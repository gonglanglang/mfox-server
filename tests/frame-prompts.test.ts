import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assetFrameReferences, numberFrameReferences, isFixedFramePrompt, assertFramePromptPair } from '../src/tools/frame-prompts'

test('人物素材把身高写进参考图标签，其它类型与缺省身高不受影响', () => {
  const references = assetFrameReferences([
    { id: 31, type: 'persona', name: '郭晴', image: 'g.png', height: 170 },
    { id: 26, type: 'persona', name: '何杰熊', image: 'h.png' },
    { id: 110, type: 'scene', name: '卧室', image: 's.png', height: 999 },
    { id: 123, type: 'prop', name: '旧棉被', image: 'p.png' },
    { id: 99, type: 'persona', name: '无图素材', image: '' },
  ])
  assert.deepEqual(references.map(ref => ref.label), [
    '角色：【郭晴】（ID:31，身高170cm）',
    '角色：【何杰熊】（ID:26）',
    '场景：【卧室】（ID:110）',
    '道具：【旧棉被】（ID:123）',
  ])
  assert.ok(!references[1]!.label.includes('身高'))
  assert.deepEqual(numberFrameReferences(references).map(ref => ref.label), [
    '图1 角色：【郭晴】（ID:31，身高170cm）',
    '图2 角色：【何杰熊】（ID:26）',
    '图3 场景：【卧室】（ID:110）',
    '图4 道具：【旧棉被】（ID:123）',
  ])
})

test('首尾帧提示词已移除八段式与身份硬约束，任意非空提示词均判为合法', () => {
  assert.equal(isFixedFramePrompt('远景，正面机位，夜雨中的后山丹房门槛外'), true)
  assert.equal(isFixedFramePrompt('【镜头】中全景\n【画面构图】人物位于中央'), true)
  assert.equal(isFixedFramePrompt('   '), false)
  assert.doesNotThrow(() => assertFramePromptPair('本帧是尾帧', '本帧是首帧'))
})
