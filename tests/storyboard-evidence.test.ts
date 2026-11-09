import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { db } from '../src/mysqlDb'
import { loadStoryboardEvidence } from '../src/tools/storyboard-evidence'

const scope = { workId: 8, chapterId: 9, userId: 10 }
const configs = [{ scene_id: '110', prop_ids: ['123'], role_id: '999', shots: [
  { roles: [{ id: '26' }, { id: 27 }], dialogue: [] },
  { roles: [{ id: 26 }], dialogue: [{ id: '999' }] },
] }]

test('one scoped query filters latest scene, prop and shot role IDs and returns selected images', async t => {
  let calls = 0
  let query: { sql: string; params: unknown[] } | undefined
  const rows = [
    { id: 26, source_type: 'persona', name: '韩立', description: '角色', detail: { age: 12 }, cur_image_id: 'chosen', images: [{ id: 'other', url: 'old.png' }, { id: 'chosen', url: 'role.png', job_status: 'ready' }] },
    { id: 27, source_type: 'persona', name: '韩铸', cur_image_id: null, images: [] },
    { id: 110, source_type: 'scene', name: '卧房', cur_image_id: 'room', images: [{ id: 'room', url: 'room.png' }] },
    { id: 123, source_type: 'prop', name: '被子', cur_image_id: 'pending', images: [{ id: 'pending', url: 'pending.png', job_status: 'running' }] },
  ]
  t.mock.method(db, 'select', () => {
    calls++
    return { from: () => ({ where: (where: any) => {
      query = new MySqlDialect().sqlToQuery(where)
      return { orderBy: async () => rows }
    } }) }
  })
  const before = structuredClone(configs)
  const result = await loadStoryboardEvidence(scope, configs)
  assert.equal(calls, 1)
  assert.deepEqual(query!.params, [8, 10, 'persona', 26, 27, 'prop', 123, 'scene', 110, 9])
  assert.match(query!.sql, /work_id/)
  assert.match(query!.sql, /user_id/)
  assert.match(query!.sql, /chapters_id/)
  assert.deepEqual(result.roles?.map(role => role.id), [26, 27])
  assert.equal(result.roles?.[0]?.image, 'role.png')
  assert.equal(result.roles?.[0]?.imageId, 'chosen')
  assert.deepEqual(result.roles?.[0]?.detail, { age: 12 })
  assert.equal(result.scene?.[0]?.image, 'room.png')
  assert.equal(Object.hasOwn(result.props![0]!, 'image'), false)
  assert.equal(Object.hasOwn(result.props![0]!, 'imageId'), false)
  assert.equal(result.assets?.length, 4)
  assert.deepEqual(configs, before)
})

test('empty configs skip querying and invalid IDs are rejected', async t => {
  t.mock.method(db, 'select', () => { throw new Error('Unexpected query') })
  assert.deepEqual(await loadStoryboardEvidence(scope, []), {})
  await assert.rejects(loadStoryboardEvidence(scope, [{ scene_id: '', prop_ids: [], shots: [] }]), /正整数/)
  await assert.rejects(loadStoryboardEvidence({ ...scope, userId: 0 }, []), /正整数/)
})

test('omitting configs loads available scoped assets with the same image mapping', async t => {
  let query: { sql: string; params: unknown[] } | undefined
  t.mock.method(db, 'select', () => ({ from: () => ({ where: (where: any) => {
    query = new MySqlDialect().sqlToQuery(where)
    return { orderBy: async () => [{ id: 110, source_type: 'scene', name: '卧房', cur_image_id: 'v1', images: [{ id: 'v1', url: 'scene.png' }] }] }
  } }) }))
  const result = await loadStoryboardEvidence(scope)
  assert.deepEqual(query!.params, [8, 10, 'persona', 'prop', 'scene', 9])
  assert.equal(result.scene?.[0]?.image, 'scene.png')
  assert.equal(result.scene?.[0]?.imageId, 'v1')
  assert.equal(Object.hasOwn(result, 'roles'), false)
  assert.equal(Object.hasOwn(result, 'props'), false)
})

test('recursively removes empty fields and array entries while preserving zero and false', async t => {
  const row = { id: 26, source_type: 'persona', name: '韩立', description: '  ', cur_image_id: null, images: [],
    detail: { nil: null, missing: undefined, empty: '', blank: ' \n ', list: [], object: {},
      nested: { empty: [null, '', {}] }, age: 0, interior: false,
      tags: [null, '', [], {}, 0, false, { keep: '原文', drop: null }] } }
  const before = structuredClone(row)
  t.mock.method(db, 'select', () => ({ from: () => ({ where: () => ({ orderBy: async () => [row] }) }) }))
  const result = await loadStoryboardEvidence(scope)
  assert.deepEqual(result.roles?.[0], { id: 26, type: 'persona', name: '韩立',
    detail: { age: 0, interior: false, tags: [0, false, { keep: '原文' }] } })
  assert.deepEqual(row, before)
})
