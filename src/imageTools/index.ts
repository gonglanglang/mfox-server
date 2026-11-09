// ============================================
// 图片生成模块（与 videoTools 同构）
// - 协议分发：ai_service_configs.protocol → adapters/
// - 模型解析：ai_models（endpoint / params / price_config）
// - 上游只需调用 generateImageByModel
// ============================================

export { generateImageByModel } from './generate'
export type { GenerateImageOptions, GenerateImageResult } from './generate'
export { resolveImageModel } from './model-config'
export type { ResolvedImageModel } from './model-config'
export { resolveImageAdapter } from './adapters'
export type { ImageAdapter, ImageConnection, ImageSubmitInput, ImageResult } from './adapters'
export { assertPublicHttpUrl, isPublicHttpUrl } from './url-guard'
