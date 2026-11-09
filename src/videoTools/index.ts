// ============================================
// videoTools 统一出口
// 视频生成按「协议适配器」分发：DB 配置决定用哪套协议，代码只提供适配器实现。
// ============================================
export { generateVideoByModel } from './generate'
export type { GenerateVideoOptions } from './generate'
export { resolveVideoModel, normalizeTiers } from './model-config'
export type { ModelTier } from './model-config'
export { resolveVideoAdapter } from './adapters'
export type { VideoAdapter, VideoConnection, VideoSubmitInput, VideoTaskResult, VideoMediaItem } from './adapters'
