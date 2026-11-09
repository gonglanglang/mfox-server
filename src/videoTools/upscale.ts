import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { uploadBufferToOSS } from '../config/oss.config'
import { recordShotAssetVersion, selectShotAssetVersion } from '../pipeline/shot-assets-store'

export type UpscaleTargetResolution = '1080p' | '2k' | '4k'

export interface UpscaleVideoOptions {
  videoUrl: string
  targetResolution?: UpscaleTargetResolution | string
  aspectRatio?: string
  chapterId?: number
  sceneIndex?: number
  shotIndex?: number
  assetType?: 'video' | 'compose'
}

export interface UpscaleVideoResult {
  url: string
  width: number
  height: number
  targetResolution: string
  version?: number
  assetId?: number
}

/**
 * 根据目标清晰度档位（1080p / 2k / 4k）与宽高比计算目标像素宽高及 FFmpeg Lanczos + Unsharp 超分滤镜链。
 */
export function buildUpscaleFilter(
  targetResolution: UpscaleTargetResolution | string = '1080p',
  aspectRatio = '16:9',
): {
  width: number
  height: number
  filter: string
  normalizedResolution: UpscaleTargetResolution
} {
  const token = String(targetResolution || '1080p').trim().toLowerCase()
  const normalizedResolution: UpscaleTargetResolution =
    token === '4k' || token === '2160p'
      ? '4k'
      : token === '2k' || token === '1440p'
        ? '2k'
        : '1080p'

  const baseLongEdge =
    normalizedResolution === '4k'
      ? 3840
      : normalizedResolution === '2k'
        ? 2560
        : 1920

  const ratioStr = String(aspectRatio || '16:9').trim()
  const [rwRaw, rhRaw] = ratioStr.split(':').map(n => Number(n))
  const rw = Number.isFinite(rwRaw) && rwRaw! > 0 ? rwRaw! : 16
  const rh = Number.isFinite(rhRaw) && rhRaw! > 0 ? rhRaw! : 9

  let width: number
  let height: number
  if (rw >= rh) {
    width = baseLongEdge
    height = Math.round((baseLongEdge * rh) / rw / 2) * 2
  } else {
    height = baseLongEdge
    width = Math.round((baseLongEdge * rw) / rh / 2) * 2
  }

  const filter = [
    `scale=${width}:${height}:flags=lanczos:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'unsharp=5:5:0.8:3:3:0.4',
    'format=yuv420p',
  ].join(',')

  return { width, height, filter, normalizedResolution }
}

function runFfmpegUpscale(args: string[]): Promise<void> {
  const bin = process.env.FFMPEG_PATH || ffmpegInstaller.path
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', err => reject(err))
    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`FFmpeg 超分失败 (exit ${code}): ${stderr.slice(-400)}`))
    })
  })
}

/**
 * 视频超分节点（Video Upscale）：将分镜视频或合成成片超分至 1080P / 2K / 4K 并写入 shot_assets 新版本。
 */
export async function upscaleVideo(options: UpscaleVideoOptions): Promise<UpscaleVideoResult> {
  const cleanUrl = String(options.videoUrl || '').trim()
  if (!cleanUrl) {
    throw new Error('缺少待超分的视频地址（videoUrl）')
  }

  const { width, height, filter, normalizedResolution } = buildUpscaleFilter(
    options.targetResolution,
    options.aspectRatio,
  )

  const workDir = await mkdtemp(join(tmpdir(), 'mfox-upscale-'))
  try {
    const inputFile = join(workDir, 'input.mp4')
    const outputFile = join(workDir, 'upscaled.mp4')

    const res = await fetch(cleanUrl)
    if (!res.ok) {
      throw new Error(`下载待超分视频失败：HTTP ${res.status}`)
    }
    await writeFile(inputFile, Buffer.from(await res.arrayBuffer()))

    await runFfmpegUpscale([
      '-hide_banner', '-nostdin', '-y',
      '-i', inputFile,
      '-vf', filter,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '17',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      outputFile,
    ])

    const outBuffer = await readFile(outputFile)
    if (!outBuffer.length) {
      throw new Error('视频超分输出为空文件')
    }

    const ossKey = `videos/upscaled/${crypto.randomUUID()}-${normalizedResolution}.mp4`
    const ossUrl = await uploadBufferToOSS(ossKey, outBuffer, 'video/mp4')

    let version: number | undefined
    let assetId: number | undefined
    if (options.chapterId != null) {
      const assetType = options.assetType || 'video'
      const sceneIndex = options.sceneIndex ?? 0
      const shotIndex = options.shotIndex ?? 0
      const recorded = await recordShotAssetVersion({
        chapterId: options.chapterId,
        sceneIndex,
        shotIndex,
        assetType,
        url: ossUrl,
        prompt: `HD Upscale (${normalizedResolution.toUpperCase()})`,
        modelKey: `ffmpeg-lanczos-${normalizedResolution}`,
        params: {
          sourceUrl: cleanUrl,
          targetResolution: normalizedResolution,
          width,
          height,
        },
        status: 'done',
      })
      version = recorded.version
      assetId = recorded.id
      if (assetType === 'video') {
        await selectShotAssetVersion({
          chapterId: options.chapterId,
          sceneIndex,
          shotIndex,
          assetType: 'video',
          version: recorded.version,
        }).catch(() => {})
      }
    }

    return {
      url: ossUrl,
      width,
      height,
      targetResolution: normalizedResolution,
      ...(version !== undefined ? { version } : {}),
      ...(assetId !== undefined ? { assetId } : {}),
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}
