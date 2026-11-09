import type { ImageAdapter } from './types'
import { openaiImagesAdapter } from './openai-images'
import { dashscopeAsyncImageAdapter } from './dashscope'

/**
 * 按协议选择图片适配器。
 * - 新增同协议供应商：只加后台配置（protocol 选对应协议），零代码；
 * - 同一火山引擎供应商若 protocol 设为 volcengine-ark，其下属图片模型自动走 openai-images。
 */
const ADAPTERS: Record<string, ImageAdapter> = {
  [openaiImagesAdapter.protocol]: openaiImagesAdapter,
  'volcengine-ark': openaiImagesAdapter,
  'openai-chat': openaiImagesAdapter,
  [dashscopeAsyncImageAdapter.protocol]: dashscopeAsyncImageAdapter,
}

/** 历史数据（protocol 未填）时按服务商标识兜底推断 */
const PROVIDER_FALLBACK: Record<string, string> = {
  aliyun: 'dashscope-async',
  dashscope: 'dashscope-async',
  volcengine: 'openai-images',
  ark: 'openai-images',
  doubao: 'openai-images',
  seedance: 'openai-images',
  seedream: 'openai-images',
  huobao: 'openai-images',
  'ai hub': 'openai-images',
}

export function resolveImageAdapter(protocol?: string, provider?: string): ImageAdapter | null {
  const key = (protocol || '').trim() || PROVIDER_FALLBACK[(provider || '').trim().toLowerCase()] || ''
  return ADAPTERS[key] || null
}

export type { ImageAdapter, ImageConnection, ImageSubmitInput, ImageResult } from './types'
