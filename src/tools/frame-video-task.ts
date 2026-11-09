import { and, eq } from 'drizzle-orm'
import { db, schema, type DbExecutor } from '../mysqlDb'
import { consumeModelPoints, addPoints } from './index'
import { createTask } from './taskManager'
import { resolveStoryboardPanel } from './storyboard-panel'

/**
 * 进程内活跃视频任务注册表 + 遗留任务接管。
 *
 * 视频任务的终态由 settleFrameVideoTask 落库。若进程在"任务已创建、结算未执行"之间退出
 * （开发时 tsx watch 热重启、线上崩溃/发版都会发生），分镜会永久停在 generating：
 * 前端一直转圈、用户也无法重新提交（被"正在生成中"挡住）。这里用进程内注册表区分
 * "真的还在跑"与"遗留"，让遗留任务被下一次提交（或手动重置）自动接管并退款。
 */
const activeVideoTasks = new Set<string>()

/** 超过该时长仍未结算的活跃任务视为陈旧（进程没重启但轮询卡死时兜底） */
export const STALE_VIDEO_MS = 30 * 60_000

/**
 * 是否应接管该分镜上遗留的视频任务：
 * - 非视频任务（例如重绘）或不是生成中 → 不接管
 * - 没有任务号 → 接管（数据已残缺）
 * - 进程内注册表里没有该任务 → 接管（重启/异常退出，没人再结算它）
 * - 在册但已超过陈旧阈值 → 接管
 */
export function shouldTakeOverVideoTask(
  panel: { panelStatus?: string; _task?: string; videoTaskId?: string; videoTaskStartedAt?: string } | undefined,
  activeTasks: ReadonlySet<string>,
  now = Date.now(),
  staleMs = STALE_VIDEO_MS,
): boolean {
  if (panel?.panelStatus !== 'generating' || panel?._task !== 'video') return false
  const taskId = String(panel.videoTaskId || '').trim()
  if (!taskId) return true
  if (!activeTasks.has(taskId)) return true
  const startedAt = Date.parse(String(panel.videoTaskStartedAt || ''))
  return !Number.isFinite(startedAt) || now - startedAt > staleMs
}

/** 遗留任务当前是否仍在进程内轮询（仅用于提示文案） */
export function isVideoTaskActive(taskId: string): boolean {
  return activeVideoTasks.has(taskId)
}

/**
 * 接管遗留的视频任务：退款 + 解锁 + 把旧任务标记失败。
 * 必须在章节行锁事务内执行（退款与状态同事务提交）；重复执行为幂等空操作。
 */
async function takeOverVideoTask(userId: number, panel: any, executor: DbExecutor, reason: string) {
  const taskId = String(panel.videoTaskId || '').trim()
  const [task] = taskId
    ? await executor.select().from(schema.ai_tasks).where(eq(schema.ai_tasks.taskId, taskId)).for('update')
    : []
  const cost = Number((task?.extra as { cost?: number } | null)?.cost || 0)
  if (cost > 0 && !await addPoints(userId, cost, executor)) throw new Error('视频任务退款失败')
  if (task && task.status === 'running') {
    await executor.update(schema.ai_tasks)
      .set({ status: 'failed', result: reason, updatedAt: new Date() })
      .where(eq(schema.ai_tasks.taskId, taskId))
  }
  panel.panelStatus = 'error'
  panel.taskError = reason
  panel._task = ''
  panel.videoTaskId = ''
  panel.videoTaskStartedAt = ''
  if (taskId) activeVideoTasks.delete(taskId)
  console.warn(`[frame-video] 接管遗留任务 ${taskId || '(无任务号)'}：退款 ${cost}`)
}

/** 锁定章节后创建任务、扣费、标记分镜，避免重复点击造成重复扣费。 */
export async function createFrameVideoTask(
  userId: number,
  chapterId: number,
  panelIdx: number,
  model: string,
  quality?: string,
  resolution?: string,
  workId?: number,
) {
  return db.transaction(async tx => {
    const [chapter] = await tx.select().from(schema.chapters)
      .where(and(eq(schema.chapters.id, chapterId), eq(schema.chapters.user_id, userId), ...(workId ? [eq(schema.chapters.work_id, workId)] : []))).for('update')
    if (!chapter) throw new Error('章节不存在')
    const panels = Array.isArray(chapter.content_configs) ? chapter.content_configs as any[] : []
    const target = resolveStoryboardPanel(panels, panelIdx)
    const panel = target?.panel
    if (!panel?.firstFrameUrl) throw new Error('请先生成分镜首帧')
    if (panel.panelStatus === 'generating') {
      // 先看是不是遗留（进程重启/服务发版导致没人结算）：是则接管并退款，否则按重复提交拒绝
      if (shouldTakeOverVideoTask(panel, activeVideoTasks)) {
        await takeOverVideoTask(userId, panel, tx, '上一次视频生成未完成（服务可能重启过），已自动重置并退回积分')
        target!.commit()
        await tx.update(schema.chapters).set({ content_configs: panels }).where(eq(schema.chapters.id, chapterId))
      } else {
        throw new Error('该分镜正在生成，请勿重复提交')
      }
    }
    // 注：场景最后一个镜头同样参与视频生成——它的尾帧是按本镜【主体动作】演完的终态单独出图，
    // 所以它有自己的"从起点演到终点"，不再复用上一镜尾帧充当自己的全部画面。
    const charge = await consumeModelPoints(userId, model, 'video', resolution || quality, tx)
    if (!charge.ok) throw new Error('视频模型不可用或积分不足')
    const task = await createTask(userId, 'frameVideo', {
      chapterId, panelIdx, model, quality, resolution, cost: charge.cost, router: '/video-storyboard',
    }, tx)
    panel.panelStatus = 'generating'
    panel._task = 'video'
    panel.videoTaskId = task.taskId
    panel.videoTaskStartedAt = new Date().toISOString()
    activeVideoTasks.add(task.taskId)
    target!.commit()
    await tx.update(schema.chapters).set({ content_configs: panels }).where(eq(schema.chapters.id, chapterId))
    return task
  })
}

/**
 * 手动重置卡住的分镜（前端"长时间无响应？点此重置"）：解锁 + 退款 + 旧任务标记失败。
 * 供应商可能仍在出片，但客户端已不再等待它，重新生成更符合预期。
 */
export async function resetStuckVideoTask(userId: number, chapterId: number, panelIdx: number, workId?: number) {
  return db.transaction(async tx => {
    const [chapter] = await tx.select().from(schema.chapters)
      .where(and(eq(schema.chapters.id, chapterId), eq(schema.chapters.user_id, userId), ...(workId ? [eq(schema.chapters.work_id, workId)] : []))).for('update')
    if (!chapter) throw new Error('章节不存在')
    const panels = Array.isArray(chapter.content_configs) ? chapter.content_configs as any[] : []
    const target = resolveStoryboardPanel(panels, panelIdx)
    const panel = target?.panel
    if (!panel) throw new Error('分镜不存在')
    if (panel.panelStatus !== 'generating' || panel._task !== 'video') {
      throw new Error('该分镜当前没有进行中的视频任务')
    }
    await takeOverVideoTask(userId, panel, tx, '已手动重置（若供应商仍在出片，可稍后重新生成）')
    target!.commit()
    await tx.update(schema.chapters).set({ content_configs: panels }).where(eq(schema.chapters.id, chapterId))
    return true
  })
}

/** 失败退款与任务终态一起提交；重复结算不会重复退款。 */
export async function settleFrameVideoTask(taskId: string, failure?: string) {
  activeVideoTasks.delete(taskId)
  await db.transaction(async tx => {
    const [task] = await tx.select().from(schema.ai_tasks).where(eq(schema.ai_tasks.taskId, taskId)).for('update')
    if (!task || task.status !== 'running') return
    const extra = task.extra as { chapterId: number; panelIdx: number; cost: number }
    const [chapter] = await tx.select().from(schema.chapters).where(eq(schema.chapters.id, extra.chapterId)).for('update')
    if (failure && extra.cost > 0 && !await addPoints(task.userId, extra.cost, tx)) throw new Error('视频任务退款失败')
    if (chapter) {
      const panels = chapter.content_configs as any[]
      const target = resolveStoryboardPanel(panels, extra.panelIdx)
      const panel = target?.panel
      if (panel?.videoTaskId === taskId) {
        panel.panelStatus = failure ? 'error' : 'done'
        panel.taskError = failure || ''
        panel.videoTaskStartedAt = ''
        target!.commit()
        await tx.update(schema.chapters).set({ content_configs: panels }).where(eq(schema.chapters.id, chapter.id))
      }
    }
    await tx.update(schema.ai_tasks).set({
      status: failure ? 'failed' : 'done', result: failure || '', updatedAt: new Date(),
    }).where(eq(schema.ai_tasks.taskId, taskId))
  })
}
