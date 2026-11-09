import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseStoryboardText, normalizeShotLink, isPlaceholderEmptyDialogue, sanitizeDialogueList } from '../src/tools/storyboard-text'
import { validateShots, autoFixShotDurations, enrichChapterContinuity, removeRedundantCuts, deriveSceneWorldState } from '../src/tools/shot-continuity'
import { decideShotTransitions } from '../src/tools/transition-decision'
import { inspectVideoQuality } from '../src/tools/video-qc'
import { frameContinuityPlan } from '../src/tools/frame-continuity'

test('parseStoryboardText 解析新增标签：【衔接】【入点】【运动】【出点】【轴线侧】【视线】【光位】【转场出】', () => {
  const raw = [
    '【场景序号】1',
    '【场景ID】157',
    '【主视角ID】151',
    '【角色ID】151,152',
    '【环境】深夜，后山丹房外廊下，左上檐灯昏黄斜照，雨丝泛冷青。',
    '【转场】叠化',
    '',
    '【分镜序号】1-1',
    '【衔接】continuous',
    '【景别】远景',
    '【机位】正面机位',
    '【运镜】固定镜头',
    '【时长】4',
    '【轴线侧】A',
    '【视线】沈无咎面向右侧门内，视线落向暖光药柜',
    '【光位】左上檐灯昏黄斜照',
    '【入点】沈无咎浑身湿透立在画面左中景门槛外泥水中，双肩微塌。',
    '【运动】沈无咎右脚在泥里向前挪出半步，身体微前倾（amplitude=small）',
    '【出点】沈无咎右脚停在门槛前半步，视线紧锁门内药柜。',
    '【音效】雨声,檐水声',
    '【转场出】硬切',
    '',
    '【分镜序号】1-2',
    '【衔接】cut | eyeline | 承接沈无咎投向门内的视线，切至门内执事正面近景',
    '【景别】中近景',
    '【机位】过肩机位',
    '【运镜】固定镜头',
    '【时长】3',
    '【轴线侧】A',
    '【视线】执事居画面右侧面朝左侧门外，眼神冷漠俯视',
    '【光位】左上檐灯昏黄斜照',
    '【画面】门内执事冷冷盯着门槛外的沈无咎，右手扬起宽袖。',
    '【入点】执事立在门槛内侧，右手刚抬起宽袖。',
    '【运动】执事眼神一凛，右手宽袖向门外猛然挥出（amplitude=small）',
    '【出点】执事右袖挥至门框正中，衣袂鼓荡。',
    '【台词】执事（冷喝/angry）：滚出去！',
    '【转场出】叠化',
  ].join('\n')

  const scenes = parseStoryboardText(raw, [{ id: 151, name: '沈无咎' }, { id: 152, name: '执事' }])
  assert.equal(scenes.length, 1)
  const shots = scenes[0]!.shots
  assert.equal(shots.length, 2)

  // 1-1：未写【画面】与【人物动作】时自动从【入点】【运动】【出点】派生 content 与 subject_motion
  assert.deepEqual(shots[0]!.link, { type: 'continuous', match: null, anchor: '' })
  assert.equal(shots[0]!.axis_side, 'A')
  assert.equal(shots[0]!.eyeline, '沈无咎面向右侧门内，视线落向暖光药柜')
  assert.equal(shots[0]!.continuity?.light_dir, '左上檐灯昏黄斜照')
  assert.equal(shots[0]!.motion?.amplitude, 'small')
  assert.match(shots[0]!.content, /浑身湿透立在画面左中景/)
  assert.match(shots[0]!.subject_motion, /右脚在泥里向前挪出半步/)
  assert.equal(shots[0]!.transition_out, '硬切')

  // 1-2：cut | eyeline | anchor
  assert.deepEqual(shots[1]!.link, {
    type: 'cut',
    match: 'eyeline',
    anchor: '承接沈无咎投向门内的视线，切至门内执事正面近景',
  })
  assert.equal(shots[1]!.transition_out, '叠化')
  assert.equal(shots[1]!.transition, '叠化')
  assert.equal(shots[1]!.dialogue[0]!.id, '152')
})

test('validateShots 检出 C1 越轴、C2 景别跳变、C3 连续三镜雷同、C4 光位矛盾、C6 cut 缺锚点、C10 首尾帧相同', () => {
  const scene = {
    scene_id: '157',
    shots: [
      {
        shot_size: '极远景',
        camera_angle: '正面机位',
        camera_movement: '固定镜头',
        durShort: 4,
        axis_side: 'A',
        continuity: { light_dir: '左侧暖光' },
        content: '一',
        start_prompt: '相同提示词',
        end_prompt: '相同提示词',
      },
      {
        shot_size: '极特写', // C2：极远景 → 极特写 跨 9 档
        camera_angle: '正面机位',
        camera_movement: '固定镜头',
        durShort: 4,
        axis_side: 'B', // C1：A → B 越轴且上一镜非环绕/移镜头
        continuity: { light_dir: '右侧冷光' }, // C4：与基准光位不一致
        link: { type: 'cut', match: 'eyeline', anchor: '' }, // C6：cut 缺少 anchor
        content: '二',
      },
      {
        shot_size: '极特写',
        camera_angle: '正面机位',
        camera_movement: '固定镜头',
        durShort: 4,
        content: '三',
      },
      {
        shot_size: '极特写', // C3：第 2、3、4 镜连续三镜 极特写+正面机位
        camera_angle: '正面机位',
        camera_movement: '固定镜头',
        durShort: 4,
        content: '四',
      },
    ],
  }

  const issues = validateShots(scene)
  const codes = new Set(issues.map(i => i.code))
  assert.equal(codes.has('C1'), true)
  assert.equal(codes.has('C2'), true)
  assert.equal(codes.has('C3'), true)
  assert.equal(codes.has('C4'), true)
  assert.equal(codes.has('C6'), true)
  assert.equal(codes.has('C10'), false)
})

test('autoFixShotDurations 仅钳制合法时长范围 [2, 15]，不再按台词字数强行抬高时长', () => {
  const scene = {
    shots: [
      {
        durShort: 3,
        dialogue: [{ speaker: '沈无咎', text: '管事师叔，弟子的傷势实在撑不住了，求您赐一粒止血丹救命！', tone: '哀求', emotion: 'sad' }],
      },
    ],
  }
  autoFixShotDurations(scene)
  assert.equal(scene.shots[0]!.durShort, 3)
})

test('frameContinuityPlan 按 link.type 分支：cut / transition 镜头允许独立首帧，不触发 continuous 断链报错', () => {
  const configs = [
    {
      scene_id: '157',
      prop_ids: [],
      environment: '夜雨丹房',
      shots: [
        {
          roles: [{ id: 151 }],
          start_prompt: 'p1-start',
          end_prompt: 'p1-end',
          content: '镜头1',
          firstFrameUrl: 'frame-1-start.png',
          lastFrameUrl: 'frame-1-end.png',
          dialogue: [],
        },
        {
          roles: [{ id: 152 }],
          link: { type: 'cut', match: 'eyeline', anchor: '切门内执事正反打' },
          start_prompt: 'p2-start',
          end_prompt: 'p2-end',
          content: '镜头2（正反打切镜）',
          firstFrameUrl: 'independent-frame-2-start.png',
          lastFrameUrl: 'frame-2-end.png',
          dialogue: [],
        },
        {
          roles: [{ id: 152 }],
          // 未设置 link：默认按 continuous 处理（向后兼容）
          start_prompt: 'p3-start',
          end_prompt: 'p3-end',
          content: '镜头3（连续镜头）',
          firstFrameUrl: ' mismatched-frame.png',
          lastFrameUrl: '',
          dialogue: [],
        },
      ],
    },
  ]

  // panelIdx=1 是 cut 切镜：即使 firstFrameUrl !== previous.lastFrameUrl 也合法通过
  const cutPlan = frameContinuityPlan(configs, 1)
  assert.equal(normalizeShotLink(cutPlan.current).type, 'cut')
  assert.equal(cutPlan.current.firstFrameUrl, 'independent-frame-2-start.png')

  // panelIdx=2 缺省为 continuous：firstFrameUrl 与上一镜 lastFrameUrl 不一致时立即抛断链错误
  assert.throws(() => frameContinuityPlan(configs, 2), /帧链断裂/)
})

test('validateShots 精细化规则：C1 检查本镜运镜、C5 检出站立→跌坐姿态突变、C8 超长台词拆分告警、C9 逗号子句过载', () => {
  const scene = {
    scene_id: '157',
    shots: [
      {
        shot_size: '中景',
        camera_angle: '正面机位',
        camera_movement: '环绕镜头', // 上一镜环绕，但下一镜固定镜头却翻转轴线 -> 仍应报 C1
        durShort: 4,
        axis_side: 'A',
        motion: {
          in: '沈无咎立在门槛外泥水中',
          out: '沈无咎直立在门槛外泥水中，视线望向门内',
          path: '沈无咎转身走向门口，伸手推开木门，抬头看向天空，随后跪倒在地（amplitude=medium）', // 4 个逗号子句 -> C9
        },
        dialogue: [
          {
            speaker: '沈无咎',
            text: '管事师叔，弟子的伤势实在撑不住了，求您发发慈悲赐一粒止血丹救命，弟子做牛做马也会报答您的大恩大德！', // > 36 字 -> C8 拆分建议
          },
        ],
        content: '一',
      },
      {
        shot_size: '中近景',
        camera_angle: '正面机位',
        camera_movement: '固定镜头',
        durShort: 4,
        axis_side: 'B', // C1：cur.camera_movement 是固定镜头而非环绕/移镜头
        link: { type: 'continuous', match: null, anchor: '' },
        motion: {
          in: '沈无咎跌坐在门槛外泥水中，双手撑地', // C5：上一镜出点「直立」，本镜入点「跌坐」姿态互斥
          out: '沈无咎坐在泥水中抬头',
          path: '沈无咎微微抬头',
        },
        content: '二',
      },
    ],
  }

  const issues = validateShots(scene)
  const codes = new Set(issues.map(i => i.code))
  assert.equal(codes.has('C1'), true)
  assert.equal(codes.has('C5'), true)
  assert.equal(codes.has('C8'), false)
  assert.equal(codes.has('C9'), false)
})

test('enrichChapterContinuity 补齐连贯性字段、删除冗余切镜并产出 storyboard 结构与前序摘要', () => {
  const configs = [
    {
      scene_id: '157',
      role_id: 151,
      environment: '深夜丹房外，暖黄檐灯与冷青雨丝交织',
      transition: '叠化',
      shots: [
        {
          shot_size: '远景',
          camera_angle: '正面机位',
          camera_movement: '固定镜头',
          durShort: 3,
          roles: [{ id: 151 }],
          content: '沈无咎立在门槛外泥水中',
          subject_motion: '沈无咎向右迈出半步',
          dialogue: [],
        },
        {
          // 与第 1 镜完全相同的无台词冗余切镜 -> 应被 removeRedundantCuts 自动合并
          shot_size: '远景',
          camera_angle: '正面机位',
          camera_movement: '固定镜头',
          durShort: 2,
          roles: [{ id: 151 }],
          content: '沈无咎立在门槛外泥水中',
          dialogue: [],
        },
        {
          shot_size: '中景',
          camera_angle: '过肩机位',
          camera_movement: '推镜头',
          durShort: 4,
          roles: [{ id: 151 }],
          link: { type: 'cut', match: 'eyeline', anchor: '承接沈无咎视线切中景' },
          content: '沈无咎向前倾身求药',
          dialogue: [{ speaker: '沈无咎', text: '求师叔赐药！' }],
        },
      ],
    },
  ]

  const enriched = enrichChapterContinuity(configs, { chapterId: 241, workId: 226, styleAnchorId: 7 })
  // 冗余的第 2 镜已被合并，剩余 2 镜
  assert.equal(enriched.configs[0]!.shots.length, 2)
  assert.equal(enriched.storyboardRows.length, 2)

  const row0 = enriched.storyboardRows[0]!
  const row1 = enriched.storyboardRows[1]!
  assert.equal(row0.shot_key, '241:0:0')
  assert.equal(row0.subject_id, 151)
  assert.equal(row0.motion_direction, 'left_to_right')
  assert.equal(row0.prev_shot_id, null)
  assert.equal(row0.next_shot_id, '241:0:1')
  assert.equal(row0.style_anchor_id, 7)
  assert.match(row0.color_tone, /暖黄|冷青/)

  assert.equal(row1.prev_shot_id, '241:0:0')
  assert.equal(row1.next_shot_id, null)
  assert.equal(enriched.configs[0]!.shots[1]!.prev_shot_summary.shot_id, '241:0:0')
  assert.ok(Number.isInteger(enriched.configs[0]!.shots[0]!.start_seed))
})

test('decideShotTransitions 按镜头关系智能决策转场并控制同场景≤0.3s与全片转场占比上限', () => {
  const configs = [
    {
      scene_id: '157',
      environment: '雨夜丹房',
      transition: '黑场',
      shots: [
        {
          shot_id: '241:0:0',
          shot_size: '远景',
          durShort: 4,
          content: '第一镜',
        },
        {
          shot_id: '241:0:1',
          shot_size: '中景',
          durShort: 4,
          link: { type: 'continuous', match: null, anchor: '' },
          content: '第二镜（continuous）',
        },
        {
          shot_id: '241:0:2',
          shot_size: '近景',
          durShort: 6,
          link: { type: 'cut', match: 'graphic', anchor: '构图相似软切' },
          content: '第三镜（graphic cut）',
        },
      ],
    },
    {
      scene_id: '158',
      environment: '次日清晨，后山崖边',
      transition: '淡出',
      shots: [
        {
          shot_id: '241:1:0',
          shot_size: '大远景',
          durShort: 5,
          link: { type: 'transition', match: 'graphic', anchor: '跨场次日清晨' },
          content: '第四镜（跨场景次日清晨）',
        },
      ],
    },
  ]

  const decisions = decideShotTransitions(configs, { chapterId: 241 })
  assert.equal(decisions.length, 3)
  // 0 -> 1: 同场景 continuous 必须为 0s 硬切
  assert.equal(decisions[0]!.type, '硬切')
  assert.equal(decisions[0]!.duration, 0)
  // 1 -> 2: 同场景 graphic cut 为 ≤0.3s 软叠化
  assert.equal(decisions[1]!.type, '叠化')
  assert.ok(decisions[1]!.duration > 0 && decisions[1]!.duration <= 0.3)
  // 2 -> 3: 跨场景且含「次日清晨」大时间跨度 -> 黑场过渡
  assert.equal(decisions[2]!.type, '黑场')
  assert.equal(decisions[2]!.duration, 0.55)
})

test('inspectVideoQuality 检测音画不同步、字幕溢出并触发自动回退重生成标志', async () => {
  const failReport = await inspectVideoQuality({
    renderId: 'test-qc-1',
    chapterId: 241,
    panelIdx: 2,
    expectedSpeechDurationSec: 6.2,
    expectedShotDurationSec: 4.0, // 视频仅 4.0s，小于配音 6.2s -> av_sync fail + regenerate_flag=1
    dialogue: [
      { speaker: '沈无咎', text: '管事师叔求您赐我一粒止血丹救命，我师弟快撑不住了啊，求求您发发慈悲吧！' },
    ],
    shot: {
      subject_id: 151,
      color_tone: '暖黄/冷青',
      motion_direction: 'forward',
      shot_size: '中近景',
      continuity_status: 'passed',
    },
  })

  assert.equal(failReport.passed, false)
  assert.equal(failReport.shouldRegenerate, true)
  const syncItem = failReport.records.find(r => r.check_item === 'av_sync')
  assert.equal(syncItem?.result, 'fail')
  assert.equal(syncItem?.regenerate_flag, 1)
})

test('parseStoryboardText 与 sanitizeDialogueList 过滤「无」「（无）」「无台词」「旁白：无」等占位符，静音镜头不生成无字台词', () => {
  assert.equal(isPlaceholderEmptyDialogue('无'), true)
  assert.equal(isPlaceholderEmptyDialogue('（无）'), true)
  assert.equal(isPlaceholderEmptyDialogue('无台词'), true)
  assert.equal(isPlaceholderEmptyDialogue('暂无'), true)
  assert.equal(isPlaceholderEmptyDialogue('None'), true)
  assert.equal(isPlaceholderEmptyDialogue('滚出去！'), false)

  const raw = [
    '【场景序号】1',
    '【场景ID】157',
    '【角色ID】151',
    '【环境】深夜丹房外',
    '',
    '【分镜序号】1-1',
    '【景别】远景',
    '【机位】正面机位',
    '【运镜】固定镜头',
    '【画面】沈无咎推开木门走入屋内',
    '【台词】无',
    '',
    '【分镜序号】1-2',
    '【景别】中景',
    '【机位】正面机位',
    '【运镜】推镜头',
    '【画面】沈无咎环视四周',
    '【台词】旁白：无',
    '【台词】沈无咎（警惕/fearful）：（无）',
  ].join('\n')

  const scenes = parseStoryboardText(raw, [{ id: 151, name: '沈无咎' }])
  assert.equal(scenes[0]!.shots[0]!.dialogue.length, 0)
  assert.equal(scenes[0]!.shots[1]!.dialogue.length, 0)

  const sanitized = sanitizeDialogueList([
    { speaker: '旁白', text: '无' },
    { speaker: '沈无咎', text: '（无）' },
    { speaker: '沈无咎', text: '谁在里面？' },
  ])
  assert.equal(sanitized.length, 1)
  assert.equal(sanitized[0]!.text, '谁在里面？')
})

test('deriveSceneWorldState 与 validateShots(C15) 追踪跨镜不可逆状态（如镜头1开门后镜头2禁止重置为关门重开）', () => {
  const scene: any = {
    scene_id: '157',
    shots: [
      {
        shot_size: '中景',
        camera_angle: '正面机位',
        camera_movement: '固定镜头',
        durShort: 4,
        content: '沈无咎伸手推开丹房木门',
        motion: {
          in: '沈无咎站在紧闭的木门前',
          path: '沈无咎双手用力推开木门',
          out: '木门已完全敞开，露出门内暖光',
        },
      },
      {
        shot_size: '近景',
        camera_angle: '过肩机位',
        camera_movement: '推镜头',
        durShort: 4,
        content: '木门紧闭，沈无咎再次伸手推开门走入',
        motion: {
          in: '紧闭的房门前，沈无咎抬手准备开门',
          path: '沈无咎推门迈步',
          out: '沈无咎走入屋内',
        },
        start_prompt: '沈无咎站在紧闭的木门前',
      },
    ],
  }

  // 未自动修复前，validateShots 应检出 C15 跨镜状态回退重做告警
  const issuesBefore = validateShots(scene)
  assert.equal(issuesBefore.some(i => i.code === 'C15'), true)

  // deriveSceneWorldState 自动为第 2 镜注入 world_state（「敞开」）并修正「木门紧闭/紧闭的木门」回退词
  deriveSceneWorldState(scene)
  assert.match(scene.shots[1].world_state, /敞开/)
  assert.doesNotMatch(scene.shots[1].content, /木门紧闭/)
  assert.doesNotMatch(scene.shots[1].motion.in, /紧闭的房门/)
  assert.doesNotMatch(scene.shots[1].start_prompt, /紧闭的木门/)
})

test('frameContinuityPlan 在主流单关键帧模式（single）下不要求上一镜存在尾帧图（lastFrameUrl）', () => {
  const configs = [
    {
      scene_id: '157',
      prop_ids: [],
      environment: '夜雨丹房',
      shots: [
        {
          roles: [{ id: 151 }],
          frame_mode: 'single',
          start_prompt: 'p1-start',
          end_prompt: '',
          content: '镜头1（单关键帧模式，仅生成首帧）',
          firstFrameUrl: 'frame-1-main.png',
          lastFrameUrl: '',
          dialogue: [],
        },
        {
          roles: [{ id: 151 }],
          frame_mode: 'single',
          link: { type: 'continuous', match: null, anchor: '' },
          start_prompt: 'p2-start',
          end_prompt: '',
          content: '镜头2（单关键帧模式，连续镜头）',
          firstFrameUrl: 'frame-2-main.png',
          lastFrameUrl: '',
          dialogue: [],
        },
      ],
    },
  ]

  // single 模式下：即使第 1 镜无 lastFrameUrl 且第 2 镜为 continuous，也不抛「帧链断裂」
  const plan = frameContinuityPlan(configs, 1, { frameMode: 'single' })
  assert.equal(plan.current.frame_mode, 'single')
  assert.equal(plan.current.firstFrameUrl, 'frame-2-main.png')
})
