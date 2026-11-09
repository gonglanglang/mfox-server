import type { Response } from 'express'

// ============================================
// SSE 流式响应工具
// 与 response.ts（普通 JSON 请求的 success/error）对应，
// 这里提供 SSE 流的初始化、发送与中断（正常结束 / 出错中断）。
// ============================================

/** 初始化 SSE 响应头（调用后应立即 flush，让前端建立连接） */
export function sseInit(res: Response) {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // 禁用 nginx 缓冲，保证逐条推送
  if (typeof res.flushHeaders === 'function') res.flushHeaders()
}

/** 发送一条 SSE 事件（自动 JSON 序列化） */
export function sseSend(res: Response, data: unknown) {
  if (res.writableEnded) return
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

/** 正常结束 SSE 流（发送 [DONE] 标记后关闭） */
export function sseEnd(res: Response) {
  if (res.writableEnded) return
  try {
    res.write('data: [DONE]\n\n')
  } catch { /* 连接可能已断开，忽略 */ }
  res.end()
}

/**
 * 出错时中断 SSE 流：先发送 { error } 事件通知前端，再关闭连接。
 * 前端应识别 error 事件并走 onError 回调（见 sse.ts 前端示例）。
 */
export function sseError(res: Response, message: string) {
  if (res.writableEnded) return
  try {
    res.write(`data: ${JSON.stringify({ error: message })}\n\n`)
  } catch { /* 连接可能已断开，忽略 */ }
  res.end()
}
