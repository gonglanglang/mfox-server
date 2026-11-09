// ============================================
// 阿里云 DashScope 异步任务协议适配器（万相 wan3.0 等）
// 提交：POST {base}{endpoint}  → 返回任务 id
// 轮询：GET  {base}/tasks/{id} → 取 video_url
// 该协议的请求体布局、状态词表、结果解析、退避策略都在此文件内，
// 同类协议的第二个供应商只需在后台新增一行配置（protocol=dashscope-async）。
// ============================================
import type { VideoAdapter, VideoConnection, VideoSubmitInput, VideoTaskResult, VideoMediaItem } from './types'

/** 协议默认端点（ai_models.endpoint 留空时使用） */
const DEFAULT_ENDPOINT = '/services/aigc/video-generation/video-synthesis'
const DEFAULT_DURATION = 5

export interface PollOptions {
  /** 最多轮询次数，默认 120（约 10 分钟） */
  maxAttempts?: number
  /** 基础轮询间隔（毫秒），默认 5000；连续失败时按指数退避（上限 30s） */
  intervalMs?: number
  requestTimeoutMs?: number
  /** 连续临时错误允许次数，默认 3 */
  maxTransientRetries?: number
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 不记录请求头、完整响应或 URL，避免日志泄露凭证 */
function requestErrorDetail(error: any): string {
  const codes = [error?.code, error?.cause?.code,
    ...(error?.cause?.errors || []).map((item: any) => item?.code)].filter(Boolean)
  return `${error?.message || '网络请求失败'}${codes.length ? ` (${[...new Set(codes)].join(', ')})` : ''}`
}

async function requestJson(url: string, init: RequestInit, timeoutMs: number) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()
  let data: any
  try { data = JSON.parse(text) } catch { /* 非 JSON 错误页不能掩盖 HTTP 状态 */ }
  return { response, data }
}

function providerError(data: any): string {
  const message = data?.output?.message || data?.error?.message || data?.message || data?.error
  return typeof message === 'string' ? message.slice(0, 300) : '供应商未返回错误详情'
}

/** 从查询响应中健壮地提取视频 URL（该协议在不同版本下字段位置不一致） */
function extractVideoUrl(data: any): string {
  if (!data) return ''
  const candidates = [
    data?.content?.video_url,
    data.video_url,
    data.videoUrl,
    data?.output?.videos?.[0]?.url,
    data?.output?.video_url,
    data?.data?.video_url,
    data?.data?.[0]?.url,
    data?.data?.videos?.[0]?.url,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.startsWith('http')) return c
  }
  return ''
}

function endpointOf(connection: VideoConnection) {
  const base = connection.baseUrl.replace(/\/+$/, '')
  const path = (connection.endpoint || '').trim() || DEFAULT_ENDPOINT
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * 组装 wan3.0 的 input 对象（注意：是「对象」不是数组）。
 *
 * 协议要点（阿里云百炼 wan3.0-video）：
 * - `input = { prompt, media: [{ type, url }] }`
 * - `media[].type` ∈ first_frame / last_frame / reference_image / reference_video / reference_audio
 * - **first_frame | last_frame 与 reference_* 互斥**，不能出现在同一请求里
 *
 * 这里统一使用 `reference_image` / `reference_audio`（全模态参考模式）：
 * 提示词已用「图1 为起始画面、图2 为收尾画面、图3 场景、图4/图5 角色」的整体编号描述素材，
 * 与该模式的「图片按顺序计编号」一致；若改用首尾帧模式，既不能带音频、也会让提示词里的编号失配。
 */
function buildInput(input: VideoSubmitInput) {
  const media = input.media.map((item: VideoMediaItem) => ({
    type: item.type === 'reference_audio' ? 'reference_audio' : item.type === 'reference_video' ? 'reference_video' : 'reference_image',
    url: item.url,
  }))
  const value: Record<string, unknown> = { prompt: input.prompt }
  if (media.length) value.media = media
  return value
}

/** 组装 parameters：模型固定参数打底，用户选择项覆盖 */
function buildParameters(input: VideoSubmitInput, connection: VideoConnection) {
  const parameters: Record<string, unknown> = {
    ...(connection.params || {}),
    duration: input.duration ?? DEFAULT_DURATION,
  }
  if (input.resolution) parameters.resolution = input.resolution
  if (input.ratio) parameters.ratio = input.ratio
  return parameters
}

export async function submitAliyunVideoTask(
  input: VideoSubmitInput,
  connection: VideoConnection,
  requestTimeoutMs = 60_000,
): Promise<VideoTaskResult> {
  if (!connection.baseUrl || !connection.apiKey) {
    return { success: false, error: '缺少视频服务商 API 地址或密钥配置' }
  }
  if (!input.media.length && !input.prompt) {
    return { success: false, error: '内容与提示词不能同时为空' }
  }

  const url = endpointOf(connection)
  const body = {
    model: input.model,
    input: buildInput(input),
    parameters: buildParameters(input, connection),
  }

  try {
    // ── 提交前把"真正发给供应商的东西"完整打印出来，便于人工确认 ──
    console.log('════════════ 视频生成请求（提交前确认） ════════════')
    console.log('模型:', input.model)
    console.log('URL:', url)
    console.log('──────── prompt（模型据此理解画面与声音） ────────')
    console.log(input.prompt)
    console.log('──────── media（参考素材，与 prompt 里的编号一致） ────────')
    let imageNo = 0
    let audioNo = 0
    for (const item of ((body.input as any).media as any[] | undefined) || []) {
      const label = item?.type === 'reference_audio' ? `音频${++audioNo}` : item?.type === 'reference_video' ? '视频1' : `图${++imageNo}`
      console.log(`  [${label}] ${item?.url}`)
    }
    console.log('──────── parameters ────────')
    console.log(JSON.stringify(body.parameters, null, 2))
    console.log('──────── 完整请求体 ────────')
    console.log(JSON.stringify(body, null, 2))
    console.log('════════════════════════════════════════════════')

    // 只想确认 prompt、暂不真正提交时：设置 VIDEO_DRY_RUN=true 跑一次即可
    console.log('VIDEO_DRY_RUN:', process.env.VIDEO_DRY_RUN)
    if (process.env.VIDEO_DRY_RUN === 'true') {
      console.log('（VIDEO_DRY_RUN=true，未提交供应商；确认无误后去掉该变量再正式生成）')
      return { success: false, error: 'DRY_RUN：已打印请求内容，未提交供应商' }
    }

    const { response: res, data } = await requestJson(url, {
      method: 'POST',
      headers: {
        'X-DashScope-Async': 'enable',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${connection.apiKey}`,
      },
      body: JSON.stringify(body),
    }, requestTimeoutMs)

    if (!res.ok) {
      return { success: false, error: `提交视频任务失败 HTTP ${res.status}: ${providerError(data)}` }
    }
    const taskId = data?.id || data?.output?.task_id || ''
    if (!taskId) return { success: false, error: '提交响应无有效任务 ID，提交结果未知，请先核查供应商任务，避免重复生成' }
    return { success: true, taskId }
  } catch (e: any) {
    return { success: false, error: `提交视频任务请求异常: ${requestErrorDetail(e)}；提交结果未知，请先核查供应商任务，避免重复生成` }
  }
}

export async function pollAliyunVideoTask(
  taskId: string,
  connection: VideoConnection,
  options: PollOptions = {},
  onStatus?: (status: string, attempt: number) => void,
): Promise<VideoTaskResult> {
  const { maxAttempts = 120, intervalMs = 5000, requestTimeoutMs = 30_000, maxTransientRetries = 3 } = options
  if (!connection.baseUrl || !connection.apiKey) {
    return { success: false, error: '缺少视频服务商 API 地址或密钥配置' }
  }
  if (!taskId) return { success: false, error: '缺少任务 ID' }

  const queryUrl = `${connection.baseUrl.replace(/\/+$/, '')}/tasks/${taskId}`
  let consecutiveErrors = 0
  let lastError = ''

  try {
    for (let i = 0; i < maxAttempts; i++) {
      await sleep(Math.min(intervalMs * 2 ** consecutiveErrors, 30_000))
      let queryData: any
      try {
        const { response, data } = await requestJson(queryUrl, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${connection.apiKey}` },
        }, requestTimeoutMs)
        if (!response.ok) {
          const error = `查询视频任务失败 HTTP ${response.status}: ${providerError(data)}`
          if (![408, 429, 500, 502, 503, 504].includes(response.status)) return { success: false, taskId, error }
          throw new Error(error)
        }
        if (!data || typeof data !== 'object') throw new Error('查询响应不是有效 JSON')
        queryData = data
      } catch (e: any) {
        lastError = requestErrorDetail(e)
        consecutiveErrors++
        console.warn('视频任务查询暂时失败:', { taskId, attempt: i + 1, consecutiveErrors, error: lastError })
        if (consecutiveErrors > maxTransientRetries) {
          return { success: false, taskId, error: `查询视频任务重试耗尽: ${lastError}；供应商任务可能仍在运行，可使用任务 ID 继续查询` }
        }
        continue
      }
      consecutiveErrors = 0
      lastError = ''
      const status = String(queryData?.status || queryData?.output?.task_status || '').toLowerCase()
      onStatus?.(status, i + 1)

      if (status === 'succeeded' || status === 'completed') {
        const rawUrl = extractVideoUrl(queryData)
        if (!rawUrl) return { success: false, taskId, error: '任务完成但没有视频 URL' }
        return { success: true, videoUrl: rawUrl, taskId }
      }
      if (status === 'failed' || status === 'cancelled') {
        return { success: false, taskId, error: `供应商视频任务 ${status}: ${providerError(queryData)}` }
      }
      if (i % 6 === 0) console.log(`视频任务 ${taskId} 状态: ${status || '未知'}（第 ${i + 1} 次查询）`)
    }
    return { success: false, taskId, error: `视频任务查询达到上限（${maxAttempts} 次），供应商任务可能仍在运行${lastError ? `；最后查询错误: ${lastError}` : ''}` }
  } catch (e: any) {
    return { success: false, taskId, error: `查询视频任务异常: ${requestErrorDetail(e)}` }
  }
}

export const aliyunVideoAdapter: VideoAdapter = {
  protocol: 'dashscope-async',
  submit: submitAliyunVideoTask,
  poll: (taskId, connection, onStatus) => pollAliyunVideoTask(taskId, connection, {}, onStatus),
}
