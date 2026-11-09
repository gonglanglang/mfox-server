import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { db, schema } from '../src/mysqlDb'
import { createFrameVideoTask, settleFrameVideoTask, shouldTakeOverVideoTask } from '../src/tools/frame-video-task'
import { modifyPanelInTx } from '../src/mysqlDb/panel'
import { preparePanelFrameGeneration } from '../src/mysqlDb/panel'

function fixture(t: TestContext) {
  let state = {
    chapter: { id: 1, content_configs: [{ panelIdx: 4, firstFrameUrl: 'frame.png', panelStatus: 'idle' }] as any[] },
    task: null as any, balanceWrites: 0,
  }
  let failInsert = false
  let failRefund = false
  const tx = {
    select() {
      let table: unknown
      const query = {
        from(value: unknown) { table = value; return query },
        where() { return query }, limit() { return query }, for() { return query },
        then(resolve: (value: unknown[]) => unknown) {
          const rows = table === schema.chapters ? [{ ...state.chapter, configs: state.chapter.content_configs }]
            : table === schema.ai_tasks ? (state.task ? [state.task] : [])
            : [{ content_type: 'video', price_config: [{ label: '默认', value: 'default', price: 9 }] }]
          return Promise.resolve(rows).then(resolve)
        },
      }
      return query
    },
    update(table: unknown) {
      return { set(values: any) { return { async where() {
        if (table === schema.users) {
          if (failRefund) return [{ affectedRows: 0 }]
          state.balanceWrites++
        } else if (table === schema.chapters) Object.assign(state.chapter, values)
        else if (table === schema.ai_tasks) Object.assign(state.task, values)
        return [{ affectedRows: 1 }]
      } } } }
    },
    insert() { return { async values(value: any) {
      if (failInsert) throw new Error('insert failed')
      state.task = value
    } } },
  }
  t.mock.method(db, 'transaction', async (run: (tx: any) => Promise<unknown>) => {
    const before = structuredClone(state)
    try { return await run(tx) } catch (err) { state = before; throw err }
  })
  return { get state() { return state }, failInsert() { failInsert = true }, failRefund(value: boolean) { failRefund = value } }
}

test('nested task writes media and status only on selected shot', async t => {
  const f = fixture(t)
  f.state.chapter.content_configs = [
    { scene_id: '110', environment: '夜', shots: [{ content: '一', dialogue: [], firstFrameUrl: 'frame.png' }, { content: '二', dialogue: [], firstFrameUrl: 'frame2.png' }] },
    { scene_id: '110', environment: '晨', shots: [{ content: '三', dialogue: [] }] },
  ]
  const task = await createFrameVideoTask(2, 1, 0, 'video')
  assert.equal(f.state.chapter.content_configs[0].shots[0].videoTaskId, task.taskId)
  assert.equal(f.state.chapter.content_configs[0].panelStatus, undefined)
  await modifyPanelInTx(1, 0, async panel => { panel.finalVideoUrl = 'done.mp4' })
  await settleFrameVideoTask(task.taskId)
  assert.equal(f.state.chapter.content_configs[0].shots[0].panelStatus, 'done')
  assert.equal(f.state.chapter.content_configs[0].shots[0].finalVideoUrl, 'done.mp4')
  assert.equal(f.state.chapter.content_configs[0].shots[1].panelStatus, undefined)
  assert.equal(f.state.chapter.content_configs[1].shots[0].panelStatus, undefined)
  // 场景最后一个镜头同样参与视频生成：它的尾帧是按本镜【主体动作】演完的终态单独出图的
  const lastShotTask = await createFrameVideoTask(2, 1, 1, 'video')
  assert.equal(f.state.chapter.content_configs[0].shots[1].videoTaskId, lastShotTask.taskId)
})

test('frame inheritance stops at nested scene boundary even with same asset', async t => {
  const f = fixture(t)
  f.state.chapter.content_configs = [
    { scene_id: '110', shots: [{ dialogue: [], lastFrameUrl: 'tail.png' }, { dialogue: [], lastFrameUrl: 'next-tail.png' }] },
    { scene_id: '110', shots: [{ dialogue: [] }] },
  ]
  const sameScene = await preparePanelFrameGeneration(1, 1)
  assert.equal(sameScene.plan.inheritedFirstFrameUrl, 'tail.png')
  // 帧链只存引用：本镜首帧指向场景 _frames 池里的同一帧（图片只存一份）
  const scene0 = f.state.chapter.content_configs[0]
  const sharedRef = scene0.shots[1].start_frame_id
  assert.ok(sharedRef)
  assert.equal(scene0._frames[sharedRef].url, 'tail.png')
  const nextScene = await preparePanelFrameGeneration(1, 2)
  assert.equal(nextScene.plan.inheritsPreviousFrame, false)
  assert.equal(f.state.chapter.content_configs[1].shots[0].start_frame_id, undefined)
})

test('video task creation rolls back charge and panel on insert failure', async t => {
  const f = fixture(t)
  f.failInsert()
  await assert.rejects(createFrameVideoTask(2, 1, 4, 'video'), /insert failed/)
  assert.equal(f.state.balanceWrites, 0)
  assert.equal(f.state.chapter.content_configs[0].panelStatus, 'idle')
})

test('duplicate submission rejected; failure refunded once', async t => {
  const f = fixture(t)
  const task = await createFrameVideoTask(2, 1, 4, 'video')
  await assert.rejects(createFrameVideoTask(2, 1, 4, 'video'), /重复/)
  await settleFrameVideoTask(task.taskId, 'failed')
  await settleFrameVideoTask(task.taskId, 'failed')
  assert.equal(f.state.balanceWrites, 2)
  assert.equal(f.state.task.status, 'failed')
  assert.equal(f.state.chapter.content_configs[0].panelStatus, 'error')
})

test('遗留视频任务判定：重启/超时/缺任务号都要接管，正常在跑则不接管', () => {
  const active = new Set(['running-task'])
  const fresh = new Date().toISOString()
  // 不是"生成中 + 视频任务" → 不接管（重绘有自己的接管逻辑）
  assert.equal(shouldTakeOverVideoTask({ panelStatus: 'done', _task: '' }, active), false)
  assert.equal(shouldTakeOverVideoTask({ panelStatus: 'generating', _task: 'redraw', videoTaskId: 'x' }, active), false)
  // 在册且刚开始 → 不接管（正常并发，按"请勿重复提交"拒绝）
  assert.equal(shouldTakeOverVideoTask(
    { panelStatus: 'generating', _task: 'video', videoTaskId: 'running-task', videoTaskStartedAt: fresh },
    active), false)
  // 进程重启后注册表为空 → 接管（这正是"镜头一直转圈"的场景）
  assert.equal(shouldTakeOverVideoTask(
    { panelStatus: 'generating', _task: 'video', videoTaskId: 'running-task', videoTaskStartedAt: fresh },
    new Set()), true)
  // 没有任务号 → 接管（数据残缺，没人能结算它）
  assert.equal(shouldTakeOverVideoTask({ panelStatus: 'generating', _task: 'video' }, active), true)
  // 在册但已超过陈旧阈值 → 接管
  const stale = new Date(Date.now() - 40 * 60_000).toISOString()
  assert.equal(shouldTakeOverVideoTask(
    { panelStatus: 'generating', _task: 'video', videoTaskId: 'running-task', videoTaskStartedAt: stale },
    active), true)
})

test('refund failure keeps task recoverable and settlement can retry', async t => {
  const f = fixture(t)
  const task = await createFrameVideoTask(2, 1, 4, 'video')
  f.failRefund(true)
  await assert.rejects(settleFrameVideoTask(task.taskId, 'failed'), /退款失败/)
  assert.equal(f.state.task.status, 'running')
  f.failRefund(false)
  await settleFrameVideoTask(task.taskId, 'failed')
  assert.equal(f.state.task.status, 'failed')
})

test('successful video settlement does not refund', async t => {
  const f = fixture(t)
  const task = await createFrameVideoTask(2, 1, 4, 'video')
  await settleFrameVideoTask(task.taskId)
  assert.equal(f.state.balanceWrites, 1)
  assert.equal(f.state.task.status, 'done')
})

test('panel mutation awaits callback, locates actual panelIdx, and rejects failures', async t => {
  const f = fixture(t)
  const panel = await modifyPanelInTx(1, 4, async panel => {
    await Promise.resolve()
    panel.start_prompt = 'saved'
  })
  assert.equal(panel.start_prompt, 'saved')
  await assert.rejects(modifyPanelInTx(1, 0, async () => {}), /不存在/)
  await assert.rejects(modifyPanelInTx(1, 4, async panel => {
    panel.start_prompt = 'discard'
    throw new Error('callback failed')
  }), /callback failed/)
  assert.equal(f.state.chapter.content_configs[0].start_prompt, 'saved')
})
