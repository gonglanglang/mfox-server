// ============================================
// 视口宽高比白名单
// 与前端 ai-comic-web/src/renderer/src/config/constants.ts 的 ASPECT_RATIOS 保持一致；
// 分辨率（清晰度）不在这里定，由所选模型决定。
// ============================================
export const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'] as const

export const DEFAULT_ASPECT_RATIO = '16:9'

/** 规范化宽高比：非法或缺失返回 undefined，由调用方决定忽略还是报错 */
export function normalizeAspectRatio(value: unknown): string | undefined {
  return typeof value === 'string' && (ASPECT_RATIOS as readonly string[]).includes(value)
    ? value
    : undefined
}
