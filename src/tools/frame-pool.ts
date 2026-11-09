import { sanitizeDialogueList } from './storyboard-text'

/**
 * 关键帧池：同一张画面只存一份，shot 只存引用。
 *
 * 结构挂在**场景**上（不是 content_configs 顶层——它是数组，数组挂不了命名键）：
 *   scene._frames = { [frameId]: { url, seed?, created_at? } }
 *   shot.start_frame_id / shot.end_frame_id → 池中的 frameId
 *
 * 链式语义：第 i 镜的 end_frame_id 就是第 i+1 镜的 start_frame_id（同一张图、同一个 id），
 * 所以同一张画面在库里只有一份。跨场景不衔接，池按场景隔离即可，池边界与链式边界一致。
 *
 * 兼容旧数据：shot 上直接内联 firstFrameUrl / lastFrameUrl（没有 id）时按内联字段读取；
 * 一旦写入新帧，内联字段会被移除并升级为 id 引用。
 */
export const FRAME_POOL_KEY = '_frames'
export const START_FRAME_KEY = 'start_frame_id'
export const END_FRAME_KEY = 'end_frame_id'

export interface FrameEntry {
  url: string
  /** 生成该帧使用的种子：复现与断链排查用 */
  seed?: number
  created_at?: string
}

export type FrameKind = 'start' | 'end'

const REF_KEYS: Record<FrameKind, string> = { start: START_FRAME_KEY, end: END_FRAME_KEY }
const LEGACY_KEYS: Record<FrameKind, string> = { start: 'firstFrameUrl', end: 'lastFrameUrl' }

function normalizeFrameId(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

/** 读取场景帧池（不存在则就地创建）。 */
export function framePool(scene: any): Record<string, FrameEntry> {
  if (!scene || typeof scene !== 'object') return {}
  const pool = scene[FRAME_POOL_KEY]
  if (!pool || typeof pool !== 'object' || Array.isArray(pool)) scene[FRAME_POOL_KEY] = {}
  return scene[FRAME_POOL_KEY]
}

/** 池中某帧的 URL；帧缺失返回空串。 */
export function frameUrl(scene: any, frameId: unknown): string {
  const id = normalizeFrameId(frameId)
  if (!id) return ''
  const entry = framePool(scene)[id]
  return entry && typeof entry.url === 'string' ? entry.url.trim() : ''
}

/** 池中某帧的 seed；缺失返回 null。 */
export function frameSeed(scene: any, frameId: unknown): number | null {
  const id = normalizeFrameId(frameId)
  if (!id) return null
  const seed = framePool(scene)[id]?.seed
  return typeof seed === 'number' && Number.isFinite(seed) ? seed : null
}

/** shot 上某端的 frameId 引用（没有引用返回空串）。 */
export function shotFrameRef(shot: any, kind: FrameKind): string {
  return normalizeFrameId(shot?.[REF_KEYS[kind]])
}

/** 解析 shot 某端的实际图片 URL：优先 id 引用，其次旧内联字段。 */
export function shotFrameUrl(scene: any, shot: any, kind: FrameKind): string {
  const id = shotFrameRef(shot, kind)
  if (id) return frameUrl(scene, id)
  const legacy = shot?.[LEGACY_KEYS[kind]]
  return typeof legacy === 'string' ? legacy.trim() : ''
}

/** 存入一帧：同一 URL 复用同一 frameId，避免同一张画面在池里存两份。 */
export function putFrame(scene: any, frame: { url: string; seed?: number | null }): string {
  const url = String(frame?.url || '').trim()
  if (!url) throw new Error('帧图 URL 不能为空')
  const pool = framePool(scene)
  for (const [id, entry] of Object.entries(pool)) {
    if (String(entry?.url || '').trim() === url) {
      if (entry.seed == null && typeof frame.seed === 'number' && Number.isFinite(frame.seed)) entry.seed = frame.seed
      return id
    }
  }
  let index = Object.keys(pool).length + 1
  while (pool[`f${index}`]) index += 1
  const id = `f${index}`
  pool[id] = {
    url,
    ...(typeof frame.seed === 'number' && Number.isFinite(frame.seed) ? { seed: frame.seed } : {}),
    created_at: new Date().toISOString(),
  }
  return id
}

/**
 * 设置（或清空）shot 某端的帧引用。
 * 传 frame：写入池并升级为 id 引用（移除旧内联字段）；传 null：清空引用。
 * @returns 写入后的 frameId（清空时为空串）
 */
export function setShotFrame(
  scene: any, shot: any, kind: FrameKind,
  frame: { url: string; seed?: number | null } | null,
): string {
  if (!shot || typeof shot !== 'object') return ''
  const refKey = REF_KEYS[kind]
  const legacyKey = LEGACY_KEYS[kind]
  const url = String(frame?.url || '').trim()
  if (!url) {
    delete shot[refKey]
    delete shot[legacyKey]
    return ''
  }
  const id = putFrame(scene, { url, seed: frame?.seed ?? null })
  shot[refKey] = id
  delete shot[legacyKey]
  return id
}

/**
 * 把某帧写入池，并挂到 panel（resolveStoryboardPanel 的派生视图）的引用字段上。
 *
 * 为什么必须写 panel 而不是直接改 shot：panel 在解析时快照了 shot 的字段，
 * commit() 会把它写回 shot，直接改 shot 会被覆盖。所以帧引用统一走 panel 字段 + 池。
 * @returns 写入后的 frameId（清空时为空串）
 */
export function assignPanelFrame(
  scene: any, panel: any, kind: FrameKind,
  frame: { url: string; seed?: number | null } | null,
): string {
  if (!panel || typeof panel !== 'object') return ''
  const refKey = REF_KEYS[kind]
  delete panel[LEGACY_KEYS[kind]] // 派生字段不再使用（commit 也会剥离，这里显式清理）
  const url = String(frame?.url || '').trim()
  if (!url) {
    delete panel[refKey]
    return ''
  }
  const id = putFrame(scene, { url, seed: frame?.seed ?? null })
  panel[refKey] = id
  return id
}

/**
 * 下发用：把帧池引用解析成 shot 上的 firstFrameUrl / lastFrameUrl（只读派生视图），
 * 同时自动剔除历史遗留的“无”占位台词。
 *
 * 落库的真源是 shot.start_frame_id / end_frame_id + 场景 _frames 池，
 * 但前端与旧调用方按 firstFrameUrl / lastFrameUrl 读图，所以下发前统一补齐这两个字段。
 * 不修改入参，返回新的场景数组。
 */
export function hydrateFrameUrls(configs: any[]): any[] {
  if (!Array.isArray(configs)) return configs
  return configs.map(scene => {
    if (!Array.isArray(scene?.shots)) return scene
    return {
      ...scene,
      shots: scene.shots.map((shot: any) => ({
        ...shot,
        ...(Array.isArray(shot?.dialogue) ? { dialogue: sanitizeDialogueList(shot.dialogue) } : {}),
        firstFrameUrl: shotFrameUrl(scene, shot, 'start'),
        lastFrameUrl: shotFrameUrl(scene, shot, 'end'),
      })),
    }
  })
}
