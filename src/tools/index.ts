import json5 from "json5";
import { createOpenAI } from "@ai-sdk/openai";
import type { RequestContext } from "@mastra/core/request-context";
import { db, schema, type DbExecutor } from "../mysqlDb/index";
import { eq, and, gte, sql } from "drizzle-orm";
import { safeJsonParse } from "./animahub-json";
import { isSkipPointsEnabled } from "../config/bypass";

/**
 * 从 LLM 返回的文本中提取并解析 JSON 对象或数组（接入 AnimaHub 自愈修复引擎）。
 * 支持以下格式：
 * - 纯 JSON 字符串（对象或数组）
 * - 含 `<think>...</think>` 推理块或被 ```json ... ``` 包裹的 JSON
 * - 前后包含额外说明文字的 JSON（平衡括号提取）
 * - 字符串内未转义换行符、漏逗号、尾随逗号自动修复
 *
 * @param text - LLM 返回的原始文本
 * @returns 解析后的对象/数组；如果解析失败则返回 null
 */
export function LLMJSON(text: string): any | null {
  if (!text || typeof text !== "string") {
    return null;
  }

  const parsed = safeJsonParse(text);
  if (parsed.ok) {
    return parsed.value;
  }

  // 抑制空串噪音，保留真实格式失败告警便于排障
  if (text.trim()) {
    console.warn("JSON 解析失败，原始文本片段：", text.slice(0, 300));
  }
  void json5;
  return null;
}

// 根据请求上下文中的模型标识创建 LLM 实例（模型工厂）
// ① 查 ai_models 定位模型 → ② 查 ai_service_configs 取服务商配置 → 创建 provider
export async function createModelFromContext({
  requestContext,
}: {
  requestContext?: RequestContext;
}) {
  const modelId = requestContext?.get("aiModel") as string | undefined;
  if (!modelId) throw new Error("缺少模型标识（aiModel）");

  const [modelConfig] = await db
    .select()
    .from(schema.ai_models)
    .where(eq(schema.ai_models.model, modelId))
    .limit(1);
  if (!modelConfig) throw new Error(`模型不存在：${modelId}`);

  const [providerConfig] = await db
    .select()
    .from(schema.ai_service_configs)
    .where(eq(schema.ai_service_configs.id, modelConfig.provider_id))
    .limit(1);
  if (!providerConfig)
    throw new Error(
      `模型 ${modelId} 的服务商配置不存在（provider_id: ${modelConfig.provider_id}）`,
    );

  // ⚠️ 日志不打印 API Key，避免密钥泄露
  console.log(
    `调用模型 ${modelConfig.model}（服务商 ${providerConfig.name}，${providerConfig.api_url || ""}）`,
  );

  const provider = createOpenAI({
    name: providerConfig.name || modelConfig.name, // provider 标识用服务商名
    apiKey: providerConfig.api_key || "",
    baseURL: providerConfig.api_url || "",
  });
  return provider.chat(modelConfig.model);
}

// ============================================
// 节流写入器：按时间间隔节流调用 write，串行 promise 链保证写入顺序，
// 写入失败静默（不阻断调用方主流程）。
// ============================================

/**
 * @param write      实际写入函数（如 updateTask(taskId, patch)）
 * @param throttleMs 节流间隔（毫秒）：距上次实际写入不足该间隔时跳过
 */
export function createThrottledWriter<T>(
  write: (data: T) => Promise<unknown>,
  throttleMs: number,
) {
  let lastWriteAt = 0
  let chain: Promise<unknown> = Promise.resolve()

  const enqueue = (data: T) => {
    const snapshot = data // 捕获快照，避免调用方后续修改影响已入队数据
    chain = chain
      .then(() => write(snapshot))
      .catch(() => { /* 写失败不阻断主流程 */ })
  }

  /** 节流入队：距上次写入不足 interval 时跳过；用于高频中间态写入 */
  function push(data: T) {
    const now = Date.now()
    if (now - lastWriteAt < throttleMs) return
    lastWriteAt = now
    enqueue(data)
  }

  /** 立即入队（不节流），用于最终状态写入 */
  function writeNow(data: T) {
    enqueue(data)
  }

  /** 等待链上所有已入队写入完成（排空） */
  async function flush() {
    await chain
  }

  return { push, writeNow, flush }
}

// ============================================
// 积分扣除工具：原子扣减用户积分（WHERE points >= amount 条件更新，
// 天然防止并发超扣），余额不足返回 false，由调用方决定提示文案。
// ============================================

/**
 * 原子扣除用户积分。
 * @param userId 用户 ID
 * @param amount 扣除积分数（必须 > 0）
 * @returns 是否扣减成功（余额不足 / 用户不存在 / 参数非法返回 false）
 *
 * @example
 * // 配合模型消耗：deductPoints(userId, 该档位对应的积分)
 * const ok = await deductPoints(userId, 100)
 * if (!ok) return error(res, '积分不足')
 */
export async function deductPoints(userId: number, amount: number, executor: DbExecutor = db, bizType = 'consume', bizId = ''): Promise<boolean> {
  if (isSkipPointsEnabled()) return true
  // 参数校验：必须为正数
  if (!Number.isFinite(amount) || amount <= 0) return false

  try {
    // 单条 SQL：仅当 points >= amount 时扣减（原子，防并发超扣）
    const result: any = await executor
      .update(schema.users)
      .set({ points: sql`points - ${amount}`, updatedAt: new Date() })
      .where(and(eq(schema.users.id, userId), gte(schema.users.points, amount)))

    // drizzle-orm/mysql2 的 UPDATE 返回 mysql2 结果数组 [ResultSetHeader, FieldPacket[]]，
    // affectedRows 在 result[0] 上（取错会导致"已扣分但返回 false"）
    const ok = (result?.[0]?.affectedRows ?? 0) > 0
    if (ok) {
      const [u] = await executor.select({ points: schema.users.points }).from(schema.users).where(eq(schema.users.id, userId)).limit(1)
      await writePointsLedger(userId, -amount, u?.points ?? 0, bizType, bizId || `deduct-${Date.now()}`, executor)
    }
    return ok
  } catch (e) {
    console.error('扣除积分失败:', (e as Error)?.message)
    return false
  }
}

// ============================================
// 积分加分工具：原子增加用户积分（生成失败退款等场景）
// ============================================

/**
 * 原子增加用户积分。
 * @param userId 用户 ID
 * @param amount 增加积分数（必须 > 0）
 * @returns 是否成功
 */
export async function addPoints(userId: number, amount: number, executor: DbExecutor = db, bizType = 'refund', bizId = ''): Promise<boolean> {
  if (isSkipPointsEnabled()) return true
  if (!Number.isFinite(amount) || amount <= 0) return false
  try {
    const result: any = await executor
      .update(schema.users)
      .set({ points: sql`points + ${amount}`, updatedAt: new Date() })
      .where(eq(schema.users.id, userId))
    // 同 deductPoints：drizzle-orm/mysql2 的 UPDATE 返回 [ResultSetHeader, FieldPacket[]]，affectedRows 在 result[0]
    const ok = (result?.[0]?.affectedRows ?? 0) > 0
    if (ok) {
      const [u] = await executor.select({ points: schema.users.points }).from(schema.users).where(eq(schema.users.id, userId)).limit(1)
      await writePointsLedger(userId, amount, u?.points ?? 0, bizType, bizId || `add-${Date.now()}`, executor)
    }
    return ok
  } catch (e) {
    console.error('增加积分失败:', (e as Error)?.message)
    return false
  }
}

// ============================================
// 模型积分消耗统一入口：查启用模型 → 原子预扣其价格档位积分
// 价格来自 ai_models.price_config（[{label, value, price}]）：
// 未传档位或未命中档位时视为免费，不扣积分。
// ============================================

type PriceTier = { label?: unknown; value?: unknown; price?: unknown }

/**
 * 解析模型价格（积分）。
 * 匹配顺序：① 传入档位（label 或 value 均可）→ ② 回退到 label 为「默认」的那一行（固定价）
 * → ③ 都没有则不收费（返回 0）。
 * @param model  ai_models 行
 * @param option 档位标识；缺省时只走「默认」兜底
 */
export function resolveModelCost(model: typeof schema.ai_models.$inferSelect, option?: string): number {
  if (isSkipPointsEnabled()) return 0
  const tiers = model.price_config
  if (!Array.isArray(tiers) || !tiers.length) return 0
  const list = tiers as PriceTier[]
  const hit = (option
    ? list.find((tier) => String(tier?.value ?? '') === option || String(tier?.label ?? '') === option)
    : undefined)
    || list.find((tier) => String(tier?.label ?? '').trim() === '默认')
  const price = Number(hit?.price)
  return Number.isFinite(price) && price >= 0 ? Math.floor(price) : 0
}

/**
 * 校验并扣除模型消耗积分（提交任务前调用）。
 * @param userId 用户 ID
 * @param modelId 模型标识（ai_models.model）
 * @param quality 档位标识（模型 price_config 里的 label 或 value）；缺省或未命中「默认」时不扣积分
 * @returns { ok, cost } ok=false 表示模型不存在/已停用/积分不足；cost 为实际扣除的积分数（退款用）
 */
export async function consumeModelPoints(
  userId: number,
  modelId: string,
  contentType?: string,
  quality?: string,
  executor: DbExecutor = db,
  units = 1,
): Promise<{ ok: boolean; cost: number }> {
  if (!Number.isSafeInteger(units) || units < 1) throw new Error('无效计费次数');
  const where = contentType
    ? and(eq(schema.ai_models.model, modelId), eq(schema.ai_models.status, 1), eq(schema.ai_models.content_type, contentType))
    : and(eq(schema.ai_models.model, modelId), eq(schema.ai_models.status, 1))
  const [model] = await executor
    .select()
    .from(schema.ai_models)
    .where(where)
    .limit(1)
  if (!model) return { ok: false, cost: 0 } // 模型不存在或停用
  const cost = resolveModelCost(model, quality) * units;

  // 未配置价格档位、或未命中档位且没有「默认」行：直接放行（不扣积分）
  if (!cost) return { ok: true, cost: 0 }

  const ok = await deductPoints(userId, cost, executor) // 原子扣减积分
  return ok ? { ok: true, cost } : { ok: false, cost: 0 }
}

// ============================================
// 积分流水：所有积分变动写流水表（points_ledger），users.points 仅作汇总缓存
// ============================================
export async function writePointsLedger(
  userId: number,
  change: number,        // 正数入账 / 负数扣减
  balanceAfter: number,  // 变动后余额
  bizType: string,       // recharge/consume/refund/grant
  bizId: string,         // 关联业务 ID（订单号/任务ID）
  executor: DbExecutor = db,
): Promise<void> {
  try {
    await executor.insert(schema.pointsLedger).values({
      userId,
      change,
      balanceAfter,
      bizType,
      bizId,
      createdAt: new Date(),
    } as any)
  } catch (e) {
    console.error('写积分流水失败:', (e as Error)?.message)
  }
}
