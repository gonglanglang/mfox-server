// ============================================
// 图片生成适配器接口
// 边界约定：DB 只放"可枚举标量"（api_url / endpoint / params / 档位映射），
// 各协议的请求体布局、尺寸格式、结果解析、轮询策略一律留在适配器代码里。
// ============================================

/** 连接信息（由 resolveImageModel 从 ai_service_configs + ai_models 解析而来） */
export interface ImageConnection {
  baseUrl: string
  apiKey: string
  /** 接口路径（相对 baseUrl）；留空时适配器使用协议默认路径 */
  endpoint?: string
  /** 模型固定参数（ai_models.params），与本次请求显式参数合并后发送 */
  params?: Record<string, unknown>
  /** 单次 HTTP 请求超时（毫秒），缺省由适配器决定 */
  requestTimeoutMs?: number
}

export interface ImageSubmitInput {
  /** 供应商模型名（ai_models.model） */
  model: string
  prompt: string
  negativePrompt?: string
  /** 已按档位归一过的供应商取值（如 2K / 2048x2048） */
  resolution?: string
  /** 兼容旧调用：未传 resolution 时按档位使用 */
  quality?: string
  /** 兼容旧调用：未传 resolution 时的尺寸 */
  size?: string
  /** 参考图 URL（图生图）；调用方已做过公网校验 */
  refImageUrls?: string[]
  /**
   * 类型化参考图（如火山即梦/Seedream）：style=风格参考（IP-Adapter/风格迁移）、
   * character=角色参考（人物一致性）。同一角色应复用同一 URL。
   * 具体供应商参数形态由适配器映射（官方 Seedream API 用 image 数组 + prompt 语义承载）。
   */
  referenceImages?: { url: string; type?: string }[]
  /** 随机种子：供应商支持时用于复现同一张图 */
  seed?: number
  outputFormat?: 'png' | 'jpeg' | 'webp'
  watermark?: boolean
  /** 期望张数；传 1 时关闭供应商的组图行为 */
  imageCount?: number
  /** 用途标签，仅用于 dry run 打印时区分是哪个环节（如「分镜首帧」「分镜尾帧」） */
  label?: string
}

export interface ImageResult {
  success: boolean
  /** 供应商返回的原始图片 URL（转存 OSS 之前） */
  imageUrls?: string[]
  error?: string
}

export interface ImageAdapter {
  /** 协议标识（与 ai_service_configs.protocol 对应） */
  readonly protocol: string
  /**
   * 生成图片。同步协议一次请求即返回；异步协议（如阿里云）在内部完成
   * "提交任务 + 轮询"，对上游暴露同一个返回值。
   */
  generate(input: ImageSubmitInput, connection: ImageConnection): Promise<ImageResult>
}
