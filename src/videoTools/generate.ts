import { modifyPanelInTx } from '../mysqlDb/panel'
import { resolveVideoModel } from './model-config'
import { resolveVideoAdapter, type VideoConnection, type VideoSubmitInput, type VideoTaskResult } from './adapters'
import { uploadRemoteFileToOSS } from '../config/oss.config'
import { collectInputs, validateParams, type VideoMode } from '../pipeline/model-schema'

export interface GenerateVideoOptions {
  /** 上游 workflow 组装好的多模态内容（prompt + 素材） */
  content: { prompt: string; media: { type?: string; url: string; role?: string }[] }
  /** 视频生成模式（modeType：text2video / singleImage2video / frames2video / image2video 等） */
  mode?: VideoMode | string
  /** 可选传入原始镜头对象，供 collectInputs 自动组装与校验 */
  shot?: Record<string, any>
  /** 视频模型 ID（ai_models.model） */
  model: string
  quality?: string
  resolution?: string
  ratio?: string
  duration?: number
  /** 提供时会把供应商任务 ID 写回分镜，便于人工续查 */
  chapterId?: number
  panelIdx?: number
}

/**
 * 分镜视频生成门面：解析模型 → 按协议选适配器 → 提交 → 记录任务 ID → 轮询 → 转存 OSS。
 * 供应商差异（端点、请求体、状态词表、结果解析）全部由适配器承担，本函数只做流程编排。
 */
export async function generateVideoByModel(options: GenerateVideoOptions): Promise<VideoTaskResult> {
  // 档位（分辨率）与价格同源：优先用 resolution，兼容旧的 quality 参数
  const resolved = await resolveVideoModel(options.model, options.resolution || options.quality)
  const adapter = resolveVideoAdapter(resolved.protocol, resolved.provider, resolved.baseUrl, resolved.endpoint)
  if (!adapter) {
    throw new Error(`暂不支持的视频调用协议：${resolved.protocol || '(未配置)'}（服务商 ${resolved.provider || '未知'}），请在后台为该服务商选择调用协议`)
  }

  const connection: VideoConnection = {
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    endpoint: resolved.endpoint,
    params: resolved.params,
  }
  let effectivePrompt = options.content?.prompt || ''
  let effectiveMedia = Array.isArray(options.content?.media)
    ? options.content.media.map(item => ({ type: item.type, url: item.url, ...(item.role ? { role: item.role } : {}) }))
    : []
  let effectiveMode = options.mode ? String(options.mode) : undefined

  if (options.mode && resolved.capabilities) {
    const paramCheck = validateParams(resolved.capabilities, {
      mode: options.mode,
      duration: options.duration,
      aspectRatio: options.ratio,
    })
    if (!paramCheck.valid) {
      throw new Error(paramCheck.errors.join('；'))
    }
    effectiveMode = paramCheck.normalized.mode
  }
  if (options.shot && resolved.capabilities) {
    const collected = collectInputs(options.shot, effectiveMode, resolved.capabilities)
    effectiveMode = collected.mode
    if (!effectivePrompt) effectivePrompt = collected.prompt
    if (effectiveMedia.length === 0) {
      effectiveMedia = collected.media.map(m => ({ type: m.type, url: m.url, role: m.role }))
    }
  }

  const input: VideoSubmitInput = {
    ...(effectiveMode ? { mode: effectiveMode } : {}),
    model: resolved.model,
    prompt: effectivePrompt,
    media: Array.isArray(options.content?.media)
      ? effectiveMedia
      : [],
    duration: options.duration,
    resolution: resolved.resolutionValue || undefined,
    ratio: options.ratio,
  }

  const submitted = await adapter.submit(input, connection)
  if (!submitted.success || !submitted.taskId) return submitted
  const taskId = submitted.taskId

  // 记录供应商任务 ID（失败不阻断主流程，仅用于人工续查）
  if (options.chapterId != null && options.panelIdx != null) {
    try {
      await modifyPanelInTx(options.chapterId, options.panelIdx, async (panel) => {
        panel.taskId = taskId
        return panel
      }) as any
    } catch (e: any) {
      console.warn(`存储供应商视频任务 ID 失败: ${e.message}`)
    }
  }

  const polled = await adapter.poll(taskId, connection)
  if (!polled.success || !polled.videoUrl) return polled

  try {
    const ossUrl = await uploadRemoteFileToOSS(polled.videoUrl, 'videos/frames')
    return { success: true, videoUrl: ossUrl, taskId }
  } catch (e: any) {
    return { success: false, error: `视频转存 OSS 失败: ${e.message}`, taskId }
  }
}
