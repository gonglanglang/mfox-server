import type { VideoAdapter } from './types'
import { aliyunVideoAdapter } from './aliyun'
import { volcengineVideoAdapter } from './volcengine'

/**
 * 按协议选择视频适配器。
 * - 新增同协议供应商：只加后台配置（protocol 选对应协议），零代码；
 * - 同一供应商下同时挂载文本/图片/视频模型时，若服务商 protocol 填了 openai-images / openai-chat，
 *   也能根据 endpoint / provider / baseUrl 智能匹配到正确的视频适配器。
 */
const ADAPTERS: Record<string, VideoAdapter> = {
  [aliyunVideoAdapter.protocol]: aliyunVideoAdapter,
  [volcengineVideoAdapter.protocol]: volcengineVideoAdapter,
  seedance: volcengineVideoAdapter,
  'ark-async': volcengineVideoAdapter,
}

/** 历史数据或同供应商跨模态共用时按服务商标识推断 */
const PROVIDER_FALLBACK: Record<string, string> = {
  aliyun: 'dashscope-async',
  dashscope: 'dashscope-async',
  volcengine: 'volcengine-ark',
  ark: 'volcengine-ark',
  doubao: 'volcengine-ark',
  seedance: 'volcengine-ark',
  huobao: 'volcengine-ark',
  'ai hub': 'volcengine-ark',
}

export function resolveVideoAdapter(
  protocol?: string,
  provider?: string,
  baseUrl?: string,
  endpoint?: string,
): VideoAdapter | null {
  const ep = String(endpoint || '').trim().toLowerCase()
  if (ep.includes('/contents/generations/tasks')) return volcengineVideoAdapter
  if (ep.includes('/video-generation/video-synthesis')) return aliyunVideoAdapter

  const proto = String(protocol || '').trim()
  if (ADAPTERS[proto]) return ADAPTERS[proto]

  const provKey = String(provider || '').trim().toLowerCase()
  if (PROVIDER_FALLBACK[provKey]) return ADAPTERS[PROVIDER_FALLBACK[provKey]] || null

  const url = String(baseUrl || '').trim().toLowerCase()
  if (url.includes('volces.com') || url.includes('volcengine')) return volcengineVideoAdapter
  if (url.includes('aliyuncs.com') || url.includes('dashscope')) return aliyunVideoAdapter

  return null
}

export type { VideoAdapter, VideoConnection, VideoSubmitInput, VideoTaskResult, VideoMediaItem } from './types'
