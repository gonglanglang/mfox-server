import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { db, schema } from '../src/mysqlDb/index'
import { createImageTask, finishImageTask } from '../src/tools/image-task'
import { createChargedTask, subscribeTaskStream } from '../src/tools/taskManager'

function fixture(t: TestContext) {
  let state = {
    persona: { id: 1, user_id: 2, work_id: 3, images: [] as any[] },
    task: null as any,
    balanceWrites: 0,
  }
  let failInsert = false
  let failRefund = false
  const tx = {
    select() {
      let table: unknown
      const query = {
        from(value: unknown) { table = value; return query },
        where() { return query },
        limit() { return query },
        for() { return query },
        then(resolve: (rows: unknown[]) => unknown) {
          return Promise.resolve(table === schema.personas ? [state.persona]
            : table === schema.ai_tasks ? (state.task ? [state.task] : [])
              : table === schema.ai_models ? [{ content_type: 'image', price_config: [{ label: '默认', value: 'default', price: 7 }] }]
                : [{ id: 2 }]).then(resolve)
        },
      }
      return query
    },
    update(table: unknown) {
      return { set(values: any) {
        return { async where() {
          if (table === schema.users) {
            if (failRefund) return [{ affectedRows: 0 }]
            state.balanceWrites++
          } else if (table === schema.personas) Object.assign(state.persona, values)
          else if (table === schema.ai_tasks) Object.assign(state.task, values)
          return [{ affectedRows: 1 }]
        } }
      } }
    },
    insert() {
      return { async values(value: any) {
        if (failInsert) throw new Error('insert failed')
        state.task = value
      } }
    },
  }
  t.mock.method(db, 'transaction', async (run: (value: unknown) => Promise<unknown>) => {
    const before = structuredClone(state)
    try { return await run(tx) } catch (error) { state = before; throw error }
  })
  return {
    get state() { return state },
    failInsert() { failInsert = true },
    failRefund(value: boolean) { failRefund = value },
  }
}

const input = { userId: 2, workId: 3, personaId: 1, model: 'test', quality: '1K', resolution: '1024x1024', router: '' }

test('asset image task charges the selected text and image models together', async t => {
  const f = fixture(t)
  const created = await createImageTask({ ...input, textModel: 'text-test' })
  assert.equal(f.state.task.extra.cost, 14)
  assert.equal(f.state.balanceWrites, 2)

  await finishImageTask({ taskId: created.taskId, userId: 2, imageUrl: '', message: 'failed' })
  assert.equal(f.state.balanceWrites, 3)
})

test('single and full extraction persist the same amount returned for refunds', async t => {
  const f = fixture(t)
  for (const units of [1, 3]) {
    const task = await createChargedTask(2, 'characterExtract', { chapterId: 4 }, 'test', 'text', undefined, units)
    assert.ok(task)
    assert.equal(task.cost, 7 * units)
    assert.equal(f.state.task.extra.cost, 7 * units)
  }
})

test('invalid extraction billing units cannot create a task or charge points', async t => {
  const f = fixture(t)
  await assert.rejects(createChargedTask(2, 'characterExtract', {}, 'test', 'text', undefined, 0), /无效计费次数/)
  assert.equal(f.state.balanceWrites, 0)
  assert.equal(f.state.task, null)
})

test('task insert failure rolls back the charge and placeholder', async t => {
  const f = fixture(t)
  f.failInsert()
  await assert.rejects(createImageTask(input), /insert failed/)
  assert.equal(f.state.balanceWrites, 0)
  assert.deepEqual(f.state.persona.images, [])
})

test('text task insert failure rolls back its charge', async t => {
  const f = fixture(t)
  f.failInsert()
  await assert.rejects(createChargedTask(2, 'storyboard', { chapterId: 4 }, 'test', 'text'), /insert failed/)
  assert.equal(f.state.balanceWrites, 0)
  assert.equal(f.state.task, null)
})

test('failure settles once, preserves other images, and broadcasts failure', async t => {
  const f = fixture(t)
  const created = await createImageTask(input)
  f.state.persona.images.push({ id: 'another', job_status: 'running' })
  const messages: string[] = []
  const stop = subscribeTaskStream(created.taskId, message => messages.push(message))
  t.after(stop)
  const result = { taskId: created.taskId, userId: 2, imageUrl: '', message: 'failed' }
  await finishImageTask(result)
  await finishImageTask(result)
  assert.equal(f.state.balanceWrites, 2) // One charge and one refund.
  assert.equal(f.state.task.status, 'failed')
  assert.equal(f.state.persona.images[0].job_status, 'failed')
  assert.equal(f.state.persona.images[1].job_status, 'running')
  assert.equal(JSON.parse(messages[0]).type, 'failed')
  assert.deepEqual(messages.slice(1), ['DONE'])
})

test('refund failure rolls back settlement and allows a later retry', async t => {
  const f = fixture(t)
  const created = await createImageTask(input)
  const result = { taskId: created.taskId, userId: 2, imageUrl: '', message: 'failed' }
  f.failRefund(true)
  await assert.rejects(finishImageTask(result))
  assert.equal(f.state.task.status, 'running')
  assert.equal(f.state.persona.images[0].job_status, 'running')
  f.failRefund(false)
  await finishImageTask(result)
  assert.equal(f.state.task.status, 'failed')
  assert.equal(f.state.balanceWrites, 2)
})

test('success stores the image without refunding and ignores repeated settlement', async t => {
  const f = fixture(t)
  const created = await createImageTask(input)
  await finishImageTask({ taskId: created.taskId, userId: 2, imageUrl: 'https://example.com/image.png', message: 'ok' })
  await finishImageTask({ taskId: created.taskId, userId: 2, imageUrl: '', message: 'late failure' })
  assert.equal(f.state.task.status, 'done')
  assert.equal(f.state.persona.images[0].job_status, 'ready')
  assert.equal(f.state.balanceWrites, 1)
})
