import test from 'node:test'
import assert from 'node:assert/strict'
import { checkModelCompleteness as checkServer } from '../src/tools/model-rules'
// @ts-ignore — 跨项目一致性校验
import {
  checkModelCompleteness as checkAdmin,
  maskApiKey,
  isMaskedOrEmptyApiKey,
} from '../../mfox-admin-server/src/utils/model-rules.js'
// @ts-ignore — 前端规则一致性校验
import { checkModelCompleteness as checkFrontend } from '../../mfox-admin/src/views/ai/shared/modelSchema.js'

const validProvider = {
  id: 1,
  provider: 'seedance',
  name: '火山方舟',
  api_url: 'https://ark.cn-beijing.volces.com/api/v3',
  api_key: 'sk-1234567890abcdef',
}

test('text / audio 模型只需基础必填项即可完整启用（三端规则一致）', () => {
  const row = {
    provider_id: 1,
    content_type: 'text',
    name: 'DeepSeek V3',
    model: 'deepseek-v3',
    size_map: {},
    price_config: [],
  }
  const s = checkServer(row, validProvider)
  const a = checkAdmin(row, validProvider)
  const f = checkFrontend(row, validProvider)
  assert.equal(s.ok, true)
  assert.deepEqual(s, a)
  assert.deepEqual(s, f)
})

test('image / video 模型缺少 size_map 或 price_config 时判定不完整（三端规则一致）', () => {
  const incompleteImage = {
    provider_id: 1,
    content_type: 'image',
    name: '豆包 Seedream 5.0 Lite',
    model: 'doubao-seedream-5-0-lite',
    size_map: {},
    price_config: [],
  }
  const s1 = checkServer(incompleteImage, validProvider)
  const a1 = checkAdmin(incompleteImage, validProvider)
  const f1 = checkFrontend(incompleteImage, validProvider)
  assert.equal(s1.ok, false)
  assert.ok(s1.missing.includes('尺寸映射（至少 1 个档位）'))
  assert.ok(s1.missing.includes('价格档位（至少 1 档）'))
  assert.deepEqual(s1, a1)
  assert.deepEqual(s1, f1)

  const completeImage = {
    ...incompleteImage,
    size_map: { '2K': { '16:9': '2848x1600', '1:1': '2048x2048' } },
    price_config: [{ label: '2K 高清', value: '2K', price: 10 }],
  }
  const s2 = checkServer(completeImage, validProvider)
  const a2 = checkAdmin(completeImage, validProvider)
  const f2 = checkFrontend(completeImage, validProvider)
  assert.equal(s2.ok, true)
  assert.deepEqual(s2, a2)
  assert.deepEqual(s2, f2)
})

test('供应商缺失 api_url 或 api_key 时判定不完整', () => {
  const row = {
    provider_id: 1,
    content_type: 'audio',
    name: 'CosyVoice',
    model: 'cosyvoice-v1',
  }
  const badProvider = { ...validProvider, api_key: '' }
  const s = checkServer(row, badProvider)
  const a = checkAdmin(row, badProvider)
  const f = checkFrontend(row, badProvider)
  assert.equal(s.ok, false)
  assert.ok(s.missing.includes('供应商 API URL / Key'))
  assert.deepEqual(s, a)
  assert.deepEqual(s, f)
})

test('API Key 脱敏与防覆盖判断', () => {
  const raw = 'sk-123456789f2a'
  const masked = maskApiKey(raw)
  assert.equal(masked, 'sk-****9f2a')
  assert.equal(isMaskedOrEmptyApiKey('', raw), true)
  assert.equal(isMaskedOrEmptyApiKey(null, raw), true)
  assert.equal(isMaskedOrEmptyApiKey(masked, raw), true)
  assert.equal(isMaskedOrEmptyApiKey('sk-newkey999999', raw), false)
})
