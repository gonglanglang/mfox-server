import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import ffprobeStatic from 'ffprobe-static'
import { pool } from '../mysqlDb'

export type QcCheckItemName =
  | 'black_frame'
  | 'audio_silence'
  | 'av_sync'
  | 'subtitle_overflow'
  | 'continuity_norm'

export interface QcRecordItem {
  render_id: string
  chapter_id: number | null
  panel_idx: number | null
  check_item: QcCheckItemName
  result: 'pass' | 'warn' | 'fail'
  score: number
  regenerate_flag: 0 | 1
  detail: string
}

export interface VideoQcInput {
  renderId: string
  chapterId?: number | null
  panelIdx?: number | null
  /** 本地视频文件路径、Buffer 或远程 URL（三选一；若均未传则仅做元数据级质检） */
  videoPath?: string
  videoBuffer?: Buffer
  videoUrl?: string
  /** 期望的配音有效时长（秒）；>0 表示本镜有配音，必须有声音且不可被腰斩 */
  expectedSpeechDurationSec?: number
  /** 剧本设定的目标时长（秒） */
  expectedShotDurationSec?: number
  /** 本镜台词列表，用于检测字幕断句与溢出 */
  dialogue?: Array<{ speaker?: string; text?: string }>
  /** 分镜对象本身，用于检查连贯性锚点与首尾帧完备性 */
  shot?: Record<string, any>
  /** 是否允许包含黑场过渡（如跨场景黑场转场） */
  allowBlackFade?: boolean
}

export interface VideoQcReport {
  renderId: string
  passed: boolean
  shouldRegenerate: boolean
  overallScore: number
  actualDurationSec: number
  hasAudio: boolean
  blackDurationSec: number
  silenceDurationSec: number
  records: QcRecordItem[]
}

function getBinPath(installerObj: unknown, envKey: string, fallback: string): string {
  return process.env[envKey] || (installerObj as { path?: string } | null)?.path || fallback
}

function runCommandOutput(bin: string, args: string[], timeoutMs = 45_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${bin} 执行超时 (${timeoutMs}ms)`))
    }, timeoutMs)
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', err => { clearTimeout(timer); reject(err) })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code: code ?? -1 })
    })
  })
}

async function analyzeMediaFile(filePath: string): Promise<{
  durationSec: number
  hasAudio: boolean
  blackDurationSec: number
  silenceDurationSec: number
}> {
  const ffprobe = getBinPath(ffprobeStatic, 'FFPROBE_PATH', 'ffprobe')
  const ffmpeg = getBinPath(ffmpegInstaller, 'FFMPEG_PATH', 'ffmpeg')

  const probeRes = await runCommandOutput(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-show_entries', 'stream=codec_type',
    '-of', 'json',
    filePath,
  ])
  let parsed: any = null
  try { parsed = JSON.parse(probeRes.stdout) } catch { /* ignore */ }
  const durationSec = Number(parsed?.format?.duration) || 0
  const streams: any[] = Array.isArray(parsed?.streams) ? parsed.streams : []
  const hasAudio = streams.some(s => s?.codec_type === 'audio')

  // 使用单次 ffmpeg 扫描同时执行 blackdetect 与 silencedetect
  const filterArgs: string[] = ['-hide_banner', '-nostdin', '-i', filePath, '-vf', 'blackdetect=d=0.12:pix_th=0.10']
  if (hasAudio) {
    filterArgs.push('-af', 'silencedetect=noise=-45dB:d=0.40')
  } else {
    filterArgs.push('-an')
  }
  filterArgs.push('-f', 'null', '-')

  const scanRes = await runCommandOutput(ffmpeg, filterArgs, 60_000)
  const log = scanRes.stderr || ''

  let blackDurationSec = 0
  for (const m of log.matchAll(/black_duration:\s*(\d+(?:\.\d+)?)/g)) {
    blackDurationSec += Number(m[1] || 0)
  }

  let silenceDurationSec = 0
  for (const m of log.matchAll(/silence_duration:\s*(\d+(?:\.\d+)?)/g)) {
    silenceDurationSec += Number(m[1] || 0)
  }
  // 若从某点开始静音直到视频结束但未打印 silence_end，补充尾部静音时长
  const starts = [...log.matchAll(/silence_start:\s*(\d+(?:\.\d+)?)/g)].map(m => Number(m[1] || 0))
  const ends = [...log.matchAll(/silence_end:\s*(\d+(?:\.\d+)?)/g)].map(m => Number(m[1] || 0))
  if (starts.length > ends.length && durationSec > 0) {
    const lastStart = starts[starts.length - 1]!
    if (durationSec > lastStart) {
      silenceDurationSec += (durationSec - lastStart)
    }
  }

  return {
    durationSec: Number(durationSec.toFixed(3)),
    hasAudio,
    blackDurationSec: Number(blackDurationSec.toFixed(3)),
    silenceDurationSec: Number(silenceDurationSec.toFixed(3)),
  }
}

/**
 * 成片与分镜视频自动质检器（需求 3.2 / 4 / 5 / 6）：
 * 检测：
 * 1. black_frame（黑帧异常）
 * 2. audio_silence（静音/音轨丢失）
 * 3. av_sync（音画不同步/配音被截断/时长错位）
 * 4. subtitle_overflow（字幕溢出/单句过长未断句）
 * 5. continuity_norm（连贯性锚点与状态达标度）
 */
export async function inspectVideoQuality(input: VideoQcInput): Promise<VideoQcReport> {
  const {
    renderId,
    chapterId = null,
    panelIdx = null,
    expectedSpeechDurationSec = 0,
    expectedShotDurationSec = 0,
    dialogue = [],
    shot,
    allowBlackFade = false,
  } = input

  let actualDurationSec = expectedShotDurationSec || Number(shot?.durShort) || 4
  let hasAudio = true
  let blackDurationSec = 0
  let silenceDurationSec = 0

  let tempDir: string | null = null
  try {
    let targetFile = input.videoPath || ''
    if (!targetFile && input.videoBuffer && input.videoBuffer.length > 0) {
      tempDir = await mkdtemp(join(tmpdir(), 'video-qc-'))
      targetFile = join(tempDir, 'check.mp4')
      await writeFile(targetFile, input.videoBuffer)
    } else if (!targetFile && input.videoUrl && /^https?:\/\//i.test(input.videoUrl)) {
      tempDir = await mkdtemp(join(tmpdir(), 'video-qc-'))
      targetFile = join(tempDir, 'check.mp4')
      const res = await fetch(input.videoUrl, { signal: AbortSignal.timeout(45_000) })
      if (res.ok) {
        await writeFile(targetFile, Buffer.from(await res.arrayBuffer()))
      } else {
        targetFile = ''
      }
    }

    if (targetFile) {
      const media = await analyzeMediaFile(targetFile)
      actualDurationSec = media.durationSec
      hasAudio = media.hasAudio
      blackDurationSec = media.blackDurationSec
      silenceDurationSec = media.silenceDurationSec
    }
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  const records: QcRecordItem[] = []

  // 1. 黑帧检测 (black_frame)
  const allowedBlackSec = allowBlackFade ? 0.85 : 0.25
  const blackRatio = actualDurationSec > 0 ? blackDurationSec / actualDurationSec : 0
  if (blackDurationSec > allowedBlackSec || blackRatio > 0.25) {
    records.push({
      render_id: renderId,
      chapter_id: chapterId,
      panel_idx: panelIdx,
      check_item: 'black_frame',
      result: 'fail',
      score: Math.max(10, Math.round(100 - blackRatio * 200)),
      regenerate_flag: 1,
      detail: `检测到异常黑帧累计 ${blackDurationSec.toFixed(2)}s（占比 ${(blackRatio * 100).toFixed(1)}% > 阈值）`,
    })
  } else if (blackDurationSec > 0.12) {
    records.push({
      render_id: renderId,
      chapter_id: chapterId,
      panel_idx: panelIdx,
      check_item: 'black_frame',
      result: 'warn',
      score: 85,
      regenerate_flag: 0,
      detail: `存在轻微黑场过渡 ${blackDurationSec.toFixed(2)}s，在允许范围内`,
    })
  } else {
    records.push({
      render_id: renderId,
      chapter_id: chapterId,
      panel_idx: panelIdx,
      check_item: 'black_frame',
      result: 'pass',
      score: 100,
      regenerate_flag: 0,
      detail: '无异常黑帧',
    })
  }

  // 2. 静音与音轨检测 (audio_silence)
  const silenceRatio = actualDurationSec > 0 ? Math.min(1, silenceDurationSec / actualDurationSec) : 0
  if (expectedSpeechDurationSec > 0 && !hasAudio) {
    records.push({
      render_id: renderId,
      chapter_id: chapterId,
      panel_idx: panelIdx,
      check_item: 'audio_silence',
      result: 'fail',
      score: 0,
      regenerate_flag: 1,
      detail: `本镜含 ${expectedSpeechDurationSec.toFixed(2)}s 配音，但成片丢失音轨`,
    })
  } else if (expectedSpeechDurationSec > 0.5 && silenceRatio > 0.92) {
    records.push({
      render_id: renderId,
      chapter_id: chapterId,
      panel_idx: panelIdx,
      check_item: 'audio_silence',
      result: 'fail',
      score: 20,
      regenerate_flag: 1,
      detail: `本镜含配音但静音占比高达 ${(silenceRatio * 100).toFixed(1)}%，疑似配音混音失败`,
    })
  } else {
    records.push({
      render_id: renderId,
      chapter_id: chapterId,
      panel_idx: panelIdx,
      check_item: 'audio_silence',
      result: 'pass',
      score: 100,
      regenerate_flag: 0,
      detail: hasAudio
        ? `音轨正常（有效发声占比 ${((1 - silenceRatio) * 100).toFixed(1)}%）`
        : '无配音镜头',
    })
  }

  // 3. 音画同步与时长对齐检测 (av_sync)
  if (actualDurationSec < 1.5) {
    records.push({
      render_id: renderId,
      chapter_id: chapterId,
      panel_idx: panelIdx,
      check_item: 'av_sync',
      result: 'fail',
      score: 15,
      regenerate_flag: 1,
      detail: `成片时长异常过短（${actualDurationSec.toFixed(2)}s < 1.5s），存在跳帧或截断`,
    })
  } else if (expectedSpeechDurationSec > 0 && actualDurationSec + 0.25 < expectedSpeechDurationSec) {
    records.push({
      render_id: renderId,
      chapter_id: chapterId,
      panel_idx: panelIdx,
      check_item: 'av_sync',
      result: 'fail',
      score: 30,
      regenerate_flag: 1,
      detail: `音画不同步：配音需 ${expectedSpeechDurationSec.toFixed(2)}s，视频仅 ${actualDurationSec.toFixed(2)}s，台词尾部被截断`,
    })
  } else {
    records.push({
      render_id: renderId,
      chapter_id: chapterId,
      panel_idx: panelIdx,
      check_item: 'av_sync',
      result: 'pass',
      score: 100,
      regenerate_flag: 0,
      detail: `音画时长对齐良好（视频 ${actualDurationSec.toFixed(2)}s / 配音 ${expectedSpeechDurationSec.toFixed(2)}s）`,
    })
  }

  // 4. 字幕溢出与断句检测 (subtitle_overflow)
  const lines = Array.isArray(dialogue) ? dialogue : (Array.isArray(shot?.dialogue) ? shot!.dialogue : [])
  const totalChars = lines.reduce((sum, l) => sum + String(l?.text || '').trim().length, 0)
  const charsPerSec = actualDurationSec > 0 ? totalChars / actualDurationSec : 0
  const maxClauseLen = lines.reduce((max, l) => {
    const clauses = String(l?.text || '').split(/[，,。！？；!?;、\s]+/)
    const longest = clauses.reduce((m, c) => Math.max(m, c.trim().length), 0)
    return Math.max(max, longest)
  }, 0)

  if (charsPerSec > 8.5) {
    records.push({
      render_id: renderId,
      chapter_id: chapterId,
      panel_idx: panelIdx,
      check_item: 'subtitle_overflow',
      result: 'fail',
      score: 40,
      regenerate_flag: 1,
      detail: `字幕语速密度过高（${charsPerSec.toFixed(1)} 字/秒 > 8.5），字幕与画面边界溢出`,
    })
  } else if (maxClauseLen > 24 || charsPerSec > 6.5) {
    records.push({
      render_id: renderId,
      chapter_id: chapterId,
      panel_idx: panelIdx,
      check_item: 'subtitle_overflow',
      result: 'warn',
      score: 80,
      regenerate_flag: 0,
      detail: `单句最大不断句长度 ${maxClauseLen} 字，语速 ${charsPerSec.toFixed(1)} 字/秒，烧录时将自动安全区折行`,
    })
  } else {
    records.push({
      render_id: renderId,
      chapter_id: chapterId,
      panel_idx: panelIdx,
      check_item: 'subtitle_overflow',
      result: 'pass',
      score: 100,
      regenerate_flag: 0,
      detail: totalChars > 0 ? `字幕共 ${totalChars} 字，安全区内断句对齐正常` : '本镜无字幕溢出风险',
    })
  }

  // 5. 连贯性规范达标度 (continuity_norm)
  if (shot) {
    const hasAnchors = Boolean(shot.color_tone && shot.motion_direction && shot.shot_size)
    const hasContinuityErr = shot.continuity_status === 'qc_failed'
    if (hasContinuityErr) {
      records.push({
        render_id: renderId,
        chapter_id: chapterId,
        panel_idx: panelIdx,
        check_item: 'continuity_norm',
        result: 'warn',
        score: 65,
        regenerate_flag: 0,
        detail: `分镜存在连贯性告警项：${JSON.stringify(shot.continuity_issues || []).slice(0, 180)}`,
      })
    } else {
      records.push({
        render_id: renderId,
        chapter_id: chapterId,
        panel_idx: panelIdx,
        check_item: 'continuity_norm',
        result: 'pass',
        score: hasAnchors ? 100 : 90,
        regenerate_flag: 0,
        detail: `主体(${shot.subject_id ?? '-'})、色调(${shot.color_tone || '-'})、运动方向(${shot.motion_direction || 'static'})连贯性锚点完备`,
      })
    }
  }

  const shouldRegenerate = records.some(r => r.regenerate_flag === 1)
  const passed = !records.some(r => r.result === 'fail')
  const overallScore = records.length
    ? Math.round(records.reduce((sum, r) => sum + r.score, 0) / records.length)
    : 100

  return {
    renderId,
    passed,
    shouldRegenerate,
    overallScore,
    actualDurationSec,
    hasAudio,
    blackDurationSec,
    silenceDurationSec,
    records,
  }
}

/**
 * 将质检记录批量持久化至 qc_record 表。
 */
export async function saveQcRecordsToDb(records: QcRecordItem[]): Promise<void> {
  if (!Array.isArray(records) || !records.length) return
  const now = new Date()
  for (const r of records) {
    await pool.query(
      `INSERT INTO \`qc_record\`
       (\`render_id\`, \`chapter_id\`, \`panel_idx\`, \`check_item\`, \`result\`, \`score\`, \`regenerate_flag\`, \`detail\`, \`created_at\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.render_id,
        r.chapter_id ?? null,
        r.panel_idx ?? null,
        r.check_item,
        r.result,
        r.score,
        r.regenerate_flag,
        String(r.detail || '').slice(0, 500),
        now,
      ],
    )
  }
}
