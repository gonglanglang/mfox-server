import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db, schema, type DbExecutor } from '../mysqlDb'
import { addPoints, consumeModelPoints, resolveModelCost } from './index'
import { resolveStoryboardPanel } from './storyboard-panel'
import { frameContinuityPlan, framePlanSnapshot } from './frame-continuity'
import { assertFramePromptPair } from './frame-prompts'
import { normalizeShotLink } from './storyboard-text'

/** 双帧模式下每次重绘固定出图张数：首帧 + 尾帧各一张；主流单帧模式（single）仅生成 1 张首帧。 */
export const REDRAW_FRAME_COUNT = 2

export type FrameRedrawMode = 'single' | 'dual' | 'video_tail'

export interface FrameRedrawRun {
  id: string
  cost: number
  status: 'charged' | 'done' | 'refunded'
  snapshot?: string
  imageUnitCost?: number
  usedCost?: number
  refundedCost?: number
  frameMode?: FrameRedrawMode
  /** 提交时间（ISO）。缺失说明是旧版本写入的 run，接管时按陈旧处理。 */
  startedAt?: string
}

// ============================================
// 活跃 run 注册表与遗留任务接管
// 重绘的终态由 settleFrameRedraw 落库：若进程在“图片已保存、结算未执行”之间退出，
// 分镜会永久停在 generating、预扣积分不退，用户也无法重新提交（被“正在生成中”挡住）。
// 这里用进程内注册表区分“真的还在跑”与“遗留”，让遗留任务被下一次提交自动接管并退款。
// ============================================
const activeRedrawRuns = new Set<string>()

/** 超过该时长仍未结算的 run 视为陈旧（进程没有重启但任务已死时兜底）。 */
export const STALE_REDRAW_MS = 20 * 60_000

/**
 * 是否应接管分镜上遗留的 charged run：
 * - 非重绘任务（例如视频）或已结算的 run 一律不接管
 * - 进程内仍活跃且未超过陈旧阈值 → 不接管（交回调用方报“生成中”）
 * - 进程重启后注册表为空、或已超过阈值 → 接管
 */
export function shouldTakeOverRedraw(
  panel: { panelStatus?: string; _task?: string; redrawRun?: { id?: string; status?: string; startedAt?: string } } | undefined,
  activeRuns: ReadonlySet<string>,
  now = Date.now(),
): boolean {
  if (panel?.panelStatus !== 'generating' || panel?._task !== 'redraw') return false
  const run = panel.redrawRun
  if (!run?.id || run.status !== 'charged') return false
  if (!activeRuns.has(run.id)) return true
  const startedAt = Date.parse(String(run.startedAt || ''))
  return !Number.isFinite(startedAt) || now - startedAt > STALE_REDRAW_MS
}

/**
 * 遗留 run 的退款额：已用成本缺失按 0（全额退），负数或超过预扣额时钳制。
 * 与结算成功分支共用，保证“缺失即全额退”在两条路径上一致。
 */
export function abandonedRefund(cost: number, usedCost: number | undefined): number {
  const safeCost = Number.isFinite(cost) ? Math.max(0, cost) : 0
  const used = Number.isFinite(usedCost) ? Math.min(Math.max(0, Number(usedCost)), safeCost) : 0
  return Math.max(0, safeCost - used)
}

/**
 * 接管遗留 run：图已落库（save-frames 写过 usedCost）则按已用成本结算并标记完成，
 * 否则全额退款并回退到 error；两种情况都允许用户重新提交。
 * 必须在调用方的章节行锁事务内执行（退款与状态同事务提交）。
 */
async function settleAbandonedRedraw(userId: number, panel: any, executor: DbExecutor) {
  const run = panel.redrawRun as FrameRedrawRun
  const refund = abandonedRefund(run.cost, run.usedCost)
  const used = run.cost - refund
  if (refund > 0 && !await addPoints(userId, refund, executor)) throw new Error('分镜重绘遗留任务退款失败')
  run.refundedCost = (run.refundedCost || 0) + refund
  run.status = used > 0 ? 'done' : 'refunded'
  panel.panelStatus = used > 0 ? 'done' : 'error'
  panel.taskError = used > 0 ? '' : '上一次重绘未完成，已自动退款，可重新生成'
  panel._task = ''
  panel.redrawRun = run
  console.warn(`[frame-redraw] 接管遗留任务 ${run.id}：已用 ${used}，退款 ${refund}`)
}

export async function quoteFrameRedraw(input: {
  userId: number; workId: number; chapterId: number; panelIdx: number
  imageModel: string
  /** 档位（与模型 price_config 对齐）：resolution 优先，quality 为历史兼容 */
  resolution?: string; quality?: string
  /** 关键帧模式：single=主流单帧驱动（仅出1张首帧）/ dual=首尾双帧（出2张） */
  frameMode?: FrameRedrawMode
}) {
  const [chapter] = await db.select().from(schema.chapters).where(and(
    eq(schema.chapters.id, input.chapterId), eq(schema.chapters.work_id, input.workId), eq(schema.chapters.user_id, input.userId),
  ))
  if (!chapter) throw new Error('章节不存在')
  const configs = (chapter.content_configs as any[]) || []
  const target = resolveStoryboardPanel(configs, input.panelIdx)
  const effectiveFrameMode: FrameRedrawMode = input.frameMode || target?.panel?.frame_mode || 'dual'
  const plan = frameContinuityPlan(configs, input.panelIdx, { frameMode: effectiveFrameMode })
  if (!input.imageModel) throw new Error('请选择图片模型')
  const [model] = await db.select().from(schema.ai_models).where(and(
    eq(schema.ai_models.model, input.imageModel), eq(schema.ai_models.content_type, 'image'),
    eq(schema.ai_models.status, 1),
  )).limit(1)
  if (!model) throw new Error('模型不存在或已停用')
  const isContinuous = normalizeShotLink(plan.current).type === 'continuous'
  const frameCount = effectiveFrameMode === 'single' ? 1 : REDRAW_FRAME_COUNT
  return { linked: Boolean(plan.previous && isContinuous), cost: frameCount * resolveModelCost(model, input.resolution || input.quality) }
}

/** 原子校验分镜、预扣积分并占用该分镜；不创建 ai_tasks 记录。 */
export async function beginFrameRedraw(input: {
  userId: number
  workId: number
  chapterId: number
  panelIdx: number
  imageModel: string
  /** 档位（与模型 price_config 对齐）：resolution 优先，quality 为历史兼容 */
  resolution?: string; quality?: string
  /** 前端确认过的报价；必填，避免参数变化后按旧报价静默扣费 */
  expectedCost: number
  /** 关键帧模式：single=主流单帧驱动（仅出1张首帧）/ dual=首尾双帧（出2张） */
  frameMode?: FrameRedrawMode
}) {
  if (!Number.isFinite(input.expectedCost) || input.expectedCost < 0)
    throw new Error('缺少有效的预计积分，请重新确认重绘')
  const runId = randomUUID()
  const result = await db.transaction(async tx => {
    await tx.select({ id: schema.users.id }).from(schema.users)
      .where(eq(schema.users.id, input.userId)).for('update')
    const [chapter] = await tx.select().from(schema.chapters).where(and(
      eq(schema.chapters.id, input.chapterId),
      eq(schema.chapters.work_id, input.workId),
      eq(schema.chapters.user_id, input.userId),
    )).for('update')
    if (!chapter) throw new Error('章节不存在')

    const configs = (chapter.content_configs as any[]) || []
    const target = resolveStoryboardPanel(configs, input.panelIdx)
    if (!target) throw new Error('分镜不存在')
    const { panel } = target
    if (panel.panelStatus === 'generating') {
      // 遗留任务（进程重启或结算失败）先接管退款，再允许重新提交；仍在运行的则维持原行为
      if (!shouldTakeOverRedraw(panel, activeRedrawRuns)) throw new Error('分镜正在生成中，请稍后')
      await settleAbandonedRedraw(input.userId, panel, tx)
    }

    const effectiveFrameMode: FrameRedrawMode = input.frameMode || panel.frame_mode || 'dual'
    if (input.frameMode && ['single', 'dual', 'video_tail'].includes(input.frameMode)) {
      panel.frame_mode = input.frameMode
      target.commit()
    }
    const plan = frameContinuityPlan(configs, input.panelIdx, { frameMode: effectiveFrameMode })

    if (effectiveFrameMode === 'single') {
      if (typeof panel.start_prompt !== 'string' || !panel.start_prompt.trim())
        throw new Error('请先填写首帧提示词')
      assertFramePromptPair(panel.start_prompt, String(panel.end_prompt || ''))
    } else {
      if (typeof panel.start_prompt !== 'string' || !panel.start_prompt.trim()
        || typeof panel.end_prompt !== 'string' || !panel.end_prompt.trim())
        throw new Error('请先填写首帧和尾帧提示词')
      assertFramePromptPair(panel.start_prompt, panel.end_prompt)
    }

    const frameCount = effectiveFrameMode === 'single' ? 1 : REDRAW_FRAME_COUNT
    const imageCharge = await consumeModelPoints(input.userId, input.imageModel, 'image', input.resolution || input.quality, tx, frameCount)
    if (!imageCharge.ok) throw new Error('图片模型不可用或积分不足')
    const cost = imageCharge.cost
    if (input.expectedCost !== cost) throw new Error('预计积分已变化，请重新确认重绘')

    panel.panelStatus = 'generating'
    panel._task = 'redraw'
    panel.taskError = ''
    panel.redrawRun = {
      id: runId,
      cost,
      status: 'charged',
      snapshot: framePlanSnapshot(plan),
      frameMode: effectiveFrameMode,
      startedAt: new Date().toISOString(),
      imageUnitCost: imageCharge.cost / frameCount,
    } satisfies FrameRedrawRun
    target.commit()
    await tx.update(schema.chapters).set({ content_configs: configs })
      .where(eq(schema.chapters.id, input.chapterId))
    return { panel, runId, cost, frameMode: effectiveFrameMode }
  })
  // 事务提交后才登记为活跃；进程重启后注册表为空，正是需要接管遗留任务的场景
  activeRedrawRuns.add(runId)
  return result
}

/**
 * 以分镜上的 runId 作为幂等结算凭据；失败仅退款一次。
 * @returns 是否真的完成了本次结算（无效 runId 或已结算返回 false）
 */
export async function settleFrameRedraw(input: {
  userId: number
  chapterId: number
  panelIdx: number
  runId: string
  failure?: string
}) {
  // 进入结算即不再活跃：先摘除注册表，让结算失败后的遗留 run 能被下一次提交立即接管
  activeRedrawRuns.delete(input.runId)
  return db.transaction(async tx => {
    await tx.select({ id: schema.users.id }).from(schema.users)
      .where(eq(schema.users.id, input.userId)).for('update')
    const [chapter] = await tx.select().from(schema.chapters)
      .where(eq(schema.chapters.id, input.chapterId)).for('update')
    if (!chapter) throw new Error('章节不存在')

    const configs = (chapter.content_configs as any[]) || []
    const target = resolveStoryboardPanel(configs, input.panelIdx)
    if (!target) throw new Error('分镜不存在')
    const { panel } = target
    const run = panel.redrawRun as FrameRedrawRun | undefined
    if (!run || run.id !== input.runId || run.status !== 'charged') return false

    if (input.failure) {
      if (run.cost > 0 && !await addPoints(input.userId, run.cost, tx)) throw new Error('分镜重绘退款失败')
      run.status = 'refunded'
      run.refundedCost = run.cost
      panel.panelStatus = 'error'
      panel.taskError = input.failure
    } else {
      // usedCost 由 save-frames 与图片同事务写入；缺失说明面板数据被外部改动，按 0 计（全额退款）并告警
      if (!Number.isFinite(run.usedCost)) console.warn(`[frame-redraw] run ${run.id} 缺少 usedCost，按 0 结算`)
      const refund = abandonedRefund(run.cost, run.usedCost)
      if (refund > 0 && !await addPoints(input.userId, refund, tx)) throw new Error('分镜重绘剩余积分退还失败')
      run.refundedCost = refund
      run.status = 'done'
      panel.panelStatus = 'done'
      panel.taskError = ''
    }
    panel.redrawRun = run
    target.commit()
    await tx.update(schema.chapters).set({ content_configs: configs })
      .where(eq(schema.chapters.id, input.chapterId))
    return true
  })
}
