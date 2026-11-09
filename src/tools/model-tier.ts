/**
 * 模型档位工具：图片与视频共用。
 *
 * 档位（分辨率 / 尺寸）与价格同源，统一来自 ai_models.price_config：
 * [{ label, value, price }] —— label 显示、value 请求与匹配、price 积分。
 */

export interface ModelTier {
  label: string
  value: string
  price: number
}

function parseArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

/** 把 JSON 列（mysql2 可能返回字符串）解析成对象 */
export function asJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }
  return {}
}

/** 归一价格档位（兼容 JSON 字符串；无效项与重复 value 会被丢弃） */
export function normalizeTiers(value: unknown): ModelTier[] {
  const seen = new Set<string>()
  return parseArray(value).flatMap((item) => {
    const option = asJsonObject(item)
    const label = String(option.label || '').trim()
    const tierValue = String(option.value ?? '').trim()
    if (!label || !tierValue || seen.has(tierValue)) return []
    seen.add(tierValue)
    const price = Number(option.price)
    return [{ label, value: tierValue, price: Number.isFinite(price) && price >= 0 ? Math.floor(price) : 0 }]
  })
}

/**
 * 档位匹配：调用方传 label 或 value 均可，统一归一成发给供应商的 value。
 * - 未选档位：不校验，请求里也不带该参数（交给供应商默认值）；
 * - 模型未配档位：原样透传；
 * - 传了但不在档位内：报错，避免按错误档位计费 / 请求。
 */
export function matchTier(tiers: ModelTier[], input: string | undefined): string {
  if (!input) return ''
  if (!tiers.length) return input
  const hit = tiers.find(tier => tier.value === input || tier.label === input)
  if (!hit) throw new Error('请选择有效的档位（该模型未提供此档位）')
  return hit.value
}
