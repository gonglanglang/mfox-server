import { noopObserve } from '@mastra/core/tools'
import { seedreamTool } from '../mastra/tools/seedream-tool'

/** 出图参考图（图生图输入 / 风格 / 角色 / 其它内容）语义类型 */
export type FrameReferenceType = 'init' | 'style' | 'character' | 'content'

export interface GenerateFrameCharacterReference {
  url: string
  role_id?: number | string
}

export interface GenerateFrameParams {
  prompt: string
  negative_prompt?: string
  /** 全局风格参考图（作品画风的 effect_image） */
  style_reference?: string
  /** 出场角色参考图；同一角色在同一次生成里复用同一张图（调用方保证 URL 稳定） */
  character_references?: GenerateFrameCharacterReference[]
  /** 其它内容参考图（场景、道具等），排在最后 */
  content_references?: { url: string }[]
  /**
   * 图生图输入图：链式生成时传上一帧 / 本镜首帧。
   * 当前火山 Seedream 协议没有强度参数，该图会作为参考图传入（见 init_strength 说明）。
   */
  init_image?: string
  /**
   * 0~1，越小越接近输入图。
   * 供应商支持时才生效；火山 Seedream 无此参数，会退化为"输入帧作为参考图 + prompt 描述终态"。
   */
  init_strength?: number
  /** 等价的降噪强度（同上，供应商不支持时仅记录） */
  denoise?: number
  /** 显式像素尺寸；未传时用 resolution / aspectRatio */
  width?: number
  height?: number
  /** 复现用的种子；未传则自动生成并随返回值给出 */
  seed?: number
  /** 是否把 seed 透传给供应商（供应商不支持 seed 参数时可关掉） */
  passSeed?: boolean
  // ── 供应商参数（与现有出图链路一致）──
  model?: string
  resolution?: string
  quality?: string
  aspectRatio?: string
  label?: string
}

export interface GenerateFrameResult {
  url: string
  /** 本次使用的种子（未传 seed 时为自动生成），用于复现与断链排查 */
  seed: number
  /** 实际随请求传出的参考图，顺序即 prompt 中「图N」的编号顺序 */
  references: Array<{ url: string; type: FrameReferenceType }>
}

const MAX_SEED = 2 ** 31 - 1

/** 生成一个正整数 seed（复现同一帧用）。 */
export function randomFrameSeed(): number {
  return Math.floor(Math.random() * MAX_SEED) + 1
}

/**
 * 出图统一入口：分镜重绘链路使用（提取链路只写 prompt，不调用本函数）。
 *
 * 参考图顺序固定为：init_image（图生图输入）→ style_reference（画风）→ character_references（角色）
 * → content_references（场景/道具等内容图），与 prompt 中的「图N」编号一致；调用方按同一顺序、
 * 同一去重规则构造 prompt 标签，即可保证编号不错位。
 * 图生图强度（init_strength / denoise）保留在接口里：供应商支持时生效，不支持时退化为参考图语义。
 */
export async function generateFrame(params: GenerateFrameParams): Promise<GenerateFrameResult> {
  if (!seedreamTool.execute) throw new Error('图片生成工具未配置')
  const prompt = String(params.prompt || '').trim()
  if (!prompt) throw new Error('出图 prompt 不能为空')
  const seed = Number.isFinite(params.seed) ? Number(params.seed) : randomFrameSeed()

  const collected: Array<{ url: string; type: FrameReferenceType }> = []
  const push = (url: unknown, type: FrameReferenceType) => {
    const value = String(url || '').trim()
    if (value) collected.push({ url: value, type })
  }
  push(params.init_image, 'init')
  push(params.style_reference, 'style')
  for (const ref of params.character_references || []) push(ref?.url, 'character')
  for (const ref of params.content_references || []) push(ref?.url, 'content')

  // 同一 URL 只传一次（输入帧与角色图可能是同一张）
  const seen = new Set<string>()
  const references = collected.filter(ref => !seen.has(ref.url) && seen.add(ref.url))

  if (params.init_strength != null || params.denoise != null) {
    console.warn('[frame-gen] 当前图片协议不支持强度参数，'
      + `init_strength=${params.init_strength ?? '-'} / denoise=${params.denoise ?? '-'} 未生效，`
      + '已退化为「输入帧作为参考图 + prompt 描述终态」')
  }

  const resolution = params.resolution
    || (params.width && params.height ? `${params.width}x${params.height}` : undefined)

  const result = await seedreamTool.execute({
    prompt,
    negativePrompt: params.negative_prompt,
    model: params.model,
    quality: params.quality,
    resolution,
    aspectRatio: params.aspectRatio,
    refImageUrl: references.map(ref => ref.url),
    referenceImages: references
      .filter(ref => ref.type === 'style' || ref.type === 'character')
      .map(ref => ({ url: ref.url, type: ref.type as 'style' | 'character' })),
    seed: params.passSeed === false ? undefined : seed,
    imageCount: 1,
    outputFormat: 'jpeg',
    watermark: false,
    label: params.label,
  }, { observe: noopObserve })

  if (!result || !('success' in result)) throw new Error('图片生成返回格式无效')
  const url = result.imageUrl || result.images?.[0]
  if (!result.success || !url?.trim()) throw new Error(result.error || '未生成图片URL')
  return { url, seed, references }
}
