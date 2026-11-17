import express from "express";
import { eq, and, asc } from "drizzle-orm";
import { db, schema } from "../mysqlDb";
import { success, error } from "../tools/response";
import { checkModelCompleteness } from "../tools/model-rules";
import { resolveCapability } from "../pipeline/model-schema";
import { isSkipPointsEnabled } from "../config/bypass";

const app = express();

// 合法模型类型白名单
const VALID_TYPES = ["text", "video", "image", "audio"];

// 获取模型列表（仅返回启用且配置完整的模型，可按类型过滤，携带供应商展示名）
// GET /ai-models?type=video （type: text / video / image / audio）
app.get("/", async (req, res) => {
  try {
    const type = req.query.type as string | undefined;
    // 类型白名单校验：非法值（含 ?type=a&type=b 数组）直接拒绝
    if (type !== undefined && !VALID_TYPES.includes(type)) {
      return error(res, "非法模型类型，仅支持 text / video / image / audio", 400);
    }

    const whereClause = type
      ? and(eq(schema.ai_models.content_type, type), eq(schema.ai_models.status, 1))
      : eq(schema.ai_models.status, 1);

    const joined = await db
      .select({
        modelRow: schema.ai_models,
        providerRow: schema.ai_service_configs,
      })
      .from(schema.ai_models)
      .innerJoin(
        schema.ai_service_configs,
        eq(schema.ai_models.provider_id, schema.ai_service_configs.id),
      )
      .where(whereClause)
      .orderBy(asc(schema.ai_models.sort_order), asc(schema.ai_models.id));

    const skipPoints = isSkipPointsEnabled();
    const list = joined
      .filter(({ modelRow, providerRow }) => checkModelCompleteness(modelRow, providerRow).ok)
      .map(({ modelRow, providerRow }) => ({
        id: modelRow.id,
        content_type: modelRow.content_type,
        name: modelRow.name,
        model: modelRow.model,
        status: modelRow.status,
        provider_id: modelRow.provider_id,
        provider_name: providerRow.name || providerRow.provider,
        price_config:
          skipPoints && Array.isArray(modelRow.price_config)
            ? modelRow.price_config.map((tier: any) =>
                tier && typeof tier === "object" ? { ...tier, price: 0 } : tier,
              )
            : modelRow.price_config,
        capabilities: resolveCapability({
          key: modelRow.model,
          name: modelRow.name,
          capabilities: modelRow.capabilities,
        }),
        params: modelRow.params,
        endpoint: modelRow.endpoint,
        sort_order: modelRow.sort_order ?? 0,
      }));

    return success(res, list);
  } catch (e: any) {
    return error(res, e.message);
  }
});

export default app;
