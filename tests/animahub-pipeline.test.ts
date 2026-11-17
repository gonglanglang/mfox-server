import test from 'node:test'
import assert from 'node:assert/strict'

process.env.OSS_ACCESS_KEY_ID = process.env.OSS_ACCESS_KEY_ID || 'test'
process.env.OSS_ACCESS_KEY_SECRET = process.env.OSS_ACCESS_KEY_SECRET || 'test'
process.env.OSS_REGION = process.env.OSS_REGION || 'oss-cn-hangzhou'
process.env.OSS_BUCKET = process.env.OSS_BUCKET || 'test'

import {
  extractFirstJsonArray,
  extractFirstJsonObject,
  repairUnescapedNewlinesInStrings,
  retryWithValidation,
  safeJsonParse,
  stripLeadingStylePrefix,
  tryRepairJson,
} from '../src/tools/animahub-json'
import {
  buildContextualInferencePromptPayload,
  estimateChapterStoryboardPlan,
  inferEndFramePromptDeterministic,
  parseAnimaHubStoryboardOutput,
  parseContextualInferenceResult,
  synthesizeChapterContextualPrompts,
} from '../src/tools/animahub-storyboard'
import { executeImageNode, MAX_FUSION_REFERENCE_IMAGES } from '../src/pipeline/nodes/image-node'
import {
  applyAssetVersionToConfigs,
  clearMemoryShotAssets,
  recordShotAssetVersion,
} from '../src/pipeline/shot-assets-store'
import { hydrateFrameUrls } from '../src/tools/frame-pool'

const { buildAnimaHubVideoContent } = await import('../src/mastra/workflows/frame-video.workflow')
const { formatVersionForClient, resolveShotPosition } = await import('../src/routes/pipeline')

test('AnimaHub JSON: strips <think> blocks, fences, unescaped newlines, missing commas & trailing commas', () => {
  const brokenLlmOutput = `
<think>
先思考一下如何拆解角色和分镜，注意 JSON 里可能包含 { 花括号 } 干扰。
</think>
好的，为您输出如下结果：
\`\`\`json
{
  "title": "第1集：寒夜惊变"
  "summary": "沈墨推开残破庙门，\n发现地上遗留半截断剑",
  "shots": [
    {
      "id": 1,
      "firstFramePrompt": "风雪古庙门口，黑衣青年手按剑柄"
    }
    {
      "id": 2,
      "firstFramePrompt": "特写：青砖地面半截寒铁断剑，雪花飘落",
    },
  ],
}
\`\`\`
以上为全部分镜。
`
  const parsed = safeJsonParse<{
    title: string
    summary: string
    shots: Array<{ id: number; firstFramePrompt: string }>
  }>(brokenLlmOutput, 'object')

  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.value.title, '第1集：寒夜惊变')
  assert.equal(parsed.value.summary, '沈墨推开残破庙门，\n发现地上遗留半截断剑')
  assert.equal(parsed.value.shots.length, 2)
  assert.equal(parsed.value.shots[1]?.id, 2)

  const arrSlice = extractFirstJsonArray('前缀说明 [{"a": 1}, {"b": "[nested]"}] 尾部说明')
  assert.equal(arrSlice, '[{"a": 1}, {"b": "[nested]"}]')

  const objSlice = extractFirstJsonObject('解释文字 {"k": "v {inner}"} 结束')
  assert.equal(objSlice, '{"k": "v {inner}"}')

  const repairedNewlines = repairUnescapedNewlinesInStrings('{"text": "第一行\n第二行\t缩进"}')
  assert.equal(JSON.parse(repairedNewlines).text, '第一行\n第二行\t缩进')
  assert.ok(tryRepairJson('{"a":1\n"b":2,}').includes('"a":1,'))
})

test('AnimaHub retryWithValidation: feeds structured validation error into next attempt', async () => {
  const seenFeedbacks: string[] = []
  const result = await retryWithValidation(
    async (attempt, lastError) => {
      seenFeedbacks.push(lastError)
      if (attempt === 1) {
        return '{"items": []}'
      }
      return '{"items": [{"name": "沈墨"}]}'
    },
    raw => {
      const parsed = safeJsonParse<{ items: Array<{ name: string }> }>(raw, 'object')
      if (!parsed.ok) return parsed
      if (!parsed.value.items.length) {
        return { ok: false, error: 'items 数组不能为空，至少需要 1 个角色' }
      }
      return { ok: true, value: parsed.value.items }
    },
    { maxAttempts: 3, baseDelayMs: 5 },
  )

  assert.equal(seenFeedbacks.length, 2)
  assert.equal(seenFeedbacks[0], '')
  assert.match(seenFeedbacks[1]!, /items 数组不能为空/)
  assert.equal(result[0]?.name, '沈墨')
})

test('AnimaHub stripLeadingStylePrefix: deduplicates repeated style prefix cleanly', () => {
  const style = '国风仙侠2D赛璐璐动画质感，冷青电影色调，细腻线稿'
  const raw = `${style}，${style}，中景平视，黑衣少年执剑立于断崖`
  const cleaned = stripLeadingStylePrefix(raw, style)
  assert.equal(cleaned, '中景平视，黑衣少年执剑立于断崖')
})

test('AnimaHub rhythm & dual-format storyboard parser: supports JSON scenes & AnimaHub mode aliases', () => {
  const novelSample = '沈墨猛然回头，巷尾红灯笼无风自灭。'.repeat(45)
  const plan = estimateChapterStoryboardPlan(novelSample)
  assert.ok(plan.wordCount > 500)
  assert.ok(plan.targetShots >= plan.minShots && plan.targetShots <= plan.maxShots)
  assert.equal(plan.splitRules.by_dialogue, true)
  assert.equal(plan.splitRules.max_shot_sec, 7)

  const jsonStoryboard = `\`\`\`json
{
  "scenes": [
    {
      "scene_id": "12",
      "environment": "风雪残庙",
      "transition": "叠化",
      "shots": [
        {
          "durShort": 5,
          "shot_size": "近景",
          "camera_angle": "微仰拍",
          "camera_movement": "慢推",
          "plot_description": "沈墨推门持剑戒备",
          "firstFramePrompt": "近景微仰拍，风雪残庙门前，沈墨右手按住剑柄，眼神凌厉",
          "videoPrompt": "慢推镜头，沈墨拇指顶开剑格露出一寸寒芒",
          "gen_mode": "融图",
          "dialogue": "沈墨：出来吧，不必藏头露尾。"
        },
        {
          "durationSec": 4,
          "shot_size": "特写",
          "camera_angle": "俯拍",
          "camera_movement": "固定",
          "visual": "青砖地面半截断剑反光",
          "action": "雪花落在断剑刃口融化",
          "genMode": "frame2frame",
          "narration": "那是十年前师尊遗落的佩剑。"
        }
      ]
    }
  ]
}
\`\`\``

  const parsed = parseAnimaHubStoryboardOutput(jsonStoryboard, [{ id: '88', name: '沈墨' }])
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.value.length, 1)
  const shots = parsed.value[0]!.shots
  assert.equal(shots.length, 2)
  assert.equal(shots[0]!.gen_mode, 'image2video')
  assert.equal(shots[0]!.dialogue[0]?.id, '88')
  assert.equal(shots[0]!.dialogue[0]?.text, '出来吧，不必藏头露尾。')
  assert.equal(shots[1]!.gen_mode, 'frames2video')
  assert.equal(shots[1]!.dialogue[0]?.speaker, '旁白')
})

test('AnimaHub contextual {prev,curr,next} prompt synthesis & deterministic end_frame inference', () => {
  const stylePrompt = '二次元厚涂电影感，高对比冷暖光'
  const startPrompt = '中景平视，沈墨站在竹林石阶前按剑静立'

  const end1 = inferEndFramePromptDeterministic({ startPrompt })
  assert.notEqual(end1.trim(), startPrompt.trim())

  const configs: any[] = [
    {
      scene_id: 201,
      environment: '雨夜竹林',
      roles: [{ id: 101 }],
      shots: [
        {
          shot_size: '中景',
          camera_angle: '平视',
          camera_movement: '慢推',
          content: '沈墨撑伞踏上石阶',
          image_prompt: `${stylePrompt}，沈墨撑伞踏上石阶`,
          end_prompt: `${stylePrompt}，沈墨撑伞踏上石阶`, // 故意与首帧相同，验证自动去重与重推尾帧
          subject_motion: '沈墨缓步拾级而上并抬眼望向竹亭',
          lighting: '冷蓝月光与暖黄灯笼交织',
          roles: [{ id: 101 }],
        },
        {
          shot_size: '特写',
          camera_angle: '微俯',
          camera_movement: '固定',
          content: '靴底踩碎积水倒影',
          link: { type: 'continuous', anchor: '石阶积水与油纸伞滴水衔接' },
          roles: [{ id: 101 }],
        },
      ],
    },
  ]

  synthesizeChapterContextualPrompts(configs, {
    styleProfile: { prompt: stylePrompt },
    assets: [
      {
        id: 101,
        type: 'persona',
        name: '沈墨',
        description: '黑衣束发青年剑客',
        image_url: 'https://cdn.example.com/shenmo.png',
      } as any,
      {
        id: 201,
        type: 'scene',
        name: '雨夜竹林',
        description: '青石阶与翠竹掩映的古亭',
        image_url: 'https://cdn.example.com/bamboo.png',
      } as any,
    ],
  })

  const s0 = configs[0].shots[0]
  assert.ok(!s0.image_prompt.startsWith(stylePrompt), 'image_prompt should not retain duplicate style prefix')
  assert.notEqual(s0.end_prompt, s0.start_prompt, 'end_prompt must differ from start_prompt')
  assert.ok(s0.end_prompt.includes('石阶积水') || s0.end_prompt.includes('竹亭'), 'end_prompt incorporates motion/next anchor')
  assert.ok(s0.motion_prompt.length > 8)
  assert.equal(s0.character_refs?.[0]?.image_url, 'https://cdn.example.com/shenmo.png')

  // Test contextual inference payload & validation (rejecting identical end_prompt)
  const payload = buildContextualInferencePromptPayload({
    mode: 'end_frame',
    prevShot: null,
    currShot: s0,
    nextShot: configs[0].shots[1],
    sceneEnvironment: '雨夜竹林',
    stylePrompt,
  })
  assert.ok(payload.includes('"inference_mode":"end_frame"'))

  const rejectedSame = parseContextualInferenceResult(
    JSON.stringify({ end_prompt: s0.image_prompt }),
    'end_frame',
    s0,
    stylePrompt,
  )
  assert.equal(rejectedSame.ok, false)

  const acceptedDistinct = parseContextualInferenceResult(
    JSON.stringify({ end_prompt: `${stylePrompt}，镜头推进至近景，沈墨停步于石阶顶端凝视前方竹亭` }),
    'end_frame',
    s0,
    stylePrompt,
  )
  assert.equal(acceptedDistinct.ok, true)
  if (acceptedDistinct.ok) {
    assert.ok(!acceptedDistinct.value.end_prompt.startsWith(stylePrompt))
  }
})

test('AnimaHub 7-slot multi-reference fusion image node & _frames pool version sync', async () => {
  clearMemoryShotAssets()
  const stylePrompt = '新海诚感清透光影动画风'
  let capturedParams: any = null

  const shot: any = {
    image_prompt: `${stylePrompt}，少女站在天台栏杆旁仰望流云`,
    end_prompt: `${stylePrompt}，少女站在天台栏杆旁仰望流云`, // 雷同首帧，验证 last_frame 自动差异化推导
    motion_prompt: '微风吹起少女长发，她缓缓转身微笑',
    reference_frame_url: 'https://cdn.example.com/init-layout.png',
    firstFrameUrl: 'https://cdn.example.com/shot-first-v1.png',
    character_refs: [
      { role_id: '1', name: '林夏', description: '白衬衫短发少女', image_url: 'https://cdn.example.com/char1.png' },
      { role_id: '2', name: '陆川', description: '校服少年', image_url: 'https://cdn.example.com/char2.png' },
    ],
    custom_ref_images: [
      'https://cdn.example.com/custom1.png',
      'https://cdn.example.com/custom2.png',
      'https://cdn.example.com/custom3.png', // 超出 7 张槽位应被截断
    ],
  }

  const out = await executeImageNode({
    chapterId: 9901,
    sceneIndex: 0,
    shotIndex: 0,
    assetType: 'first_frame',
    shot,
    stylePrompt,
    styleReferenceUrl: 'https://cdn.example.com/style-anchor.png',
    sceneReference: { id: 10, text: '夕阳学校天台', imageUrl: 'https://cdn.example.com/scene-rooftop.png' },
    propReferences: [
      { id: 20, name: '纸飞机', text: '白色折纸飞机', imageUrl: 'https://cdn.example.com/prop-plane.png' },
    ],
    generator: async params => {
      capturedParams = params
      return { url: 'https://cdn.example.com/generated-first-v1.png', seed: 1024 }
    },
  })

  assert.equal(out.url, 'https://cdn.example.com/generated-first-v1.png')
  assert.ok(capturedParams)
  const totalRefs =
    (capturedParams.referenceFrameUrl ? 1 : 0) +
    (capturedParams.styleReferenceUrl ? 1 : 0) +
    capturedParams.characterReferences.length +
    (capturedParams.contentReferences?.length || 0)
  assert.equal(totalRefs, MAX_FUSION_REFERENCE_IMAGES, 'must cap total multi-reference images at 7')
  // Prompt should include stylePrompt exactly once
  const occurrences = capturedParams.prompt.split(stylePrompt).length - 1
  assert.equal(occurrences, 1, 'style prompt should appear exactly once')

  // Test last_frame auto-differentiation + firstFrameUrl init anchor
  let lastFrameCaptured: any = null
  await executeImageNode({
    chapterId: 9901,
    sceneIndex: 0,
    shotIndex: 0,
    assetType: 'last_frame',
    shot,
    stylePrompt,
    generator: async params => {
      lastFrameCaptured = params
      return { url: 'https://cdn.example.com/generated-last-v1.png' }
    },
  })
  assert.equal(lastFrameCaptured.referenceFrameUrl, 'https://cdn.example.com/shot-first-v1.png')
  assert.ok(lastFrameCaptured.prompt.includes('缓缓转身微笑'))

  // Verify scene._frames pool sync when switching versions so hydrateFrameUrls picks up the new version
  const v2 = await recordShotAssetVersion({
    chapterId: 9901,
    sceneIndex: 0,
    shotIndex: 0,
    assetType: 'first_frame',
    url: 'https://cdn.example.com/generated-first-v2.png',
    status: 'done',
    makeCurrent: true,
  })
  const chapterConfigs: any[] = [
    {
      environment: '天台',
      _frames: { f_old: { url: 'https://cdn.example.com/shot-first-v1.png' } },
      shots: [
        {
          content: '少女仰望流云',
          start_frame_id: 'f_old',
          firstFrameUrl: 'https://cdn.example.com/shot-first-v1.png',
          finalVideoUrl: 'https://cdn.example.com/old.mp4',
        },
      ],
    },
  ]
  const applied = applyAssetVersionToConfigs(chapterConfigs, 0, 0, v2)
  assert.equal(applied.videoNeedsRerun, true)
  const hydrated = hydrateFrameUrls(applied.configs)
  assert.equal(hydrated[0].shots[0].firstFrameUrl, 'https://cdn.example.com/generated-first-v2.png')
})

test('AnimaHub multi-mode video assembly & pipeline contract helpers', () => {
  // 1. frames2video (首尾帧过渡) + prevVideoUrl
  const f2v = buildAnimaHubVideoContent({
    genMode: 'frames2video',
    firstFrameUrl: 'https://cdn.example.com/f1.png',
    lastFrameUrl: 'https://cdn.example.com/f2.png',
    prevVideoUrl: 'https://cdn.example.com/prev.mp4',
    shotSize: '中景',
    cameraAngle: '平视',
    cameraMovement: '缓推',
    motionPrompt: '沈墨缓步向前并拔剑出鞘',
    negativePrompt: '崩坏变形',
  })
  assert.equal(f2v.media.length, 3)
  assert.equal(f2v.media[0]?.type, 'reference_image')
  assert.equal(f2v.media[1]?.type, 'reference_image')
  assert.equal(f2v.media[2]?.type, 'reference_video')
  assert.ok(f2v.prompt.includes('图1'))
  assert.ok(f2v.prompt.includes('图2'))
  assert.ok(f2v.prompt.includes('视频1'))
  assert.ok(f2v.prompt.includes('沈墨缓步向前并拔剑出鞘'))

  // 2. image2video (多参考融图生视频，无预制首帧也可运行)
  const fusionVid = buildAnimaHubVideoContent({
    genMode: 'image2video',
    characterRefs: [
      { name: '沈墨', image_url: 'https://cdn.example.com/char-shen.png' },
      { name: '林晚', image_url: 'https://cdn.example.com/char-lin.png' },
    ],
    sceneImage: 'https://cdn.example.com/scene-hall.png',
    propImages: ['https://cdn.example.com/prop-sword.png'],
    motionPrompt: '两人隔桌对视，烛火摇曳',
  })
  assert.equal(fusionVid.media.length, 4)
  assert.ok(fusionVid.prompt.includes('多图融合参考'))

  // 3. text2video (纯文生视频)
  const t2v = buildAnimaHubVideoContent({
    genMode: 'text2video',
    environment: '云海仙山晨曦',
    cameraMovement: '航拍俯冲',
    motionPrompt: '金色晨光穿透翻涌云海掠过仙宗飞檐',
  })
  assert.equal(t2v.media.length, 0)
  assert.ok(t2v.prompt.includes('云海仙山晨曦'))

  // 4. Pipeline route contract helpers: resolveShotPosition & formatVersionForClient
  const multiSceneConfigs = [
    { shots: [{ id: 1 }, { id: 2 }] },
    { shots: [{ id: 3 }, { id: 4 }, { id: 5 }] },
  ]
  assert.deepEqual(resolveShotPosition(multiSceneConfigs, { panelIdx: 3 }), {
    panelIdx: 3,
    sceneIndex: 1,
    shotIndex: 1,
  })
  assert.deepEqual(resolveShotPosition(multiSceneConfigs, { sceneIndex: 1, shotIndex: 2 }), {
    panelIdx: 4,
    sceneIndex: 1,
    shotIndex: 2,
  })

  const formatted = formatVersionForClient(
    {
      id: 77,
      chapter_id: 12,
      scene_index: 1,
      shot_index: 1,
      asset_type: 'video',
      version: 2,
      is_current: 1,
      url: 'https://cdn.example.com/v2.mp4',
      prompt: 'test',
      model_key: 'doubao-seedance-2-0',
      gen_mode: 'singleImage2video',
      params: { cost: 25 },
      duration: 5,
      status: 'done',
      error_msg: null,
      created_at: new Date('2026-01-01T00:00:00.000Z'),
    },
    88,
  )
  assert.equal(formatted.status, 'completed')
  assert.equal(formatted.model, 'doubao-seedance-2-0')
  assert.equal(formatted.work_id, 88)
  assert.equal(formatted.cost, 25)
})

test('SKIP_AUTH & SKIP_POINTS test-mode bypass flags can be toggled cleanly', async () => {
  const { isSkipAuthEnabled, isSkipPointsEnabled } = await import('../src/config/bypass')
  const prevAuth = process.env.SKIP_AUTH
  const prevPoints = process.env.SKIP_POINTS
  const prevNodeTest = process.env.NODE_TEST_CONTEXT

  try {
    // Inside node:test with unset env vars, defaults to false to preserve billing unit tests
    delete process.env.SKIP_AUTH
    delete process.env.SKIP_POINTS
    assert.equal(isSkipAuthEnabled(), false)
    assert.equal(isSkipPointsEnabled(), false)

    // Outside node:test (production / dev runtime), defaults to true temporarily for frictionless testing
    delete process.env.NODE_TEST_CONTEXT
    assert.equal(isSkipAuthEnabled(), true)
    assert.equal(isSkipPointsEnabled(), true)

    // Explicit false re-enables strict auth & points anytime via .env
    process.env.SKIP_AUTH = 'false'
    process.env.SKIP_POINTS = 'false'
    assert.equal(isSkipAuthEnabled(), false)
    assert.equal(isSkipPointsEnabled(), false)

    // Explicit true forces bypass even inside test context
    process.env.NODE_TEST_CONTEXT = 'child-v8'
    process.env.SKIP_AUTH = 'true'
    process.env.SKIP_POINTS = 'true'
    assert.equal(isSkipAuthEnabled(), true)
    assert.equal(isSkipPointsEnabled(), true)
  } finally {
    if (prevAuth === undefined) delete process.env.SKIP_AUTH
    else process.env.SKIP_AUTH = prevAuth
    if (prevPoints === undefined) delete process.env.SKIP_POINTS
    else process.env.SKIP_POINTS = prevPoints
    if (prevNodeTest === undefined) delete process.env.NODE_TEST_CONTEXT
    else process.env.NODE_TEST_CONTEXT = prevNodeTest
  }
})

