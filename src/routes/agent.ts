import { resolveVideoModel } from '../videoTools/model-config';
import { createFrameVideoTask, settleFrameVideoTask, resetStuckVideoTask } from '../tools/frame-video-task';
import express, { type response } from "express";
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, schema } from "../mysqlDb/index";
import { success, error } from "../tools/response";
import { mastra } from "../mastra/index";
import { authMiddleware } from "../middleware/auth";
import { createTask, createChargedTask, runStreamTask, getUserTasks, removeTask, subscribeTask, updateTask, publishTaskStream, subscribeTaskStream, consumeWorkflowStream, type TaskPatch } from "../tools/taskManager";
import { RequestContext } from "@mastra/core/request-context";
import { validateRequestSSE, validateRequest } from "../middleware/validate";
import { consumeModelPoints, addPoints, createThrottledWriter } from "../tools/index";
import { sseError } from "../tools/sse";
import { beginFrameRedraw, settleFrameRedraw, quoteFrameRedraw, type FrameRedrawMode } from '../tools/frame-redraw-job';
import { uploadBufferToOSS } from '../config/oss.config';
import { composeVideos, resolveOutputSize, extractVideoLastFrameBuffer, type ComposeSegment } from '../tools/video-compose';
import { recordShotAssetVersion } from '../pipeline/shot-assets-store';
import { assignPanelFrame } from '../tools/frame-pool';
import { resolveStoryboardPanel } from '../tools/storyboard-panel';
import { normalizeShotLink } from '../tools/storyboard-text';
import { enrichChapterContinuity } from '../tools/shot-continuity';
import { decideShotTransitions, syncContinuityAndTransitionsToDb } from '../tools/transition-decision';
import { inspectVideoQuality, saveQcRecordsToDb } from '../tools/video-qc';

const app = express();
const activeExtractChapters = new Set<number>();
const activeBreakdownChapters = new Set<number>();
const activeComposeChapters = new Set<number>();

function taskErrorMessage(err: any, fallback = "任务执行失败") {
  const dataMessage = err?.data?.error?.message;
  if (typeof dataMessage === "string" && dataMessage.trim()) return dataMessage;
  if (typeof err?.responseBody === "string") {
    try {
      const parsed = JSON.parse(err.responseBody);
      if (parsed?.error?.message) return parsed.error.message;
    } catch { /* ignore */ }
  }
  return err?.message || fallback;
}

async function failSseTask(taskId: string, res: any, message: string) {
  const payload = { type: "failed", taskId, result: message, message };
  try { await updateTask(taskId, { status: "failed", result: message }); } catch { /* 数据库不可用时静默跳过 */ }
  try { publishTaskStream(taskId, JSON.stringify(payload)); } catch { /* 广播失败不影响当前连接 */ }
  try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* 连接可能已断开 */ }
}

/**
 * 结算重试：瞬时数据库故障不能让分镜停在 generating 且不退费。
 * 若重试仍失败，遗留的 charged run 会在用户下一次提交时被 beginFrameRedraw 自动接管并退款。
 */
async function settleFrameRedrawWithRetry(input: Parameters<typeof settleFrameRedraw>[0], attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await settleFrameRedraw(input)
    } catch (err: any) {
      if (attempt === attempts) throw err
      console.warn(`分镜重绘结算第 ${attempt} 次失败，${attempt}s 后重试：${err?.message}`)
      await new Promise(resolve => setTimeout(resolve, attempt * 1000))
    }
  }
}

// ============================================
// 获取服务商配置列表（脱敏）
// 注意：该接口原先既无鉴权又返回 api_key，等于对外公开所有供应商密钥。
// 现在要求登录，并且只返回非敏感字段，密钥永不下发到客户端。
// ============================================
app.get("/", authMiddleware, async (_req, res) => {
  const result = await db.select({
    id: schema.ai_service_configs.id,
    provider: schema.ai_service_configs.provider,
    name: schema.ai_service_configs.name,
    api_url: schema.ai_service_configs.api_url,
    sort_order: schema.ai_service_configs.sort_order,
  }).from(schema.ai_service_configs);
  return success(res, result);
});

// ============================================
// 小说润色（流式 SSE）
// ============================================
app.post("/polish/stream", authMiddleware, async (req, res) => {
  const { error } = validateRequestSSE(req, res, {
    content: { from: 'body', required: true, label: '润色思路', trim: true },
    genre: { from: 'body', required: true, label: '题材' },
    pov: { from: 'body', required: true, label: '视角' },
    audience: { from: 'body', required: true, label: '目标读者' },
    aiModel: { from: 'headers', required: true, label: '模型' },
  })
  if (error) return // 已中断 SSE，无需再处理

  const { content, genre, pov, audience } = req.body;
  const { 'aimodel': aiModel } = req.headers;

  // 预扣模型消耗积分（提交任务前）：模型不存在/停用/积分不足 → 直接拦截
  const { ok, cost } = await consumeModelPoints(req.user?.id as number, aiModel as string);
  if (!ok) return sseError(res, '积分不足，请先充值');

  // 获取用户选择的模型信息
  const requestContext = new RequestContext();
  requestContext.set('aiModel', aiModel)

  // 创建任务
  const { taskId, cache } = await createTask(req.user?.id as number, 'polish', {
    description: content, // 小说描述
    genre, // 小说题材
    pov, // 小说视角
    audience, // 目标读者
  });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.write(`data: ${JSON.stringify({ type: "task", taskId })}\n\n`);

  // 运行任务
  await runStreamTask(taskId, cache, res, async (task) => {
    const agent = mastra?.getAgent("PolishNovelAgent");
    const prompt = JSON.stringify({
      audience, // 目标读者
      description: content, // 小说描述
      genre, // 小说题材
      pov, // 小说视角
    })

    return await agent!.stream(prompt, {
      requestContext,
    })
  }, {
    // 生成失败：退回预扣的积分
    onFailed: async () => {
      if (cost > 0) await addPoints(req.user?.id as number, cost)
    },
  });
});

// ============================================
// AI 小说生成工作流
// ============================================
app.post("/ainovel/workflows", authMiddleware, async (req, res) => {
  const { error } = validateRequestSSE(req, res, {
    description: { from: 'body', required: true, label: '作品简介', trim: true },
    type: { from: 'body', required: true, label: '任务类型' },
    length: { from: 'body', required: true, label: '长度' },
    audience: { from: 'body', required: true, label: '目标读者' },
    pov: { from: 'body', required: true, label: '视角' },
    stepsConfig: { from: 'body', required: true, label: '步骤配置' },
    genre: { from: 'body', required: true, label: '题材' },
    workId: { from: 'body', required: false, label: '已有作品ID' },
    volumeId: { from: 'body', required: false, label: '已有卷ID' },
    previousChapterId: { from: 'body', required: false, label: '上一章章节ID' },
    previousVolumeId: { from: 'body', required: false, label: '上一章所在卷ID' },
    aiModel: { from: 'headers', required: true, label: '模型' },
  })
  if (error) return // 已中断 SSE，无需再处理
  const { description, type, length, audience, pov, stepsConfig, genre, workId, volumeId, previousChapterId, previousVolumeId } = req.body;
  const { 'aimodel': aiModel } = req.headers;

  // 预扣模型消耗积分（提交任务前）：模型不存在/停用/积分不足 → 直接拦截
  const { ok, cost } = await consumeModelPoints(req.user?.id as number, aiModel as string);
  if (!ok) return sseError(res, '积分不足，请先充值');

  // 获取用户选择的模型信息
  const requestContext = new RequestContext();
  requestContext.set('aiModel', aiModel)

  const prompt = {
    userId: req.user?.id as number, // 用户ID
    description,// 作品简介
    type, // 任务类型
    audience, // 目标受众
    pov, // 视角
    length, // 长度
    router: "/write", // 路由
    genre, // 题材风格
    stepsConfig: stepsConfig || '[]', // 步骤配置
    workId: workId || undefined, // 已有作品ID（新卷章模式：跳过创建作品）
    volumeId: volumeId || undefined, // 已有卷ID（生成下一章模式：跳过创建卷）
    previousChapterId: previousChapterId || undefined, // 上一章章节ID（内部查询上一章内容）
    previousVolumeId: previousVolumeId || undefined, // 上一章所在卷ID
    requestContext, // 请求上下文
  };

  // 创建任务
  const { taskId, cache } = await createTask(req.user?.id as number, "aiNovel", prompt);
  (prompt as any).taskId = taskId;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.write(`data: ${JSON.stringify({ type: "task", taskId })}\n\n`);

  // 订阅本任务广播：把 workflow 事件和正文 token 转写到当前 SSE 连接
  const unsubscribe = subscribeTaskStream(taskId, (msg) => {
    if (msg === "DONE") return
    try { res.write(`data: ${msg}\n\n`) } catch { /* 原始连接已断开，忽略 */ }
  });
  req.on("close", unsubscribe);

  let fullText = "";
  let finalContent = "";
  // 节流实时落库：刷新重连的快照可回显已生成部分
  const writer = createThrottledWriter<TaskPatch>(
    (patch) => updateTask(taskId, patch),
    200,
  );

  try {
    // 传了 volumeId：在当前卷下续写下一章；否则新建卷章
    const workflow = mastra?.getWorkflow(volumeId ? "NovelChapterWorkFlow" : "NovelOutLineWorkFlow");
    const run = await workflow.createRun();
    const stream = run.stream({
      inputData: prompt as any // 输入数据
    });

    // 消费 fullStream：步骤状态机落库 + 广播
    await consumeWorkflowStream(taskId, cache, stream.fullStream, undefined, {
      onText: (text) => {
        fullText += text;
        if (fullText) writer.push({ result: fullText });
      },
      onStepResult: (name, output) => {
        // 捕获步骤产出的最终正文，供 finally 写最终 result
        if (name === 'generate-chapter-content' && output?.content) finalContent = output.content
        // 保存 workId 到任务表（extra 增量合并），恢复时可回显
        return output?.workId !== undefined ? { workId: output.workId } : undefined
      },
    });
  } finally {
    unsubscribe();
    // 最终状态写挂链尾（先排空 running 写）；result 以步骤产出的最终正文为准（避免空串覆盖）
    const finalText = finalContent || fullText
    writer.writeNow({ status: "done", result: finalText });
    await writer.flush();
    try { publishTaskStream(taskId, "DONE"); } catch { /* 广播失败不影响流 */ }
    res.write("data: [DONE]\n\n");
    res.end();
  }
});

// ============================================
// AI 提取角色信息工作流（时间链）
// ============================================
app.post("/character-extract", authMiddleware, async (req, res) => {
  const { error } = validateRequestSSE(req, res, {
    text: { from: 'body', required: true, label: '章节内容', trim: true },
    workId: { from: 'body', required: true, label: '作品ID' },
    chapterId: { from: 'body', required: true, label: '章节ID' },
    aiModel: { from: 'headers', required: true, label: '模型' },
  })
  if (error) return // 已中断 SSE，无需再处理

  const { text, workId, chapterId } = req.body;
  const assetType = req.body.assetType ?? 'all';
  if (!['all', 'persona', 'scene', 'prop'].includes(assetType)) return sseError(res, '无效素材类型');
  const extractChapterId = Number(chapterId);
  const extractWorkId = Number(workId);
  const [extractChapter] = await db.select({ id: schema.chapters.id }).from(schema.chapters)
    .where(and(eq(schema.chapters.id, extractChapterId), eq(schema.chapters.work_id, extractWorkId),
      eq(schema.chapters.user_id, req.user!.id), isNull(schema.chapters.deleted_at))).limit(1);
  if (!extractChapter) return sseError(res, '章节不存在');
  if (activeExtractChapters.has(extractChapterId)) return sseError(res, '当前章节正在提取素材中，请勿重复提交');
  const workflowName = assetType === 'persona' ? 'personaExtractWorkflow'
    : assetType === 'scene' ? 'sceneExtractWorkflow'
      : assetType === 'prop' ? 'propExtractWorkflow' : 'characterExtractWorkflow';
  const { 'aimodel': aiModel } = req.headers;

  // 模型选择透传：workflow 内 agent 通过 requestContext 读取 aiModel
  const requestContext = new RequestContext();
  requestContext.set('aiModel', aiModel);

  const taskData: any = {
    userId: req.user?.id as number,
    text, workId, chapterId, assetType,
    router: "/video-storyboard",
    stepsConfig: JSON.stringify([
      { name: "extract-characters", label: "AI 提取角色", icon: "🔍", status: "pending" },
      { name: "save-characters", label: "创建角色素材", icon: "💾", status: "pending" },
      { name: "extract-scene", label: "AI 提取场景", icon: "🎬", status: "pending" },
      { name: "save-scenes", label: "创建场景素材", icon: "🏞️", status: "pending" },
      { name: "extract-props", label: "AI 提取道具", status: "pending" },
      { name: "save-props", label: "创建道具素材", status: "pending" },
    ]),
    requestContext,
  };

  if (assetType !== 'all') {
    const names = assetType === 'persona' ? ['extract-characters', 'save-characters']
      : assetType === 'scene' ? ['extract-scene', 'save-scenes'] : ['extract-props', 'save-props'];
    const steps = JSON.parse(taskData.stepsConfig).filter((step: { name: string }) => names.includes(step.name));
    if (assetType !== 'persona') steps.unshift({ name: 'load-asset-context', label: '读取已有素材', status: 'pending' });
    taskData.stepsConfig = JSON.stringify(steps);
  }
  const task = await createChargedTask(req.user?.id as number, "characterExtract", taskData, aiModel as string, 'text', undefined, assetType === 'all' ? 3 : 1);
  if (!task) return sseError(res, '模型不可用或积分不足');
  activeExtractChapters.add(extractChapterId);
  const { taskId, cache } = task;
  const cost = task.cost;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.write(`data: ${JSON.stringify({ type: "task", taskId })}\n\n`);

  let failed = false;
  try {
    const workflow: any = mastra?.getWorkflow(workflowName);
    const run = await workflow.createRun();
    const stream = run.stream({ inputData: taskData });

    // 消费 fullStream：步骤状态机落库 + 实时转发（res 直写 + 广播，供刷新重连续播）
    await consumeWorkflowStream(taskId, cache, stream.fullStream, res, {
      // step-result 输出含 saved（角色素材ID）时并入 extra，恢复时可回显
      onStepResult: (_name, output) =>
        output?.saved !== undefined ? { saved: output.saved } : undefined,
    });
    const result = await stream.result;
    if (result.status !== 'success') throw new Error('素材提取未完成，请查看失败步骤');
  } catch (e: any) {
    failed = true;
    const message = taskErrorMessage(e, '素材提取失败');
    console.error('角色提取失败:', message);
    await failSseTask(taskId, res, message);
    // 生成失败：退回预扣的积分
    if (cost > 0) { try { await addPoints(req.user?.id as number, cost) } catch { /* 退款失败不阻断 */ } }
  } finally {
    if (!failed) {
      try { await updateTask(taskId, { status: "done" }); } catch { /* 数据库不可用时静默跳过 */ }
    }
    activeExtractChapters.delete(extractChapterId);
    try { publishTaskStream(taskId, "DONE"); } catch { /* 广播失败不影响流 */ }
    res.write("data: [DONE]\n\n");
    res.end();
  }
});

// ============================================
// AI 分镜拆分工作流
// ============================================
app.post("/storyboard-breakdown", authMiddleware, async (req, res) => {
  const { error: validateError } = validateRequestSSE(req, res, {
    text: { from: 'body', required: true, label: '章节内容', trim: true },
    chapterId: { from: 'body', required: true, label: '章节ID' },
    workId: { from: 'body', required: true, label: '作品ID' },
    aiModel: { from: 'headers', required: true, label: '模型' },
  })
  if (validateError) return

  const { text, chapterId, workId } = req.body;
  const [chapter] = await db.select({ id: schema.chapters.id }).from(schema.chapters)
    .where(and(eq(schema.chapters.id, chapterId), eq(schema.chapters.work_id, workId),
      eq(schema.chapters.user_id, req.user!.id))).limit(1);
  if (!chapter) return sseError(res, '章节不存在');
  const breakdownChapterId = Number(chapterId);
  if (activeBreakdownChapters.has(breakdownChapterId)) return sseError(res, '当前章节正在拆解分镜中，请勿重复提交');
  const { 'aimodel': aiModel } = req.headers;

  const requestContext = new RequestContext();
  requestContext.set('aiModel', aiModel);

  const taskData: any = {
    userId: req.user?.id as number,
    text,
    chapterId,
    workId,
    router: "/video-storyboard",
    stepsConfig: JSON.stringify([
      { name: "write-chapter-script-step", label: "章节剧本化改写中...", status: "pending" },
      { name: "extract-novel-script-step", label: "提取小说剧本中...", status: "pending" },
      { name: "save-novel-script-step", label: "保存剧本中...", status: "pending" },
    ]),
    requestContext,
  };
  // 保存枚举值到任务表，恢复时可回显
  const task = await createChargedTask(req.user?.id as number, "novelScript", taskData, aiModel as string, 'text');
  if (!task) return sseError(res, '模型不可用或积分不足');
  activeBreakdownChapters.add(breakdownChapterId);
  const { taskId, cache, cost } = task;
  // 发送任务 ID 到客户端
  res.setHeader("Content-Type", "text/event-stream"); res.setHeader("Cache-Control", "no-cache");
  res.write(`data: ${JSON.stringify({ type: "task", taskId })}\n\n`);


  let failed = false;
  try {
    const workflow: any = mastra?.getWorkflow("NovelScriptWorkflow");
    const run = await workflow.createRun();
    // 消费 fullStream：步骤状态机落库 + 实时转发（res 直写 + 广播）
    const stream = run.stream({ inputData: taskData });
    await consumeWorkflowStream(taskId, cache, stream.fullStream, res);
    const workflowResult = await stream.result;
    if (workflowResult.status !== 'success' || workflowResult.result?.saved !== true) {
      const reason = workflowResult.error?.message || Object.values(workflowResult.steps || {})
        .map((step: any) => step?.error?.message).find(Boolean);
      throw new Error(reason || '分镜提取或保存失败，请检查素材关联或返回格式');
    }
  } catch (e: any) {
    failed = true;
    const message = taskErrorMessage(e, '剧本提取失败');
    console.error('剧本提取失败:', message);
    await failSseTask(taskId, res, message);
    if (cost > 0) { try { await addPoints(req.user?.id as number, cost) } catch { /* 退款失败不阻断 */ } }
  } finally {
    if (!failed) {
      try {
        await updateTask(taskId, { status: "done" });
      } catch { /* 数据库不可用时静默跳过 */ }
    }
    activeBreakdownChapters.delete(breakdownChapterId);
    try { publishTaskStream(taskId, "DONE"); } catch { /* 广播失败不影响流 */ }
    res.write("data: [DONE]\n\n"); res.end();
  }
});

// ============================================
// AI 重绘分镜工作流（异步非阻塞 — 每个分镜独立状态）
// ============================================
app.post('/frame-redraw/quote', authMiddleware, async (req, res) => {
  const { workId, chapterId, panelIdx, resolution, quality, frameMode } = req.body;
  const imageModel = req.headers.aimodel;
  // 档位键：resolution 为新字段，quality 兼容旧客户端
  const tier = String(resolution || quality || '').trim();
  if (![workId, chapterId].every(id => Number.isInteger(id) && id > 0)
    || !Number.isInteger(panelIdx) || panelIdx < 0 || typeof imageModel !== 'string'
    || !tier) return error(res, '请求参数无效');
  try {
    let resolvedFrameMode: FrameRedrawMode | undefined = ['single', 'dual', 'video_tail'].includes(String(frameMode))
      ? (frameMode as FrameRedrawMode)
      : undefined;
    if (!resolvedFrameMode) {
      const [work] = await db.select({ frameMode: schema.works.frame_mode }).from(schema.works).where(eq(schema.works.id, workId)).limit(1);
      if (work?.frameMode && ['single', 'dual', 'video_tail'].includes(String(work.frameMode))) {
        resolvedFrameMode = work.frameMode as FrameRedrawMode;
      } else {
        resolvedFrameMode = 'single';
      }
    }
    return success(res, await quoteFrameRedraw({
      userId: req.user!.id, workId, chapterId, panelIdx, resolution: tier, imageModel, frameMode: resolvedFrameMode,
    }));
  } catch (err: any) { return error(res, err.message || '查询重绘积分失败'); }
});

app.post("/frame-redraw", authMiddleware, async (req, res) => {
  const { error: validateError } = validateRequest(req, {
    workId: { from: 'body', required: true, label: '作品ID' },
    chapterId: { from: 'body', required: true, label: '章节ID' },
    panelIdx: { from: 'body', required: true, label: '分镜索引' },
    styleId: { from: 'body', required: true, label: '图风格ID' },
    resolution: { from: 'body', required: true, label: '图片档位' },
    aiModel: { from: 'headers', required: true, label: '图片模型' },
  })
  if (validateError) return

  const { workId, chapterId, panelIdx, styleId, resolution, expectedCost, frameMode } = req.body;
  const model = req.headers.aimodel;
  if (![workId, chapterId, panelIdx, styleId].every(Number.isInteger) || panelIdx < 0 || workId <= 0 || chapterId <= 0 || styleId <= 0)
    return error(res, '请求参数无效');
  if (typeof model !== 'string' || !model) return error(res, '请选择图片模型');

  if (typeof resolution !== 'string' || !resolution.trim()
    || typeof expectedCost !== 'number' || !Number.isFinite(expectedCost) || expectedCost < 0)
    return error(res, '请求参数无效');

  const workflow: any = mastra?.getWorkflow("frameRedrawWorkflow");
  if (!workflow) return error(res, "工作流未初始化");

  try {
    let resolvedFrameMode: FrameRedrawMode | undefined = ['single', 'dual', 'video_tail'].includes(String(frameMode))
      ? (frameMode as FrameRedrawMode)
      : undefined;
    if (!resolvedFrameMode) {
      const [work] = await db.select({ frameMode: schema.works.frame_mode }).from(schema.works).where(eq(schema.works.id, workId)).limit(1);
      if (work?.frameMode && ['single', 'dual', 'video_tail'].includes(String(work.frameMode))) {
        resolvedFrameMode = work.frameMode as FrameRedrawMode;
      } else {
        resolvedFrameMode = 'single';
      }
    }
    const job = await beginFrameRedraw({
      userId: req.user!.id, workId, chapterId, panelIdx,
      imageModel: model, resolution, expectedCost, frameMode: resolvedFrameMode,
    });

    const inputData = {
      userId: req.user!.id, workId, chapterId, panelIdx, styleId, model, resolution,
      runId: job.runId,
    };

    void (async () => {
      let failure: string | undefined;
      try {
        const run = await workflow.createRun();
        const stream = run.stream({ inputData });
        for await (const _chunk of stream.fullStream) { /* workflow 自行写入分镜数据 */ }
        const result = await stream.result;
        if (result.status !== 'success') throw new Error(taskErrorMessage(result.error, '分镜重绘失败'));
      } catch (err: any) {
        failure = taskErrorMessage(err, '分镜重绘失败');
        console.error('frame-redraw workflow 后台执行失败:', failure);
      }
      await settleFrameRedrawWithRetry({ userId: req.user!.id, chapterId, panelIdx, runId: job.runId, failure });
    })().catch(err => console.error('分镜重绘结算失败:', err.message));

    return success(res, { panelIdx, cost: job.cost, runId: job.runId }, "已开始生成");
  } catch (err: any) {
    return error(res, err.message || '创建分镜重绘失败');
  }
});

// ============================================
// AI 生成分镜视频工作流（异步非阻塞 — TTS + Seedance）
// ============================================
app.post("/frame-video", authMiddleware, async (req, res) => {
  const { chapterId, panelIdx, narrationVoiceId, quality, resolution, workId } = req.body;
  const model = req.headers.aimodel;
  if (!Number.isInteger(chapterId) || chapterId <= 0 || !Number.isInteger(panelIdx) || panelIdx < 0)
    return error(res, "无效章节或分镜索引");
  if (typeof model !== 'string' || !model) return error(res, '请选择视频模型');
  if (quality != null && typeof quality !== 'string') return error(res, '无效视频质量');
  if (resolution != null && typeof resolution !== 'string') return error(res, '无效视频分辨率');
  if (narrationVoiceId != null && (!Number.isInteger(narrationVoiceId) || narrationVoiceId <= 0))
    return error(res, '无效旁白音色');
  const workflow: any = mastra?.getWorkflow("frameVideoWorkflow");
  if (!workflow) return error(res, "工作流未初始化");


  try {
    // 校验模型与档位，并把前端传来的 label/value 归一成供应商取值（计费键与请求体共用）
    const resolved = await resolveVideoModel(model, resolution || quality);
    const task = await createFrameVideoTask(req.user!.id, chapterId, panelIdx, model,
      undefined, resolved.resolutionValue || undefined, Number(workId) || undefined);
    void (async () => {
      let failure: string | undefined;
      try {
        const run = await workflow.createRun();

        const inputData = {
          chapterId, userId: req.user!.id, panelIdx, workId,
          narrationVoiceId: narrationVoiceId ?? null,
          // 归一后的档位取值（供应商可接受），请求体与计费键保持一致
          model, resolution: resolved.resolutionValue || undefined,
        };
        console.log('frame-video inputData:', inputData);
        const stream = run.stream({
          inputData,
        });
        for await (const _chunk of stream.fullStream) { /* 工作流同步分镜状态 */ }
        const workflowResult = await stream.result;
        if (workflowResult.status !== 'success') {
          throw new Error(taskErrorMessage(workflowResult.error, '分镜视频生成失败'));
        }
      } catch (err: any) {
        console.error('frame-video workflow 后台执行失败:', err);
        failure = taskErrorMessage(err, '分镜视频生成失败');
      }
      await settleFrameVideoTask(task.taskId, failure);
    })().catch(err => console.error('视频任务结算失败:', err.message));
    return success(res, { panelIdx, taskId: task.taskId }, "已开始生成视频");
  } catch (err: any) {
    return error(res, err.message || '创建视频任务失败');
  }
});

// ============================================
// 章节成品合成（异步非阻塞：分镜视频重编码拼接 + 场景转场）
// 参与规则与「分镜视频」一致：只要分镜生成了视频就能参与合成（场景最后一个镜头同样有独立成片）。
// ============================================
const COMPOSE_RESOLUTIONS = ['720p', '1080p', '4K'];
const COMPOSE_FPS = [24, 30, 60];

app.post("/compose", authMiddleware, async (req, res) => {
  const userId = req.user?.id as number;
  const workId = Number(req.body?.workId);
  const chapterId = Number(req.body?.chapterId);
  const resolution = String(req.body?.resolution || '1080p');
  const fps = Number(req.body?.fps || 30);
  if (!Number.isSafeInteger(workId) || workId <= 0 || !Number.isSafeInteger(chapterId) || chapterId <= 0)
    return error(res, '请求参数无效');
  if (!COMPOSE_RESOLUTIONS.includes(resolution)) return error(res, '无效的分辨率档位');
  if (!COMPOSE_FPS.includes(fps)) return error(res, '无效的帧率');

  try {
    const [chapter] = await db.select().from(schema.chapters).where(and(
      eq(schema.chapters.id, chapterId), eq(schema.chapters.work_id, workId), eq(schema.chapters.user_id, userId),
    ));
    if (!chapter) return error(res, '章节不存在');
    if (activeComposeChapters.has(chapterId)) return error(res, '当前章节正在合成视频中，请稍候');
    const [work] = await db.select({ aspectRatio: schema.works.aspect_ratio }).from(schema.works)
      .where(eq(schema.works.id, workId)).limit(1);

    const configs = Array.isArray(chapter.content_configs) ? chapter.content_configs as any[] : [];
    /** 候选段：panelIdx 与前端展平后的下标一致（勾选即按它传递） */
    type ComposeCandidate = {
      panelIdx: number; label: string; url: string; sceneIdx: number
      /** 镜头级切换方式（本镜 → 下一镜）；为空时按场景级兜底 */
      shotTransition: string
      /** 本镜与上一镜的衔接类型（continuous / cut / transition） */
      linkType: 'continuous' | 'cut' | 'transition'
      /** 不可合成的原因；undefined 表示可选 */
      blocked?: 'no-video'
    };
    const BLOCKED_MESSAGE: Record<'no-video', string> = {
      'no-video': '还没有生成视频',
    };
    const candidates: ComposeCandidate[] = [];
    let flatIdx = 0;
    for (let sceneIdx = 0; sceneIdx < configs.length; sceneIdx++) {
      const scene = configs[sceneIdx];
      if (!Array.isArray(scene?.shots)) {
        // 旧扁平结构没有场景概念，不套用"最后一镜"规则
        const panelIdx = flatIdx++;
        const url = String(scene?.finalVideoUrl || '');
        candidates.push({
          panelIdx, label: `V-${String(panelIdx + 1).padStart(2, '0')}`, url, sceneIdx,
          // 旧扁平结构没有镜头层级，切换方式即自身字段
          shotTransition: String(scene?.transition_out || scene?.transition || ''),
          linkType: normalizeShotLink(scene).type,
          ...(url ? {} : { blocked: 'no-video' as const }),
        });
        continue;
      }
      for (let shotIdx = 0; shotIdx < scene.shots.length; shotIdx++) {
        const panelIdx = flatIdx++;
        const shot = scene.shots[shotIdx];
        const url = String(shot?.finalVideoUrl || '');
        candidates.push({
          panelIdx, label: `V-${String(panelIdx + 1).padStart(2, '0')}`, url, sceneIdx,
          shotTransition: String(shot?.transition_out || shot?.transition || ''),
          linkType: normalizeShotLink(shot).type,
          ...(url ? {} : { blocked: 'no-video' as const }),
        });
      }
    }

    // 勾选合成：只合成请求里指定的分镜；未指定时保持原行为（合成全部就绪的段）
    const requested: number[] | null = Array.isArray(req.body?.panelIdxes)
      ? req.body.panelIdxes.map((value: unknown) => Number(value))
      : null;
    let chosen: ComposeCandidate[];
    if (requested) {
      const wanted = [...new Set(requested.filter(value => Number.isSafeInteger(value) && value >= 0))];
      if (!wanted.length) return error(res, '请至少勾选一个分镜');
      const byIdx = new Map(candidates.map(candidate => [candidate.panelIdx, candidate]));
      const unknown = wanted.filter(idx => !byIdx.has(idx));
      if (unknown.length) return error(res, `勾选的分镜不存在：${unknown.map(idx => `V-${idx + 1}`).join('、')}`);
      const blocked = wanted.map(idx => byIdx.get(idx)!).filter(candidate => candidate.blocked);
      if (blocked.length) {
        return error(res, '勾选的分镜无法合成：' + blocked.slice(0, 5)
          .map(candidate => `${candidate.label}（${BLOCKED_MESSAGE[candidate.blocked!]}）`).join('、'));
      }
      chosen = wanted.map(idx => byIdx.get(idx)!).sort((a, b) => a.panelIdx - b.panelIdx);
    } else {
      const blocked = candidates.filter(candidate => candidate.blocked === 'no-video');
      if (blocked.length) {
        return error(res, `还有 ${blocked.length} 个分镜未生成视频（${blocked.slice(0, 8).map(c => c.label).join('、')}`
          + `${blocked.length > 8 ? ' 等' : ''}），请先在「分镜制作」里生成`);
      }
      chosen = candidates.filter(candidate => !candidate.blocked);
    }
    if (!chosen.length) return error(res, '没有可合成的分镜视频');

    // 段间转场：调用智能转场决策器（同场景≤0.3s 软切/硬切，跨场景匹配剪辑/转场，且转场总时长占比设上限）
    const enriched = enrichChapterContinuity(configs, { chapterId, workId });
    const transitionDecisions = decideShotTransitions(enriched.configs, { chapterId });
    const decisionByFromKey = new Map(transitionDecisions.map(d => [d.from_shot, d]));
    await syncContinuityAndTransitionsToDb(chapterId, enriched.storyboardRows, transitionDecisions).catch(err =>
      console.warn(`[compose] 同步连贯性/转场决策表失败: ${err?.message || err}`),
    );

    const rawClipsByPanel = new Map<number, Record<string, any>>();
    if (Array.isArray(req.body?.clips)) {
      req.body.clips.forEach((clip: any, idx: number) => {
        if (!clip || typeof clip !== 'object') return;
        const pIdx = Number.isSafeInteger(Number(clip.panelIdx)) ? Number(clip.panelIdx) : idx;
        rawClipsByPanel.set(pIdx, clip);
      });
    }

    const segments: ComposeSegment[] = chosen.map((item, index) => {
      const clipMeta = rawClipsByPanel.get(item.panelIdx) || {};
      const timelineExtras = {
        ...(clipMeta.sourceNodeId ? { sourceNodeId: String(clipMeta.sourceNodeId) } : {}),
        ...(Number.isFinite(Number(clipMeta.sourceOffset)) ? { sourceOffset: Number(clipMeta.sourceOffset) } : {}),
        ...(Number.isFinite(Number(clipMeta.sourceDuration)) && Number(clipMeta.sourceDuration) > 0
          ? { sourceDuration: Number(clipMeta.sourceDuration) }
          : {}),
        ...(Number.isFinite(Number(clipMeta.decibel)) ? { decibel: Number(clipMeta.decibel) } : {}),
      };
      const next = chosen[index + 1];
      if (!next) return { url: item.url, transitionAfter: null, transitionDuration: 0, ...timelineExtras };
      const sameScene = next.sceneIdx === item.sceneIdx;
      const fromRow = enriched.storyboardRows.find(r => r.panel_idx === item.panelIdx);
      const decision = fromRow ? decisionByFromKey.get(fromRow.shot_key) : undefined;
      if (decision) {
        return {
          url: item.url,
          transitionAfter: clipMeta.transitionAfter || decision.type,
          transitionDuration: decision.duration,
          ...timelineExtras,
        };
      }
      const explicitShotTransition = item.shotTransition.trim();
      const sceneTransition = String(configs[item.sceneIdx]?.transition || '硬切').trim() || '硬切';
      const transitionAfter = clipMeta.transitionAfter || (sameScene
        ? (explicitShotTransition || (next.linkType === 'transition' ? '叠化' : '硬切'))
        : (explicitShotTransition && explicitShotTransition !== '硬切'
          ? explicitShotTransition
          : sceneTransition));
      const transitionDuration = transitionAfter === '硬切' ? 0 : (sameScene ? 0.25 : 0.45);
      return { url: item.url, transitionAfter, transitionDuration, ...timelineExtras };
    });

    const size = resolveOutputSize(resolution, work?.aspectRatio || undefined);
    const { taskId } = await createTask(userId, 'compose', {
      workId, chapterId, resolution, fps, segmentCount: chosen.length,
      width: size.width, height: size.height,
      router: '/video-storyboard',
      stepsConfig: JSON.stringify([
        { name: 'compose', label: `准备合成 ${chosen.length} 段分镜`, status: 'running', percent: 0 },
      ]),
    });

    activeComposeChapters.add(chapterId);
    // 后台执行：下载 → 重编码拼接（含转场与双轨音量）→ 上传 OSS → 写回章节与 shot_assets
    void (async () => {
      const writer = createThrottledWriter<TaskPatch>(patch => updateTask(taskId, patch), 1000);
      const steps = (label: string, status: string, percent: number) =>
        JSON.stringify([{ name: 'compose', label, status, percent }]);
      try {
        const result = await composeVideos({
          segments, width: size.width, height: size.height, fps,
          bgmUrl: typeof req.body?.bgmUrl === 'string' ? req.body.bgmUrl : undefined,
          bgmVolume: req.body?.bgmVolume !== undefined ? Number(req.body.bgmVolume) : undefined,
          videoAudioMuted: Boolean(req.body?.videoAudioMuted),
          videoAudioVolume: req.body?.videoAudioVolume !== undefined ? Number(req.body.videoAudioVolume) : undefined,
          audioTrackMuted: Boolean(req.body?.audioTrackMuted),
          audioTrackVolume: req.body?.audioTrackVolume !== undefined ? Number(req.body.audioTrackVolume) : undefined,
          onProgress: (percent, label) => {
            writer.push({ stepsConfig: steps(label, 'running', percent) });
          },
        });
        writer.writeNow({ stepsConfig: steps('正在执行成片连贯性质检', 'running', 98) });
        try {
          const qcReport = await inspectVideoQuality({
            renderId: `compose-${chapterId}-${taskId}`,
            chapterId,
            panelIdx: null,
            videoBuffer: result.buffer,
            expectedShotDurationSec: result.durationSec,
            allowBlackFade: true,
          });
          await saveQcRecordsToDb(qcReport.records);
        } catch (qcErr: any) {
          console.warn(`[compose] 成片自动质检记录跳过: ${qcErr?.message || qcErr}`);
        }
        writer.writeNow({ stepsConfig: steps('正在上传成品', 'running', 99) });
        const key = `videos/compose/${workId}_${chapterId}_${Date.now()}.mp4`;
        const url = await uploadBufferToOSS(key, result.buffer, 'video/mp4');
        await db.update(schema.chapters).set({ composed_video_url: url, updatedAt: new Date() })
          .where(and(eq(schema.chapters.id, chapterId), eq(schema.chapters.user_id, userId)));
        await recordShotAssetVersion({
          chapterId,
          sceneIndex: 0,
          shotIndex: 0,
          assetType: 'compose',
          url,
          prompt: `Composed (${chosen.length} clips, ${resolution}, ${fps}fps)`,
          duration: result.durationSec,
          params: {
            resolution,
            fps,
            segmentCount: chosen.length,
            videoAudioMuted: Boolean(req.body?.videoAudioMuted),
            videoAudioVolume: req.body?.videoAudioVolume ?? 1,
            audioTrackMuted: Boolean(req.body?.audioTrackMuted),
            audioTrackVolume: req.body?.audioTrackVolume ?? 1,
          },
          status: 'done',
        }).catch(() => {});
        writer.writeNow({
          status: 'done', result: url,
          stepsConfig: steps('合成完成', 'success', 100),
        });
        await writer.flush();
      } catch (err: any) {
        const message = taskErrorMessage(err, '作品合成失败');
        console.error('作品合成失败:', message);
        writer.writeNow({ status: 'failed', result: message, stepsConfig: steps(message, 'failed', 0) });
        await writer.flush().catch(() => { /* 落库失败不影响任务已失败的终态提示 */ });
      } finally {
        activeComposeChapters.delete(chapterId);
      }
    })().catch(err => console.error('合成任务异常:', err?.message));

    return success(res, {
      taskId, segmentCount: chosen.length, width: size.width, height: size.height,
    }, "已开始合成");
  } catch (err: any) {
    return error(res, err.message || '创建合成任务失败');
  }
});

// ============================================
// 重置卡住的视频任务（进程重启/异常退出会让分镜一直停在"生成中"，无法重新提交）
// ============================================
app.post("/frame-video/reset", authMiddleware, async (req, res) => {
  const userId = req.user?.id as number;
  const chapterId = Number(req.body?.chapterId);
  const panelIdx = Number(req.body?.panelIdx);
  if (!Number.isSafeInteger(chapterId) || chapterId <= 0 || !Number.isSafeInteger(panelIdx) || panelIdx < 0)
    return error(res, '请求参数无效');
  try {
    await resetStuckVideoTask(userId, chapterId, panelIdx);
    return success(res, null, '已重置，可以重新生成');
  } catch (err: any) {
    return error(res, err.message || '重置失败');
  }
});

// ============================================
// 配音链路诊断：把「角色 → personas.voice_id → voices.id → voices.voice_id」逐跳解析出来，
// 用于定位"配音音色不对"到底断在哪一跳（角色没选音色 / 配音没填供应商音色 / 多条配音重复等）。
// ============================================
app.get("/tts/diagnose", authMiddleware, async (req, res) => {
  const userId = req.user?.id as number;
  const workId = Number(req.query.workId);
  const chapterId = Number(req.query.chapterId);
  const panelIdx = Number(req.query.panelIdx ?? 0);
  if (!Number.isSafeInteger(workId) || workId <= 0 || !Number.isSafeInteger(chapterId) || chapterId <= 0
    || !Number.isSafeInteger(panelIdx) || panelIdx < 0) return error(res, '请求参数无效');
  try {
    const [chapter] = await db.select().from(schema.chapters).where(and(
      eq(schema.chapters.id, chapterId), eq(schema.chapters.work_id, workId), eq(schema.chapters.user_id, userId),
    ));
    if (!chapter) return error(res, '章节不存在');
    const panel = resolveStoryboardPanel((chapter.content_configs as any[]) || [], panelIdx)?.panel;
    if (!panel) return error(res, '分镜不存在');

    const [work] = await db.select({ narrationVoiceId: schema.works.narration_voice_id }).from(schema.works)
      .where(eq(schema.works.id, workId)).limit(1);
    const allVoices = await db.select({
      id: schema.voices.id, voice_name: schema.voices.voice_name, providerVoiceId: schema.voices.voice_id,
    }).from(schema.voices);
    const voicesById = new Map(allVoices.map(voice => [voice.id, voice]));

    const dialogue = Array.isArray(panel.dialogue) ? panel.dialogue as any[] : [];
    const roleIds = [...new Set([
      ...((panel.roles as { id: unknown }[]) || []).map(role => Number(role?.id)).filter(Number.isSafeInteger),
      ...dialogue.map(line => (line?.id === '' || line?.id == null ? undefined : Number(line.id)))
        .filter((value): value is number => Number.isSafeInteger(value)),
    ])];
    const personas = roleIds.length
      ? await db.select({
        id: schema.personas.id, name: schema.personas.name,
        voiceId: schema.personas.voice_id, sourceType: schema.personas.source_type,
      }).from(schema.personas)
        .where(and(inArray(schema.personas.id, roleIds), eq(schema.personas.work_id, workId)))
      : [];

    const roles = roleIds.map(roleId => {
      const persona = personas.find(item => item.id === roleId);
      const voice = persona?.voiceId == null ? undefined : voicesById.get(persona.voiceId);
      const problem = !persona
        ? 'personas 表中找不到该 id（分镜里的角色 ID 不是角色素材 ID）'
        : persona.sourceType !== 'persona'
          ? `该素材不是角色（source_type=${persona.sourceType}）`
          : persona.voiceId == null
            ? '角色未选择音色（personas.voice_id 为空）'
            : !voice
              ? `personas.voice_id=${persona.voiceId} 在 voices 表中不存在`
              : !voice.providerVoiceId
                ? `配音「${voice.voice_name}」的 voice_id 为空（TTS 时无法使用）`
                : '';
      return {
        roleId,
        personaName: persona?.name ?? null,
        personaSourceType: persona?.sourceType ?? null,
        personasVoiceId: persona?.voiceId ?? null,
        voicesRow: voice ? { id: voice.id, name: voice.voice_name, providerVoiceId: voice.providerVoiceId } : null,
        resolvedProviderVoiceId: voice?.providerVoiceId || '',
        ok: !problem,
        problem,
      };
    });

    const narrationVoice = work?.narrationVoiceId == null ? undefined : voicesById.get(work.narrationVoiceId);
    const duplicates = (() => {
      const owners = new Map<string, string[]>();
      for (const voice of allVoices) {
        if (!voice.providerVoiceId) continue;
        owners.set(voice.providerVoiceId, [...(owners.get(voice.providerVoiceId) || []), voice.voice_name]);
      }
      return [...owners].filter(([, names]) => names.length > 1)
        .map(([providerVoiceId, names]) => ({ providerVoiceId, names }));
    })();

    return success(res, {
      panelIdx,
      narration: {
        worksNarrationVoiceId: work?.narrationVoiceId ?? null,
        voicesRow: narrationVoice
          ? { id: narrationVoice.id, name: narrationVoice.voice_name, providerVoiceId: narrationVoice.providerVoiceId }
          : null,
        resolvedProviderVoiceId: narrationVoice?.providerVoiceId || '',
      },
      dialogues: dialogue.map(line => ({
        speaker: String(line?.speaker || ''),
        text: String(line?.text || '').slice(0, 30),
        roleId: line?.id === '' || line?.id == null ? null : Number(line.id),
        audioUrl: String(line?.audioUrl || ''),
      })),
      roles,
      voices: {
        total: allVoices.length,
        withEmptyProviderId: allVoices.filter(voice => !voice.providerVoiceId).map(voice => ({ id: voice.id, name: voice.voice_name })),
        providerIdDuplicates: duplicates,
      },
    });
  } catch (err: any) {
    return error(res, err.message || '配音诊断失败');
  }
});

// ============================================
// 分镜连贯性体检、转场决策与质检报告查询（人工干预节点 — 需求 3.2 / 5 / 6 P3）
// GET /api/agent/storyboard/continuity?chapterId=xxx&workId=xxx
// ============================================
app.get("/storyboard/continuity", authMiddleware, async (req, res) => {
  const userId = req.user?.id as number;
  const chapterId = Number(req.query.chapterId);
  const workId = Number(req.query.workId || 0);
  if (!Number.isSafeInteger(chapterId) || chapterId <= 0) return error(res, 'chapterId 无效');

  try {
    const [chapter] = await db.select({
      workId: schema.chapters.work_id,
      configs: schema.chapters.content_configs,
    }).from(schema.chapters)
      .where(and(eq(schema.chapters.id, chapterId), eq(schema.chapters.user_id, userId), isNull(schema.chapters.deleted_at)))
      .limit(1);
    if (!chapter) return error(res, '章节不存在');

    const [work] = await db.select({ styleId: schema.works.style_id })
      .from(schema.works)
      .where(eq(schema.works.id, workId || chapter.workId))
      .limit(1);

    const rawConfigs = Array.isArray(chapter.configs) ? chapter.configs : [];
    const enriched = enrichChapterContinuity(rawConfigs, {
      chapterId,
      workId: workId || chapter.workId,
      styleAnchorId: work?.styleId ?? null,
    });
    const transitions = decideShotTransitions(enriched.configs, { chapterId });
    await syncContinuityAndTransitionsToDb(chapterId, enriched.storyboardRows, transitions).catch(() => {});

    const qcRows = await db.select()
      .from(schema.qc_record)
      .where(eq(schema.qc_record.chapter_id, chapterId));

    return success(res, {
      chapterId,
      overallScore: enriched.overallScore,
      storyboard: enriched.storyboardRows,
      transitions,
      issuesByScene: enriched.issuesByScene,
      qcRecords: qcRows,
    });
  } catch (err: any) {
    return error(res, err.message || '查询分镜连贯性报告失败');
  }
});

// ============================================
// 人工干预节点：手动调整分镜连贯性锚点、转场类型/时长并重算连贯性校验（需求 3.2 / 6 P3）
// POST /api/agent/storyboard/manual-adjust
// ============================================
app.post("/storyboard/manual-adjust", authMiddleware, async (req, res) => {
  const userId = req.user?.id as number;
  const chapterId = Number(req.body?.chapterId);
  const panelIdx = Number(req.body?.panelIdx);
  const patch = (req.body?.patch && typeof req.body.patch === 'object') ? req.body.patch : {};
  if (!Number.isSafeInteger(chapterId) || chapterId <= 0 || !Number.isSafeInteger(panelIdx) || panelIdx < 0) {
    return error(res, 'chapterId 或 panelIdx 无效');
  }

  try {
    const [chapter] = await db.select({
      workId: schema.chapters.work_id,
      configs: schema.chapters.content_configs,
    }).from(schema.chapters)
      .where(and(eq(schema.chapters.id, chapterId), eq(schema.chapters.user_id, userId), isNull(schema.chapters.deleted_at)))
      .limit(1);
    if (!chapter) return error(res, '章节不存在');

    const configs = Array.isArray(chapter.configs) ? (chapter.configs as any[]) : [];
    const resolved = resolveStoryboardPanel(configs, panelIdx);
    if (!resolved) return error(res, '未找到指定分镜');
    const targetShot = resolved.shot;

    if (patch.transition_out !== undefined) {
      targetShot.transition_out = String(patch.transition_out || '硬切').trim();
      targetShot.transition = targetShot.transition_out;
      targetShot.manual_transition_override = true;
    }
    if (patch.transition_duration !== undefined && Number.isFinite(Number(patch.transition_duration))) {
      targetShot.transition_duration = Math.max(0, Math.min(1.5, Number(patch.transition_duration)));
      targetShot.manual_transition_override = true;
    }
    if (patch.motion_direction !== undefined) targetShot.motion_direction = String(patch.motion_direction).trim();
    if (patch.color_tone !== undefined) targetShot.color_tone = String(patch.color_tone).trim();
    if (patch.subject_id !== undefined) targetShot.subject_id = patch.subject_id == null ? null : Number(patch.subject_id);
    if (patch.shot_size !== undefined) targetShot.shot_size = String(patch.shot_size).trim();
    if (patch.axis_side !== undefined) targetShot.axis_side = String(patch.axis_side).trim();
    if (patch.durShort !== undefined && Number.isFinite(Number(patch.durShort))) {
      targetShot.durShort = Math.max(2, Math.min(15, Number(patch.durShort)));
    }
    if (patch.start_seed !== undefined) targetShot.start_seed = patch.start_seed == null ? null : Number(patch.start_seed);
    if (patch.end_seed !== undefined) targetShot.end_seed = patch.end_seed == null ? null : Number(patch.end_seed);
    if (patch.frame_mode !== undefined && ['single', 'dual', 'video_tail'].includes(String(patch.frame_mode))) {
      targetShot.frame_mode = String(patch.frame_mode);
    }
    if (patch.world_state !== undefined) {
      targetShot.world_state = String(patch.world_state || '').slice(0, 500);
    }

    const enriched = enrichChapterContinuity(configs, {
      chapterId,
      workId: chapter.workId,
    });
    const transitions = decideShotTransitions(enriched.configs, { chapterId });
    await db.update(schema.chapters)
      .set({ content_configs: enriched.configs as any, updatedAt: new Date() })
      .where(and(eq(schema.chapters.id, chapterId), eq(schema.chapters.user_id, userId)));
    await syncContinuityAndTransitionsToDb(chapterId, enriched.storyboardRows, transitions).catch(() => {});

    return success(res, {
      overallScore: enriched.overallScore,
      storyboard: enriched.storyboardRows,
      transitions,
      shot: targetShot,
    }, '分镜连贯性参数已更新');
  } catch (err: any) {
    return error(res, err.message || '手动调整分镜失败');
  }
});

// ============================================
// 市场主流无缝承接节点：一键截取上一镜视频真实最后一帧（或上一镜画面）作为本镜首帧
// POST /api/agent/storyboard/inherit-prev-frame
// ============================================
app.post("/storyboard/inherit-prev-frame", authMiddleware, async (req, res) => {
  const userId = req.user?.id as number;
  const workId = Number(req.body?.workId);
  const chapterId = Number(req.body?.chapterId);
  const panelIdx = Number(req.body?.panelIdx);
  const preferredSource = String(req.body?.source || 'auto').trim(); // 'auto' | 'video_tail' | 'prev_frame'
  if (!Number.isSafeInteger(chapterId) || chapterId <= 0 || !Number.isSafeInteger(panelIdx) || panelIdx <= 0) {
    return error(res, '仅第 2 镜及后续分镜支持承接上一镜末帧');
  }

  try {
    const [chapter] = await db.select({
      workId: schema.chapters.work_id,
      configs: schema.chapters.content_configs,
    }).from(schema.chapters)
      .where(and(
        eq(schema.chapters.id, chapterId),
        eq(schema.chapters.user_id, userId),
        ...(Number.isSafeInteger(workId) && workId > 0 ? [eq(schema.chapters.work_id, workId)] : []),
        isNull(schema.chapters.deleted_at),
      ))
      .limit(1);
    if (!chapter) return error(res, '章节不存在');

    const configs = Array.isArray(chapter.configs) ? (chapter.configs as any[]) : [];
    const curTarget = resolveStoryboardPanel(configs, panelIdx);
    const prevTarget = resolveStoryboardPanel(configs, panelIdx - 1);
    if (!curTarget || !prevTarget) return error(res, '未找到当前分镜或上一镜');

    const prevVideoUrl = String(prevTarget.panel?.finalVideoUrl || '').trim();
    const prevKeyFrameUrl = String(prevTarget.panel?.lastFrameUrl || prevTarget.panel?.firstFrameUrl || '').trim();

    let inheritedUrl = '';
    let sourceUsed: 'video_tail' | 'prev_frame' = 'prev_frame';

    if ((preferredSource === 'auto' || preferredSource === 'video_tail') && prevVideoUrl) {
      const frameBuf = await extractVideoLastFrameBuffer(prevVideoUrl);
      const ossKey = `images/frames/video_tail_${chapter.workId}_${chapterId}_p${panelIdx}_${Date.now()}.png`;
      try {
        inheritedUrl = await uploadBufferToOSS(ossKey, frameBuf, 'image/png');
      } catch (ossErr: any) {
        console.warn(`[inherit-prev-frame] OSS 上传失败 (${ossErr?.message})，回退使用内联 base64 URL`);
        inheritedUrl = `data:image/png;base64,${frameBuf.toString('base64')}`;
      }
      sourceUsed = 'video_tail';
    } else if (prevKeyFrameUrl) {
      inheritedUrl = prevKeyFrameUrl;
      sourceUsed = 'prev_frame';
    } else {
      return error(res, '上一镜尚未生成视频或画面，请先生成上一镜后再承接');
    }

    if (curTarget.sceneIdx === undefined || !curTarget.scene) {
      curTarget.panel.firstFrameUrl = inheritedUrl;
    } else {
      assignPanelFrame(curTarget.scene, curTarget.panel, 'start', { url: inheritedUrl, seed: null });
    }
    curTarget.panel.finalVideoUrl = '';
    curTarget.commit();

    const enriched = enrichChapterContinuity(configs, {
      chapterId,
      workId: chapter.workId,
    });
    const transitions = decideShotTransitions(enriched.configs, { chapterId });
    await db.update(schema.chapters)
      .set({ content_configs: enriched.configs as any, updatedAt: new Date() })
      .where(and(eq(schema.chapters.id, chapterId), eq(schema.chapters.user_id, userId)));
    await syncContinuityAndTransitionsToDb(chapterId, enriched.storyboardRows, transitions).catch(() => {});

    return success(res, {
      panelIdx,
      firstFrameUrl: inheritedUrl,
      sourceUsed,
      world_state: String(curTarget.shot?.world_state || ''),
    }, sourceUsed === 'video_tail' ? '已从上一镜视频截取真实末帧作为本镜首帧' : '已复用上一镜关键帧作为本镜首帧');
  } catch (err: any) {
    return error(res, err.message || '承接上一镜末帧失败');
  }
});

// ============================================
// 查询用户任务列表（支持可选分页：?page=1&pageSize=10）
// ============================================
app.get("/task", authMiddleware, async (req, res) => {
  const paginated = req.query.page !== undefined || req.query.pageSize !== undefined;
  const page = Number(req.query.page ?? 1);
  const pageSize = Number(req.query.pageSize ?? 10);
  return success(
    res,
    await getUserTasks(
      req.user?.id as number,
      paginated ? page : undefined,
      paginated ? pageSize : undefined,
    ),
  );
});

// ============================================
// 删除任务
// ============================================
app.delete("/task/:taskId", authMiddleware, async (req, res) => {
  if (!req.params.taskId) return error(res, "task任务ID为空")
  await removeTask(req.user?.id as number, req.params.taskId);
  return success(res, "已清理");
});

// ============================================
// 订阅任务流（重连）
// ============================================
app.get("/task/:taskId/stream", authMiddleware, async (req, res) => {
  if (!req.params.taskId) return error(res, "task任务ID为空")
  await subscribeTask(req, req.params.taskId, req.user?.id as number, res);
});

export default app;
