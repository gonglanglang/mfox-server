// ============================================
// 通用任务管理器 — 所有流式任务复用
// 使用方式见底部示例
// 任务存储基于 MySQL 任务表（ai_tasks），流式重连订阅基于进程内事件，不再依赖 Redis
// ============================================
import type { Response, Request } from "express";
import crypto from "crypto";
import { EventEmitter } from "events";
import { eq, and, desc, count } from "drizzle-orm";
import { db, schema, type DbExecutor } from "../mysqlDb";
import { createThrottledWriter, consumeModelPoints, addPoints } from "./index";

// ai_tasks 表的查询行类型
type AiTaskRow = typeof schema.ai_tasks.$inferSelect;

// updateTask 的补丁类型（节流写入器数据形状）
export type TaskPatch = {
  status?: "running" | "done" | "failed" | "timeout" | "cancelled";
  result?: string;
  stepsConfig?: string;
  extra?: Record<string, any>;
};

// -------- 类型 --------
export interface TaskCache {
  userId: number;
  taskId: string;
  type: string;
  status: "running" | "done" | "failed";
  router: string;
  createdAt: Date;
  stepsConfig?: string; // 任务时间链（JSON 字符串）
  result?: string; // AI 输出结果全文
  [key: string]: any; // 调用 AI 接口时的输入参数（content/genre/text/workId...）
}

interface StreamGenResult {
  /** 流式迭代器 */
  textStream: AsyncIterable<string>;
}

interface StreamGenFn {
  (task: TaskCache): Promise<StreamGenResult>;
}

// -------- 进程内流式订阅器（替代 Redis pub/sub，单实例内可用） --------
const streamBus = new EventEmitter();
streamBus.setMaxListeners(0); // 不限制监听器数量，避免长连接场景下的告警

/**
 * 向指定任务的所有订阅者推送一条消息（替代 redis.publish(`stream:${taskId}`)）
 */
export function publishTaskStream(taskId: string, msg: string) {
  streamBus.emit("stream", taskId, msg);
}

/**
 * 订阅指定任务的消息流（替代 redis.subscribe），返回取消订阅函数。
 * 所有流式任务重连时通用：快照回显历史后，续订广播直到 DONE。
 * 也供发起请求的路由使用：订阅广播并把消息转写到原始 SSE 连接。
 */
export function subscribeTaskStream(taskId: string, handler: (msg: string) => void): () => void {
  const listener = (t: string, msg: string) => {
    if (t === taskId) handler(msg);
  };
  streamBus.on("stream", listener);
  return () => streamBus.off("stream", listener);
}

// -------- 核心 API --------

/**
 * 创建任务并写入数据库（ai_tasks）
 * 任务不会自动删除，保留在表中供用户手动管理
 * @returns 生成的 taskId + 写入的 task 缓存对象
 */
export async function createTask(
  userId: number,
  type: string,
  extra: Record<string, any> = {},
  executor: DbExecutor = db,
): Promise<{ taskId: string; cache: TaskCache }> {
  const taskId = crypto.randomUUID();
  const now = new Date();
  const { router = "/", stepsConfig, ...rest } = extra;

  await executor.insert(schema.ai_tasks).values({
    taskId, // 任务 ID，唯一标识任务
    userId, // 用户 ID，关联创建任务的用户
    type, // 任务类型，用于区分不同任务（如 "chat"、"work" 等）
    status: "running", // 任务状态，默认运行中
    router: router as string, // 任务路由，用于订阅流式消息
    stepsConfig: stepsConfig ? String(stepsConfig) : null, // 任务时间链（JSON 字符串）
    extra: Object.keys(rest).length ? rest : null, // 任务额外信息（如 content/genre/text/workId 等）
    createdAt: now, // 任务创建时间
    updatedAt: now, // 任务最后更新时间
  } as any);

  const cache: TaskCache = {
    userId,
    taskId,
    type,
    status: "running",
    router: router as string,
    createdAt: now,
    stepsConfig: stepsConfig ? String(stepsConfig) : undefined,
    ...rest,
  };

  return { taskId, cache };
}

/** 创建并计费任务 */
export async function createChargedTask(
  userId: number, type: string, extra: Record<string, any>, model: string, // 模型名称
  contentType?: string, // 输入内容类型（如 "text"、"image" 等）
  cost?: number, // 任务成本，单位：积分
  units = 1,
) {
  return db.transaction(async tx => {
    const charge = await consumeModelPoints(userId, model, contentType, undefined, tx, units);
    if (!charge.ok) return null;
    const task = await createTask(userId, type, { ...extra, cost: charge.cost, model }, tx);
    return { ...task, cost: cost || charge.cost };
  });
}

/**
 * 更新任务的数据库记录（status/result/stepsConfig，extra 为增量合并）
 */
export async function updateTask(
  taskId: string,
  patch: {
    status?: "running" | "done" | "failed" | "timeout" | "cancelled";
    result?: string;
    stepsConfig?: string;
    extra?: Record<string, any>;
  }
) {
  const set: Record<string, any> = { updatedAt: new Date() };
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.result !== undefined) set.result = patch.result;
  if (patch.stepsConfig !== undefined) set.stepsConfig = patch.stepsConfig;
  if (patch.extra !== undefined) {
    const [row] = await db
      .select({ extra: schema.ai_tasks.extra })
      .from(schema.ai_tasks)
      .where(eq(schema.ai_tasks.taskId, taskId))
      .limit(1);
    set.extra = { ...((row?.extra as Record<string, any>) || {}), ...patch.extra };
  }
  await db.update(schema.ai_tasks).set(set).where(eq(schema.ai_tasks.taskId, taskId));
}

/**
 * 执行流式任务并广播进度
 * @param taskId 任务 ID
 * @param cache  任务缓存（会被原地更新）
 * @param res    Express Response（用于 SSE 推送）
 * @param gen    流式生成器函数
 * @param options 可选：onFailed（生成失败时调用，用于积分退款等清理）
 */
export async function runStreamTask(
  taskId: string, // 任务 ID
  cache: TaskCache, // 任务缓存（会被原地更新）
  res: Response, // Express Response（用于 SSE 推送）
  gen: StreamGenFn, // 流式生成器函数，返回 textStream
  options?: { onFailed?: () => Promise<void> | void },
) {
  let fullText = "";
  let failed = false;
  let failedMsg = "";
  // 节流写入器：running 中间态 result 节流落库；最终状态 writeNow 挂链尾（先排空再写，避免乱序覆盖）
  const writer = createThrottledWriter<TaskPatch>(
    (patch) => updateTask(taskId, patch),
    200, // 每 200ms 最多写一次，避免每 token 全量 UPDATE（O(n²)）
  );

  try {
    const runResult = await gen(cache) as any;

    // 遍历流式结果，推送给当前连接，同时广播给重连订阅者并节流实时写库
    for await (const chunk of runResult.textStream) {
      fullText += chunk;
      const msg = JSON.stringify({ token: chunk });
      res.write(`data: ${msg}\n\n`);
      try { publishTaskStream(taskId, msg); } catch { /* 广播失败不影响流 */ }
      process.stdout.write(chunk); // 打印到控制台，方便调试
      writer.push({ result: fullText }); // 节流入队（内部按 200ms 间隔）
    }
  } catch (err: any) {
    // 生成失败：记录错误并标记任务失败（错误信息入库，供列表/重连回显）
    failed = true;
    failedMsg = err?.message || "任务执行失败";
    console.error("runStreamTask 生成失败:", failedMsg);
    const msg = JSON.stringify({ type: "failed", taskId, result: failedMsg, message: failedMsg });
    try {
      res.write(`data: ${msg}\n\n`);
      publishTaskStream(taskId, msg);
    } catch { /* 连接已断开或广播失败，不影响最终状态落库 */ }
    // 失败回调（如积分退款）
    try {
      await options?.onFailed?.();
    } catch { /* 清理回调失败不阻断主流程 */ }
  } finally {
    // 最终状态写挂到链尾，先排空已排队的 running 写，再写最终状态（避免后写覆盖）
    writer.writeNow(failed
      ? { status: "failed", result: failedMsg }
      : { status: "done", result: fullText });
    await writer.flush();
    try { publishTaskStream(taskId, "DONE"); } catch { /* 广播失败不影响流 */ }
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

// ============================================
// Workflow 流消费 —— 抽离各 workflow 路由重复的
// “遍历 fullStream + 步骤状态机落库 + 正文回调 + SSE 转发/广播”样板
// ============================================

/** workflow fullStream 中的一个 chunk（Mastra 事件或正文 token） */
interface WorkflowChunk {
  type?: string;
  chunk?: unknown;
  payload?: { stepName?: string; id?: string; output?: Record<string, any> };
}

export interface WorkflowStreamHandlers {
  /** 正文 token（string 或 { chunk: '文本' }）回调：供调用方累积全文 / 节流落库 */
  onText?: (text: string) => void;
  /** workflow-step-result 回调：捕获副作用（如最终正文）；返回对象则增量并入任务 extra 并写回 cache */
  onStepResult?: (stepName: string, output: Record<string, any>) => Record<string, any> | void;
}

/**
 * 消费 workflow 的单个 fullStream chunk：
 * - 正文 token（string / { chunk: '文本' }）→ 返回其文本（不落库）
 * - workflow-step-start/result → 更新 cache.stepsConfig 中的步骤状态并落库，
 *   result 阶段调用 onStepResult（返回对象会并入任务 extra 与 cache）
 * @returns 正文文本；事件类 chunk 返回 null（已内部落库）
 */
async function syncWorkflowChunk(
  taskId: string,
  cache: TaskCache,
  chunk: unknown,
  onStepResult?: WorkflowStreamHandlers["onStepResult"],
): Promise<string | null> {
  if (typeof chunk === "string") return chunk;
  const c = chunk as WorkflowChunk;
  if (typeof c.chunk === "string") return c.chunk;

  const type = c.type;
  if (type === 'workflow-step-output' && c.payload?.output?.type === 'frame-prompt-progress') {
    const progress = c.payload.output;
    const steps = JSON.parse(cache.stepsConfig || '[]') as Array<{ name: string; label?: string }>;
    const step = steps.find(s => s.name === progress.stepName);
    if (step && typeof progress.label === 'string') {
      step.label = progress.label.slice(0, 180);
      cache.stepsConfig = JSON.stringify(steps);
      await updateTask(taskId, { stepsConfig: cache.stepsConfig });
    }
    return null;
  }
  if (type !== "workflow-step-start" && type !== "workflow-step-result") return null;

  const name = c.payload?.stepName || c.payload?.id || "";
  const steps = JSON.parse(cache.stepsConfig || "[]") as Array<{ name?: string; status?: string }>;
  const step = steps.find((s) => s.name === name);
  if (step) step.status = type === "workflow-step-start" ? "running" : "done";
  cache.stepsConfig = JSON.stringify(steps);

  const patch: TaskPatch = { stepsConfig: cache.stepsConfig };
  if (type === "workflow-step-result") {
    const output = c.payload?.output || {};
    const extra = onStepResult?.(name, output);
    if (extra) {
      Object.assign(cache, extra); // 写回内存 cache，保持原路由里 cache.workId/saved 的语义
      patch.extra = extra; // updateTask 内部增量合并，不清掉其它 extra 字段
    }
  }
  await updateTask(taskId, patch);
  return null;
}

/**
 * 遍历 workflow 的 fullStream，统一“步骤状态机落库 + 正文回调 + SSE 转发/广播”。
 * 转发规则（各 chunk 与 workflow 内部步骤的 token 走同一广播通道）：
 * - 传入 res → 每个 chunk 同时写 SSE 并广播（当前请求直发模式，如 /character-extract）
 * - 不传 res → 仅广播，由路由侧 subscribeTaskStream 转写到 SSE（如 /ainovel/workflows，
 *   因为其正文 token 由 workflow 步骤内部自行 publish，必须依赖订阅转发）
 */
export async function consumeWorkflowStream(
  taskId: string,
  cache: TaskCache,
  fullStream: AsyncIterable<unknown>,
  res?: Response,
  handlers: WorkflowStreamHandlers = {},
): Promise<void> {
  for await (const chunk of fullStream) {
    const text = await syncWorkflowChunk(taskId, cache, chunk, handlers.onStepResult);
    if (text !== null) handlers.onText?.(text);
    const msg = JSON.stringify(chunk);
    try {
      if (res) res.write(`data: ${msg}\n\n`);
      publishTaskStream(taskId, msg);
    } catch { /* 连接已断开或广播失败，不影响流 */ }
  }
}

/**
 * 任务分页结果（page/pageSize 模式）
 */
export interface TaskPageResult {
  list: TaskCache[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 获取用户任务列表（按创建时间倒序）
 * - 不传分页参数：返回全量数组（NavBar 轮询 / 任务恢复依赖全量）
 * - 传入 page/pageSize：返回分页结果 { list, total, page, pageSize }
 */
export async function getUserTasks(
  userId: number,
  page?: number,
  pageSize?: number,
): Promise<TaskCache[] | TaskPageResult> {
  // 未传分页参数：保持全量返回（向后兼容）
  if (page === undefined && pageSize === undefined) {
    const rows = await db
      .select()
      .from(schema.ai_tasks)
      .where(eq(schema.ai_tasks.userId, userId))
      .orderBy(desc(schema.ai_tasks.createdAt));
    return rows.map(rowToCache);
  }

  // 兜底校验：非数字 / 越界值时用默认值，避免 limit/offset 收到 NaN
  const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page as number)) : 1;
  const safePageSize = Number.isFinite(pageSize)
    ? Math.min(50, Math.max(1, Math.floor(pageSize as number)))
    : 10;

  const [totalRow] = await db
    .select({ count: count() })
    .from(schema.ai_tasks)
    .where(eq(schema.ai_tasks.userId, userId));
  const total = totalRow?.count ?? 0;

  const rows = await db
    .select()
    .from(schema.ai_tasks)
    .where(eq(schema.ai_tasks.userId, userId))
    .orderBy(desc(schema.ai_tasks.createdAt))
    .limit(safePageSize)
    .offset((safePage - 1) * safePageSize);

  return {
    list: rows.map(rowToCache),
    total,
    page: safePage,
    pageSize: safePageSize,
  };
}

/**
 * 删除指定任务
 */
export async function removeTask(userId: number, taskId: string) {
  await db
    .delete(schema.ai_tasks)
    .where(and(eq(schema.ai_tasks.userId, userId), eq(schema.ai_tasks.taskId, taskId)));
}

/**
 * 订阅已有任务流（重连用）
 * @param taskId 任务 ID
 * @param userId 用户 ID（验证归属）
 * @param res    Express Response
 */
export async function subscribeTask(
  req: Request,
  taskId: string,
  userId: number,
  res: Response
) {
  try {
    const [row] = await db
      .select()
      .from(schema.ai_tasks)
      .where(eq(schema.ai_tasks.taskId, taskId))
      .limit(1);
    if (!row) return res.status(404).json({ message: "任务不存在" });

    if (row.userId !== userId)
      return res.status(403).json({ message: "无权访问" });

    if (row.status === "done") {
      // 已完成任务：以 SSE 格式返回完成信号 + 结果。
      // 前端在“列表仍为 running 但后端已完成”的刷新竞态下重连到这里时，
      // 若返回普通 JSON，fetchEventSource 解析不出事件，onDone 永不触发 → 加载状态卡死。
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.write(`data: ${JSON.stringify({ type: "done", taskId, result: row.result ?? "" })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    if (row.status === "failed") {
      // 失败任务：同样以 SSE 完成信号结束，避免重连挂起；携带错误信息供前端回显
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.write(`data: ${JSON.stringify({ type: "failed", taskId, result: row.result ?? "任务执行失败" })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");

    // 惰性超时检测：running 任务 updatedAt 超过阈值视为超时，标记 timeout 并退款（addPoints 自动写 refund 流水）
    const TIMEOUT_MS = 30 * 60 * 1000 // 30 分钟；视频类长任务可按类型再放宽
    if (Date.now() - new Date(row.updatedAt).getTime() > TIMEOUT_MS) {
      const cost = Number((row.extra as Record<string, unknown> | null)?.cost) || 0
      if (cost > 0) await addPoints(row.userId, cost, db, 'refund', row.taskId)
      await updateTask(taskId, { status: 'timeout', result: '任务执行超时，积分已退回' })
      res.write(`data: ${JSON.stringify({ type: 'timeout', taskId, result: '任务执行超时，积分已退回' })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return
    }

    // 全局通用重连：先回显当前快照（result / stepsConfig 已实时落库），
    // 再保持长连接续订进程内广播，直到收到 DONE。
    const snapshot: Record<string, unknown> = {
      type: "running",
      taskId,
      result: row.result ?? "",
      stepsConfig: row.stepsConfig ?? "",
    };
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    const unsubscribe = subscribeTaskStream(taskId, (msg) => {
      if (msg === "DONE") {
        res.write("data: [DONE]\n\n");
        res.end();
        unsubscribe();
        return;
      }
      res.write(`data: ${msg}\n\n`);
    });
    req.on("close", unsubscribe);
  } catch (err: any) {
    // 数据库或其他基础设施故障时，返回明确错误而非 500
    console.error('subscribeTask 订阅失败:', err.message);
    if (!res.headersSent) {
      res.status(503).json({ message: '服务暂时不可用，请稍后刷新重试' });
    }
  }
}

// -------- 内部工具 --------

/** 数据库行 → 任务缓存对象（展开 extra 字段，兼容现有代码直接访问 task.genre/task.content 等） */
function rowToCache(row: AiTaskRow): TaskCache {
  const { extra, ...base } = row as any;
  return { ...base, ...(extra || {}) };
}
