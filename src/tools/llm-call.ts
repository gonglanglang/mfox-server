// ============================================
// LLM 调用的时间预算工具
// 约定：超时错误必须能区分“单次调用超出上限”与“阶段预算已耗尽”，
// 并在消息里带上允许秒数与剩余预算。历史缺陷：两种情形抛同一句话，日志无法归因。
// ============================================

/**
 * 单次调用的硬上限：超时后 abort 请求并按 label 抛出可读错误。
 * Promise.race 已为 run(...) 附加 reaction，abort 造成的 reject 不会变成未处理拒绝；
 * 但若供应商忽略 abortSignal，后台请求仍会继续，直到它自行结束。
 */
export function boundedPromptCall<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const seconds = Math.max(1, Math.round(Math.max(1, timeoutMs) / 1000))
        reject(new Error(`${label} 超时（允许 ${seconds}s），已停止本轮请求`))
        controller.abort()
      }, Math.max(1, timeoutMs))
    }),
    run(controller.signal),
  ]).finally(() => { clearTimeout(timer) })
}

/**
 * 阶段预算：同一阶段内的多次调用共享总时限。
 * 预算耗尽时立即报错，而不是发出一个必然超时的请求（“剩余预算 0s 超时”掩盖真实原因）。
 */
export class PromptBudget {
  private readonly deadline: number
  constructor(private readonly stage: string, private readonly totalMs: number) {
    this.deadline = Date.now() + totalMs
  }

  /** 距预算耗尽的剩余毫秒数（可能为负） */
  get remainingMs(): number {
    return this.deadline - Date.now()
  }

  /** 至今已消耗的毫秒数 */
  get elapsedMs(): number {
    return this.totalMs - this.remainingMs
  }

  /**
   * 在预算内执行一次调用：上限取 min(maxMs, 剩余预算)。
   * @param label 阶段内可读标签（会出现在超时消息里）
   * @param maxMs 本次调用的期望上限
   */
  call<T>(label: string, run: (signal: AbortSignal) => Promise<T>, maxMs: number): Promise<T> {
    const remaining = this.remainingMs
    if (remaining <= 0) {
      throw new Error(
        `${this.stage} 总预算 ${Math.round(this.totalMs / 1000)}s 已耗尽，${label} 未执行`,
      )
    }
    const allowed = Math.min(maxMs, remaining)
    return boundedPromptCall(run, allowed, `${label}（剩余预算 ${Math.round(remaining / 1000)}s）`)
  }
}
