import type { ImageAdapter, ImageSubmitInput } from './types'
import { DRY_RUN_IMAGE_URL, imageDryRunEnabled, logImageRequest } from '../dry-run'

/** 协议默认端点（ai_models.endpoint 留空时使用） */
const DEFAULT_ENDPOINT = '/images/generations'
/** 出图比文本慢，给足超时但不无限等待 */
const DEFAULT_TIMEOUT_MS = 180_000

/**
 * 组装请求体：以 ai_models.params 为基线，本次请求的显式参数覆盖它。
 * 供应商专有字段（sequential_image_generation / watermark / output_format 等）
 * 一律通过 params 配置，不再写死在代码里。
 */
function buildBody(input: ImageSubmitInput, params: Record<string, unknown>) {
  const body: Record<string, unknown> = {
    model: input.model,
    prompt: input.negativePrompt?.trim()
      ? `${input.prompt}\n负面提示词（避免出现）：${input.negativePrompt.trim()}`
      : input.prompt,
    response_format: 'url',
    stream: false,
    ...params,
  }
  const size = input.resolution || input.size || input.quality
  if (size) body.size = size
  if (input.outputFormat) body.output_format = input.outputFormat
  if (input.watermark !== undefined) body.watermark = input.watermark
  // 种子：供应商支持时用于复现（不支持可在模型 params 里覆盖/移除）
  if (input.seed !== undefined) body.seed = input.seed
  if (input.refImageUrls?.length) body.image = input.refImageUrls
  // 类型化参考图（style / character）：官方 Seedream API 用 image 数组承载全部参考图，
  // 风格/角色语义通过 prompt 显式声明（图N 编号与 image 数组顺序一致）。
  if (input.referenceImages?.length && input.refImageUrls?.length) {
    const positions = input.referenceImages.map(ref => {
      const position = input.refImageUrls!.indexOf(ref.url) + 1
      return { position, type: ref.type }
    }).filter(item => item.position > 0)
    if (positions.length) {
      const styleRefs = positions.filter(item => item.type === 'style').map(item => `图${item.position}`)
      const characterRefs = positions.filter(item => item.type === 'character').map(item => `图${item.position}`)
      const rules: string[] = []
      if (styleRefs.length) rules.push(`${styleRefs.join('、')} 为风格参考图：整体沿用其画风、材质质感与色彩倾向`)
      if (characterRefs.length) rules.push(`${characterRefs.join('、')} 为角色参考图：保持人物面部、发型、服饰、体型与年龄一致，禁止改动`)
      if (rules.length) body.prompt = `${body.prompt}\n参考图语义（必须执行）：${rules.join('；')}。`
    }
  }
  // 只要一张时关闭组图，并清掉配套参数（params 里可能预设过）
  if (input.imageCount === 1) {
    body.n = 1
    body.sequential_image_generation = 'disabled'
    delete body.sequential_image_generation_options
  }
  return body
}

/**
 * OpenAI 兼容出图协议：火山方舟（豆包 Seedream）、OpenAI images、
 * 以及各类 OpenAI 兼容代理共用同一套请求/响应形态。
 */
export const openaiImagesAdapter: ImageAdapter = {
  protocol: 'openai-images',

  async generate(input, connection) {
    if (!connection.baseUrl || !connection.apiKey) {
      return { success: false, error: '缺少图片模型服务商 API 地址或密钥配置' }
    }
    const path = (connection.endpoint?.trim() || DEFAULT_ENDPOINT).replace(/^\/+/, '')
    const url = `${connection.baseUrl.replace(/\/+$/, '')}/${path}`
    const timeoutMs = connection.requestTimeoutMs || DEFAULT_TIMEOUT_MS

    // 提交前把真正要发出去的东西完整打印出来；开了 dry run 就到此为止，不提交供应商
    const body = buildBody(input, connection.params || {})
    logImageRequest({
      label: input.label || '图片生成',
      url, model: input.model,
      prompt: input.prompt, negativePrompt: input.negativePrompt,
      refImageUrls: input.refImageUrls, body,
    })
    // dry run：不发请求，但返回占位地址让上层继续——这样同一镜的尾帧请求体也会被打印。
    // 真正的中止由 workflow 在首尾两帧都处理完后统一执行，不会写库。
    if (imageDryRunEnabled()) return { success: true, imageUrls: [DRY_RUN_IMAGE_URL] }

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${connection.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e: any) {
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError'
      return {
        success: false,
        error: timedOut ? `图片生成超时（${Math.round(timeoutMs / 1000)}s）` : `请求失败：${e?.message || e}`,
      }
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      return { success: false, error: `API 错误 ${res.status}: ${errText.slice(0, 300)}` }
    }

    const data: any = await res.json().catch(() => null)
    const items = Array.isArray(data?.data) ? data.data : []
    const imageUrls = items.flatMap((item: any) =>
      typeof item?.url === 'string' && item.url ? [item.url] : [])
    if (!imageUrls.length) return { success: false, error: 'API 返回了数据但没有图片 URL' }
    return { success: true, imageUrls }
  },
}
