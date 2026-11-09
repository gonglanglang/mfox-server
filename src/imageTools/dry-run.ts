/**
 * 图片生成 dry run：只打印、不提交
 *
 * 用途：核对真正要发给供应商的参数（模型、prompt、参考图、尺寸档位、采样参数），
 * 确认无误后再正式生成——避免花钱跑出一批参数错误的图。
 *
 * 开关：
 *   IMAGE_DRY_RUN   图片专用（优先）
 *   VIDEO_DRY_RUN   视频专用；未设 IMAGE_DRY_RUN 时图片也会跟随它，
 *                   所以只写一个 VIDEO_DRY_RUN=true 就能同时拦住图片与视频
 *
 * 行为：开启后返回 success=false，workflow 会按"生成失败"处理（退积分、不写库），
 * 因此不会污染已有分镜数据。
 */

/** 是否开启了图片 dry run */
export function imageDryRunEnabled(): boolean {
  const flag = (process.env.IMAGE_DRY_RUN ?? process.env.VIDEO_DRY_RUN ?? '').trim().toLowerCase()
  return flag === 'true' || flag === '1'
}

export interface ImageRequestLog {
  /** 用途说明，便于在日志里区分是哪一步（如"分镜首帧"/"分镜尾帧"） */
  label?: string
  /** 真正要请求的地址 */
  url: string
  model: string
  prompt: string
  negativePrompt?: string
  /** 参考图（图生图）；顺序与 prompt 里的「图N」编号一致 */
  refImageUrls?: string[]
  /** 完整请求体，原样打印便于逐项核对 */
  body: unknown
}

/** 把即将发出的图片生成请求完整打印到终端 */
export function logImageRequest(info: ImageRequestLog): void {
  console.log('════════════ 图片生成请求（提交前确认） ════════════')
  if (info.label) console.log('用途:', info.label)
  console.log('模型:', info.model)
  console.log('URL:', info.url)

  const refs = info.refImageUrls || []
  if (refs.length) {
    console.log('──────── 参考图（与 prompt 里的「图N」编号一致） ────────')
    refs.forEach((u, i) => console.log(`  [图${i + 1}] ${u}`))
  }

  console.log('──────── prompt（模型据此生成画面） ────────')
  console.log(info.prompt || '(空)')

  if (info.negativePrompt) {
    console.log('──────── negative_prompt（要避免的内容） ────────')
    console.log(info.negativePrompt)
  }

  console.log('──────── 完整请求体 ────────')
  try {
    console.log(JSON.stringify(info.body, null, 2))
  } catch {
    console.log(String(info.body))
  }
  console.log('════════════════════════════════════════════════')
}

/**
 * dry run 时交给上层的占位地址。
 *
 * 不直接返回失败，是为了让"一镜两帧"的流程继续跑下去——首帧若不返回图片，
 * 尾帧就永远不会被请求，也就看不到尾帧的请求体。真正的中止由 workflow
 * 在首尾两帧都处理完之后统一执行（抛错 → 退款 → 不写分镜）。
 */
export const DRY_RUN_IMAGE_URL = 'https://dry-run.invalid/placeholder.png'
