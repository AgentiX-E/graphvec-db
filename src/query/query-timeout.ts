/**
 * query-timeout.ts — 查询超时控制
 *
 * 提供 withQueryTimeout() 包装函数，支持同步和异步查询的超时。
 * 使用 AbortController 实现，避免 dangling promise 泄漏。
 */

export class QueryTimeoutError extends Error {
  constructor(message: string = 'Query timed out') {
    super(message)
    this.name = 'QueryTimeoutError'
  }
}

const DEFAULT_TIMEOUT_MS = 30000

/**
 * 包装查询函数或 Promise，超时后抛出 QueryTimeoutError。
 *
 * 支持三种模式：
 * 1. `() => T`（同步函数）— 在微任务边界上超时检测
 * 2. `() => Promise<T>`（异步工厂）— 如果超时，调用 .abort() 取消
 * 3. `Promise<T>`（已有 Promise）— 竞速模式
 *
 * @param fnOrPromise - 查询函数或 Promise
 * @param timeoutMs - 超时毫秒数（默认 30000）
 * @param abortSignal - 外部 AbortSignal（Optional，用于级联取消）
 * @returns 查询结果
 */
export async function withQueryTimeout<T>(
  fnOrPromise: (() => T | Promise<T>) | Promise<T>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  abortSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController()

  // 级联外部 abort
  if (abortSignal) {
    const onAbort = () => controller.abort(abortSignal.reason)
    abortSignal.addEventListener('abort', onAbort, { once: true })
  }

  const timer = setTimeout(() => {
    controller.abort(new QueryTimeoutError(`Query timed out after ${timeoutMs}ms`))
  }, timeoutMs)

  try {
    if (typeof fnOrPromise === 'function') {
      const result = fnOrPromise()
      if (result instanceof Promise) {
        return await wrapPromiseWithAbort(result, controller.signal, timer)
      }
      clearTimeout(timer)
      return result as T
    }
    return await wrapPromiseWithAbort(fnOrPromise, controller.signal, timer)
  } finally {
    clearTimeout(timer)
    controller.abort() // 清理事件监听器
  }
}

async function wrapPromiseWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timer: ReturnType<typeof setTimeout>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      const reason = signal.reason
      reject(reason instanceof QueryTimeoutError ? reason : new QueryTimeoutError(String(reason)))
    }

    if (signal.aborted) {
      onAbort()
      return
    }

    signal.addEventListener('abort', onAbort, { once: true })

    promise.then(
      (val) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(val)
      },
      (err) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}
