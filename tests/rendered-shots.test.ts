import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyRenderedShots } from '../src/mastra/workflows/NovelScriptFlows/index'

const framePrompt = (frame: string) => `${frame}，中景，正面机位，固定镜头，人物位于画面中央`
const renderedFrame = (index: number) => ({
  frame_index: index, prompt: framePrompt(`第${index + 1}帧`), negative_prompt: '排除现代服饰',
})
const chapters = () => [{
  scene_id: '110',
  shots: [{ content: '甲' }, { content: '乙' }, { content: '丙' }],
}]

test('渲染结果只写入批次范围内的镜头，其余镜头保持不变', () => {
  const configs = chapters()
  const updated = applyRenderedShots(configs, { sceneIndex: 0, batchStart: 1, batchSize: 2 }, {
    scene_id: '110', frames: [renderedFrame(1), renderedFrame(2), renderedFrame(3)],
  })
  assert.equal(updated[0]!.shots[0]!.start_prompt, undefined)
  assert.equal(updated[0]!.shots[0]!.content, '甲')
  assert.match(updated[0]!.shots[1]!.start_prompt, /第2帧/)
  assert.match(updated[0]!.shots[2]!.end_prompt, /第4帧/)
  assert.equal(updated[0]!.shots[1]!.content, '乙')
  assert.equal(configs[0]!.shots[1]!.start_prompt, undefined)
})

test('同一镜的起终两帧描述相同或非八段式自然语言均允许正常写入', () => {
  const configs = chapters()
  const updated = applyRenderedShots(configs, { sceneIndex: 0, batchStart: 0, batchSize: 1 }, {
    scene_id: '110', frames: [
      { frame_index: 0, prompt: '同一画面自然语言提示词', negative_prompt: '' },
      { frame_index: 1, prompt: '同一画面自然语言提示词', negative_prompt: '' },
    ],
  })
  assert.equal(updated[0]!.shots[0]!.start_prompt, '同一画面自然语言提示词')
  assert.equal(updated[0]!.shots[0]!.end_prompt, '同一画面自然语言提示词')
})

test('场景不匹配、数量不符、索引越界或重复一律拒绝', () => {
  const configs = chapters()
  const apply = (value: unknown, batch = { sceneIndex: 0, batchStart: 0, batchSize: 2 }) =>
    applyRenderedShots(configs, batch, value)

  assert.throws(() => apply({ scene_id: '111', frames: [renderedFrame(0), renderedFrame(1), renderedFrame(2)] }), /场景不匹配/)
  assert.throws(() => apply({ scene_id: '110', frames: [renderedFrame(0)] }), /帧数量应为 3/)
  assert.throws(() => apply({ scene_id: '110', frames: [renderedFrame(0), renderedFrame(1), renderedFrame(3)] }), /批外帧索引/)
  assert.throws(() => apply({ scene_id: '110', frames: [renderedFrame(1), renderedFrame(1), renderedFrame(2)] }), /帧索引重复/)
  assert.throws(() => applyRenderedShots(configs, { sceneIndex: 0, batchStart: 2, batchSize: 2 },
    { scene_id: '110', frames: [renderedFrame(2), renderedFrame(3), renderedFrame(4)] }), /批次越界/)
  assert.throws(() => applyRenderedShots(configs, { sceneIndex: 5, batchStart: 0, batchSize: 1 },
    { scene_id: '110', frames: [renderedFrame(0), renderedFrame(1)] }), /场景不存在/)
})
