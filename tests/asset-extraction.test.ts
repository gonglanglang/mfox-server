import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAssetArray, resolveCharacterIds } from '../src/tools/asset-extraction'

test('empty and fenced model arrays are accepted, non-arrays rejected', () => {
  assert.deepEqual(parseAssetArray('[]'), [])
  assert.deepEqual(parseAssetArray('```json\n[{"name":"剑"}]\n```'), [{ name: '剑' }])
  assert.throws(() => parseAssetArray('{}'))
  assert.throws(() => parseAssetArray('[invalid]'))
})

test('legacy names resolve only when unique; unknown IDs are rejected', () => {
  const roles = [{ id: 1, name: '甲' }, { id: 2, name: '乙' }, { id: 3, name: '乙' }]
  assert.deepEqual(resolveCharacterIds(['甲', 1, '乙', 99], roles), {
    ids: [1], unresolved: ['乙', 99],
  })
})

test('stored IDs keep their association after renaming', () => {
  assert.deepEqual(resolveCharacterIds([1], [{ id: 1, name: '新名字' }]), { ids: [1], unresolved: [] })
})
