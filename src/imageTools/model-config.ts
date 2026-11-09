import { and, eq } from 'drizzle-orm'
import { db, schema } from '../mysqlDb'
import { asJsonObject, matchTier, normalizeTiers, type ModelTier } from '../tools/model-tier'

export interface ResolvedImageModel {
  model: string
  provider: string
  protocol: string
  baseUrl: string
  apiKey: string
  /** 相对 baseUrl 的接口路径；留空时适配器用协议默认路径 */
  endpoint: string
  /** 模型固定参数（ai_models.params） */
  params: Record<string, unknown>
  tiers: ModelTier[]
  /** 归一后的档位取值（请求体与计费键共用；未选档位时为空串） */
  resolutionValue: string
  /** 尺寸映射（ai_models.size_map）：{档位: {宽高比: "宽x高"}}，把档位+作品比例还原成像素值 */
  sizeMap: unknown
}

/** .env 兜底：调用方未指定模型时沿用历史行为，走 SEEDREAM_* 配置 */
function resolveFallbackModel(): ResolvedImageModel {
  return {
    model: process.env.SEEDREAM_MODEL || 'doubao-seedream-5.0-lite',
    provider: '',
    protocol: 'openai-images',
    baseUrl: process.env.SEEDREAM_BASE_URL || '',
    apiKey: process.env.SEEDREAM_API_KEY || '',
    endpoint: '',
    params: {},
    tiers: [],
    resolutionValue: '',
    sizeMap: {},
  }
}

/**
 * 解析图片模型：校验模型与档位，返回连接信息、调用协议与固定参数。
 * 档位（尺寸 / 分辨率）与价格统一来自 ai_models.price_config。
 */
export async function resolveImageModel(model?: string, option?: string): Promise<ResolvedImageModel> {
  if (!model) return resolveFallbackModel()

  const [row] = await db.select({
    model: schema.ai_models.model,
    endpoint: schema.ai_models.endpoint,
    params: schema.ai_models.params,
    priceConfig: schema.ai_models.price_config,
    sizeMap: schema.ai_models.size_map,
    baseUrl: schema.ai_service_configs.api_url,
    apiKey: schema.ai_service_configs.api_key,
    protocol: schema.ai_service_configs.protocol,
    provider: schema.ai_service_configs.provider,
  }).from(schema.ai_models)
    .innerJoin(schema.ai_service_configs, eq(schema.ai_models.provider_id, schema.ai_service_configs.id))
    .where(and(eq(schema.ai_models.model, model), eq(schema.ai_models.content_type, 'image'),
      eq(schema.ai_models.status, 1))).limit(1)

  if (!row) throw new Error(`图片模型不存在或已停用：${model}`)
  if (!row.baseUrl || !row.apiKey) throw new Error(`图片模型服务商配置不完整：${model}`)

  const tiers = normalizeTiers(row.priceConfig)
  return {
    model: row.model,
    provider: row.provider || '',
    protocol: row.protocol || '',
    baseUrl: row.baseUrl,
    apiKey: row.apiKey,
    endpoint: row.endpoint || '',
    params: asJsonObject(row.params),
    tiers,
    resolutionValue: matchTier(tiers, option),
    sizeMap: row.sizeMap,
  }
}
