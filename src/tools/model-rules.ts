/**
 * 模型配置完整性校验规则（与 mfox-admin-server/src/utils/model-rules.js 保持逐行同步）
 *
 * 详见《模型配置重构设计.md》第 6 节：
 * - 所有类型（text / image / audio / video）必填：provider_id、content_type、name、model、所属供应商有效（api_url + api_key 非空）
 * - image / video 额外必填：
 *   - size_map 非空（至少 1 个档位，且每个档位下至少 1 个合法 "宽x高" 宽高比像素值）
 *   - price_config 非空（至少 1 档，且每档含非空 label 与 value）
 * - text / audio：params、price_config 均为可选
 */

export interface CompletenessResult {
  ok: boolean
  missing: string[]
}

const VALID_CONTENT_TYPES = ['text', 'image', 'audio', 'video'] as const

function parseJsonIfNeeded(val: unknown): unknown {
  if (typeof val === 'string' && val.trim()) {
    try {
      return JSON.parse(val)
    } catch {
      return val
    }
  }
  return val
}

/**
 * 校验单个模型行及其所属供应商是否满足启用条件
 * @param row      ai_models 行对象
 * @param provider ai_service_configs 行对象（可选；传入时校验供应商存在且 api_url / api_key 非空）
 */
export function checkModelCompleteness(
  row: Record<string, any> | null | undefined,
  provider?: Record<string, any> | null,
): CompletenessResult {
  const missing: string[] = []
  if (!row || typeof row !== 'object') {
    return { ok: false, missing: ['模型记录不存在'] }
  }

  if (!row.provider_id) missing.push('所属供应商')
  const contentType = String(row.content_type || '').trim()
  if (!VALID_CONTENT_TYPES.includes(contentType as any)) {
    missing.push('模型类型')
  }
  if (!String(row.name || '').trim()) missing.push('展示名称')
  if (!String(row.model || '').trim()) missing.push('模型标识')

  // 若显式传入了 provider 参数（含 null），则校验供应商有效性
  if (provider !== undefined) {
    if (!provider || !String(provider.api_url || '').trim() || !String(provider.api_key || '').trim()) {
      missing.push('供应商 API URL / Key')
    }
  }

  // 图片 & 视频模型：必须配置尺寸映射与价格档位
  if (contentType === 'image' || contentType === 'video') {
    const rawSizeMap = parseJsonIfNeeded(row.size_map)
    const sizeMap =
      rawSizeMap && typeof rawSizeMap === 'object' && !Array.isArray(rawSizeMap)
        ? (rawSizeMap as Record<string, unknown>)
        : {}
    const tiers = Object.keys(sizeMap).filter((k) => String(k).trim().length > 0)
    if (tiers.length === 0) {
      missing.push('尺寸映射（至少 1 个档位）')
    } else {
      for (const tier of tiers) {
        const ratiosObj = sizeMap[tier]
        const ratios =
          ratiosObj && typeof ratiosObj === 'object' && !Array.isArray(ratiosObj)
            ? Object.values(ratiosObj as Record<string, unknown>).filter(
                (v) => typeof v === 'string' && /^\d+x\d+$/.test(v.trim()),
              )
            : []
        if (ratios.length === 0) {
          missing.push(`档位「${tier}」缺少宽高比尺寸`)
        }
      }
    }

    const rawPrices = parseJsonIfNeeded(row.price_config)
    const prices = Array.isArray(rawPrices)
      ? rawPrices.filter(
          (p) =>
            p &&
            typeof p === 'object' &&
            String((p as any).label || '').trim() &&
            String((p as any).value ?? '').trim(),
        )
      : []
    if (prices.length === 0) {
      missing.push('价格档位（至少 1 档）')
    }
  }

  // 文本 & 音频模型：params、price_config 均可选，无额外必填项
  return { ok: missing.length === 0, missing }
}
