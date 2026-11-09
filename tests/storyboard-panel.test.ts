import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveStoryboardPanel } from '../src/tools/storyboard-panel'
import { patchStoryboardScene } from '../src/tools/storyboard-patch'

test('scene transition and shot prompts save at their respective levels', () => {
  const configs = [{ scene_id: '110', environment: '夜', transition: '硬切', shots: [
    { content: '一', start_prompt: '旧首帧', dialogue: [] }, { content: '二', dialogue: [] },
  ] }]
  const scene = patchStoryboardScene(configs, 0, undefined, { transition: '淡入淡出' })
  assert.equal(scene.scene.transition, '淡入淡出')
  assert.equal(scene.scene.shots, configs[0]!.shots)
  const shot = patchStoryboardScene(scene.configs, 0, 0, {
    start_prompt: '新首帧', end_prompt: '尾帧', negative_prompt: '', sound_effect: '风声',
  })
  assert.equal(shot.updated.start_prompt, '新首帧')
  assert.equal(shot.updated.end_prompt, '尾帧')
  assert.equal(shot.updated.negative_prompt, '')
  assert.equal(shot.updated.sound_effect, '风声')
  assert.equal(shot.scene.environment, '夜')
  assert.equal(shot.scene.shots[1].start_prompt, undefined)
  assert.throws(() => patchStoryboardScene(configs, 0, undefined, { transition: '随意值' }), /切换方式/)
})

const fixture = (): any[] => [
  { scene_id: '110', prop_ids: ['123'], environment: '深夜', shots: [
    { content: '睁眼', dialogue: [{ id: '26', speaker: '韩立（内心OS）', text: '你好', tone: '低语', emotion: 'calm' }] },
    { content: '闭眼', dialogue: [] },
  ] },
  { scene_id: '110', prop_ids: [], environment: '清晨', shots: [{ content: '起床', dialogue: [] }] },
]

test('global indices resolve nested shots with repeated scene assets', () => {
  const configs = fixture()
  const first = resolveStoryboardPanel(configs, 0)!
  assert.equal(first.panel.environment, '深夜\n睁眼')
  assert.deepEqual(first.panel.roles, [{ id: 26 }])
  assert.equal(first.panel.segments[0].speaker, '韩立（内心OS）')
  assert.equal(first.panel.scene_id, 110)
  assert.deepEqual(first.panel.prop_ids, [123])
  assert.equal(resolveStoryboardPanel(configs, 1)!.panel.content, '闭眼')
  assert.equal(resolveStoryboardPanel(configs, 2)!.panel.content, '起床')
  assert.notEqual(first.sceneIdx, resolveStoryboardPanel(configs, 2)!.sceneIdx)
  assert.equal(resolveStoryboardPanel(configs, 3), undefined)
})

test('media persist on selected shot without flattening scenes', () => {
  const configs = fixture()
  const before = structuredClone(configs)
  const target = resolveStoryboardPanel(configs, 0)!
  Object.assign(target.panel, { panelStatus: 'done', firstFrameUrl: 'first.png', finalVideoUrl: 'video.mp4' })
  // TTS 音频归属台词本身（dialogue[].audioUrl）；segments 是派生视图，不参与落库
  configs[0].shots[0].dialogue[0].audioUrl = 'voice.mp3'
  target.commit()
  assert.equal(configs[0].shots[0].finalVideoUrl, 'video.mp4')
  assert.equal(configs[0].shots[0].environment, undefined)
  assert.equal(configs[0].shots[0].scene_id, undefined)
  assert.equal(configs[0].shots[0].segments, undefined)
  assert.deepEqual(configs[0].shots[0].dialogue[0], { ...before[0].shots[0].dialogue[0], audioUrl: 'voice.mp3' })
  assert.deepEqual(configs[0].shots[1], before[0].shots[1])
  assert.deepEqual(configs[1], before[1])
  assert.equal(resolveStoryboardPanel(configs, 0)!.panel.segments[0].audioUrl, 'voice.mp3')
})

test('legacy panelIdx and explicit empty roles remain authoritative', () => {
  const legacy = [{ panelIdx: 7, roles: [], segments: [], firstFrameUrl: 'old.png' }]
  assert.equal(resolveStoryboardPanel(legacy, 0), undefined)
  assert.equal(resolveStoryboardPanel(legacy, 7)!.panel, legacy[0])
  const configs = fixture()
  configs[0].shots[0].roles = []
  assert.deepEqual(resolveStoryboardPanel(configs, 0)!.panel.roles, [])
})

test('explicit cast includes silent roles, while narration keeps the narration voice', () => {
  const configs = fixture()
  configs[0].role_id = '99'
  configs[0].shots[0].roles = [{ id: '26' }, { id: '27' }]
  configs[0].shots[0].dialogue[0].speaker = '旁白'
  const target = resolveStoryboardPanel(configs, 0)!
  assert.deepEqual(target.panel.roles, [{ id: 26 }, { id: 27 }])
  assert.equal(target.panel.segments[0].type, 'narration')
  target.commit()
  assert.equal(configs[0].shots[0].dialogue[0].id, '26')
  assert.equal(configs[0].role_id, '99')
  const patched = patchStoryboardScene(configs, 0, 0, { roles: [{ id: '27' }] })
  assert.deepEqual(patched.updated.roles, [{ id: 27 }])
  assert.deepEqual(patched.updated.dialogue, configs[0].shots[0].dialogue)
})

test('production edits validate duration, roles and active tasks', () => {
  const configs = fixture()
  const patch = { durShort: 8, roles: [{ id: 26 }], videoPrompt: 'video' }
  const result = patchStoryboardScene(configs, 0, 1, patch)
  assert.equal(result.updated.durShort, 8)
  assert.deepEqual(result.updated.roles, [{ id: 26 }])
  for (const value of [0, 61, NaN, 1.5, '5']) assert.throws(() => patchStoryboardScene(configs, 0, 0, { durShort: value }))
  assert.throws(() => patchStoryboardScene(configs, 0, 0, { roles: [{ id: -1 }] }))
  configs[0].shots[0].panelStatus = 'generating'
  assert.throws(() => patchStoryboardScene(configs, 0, 0, { videoPrompt: 'overwrite' }), /生成/)
  assert.throws(() => patchStoryboardScene(configs, 0, undefined, { scene_id: 111 }), /生成/)
})
