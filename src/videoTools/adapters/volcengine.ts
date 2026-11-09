// ============================================
// 火山引擎方舟（Volcengine Ark / 豆包 Seedance）异步视频生成适配器
// 提交：POST {base}{endpoint}        （默认 /contents/generations/tasks） → 返回任务 id
// 轮询：GET  {base}{endpoint}/{id}   （默认 /contents/generations/tasks/{id}） → 取 content.video_url
//
// 同时支持：
// 1. Seedance 2.0 全模态参考模式（reference_image + reference_audio + reference_video）
// 2. Seedance 1.0 / 1.5 首尾帧模式（first_frame + last_frame，当模型名为 seedance-1-* 或 params.image_role='first_last_frame' 时自动启用）
// ============================================
import type { VideoAdapter, VideoConnection, VideoSubmitInput, VideoTaskResult, VideoMediaItem } from './types'

const DEFAULT_ENDPOINT = '/contents/generations/tasks'
const DEFAULT_DURATION = 5
const DEFAULT_RATIO = '16:9'
const DEFAULT_RESOLUTION = '720p'

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

function requestErrorDetail(error: any): string {
  const codes = [
    error?.code,
    error?.cause?.code,
    ...(error?.cause?.errors || []).map((item: any) => item?.code),
  ].filter(Boolean)
  return `${error?.message || '网络请求失败'}${codes.length ? ` (${[...new Set(codes)].join(', ')})` : ''}`
}

async function requestJson(url: string, init: RequestInit, timeoutMs: number) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()
  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    /* 非 JSON 错误页不能掩盖 HTTP 状态 */
  }
  return { response, data }
}

function providerError(data: any): string {
  const message = data?.error?.message || data?.output?.message || data?.message || data?.error
  return typeof message === 'string' ? message.slice(0, 300) : '供应商未返回错误详情'
}

/** 从查询响应中提取视频 URL（火山方舟标准返回在 data.content.video_url） */
function extractVideoUrl(data: any): string {
  if (!data) return ''
  const candidates = [
    data?.content?.video_url,
    data?.video_url,
    data?.videoUrl,
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
 * 将上游统一提示词中的「图1 / 音频1 / 视频1」归一为 Seedance 识别的「@图像1 / @音频1 / @视频1」
 */
export function normalizeSeedancePromptRefs(prompt: string): string {
  return String(prompt || '')
    .replace(/(?:@图像|图)\s*(\d+)/g, '@图像$1')
    .replace(/(?:@音频|音频)\s*(\d+)/g, '@音频$1')
    .replace(/(?:@视频|视频)\s*(\d+)/g, '@视频$1')
}

/**
 * 判断是否走首尾帧模式（Seedance 1.0 / 1.5 默认走 first_frame/last_frame，Seedance 2.0 默认走全模态 reference_*）
 */
function useFirstLastFrameMode(input: VideoSubmitInput, connection: VideoConnection): boolean {
  const explicitRole = String(connection.params?.image_role || '').trim()
  if (explicitRole === 'first_last_frame') return true
  if (explicitRole === 'reference_image') return false
  return /seedance[-_.]?1[-_.]?[05]/i.test(input.model)
}

/**
 * 组装火山方舟 content 数组：
 * - 第 1 项：{ type: 'text', text }
 * - 后续项：image_url / video_url / audio_url
 */
export function buildVolcengineContent(input: VideoSubmitInput, connection: VideoConnection) {
  const firstLastMode = useFirstLastFrameMode(input, connection)
  const content: Record<string, unknown>[] = []

  const promptText = firstLastMode ? input.prompt : normalizeSeedancePromptRefs(input.prompt)
  if (promptText) {
    content.push({ type: 'text', text: promptText })
  }

  if (firstLastMode) {
    // 首尾帧模式：取前两张图片分别作为 first_frame 与 last_frame
    const images = input.media.filter(
      (m) => !m.type || m.type === 'reference_image' || m.type === 'first_frame' || m.type === 'last_frame',
    )
    if (images[0]?.url) {
      content.push({
        type: 'image_url',
        image_url: { url: images[0].url },
        role: 'first_frame',
      })
    }
    if (images[1]?.url) {
      content.push({
        type: 'image_url',
        image_url: { url: images[1].url },
        role: 'last_frame',
      })
    }
    return content
  }

  // 全模态参考模式（Seedance 2.0）：按顺序推入 reference_image / reference_video / reference_audio
  for (const item of input.media) {
    if (!item?.url) continue
    if (item.type === 'reference_audio') {
      content.push({
        type: 'audio_url',
        audio_url: { url: item.url },
        role: 'reference_audio',
      })
    } else if (item.type === 'reference_video') {
      content.push({
        type: 'video_url',
        video_url: { url: item.url },
        role: 'reference_video',
      })
    } else if (item.type === 'first_frame' || item.type === 'last_frame') {
      content.push({
        type: 'image_url',
        image_url: { url: item.url },
        role: item.type,
      })
    } else {
      content.push({
        type: 'image_url',
        image_url: { url: item.url },
        role: 'reference_image',
      })
    }
  }

  return content
}

/** 组装完整请求体 */
function buildBody(input: VideoSubmitInput, connection: VideoConnection) {
  const rawParams = { ...(connection.params || {}) }
  delete rawParams.image_role

  const rawResolution = String(input.resolution || rawParams.resolution || DEFAULT_RESOLUTION).trim()
  // 火山方舟分辨率参数要求小写（480p / 720p / 1080p）
  const normalizedResolution = /^(480|720|1080)p$/i.test(rawResolution)
    ? rawResolution.toLowerCase()
    : rawResolution

  const body: Record<string, unknown> = {
    generate_audio: true,
    watermark: false,
    ...rawParams,
    model: input.model,
    content: buildVolcengineContent(input, connection),
    ratio: input.ratio || (rawParams.ratio as string) || DEFAULT_RATIO,
    duration: input.duration ?? (rawParams.duration as number) ?? DEFAULT_DURATION,
    resolution: normalizedResolution,
  }

  return body
}

export async function submitVolcengineVideoTask(
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
  const body = buildBody(input, connection)

  try {
    console.log('════════════ 视频生成请求（火山方舟 Seedance 提交前确认） ════════════')
    console.log('模型:', input.model)
    console.log('URL:', url)
    console.log('──────── prompt（模型据此理解画面与声音） ────────')
    console.log((body.content as any[])?.find((c) => c.type === 'text')?.text || input.prompt)
    console.log('──────── media（参考素材，与 prompt 里的编号一致） ────────')
    let imageNo = 0
    let audioNo = 0
    let videoNo = 0
    for (const item of input.media || []) {
      const label =
        item?.type === 'reference_audio'
          ? `@音频${++audioNo}`
          : item?.type === 'reference_video'
            ? `@视频${++videoNo}`
            : `@图像${++imageNo}`
      console.log(`  [${label}] ${item?.url}`)
    }
    console.log('──────── 完整请求体 ────────')
    console.log(JSON.stringify(body, null, 2))
    console.log('════════════════════════════════════════════════')

    console.log('VIDEO_DRY_RUN:', process.env.VIDEO_DRY_RUN)
    if (process.env.VIDEO_DRY_RUN === 'true') {
      console.log('（VIDEO_DRY_RUN=true，未提交供应商；确认无误后去掉该变量再正式生成）')
      return { success: false, error: 'DRY_RUN：已打印请求内容，未提交供应商' }
    }

    const { response: res, data } = await requestJson(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${connection.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      requestTimeoutMs,
    )

    if (!res.ok) {
      return { success: false, error: `提交视频任务失败 HTTP ${res.status}: ${providerError(data)}` }
    }
    const taskId = data?.id || data?.output?.task_id || data?.data?.id || ''
    if (!taskId) {
      return {
        success: false,
        error: '提交响应无有效任务 ID，提交结果未知，请先核查供应商任务，避免重复生成',
      }
    }
    return { success: true, taskId }
  } catch (e: any) {
    return {
      success: false,
      error: `提交视频任务请求异常: ${requestErrorDetail(e)}；提交结果未知，请先核查供应商任务，避免重复生成`,
    }
  }
}

export async function pollVolcengineVideoTask(
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

  const submitUrl = endpointOf(connection).replace(/\/+$/, '')
  const queryUrl = `${submitUrl}/${encodeURIComponent(taskId)}`
  let consecutiveErrors = 0
  let lastError = ''

  try {
    for (let i = 0; i < maxAttempts; i++) {
      await sleep(Math.min(intervalMs * 2 ** consecutiveErrors, 30_000))
      let queryData: any
      try {
        const { response, data } = await requestJson(
          queryUrl,
          {
            method: 'GET',
            headers: { Authorization: `Bearer ${connection.apiKey}` },
          },
          requestTimeoutMs,
        )
        if (!response.ok) {
          const error = `查询视频任务失败 HTTP ${response.status}: ${providerError(data)}`
          if (![408, 429, 500, 502, 503, 504].includes(response.status)) {
            return { success: false, taskId, error }
          }
          throw new Error(error)
        }
        if (!data || typeof data !== 'object') throw new Error('查询响应不是有效 JSON')
        queryData = data
      } catch (e: any) {
        lastError = requestErrorDetail(e)
        consecutiveErrors++
        console.warn('火山视频任务查询暂时失败:', { taskId, attempt: i + 1, consecutiveErrors, error: lastError })
        if (consecutiveErrors > maxTransientRetries) {
          return {
            success: false,
            taskId,
            error: `查询视频任务重试耗尽: ${lastError}；供应商任务可能仍在运行，可使用任务 ID 继续查询`,
          }
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
      if (status === 'failed' || status === 'cancelled' || status === 'expired') {
        return { success: false, taskId, error: `供应商视频任务 ${status}: ${providerError(queryData)}` }
      }
      if (i % 6 === 0) console.log(`火山视频任务 ${taskId} 状态: ${status || '未知'}（第 ${i + 1} 次查询）`)
    }
    return {
      success: false,
      taskId,
      error: `视频任务查询达到上限（${maxAttempts} 次），供应商任务可能仍在运行${lastError ? `；最后查询错误: ${lastError}` : ''}`,
    }
  } catch (e: any) {
    return { success: false, taskId, error: `查询视频任务异常: ${requestErrorDetail(e)}` }
  }
}

export const volcengineVideoAdapter: VideoAdapter = {
  protocol: 'volcengine-ark',
  submit: submitVolcengineVideoTask,
  poll: (taskId, connection, onStatus) => pollVolcengineVideoTask(taskId, connection, {}, onStatus),
}
