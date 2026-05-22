/**
 * Retry — 通用重试逻辑
 *
 * 支持指数退避和最大重试次数
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number } = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3
  const baseDelayMs = options.baseDelayMs ?? 100
  const maxDelayMs = options.maxDelayMs ?? 5000

  let lastError: Error | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err as Error
      if (attempt < maxRetries) {
        const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs)
        // jitter: 随机 50%~100%，防止惊群效应
        const jittered = delay * (0.5 + Math.random() * 0.5)
        await new Promise(r => setTimeout(r, Math.round(jittered)))
      }
    }
  }

  throw lastError
}
