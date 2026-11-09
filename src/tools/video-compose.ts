import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import ffprobeStatic from 'ffprobe-static'

/**
 * 章节成品合成：把各分镜视频按顺序重编码拼接为一个 MP4。
 *
 * 为什么重编码而不是流拷贝：分镜视频逐段参数并不保证一致，且场景之间要插转场，
 * 必须走 filter_complex 重编码。
 *
 * 转场有两条路径（按 ffmpeg 能力自动选择）：
 *  1. xfade/acrossfade（ffmpeg ≥ 4.3）：真正的交叉转场（叠化/闪白/黑场/淡入淡出…）；
 *  2. 回退路径（更老的 ffmpeg，如 @ffmpeg-installer 自带的 4.0）：
 *     在上一段末尾 fade out、下一段开头 fade in（颜色按转场取黑/白）+ concat，
 *     视觉上是"过场式"过渡，没有交叉叠化。
 * 想升级到真转场：设置环境变量 FFMPEG_PATH 指向新版 ffmpeg 即可（代码优先使用它）。
 *
 * 音频连续性（Section 5.5）：
 *  - 软转场：使用转场时长做 acrossfade / afade；
 *  - 硬切：在切点处做 60~80ms 的微幅音频平滑交叉/渐变（消除环境音底噪切点的爆音与断崖感，且保证音画零累积偏移）；
 *  - 支持可选章节级/场级 BGM 铺底混音。
 */

/** storyboard-enums.transitionOptions → ffmpeg xfade；null 表示硬切（不插转场） */
export const TRANSITION_XFADE: Record<string, { name: string; duration: number } | null> = {
  '硬切': null,
  '淡入淡出': { name: 'fade', duration: 0.6 },
  '叠化': { name: 'dissolve', duration: 0.5 },
  '闪白': { name: 'fadewhite', duration: 0.35 },
  '黑场': { name: 'fadeblack', duration: 0.6 },
  '声音先入': { name: 'dissolve', duration: 0.6 },
  '画面先入': { name: 'dissolve', duration: 0.6 },
  '相似物转场': null, // 靠画面内容匹配，拼接处保持硬切
  '动作匹配转场': null,
  '空镜过渡': { name: 'dissolve', duration: 0.8 },
  '淡出': null, // 末段整体淡出，不参与段间转场
}

/** 回退路径：该转场用什么颜色的"淡出→淡入"过渡；undefined = 硬切 */
const TRANSITION_FADE_COLOR: Record<string, 'black' | 'white' | undefined> = {
  '硬切': undefined,
  '淡入淡出': 'black',
  '叠化': 'black',
  '闪白': 'white',
  '黑场': 'black',
  '声音先入': 'black',
  '画面先入': 'black',
  '相似物转场': undefined,
  '动作匹配转场': undefined,
  '空镜过渡': 'black',
  '淡出': undefined,
}

/** 片头/片尾的淡入淡出时长（秒） */
const FADE_IN = 0.4
const FADE_OUT = 0.6
/** 场景之间过渡的淡出/淡入时长（回退路径） */
const SCENE_FADE = 0.4
/** 硬切边界处用于消除环境音爆音的微幅音频渐变时长（秒） */
const HARD_CUT_AUDIO_FADE = 0.06
/** xfade 路径下硬切边界的微幅音频交叉时长（秒，配等长采样补偿以保证零音画漂移） */
const HARD_CUT_CROSSFADE = 0.08
/** 转场可用下限：段本身太短时把转场压到该段时长的一半 */
const MIN_SEGMENT_FOR_XFADE = 0.4

export interface ComposeClip {
  /** 来源分镜节点 ID（如 "scene-0-shot-1"） */
  sourceNodeId?: string
  url: string
  /** 在成品时间线上的起点（秒） */
  startTime?: number
  /** 在成品时间线上的播放时长（秒） */
  duration?: number
  /** 原视频入点（秒，默认 0） */
  sourceOffset?: number
  /** 原视频截取时长（秒，默认取整段） */
  sourceDuration?: number
  /** 单段音量调节（dB，默认 0，范围 -60 ~ +20） */
  decibel?: number
  /** 本段之后、与下一段之间的转场（storyboard transition 值）；缺省按硬切处理 */
  transitionAfter?: string | null
  /** 转场决策器输出的自定义转场时长（秒；同场景 ≤0.3s，跨场景 0.3~0.6s，0 表示硬切） */
  transitionDuration?: number | null
}

export type ComposeSegment = ComposeClip

export interface ComposeOptions {
  /** 兼容旧版按序拼接段列表 */
  segments?: ComposeSegment[]
  /** 对齐 LibTV 的时间线片段列表（优先于 segments） */
  clips?: ComposeClip[]
  width: number
  height: number
  fps: number
  /** 可选章节/场景级 BGM 音频 URL（循环铺底混音） */
  bgmUrl?: string
  /** BGM 音量比例（默认 0.18） */
  bgmVolume?: number
  /** Track 1：视频原声静音开关 */
  videoAudioMuted?: boolean
  /** Track 1：视频原声音量倍率（0~2，默认 1.0） */
  videoAudioVolume?: number
  /** Track 2：配音/BGM 音轨静音开关 */
  audioTrackMuted?: boolean
  /** Track 2：配音/BGM 音轨音量倍率（0~2，默认 1.0） */
  audioTrackVolume?: number
  /** 进度回调（0~100） */
  onProgress?: (percent: number, stage: string) => void | Promise<void>
}

export interface ComposeResult {
  buffer: Buffer
  durationSec: number
  width: number
  height: number
  /** 实际使用的转场实现（排查用） */
  transitionMode: 'xfade' | 'fade'
}

export interface MergePanelAudioOptions {
  /** 分镜原始视频 URL */
  videoUrl: string
  /** 按顺序列出的 MiniMax TTS 语音 URL */
  audioUrls: string[]
  /**
   * 是否完全替换原视频音轨：
   * - false（默认）：保留原视频 30% 环境音底噪（雨声、雷声、脚步声等），与 100% 清晰 TTS 语音混音；
   * - true：静默原视频音轨，仅保留 TTS 语音。
   */
  replaceOriginalAudio?: boolean
}

export interface MergePanelAudioResult {
  buffer: Buffer
  durationSec: number
  speechDurationSec: number
}

/** 档位 + 作品宽高比 → 输出像素尺寸（短边取档位值，保证偶数） */
export function resolveOutputSize(resolution: string, aspectRatio?: string): { width: number; height: number } {
  const shortSide = resolution === '720p' ? 720 : resolution === '4K' ? 2160 : 1080
  const match = String(aspectRatio || '16:9').trim().match(/^(\d+)\s*[:：x×]\s*(\d+)$/)
  const ratioW = match ? Number(match[1]) : 16
  const ratioH = match ? Number(match[2]) : 9
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2)
  return ratioW >= ratioH
    ? { width: even((shortSide * ratioW) / ratioH), height: even(shortSide) }
    : { width: even(shortSide), height: even((shortSide * ratioH) / ratioW) }
}

/** 一次性执行并收集输出（版本探测 / ffprobe） */
function runOnce(bin: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${bin} 退出码 ${code}：${stderr.trim().slice(-400) || '无输出'}`))
    })
  })
}

/** 逐个候选探测可执行性，返回第一个真正能跑 `-version` 的路径 */
async function resolveBinary(candidates: (string | null | undefined)[], label: string): Promise<string> {
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      await runOnce(candidate, ['-version'])
      return candidate
    } catch { /* 该候选不可用，试下一个 */ }
  }
  throw new Error(`未找到可用的 ${label}：请在后端安装依赖（npm i @ffmpeg-installer/ffmpeg ffprobe-static），`
    + `或把 ${label} 加入系统 PATH / 设置 FFMPEG_PATH`)
}

let ffmpegPathCache: string | null = null
let ffprobePathCache: string | null = null
let xfadeSupport: boolean | null = null

/** ffmpeg：FFMPEG_PATH（可指向新版 ffmpeg）→ @ffmpeg-installer（随 npm 包分发）→ 系统 PATH */
async function getFFmpegPath(): Promise<string> {
  if (!ffmpegPathCache) {
    ffmpegPathCache = await resolveBinary([
      process.env.FFMPEG_PATH,
      (ffmpegInstaller as { path?: string } | null)?.path,
      'ffmpeg',
    ], 'ffmpeg')
  }
  return ffmpegPathCache
}

/** ffprobe：FFMPEG_PATH 同目录优先 → ffprobe-static → 系统 PATH */
async function getFFprobePath(): Promise<string> {
  if (!ffprobePathCache) {
    ffprobePathCache = await resolveBinary([
      (ffprobeStatic as { path?: string } | null)?.path,
      'ffprobe',
    ], 'ffprobe')
  }
  return ffprobePathCache
}

/** 是否支持 xfade 转场（ffmpeg ≥ 4.3）；结果缓存 */
async function supportsXfade(): Promise<boolean> {
  if (xfadeSupport !== null) return xfadeSupport
  try {
    const { stdout } = await runOnce(await getFFmpegPath(), ['-version'])
    const match = stdout.match(/ffmpeg version n?(\d+)\.(\d+)/)
    const major = Number(match?.[1] || 0)
    const minor = Number(match?.[2] || 0)
    xfadeSupport = major > 4 || (major === 4 && minor >= 3)
  } catch {
    xfadeSupport = false
  }
  if (!xfadeSupport) console.warn('[compose] 当前 ffmpeg 不支持 xfade（需 4.3+），转场回退为"淡出→淡入"过场')
  return xfadeSupport
}

/** 读取媒体时长与是否含音轨 */
async function probeMedia(file: string): Promise<{ duration: number; hasAudio: boolean }> {
  const { stdout } = await runOnce(await getFFprobePath(), [
    '-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type', '-of', 'json', file,
  ])
  let parsed: any = null
  try { parsed = JSON.parse(stdout) } catch { /* 下面统一报错 */ }
  const duration = Number(parsed?.format?.duration)
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`无法读取媒体时长：${file}`)
  const streams = Array.isArray(parsed?.streams) ? parsed.streams : []
  return { duration, hasAudio: streams.some((stream: any) => stream?.codec_type === 'audio') }
}

/** 执行 ffmpeg 并按 time= 上报进度 */
async function runFFmpeg(args: string[], totalSec: number, onProgress?: ComposeOptions['onProgress']): Promise<void> {
  const ffmpegPath = await getFFmpegPath()
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    let lastPercent = -1
    let lastReport = 0
    child.stderr.on('data', chunk => {
      const text = String(chunk)
      stderr = (stderr + text).slice(-4000)
      const match = [...text.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)].pop()
      if (!match || !onProgress || totalSec <= 0) return
      const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
      const percent = Math.min(99, Math.max(0, Math.floor((seconds / totalSec) * 100)))
      const now = Date.now()
      if (percent <= lastPercent || now - lastReport < 1500) return
      lastPercent = percent
      lastReport = now
      void Promise.resolve(onProgress(percent, `正在合成 ${percent}%`)).catch(() => { /* 进度上报失败不影响合成 */ })
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 退出码 ${code}：${stderr.trim().slice(-400) || '无输出'}`))
    })
  })
}

/**
 * 将单镜头的 MiniMax TTS 配音（支持单句或多角色多句、旁白、内心OS）与分镜视频混音合成：
 * - 首句前留 0.15s 自然起音缓冲，多句之间插入 0.20s 停顿；
 * - 若配音总时长超出视频时长，自动使用 tpad 克隆延长视频末帧，确保台词末尾绝不被腰斩；
 * - 默认保留原视频 30% 的环境音效底噪（雨声、雷声、脚步声等），与 100% 清晰度的 TTS 配音混音。
 */
export async function mergePanelAudioWithVideo(options: MergePanelAudioOptions): Promise<MergePanelAudioResult> {
  const audioUrls = (options.audioUrls || []).map(u => String(u || '').trim()).filter(Boolean)
  if (!audioUrls.length) throw new Error('没有可合并的配音音频 URL')

  const workDir = await mkdtemp(join(tmpdir(), 'panel-mux-'))
  try {
    const videoFile = join(workDir, 'video.mp4')
    const videoRes = await fetch(options.videoUrl, { signal: AbortSignal.timeout(60_000) })
    if (!videoRes.ok) throw new Error(`下载分镜视频失败：HTTP ${videoRes.status}`)
    await writeFile(videoFile, Buffer.from(await videoRes.arrayBuffer()))
    const videoProbe = await probeMedia(videoFile)

    const audioFiles: string[] = []
    const audioProbes: { duration: number; hasAudio: boolean }[] = []
    for (let i = 0; i < audioUrls.length; i++) {
      const res = await fetch(audioUrls[i]!, { signal: AbortSignal.timeout(60_000) })
      if (!res.ok) throw new Error(`下载第 ${i + 1} 段配音失败：HTTP ${res.status}`)
      const file = join(workDir, `tts-${String(i).padStart(3, '0')}.mp3`)
      await writeFile(file, Buffer.from(await res.arrayBuffer()))
      audioFiles.push(file)
      audioProbes.push(await probeMedia(file))
    }

    const leadInSec = 0.15
    const gapSec = 0.20
    const tailBufferSec = 0.15
    const gapSamples = Math.round(gapSec * 48000) // 9600 samples @ 48kHz
    const speechDurationSec = Number((
      leadInSec
      + audioProbes.reduce((sum, p) => sum + p.duration, 0)
      + Math.max(0, audioFiles.length - 1) * gapSec
      + tailBufferSec
    ).toFixed(3))

    const targetDuration = Math.max(videoProbe.duration, speechDurationSec)
    const extraPadSec = targetDuration > videoProbe.duration + 0.05
      ? Number((targetDuration - videoProbe.duration + 0.1).toFixed(3))
      : 0

    const inputs: string[] = ['-i', videoFile]
    for (const file of audioFiles) inputs.push('-i', file)

    const filters: string[] = []
    for (let i = 0; i < audioFiles.length; i++) {
      const chain = [
        'aresample=48000',
        'aformat=sample_fmts=fltp:channel_layouts=stereo',
        'asetpts=PTS-STARTPTS',
      ]
      if (i === 0) chain.push(`adelay=${Math.round(leadInSec * 1000)}|${Math.round(leadInSec * 1000)}`)
      if (i < audioFiles.length - 1) chain.push(`apad=pad_len=${gapSamples}`)
      filters.push(`[${i + 1}:a]${chain.join(',')}[tts${i}]`)
    }

    if (audioFiles.length === 1) {
      filters.push('[tts0]apad[speech]')
    } else {
      const concatInputs = Array.from({ length: audioFiles.length }, (_, i) => `[tts${i}]`).join('')
      filters.push(`${concatInputs}concat=n=${audioFiles.length}:v=0:a=1,apad[speech]`)
    }

    if (videoProbe.hasAudio && !options.replaceOriginalAudio) {
      // 关键防串音处理：视频模型（如 Seedance）在看到人物张嘴做口型时常会在原视频音轨中自行脑补出一段假人声台词；
      // 这里用单段带阻滤波器（bandreject=f=1000:width_type=h:w=1800）抑制人声核心频段，
      // 保留低频雷鸣/环境底噪与高频雨声/风声，并将底噪压低至 12%，再经 alimiter 限幅防止峰值削波破音。
      filters.push('[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,bandreject=f=1000:width_type=h:w=1800,volume=0.12,apad[bg]')
      filters.push('[bg][speech]amix=inputs=2:duration=first:dropout_transition=0,volume=1.8,alimiter=limit=0.95:level=false[outa]')
    } else {
      filters.push('[speech]volume=1.0[outa]')
    }

    const outputFile = join(workDir, 'muxed.mp4')
    if (extraPadSec > 0) {
      // 音频对齐优化（需求 3.1 & 4）：
      // 若配音超出视频时长比例在 22% 以内，优先通过 setpts 微幅放慢视频节奏对齐配音，避免画面突然定格死帧；
      // 若超出较多，则结合 1.15x 平滑放慢 + 尾部克隆留白补偿（tpad）。
      const rawRatio = videoProbe.duration > 0 ? targetDuration / videoProbe.duration : 1
      if (rawRatio > 1.01 && rawRatio <= 1.22) {
        filters.push(`[0:v]setpts=${rawRatio.toFixed(4)}*PTS,tpad=stop_mode=clone:stop_duration=0.08,format=yuv420p[outv]`)
      } else {
        const stretch = 1.15
        const stretchedDur = videoProbe.duration * stretch
        const remainPad = Math.max(0.1, Number((targetDuration - stretchedDur + 0.1).toFixed(3)))
        filters.push(`[0:v]setpts=${stretch.toFixed(4)}*PTS,tpad=stop_mode=clone:stop_duration=${remainPad},format=yuv420p[outv]`)
      }
      await runFFmpeg([
        '-hide_banner', '-nostdin', '-y',
        ...inputs,
        '-filter_complex', filters.join(';'),
        '-map', '[outv]', '-map', '[outa]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p',
        '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
        '-movflags', '+faststart',
        '-t', targetDuration.toFixed(3),
        outputFile,
      ], targetDuration)
    } else {
      await runFFmpeg([
        '-hide_banner', '-nostdin', '-y',
        ...inputs,
        '-filter_complex', filters.join(';'),
        '-map', '0:v:0', '-map', '[outa]',
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
        '-movflags', '+faststart',
        '-t', targetDuration.toFixed(3),
        outputFile,
      ], targetDuration)
    }

    const buffer = await readFile(outputFile)
    if (!buffer.length) throw new Error('分镜音视频混音结果为空文件')
    return { buffer, durationSec: targetDuration, speechDurationSec }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** 返回该段可用的 xfade 转场（支持转场决策器自定义时长；段太短时压缩时长，避免 xfade 失败） */
function pickXfade(
  transition: string | null | undefined,
  previousDur: number,
  nextDur: number,
  customDuration?: number | null,
) {
  if (customDuration !== undefined && customDuration !== null && Number(customDuration) <= 0) return null
  const mapped = TRANSITION_XFADE[String(transition || '').trim()] ?? null
  if (!mapped) return null
  const baseDur = (customDuration != null && Number.isFinite(Number(customDuration)) && Number(customDuration) > 0)
    ? Number(customDuration)
    : mapped.duration
  const duration = Math.min(baseDur, previousDur / 2, nextDur / 2)
  if (!Number.isFinite(duration) || duration < 0.15 || Math.min(previousDur, nextDur) < MIN_SEGMENT_FOR_XFADE) return null
  return { name: mapped.name, duration: Number(duration.toFixed(3)) }
}

interface GraphInput {
  segmentCount: number
  probes: { duration: number; hasAudio: boolean }[]
  segments: ComposeSegment[]
  silenceIndex: Map<number, number>
  width: number
  height: number
  fps: number
  totalDuration: number
  bgmInputIndex?: number
  bgmVolume?: number
  videoAudioMuted?: boolean
  videoAudioVolume?: number
  audioTrackMuted?: boolean
  audioTrackVolume?: number
}

/**
 * 计算单个时间线 Clip 的入出点裁剪（trim/atrim）与音量（decibel + Track 1 原声开关/音量）滤镜。
 */
export function buildTimelineClipFilters(
  clip: ComposeClip,
  probeDuration: number,
  options: { videoAudioMuted?: boolean; videoAudioVolume?: number } = {},
): {
  effectiveDuration: number
  videoTrimFilters: string[]
  audioTrimAndVolumeFilters: string[]
} {
  const rawOffset = Number(clip.sourceOffset ?? 0)
  const offset = Number.isFinite(rawOffset) && rawOffset > 0
    ? Math.min(rawOffset, Math.max(0, probeDuration - 0.1))
    : 0
  const maxAvail = Math.max(0.1, probeDuration - offset)
  const requestedDur = Number(clip.sourceDuration ?? clip.duration ?? 0)
  const hasCustomDur = Number.isFinite(requestedDur) && requestedDur > 0 && requestedDur < maxAvail - 0.01
  const effectiveDuration = hasCustomDur ? Number(requestedDur.toFixed(3)) : Number(maxAvail.toFixed(3))

  const videoTrimFilters: string[] = []
  const audioTrimAndVolumeFilters: string[] = []
  if (offset > 0 || hasCustomDur) {
    videoTrimFilters.push(`trim=start=${offset.toFixed(3)}:duration=${effectiveDuration.toFixed(3)}`, 'setpts=PTS-STARTPTS')
    audioTrimAndVolumeFilters.push(`atrim=start=${offset.toFixed(3)}:duration=${effectiveDuration.toFixed(3)}`, 'asetpts=PTS-STARTPTS')
  }

  const decibel = Number(clip.decibel ?? 0)
  if (Number.isFinite(decibel) && decibel !== 0) {
    const clampedDb = Math.max(-60, Math.min(20, decibel))
    audioTrimAndVolumeFilters.push(`volume=${clampedDb}dB`)
  }

  if (options.videoAudioMuted) {
    audioTrimAndVolumeFilters.push('volume=0')
  } else if (options.videoAudioVolume !== undefined && Number.isFinite(Number(options.videoAudioVolume)) && Number(options.videoAudioVolume) !== 1) {
    const vol = Math.max(0, Math.min(2, Number(options.videoAudioVolume)))
    audioTrimAndVolumeFilters.push(`volume=${vol.toFixed(2)}`)
  }

  return {
    effectiveDuration,
    videoTrimFilters,
    audioTrimAndVolumeFilters,
  }
}

/** 每段统一规格的滤镜链前缀（支持时间线入出点裁剪） */
function normalizeChain(input: GraphInput, index: number) {
  const seg = input.segments[index]!
  const probeDur = input.probes[index]!.duration
  const { videoTrimFilters } = buildTimelineClipFilters(seg, probeDur, {
    videoAudioMuted: input.videoAudioMuted,
    videoAudioVolume: input.videoAudioVolume,
  })
  return [
    ...videoTrimFilters,
    `scale=${input.width}:${input.height}:force_original_aspect_ratio=decrease`,
    `pad=${input.width}:${input.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
    `fps=${input.fps}`,
    'format=yuv420p',
  ]
}

function audioInputOf(input: GraphInput, index: number) {
  return input.probes[index]!.hasAudio ? `${index}:a` : `${input.silenceIndex.get(index)}:a`
}

/** 路径 1：xfade + acrossfade 链式拼接（真转场，硬切边界做 80ms 微幅音频平滑交叉且补偿采样零漂移） */
function buildXfadeGraph(input: GraphInput): string[] {
  const filters: string[] = []
  for (let index = 0; index < input.segmentCount; index++) {
    const seg = input.segments[index]!
    const probeDur = input.probes[index]!.duration
    const { audioTrimAndVolumeFilters } = buildTimelineClipFilters(seg, probeDur, {
      videoAudioMuted: input.videoAudioMuted,
      videoAudioVolume: input.videoAudioVolume,
    })
    filters.push(`[${index}:v]${normalizeChain(input, index).join(',')}[v${index}]`)
    const aChain = ['aresample=48000', 'asetpts=PTS-STARTPTS', ...audioTrimAndVolumeFilters]
    filters.push(`[${audioInputOf(input, index)}]${aChain.join(',')}[a${index}]`)
  }
  let currentVideo = 'v0'
  let currentAudio = 'a0'
  let accumulated = input.probes[0]!.duration
  const hardCutPadSamples = Math.round(HARD_CUT_CROSSFADE * 48000)
  for (let index = 1; index < input.segmentCount; index++) {
    const prevSeg = input.segments[index - 1]!
    const transition = pickXfade(
      prevSeg.transitionAfter,
      input.probes[index - 1]!.duration,
      input.probes[index]!.duration,
      prevSeg.transitionDuration,
    )
    if (transition) {
      const offset = Math.max(0, accumulated - transition.duration)
      const videoOut = `vx${index}`
      const audioOut = `ax${index}`
      filters.push(`[${currentVideo}][v${index}]xfade=transition=${transition.name}:duration=${transition.duration}:`
        + `offset=${offset.toFixed(3)}[${videoOut}]`)
      filters.push(`[${currentAudio}][a${index}]acrossfade=d=${transition.duration}:c1=tri:c2=tri[${audioOut}]`)
      accumulated = accumulated + input.probes[index]!.duration - transition.duration
      currentVideo = videoOut
      currentAudio = audioOut
    } else {
      const videoOut = `vc${index}`
      const audioPad = `apad${index}`
      const audioOut = `ac${index}`
      filters.push(`[${currentVideo}][v${index}]concat=n=2:v=1:a=0[${videoOut}]`)
      filters.push(`[${currentAudio}]apad=pad_len=${hardCutPadSamples}[${audioPad}]`)
      filters.push(`[${audioPad}][a${index}]acrossfade=d=${HARD_CUT_CROSSFADE}:c1=tri:c2=tri[${audioOut}]`)
      accumulated += input.probes[index]!.duration
      currentVideo = videoOut
      currentAudio = audioOut
    }
  }
  const fadeOutStart = Math.max(FADE_IN, accumulated - FADE_OUT)
  filters.push(`[${currentVideo}]fade=t=in:st=0:d=${FADE_IN},fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${FADE_OUT}[outv]`)
  const hasBgmTrack = input.bgmInputIndex != null && !input.audioTrackMuted
  const mainAudioLabel = hasBgmTrack ? 'maina' : 'preloud'
  filters.push(`[${currentAudio}]afade=t=in:st=0:d=${FADE_IN},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${FADE_OUT}[${mainAudioLabel}]`)
  if (hasBgmTrack) {
    const baseVol = Number.isFinite(input.bgmVolume) ? Number(input.bgmVolume) : 0.18
    const trackMult = Number.isFinite(input.audioTrackVolume) ? Math.max(0, Math.min(2, Number(input.audioTrackVolume))) : 1
    const vol = baseVol * trackMult
    filters.push(`[${input.bgmInputIndex}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,volume=${vol.toFixed(2)},afade=t=in:st=0:d=${FADE_IN},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${FADE_OUT}[bgm]`)
    filters.push('[maina][bgm]amix=inputs=2:duration=first:dropout_transition=0,volume=1.8,alimiter=limit=0.95:level=false[preloud]')
  }
  // 统一响度标准 -14 LUFS（需求 3.1 & 4）
  filters.push('[preloud]loudnorm=I=-14:TP=-1.5:LRA=11[outa]')
  return filters
}

/** 路径 2：段内淡出/淡入 + 一次 concat（老 ffmpeg 回退，硬切边界做 60ms 微幅音频平滑渐变消除爆音） */
function buildFadeGraph(input: GraphInput): string[] {
  const filters: string[] = []
  // 场景间的过渡：上一段尾 fade out（颜色）→ 下一段头 fade in（同色）
  const fadeIn = new Array<'black' | 'white' | undefined>(input.segmentCount).fill(undefined)
  const fadeOut = new Array<'black' | 'white' | undefined>(input.segmentCount).fill(undefined)
  for (let index = 0; index < input.segmentCount - 1; index++) {
    const color = TRANSITION_FADE_COLOR[String(input.segments[index]!.transitionAfter || '').trim()]
    if (!color) continue
    fadeOut[index] = color
    fadeIn[index + 1] = color
  }
  for (let index = 0; index < input.segmentCount; index++) {
    const dur = input.probes[index]!.duration
    const seg = input.segments[index]!
    const { audioTrimAndVolumeFilters } = buildTimelineClipFilters(seg, dur, {
      videoAudioMuted: input.videoAudioMuted,
      videoAudioVolume: input.videoAudioVolume,
    })
    const chain = normalizeChain(input, index)
    if (fadeIn[index]) chain.push(`fade=t=in:st=0:d=${SCENE_FADE}:color=${fadeIn[index]}`)
    const outColor = fadeOut[index]
    const outStart = outColor ? Math.max(0, dur - SCENE_FADE) : 0
    if (outColor) chain.push(`fade=t=out:st=${outStart.toFixed(3)}:d=${SCENE_FADE}:color=${outColor}`)
    filters.push(`[${index}:v]${chain.join(',')}[v${index}]`)

    const audioChain = ['aresample=48000', 'asetpts=PTS-STARTPTS', ...audioTrimAndVolumeFilters]
    if (fadeIn[index]) {
      audioChain.push(`afade=t=in:st=0:d=${SCENE_FADE}`)
    } else if (index > 0 && dur > HARD_CUT_AUDIO_FADE * 3) {
      audioChain.push(`afade=t=in:st=0:d=${HARD_CUT_AUDIO_FADE}`)
    }
    if (outColor) {
      audioChain.push(`afade=t=out:st=${outStart.toFixed(3)}:d=${SCENE_FADE}`)
    } else if (index < input.segmentCount - 1 && dur > HARD_CUT_AUDIO_FADE * 3) {
      const hardOutStart = Math.max(0, dur - HARD_CUT_AUDIO_FADE)
      audioChain.push(`afade=t=out:st=${hardOutStart.toFixed(3)}:d=${HARD_CUT_AUDIO_FADE}`)
    }
    filters.push(`[${audioInputOf(input, index)}]${audioChain.join(',')}[a${index}]`)
  }
  const inputs = Array.from({ length: input.segmentCount }, (_, index) => `[v${index}][a${index}]`).join('')
  const hasBgmTrack = input.bgmInputIndex != null && !input.audioTrackMuted
  const mainAudioLabel = hasBgmTrack ? 'maina' : 'preloud'
  // 只勾选了一段时没有可 concat 的对象（concat 需要 ≥2 路），直接透传
  if (input.segmentCount === 1) {
    filters.push('[v0]null[outv]')
    filters.push(`[a0]anull[${mainAudioLabel}]`)
  } else {
    filters.push(`${inputs}concat=n=${input.segmentCount}:v=1:a=1[outv][${mainAudioLabel}]`)
  }
  if (hasBgmTrack) {
    const baseVol = Number.isFinite(input.bgmVolume) ? Number(input.bgmVolume) : 0.18
    const trackMult = Number.isFinite(input.audioTrackVolume) ? Math.max(0, Math.min(2, Number(input.audioTrackVolume))) : 1
    const vol = baseVol * trackMult
    const fadeOutStart = Math.max(FADE_IN, input.totalDuration - FADE_OUT)
    filters.push(`[${input.bgmInputIndex}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,volume=${vol.toFixed(2)},afade=t=in:st=0:d=${FADE_IN},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${FADE_OUT}[bgm]`)
    filters.push('[maina][bgm]amix=inputs=2:duration=first:dropout_transition=0,volume=1.8,alimiter=limit=0.95:level=false[preloud]')
  }
  // 统一响度标准 -14 LUFS（需求 3.1 & 4）
  filters.push('[preloud]loudnorm=I=-14:TP=-1.5:LRA=11[outa]')
  return filters
}

/**
 * 合成章节成品：下载各段 → 统一规格（支持时间线入出点裁剪与双轨音量） → 按转场拼接 → 返回 MP4 buffer。
 * 临时文件在 finally 中清理；任一步失败都会抛出带上下文的错误。
 */
export async function composeVideos(options: ComposeOptions): Promise<ComposeResult> {
  const { width, height, fps, bgmUrl, bgmVolume, videoAudioMuted, videoAudioVolume, audioTrackMuted, audioTrackVolume, onProgress } = options
  const segments = (Array.isArray(options.clips) && options.clips.length > 0 ? options.clips : options.segments) || []
  if (!segments.length) throw new Error('没有可合成的分镜视频')
  if (![width, height, fps].every(value => Number.isFinite(value) && value > 0)) throw new Error('合成参数无效')

  const workDir = await mkdtemp(join(tmpdir(), 'compose-'))
  try {
    // 1. 下载各段视频
    const files: string[] = []
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index]!
      await onProgress?.(Math.floor((index / segments.length) * 10), `正在下载第 ${index + 1}/${segments.length} 段`)
      const res = await fetch(segment.url)
      if (!res.ok) throw new Error(`下载第 ${index + 1} 段分镜视频失败：HTTP ${res.status}`)
      const file = join(workDir, `seg-${String(index).padStart(3, '0')}.mp4`)
      await writeFile(file, Buffer.from(await res.arrayBuffer()))
      files.push(file)
    }

    // 2. 读取每段时长与音轨（结合时间线入出点计算实际有效时长）
    const rawProbes: { duration: number; hasAudio: boolean }[] = []
    for (const file of files) rawProbes.push(await probeMedia(file))
    const probes = rawProbes.map((probe, idx) => {
      const { effectiveDuration } = buildTimelineClipFilters(segments[idx]!, probe.duration)
      return { duration: effectiveDuration, hasAudio: probe.hasAudio }
    })
    const totalDuration = probes.reduce((sum, probe) => sum + probe.duration, 0)

    // 3. 组装 ffmpeg 输入与滤镜图：无音轨的段补一路静音输入，保证音视频流对齐
    const inputs: string[] = []
    for (const file of files) inputs.push('-i', file)
    const silenceIndex = new Map<number, number>()
    let nextInputIndex = files.length
    for (let index = 0; index < files.length; index++) {
      if (probes[index]!.hasAudio) continue
      inputs.push('-f', 'lavfi', '-t', probes[index]!.duration.toFixed(3), '-i',
        'anullsrc=channel_layout=stereo:sample_rate=48000')
      silenceIndex.set(index, nextInputIndex++)
    }

    let bgmInputIndex: number | undefined
    if (bgmUrl && bgmUrl.trim() && !audioTrackMuted) {
      try {
        const bgmRes = await fetch(bgmUrl.trim(), { signal: AbortSignal.timeout(30_000) })
        if (bgmRes.ok) {
          const bgmFile = join(workDir, 'bgm.mp3')
          await writeFile(bgmFile, Buffer.from(await bgmRes.arrayBuffer()))
          inputs.push('-stream_loop', '-1', '-t', Math.max(1, totalDuration).toFixed(3), '-i', bgmFile)
          bgmInputIndex = nextInputIndex++
        }
      } catch (bgmErr: any) {
        console.warn(`[compose] 下载 BGM 失败，忽略 BGM 混音：${bgmErr?.message || bgmErr}`)
      }
    }

    const graphInput: GraphInput = {
      segmentCount: files.length, probes, segments, silenceIndex, width, height, fps, totalDuration,
      bgmInputIndex, bgmVolume, videoAudioMuted, videoAudioVolume, audioTrackMuted, audioTrackVolume,
    }
    const transitionMode: ComposeResult['transitionMode'] = await supportsXfade() ? 'xfade' : 'fade'
    const filters = transitionMode === 'xfade' ? buildXfadeGraph(graphInput) : buildFadeGraph(graphInput)

    const outputFile = join(workDir, 'composed.mp4')
    await runFFmpeg([
      '-hide_banner', '-nostdin', '-y',
      ...inputs,
      '-filter_complex', filters.join(';'),
      '-map', '[outv]', '-map', '[outa]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
      '-movflags', '+faststart',
      '-t', Math.max(1, totalDuration).toFixed(3),
      outputFile,
    ], totalDuration, async (percent, stage) => {
      // 下载阶段已占用 0~10%，合成阶段映射到 10~100%
      await onProgress?.(10 + Math.floor(percent * 0.89), stage)
    })

    await onProgress?.(99, '正在整理成品')
    const buffer = await readFile(outputFile)
    if (!buffer.length) throw new Error('合成结果为空文件')
    return { buffer, durationSec: totalDuration, width, height, transitionMode }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => { /* 清理失败不影响结果 */ })
  }
}

/**
 * 从已生成的分镜视频（videoUrl）中精确截取真实最后一帧画面（PNG Buffer），
 * 用于下一镜首帧无缝承接（100% 像素级对齐，彻底解决“上一镜已开门、下一镜门又还原关着重开”以及“多镜首尾帧对不齐”问题）。
 */
export async function extractVideoLastFrameBuffer(videoUrl: string): Promise<Buffer> {
  const cleanUrl = String(videoUrl || '').trim()
  if (!cleanUrl) throw new Error('上一镜视频地址为空，无法截取末帧')
  const workDir = await mkdtemp(join(tmpdir(), 'mfox-vtail-'))
  try {
    const inputFile = join(workDir, 'prev.mp4')
    const outputFile = join(workDir, 'tail.png')
    const res = await fetch(cleanUrl)
    if (!res.ok) throw new Error(`下载上一镜视频失败：HTTP ${res.status}`)
    await writeFile(inputFile, Buffer.from(await res.arrayBuffer()))
    const probe = await probeMedia(inputFile)
    const seekSec = Math.max(0, probe.duration - 0.08)
    await runFFmpeg([
      '-hide_banner', '-nostdin', '-y',
      '-ss', seekSec.toFixed(3),
      '-i', inputFile,
      '-frames:v', '1',
      '-f', 'image2',
      outputFile,
    ], 1)
    const buf = await readFile(outputFile).catch(() => Buffer.alloc(0))
    if (buf.length > 0) return buf

    // 兜底：若按 duration 末尾 seek 未取到帧，改用 -sseof -0.2 重试
    await runFFmpeg([
      '-hide_banner', '-nostdin', '-y',
      '-sseof', '-0.2',
      '-i', inputFile,
      '-frames:v', '1',
      '-f', 'image2',
      outputFile,
    ], 1)
    const fallbackBuf = await readFile(outputFile)
    if (!fallbackBuf.length) throw new Error('截取上一镜视频末帧为空')
    return fallbackBuf
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}
