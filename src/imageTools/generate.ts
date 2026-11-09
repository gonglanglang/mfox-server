import { uploadRemoteImageToOSS } from '../config/oss.config'
import { resolveImageModel } from './model-config'
import { resolveImageAdapter, type ImageConnection, type ImageSubmitInput } from './adapters'
import { resolveImageSize } from './size-map'
import { imageDryRunEnabled } from './dry-run'
import { assertPublicHttpUrl, isPublicHttpUrl } from './url-guard'

export interface GenerateImageOptions {
  /** 图片模型 ID（ai_models.model）；缺省时走 .env 兜底配置 */
  model?: string
  prompt: string
  negativePrompt?: string
  /** 档位（与模型 price_config 对齐）；未传时依次回退 quality / size */
  resolution?: string
  quality?: string
  size?: string
  /** 作品宽高比（如 "16:9"）：与档位一起查表得出供应商要的像素值，用于锁定出图比例 */
  aspectRatio?: string
  /** 用途标签，仅用于 dry run 打印时区分环节（如「分镜首帧」「分镜尾帧」） */
  label?: string
  /** 参考图 URL（图生图）；非公网 http(s) 的会被丢弃 */
  refImageUrls?: string[]
  /**
   * 类型化参考图（style=风格参考 / character=角色参考）。同一角色同一次生成
   * 必须复用同一 URL；语义由适配器映射到供应商参数（官方 Seedream API 用 image 数组承载）。
   */
  referenceImages?: { url: string; type?: string }[]
  /** 随机种子：供应商支持时用于复现同一张图 */
  seed?: number
  outputFormat?: 'png' | 'jpeg' | 'webp'
  watermark?: boolean
  /** 期望张数；传 1 时关闭供应商的组图行为 */
  imageCount?: number
  /** 转存 OSS 的目录前缀 */
  ossPrefix?: string
}

export interface GenerateImageResult {
  success: boolean
  /** 已转存到 OSS 的图片地址 */
  imageUrls?: string[]
  error?: string
}

/**
 * 图片生成门面：解析模型 → 按协议选适配器 → 生成 → 校验来源 → 转存 OSS。
 * 供应商差异（端点、请求体、尺寸格式、轮询、结果解析）全部由适配器承担，
 * 本函数只做流程编排。新增供应商 = 后台配 protocol（必要时加一个适配器文件）。
 */
export async function generateImageByModel(options: GenerateImageOptions): Promise<GenerateImageResult> {
  const resolved = await resolveImageModel(options.model, options.resolution || options.quality || options.size)
  const adapter = resolveImageAdapter(resolved.protocol, resolved.provider)
  if (!adapter) {
    throw new Error(`暂不支持的图片调用协议：${resolved.protocol || '(未配置)'}（服务商 ${resolved.provider || '未知'}），请在后台为该服务商选择调用协议`)
  }

  const connection: ImageConnection = {
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    endpoint: resolved.endpoint,
    params: resolved.params,
  }
  const input: ImageSubmitInput = {
    model: resolved.model,
    prompt: options.prompt,
    negativePrompt: options.negativePrompt,
    // 档位（2K/3K…）+ 作品宽高比 → 供应商要的像素值（如 2848x1600）；
    // 查不到时回退成档位字符串，交给模型自行判断尺寸。
    resolution: resolveImageSize(resolved.model, resolved.sizeMap, resolved.resolutionValue, options.aspectRatio) || undefined,
    quality: options.quality,
    size: options.size,
    // 参考图会被转发给供应商，只放行公网 http(s)
    refImageUrls: (options.refImageUrls || []).filter((url) => isPublicHttpUrl(url)),
    // 类型化参考图同样只放行公网地址；类型透传给适配器映射
    referenceImages: (options.referenceImages || [])
      .filter(ref => ref?.url && isPublicHttpUrl(ref.url))
      .map(ref => ({ url: ref.url, type: ref.type })),
    seed: options.seed,
    outputFormat: options.outputFormat,
    watermark: options.watermark,
    imageCount: options.imageCount,
    label: options.label,
  }

  const generated = await adapter.generate(input, connection)
  if (!generated.success || !generated.imageUrls?.length) {
    return { success: false, error: generated.error || '图片生成失败' }
  }

  // dry run 返回的是占位地址（不是真图），跳过外链校验与 OSS 转存，直接交给上层
  if (imageDryRunEnabled()) return { success: true, imageUrls: generated.imageUrls }

  // 供应商返回的地址同样属于外部输入：先校验再下载，避免被牵着请求内网（SSRF）
  const ossUrls: string[] = []
  for (const remoteUrl of generated.imageUrls) {
    const safeUrl = assertPublicHttpUrl(remoteUrl, '供应商图片地址')
    ossUrls.push(await uploadRemoteImageToOSS(safeUrl, options.ossPrefix || 'images/personas'))
  }
  return { success: true, imageUrls: ossUrls }
}
