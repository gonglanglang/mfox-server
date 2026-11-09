import type { Request, Response } from 'express'
import { sseError } from '../tools/sse'

// ============================================
// 请求参数统一校验工具
// 按字段定义从 params / query / body / headers 取值，
// 必填项缺失（undefined / null / 空串）时返回错误信息。
// ============================================

type ParamSource = 'params' | 'query' | 'body' | 'headers'

export interface ParamFieldSpec {
  /** 参数来源：params / query / body / headers */
  from: ParamSource
  /** 是否必填：缺失 / null / 空串（trim 后）时报错，默认 false */
  required?: boolean
  /** 非必填且缺失时使用的默认值 */
  default?: unknown
  /** 错误提示中使用的名称（默认用字段 key） */
  label?: string
  /** 字符串是否 trim 后再判断/返回 */
  trim?: boolean
}

export interface ValidateResult {
  /** null 表示校验通过；否则为缺失/必填错误信息 */
  error: string | null
  /** 校验通过时的取值结果（key 与传入字段定义一致） */
  data: Record<string, any>
}

/**
 * 校验请求参数。
 *
 * @example
 * const { error, data } = validateRequest(req, {
 *   type:    { from: 'params',  required: true,  label: '任务类型' },
 *   content: { from: 'body',    required: true,  label: '内容', trim: true },
 *   genre:   { from: 'body',    default: '科幻' },
 *   aiModel: { from: 'headers', default: 'default-model' },
 * })
 * if (error) return error(res, error)
 */
export function validateRequest(req: Request, fields: Record<string, ParamFieldSpec>): ValidateResult {
  const data: Record<string, any> = {}
  for (const [key, spec] of Object.entries(fields)) {
    const source = (req[spec.from] || {}) as Record<string, any>
    // headers 的 key 在 Node 中统一转为小写存储（如前端发 aiModel → aimodel）
    const sourceKey = spec.from === 'headers' ? key.toLowerCase() : key
    let value = source[sourceKey]

    if (spec.trim && typeof value === 'string') value = value.trim()

    const isEmpty = value === undefined || value === null || value === ''
    if (isEmpty) {
      if (spec.required) {
        return { error: `缺少参数：${spec.label || key}`, data }
      }
      value = spec.default
    }
    data[key] = value
  }
  return { error: null, data }
}

/**
 * SSE 路由专用校验：验证失败时直接中断 SSE 流（发送 { error } 事件并关闭连接）。
 * 调用前请先 sseInit(res) 设置 SSE 响应头，否则前端无法按 SSE 解析。
 *
 * @example
 * sseInit(res)
 * const { error, data } = validateRequestSSE(req, res, {
 *   content: { from: 'body', required: true, label: '润色思路', trim: true },
 *   aiModel: { from: 'headers', required: true, label: '模型' },
 * })
 * if (error) return // 已中断 SSE，无需再处理
 */
export function validateRequestSSE(
  req: Request,
  res: Response,
  fields: Record<string, ParamFieldSpec>,
): ValidateResult {
  console.log(req.body)
  const result = validateRequest(req, fields)
  if (result.error) sseError(res, result.error)
  return result
}
