import json5 from 'json5'

/**
 * AnimaHub 核心 JSON 自愈解析、校验反馈重试与风格前缀去重工具集
 *
 * 吸收自 AnimaHub (`lib/script-workshop/json.ts`, `retry.ts`, `ImageGenerationModal.tsx`)：
 * 1. 自动剥离推理模型 `<think>...</think>` 思考块与 Markdown 代码围栏
 * 2. 平衡括号提取首个 JSON 对象 `{...}` 或数组 `[...]`（忽略引号内花括号/方括号）
 * 3. 状态机修复字符串内部未转义的真实换行符/制表符，以及 AI 常见的漏逗号、尾随逗号语法瑕疵
 * 4. 带结构化校验错误反馈的指数退避重试器 `retryWithValidation`
 * 5. 全局画风前缀去重 `stripLeadingStylePrefix`（防止生图/重绘时画风词重复注入两次）
 */

/**
 * 移除推理模型输出中的 `<think>...</think>` 块与首尾空白。
 */
export function stripReasoningBlocks(raw: string): string {
  if (!raw || typeof raw !== 'string') return ''
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim()
}

/**
 * 剥离最外层 Markdown 代码块包裹（如 ```json ... ```）。
 */
export function stripMarkdownCodeFence(raw: string): string {
  const cleaned = stripReasoningBlocks(raw)
  const fenced = cleaned.match(/^```(?:json|json5|javascript|ts)?\s*\n?([\s\S]*?)\n?\s*```$/i)
  if (fenced && fenced[1] !== undefined) {
    return fenced[1].trim()
  }
  const inlineFence = cleaned.match(/```(?:json|json5)?\s*\n([\s\S]*?)\n\s*```/i)
  if (inlineFence && inlineFence[1] !== undefined) {
    return inlineFence[1].trim()
  }
  return cleaned
}

/**
 * 扫描并提取文本中第一个括号平衡的 JSON 子串（支持 `{...}` 或 `[...]`）。
 * 若文本被截断未闭合，回退到首尾起止符切片以便后续修复尝试。
 */
export function extractFirstJsonValue(
  text: string,
  expectedRoot?: 'object' | 'array',
): string | null {
  if (!text || typeof text !== 'string') return null
  const cleaned = stripMarkdownCodeFence(text)
  if (!cleaned) return null

  let startIdx = -1
  let openChar: '{' | '[' = '{'
  let closeChar: '}' | ']' = '}'

  if (expectedRoot === 'object') {
    startIdx = cleaned.indexOf('{')
    openChar = '{'
    closeChar = '}'
  } else if (expectedRoot === 'array') {
    startIdx = cleaned.indexOf('[')
    openChar = '['
    closeChar = ']'
  } else {
    const braceIdx = cleaned.indexOf('{')
    const bracketIdx = cleaned.indexOf('[')
    if (braceIdx === -1 && bracketIdx === -1) return null
    if (braceIdx !== -1 && (bracketIdx === -1 || braceIdx < bracketIdx)) {
      startIdx = braceIdx
      openChar = '{'
      closeChar = '}'
    } else {
      startIdx = bracketIdx
      openChar = '['
      closeChar = ']'
    }
  }

  if (startIdx === -1) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = startIdx; i < cleaned.length; i++) {
    const ch = cleaned[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (ch === openChar) {
      depth++
    } else if (ch === closeChar) {
      depth--
      if (depth === 0) {
        return cleaned.slice(startIdx, i + 1)
      }
    }
  }

  const lastClose = cleaned.lastIndexOf(closeChar)
  if (lastClose > startIdx) {
    return cleaned.slice(startIdx, lastClose + 1)
  }
  return null
}

export function extractFirstJsonObject(text: string): string | null {
  return extractFirstJsonValue(text, 'object')
}

export function extractFirstJsonArray(text: string): string | null {
  return extractFirstJsonValue(text, 'array')
}

/**
 * 状态机修复双引号字符串内部未转义的真实换行符与制表符（移植自 AnimaHub `json.ts`）。
 */
export function repairUnescapedNewlinesInStrings(text: string): string {
  const result: string[] = []
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!

    if (escaped) {
      result.push(char)
      escaped = false
      continue
    }

    if (char === '\\') {
      result.push(char)
      escaped = true
      continue
    }

    if (char === '"') {
      inString = !inString
      result.push(char)
      continue
    }

    if (inString) {
      if (char === '\n') {
        result.push('\\n')
        continue
      }
      if (char === '\t') {
        result.push('\\t')
        continue
      }
    }

    result.push(char)
  }

  return result.join('')
}

/**
 * 修复常见的 AI 输出 JSON 语法瑕疵（移植并增强自 AnimaHub `tryRepairJson`）。
 */
export function tryRepairJson(text: string): string {
  let repaired = stripMarkdownCodeFence(text)

  // 0. 统一换行符为 \n
  repaired = repaired.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  // 1. 修复数组对象元素之间缺少逗号: `}\n{` -> `},\n{`
  repaired = repaired.replace(/}(\s*\n\s*){/g, '},$1{')

  // 2. 修复 `]` 后跟 `"key":` 缺少逗号
  repaired = repaired.replace(/](\s*\n\s*)"([^"]+)"\s*:/g, '],$1"$2":')

  // 3. 修复 `"value"` 后跟 `"key":` 缺少逗号
  repaired = repaired.replace(/"(\s*\n\s*)"([^"]+)"\s*:/g, '",$1"$2":')

  // 4. 修复数字 / true / false / null 后跟 `"key":` 缺少逗号
  repaired = repaired.replace(/(\d|\btrue|\bfalse|\bnull)(\s*\n\s*)"([^"]+)"\s*:/g, '$1,$2"$3":')

  // 5. 修复 `}` 后跟 `"key":` 缺少逗号
  repaired = repaired.replace(/}(\s*\n\s*)"([^"]+)"\s*:/g, '},$1"$2":')

  // 6. 移除 `]` 或 `}` 前的尾随逗号
  repaired = repaired.replace(/,\s*([\]}])/g, '$1')

  // 7. 状态机修复双引号字符串内未转义换行符
  repaired = repairUnescapedNewlinesInStrings(repaired)

  return repaired
}

/**
 * 安全解析 AI 返回的 JSON（支持直接解析 → 自动修复解析 → 提取平衡 JSON 块后修复解析 → json5 兜底）。
 */
export function safeJsonParse<T = unknown>(
  text: string,
  expectedRoot?: 'object' | 'array',
): { ok: true; value: T } | { ok: false; error: string } {
  if (!text || typeof text !== 'string' || !text.trim()) {
    return { ok: false, error: 'AI 返回内容为空' }
  }

  const stripped = stripMarkdownCodeFence(text)

  // 1. 原样标准 JSON.parse
  try {
    const value = JSON.parse(stripped) as T
    return { ok: true, value }
  } catch (firstError: any) {
    // 2. 修复后标准 JSON.parse
    try {
      const repaired = tryRepairJson(stripped)
      const value = JSON.parse(repaired) as T
      return { ok: true, value }
    } catch {
      // 3. 提取首个平衡对象/数组后再修复解析
      const extracted = extractFirstJsonValue(stripped, expectedRoot)
      if (extracted) {
        try {
          const value = JSON.parse(tryRepairJson(extracted)) as T
          return { ok: true, value }
        } catch {
          try {
            const value = json5.parse(tryRepairJson(extracted)) as T
            return { ok: true, value }
          } catch {
            // fall through
          }
        }
      }
      // 4. json5 最终尝试（兼容单引号或未加引号的键名）
      try {
        const value = json5.parse(tryRepairJson(stripped)) as T
        return { ok: true, value }
      } catch {
        return { ok: false, error: firstError?.message || 'JSON 解析失败' }
      }
    }
  }
}

export interface RetryWithValidationOptions {
  maxAttempts: number
  baseDelayMs?: number
  onAttempt?: (attempt: number, error: string) => void | Promise<void>
}

/**
 * 带结构化校验与错误反馈注入的 AI 重试器（移植并升级自 AnimaHub `retry.ts`）。
 *
 * `fn(attempt, lastError)` 会收到上一轮失败的具体校验原因 `lastError`，
 * 调用方可将其拼入重试提示词，引导模型精准修正格式或缺失字段。
 */
export async function retryWithValidation<TRaw, TValidated = TRaw>(
  fn: (attempt: number, lastError: string) => Promise<TRaw>,
  validate: (result: TRaw) => { ok: true; value: TValidated } | { ok: false; error: string },
  options: RetryWithValidationOptions,
): Promise<TValidated> {
  const { maxAttempts, baseDelayMs = 400, onAttempt } = options
  let lastError = ''

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const raw = await fn(attempt, lastError)
      const checked = validate(raw)
      if (checked.ok) {
        return checked.value
      }

      lastError = checked.error
      if (attempt < maxAttempts) {
        await onAttempt?.(attempt, lastError)
        if (baseDelayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, baseDelayMs * attempt))
        }
      } else {
        throw new Error(`验证失败（${maxAttempts} 次尝试后）: ${lastError}`)
      }
    } catch (err: any) {
      if (attempt >= maxAttempts) {
        throw err
      }
      lastError = err?.message || String(err) || '未知错误'
      await onAttempt?.(attempt, lastError)
      if (baseDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, baseDelayMs * attempt))
      }
    }
  }

  throw new Error(`重试失败（${maxAttempts} 次尝试后）: ${lastError}`)
}

/**
 * 剥离画面提示词头部已包含的重复画风前缀（移植自 AnimaHub `stripLeadingStylePrefix`）。
 * 防止分镜提示词本身已带画风描述时，生图/重绘节点再次前置拼接 `stylePrompt` 造成权重污染。
 */
export function stripLeadingStylePrefix(prompt: string, stylePrompt?: string): string {
  let out = String(prompt || '').trim()
  if (!out) return ''

  const cleanStyle = String(stylePrompt || '').trim()
  if (!cleanStyle) return out

  const taggedPrefix = `【全局风格】${cleanStyle}`
  let changed = true
  while (changed && out) {
    changed = false
    if (out.toLowerCase().startsWith(taggedPrefix.toLowerCase())) {
      const rest = out.slice(taggedPrefix.length).replace(/^[\s,，。；;:\n]+/, '').trim()
      if (rest && rest !== out) {
        out = rest
        changed = true
      }
    }
    if (out.toLowerCase().startsWith(cleanStyle.toLowerCase())) {
      const rest = out.slice(cleanStyle.length).replace(/^[\s,，。；;:\n]+/, '').trim()
      if (rest && rest !== out) {
        out = rest
        changed = true
      }
    }
  }

  return out
}
