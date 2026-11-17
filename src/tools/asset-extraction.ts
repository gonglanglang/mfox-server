import { safeJsonParse } from './animahub-json'

export function parseAssetArray(raw: string): unknown[] {
  const parsed = safeJsonParse(String(raw ?? ''), 'array')
  if (!parsed.ok) {
    throw new Error(`素材 JSON 解析失败: ${parsed.error}`)
  }
  const value = parsed.value
  if (!Array.isArray(value)) throw new Error('素材输出必须是 JSON 数组')
  return value
}

export function resolveCharacterIds(values: unknown[], roles: { id: number; name: string }[]) {
  const ids: number[] = []
  const unresolved: unknown[] = []
  for (const value of values) {
    const matches = roles.filter(role => typeof value === 'number' ? role.id === value : role.name === value)
    if (matches.length === 1) ids.push(matches[0]!.id)
    else unresolved.push(value)
  }
  return { ids: [...new Set(ids)], unresolved }
}
