import crypto from 'node:crypto'
import { uploadBufferToOSS } from '../../config/oss.config'
import { composeVideos, type ComposeClip, type ComposeOptions } from '../../tools/video-compose'
import { recordShotAssetVersion, type ShotAssetRecord } from '../shot-assets-store'

export interface ComposeNodeInput {
  chapterId: number
  clips: ComposeClip[]
  width?: number
  height?: number
  fps?: number
  bgmUrl?: string
  bgmVolume?: number
  videoAudioMuted?: boolean
  videoAudioVolume?: number
  audioTrackMuted?: boolean
  audioTrackVolume?: number
  onProgress?: (percent: number, stage: string) => void | Promise<void>
  composer?: (options: ComposeOptions) => Promise<{ url: string; durationSec: number }>
}

export interface ComposeNodeOutput {
  nodeType: 'compose'
  chapterId: number
  assetType: 'compose'
  url: string
  durationSec: number
  version: number
  asset: ShotAssetRecord
}

/**
 * 时间线视频合成节点（VideoComposeNode）：
 * - 支持 clips[] 逐段入出点裁剪（sourceOffset / sourceDuration）与分贝调节（decibel）
 * - 支持双轨音量（视频原声静音/音量 + BGM/配音轨静音/音量）
 * - 合成结果记录到 shot_assets（asset_type = 'compose'）支持历史合成版本回溯
 */
export async function executeComposeNode(input: ComposeNodeInput): Promise<ComposeNodeOutput> {
  if (!Array.isArray(input.clips) || input.clips.length === 0) {
    throw new Error('合成节点缺少有效的时间线片段（clips）')
  }

  const width = input.width || 1920
  const height = input.height || 1080
  const fps = input.fps || 24

  const composeOpts: ComposeOptions = {
    clips: input.clips,
    segments: input.clips,
    width,
    height,
    fps,
    bgmUrl: input.bgmUrl,
    bgmVolume: input.bgmVolume,
    videoAudioMuted: input.videoAudioMuted,
    videoAudioVolume: input.videoAudioVolume,
    audioTrackMuted: input.audioTrackMuted,
    audioTrackVolume: input.audioTrackVolume,
    onProgress: input.onProgress,
  }

  let url = ''
  let durationSec = 0

  if (input.composer) {
    const res = await input.composer(composeOpts)
    url = res.url
    durationSec = res.durationSec
  } else {
    const res = await composeVideos(composeOpts)
    durationSec = res.durationSec
    const ossKey = `videos/composed/${crypto.randomUUID()}.mp4`
    url = await uploadBufferToOSS(ossKey, res.buffer, 'video/mp4')
  }

  const asset = await recordShotAssetVersion({
    chapterId: input.chapterId,
    sceneIndex: 0,
    shotIndex: 0,
    assetType: 'compose',
    url,
    prompt: `Timeline Compose (${input.clips.length} clips)`,
    duration: durationSec,
    params: {
      clipsCount: input.clips.length,
      width,
      height,
      fps,
      videoAudioMuted: Boolean(input.videoAudioMuted),
      videoAudioVolume: input.videoAudioVolume ?? 1,
      audioTrackMuted: Boolean(input.audioTrackMuted),
      audioTrackVolume: input.audioTrackVolume ?? 1,
    },
    status: 'done',
  })

  return {
    nodeType: 'compose',
    chapterId: input.chapterId,
    assetType: 'compose',
    url,
    durationSec,
    version: asset.version,
    asset,
  }
}
