/**
 * QuerySlowLog — 慢查询拦截器
 *
 * 记录所有耗时超过阈值的查询
 * 阈值默认 100ms
 */
export class QuerySlowLog {
  private thresholdMs: number
  private logs: { op: string; duration: number; timestamp: number; user?: string }[] = []
  private maxEntries: number

  constructor(thresholdMs: number = 100, maxEntries: number = 1000) {
    this.thresholdMs = thresholdMs
    this.maxEntries = maxEntries
  }

  /**
   * 执行查询并记录慢查询
   * @returns 查询结果
   */
  async track<T>(name: string, fn: () => Promise<T>, user?: string): Promise<T> {
    const start = Date.now()
    try {
      return await fn()
    } finally {
      const duration = Date.now() - start
      if (duration >= this.thresholdMs) {
        this._log(name, duration, user)
      }
    }
  }

  /** 获取慢查询列表 */
  getSlowQueries(): typeof this.logs {
    return [...this.logs]
  }

  /** 获取最近慢查询数 */
  get count(): number {
    return this.logs.length
  }

  setThreshold(ms: number): void {
    this.thresholdMs = ms
  }

  clear(): void {
    this.logs = []
  }

  private _log(op: string, duration: number, user?: string): void {
    this.logs.push({ op, duration, timestamp: Date.now(), user })
    if (this.logs.length > this.maxEntries) {
      this.logs.shift()
    }
  }
}
