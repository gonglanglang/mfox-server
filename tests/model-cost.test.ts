import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveModelCost } from '../src/tools/index'

// resolveModelCost 只读模型行，不需要数据库连接
const model = (price_config: unknown) => ({ price_config } as any)

test('按档位精确匹配（label 或 value 都认）', () => {
  const tiers = [
    { label: '高清', value: 'high', price: 40 },
    { label: '标清', value: 'low', price: 20 },
  ]
  assert.equal(resolveModelCost(model(tiers), 'high'), 40)
  assert.equal(resolveModelCost(model(tiers), '高清'), 40)
  assert.equal(resolveModelCost(model(tiers), 'low'), 20)
  assert.equal(resolveModelCost(model(tiers), '高清 1080P'), 0) // 未命中且没有「默认」行 → 不收费
})

test('未传档位时回退到「默认」行（固定价）', () => {
  const tiers = [
    { label: '100', value: '100', price: 20 },
    { label: '默认', value: 'default', price: 9 },
  ]
  assert.equal(resolveModelCost(model(tiers), undefined), 9)
  assert.equal(resolveModelCost(model(tiers), '100'), 20)
})

test('没有价格档位或完全未命中时不收费', () => {
  assert.equal(resolveModelCost(model(undefined), 'high'), 0)
  assert.equal(resolveModelCost(model([]), 'high'), 0)
  assert.equal(resolveModelCost(model([{ label: '高清', value: 'high', price: 40 }]), 'low'), 0)
  assert.equal(resolveModelCost(model([{ label: '高清', value: 'high', price: 40 }]), undefined), 0)
})

test('非法价格按 0 处理，负数与小数被规范化', () => {
  assert.equal(resolveModelCost(model([{ label: '默认', price: 'abc' }]), undefined), 0)
  assert.equal(resolveModelCost(model([{ label: '默认', price: -5 }]), undefined), 0)
  assert.equal(resolveModelCost(model([{ label: '默认', price: 12.9 }]), undefined), 12)
})
