import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import { db, schema } from '../mysqlDb'

type StoryboardAsset = typeof schema.personas.$inferSelect

/** 场景限当前章节；角色和道具在作品内复用，查询始终限制用户归属。 */
export async function loadStoryboardAssets(workId: number, chapterId: number, userId: number) {
  return db.select().from(schema.personas).where(and(
    eq(schema.personas.work_id, workId), eq(schema.personas.user_id, userId), isNull(schema.personas.deleted_at),
    or(eq(schema.personas.source_type, 'persona'), eq(schema.personas.source_type, 'prop'),
      and(eq(schema.personas.source_type, 'scene'), eq(schema.personas.chapters_id, chapterId))),
  ))
}

export function validatePanelAssets(panel: any, assets: { id: number; source_type: string }[]) {
  // AI 可能返回 "110"；仅接受整数或十进制数字字符串，避免将空串、布尔值等转换为 ID。
  const assetId = (value: unknown, type: string, label: string): number => {
    const id = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 ||
      !assets.some(asset => asset.id === id && asset.source_type === type)) {
      throw new Error(`分镜引用了无效${label}（ID: ${JSON.stringify(value)}）`)
    }
    return id
  }
  const sceneId = panel.scene_id == null ? null : assetId(panel.scene_id, 'scene', '场景')
  if (panel.prop_ids !== undefined && !Array.isArray(panel.prop_ids)) throw new Error('分镜引用了无效道具')
  if (panel.roles !== undefined && !Array.isArray(panel.roles)) throw new Error('分镜引用了无效角色')
  const propIds = (panel.prop_ids || []).map((id: unknown) => assetId(id, 'prop', '道具'))
  const roles = panel.roles?.map((role: any) => ({ ...role, id: assetId(role?.id, 'persona', '角色') }))
  // 全部校验通过后再写回，避免失败时留下部分转换的数据。
  panel.scene_id = sceneId
  panel.prop_ids = [...new Set(propIds)]
  if (roles !== undefined) panel.roles = roles
}

/** 只使用明确选中且可用的图；缺图不擅自切换其他版本。 */
export function selectedAssetImage(asset: { images: unknown; cur_image_id: string | null }) {
  if (!asset.cur_image_id || !Array.isArray(asset.images)) return null
  return asset.images.find(image => image.id === asset.cur_image_id && image.url &&
    (!image.job_status || image.job_status === 'ready')) || null
}

function uniqueIds(values: unknown[]): number[] {
  return [...new Set(values.flatMap(value => {
    const id = Number(value)
    return Number.isInteger(id) ? [id] : []
  }))]
}

function flattenPromptAsset(asset: StoryboardAsset) {
  const image = selectedAssetImage(asset)
  const detail = asset.detail && typeof asset.detail === 'object' && !Array.isArray(asset.detail)
    ? asset.detail as Record<string, unknown>
    : {}
  return {
    ...detail,
    id: asset.id,
    type: asset.source_type,
    name: asset.name,
    height: asset.height ?? null, // 人物身高（cm）：提示词里的尺度锚点
    description: asset.description || '',
    imageId: image?.id || null,
    image: image?.url || '',
  }
}

/** 一次查询并整理角色、道具、场景描述及当前选中的场景图片 URL。 */
export async function loadPanelPromptReferences(input: {
  workId: number // 作品 ID
  chapterId: number // 章节 ID
  userId: number // 用户 ID
  roles?: { id?: unknown }[] // 角色 ID 列表
  sceneId: number // 场景 ID
  propIds?: number[] // 道具 ID 列表
}) {
  const roleIds = uniqueIds((input.roles || []).map(role => role?.id))
  const propIds = uniqueIds(input.propIds || [])
  const requestedIds = uniqueIds([...roleIds, input.sceneId, ...propIds])
  const queriedAssets = requestedIds.length
    ? await db.select().from(schema.personas).where(and(
      inArray(schema.personas.id, requestedIds),
      eq(schema.personas.work_id, input.workId),
      eq(schema.personas.user_id, input.userId),
      isNull(schema.personas.deleted_at),
    ))
    : []

  const byId = new Map(queriedAssets.map(asset => [asset.id, asset]))
  const roleAssets = roleIds.flatMap(id => {
    const asset = byId.get(id)
    return asset?.source_type === 'persona' ? [asset] : []
  })
  const candidateScene = byId.get(input.sceneId)
  const sceneAsset = candidateScene?.source_type === 'scene' && candidateScene.chapters_id === input.chapterId
    ? candidateScene
    : null
  const propAssets = propIds.flatMap(id => {
    const asset = byId.get(id)
    return asset?.source_type === 'prop' ? [asset] : []
  })
  const assets = [...roleAssets, ...(sceneAsset ? [sceneAsset] : []), ...propAssets]

  // 校验分镜引用的资产是否存在
  validatePanelAssets({
    roles: roleIds.map(id => ({ id })),
    scene_id: input.sceneId,
    prop_ids: propIds,
  }, assets)

  const roles = roleAssets.map(flattenPromptAsset)
  const scene = sceneAsset?.description || ''
  const sceneImage = sceneAsset ? selectedAssetImage(sceneAsset)?.url || '' : ''
  const props = propAssets.map(flattenPromptAsset)

  return {
    roles, // 角色描述
    scene, // 场景描述
    sceneImage, // 当前选中的场景图片 URL；没有可用图片时为空字符串
    props, // 道具描述
  }
}

// ============================================
// StyleProfile：作品画风（复用 visual_styles 画风体系）
// ============================================

/** 未选择画风时的兜底画风描述（正常流程里画风为作品必选项）。 */
export const DEFAULT_STYLE_PROMPT = 'Chinese webtoon style, cel-shaded, vibrant colors, 16:9 cinematic composition, high quality illustration, clean lineart'

export interface StyleProfile {
  /** 画风描述（visual_styles.description）；为空时回退 DEFAULT_STYLE_PROMPT */
  prompt: string
  /** 画风参考图（visual_styles.effect_image）；没有参考图时为空串 */
  referenceUrl: string
}

/**
 * 读取作品所选画风（works.style_id → visual_styles）：
 * description 作为全局风格描述，effect_image 作为风格参考图。
 * 画风为官方内置或用户自定义，二者同表管理。
 */
export async function loadWorkStyleProfile(scope: { workId: number; userId: number }): Promise<StyleProfile> {
  const [work] = await db.select({ styleId: schema.works.style_id }).from(schema.works)
    .where(and(eq(schema.works.id, scope.workId), eq(schema.works.user_id, scope.userId)))
    .limit(1)
  const styleId = Number(work?.styleId)
  if (!Number.isSafeInteger(styleId) || styleId <= 0) {
    return { prompt: DEFAULT_STYLE_PROMPT, referenceUrl: '' }
  }
  const [style] = await db.select({
    description: schema.visualStyles.description,
    effectImage: schema.visualStyles.effect_image,
  }).from(schema.visualStyles).where(eq(schema.visualStyles.style_id, styleId)).limit(1)
  return {
    prompt: String(style?.description || '').trim() || DEFAULT_STYLE_PROMPT,
    referenceUrl: String(style?.effectImage || '').trim(),
  }
}

// ============================================
// 设定卡（角色 / 场景 / 道具）：拼成英文自然语言段落，注入渲染 prompt
// ============================================

/** 素材快照（loadStoryboardEvidence / loadPanelPromptReferences 的展平结果均兼容）。 */
export interface CardAsset {
  id?: number | string
  type?: string
  name?: string
  gender?: string
  age?: string
  height?: number | null
  description?: string | null
  detail?: unknown
  image?: string
}

export interface CharacterCard {
  id: number | string
  name: string
  /** 角色设定卡正文（英文为主；中文原文片段由渲染 Agent 翻译后写入提示词） */
  text: string
  /** 当前选中角色图 URL（cur_image_id 固定，同一次生成复用同一张） */
  imageUrl: string
}

export interface SceneCard {
  id: number | string
  /** 场景设定卡正文：Setting: location, time, lighting, mood, key props */
  text: string
  imageUrl: string
}

export interface PropCard {
  id: number | string
  name: string
  text: string
  imageUrl: string
}

const AGE_EN: Record<string, string> = { '儿童': 'child', '少年': 'teenager', '青年': 'young adult', '中年': 'middle-aged', '老年': 'elderly', '未知': '' }
const GENDER_EN: Record<string, string> = { male: 'male', female: 'female', unknown: '', '男': 'male', '女': 'female' }

function detailOf(asset?: CardAsset | null): Record<string, unknown> {
  const detail = asset?.detail
  return detail && typeof detail === 'object' && !Array.isArray(detail)
    ? detail as Record<string, unknown>
    : {}
}

function pickDetail(detail: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = detail[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return ''
}

function imageUrlOf(asset?: CardAsset | null): string {
  return typeof asset?.image === 'string' ? asset.image.trim() : ''
}

/**
 * 角色设定卡：优先取 detail 的结构化字段（gender / age_appearance / hair_style_and_color /
 * outfit / accessories / body_shape / distinctive_features），缺失时回退 personas 表上的
 * gender / age / height / description。结构化部分直接拼英文；description 等中文原文原样保留，
 * 由渲染 Agent 在写提示词时翻译成英文。
 */
export function buildCharacterCard(asset?: CardAsset | null): CharacterCard | null {
  if (asset?.id == null) return null
  const id = asset.id
  const name = String(asset.name || '').trim()
  const detail = detailOf(asset)

  const gender = pickDetail(detail, ['gender']) || GENDER_EN[String(asset?.gender || '').trim()] || ''
  const age = pickDetail(detail, ['age_appearance', 'ageAppearance'])
    || AGE_EN[String(asset?.age || '').trim()] || String(asset?.age || '').trim()
  const height = Number.isFinite(asset?.height) ? `${asset.height}cm tall` : ''
  const hair = pickDetail(detail, ['hair_style_and_color', 'hairStyleAndColor'])
  const outfit = pickDetail(detail, ['outfit'])
  const accessories = pickDetail(detail, ['accessories'])
  const bodyShape = pickDetail(detail, ['body_shape', 'bodyShape'])
  const features = pickDetail(detail, ['distinctive_features', 'distinctiveFeatures'])
  const description = String(asset?.description || '').trim()

  const parts: string[] = []
  if (gender || age || height) parts.push([gender, age, height].filter(Boolean).join(', '))
  if (hair) parts.push(hair)
  if (outfit) parts.push(`wearing ${outfit}`)
  if (accessories) parts.push(accessories)
  if (bodyShape) parts.push(bodyShape)
  if (features) parts.push(features)
  if (description) parts.push(`appearance source material (translate to English in prompts): ${description}`)
  if (!parts.length) parts.push('appearance not specified')

  return {
    id,
    name,
    imageUrl: imageUrlOf(asset),
    text: `Character ${name || `ID:${id}`} (ID:${id}): ${parts.join('. ')}.`,
  }
}

/** 场景设定卡：detail 里的 location/time/lighting/mood/key_props（含别名），缺项回退 description。 */
export function buildSceneCard(asset?: CardAsset | null): SceneCard | null {
  if (asset?.id == null) return null
  const id = asset.id
  const detail = detailOf(asset)

  const location = pickDetail(detail, ['location_name', 'locationName', 'location']) || String(asset?.name || '').trim()
  const time = pickDetail(detail, ['time_of_day', 'timeOfDay', 'time'])
  const lighting = pickDetail(detail, ['lighting'])
  const mood = pickDetail(detail, ['mood'])
  const keyProps = pickDetail(detail, ['key_props', 'keyProps'])
  const description = String(asset?.description || '').trim()

  const parts: string[] = []
  parts.push(location ? `location: ${location}` : 'location: unspecified')
  if (time) parts.push(`time of day: ${time}`)
  if (lighting) parts.push(`lighting: ${lighting}`)
  if (mood) parts.push(`mood: ${mood}`)
  if (keyProps) parts.push(`key props: ${keyProps}`)
  if (description) parts.push(`setting description (translate to English in prompts): ${description}`)

  return {
    id,
    imageUrl: imageUrlOf(asset),
    text: `Setting: ${parts.join(', ')}.`,
  }
}

/** 道具卡：名称 + 描述 + 当前图 URL。 */
export function buildPropCard(asset?: CardAsset | null): PropCard | null {
  if (asset?.id == null) return null
  const id = asset.id
  const name = String(asset?.name || '').trim()
  const description = String(asset?.description || '').trim()
  return {
    id,
    name,
    imageUrl: imageUrlOf(asset),
    text: `Prop ${name || `ID:${id}`} (ID:${id})${description ? `: ${description} (translate to English in prompts)` : ''}.`,
  }
}

export interface CharacterReferenceSnapshot {
  role_id: number
  asset_url: string
  description: string
}

/**
 * 按 role_id 生成角色参考快照：每个角色固定使用其当前选中图（cur_image_id），
 * 同一次生成里同一角色复用同一张 reference_image，不随机选图。
 */
export function buildCharacterReferences(
  roleIds: (number | string | { id?: number | string })[],
  assets: CardAsset[],
): CharacterReferenceSnapshot[] {
  const byId = new Map(assets.map(asset => [String(asset?.id), asset]))
  const seen = new Set<number>()
  const refs: CharacterReferenceSnapshot[] = []
  for (const role of roleIds) {
    const raw = typeof role === 'object' && role !== null ? role.id : role
    const numeric = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw
    if (typeof numeric !== 'number' || !Number.isSafeInteger(numeric) || numeric <= 0 || seen.has(numeric)) continue
    const card = buildCharacterCard(byId.get(String(numeric)) || byId.get(String(raw)))
    if (!card) continue
    seen.add(numeric)
    refs.push({ role_id: numeric, asset_url: card.imageUrl, description: card.text })
  }
  return refs
}
