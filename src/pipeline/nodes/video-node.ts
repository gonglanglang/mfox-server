import { generateVideoByModel } from '../../videoTools/generate'
import {
  collectInputs,
  resolveCapability,
  validateParams,
  type CollectedMediaItem,
  type ModelCapability,
  type VideoMode,
} from '../model-schema'
import {
  recordShotAssetVersion,
  selectShotAssetVersion,
  type ShotAssetRecord,
} from '../shot-assets-store'

export interface VideoNodeInput {
  chapterId: number
  sceneIndex: number
  shotIndex: number
  panelIdx?: number
  shot: Record<string, any>
  modelKey: string
  mode?: VideoMode | string
  duration?: number
  resolution?: string
  quality?: string
  aspectRatio?: string
  fps?: number
  capability?: ModelCapability
  /** 可选自定义视频生成器（供单元测试或离线模拟注入） */
  generator?: (params: {
    modelKey: string
    mode: VideoMode
    prompt: string
    media: CollectedMediaItem[]
    duration: number
    resolution: string
    aspectRatio: string
    fps?: number
  }) => Promise<{ videoUrl: string; taskId?: string }>
}

export interface VideoNodeOutput {
  nodeType: 'video'
  chapterId: number
  sceneIndex: number
  shotIndex: number
  assetType: 'video'
  url: string
  mode: VideoMode
  version: number
  asset: ShotAssetRecord
}

/**
 * 独立视频生成节点（VideoGenNode）：
 * - 按 gen_mode（modeType）自动收集首帧/尾帧/多图角色参考/视频参考/音频并校验模型能力 Schema
 * - 使用 motion_prompt ?? subject_motion 驱动动态镜头运动
 * - 产物写入 shot_assets 新版本并置为 is_current=1
 */
export async function executeVideoNode(input: VideoNodeInput): Promise<VideoNodeOutput> {
  const shot = input.shot || {}
  const capability = input.capability || resolveCapability({
    key: input.modelKey,
    capabilities: shot.model_params?.capabilities,
  })

  const requestedMode = input.mode || shot.gen_mode || shot.model_params?.mode
  const collected = collectInputs(shot, requestedMode, capability)

  const duration = input.duration ?? shot.model_params?.duration ?? shot.durShort
  const resolution = input.resolution || shot.model_params?.resolution || input.quality
  const aspectRatio = input.aspectRatio || shot.model_params?.aspectRatio
  const fps = input.fps ?? shot.model_params?.fps

  const paramCheck = validateParams(capability, {
    mode: collected.mode,
    ...(duration !== undefined ? { duration: Number(duration) } : {}),
    ...(resolution ? { resolution } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(fps !== undefined ? { fps: Number(fps) } : {}),
  })
  if (!paramCheck.valid) {
    throw new Error(paramCheck.errors.join('；'))
  }

  const finalPrompt = [
    shot.camera_movement ? `【运镜】${shot.camera_movement}` : '',
    collected.motionPrompt || collected.prompt,
    shot.character_action && shot.character_action !== collected.motionPrompt
      ? `【角色动作】${shot.character_action}`
      : '',
  ].filter(Boolean).join('；') || collected.prompt

  let videoUrl = ''
  let taskId: string | undefined

  if (input.generator) {
    const res = await input.generator({
      modelKey: input.modelKey,
      mode: paramCheck.normalized.mode,
      prompt: finalPrompt,
      media: collected.media,
      duration: paramCheck.normalized.duration,
      resolution: paramCheck.normalized.resolution,
      aspectRatio: paramCheck.normalized.aspectRatio,
      fps: paramCheck.normalized.fps,
    })
    videoUrl = res.videoUrl
    taskId = res.taskId
  } else {
    const res = await generateVideoByModel({
      model: input.modelKey,
      mode: paramCheck.normalized.mode,
      shot,
      content: {
        prompt: finalPrompt,
        media: collected.media.map(m => ({ type: m.type, url: m.url, role: m.role })),
      },
      duration: paramCheck.normalized.duration,
      resolution: paramCheck.normalized.resolution,
      quality: input.quality,
      ratio: paramCheck.normalized.aspectRatio,
      chapterId: input.chapterId,
      panelIdx: input.panelIdx,
    })
    if (!res.success || !res.videoUrl) {
      throw new Error(res.error || '视频节点生成失败')
    }
    videoUrl = res.videoUrl
    taskId = res.taskId
  }

  const asset = await recordShotAssetVersion({
    chapterId: input.chapterId,
    sceneIndex: input.sceneIndex,
    shotIndex: input.shotIndex,
    assetType: 'video',
    url: videoUrl,
    prompt: finalPrompt,
    modelKey: input.modelKey,
    genMode: paramCheck.normalized.mode,
    duration: paramCheck.normalized.duration,
    params: {
      ...paramCheck.normalized,
      mediaCount: collected.media.length,
      ...(taskId ? { taskId } : {}),
    },
    status: 'done',
  })

  await selectShotAssetVersion({
    chapterId: input.chapterId,
    sceneIndex: input.sceneIndex,
    shotIndex: input.shotIndex,
    assetType: 'video',
    version: asset.version,
  }).catch(() => {})

  return {
    nodeType: 'video',
    chapterId: input.chapterId,
    sceneIndex: input.sceneIndex,
    shotIndex: input.shotIndex,
    assetType: 'video',
    url: videoUrl,
    mode: paramCheck.normalized.mode,
    version: asset.version,
    asset,
  }
}
