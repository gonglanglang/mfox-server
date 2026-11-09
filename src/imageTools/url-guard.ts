/**
 * 外部图片地址防护：只允许公网 http(s)。
 *
 * 用途有二：
 * 1) 参考图（调用方传入）会被转发给供应商；
 * 2) 供应商返回的图片地址会被我们下载转存 OSS。
 * 两处都是"外部输入驱动我们发起请求"，必须挡掉 file:// 与内网地址（SSRF / 本地文件读取）。
 */

/** 内网 / 保留地址段（主机名或 IPv4/IPv6 前缀） */
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local
  /^::1$/,
  /^\[::1\]$/,
  /^fe80:/i,
  /^fc00:/i,
  /^fd00:/i,
]

/** 校验并返回规范化的 URL；不合法时抛错（由调用方决定是拦截还是记录） */
export function assertPublicHttpUrl(raw: string, label: string): string {
  let url: URL
  try {
    url = new URL(String(raw))
  } catch {
    throw new Error(`${label}不是合法地址：${String(raw).slice(0, 120)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label}只支持 http(s) 协议：${url.protocol}`)
  }
  const host = url.hostname.toLowerCase()
  if (BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    throw new Error(`${label}不能指向本机或内网地址：${host}`)
  }
  return url.toString()
}

/** 非抛错版本：用于过滤调用方传入的候选列表 */
export function isPublicHttpUrl(raw: unknown): boolean {
  if (typeof raw !== 'string' || !raw.trim()) return false
  try {
    assertPublicHttpUrl(raw, '地址')
    return true
  } catch {
    return false
  }
}
