import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../mysqlDb'
import { addPoints, consumeModelPoints } from './index'
import { createTask, publishTaskStream } from './taskManager'

export async function createImageTask(input: {
  userId: number; workId: number; personaId: number
  textModel?: string; model: string; quality: string; resolution: string; router: string
}) {
  return db.transaction(async tx => {
    const { userId, workId, personaId, textModel, model, quality, resolution, router } = input
    // All image transactions lock the user first to keep lock ordering consistent.
    await tx.select({ id: schema.users.id }).from(schema.users)
      .where(eq(schema.users.id, userId)).for('update')
    const [row] = await tx.select().from(schema.personas).where(and(
      eq(schema.personas.id, personaId), eq(schema.personas.work_id, workId),
      eq(schema.personas.user_id, userId),
    )).for('update')
    if (!row) throw new Error('素材不存在')
    const textCharge = textModel
      ? await consumeModelPoints(userId, textModel, 'text', undefined, tx)
      : { ok: true, cost: 0 }
    if (!textCharge.ok) throw new Error('文本模型不可用或积分不足')
    // 档位键与模型 price_config 对齐：前端传 resolution，历史调用可能传 quality
    const imageCharge = await consumeModelPoints(userId, model, 'image', quality || resolution, tx)
    if (!imageCharge.ok) throw new Error('图片模型不可用或积分不足')
    const cost = textCharge.cost + imageCharge.cost
    const placeholder = {
      id: randomUUID(), url: '', type: 'generated',
      job_id: 0, job_status: 'running', edit_job_id: 0, edit_job_status: 'ready',
      prompt: '', parent_image_id: null, ref_images: [],
    }
    const images = Array.isArray(row.images) ? row.images : []
    await tx.update(schema.personas).set({ images: [...images, placeholder], updatedAt: new Date() })
      .where(eq(schema.personas.id, personaId))
    const { taskId } = await createTask(userId, 'aiImage', {
      personaId, workId, placeholderId: placeholder.id, router,
      textModel, model, quality, resolution, cost,
    }, tx)
    return { row, taskId, placeholderId: placeholder.id }
  })
}

export async function finishImageTask(input: {
  taskId: string; userId: number; imageUrl: string; message: string
}) {
  const { taskId, userId, imageUrl, message } = input
  const changed = await db.transaction(async tx => {
    await tx.select({ id: schema.users.id }).from(schema.users)
      .where(eq(schema.users.id, userId)).for('update')
    const [task] = await tx.select().from(schema.ai_tasks).where(and(
      eq(schema.ai_tasks.taskId, taskId), eq(schema.ai_tasks.userId, userId),
    )).for('update')
    // The task row is the settlement guard: retries cannot refund twice.
    if (!task || task.status !== 'running') return false
    const extra = task.extra as { personaId: number; placeholderId: string; cost: number }
    const [row] = await tx.select().from(schema.personas).where(and(
      eq(schema.personas.id, extra.personaId), eq(schema.personas.user_id, userId),
    )).for('update')
    const images = (Array.isArray(row?.images) ? row.images : []) as Record<string, unknown>[]
    const index = images.findIndex(image => image.id === extra.placeholderId)
    if (index >= 0) {
      images[index] = { ...images[index], url: imageUrl, job_status: imageUrl ? 'ready' : 'failed', prompt: message.slice(0, 500) }
      await tx.update(schema.personas).set({ images, updatedAt: new Date() })
        .where(eq(schema.personas.id, extra.personaId))
    }
    if (!imageUrl && extra.cost > 0 && !await addPoints(userId, extra.cost, tx)) {
      throw new Error('图片任务退款失败，结算已回滚')
    }
    await tx.update(schema.ai_tasks).set({
      status: imageUrl ? 'done' : 'failed', result: imageUrl || message, updatedAt: new Date(),
    }).where(eq(schema.ai_tasks.taskId, taskId))
    return true
  })
  if (changed) {
    publishTaskStream(taskId, JSON.stringify(imageUrl
      ? { type: 'done', taskId, imageUrl }
      : { type: 'failed', taskId, result: message, message }))
    publishTaskStream(taskId, 'DONE')
  }
}
