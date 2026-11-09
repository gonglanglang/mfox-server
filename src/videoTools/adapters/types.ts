// ============================================
// 视频生成适配器接口
// 边界约定：DB 只放"可枚举标量"（api_url / endpoint / params / 档位映射），
// 各协议的请求体布局、状态词表、结果解析、退避策略一律留在适配器代码里。
// ============================================

/** 连接信息（由 resolveVideoModel 从 ai_service_configs + ai_models 解析而来） */
export interface VideoConnection {
  baseUrl: string
  apiKey: string
  /** 接口路径（相对 baseUrl）；留空时适配器使用协议默认路径 */
  endpoint?: string
  /** 模型固定参数（ai_models.params），与用户选择项合并后发送 */
  params?: Record<string, unknown>
}

/** 一个多模态素材项（图片 / 音频 / 视频参考） */
export interface VideoMediaItem {
  type?: string
  url: string
  role?: string
}

export interface VideoSubmitInput {
  /** 供应商模型名（ai_models.model） */
  model: string
  prompt: string
  /** 多模态素材，顺序与 prompt 里的"图N / 音频N"编号对应 */
  media: VideoMediaItem[]
  mode?: string
  duration?: number
  /** 已按档位映射过的供应商取值（如 720P / 1080P） */
  resolution?: string
  quality?: string
  ratio?: string
}

export interface VideoTaskResult {
  success: boolean
  videoUrl?: string
  taskId?: string
  error?: string
}

export interface VideoAdapter {
  /** 协议标识（与 ai_service_configs.protocol 对应） */
  readonly protocol: string
  /** 提交生成任务 */
  submit(input: VideoSubmitInput, connection: VideoConnection): Promise<VideoTaskResult>
  /** 轮询任务直到完成/失败/超时，成功时返回供应商原始视频 URL */
  poll(taskId: string, connection: VideoConnection, onStatus?: (status: string, attempt: number) => void): Promise<VideoTaskResult>
}
