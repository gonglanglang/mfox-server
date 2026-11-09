import { test } from 'node:test'
import assert from 'node:assert/strict'
import { patchStoryboardScene } from '../src/tools/storyboard-patch'

const fixture = () => [{
  scene_id: '110', prop_ids: ['123'], environment: '夜', transition: '淡出', bgm: '古琴',
  shots: [{ content: '旧', sound_effect: '风', finalVideoUrl: 'keep', dialogue: [
    { id: '26', speaker: '韩立（内心OS）', text: '你好', tone: '低语', emotion: 'calm' },
    { id: '26', speaker: '韩立（内心OS）', text: '再见', tone: '呢喃', emotion: 'happy' },
  ] }, { content: '邻镜', dialogue: [] }],
}]

test('镜头修改保留对白元数据、媒体和相邻镜头，不修改输入', () => {
  const scenes = fixture()
  const { configs, updated } = patchStoryboardScene(scenes, 0, 0, { content: '新' })
  assert.equal(updated.content, '新')
  assert.equal(updated.finalVideoUrl, 'keep')
  assert.deepEqual(updated.dialogue, scenes[0]!.shots[0]!.dialogue)
  assert.equal(configs[0].shots[1], scenes[0]!.shots[1])
  assert.equal(scenes[0]!.shots[0]!.content, '旧')
})

test('重复场景素材 ID 按数组索引定位，场景字段编辑保留镜头', () => {
  const scenes = [...fixture(), ...fixture()]
  const result = patchStoryboardScene(scenes, 1, undefined, { bgm: '', prop_ids: [] })
  assert.equal(result.configs[0].bgm, '古琴')
  assert.equal(result.configs[1].bgm, '')
  assert.deepEqual(result.scene.prop_ids, [])
  assert.equal(result.scene.shots, scenes[1]!.shots)
})

test('重复角色对白不合并，支持清空对白', () => {
  const scenes = fixture()
  const dialogue = scenes[0]!.shots[0]!.dialogue
  assert.deepEqual(patchStoryboardScene(scenes, 0, 0, { dialogue }).updated.dialogue, dialogue)
  assert.deepEqual(patchStoryboardScene(scenes, 0, 0, { dialogue: [] }).updated.dialogue, [])
})

test('拒绝错层字段、媒体覆盖、错误类型和无效索引', () => {
  for (const patch of [{ shots: [] }, { bgm: 'x' }, { finalVideoUrl: 'bad' }, { content: null }, { dialogue: [{}] }, {}]) {
    assert.throws(() => patchStoryboardScene(fixture(), 0, 0, patch))
  }
  assert.throws(() => patchStoryboardScene(fixture(), 0, 9, { content: 'x' }))
  assert.throws(() => patchStoryboardScene(fixture(), -1, undefined, { bgm: 'x' }))
  assert.throws(() => patchStoryboardScene(fixture(), 0, undefined, { dialogue: [] }))
})

test('scene_tags 同时兼容字符串数组与逗号分隔字符串，避免前端保存或重绘时报错', () => {
  const scenes = fixture()
  const fromEmptyArray = patchStoryboardScene(scenes, 0, 0, { scene_tags: [] })
  assert.equal(fromEmptyArray.updated.scene_tags, '')

  const fromArray = patchStoryboardScene(scenes, 0, 0, { scene_tags: ['雨夜', '废弃工厂'] })
  assert.equal(fromArray.updated.scene_tags, '雨夜,废弃工厂')

  const fromString = patchStoryboardScene(scenes, 0, 0, { scene_tags: '室内,暖光' })
  assert.equal(fromString.updated.scene_tags, '室内,暖光')
})


