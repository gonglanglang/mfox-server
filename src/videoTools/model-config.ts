import { and, eq } from 'drizzle-orm'
import { db, schema } from '../mysqlDb'
import { asJsonObject, matchTier, normalizeTiers, type ModelTier } from '../tools/model-tier'
import { resolveCapability, type ModelCapability } from '../pipeline/model-schema'

// 档位工具与图片模块共用（src/tools/model-tier.ts）；此处 re-export 保持既有引用可用
export { normalizeTiers }
export type { ModelTier }

/**
 * 解析视频模型：校验模型与档位，返回连接信息、调用协议与固定参数。
 * 档位（分辨率等）与价格统一来自 ai_models.price_config。
 */
export async function resolveVideoModel(model: string, option?: string) {
  const [row] = await db.select({
    model: schema.ai_models.model,
    endpoint: schema.ai_models.endpoint,
    params: schema.ai_models.params,
    priceConfig: schema.ai_models.price_config,
    capabilities: schema.ai_models.capabilities,
    baseUrl: schema.ai_service_configs.api_url,
    apiKey: schema.ai_service_configs.api_key,
    protocol: schema.ai_service_configs.protocol,
    provider: schema.ai_service_configs.provider,
  }).from(schema.ai_models)
    .innerJoin(schema.ai_service_configs, eq(schema.ai_models.provider_id, schema.ai_service_configs.id))
    .where(and(eq(schema.ai_models.model, model), eq(schema.ai_models.content_type, 'video'),
      eq(schema.ai_models.status, 1))).limit(1)
  if (!row?.baseUrl || !row.apiKey) throw new Error('视频模型不可用或服务商配置不完整')

  const tiers = normalizeTiers(row.priceConfig)
  const resolutionValue = matchTier(tiers, option)

  return {
    model: row.model,
    provider: row.provider || '',
    protocol: row.protocol || '',
    baseUrl: row.baseUrl,
    apiKey: row.apiKey,
    endpoint: row.endpoint || '',
    params: asJsonObject(row.params),
    tiers,
    /** 归一后的档位取值（请求体与计费键共用；未选档位时为空串） */
    resolutionValue,
    capabilities: resolveCapability({ key: row.model, capabilities: row.capabilities }),
  }
}
