import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import { db, schema } from '../mysqlDb'
import { selectedAssetImage } from './storyboard-assets'

interface StoryboardConfig {
  scene_id: number | string
  prop_ids: (number | string)[]
  shots: { roles: { id: number | string }[] }[]
}

/** 递归移除空值；清理后为空的数组/对象也移除，不修改源数据。 */
function cleanEmptyValue(value: unknown): unknown {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return undefined
  if (Array.isArray(value)) {
    const items = value.map(cleanEmptyValue).filter(item => item !== undefined)
    return items.length ? items : undefined
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).flatMap(([key, item]) => {
      const cleaned = cleanEmptyValue(item)
      return cleaned === undefined ? [] : [[key, cleaned] as const]
    })
    return entries.length ? Object.fromEntries(entries) : undefined
  }
  return value
}

function cleanEmptyFields<T extends object>(value: T): Partial<T> {
  return (cleanEmptyValue(value) ?? {}) as Partial<T>
}

/** 不传 configs 加载可选素材；传入时仅加载最新分镜引用的素材（空数组返回空结果）。 */
export async function loadStoryboardEvidence(
  scope: { workId: number; chapterId: number; userId: number },
  configs?: StoryboardConfig[],
) {
  const normalizeIds = (values: (number | string)[]) => [...new Set(values.map(value => {
    const id = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new Error('素材 ID 必须为正整数')
    return id
  }))]
  normalizeIds([scope.workId, scope.chapterId, scope.userId])
  const filters = []
  if (configs === undefined) {
    filters.push(eq(schema.personas.source_type, 'persona'), eq(schema.personas.source_type, 'prop'),
      and(eq(schema.personas.source_type, 'scene'), eq(schema.personas.chapters_id, scope.chapterId)))
  } else {
    const sceneIds = normalizeIds(configs.map(config => config.scene_id))
    const propIds = normalizeIds(configs.flatMap(config => config.prop_ids))
    const roleIds = normalizeIds(configs.flatMap(config => config.shots.flatMap(shot => shot.roles.map(role => role.id))))
    if (roleIds.length) filters.push(and(eq(schema.personas.source_type, 'persona'), inArray(schema.personas.id, roleIds)))
    if (propIds.length) filters.push(and(eq(schema.personas.source_type, 'prop'), inArray(schema.personas.id, propIds)))
    if (sceneIds.length) filters.push(and(eq(schema.personas.source_type, 'scene'), inArray(schema.personas.id, sceneIds), eq(schema.personas.chapters_id, scope.chapterId)))
  }
  const rows = filters.length ? await db.select().from(schema.personas).where(and(
    eq(schema.personas.work_id, scope.workId), eq(schema.personas.user_id, scope.userId), isNull(schema.personas.deleted_at), or(...filters),
  )).orderBy(schema.personas.id) : []
  const assets = rows.map(asset => {
    const image = selectedAssetImage(asset)
    return cleanEmptyFields({
      id: asset.id, type: asset.source_type, name: asset.name,
      height: asset.height ?? null,
      description: asset.description, detail: asset.detail,
      image: image?.url || '', imageId: image?.id || null,
    })
  })
  return cleanEmptyFields({
    roles: assets.filter(asset => asset.type === 'persona'),
    scene: assets.filter(asset => asset.type === 'scene'),
    props: assets.filter(asset => asset.type === 'prop'),
    assets,
  })
}
