import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fillScenePrompts, type PromptPipelineAgents } from '../src/mastra/workflows/NovelScriptFlows/pipeline'

// ---------- 夹具 ----------

const framePrompt = (frame: string) => [
  `【镜头】${frame}，中景，正面机位，固定镜头`,
  '【画面构图】人物位于画面中央，背景为黄泥墙',
  '【人物状态与动作】韩立（#26）仰卧，双手置于被外',
  '【道具状态】旧棉被（#123）盖至胸口',
  '【场景环境】夜晚卧室，床位于房间内侧，门在右侧',
  '【光线氛围】深夜，左侧墙缝冷光，色调青灰',
  '【连续性约束】保持姿态、位置与光位，仅允许呼吸起伏',
  '【画风】保持作品与素材统一画风',
].join('\n')

function makeConfigs(count = 2) {
  return [{
    scene_id: '110', environment: '夜晚卧室', transition: '淡入淡出',
    roles: [{ id: 26 }], prop_ids: [],
    shots: Array.from({ length: count }, (_, index) => ({
      content: `镜头${index + 1}的内容`,
      dialogue: [{ speaker: '韩立', text: `台词${index + 1}`, tone: '平静', emotion: 'calm' }],
      shot_size: '中景', camera_angle: '正面机位', camera_movement: '固定镜头',
      roles: [{ id: 26 }], prop_ids: [],
    })),
  }]
}

const renderAll = (payload: any) => JSON.stringify({
  scene_id: payload.scene.scene_id,
  // 相邻帧必须描述动作的起终两个不同瞬间：夹具按 frame_index 生成不同文案
  frames: payload.frames.map((frame: any) => ({
    frame_index: frame.frame_index, prompt: framePrompt(`第${frame.frame_index + 1}帧`), negative_prompt: '排除现代服饰',
  })),
})

type Kind = 'render'
type Call = { kind: Kind; payload: any }

/** 假 agent：记录每次调用的 payload，并按 kind 计数（用于断言重试次数）。 */
function fakeAgents(handlers: Partial<Record<Kind, (payload: any, attempt: number) => string>>) {
  const calls: Call[] = []
  const counts: Record<Kind, number> = { render: 0 }
  const make = (kind: Kind) => async (payload: string) => {
    counts[kind] += 1
    const parsed = JSON.parse(payload)
    calls.push({ kind, payload: parsed })
    const handler = handlers[kind]
    if (!handler) throw new Error(`测试缺少 ${kind} 的假实现`)
    return handler(parsed, counts[kind])
  }
  const agents: PromptPipelineAgents = {
    render: make('render'),
  }
  return { agents, calls, counts }
}

const run = (configs: any[], agents: PromptPipelineAgents, extra: Record<string, unknown> = {}) =>
  fillScenePrompts({
    sceneIndex: 0, sceneCount: 1, configs, evidence: { assets: [] }, agents, ...extra,
  })

// ---------- 用例 ----------

test('每个镜头的 content 直接作为帧状态，不再规划与审查边界', async () => {
  const configs = makeConfigs(2)
  const { agents, calls } = fakeAgents({
    render: renderAll,
  })
  const labels: string[] = []
  const result = await run(configs, agents, { progress: (label: string) => { labels.push(label) } })

  // 状态数 = 镜头数 + 1；不再有审查轮次
  assert.equal(result.boundaryCount, 3)
  assert.equal(result.reviewRounds, 0)
  assert.equal(result.renderCalls, 1)
  // 第 i 镜的首/尾帧提示词来自相邻两个帧
  assert.match(result.configs[0]!.shots[0]!.start_prompt, /【镜头】第1帧/)
  assert.match(result.configs[0]!.shots[1]!.end_prompt, /【镜头】第3帧/)

  // 核心不变量：镜头 i 从 content[i] 演到 content[i+1]，一批 N 镜对应 N+1 帧
  const render = calls.find(call => call.kind === 'render')!.payload
  assert.deepEqual(render.frames.map((frame: any) => frame.state), ['镜头1的内容', '镜头2的内容', '镜头2的内容'])
  assert.deepEqual(render.frames.map((frame: any) => frame.frame_index), [0, 1, 2])
  // 渲染输入带上场景素材与镜头参数，供渲染器写 8 段
  assert.equal(render.frames[0].camera_angle, '正面机位')
  assert.equal(render.scene.transition, '淡入淡出')
  // 全局风格锚：未显式传 styleProfile 时回退默认画风，且原文 + 硬性声明由渲染器写入
  assert.match(render.global_style.prompt, /Chinese webtoon style/)
  assert.equal(render.global_style.reference_url, '')
  assert.deepEqual(render.character_cards, [])
  assert.equal(render.scene_card, null)
  assert.deepEqual(render.prop_cards, [])

  assert.ok(labels.some(label => label.startsWith('场景 1/1：渲染首尾帧提示词（镜头 1-2')))
  assert.ok(!labels.some(label => label.includes('规划状态边界')))
  assert.ok(!labels.some(label => label.includes('边界审查')))
})

test('渲染格式错误就地重试，第二次带反馈并成功', async () => {
  const configs = makeConfigs(2)
  const { agents, calls, counts } = fakeAgents({
    render: (payload, attempt) => attempt === 1
      ? JSON.stringify({
        scene_id: payload.scene.scene_id,
        frames: payload.frames.map((frame: any) => ({
          frame_index: frame.frame_index, prompt: '   ', negative_prompt: '',
        })),
      })
      : renderAll(payload),
  })
  const result = await run(configs, agents)

  assert.equal(result.renderCalls, 2)
  assert.equal(counts.render, 2)
  const retried = calls.filter(call => call.kind === 'render')[1]!.payload
  assert.match(retried.feedback, /渲染结果格式错误/)
  assert.match(result.configs[0]!.shots[1]!.start_prompt, /【镜头】第2帧/)
})

test('渲染重试耗尽时抛错，configs 保持未修改', async () => {
  const configs = makeConfigs(1)
  const { agents, counts } = fakeAgents({
    render: (payload) => JSON.stringify({
      scene_id: payload.scene.scene_id,
      frames: payload.frames.map((frame: any) => ({
        frame_index: frame.frame_index, prompt: '', negative_prompt: '',
      })),
    }),
  })
  await assert.rejects(() => run(configs, agents), /渲染首尾帧提示词（镜头 1-1）\s*连续 3 次未通过/)
  assert.equal(counts.render, 3)
  assert.equal(configs[0]!.shots[0]!.start_prompt, undefined)
})

test('按 batchSize 分批渲染，跨批次共享交界帧只渲染一次并严格复用', async () => {
  const configs = makeConfigs(5)
  const { agents, calls } = fakeAgents({
    render: (payload, attempt) => JSON.stringify({
      scene_id: payload.scene.scene_id,
      frames: payload.frames.map((frame: any) => ({
        frame_index: frame.frame_index,
        prompt: framePrompt(`批次${attempt}-第${frame.frame_index + 1}帧`),
        negative_prompt: '排除现代服饰',
      })),
    }),
  })
  const result = await run(configs, agents, { batchSize: 2 })

  // 首批渲染 [0, 1, 2]；后续批次复用上一批已渲染的交界帧（帧 2、帧 4），不再重复请求 LLM
  const batches = calls.filter(call => call.kind === 'render').map(call => call.payload.frames.map((f: any) => f.frame_index))
  assert.deepEqual(batches, [[0, 1, 2], [3, 4], [5]])
  assert.equal(result.renderCalls, 3)
  assert.equal(result.configs[0]!.shots.length, 5)
  assert.equal(result.configs[0]!.shots[1]!.end_prompt, result.configs[0]!.shots[2]!.start_prompt)
  assert.equal(result.configs[0]!.shots[3]!.end_prompt, result.configs[0]!.shots[4]!.start_prompt)
  assert.match(result.configs[0]!.shots[4]!.end_prompt, /【镜头】批次3-第6帧/)
})

test('渲染后把本次使用的风格/角色/场景快照写回每个镜头', async () => {
  const configs = makeConfigs(2)
  const assets = [
    { id: 26, type: 'persona', name: '韩立', gender: 'male', age: '青年', height: 178,
      description: '乌黑短发', detail: {}, image: 'role.png' },
    { id: 110, type: 'scene', name: '卧房', description: '夜晚卧室',
      detail: { location: '卧室', time: '深夜', lighting: '左侧墙缝冷光', mood: '静谧' }, image: 'scene.png' },
  ]
  const { agents } = fakeAgents({ render: renderAll })
  const result = await run(configs, agents, {
    evidence: { assets },
    styleProfile: { prompt: 'Japanese anime cel-shading', referenceUrl: 'style.png' },
  })

  for (const shot of result.configs[0].shots) {
    assert.equal(shot.style_prompt_snapshot, 'Japanese anime cel-shading')
    assert.equal(shot.character_references_snapshot.length, 1)
    assert.equal(shot.character_references_snapshot[0].role_id, 26)
    assert.equal(shot.character_references_snapshot[0].asset_url, 'role.png')
    assert.match(shot.character_references_snapshot[0].description, /Character 韩立 \(ID:26\)/)
    assert.equal(shot.scene_reference_snapshot.scene_id, 110)
    assert.match(shot.scene_reference_snapshot.text, /Setting: location: 卧室, time of day: 深夜/)
    assert.equal(shot.scene_reference_snapshot.image_url, 'scene.png')
  }
  // 未传 styleProfile 时使用默认画风作为快照
  const { agents: defaultAgents } = fakeAgents({ render: renderAll })
  const defaulted = await run(makeConfigs(1), defaultAgents, { evidence: { assets } })
  assert.match(defaulted.configs[0].shots[0].style_prompt_snapshot, /Chinese webtoon style/)
})

test('预算耗尽时立即失败并说明预算已耗尽', async () => {
  const configs = makeConfigs(1)
  const { agents, counts } = fakeAgents({ render: renderAll })
  await assert.rejects(() => run(configs, agents, { budgetMs: 0 }), /总预算 0s 已耗尽/)
  assert.equal(counts.render, 0)
})

test('场景没有镜头时直接失败，不调用模型', async () => {
  const configs = [{ scene_id: '110', shots: [] }]
  const { agents, counts } = fakeAgents({ render: renderAll })
  await assert.rejects(() => run(configs, agents), /没有镜头/)
  assert.deepEqual(counts, { render: 0 })
})

test('当下一镜为 cut 切镜时，本镜拥有独立 end_only 尾帧，不把下一镜首帧当成本镜尾帧', async () => {
  const configs = [{
    scene_id: '157', environment: '雨夜丹房门外', transition: '硬切',
    roles: [{ id: 151 }], prop_ids: [],
    shots: [
      {
        content: '沈无咎在门外压着嗓子求药',
        link: { type: 'cut', match: 'eyeline', anchor: '切至正面中近景' },
        motion: {
          in: '中近景正面，沈无咎脸在画面中央偏左',
          out: '沈无咎说完仍前倾，眼睛盯着右前方，雨水挂在下巴',
          path: '镜头缓慢推近，嘴唇开合说话',
          amplitude: 'small',
        },
        shot_size: '中近景', camera_angle: '正面机位', camera_movement: '推镜头',
        roles: [{ id: 151 }], prop_ids: [],
      },
      {
        content: '门内管事袖子朝外一甩，木门板砰地合上',
        link: { type: 'cut', match: 'action', anchor: '切至门内管事甩袖关门' },
        motion: {
          in: '近景斜角，门板半开，管事袖口在画面右侧抬起',
          out: '门板完全合死，沈无咎脸在画面左侧被溅上泥点',
          path: '管事袖子向左外甩，门板顺势合拢',
          amplitude: 'small',
        },
        shot_size: '近景', camera_angle: '斜角机位', camera_movement: '固定镜头',
        roles: [{ id: 151 }], prop_ids: [],
      },
    ],
  }]

  const { agents, calls } = fakeAgents({
    render: (payload) => JSON.stringify({
      scene_id: payload.scene.scene_id,
      frames: payload.frames.map((frame: any) => ({
        frame_index: frame.frame_index,
        prompt: framePrompt(`帧${frame.frame_index}(${frame.frame_role}:${frame.shot_size}:${frame.camera_angle}:${frame.state})`),
        negative_prompt: '改变发型发色',
      })),
    }),
  })

  const result = await run(configs, agents)
  const framesSent = calls[0]!.payload.frames
  // 两个镜头之间是 cut：共需 4 个独立帧（镜0首帧=0、镜0独立尾帧=1、镜1独立首帧=2、镜1收尾帧=3）
  assert.equal(result.boundaryCount, 4)
  assert.deepEqual(framesSent.map((f: any) => f.frame_index), [0, 1, 2, 3])
  assert.deepEqual(framesSent.map((f: any) => f.frame_role), [
    'scene_opening_start',
    'end_only',
    'start_only',
    'scene_closing_end',
  ])
  // 镜0的尾帧保持镜0自己的「中近景+正面机位+motion.out」，绝不变成镜1的「近景+斜角机位+门板半开」
  const shot0 = result.configs[0]!.shots[0]!
  const shot1 = result.configs[0]!.shots[1]!
  assert.match(shot0.start_prompt, /帧0\(scene_opening_start:中近景:正面机位/)
  assert.match(shot0.end_prompt, /帧1\(end_only:中近景:正面机位:沈无咎说完仍前倾/)
  assert.match(shot1.start_prompt, /帧2\(start_only:近景:斜角机位:近景斜角，门板半开/)
  assert.match(shot1.end_prompt, /帧3\(scene_closing_end:近景:斜角机位:门板完全合死/)
})
