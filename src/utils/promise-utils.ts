/**
 * Promise utils — 并发控制
 */

/**
 * 限制并发数执行异步函数
 */
export async function parallelLimit<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  limit: number
): Promise<void> {
  const results: Promise<void>[] = []
  const executing = new Set<Promise<void>>()

  for (const item of items) {
    const p = fn(item).finally(() => executing.delete(p))
    results.push(p)
    executing.add(p)

    if (executing.size >= limit) {
      await Promise.race(executing)
    }
  }

  await Promise.all(results)
}

/**
 * 带超时的 Promise
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, msg?: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(msg || `Timeout after ${ms}ms`)), ms)
    ),
  ])
}

/**
 * 重试直到条件满足
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number = 5000,
  intervalMs: number = 100
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return
    await new Promise(r => setTimeout(r, intervalMs))
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`)
}
