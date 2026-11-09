/**
 * 图片尺寸映射：档位（2K/3K/4K…）+ 宽高比 → 供应商要的「宽x高」像素值
 *
 * 为什么不按比例算：
 *   2K 的 1:1  = 2048x2048 = 4,194,304 像素
 *   2K 的 16:9 = 2848x1600 = 4,556,800 像素
 * 两者总像素并不相等，说明这些是实测标准值而非等比缩放。所以只能照抄，不能推导。
 *
 * 取值优先级：
 *   ① 后台 ai_models.size_map（按模型分别配置，改配置即可适配新模型）
 *   ② 代码内置兜底表（豆包 Seedream 系列，数据取自官方文档）
 *   ③ 都查不到 → 回退成档位字符串本身（如 "2K"），交给模型自行判断尺寸
 */

/** 宽高比 → 像素值 */
export type AspectSizeTable = Record<string, string>
/** 档位 → 宽高比 → 像素值 */
export type SizeMap = Record<string, AspectSizeTable>

const SEEDREAM_ASPECTS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'] as const

/** 按宽高比顺序展开成表，避免手写时错位；列数不符立即报错，免得悄悄漏掉某个比例 */
function row(pixels: string[]): AspectSizeTable {
  if (pixels.length !== SEEDREAM_ASPECTS.length) {
    throw new Error(`尺寸表列数应为 ${SEEDREAM_ASPECTS.length}，实际 ${pixels.length}`)
  }
  const table: AspectSizeTable = {}
  SEEDREAM_ASPECTS.forEach((ratio, i) => { table[ratio] = pixels[i]! })
  return table
}

/**
 * 豆包 Seedream 5.0 lite / 4.5（2K / 3K / 4K）
 * 取自官方文档「采用方式 1 时，模型实际映射的宽高像素参考值」
 */
const SEEDREAM_LITE: SizeMap = {
  '2K': row(['2048x2048', '2304x1728', '1728x2304', '2848x1600', '1600x2848', '2496x1664', '1664x2496', '3136x1344']),
  '3K': row(['3072x3072', '3456x2592', '2592x3456', '4096x2304', '2304x4096', '3744x2496', '2496x3744', '4704x2016']),
  '4K': row(['4096x4096', '4704x3520', '3520x4704', '5504x3040', '3040x5504', '4992x3328', '3328x4992', '6240x2656']),
}

/** 豆包 Seedream 5.0 pro / flash（1K / 1.5K / 2K）——注意与 lite 的 2K 值不同 */
const SEEDREAM_PRO: SizeMap = {
  '1K': row(['1024x1024', '1152x864', '864x1152', '1424x800', '800x1424', '1248x832', '832x1248', '1568x672']),
  '1.5K': row(['1536x1536', '1792x1344', '1344x1792', '2048x1152', '1152x2048', '1872x1248', '1248x1872', '2352x1008']),
  '2K': row(['2048x2048', '2368x1776', '1776x2368', '2816x1584', '1584x2816', '2496x1664', '1664x2496', '3136x1344']),
}

/** 豆包 Seedream 4.0（1K / 2K / 4K） */
const SEEDREAM_40: SizeMap = {
  '1K': row(['1024x1024', '1152x864', '864x1152', '1280x720', '720x1280', '1248x832', '832x1248', '1512x648']),
  '2K': row(['2048x2048', '2304x1728', '1728x2304', '2848x1600', '1600x2848', '2496x1664', '1664x2496', '3136x1344']),
  '4K': row(['4096x4096', '4704x3520', '3520x4704', '5504x3040', '3040x5504', '4992x3328', '3328x4992', '6240x2656']),
}

/**
 * 内置兜底表：按模型名（小写包含匹配）选表。
 * 顺序敏感——先匹配 "5.0-pro" 再匹配 "5.0"，避免 flash/pro 被 lite 抢走。
 */
const BUILTIN: { match: (model: string) => boolean; table: SizeMap }[] = [
  { match: m => /5[._-]?0[._-]?(pro|flash)/.test(m), table: SEEDREAM_PRO },
  { match: m => /5[._-]?0[._-]?lite/.test(m), table: SEEDREAM_LITE },
  { match: m => /4[._-]?5/.test(m), table: SEEDREAM_LITE },
  { match: m => /4[._-]?0/.test(m), table: SEEDREAM_40 },
]

/** 把后台传来的 JSON 解析成 SizeMap（非法结构直接忽略） */
export function asSizeMap(value: unknown): SizeMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: SizeMap = {}
  for (const [tier, ratios] of Object.entries(value as Record<string, unknown>)) {
    if (!ratios || typeof ratios !== 'object' || Array.isArray(ratios)) continue
    const table: AspectSizeTable = {}
    for (const [ratio, size] of Object.entries(ratios as Record<string, unknown>)) {
      if (typeof size === 'string' && size.trim()) table[ratio.trim()] = size.trim()
    }
    if (Object.keys(table).length) out[tier.trim()] = table
  }
  return out
}

/** 内置兜底表查询 */
function builtinSizeMap(model: string): SizeMap {
  const key = String(model || '').toLowerCase()
  return BUILTIN.find(item => item.match(key))?.table || {}
}

/**
 * 解析最终要填进 size 的值。
 *
 * @param model       模型 ID（ai_models.model），用于选内置兜底表
 * @param configured  后台配置的 size_map（优先）
 * @param tier        档位取值（ai_models.price_config 的 value，如 "2K"）
 * @param aspectRatio 作品宽高比（如 "16:9"）
 * @returns 像素值（如 "2848x1600"）；查不到时原样返回 tier（如 "2K"），由模型自行判断
 */
export function resolveImageSize(
  model: string,
  configured: unknown,
  tier: string,
  aspectRatio?: string,
): string {
  const wantedTier = String(tier || '').trim()
  const wantedRatio = String(aspectRatio || '').trim()
  if (!wantedTier) return ''
  if (!wantedRatio) return wantedTier

  for (const table of [asSizeMap(configured), builtinSizeMap(model)]) {
    const size = table[wantedTier]?.[wantedRatio]
    if (size) return size
  }
  // 档位或比例不在表里：回退成档位字符串，至少保证请求能发出去
  return wantedTier
}
