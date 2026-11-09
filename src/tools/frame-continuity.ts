import { z } from 'zod'
import { resolveStoryboardPanel } from './storyboard-panel'
import { frameSeed, shotFrameRef } from './frame-pool'
import { normalizeShotLink } from './storyboard-text'

export const shotLinkSchema = z.object({
  type: z.enum(['continuous', 'cut', 'transition']),
  match: z.enum(['action', 'eyeline', 'graphic', 'sound']).nullable().optional(),
  anchor: z.string().optional(),
})

export const frameShotSchema = z.object({
  panelIdx: z.number().int().nonnegative(),
  start_prompt: z.string(), end_prompt: z.string(), content: z.string(), negative_prompt: z.string(),
  shot_size: z.string().default(''), camera_angle: z.string().default(''), camera_movement: z.string().default(''),
  firstFrameUrl: z.string(), lastFrameUrl: z.string(),
  /** 关键帧引用（帧池 frameId）；空串表示旧数据走内联 URL */
  start_frame_id: z.string().default(''), end_frame_id: z.string().default(''),
  /** 该帧的生成种子：复现与断链排查用 */
  start_seed: z.number().int().nullable().default(null), end_seed: z.number().int().nullable().default(null),
  roles: z.array(z.object({ id: z.coerce.number().int().positive() })),
  /** 镜头与上一镜的衔接关系（缺省按 continuous 处理） */
  link: shotLinkSchema.optional(),
  /** 关键帧模式：single=主流单帧驱动 / dual=首尾双帧 / video_tail=视频末帧续接 */
  frame_mode: z.enum(['single', 'dual', 'video_tail']).optional(),
  /** 前序不可逆世界与道具状态锁 */
  world_state: z.string().default(''),
})
export const framePlanSchema = z.object({
  sceneIdx: z.number().int(), scene_id: z.coerce.number().int().positive(),
  prop_ids: z.array(z.coerce.number().int().positive()), environment: z.string(),
  current: frameShotSchema, previous: frameShotSchema.nullable(), next: frameShotSchema.nullable(),
})

/**
 * 同场景按「关键帧模式（frame_mode）」与「衔接类型（link.type）」决定关键帧策略：
 * - single（市场主流单关键帧模式）：每镜仅生成 1 张主关键帧（firstFrameUrl），通过单帧 I2V + 动作演进生成视频，
 *   无需强制上一镜先生成尾帧，也彻底消除首尾两张静态 AI 图对不齐的问题；
 * - video_tail（视频真实末帧承接模式）：直接截取上一镜成片视频的真实最后一帧作为本镜首帧；
 * - dual（首尾双帧模式）+ continuous：镜头 i 的首帧继承镜头 i-1 的尾帧（共享同一个 frameId），执行三层断链校验；
 * - cut / transition 或跨场景：一律独立生成首帧。
 */
export function frameContinuityPlan(
  configs: any[],
  panelIdx: number,
  options?: { frameMode?: 'single' | 'dual' | 'video_tail' },
) {
  const current = resolveStoryboardPanel(configs, panelIdx)
  if (!current || current.sceneIdx === undefined) throw new Error('分镜数据格式无效')
  const describe = (panel: any, index: number, scene: any) => {
    const startRef = shotFrameRef(panel, 'start')
    const endRef = shotFrameRef(panel, 'end')
    const rawFrameMode = String(panel.frame_mode || '').trim()
    return {
      panelIdx: index, start_prompt: String(panel.start_prompt || ''), end_prompt: String(panel.end_prompt || ''), content: String(panel.content || ''),
      negative_prompt: String(panel.negative_prompt || ''), firstFrameUrl: String(panel.firstFrameUrl || ''), lastFrameUrl: String(panel.lastFrameUrl || ''),
      shot_size: String(panel.shot_size || ''), camera_angle: String(panel.camera_angle || ''), camera_movement: String(panel.camera_movement || ''),
      start_frame_id: startRef, end_frame_id: endRef,
      start_seed: frameSeed(scene, startRef), end_seed: frameSeed(scene, endRef),
      roles: panel.roles || [],
      ...(panel.link ? { link: normalizeShotLink(panel) } : {}),
      ...(['single', 'dual', 'video_tail'].includes(rawFrameMode) ? { frame_mode: rawFrameMode as 'single' | 'dual' | 'video_tail' } : {}),
      world_state: String(panel.world_state || ''),
    }
  }
  const neighbor = (index: number) => {
    const target = resolveStoryboardPanel(configs, index)
    if (!target || target.sceneIdx !== current.sceneIdx) return null
    if (target.panel.panelStatus === 'generating') throw new Error('相邻镜头正在生成，请稍后再重绘')
    return describe(target.panel, index, target.scene)
  }
  const previous = panelIdx > 0 ? neighbor(panelIdx - 1) : null
  const next = neighbor(panelIdx + 1)
  const currentLink = normalizeShotLink(current.panel)
  const effectiveFrameMode = options?.frameMode || current.panel.frame_mode || 'dual'

  if (effectiveFrameMode === 'dual' && previous && currentLink.type === 'continuous') {
    if (!previous.lastFrameUrl.trim()) throw new Error('请先生成同场景上一镜头的尾帧')
    // 断链校验 1：两张图必须是同一张（URL 层面，id 与旧内联数据都适用）
    if (current.panel.firstFrameUrl && current.panel.firstFrameUrl !== previous.lastFrameUrl)
      throw new Error('帧链断裂：本镜首帧与上一镜尾帧不是同一张图，请重新生成上一镜尾帧后再试')
    // 断链校验 2：若两侧都记了帧引用，必须是同一个 frameId
    const currentStartRef = shotFrameRef(current.panel, 'start')
    if (previous.end_frame_id && currentStartRef && previous.end_frame_id !== currentStartRef)
      throw new Error('帧链断裂：本镜首帧未引用上一镜尾帧对应的关键帧，请重新生成本镜首帧')
    // 断链校验 3：同一张画面必须记录同一个种子
    if (previous.end_seed != null && currentStartRef === previous.end_frame_id) {
      const currentSeed = frameSeed(current.scene, currentStartRef)
      if (currentSeed != null && currentSeed !== previous.end_seed)
        throw new Error('帧链断裂：本镜首帧与上一镜尾帧的种子不一致，请重新生成')
    }
  }
  const scene = configs[current.sceneIdx]
  return framePlanSchema.parse({ sceneIdx: current.sceneIdx, scene_id: scene.scene_id,
    prop_ids: scene.prop_ids || [], environment: scene.environment || '',
    current: describe(current.panel, panelIdx, current.scene), previous, next })
}

/** 图片及脚本快照；生成期间任何相邻画面或提示词变化都需重新审查。 */
export function framePlanSnapshot(plan: z.infer<typeof framePlanSchema>) {
  return JSON.stringify(plan)
}
