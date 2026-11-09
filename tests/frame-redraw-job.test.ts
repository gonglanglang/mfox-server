import assert from 'node:assert/strict'
import { test } from 'node:test'
import { abandonedRefund, shouldTakeOverRedraw, STALE_REDRAW_MS } from '../src/tools/frame-redraw-job'

const run = (overrides: Record<string, unknown> = {}) => ({ id: 'run-1', status: 'charged', ...overrides })
const panel = (overrides: Record<string, unknown> = {}) => ({
  panelStatus: 'generating', _task: 'redraw', redrawRun: run(), ...overrides,
})

test('只接管遗留的重绘 charged run', () => {
  assert.equal(shouldTakeOverRedraw(undefined, new Set()), false)
  assert.equal(shouldTakeOverRedraw(panel({ panelStatus: 'done' }), new Set()), false)
  assert.equal(shouldTakeOverRedraw(panel({ panelStatus: 'error' }), new Set()), false)
  assert.equal(shouldTakeOverRedraw(panel({ panelStatus: 'idle' }), new Set()), false)
  // 视频等其它任务类型不在这里接管
  assert.equal(shouldTakeOverRedraw(panel({ _task: 'video' }), new Set()), false)
  assert.equal(shouldTakeOverRedraw(panel({ _task: undefined }), new Set()), false)
  // 已结算（done/refunded）或没有 run 的面板不需要接管
  assert.equal(shouldTakeOverRedraw(panel({ redrawRun: run({ status: 'done' }) }), new Set()), false)
  assert.equal(shouldTakeOverRedraw(panel({ redrawRun: run({ status: 'refunded' }) }), new Set()), false)
  assert.equal(shouldTakeOverRedraw(panel({ redrawRun: undefined }), new Set()), false)
  assert.equal(shouldTakeOverRedraw(panel({ redrawRun: run({ id: undefined }) }), new Set()), false)
})

test('进程重启后注册表为空：遗留任务立即可以接管', () => {
  assert.equal(shouldTakeOverRedraw(panel(), new Set()), true)
})

test('仍在运行且未超时的任务不接管；超时或缺少 startedAt 时可接管', () => {
  const now = Date.now()
  const running = new Set(['run-1'])

  assert.equal(shouldTakeOverRedraw(
    panel({ redrawRun: run({ startedAt: new Date(now - 60_000).toISOString() }) }), running, now), false)
  assert.equal(shouldTakeOverRedraw(
    panel({ redrawRun: run({ startedAt: new Date(now - STALE_REDRAW_MS - 1).toISOString() }) }), running, now), true)
  // 无法解析的 startedAt 与旧版本（无该字段）写入的 run 都按陈旧处理
  assert.equal(shouldTakeOverRedraw(panel({ redrawRun: run({ startedAt: 'not-a-date' }) }), running, now), true)
  assert.equal(shouldTakeOverRedraw(panel({ redrawRun: run() }), running, now), true)
})

test('接管退款额：已用成本缺失按全额退，越界值被钳制', () => {
  assert.equal(abandonedRefund(60, undefined), 60)
  assert.equal(abandonedRefund(60, 0), 60)
  assert.equal(abandonedRefund(60, 20), 40)
  assert.equal(abandonedRefund(60, 60), 0)
  assert.equal(abandonedRefund(60, 90), 0)
  assert.equal(abandonedRefund(60, -5), 60)
  assert.equal(abandonedRefund(0, undefined), 0)
})
