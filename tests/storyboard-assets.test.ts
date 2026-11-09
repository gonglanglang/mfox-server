import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validatePanelAssets } from '../src/tools/storyboard-assets'

const assets = [
  { id: 110, source_type: 'scene' },
  { id: 26, source_type: 'persona' },
  { id: 123, source_type: 'prop' },
]

test('normalizes AI string IDs and deduplicates props while preserving role details', () => {
  const panel = { scene_id: '110', roles: [{ id: '26', name: '韩立' }], prop_ids: ['123', 123] }
  validatePanelAssets(panel, assets)
  assert.deepEqual(panel, { scene_id: 110, roles: [{ id: 26, name: '韩立' }], prop_ids: [123] })
})

test('accepts numeric IDs and optional assets', () => {
  const panel = { scene_id: 110, roles: [{ id: 26 }], prop_ids: [123] }
  validatePanelAssets(panel, assets)
  assert.equal(panel.scene_id, 110)
  const empty = {}
  validatePanelAssets(empty, assets)
  assert.deepEqual(empty, { scene_id: null, prop_ids: [] })
})

test('rejects invalid, unavailable, and wrong-type references', () => {
  for (const id of ['', ' ', true, false, [], {}, '110x', '1.1e2', '0x6e', 110.5, 0, -1, '999', '26']) {
    assert.throws(() => validatePanelAssets({ scene_id: id }, assets), /无效场景/)
  }
  assert.throws(() => validatePanelAssets({ prop_ids: ['110'] }, assets), /无效道具/)
  assert.throws(() => validatePanelAssets({ roles: [{ id: '123' }] }, assets), /无效角色/)
  assert.throws(() => validatePanelAssets({ scene_id: '110' }, []), /无效场景.*110/)
})

test('rejects malformed lists and leaves the input unchanged on failure', () => {
  for (const prop_ids of [null, '123', {}]) {
    assert.throws(() => validatePanelAssets({ prop_ids }, assets), /无效道具/)
  }
  for (const roles of [null, '26', {}, [null]]) {
    assert.throws(() => validatePanelAssets({ roles }, assets), /无效角色/)
  }
  const panel = { scene_id: '110', prop_ids: ['123'], roles: [{ id: '999' }] }
  const original = structuredClone(panel)
  assert.throws(() => validatePanelAssets(panel, assets), /无效角色.*999/)
  assert.deepEqual(panel, original)
})
