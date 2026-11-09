import { test } from 'node:test'
import assert from 'node:assert/strict'
import { submitAliyunVideoTask, pollAliyunVideoTask } from '../src/videoTools/adapters/aliyun'

test('selected model and provider are used for both submission and polling', async t => {
  const calls: { url: string; init?: RequestInit }[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(init?.method === 'POST' ? { id: 'test-task' }
      : { status: 'succeeded', content: { video_url: 'https://example.test/video.mp4' } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  const connection = { baseUrl: 'https://example.test/api/v3/', apiKey: 'test-only' }
  const submitted = await submitAliyunVideoTask({
    model: 'selected-video-model', duration: 8, prompt: 'test', media: [],
  }, connection)
  assert.equal(submitted.taskId, 'test-task')
  const body = JSON.parse(calls[0]!.init!.body as string)
  assert.equal(body.model, 'selected-video-model')
  assert.equal(body.parameters.duration, 8)
  const result = await pollAliyunVideoTask('test-task', connection, { maxAttempts: 1, intervalMs: 0 })
  assert.equal(result.success, true)
  assert.equal(calls[0]!.url, 'https://example.test/api/v3/services/aigc/video-generation/video-synthesis')
  assert.equal(calls[1]!.url, 'https://example.test/api/v3/tasks/test-task')
})

test('模型配置的 endpoint 与 params 生效，用户选择的档位覆盖固定参数', async t => {
  const calls: { url: string; init?: RequestInit }[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ id: 'task-x' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  const connection = {
    baseUrl: 'https://example.test/api/v1', apiKey: 'test-only',
    endpoint: '/custom/path/generate',
    params: { prompt_extend: true, ratio: 'adaptive', watermark: false },
  }
  await submitAliyunVideoTask({
    model: 'wan3.0-video', prompt: 'p', media: [{ type: 'reference_image', url: 'a.png' }],
    duration: 8, resolution: '1080P', ratio: '16:9',
  }, connection)

  assert.equal(calls[0]!.url, 'https://example.test/api/v1/custom/path/generate')
  const body = JSON.parse(calls[0]!.init!.body as string)
  // 用户选择的档位真正进入请求体（历史缺陷：被硬编码 720P 覆盖）
  assert.equal(body.parameters.resolution, '1080P')
  assert.equal(body.parameters.ratio, '16:9')
  // 模型固定参数保留，且与用户选择合并
  assert.equal(body.parameters.prompt_extend, true)
  assert.equal(body.parameters.watermark, false)
  // wan3.0 的 input 是对象而不是数组：input = { prompt, media: [{ type, url }] }
  assert.deepEqual(body.input, { prompt: 'p', media: [{ type: 'reference_image', url: 'a.png' }] })
})

const connection = { baseUrl: 'https://example.test', apiKey: 'test-only' }
const completed = () => new Response(JSON.stringify({ output: {
  task_status: 'SUCCEEDED', video_url: 'https://example.test/video.mp4',
} }))

test('polling recovers from network failure and 503 without submitting again', async t => {
  let count = 0
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.equal(init.method, 'GET')
    assert.ok(init.signal)
    count++
    if (count === 1) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })
    if (count === 2) return new Response('gateway error', { status: 503 })
    return completed()
  })
  const result = await pollAliyunVideoTask('existing', connection, { intervalMs: 0, maxAttempts: 4 })
  assert.equal(result.success, true)
  assert.equal(result.taskId, 'existing')
  assert.equal(count, 3)
})

test('persistent network failures stop after bounded retries and retain cause and task ID', async t => {
  let count = 0
  t.mock.method(globalThis, 'fetch', async () => {
    count++
    throw new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT' } })
  })
  const result = await pollAliyunVideoTask('existing', connection, { intervalMs: 0, maxAttempts: 10 })
  assert.equal(count, 4)
  assert.equal(result.success, false)
  assert.equal(result.taskId, 'existing')
  assert.match(result.error!, /ETIMEDOUT/)
})

test('authentication failures and supplier terminal failure are not retried', async t => {
  for (const response of [new Response('unauthorized', { status: 401 }),
    new Response(JSON.stringify({ output: { task_status: 'FAILED', message: 'invalid media' } }))]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => response)
    const result = await pollAliyunVideoTask('existing', connection, { intervalMs: 0 })
    assert.equal(result.success, false)
    assert.equal(result.taskId, 'existing')
    assert.match(result.error!, /401|invalid media/)
    assert.equal(mock.mock.callCount(), 1)
    mock.mock.restore()
  }
})

test('submission network failures are never retried', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })
  })
  const result = await submitAliyunVideoTask({ model: 'm', prompt: 'test', media: [] }, connection)
  assert.equal(mock.mock.callCount(), 1)
  assert.match(result.error!, /提交.*ECONNRESET/)
  assert.match(result.error!, /提交结果未知/)
})

test('non-JSON submission error preserves HTTP status', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('bad gateway', { status: 502 }))
  const result = await submitAliyunVideoTask({ model: 'm', prompt: 'test', media: [] }, connection)
  assert.equal(result.success, false)
  assert.match(result.error!, /HTTP 502/)
})

test('polling timeout aborts requests and retains task ID', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      // 兜底定时器必须远大于 requestTimeoutMs：窗口只有几毫秒时，机器一有负载就来不及投递 abort，
      // 测试会偶发失败（报 abort not delivered），而并非被测代码有问题。
      const timer = setTimeout(() => reject(new Error('abort not delivered')), 5000)
      init.signal!.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(init.signal!.reason)
      }, { once: true })
    }))
  const result = await pollAliyunVideoTask('existing', connection, {
    intervalMs: 0, requestTimeoutMs: 50, maxTransientRetries: 0,
  })
  assert.equal(result.success, false)
  assert.equal(result.taskId, 'existing')
  assert.match(result.error!, /timeout/i)
})

test('normal pending status resets the consecutive failure budget', async t => {
  let count = 0
  t.mock.method(globalThis, 'fetch', async () => {
    count++
    if (count === 1 || count === 3) throw new Error('fetch failed')
    if (count === 2) return new Response(JSON.stringify({ output: { task_status: 'RUNNING' } }))
    return completed()
  })
  const result = await pollAliyunVideoTask('existing', connection, {
    intervalMs: 0, maxAttempts: 4, maxTransientRetries: 1,
  })
  assert.equal(result.success, true)
})

test('polling limit keeps task ID for follow-up queries', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ status: 'running' })))
  const result = await pollAliyunVideoTask('existing', connection, { intervalMs: 0, maxAttempts: 1 })
  assert.equal(result.taskId, 'existing')
  assert.equal(result.success, false)
  assert.match(result.error!, /查询达到上限/)
})
