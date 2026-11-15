import { generateFrame } from '../../tools/frame-gen'
import { numberFrameReferences } from '../../tools/frame-prompts'
import { resolveShotCharacterRefs, resolveShotImagePrompt } from '../../tools/storyboard-text'
import { stripLeadingStylePrefix } from '../../tools/animahub-json'
import { inferEndFramePromptDeterministic } from '../../tools/animahub-storyboard'
import {
  recordShotAssetVersion,
  selectShotAssetVersion,
  type ShotAssetRecord,
} from '../shot-assets-store'

/** AnimaHub 融图创作上限：单次生图最多携带 7 张分类参考图 */
export const MAX_FUSION_REFERENCE_IMAGES = 7

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
  sceneReference?: { id?: string | number | null; text?: string; imageUrl?: string } | null
  propReferences?: { id?: string | number; name?: string; text?: string; imageUrl?: string }[]
  customRefImages?: string[]
  /** 可选自定义生成器（供单元测试或特殊适配器注入） */
  generator?: (params: {
    prompt: string
    negativePrompt?: string
    characterReferences: { url: string; role_id?: string | number; description?: string }[]
    contentReferences?: { url: string; label?: string }[]
    referenceFrameUrl?: string
    styleReferenceUrl?: string
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
 * 独立多图融合生图节点（AnimaHub 融图创作 ImageGenNode）：
 * - 只重跑目标镜头（sceneIndex, shotIndex），绝不级联覆盖相邻镜头
 * - 自动剥离画面提示词头部重复的全局画风前缀（stripLeadingStylePrefix）
 * - 尾帧生图（last_frame）若缺少或雷同于首帧提示词，自动按「首帧 + 运动」推导差异化终态构图
 * - 支持最多 7 张分类融合参考图（init 首帧/参考帧 → style 画风锚 → character 角色三视图 → scene 场景图 → prop 道具图 → custom 自定义参考图）
 * - 产物写入 shot_assets 新版本并置为 is_current=1，保留历史候选槽位供抽屉对比切换
 */
export async function executeImageNode(input: ImageNodeInput): Promise<ImageNodeOutput> {
  const assetType = input.assetType || 'first_frame'
  const shot = input.shot || {}
  const effectiveStylePrompt = String(input.stylePrompt || shot.style_prompt_snapshot || '').trim()

  const startCandidate = stripLeadingStylePrefix(
    String(shot.image_prompt || shot.start_prompt || resolveShotImagePrompt(shot)).trim(),
    effectiveStylePrompt,
  )

  let rawBasePrompt = ''
  if (input.prompt?.trim()) {
    rawBasePrompt = stripLeadingStylePrefix(input.prompt.trim(), effectiveStylePrompt)
  } else if (assetType === 'last_frame') {
    const explicitEnd = stripLeadingStylePrefix(String(shot.end_prompt || '').trim(), effectiveStylePrompt)
    if (explicitEnd && explicitEnd !== startCandidate) {
      rawBasePrompt = explicitEnd
    } else if (startCandidate || shot.motion_prompt || shot.videoPrompt || shot.subject_motion) {
      rawBasePrompt = inferEndFramePromptDeterministic({
        startPrompt: startCandidate,
        motionPrompt: String(shot.motion_prompt || shot.videoPrompt || shot.subject_motion || ''),
        motionOut: shot.motion?.out,
        cameraMovement: shot.camera_movement,
        shotSize: shot.shot_size,
        cameraAngle: shot.camera_angle,
        characterAction: shot.character_action || shot.subject_motion,
        keyPropAction: shot.key_prop_action,
        lighting: shot.lighting,
      })
    }
  } else {
    rawBasePrompt = startCandidate
  }

  if (!rawBasePrompt) {
    throw new Error(`镜头 (${input.sceneIndex + 1}-${input.shotIndex + 1}) 缺少画面提示词（image_prompt / content）`)
  }

  // 合并行级角色卡与快照角色参考
  const charRefs = resolveShotCharacterRefs(shot)
  if (Array.isArray(shot.character_references_snapshot)) {
    const seenIds = new Set(charRefs.map(r => String(r.role_id)))
    for (const snap of shot.character_references_snapshot) {
      const rid = String(snap?.role_id ?? '').trim()
      if (!rid || seenIds.has(rid)) continue
      seenIds.add(rid)
      charRefs.push({
        role_id: rid,
        name: rid,
        description: String(snap?.description || '').trim(),
        ...(snap?.asset_url ? { image_url: String(snap.asset_url).trim() } : {}),
      })
    }
  }

  const sceneRef = input.sceneReference ?? (shot.scene_reference_snapshot
    ? {
        id: shot.scene_reference_snapshot.scene_id,
        text: String(shot.scene_reference_snapshot.text || '').trim(),
        imageUrl: String(shot.scene_reference_snapshot.image_url || '').trim(),
      }
    : null)
  const propRefs = Array.isArray(input.propReferences) ? input.propReferences : []
  const customUrls = [
    ...(Array.isArray(input.customRefImages) ? input.customRefImages : []),
    ...(Array.isArray(shot.custom_ref_images) ? shot.custom_ref_images : []),
  ]
    .map(u => String(u || '').trim())
    .filter(Boolean)

  // 组装最多 7 张分类融合参考图（严格保持传图顺序与「图N」编号一致）
  const referenceFrameUrl = String(shot.reference_frame_url || '').trim() || undefined
  const initCandidate = assetType === 'last_frame'
    ? String(shot.firstFrameUrl || referenceFrameUrl || '').trim() || undefined
    : referenceFrameUrl

  type FusionSlot = {
    slotType: 'init' | 'style' | 'character' | 'content'
    url: string
    label: string
    role_id?: string | number
    description?: string
  }
  const slots: FusionSlot[] = []
  const seenUrls = new Set<string>()
  const pushSlot = (slot: FusionSlot) => {
    const cleanUrl = String(slot.url || '').trim()
    if (!cleanUrl || seenUrls.has(cleanUrl) || slots.length >= MAX_FUSION_REFERENCE_IMAGES) return
    seenUrls.add(cleanUrl)
    slots.push({ ...slot, url: cleanUrl })
  }

  if (initCandidate) {
    pushSlot({
      slotType: 'init',
      url: initCandidate,
      label: assetType === 'last_frame'
        ? '本镜首帧参考图：【保持人物面容、服饰、场景陈设与主光一致，按尾帧提示词演进动作与构图】'
        : '构图参考帧：【延续空间布局与光影基调】',
    })
  }
  if (input.styleReferenceUrl) {
    pushSlot({
      slotType: 'style',
      url: input.styleReferenceUrl,
      label: '全局画风参考图：【严格沿用其笔触、材质与色彩风格】',
    })
  }
  for (const r of charRefs) {
    if (r.image_url) {
      pushSlot({
        slotType: 'character',
        url: r.image_url,
        role_id: r.role_id,
        description: r.description,
        label: `角色参考图：【角色 ${r.name || r.role_id}：严格保持面部五官、发型发色与服饰一致】`,
      })
    }
  }
  if (sceneRef?.imageUrl) {
    pushSlot({
      slotType: 'content',
      url: sceneRef.imageUrl,
      label: '场景参考图：【保持建筑结构、空间陈设与环境色调一致】',
    })
  }
  for (const p of propRefs) {
    if (p?.imageUrl) {
      pushSlot({
        slotType: 'content',
        url: p.imageUrl,
        label: `道具参考图：【道具 ${p.name || p.id || ''}：保持器物造型、材质与花纹一致】`,
      })
    }
  }
  for (const customUrl of customUrls) {
    pushSlot({
      slotType: 'content',
      url: customUrl,
      label: '补充视觉参考图：【参考其局部细节与视觉质感】',
    })
  }

  const numberedRefs = numberFrameReferences(slots.map(s => ({ label: s.label, url: s.url })))
  const charDescriptions = charRefs
    .filter(r => r.name || r.description)
    .map(r => `【角色 ${r.name || r.role_id}】${r.description || ''}`)
    .join('\n')
  const propDescriptions = propRefs
    .filter(p => p?.text || p?.name)
    .map(p => `【道具 ${p.name || p.id || ''}】${p.text || ''}`)
    .join('\n')
  const worldState = String(shot.world_state || '').trim()

  const fullPrompt = [
    numberedRefs.length > 0
      ? `只生成单张完整分镜画面，不要多格拼图。多图融合参考编号如下：\n${numberedRefs.map(r => r.label).join('\n')}`
      : '',
    effectiveStylePrompt ? `【全局风格】${effectiveStylePrompt}` : '',
    charDescriptions ? `【角色设定】\n${charDescriptions}` : '',
    sceneRef?.text ? `【场景设定】${sceneRef.text}` : '',
    propDescriptions ? `【道具设定】\n${propDescriptions}` : '',
    worldState ? `【状态延续锁】${worldState}` : '',
    shot.scene_tags ? `【场景标签】${shot.scene_tags}` : '',
    shot.lighting ? `【灯光氛围】${shot.lighting}` : '',
    shot.emotion ? `【情绪微表情】${shot.emotion}` : '',
    rawBasePrompt,
    '禁止在画面中绘制文字、对话气泡或分格边框。',
  ].filter(Boolean).join('\n')

  const initSlot = slots.find(s => s.slotType === 'init')
  const styleSlot = slots.find(s => s.slotType === 'style')
  const characterReferences = slots
    .filter(s => s.slotType === 'character')
    .map(s => ({
      url: s.url,
      role_id: s.role_id,
      description: s.description,
    }))
  const contentReferences = slots
    .filter(s => s.slotType === 'content')
    .map(s => ({ url: s.url, label: s.label }))

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
      contentReferences,
      referenceFrameUrl: initSlot?.url || referenceFrameUrl,
      styleReferenceUrl: styleSlot?.url,
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
      init_image: initSlot?.url,
      style_reference: styleSlot?.url,
      character_references: characterReferences.map(r => ({ url: r.url, role_id: r.role_id })),
      content_references: contentReferences.map(r => ({ url: r.url })),
      model: modelKey,
      resolution,
      quality,
      aspectRatio,
      label: `分镜融图节点(${input.sceneIndex + 1}-${input.shotIndex + 1})-${assetType}`,
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
      fusionRefCount: slots.length,
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
