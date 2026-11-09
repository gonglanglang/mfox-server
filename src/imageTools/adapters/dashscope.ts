import type { ImageAdapter, ImageConnection, ImageSubmitInput } from './types'
import { DRY_RUN_IMAGE_URL, imageDryRunEnabled, logImageRequest } from '../dry-run'

/** 协议默认端点（ai_models.endpoint 留空时使用） */
const DEFAULT_SUBMIT_ENDPOINT = '/services/aigc/text2image/image-synthesis'
const DEFAULT_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 3_000
const POLL_TIMEOUT_MS = 300_000
const SUCCESS_STATUS = 'SUCCEEDED'
const FAILURE_STATUSES = ['FAILED', 'CANCELED', 'UNKNOWN']

/**
 * 阿里云的 size 用 `1024*1024`（星号）。档位简写（2K / 4K）不在其文档约定内，
 * 无法安全换算时返回 undefined —— 交给供应商默认值，而不是猜一个尺寸。
 */
function toDashScopeSize(value?: string): string | undefined {
  if (!value) return undefined
  const match = String(value).trim().match(/^(\d+)\s*[x*×X]\s*(\d+)$/)
  return match ? `${match[1]}*${match[2]}` : undefined
}

function buildSubmitBody(input: ImageSubmitInput, params: Record<string, unknown>) {
  const parameters: Record<string, unknown> = { ...params }
  const size = toDashScopeSize(input.resolution || input.size)
  if (size) parameters.size = size
  if (input.imageCount === 1) parameters.n = 1
  const prompt = input.negativePrompt?.trim()
    ? `${input.prompt}\n负面提示词（避免出现）：${input.negativePrompt.trim()}`
    : input.prompt
  return { model: input.model, input: { prompt }, parameters }
}

function authHeaders(connection: ImageConnection) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${connection.apiKey}`,
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 阿里云百炼（DashScope）异步出图协议：提交任务拿 task_id → 轮询到终态。
 * 对上游暴露与同步适配器相同的返回值。
 * 注意：本适配器按官方文档实现，尚未接入真实模型实测。
 */
export const dashscopeAsyncImageAdapter: ImageAdapter = {
  protocol: 'dashscope-async',

  async generate(input, connection) {
    if (!connection.baseUrl || !connection.apiKey) {
      return { success: false, error: '缺少图片模型服务商 API 地址或密钥配置' }
    }
    const base = connection.baseUrl.replace(/\/+$/, '')
    const submitPath = (connection.endpoint?.trim() || DEFAULT_SUBMIT_ENDPOINT).replace(/^\/+/, '')
    const timeoutMs = connection.requestTimeoutMs || DEFAULT_TIMEOUT_MS

    // 1) 提交异步任务
    // 提交前把真正要发出去的东西完整打印出来；开了 dry run 就到此为止，不提交供应商
    const submitBody = buildSubmitBody(input, connection.params || {})
    logImageRequest({
      label: input.label || '图片生成',
      url: `${base}/${submitPath}`, model: input.model,
      prompt: input.prompt, negativePrompt: input.negativePrompt,
      refImageUrls: input.refImageUrls, body: submitBody,
    })
    // dry run：不发请求，但返回占位地址让上层继续——这样同一镜的尾帧请求体也会被打印。
    // 真正的中止由 workflow 在首尾两帧都处理完后统一执行，不会写库。
    if (imageDryRunEnabled()) return { success: true, imageUrls: [DRY_RUN_IMAGE_URL] }

    let taskId = ''
    try {
      const res = await fetch(`${base}/${submitPath}`, {
        method: 'POST',
        headers: { ...authHeaders(connection), 'X-DashScope-Async': 'enable' },
        body: JSON.stringify(submitBody),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const data: any = await res.json().catch(() => null)
      if (!res.ok) {
        return { success: false, error: `API 错误 ${res.status}: ${JSON.stringify(data).slice(0, 300)}` }
      }
      taskId = String(data?.output?.task_id || '')
      if (!taskId) {
        return { success: false, error: `提交任务未返回 task_id：${JSON.stringify(data).slice(0, 300)}` }
      }
    } catch (e: any) {
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError'
      return {
        success: false,
        error: timedOut ? `提交图片任务超时（${Math.round(timeoutMs / 1000)}s）` : `提交图片任务失败：${e?.message || e}`,
      }
    }

    // 2) 轮询到终态
    const deadline = Date.now() + POLL_TIMEOUT_MS
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS)
      let data: any = null
      try {
        const res = await fetch(`${base}/tasks/${encodeURIComponent(taskId)}`, {
          headers: authHeaders(connection),
          signal: AbortSignal.timeout(timeoutMs),
        })
        data = await res.json().catch(() => null)
        if (!res.ok) {
          return { success: false, error: `查询任务失败 ${res.status}: ${JSON.stringify(data).slice(0, 300)}` }
        }
      } catch {
        continue // 单次轮询失败不终止任务，等下一轮
      }
      const status = String(data?.output?.task_status || '')
      if (status === SUCCESS_STATUS) {
        const results = Array.isArray(data?.output?.results) ? data.output.results : []
        const imageUrls = results.flatMap((item: any) =>
          typeof item?.url === 'string' && item.url ? [item.url] : [])
        if (!imageUrls.length) return { success: false, error: '任务成功但没有返回图片 URL' }
        return { success: true, imageUrls }
      }
      if (FAILURE_STATUSES.includes(status)) {
        return { success: false, error: `图片生成失败（${status}）：${data?.output?.message || '无详情'}` }
      }
    }
    return {
      success: false,
      error: `图片生成超时（轮询 ${Math.round(POLL_TIMEOUT_MS / 1000)}s 未完成，task_id=${taskId}）`,
    }
  },
}
