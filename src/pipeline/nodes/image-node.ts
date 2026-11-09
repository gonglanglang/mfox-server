import { generateFrame } from '../../tools/frame-gen'
import { resolveShotCharacterRefs, resolveShotImagePrompt } from '../../tools/storyboard-text'
import {
  recordShotAssetVersion,
  selectShotAssetVersion,
  type ShotAssetRecord,
} from '../shot-assets-store'

export interface ImageNodeInput {
  chapterId: number
  sceneIndex: number
  shotIndex: number
  assetType?: 'first_frame' | 'last_frame' | 'reference_frame'
  shot?: Record<string, any>
  prompt?: string
  negativePrompt?: string
  modelKey?: string
  resolution?: string
  quality?: string
  aspectRatio?: string
  stylePrompt?: string
  styleReferenceUrl?: string
  /** 可选自定义生成器（供单元测试或特殊适配器注入） */
  generator?: (params: {
    prompt: string
    negativePrompt?: string
    characterReferences: { url: string; role_id?: string | number; description?: string }[]
    referenceFrameUrl?: string
    modelKey?: string
    resolution?: string
    quality?: string
    aspectRatio?: string
  }) => Promise<{ url: string; seed?: number | null }>
}

export interface ImageNodeOutput {
  nodeType: 'image'
  chapterId: number
  sceneIndex: number
  shotIndex: number
  assetType: 'first_frame' | 'last_frame' | 'reference_frame'
  url: string
  version: number
  asset: ShotAssetRecord
  videoNeedsRerun: boolean
}

/**
 * 独立生图节点（ImageGenNode）：
 * - 只重跑目标镜头（sceneIndex, shotIndex），绝不级联覆盖相邻镜头
 * - 使用双提示词中的静态画面提示词（image_prompt ?? start_prompt ?? content）
 * - 注入行级角色参考卡（character_refs）保证跨镜同一角色脸部/服饰一致
 * - 产物写入 shot_assets 新版本并置为 is_current=1，保留历史版本对比
 */
export async function executeImageNode(input: ImageNodeInput): Promise<ImageNodeOutput> {
  const assetType = input.assetType || 'first_frame'
  const shot = input.shot || {}

  const basePrompt =
    input.prompt?.trim()
    || (assetType === 'last_frame'
      ? String(shot.end_prompt || shot.image_prompt || shot.content || '').trim()
      : String(shot.image_prompt || shot.start_prompt || resolveShotImagePrompt(shot)).trim())

  if (!basePrompt) {
    throw new Error(`镜头 (${input.sceneIndex + 1}-${input.shotIndex + 1}) 缺少画面提示词（image_prompt / content）`)
  }

  const charRefs = resolveShotCharacterRefs(shot)
  const charDescriptions = charRefs
    .filter(r => r.name || r.description)
    .map(r => `【角色 ${r.name || r.role_id}】${r.description || ''}`)
    .join('\n')

  const fullPrompt = [
    input.stylePrompt ? `【全局风格】${input.stylePrompt}` : '',
    charDescriptions ? `【角色设定】\n${charDescriptions}` : '',
    shot.scene_tags ? `【场景标签】${shot.scene_tags}` : '',
    shot.lighting ? `【灯光氛围】${shot.lighting}` : '',
    shot.emotion ? `【情绪微表情】${shot.emotion}` : '',
    basePrompt,
  ].filter(Boolean).join('\n')

  const characterReferences = charRefs
    .filter(r => r.image_url)
    .map(r => ({
      url: r.image_url!,
      role_id: r.role_id,
      description: r.description,
    }))

  const referenceFrameUrl = String(shot.reference_frame_url || '').trim() || undefined
  const modelKey = input.modelKey || shot.model_params?.imageModel || 'seedream'
  const resolution = input.resolution || shot.model_params?.resolution || '1024x1024'
  const quality = input.quality || shot.model_params?.quality || '2K'
  const aspectRatio = input.aspectRatio || shot.model_params?.aspectRatio

  let url = ''
  let seed: number | null | undefined = null

  if (input.generator) {
    const res = await input.generator({
      prompt: fullPrompt,
      negativePrompt: input.negativePrompt || shot.negative_prompt,
      characterReferences,
      referenceFrameUrl,
      modelKey,
      resolution,
      quality,
      aspectRatio,
    })
    url = res.url
    seed = res.seed
  } else {
    const res = await generateFrame({
      prompt: fullPrompt,
      negative_prompt: input.negativePrompt || shot.negative_prompt,
      init_image: assetType === 'last_frame' ? shot.firstFrameUrl : referenceFrameUrl,
      style_reference: input.styleReferenceUrl,
      character_references: characterReferences.map(r => ({ url: r.url, role_id: r.role_id })),
      model: modelKey,
      resolution,
      quality,
      aspectRatio,
      label: `分镜节点(${input.sceneIndex + 1}-${input.shotIndex + 1})-${assetType}`,
    })
    url = res.url
    seed = res.seed
  }

  const asset = await recordShotAssetVersion({
    chapterId: input.chapterId,
    sceneIndex: input.sceneIndex,
    shotIndex: input.shotIndex,
    assetType,
    url,
    prompt: fullPrompt,
    modelKey,
    params: {
      resolution,
      quality,
      aspectRatio,
      seed,
      characterRefsCount: characterReferences.length,
    },
    status: 'done',
  })

  const synced = await selectShotAssetVersion({
    chapterId: input.chapterId,
    sceneIndex: input.sceneIndex,
    shotIndex: input.shotIndex,
    assetType,
    version: asset.version,
  }).catch(() => ({ selected: asset, videoNeedsRerun: true }))

  return {
    nodeType: 'image',
    chapterId: input.chapterId,
    sceneIndex: input.sceneIndex,
    shotIndex: input.shotIndex,
    assetType,
    url,
    version: asset.version,
    asset,
    videoNeedsRerun: synced.videoNeedsRerun,
  }
}
