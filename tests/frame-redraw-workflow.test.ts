import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { db, schema } from '../src/mysqlDb'
import { beginFrameRedraw, settleFrameRedraw, quoteFrameRedraw } from '../src/tools/frame-redraw-job'
import { frameContinuityPlan } from '../src/tools/frame-continuity'
import { resolveStoryboardPanel } from '../src/tools/storyboard-panel'
process.env.OSS_ACCESS_KEY_ID = 'test'
process.env.OSS_ACCESS_KEY_SECRET = 'test'
process.env.OSS_REGION = 'oss-cn-hangzhou'
process.env.OSS_BUCKET = 'test'
const { seedreamTool } = await import('../src/mastra/tools/seedream-tool')
const { frameRedrawWorkflow, numberFrameReferences } = await import('../src/mastra/workflows/frame-redraw.workflow')

// 图片单价 7 分；每次重绘固定出图 2 张（首帧 + 尾帧），因此报价为 14 分且不再包含审查成本
const IMAGE_COST = 7
const QUOTE = 14

const scope = { userId: 3, workId: 1, chapterId: 2, imageModel: 'image', quality: '2K' }
// 关键帧只存引用（场景 _frames 池），所以断言一律通过解析后的派生字段来读
const shot = (name: string, image = '') => ({ roles: [{ id: '26' }], start_prompt: 'prompt-' + name, end_prompt: 'end-' + name,
  content: name, lastFrameUrl: image ? 'old-tail-' + name : '', finalVideoUrl: name + '.mp4', dialogue: [] })
/** 场景内串联帧链：第 i 镜首帧 = 第 i-1 镜尾帧（真实数据由生成流程保证一致） */
const scene = (shots: any[]) => {
  shots.forEach((item, index) => {
    item.firstFrameUrl = index === 0 ? '' : String(shots[index - 1].lastFrameUrl || '')
  })
  return { scene_id: '110', prop_ids: [123], environment: '夜', shots }
}
/** 按读取方的真实路径取某镜的帧 URL（帧池引用 → 派生字段） */
const frameUrlAt = (configs: any[], panelIdx: number, kind: 'start' | 'end') => {
  const panel = resolveStoryboardPanel(configs, panelIdx)?.panel
  return String((kind === 'start' ? panel?.firstFrameUrl : panel?.lastFrameUrl) || '')
}
const frameRefAt = (configs: any[], panelIdx: number, kind: 'start' | 'end') => {
  const panel = resolveStoryboardPanel(configs, panelIdx)?.panel
  return kind === 'start' ? panel?.start_frame_id : panel?.end_frame_id
}

function fixture(t: TestContext, configs: any[]) {
  let chapter: any = { content_configs: configs }
  let writes: number[] = []
  const generated: any[] = []
  let failure = ''
  let missing = false
  let styleEffect = ''
  let mutateDuringGenerate = () => {}
  const dialect = new MySqlDialect()
  const tx = {
    select() {
      let table: unknown
      const q = { from(v: unknown) { table = v; return q }, where() { return q }, for() { return q }, limit() { return q },
        orderBy() { return q }, then(resolve: any) {
        const rows = table === schema.chapters ? [{ ...chapter, configs: chapter.content_configs }]
          : table === schema.ai_models ? [{ content_type: 'image', price_config: [{ label: '默认', value: 'default', price: IMAGE_COST }] }]
          : table === schema.visualStyles ? [{ description: '水墨', effectImage: styleEffect }]
          : table === schema.personas ? [
            { id: 99, name: '无图素材', source_type: 'prop', images: [] },
            ...[['scene', 110, '卧房'], ['persona', 26, '韩立'], ['prop', 123, '棉被']].filter(row => !missing || row[0] !== 'scene')
              .map(([type, id, name]) => ({ id, name, source_type: type, cur_image_id: 'selected', images: [{ id: 'selected', url: type + '.png' }] })),
          ] : [{ id: 3 }]
        return Promise.resolve(rows).then(resolve)
      } }
      return q
    },
    update(table: unknown) { return { set(values: any) { return { async where() {
      if (table === schema.users) writes.push(Number(dialect.sqlToQuery(values.points).params[0]))
      else Object.assign(chapter, values)
      return [{ affectedRows: 1 }]
    } } } } },
  }
  t.mock.method(db, 'select', tx.select)
  t.mock.method(db, 'transaction', async (run: any) => {
    const before = structuredClone(chapter), beforeWrites = [...writes]
    try { return await run(tx) } catch (err) { chapter = before; writes = beforeWrites; throw err }
  })
  t.mock.method(seedreamTool, 'execute', async (input: any) => {
    generated.push(input)
    mutateDuringGenerate()
    if (failure === 'image') return { success: false, error: 'image failed' }
    return { success: true, imageUrl: 'new-' + generated.length + '.png' }
  })
  return {
    get configs() { return chapter.content_configs as any[] }, get writes() { return writes }, generated,
    fail(value: string) { failure = value }, missing() { missing = true },
    styleEffect(url: string) { styleEffect = url },
    mutate(fn: () => void) { mutateDuringGenerate = fn },
    async run(panelIdx: number) {
      // 报价是提交的必填参数：先 quote 再 begin，与前端流程一致
      const { cost } = await quoteFrameRedraw({ ...scope, panelIdx })
      const job = await beginFrameRedraw({ ...scope, panelIdx, expectedCost: cost })
      const run = await frameRedrawWorkflow.createRun()
      const result = await run.start({ inputData: { ...scope, model: 'image', panelIdx, runId: job.runId, styleId: 1, resolution: '1024x1024' } })
      await settleFrameRedraw({ ...scope, panelIdx, runId: job.runId, failure: result.status === 'success' ? undefined : 'failed' })
      return result
    },
  }
}

test('free-form frame prompts without rigid identity constraints are accepted', async t => {
  const freeForm = { ...shot('A'), end_prompt: '【镜头】本帧为首帧，斜角机位' }
  fixture(t, [scene([freeForm])])
  const job = await beginFrameRedraw({ ...scope, panelIdx: 0, expectedCost: QUOTE })
  assert.ok(job.runId)
})

test('首帧继承上一镜尾帧：N 个镜头只出 N 张图，接点是同一张画面', async t => {
  const f = fixture(t, [scene([shot('A'), shot('B'), shot('C')])])
  assert.deepEqual(await quoteFrameRedraw({ ...scope, panelIdx: 0 }), { linked: false, cost: QUOTE })
  for (const index of [0, 1, 2]) assert.equal((await f.run(index)).status, 'success')

  // 关键帧链：镜头 i 的尾帧就是镜头 i+1 的首帧——同一张图（同一个 frameId），而不是"重画一张应该长一样的"
  assert.equal(frameUrlAt(f.configs, 0, 'start'), 'new-1.png')
  assert.equal(frameUrlAt(f.configs, 0, 'end'), 'new-2.png')
  assert.equal(frameUrlAt(f.configs, 1, 'start'), 'new-2.png')
  assert.equal(frameUrlAt(f.configs, 1, 'end'), 'new-3.png')
  assert.equal(frameUrlAt(f.configs, 2, 'start'), 'new-3.png')
  assert.equal(frameUrlAt(f.configs, 2, 'end'), 'new-4.png')
  // 同一张画面只存一份：接点共享同一个 frameId，池里只有 4 帧
  assert.equal(frameRefAt(f.configs, 0, 'end'), frameRefAt(f.configs, 1, 'start'))
  assert.equal(frameRefAt(f.configs, 1, 'end'), frameRefAt(f.configs, 2, 'start'))
  assert.equal(Object.keys(f.configs[0]._frames || {}).length, 4)

  // 3 个镜头只出 4 张图：第一镜的首帧 + 每镜各一张尾帧，其余首帧全部继承
  assert.equal(f.generated.length, 4)
  // 第一镜首帧：纯文生图（无输入帧），类型化参考图在前：角色 → 场景/道具
  assert.deepEqual(f.generated[0].refImageUrl, ['persona.png', 'scene.png', 'prop.png'])
  assert.deepEqual(f.generated[0].referenceImages, [{ url: 'persona.png', type: 'character' }])
  assert.match(f.generated[0].prompt, /图1 角色参考图：【角色ID 26/)
  assert.match(f.generated[0].prompt, /图2 场景：【卧房】/)
  assert.match(f.generated[0].prompt, /图3 道具：【棉被】/)
  assert.match(f.generated[0].prompt, /水墨/)
  // 全局风格锚与角色一致性硬约束随 prompt 注入
  assert.match(f.generated[0].prompt, /All frames MUST follow this exact style/)
  assert.match(f.generated[0].prompt, /These characters MUST look identical across ALL frames/)
  // 只有场景第一镜真正生成首帧，后续三次都是尾帧
  assert.match(f.generated[0].prompt, /prompt-A/)
  assert.match(f.generated[1].prompt, /end-A/)
  assert.match(f.generated[2].prompt, /end-B/)
  assert.match(f.generated[3].prompt, /end-C/)
  // 尾帧以本镜首帧为图生图输入（排在最前，编号与 prompt 一致）
  assert.equal(f.generated[1].refImageUrl[0], 'new-1.png')
  assert.equal(f.generated[2].refImageUrl[0], 'new-2.png')
  assert.match(f.generated[1].prompt, /图1 本镜首帧（图生图输入）/)
  // 上一镜尾帧只通过参考图传递：文字版 end_prompt 有上千字，会稀释本帧的画面描述
  assert.ok(!/上一镜尾帧状态/.test(f.generated[2].prompt))
  assert.ok(!/end-A/.test(f.generated[2].prompt))
  // 冗余快照写回分镜：重绘复现与排查用（值为作品画风的 description）
  assert.equal(f.configs[0].shots[0].style_prompt_snapshot, '水墨')
  assert.match(f.configs[0].shots[0].character_references_snapshot?.[0]?.description || '', /Character 韩立 \(ID:26\)/)
  assert.equal(f.configs[0].shots[0].scene_reference_snapshot?.scene_id, 110)
})

test('作品画风带参考图时作为 style 参考图传给供应商，并排在角色参考图之前', async t => {
  const f = fixture(t, [scene([shot('A')])])
  f.styleEffect('style.png')
  assert.equal((await f.run(0)).status, 'success')

  // style 在前、character 在后：编号与 prompt 中的 图N 一致
  assert.deepEqual(f.generated[0].referenceImages, [
    { url: 'style.png', type: 'style' },
    { url: 'persona.png', type: 'character' },
  ])
  assert.deepEqual(f.generated[0].refImageUrl, ['style.png', 'persona.png', 'scene.png', 'prop.png'])
  assert.match(f.generated[0].prompt, /图1 风格参考图/)
  assert.match(f.generated[0].prompt, /图2 角色参考图/)
  assert.match(f.generated[0].prompt, /【全局风格】水墨/)
})

test('图片生成失败时保留原图并全额退款', async t => {
  const f = fixture(t, [scene([shot('A', 'a.png'), shot('B', 'b.png'), shot('C', 'c.png')])])
  f.fail('image')
  assert.equal((await f.run(1)).status, 'failed')
  assert.equal(frameUrlAt(f.configs, 0, 'end'), 'old-tail-A') // 相邻镜头永不被覆盖
  assert.equal(frameUrlAt(f.configs, 1, 'start'), 'old-tail-A')
  assert.equal(frameUrlAt(f.configs, 1, 'end'), 'old-tail-B')
  assert.equal(f.configs[0].shots[2].finalVideoUrl, 'C.mp4')
  const b = f.configs[0].shots[1]
  assert.equal(b.redrawRun.refundedCost, QUOTE)
  assert.equal(b.redrawRun.status, 'refunded')
  assert.equal(b.panelStatus, 'error')
  // 首帧失败即中止，不会继续生成尾帧
  assert.equal(f.generated.length, 1)
  assert.deepEqual(f.writes, [QUOTE, QUOTE])
})

test('缺少素材参考图时在出图前中止并全额退款', async t => {
  const f = fixture(t, [scene([shot('A'), shot('B')])])
  f.missing()
  assert.equal((await f.run(0)).status, 'failed')
  assert.equal(f.generated.length, 0)
  assert.deepEqual(f.writes, [QUOTE, QUOTE])
})

for (const mode of ['changed-neighbor', 'changed-script'] as const) {
  test('生成期间分镜或相邻画面被改动时不覆盖结果：' + mode, async t => {
    const f = fixture(t, [scene([shot('A', 'a.png'), shot('B', 'b.png'), shot('C', 'c.png')])])
    if (mode === 'changed-neighbor') f.mutate(() => { f.configs[0].shots[2].firstFrameUrl = 'external.png' })
    else f.mutate(() => { f.configs[0].shots[1].end_prompt = 'external edit' })
    assert.equal((await f.run(1)).status, 'failed')
    assert.equal(frameUrlAt(f.configs, 1, 'start'), 'old-tail-A')
    assert.equal(frameUrlAt(f.configs, 1, 'end'), 'old-tail-B')
    assert.equal(f.configs[0].shots[1].redrawRun.refundedCost, QUOTE)
  })
}

test('跨场景不继承上一镜尾帧，但仍生成独立的首尾帧', async t => {
  const f = fixture(t, [scene([shot('A', 'a.png')]), scene([shot('B')])])
  assert.equal(frameContinuityPlan(f.configs, 1).previous, null)
  assert.equal((await f.run(1)).status, 'success')
  assert.equal(frameUrlAt(f.configs, 1, 'end'), 'new-2.png')
  assert.equal(frameUrlAt(f.configs, 0, 'end'), 'old-tail-A')
})

test('前置校验、报价拦截与幂等退款', async t => {
  const f = fixture(t, [scene([shot('A'), shot('B')])])
  await assert.rejects(beginFrameRedraw({ ...scope, panelIdx: 1, expectedCost: QUOTE }), /上一镜头的尾帧/)
  await assert.rejects(beginFrameRedraw({ ...scope, panelIdx: 0, expectedCost: QUOTE - 1 }), /预计积分已变化/)
  // 缺少报价直接拒绝，且不产生任何扣费
  await assert.rejects(beginFrameRedraw({ ...scope, panelIdx: 0 } as any), /缺少有效的预计积分/)
  assert.deepEqual(f.writes, [])
  f.configs[0].shots[0].end_prompt = ''
  await assert.rejects(beginFrameRedraw({ ...scope, panelIdx: 0, expectedCost: QUOTE }), /首帧和尾帧提示词/)
  assert.deepEqual(f.writes, [])
  f.configs[0].shots[0].end_prompt = 'end-A'
  const job = await beginFrameRedraw({ ...scope, panelIdx: 0, expectedCost: QUOTE })
  // 同一分镜在结算前重复提交仍被拒绝（该 run 在活跃注册表中，不是遗留任务）
  await assert.rejects(beginFrameRedraw({ ...scope, panelIdx: 0, expectedCost: QUOTE }), /分镜正在生成中/)
  await assert.rejects(beginFrameRedraw({ ...scope, panelIdx: 1, expectedCost: QUOTE }), /相邻镜头正在生成/)
  const settlement = { ...scope, panelIdx: 0, runId: job.runId, failure: 'failed' }
  assert.equal(await settleFrameRedraw(settlement), true)
  assert.equal(await settleFrameRedraw(settlement), false) // 重复结算不再退款
  assert.deepEqual(f.writes, [QUOTE, QUOTE])
  assert.deepEqual(numberFrameReferences([{ label: '无图', url: '' }, { label: '角色', url: 'a' }]), [{ label: '图1 角色', url: 'a' }])
})

test('遗留的 charged run 会被下一次提交接管：退款、解锁并重新扣费', async t => {
  const f = fixture(t, [scene([shot('A'), shot('B')])])
  // 模拟“图片已保存但结算未执行”的遗留状态（进程重启后活跃注册表为空）
  Object.assign(f.configs[0].shots[0], {
    panelStatus: 'generating', _task: 'redraw',
    redrawRun: { id: 'abandoned-run', cost: QUOTE, status: 'charged', imageUnitCost: IMAGE_COST },
  })
  const { cost } = await quoteFrameRedraw({ ...scope, panelIdx: 0 })
  const job = await beginFrameRedraw({ ...scope, panelIdx: 0, expectedCost: cost })
  assert.equal(job.cost, QUOTE)
  // 先把旧 run 全额退回，再按新任务预扣
  assert.deepEqual(f.writes, [QUOTE, QUOTE])
  const panel = f.configs[0].shots[0]
  assert.equal(panel.redrawRun.id, job.runId)
  assert.equal(panel.panelStatus, 'generating')
  assert.equal(panel._task, 'redraw')
})

test('已出图但未结算的遗留 run 按已用成本结算，不重复退款', async t => {
  const f = fixture(t, [scene([shot('A'), shot('B')])])
  Object.assign(f.configs[0].shots[0], {
    panelStatus: 'generating', _task: 'redraw',
    redrawRun: { id: 'abandoned-used', cost: QUOTE, status: 'charged', usedCost: IMAGE_COST, imageUnitCost: IMAGE_COST },
  })
  const { cost } = await quoteFrameRedraw({ ...scope, panelIdx: 0 })
  await beginFrameRedraw({ ...scope, panelIdx: 0, expectedCost: cost })
  // 已用 7 → 只退 7，而不是全退 14
  assert.deepEqual(f.writes, [IMAGE_COST, QUOTE])
})
