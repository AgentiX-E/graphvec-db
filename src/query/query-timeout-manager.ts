/**
 * query-timeout-manager.ts — 查询超时管理器
 *
 * 在 query-timeout.ts (withQueryTimeout) 基础上提供：
 * 1. QueryTimeoutManager：集中配置和级联超时管理
 * 2. 支持按查询类型设置不同超时
 * 3. 与 REST/gRPC 请求的集成点
 * 4. 超时统计
 *
 * 集成方式：
 * ```ts
 * const timeoutManager = new QueryTimeoutManager({ defaultTimeoutMs: 15000 })
 * // 在 REST handler 中：
 * const result = await timeoutManager.runWithTimeout(
 *   () => executeQuery(plan, nodes),
 *   { queryType: 'graph-query', requestId: req.headers['x-request-id'] }
 * )
 * ```
 */

import { withQueryTimeout, QueryTimeoutError } from './query-timeout'

export { QueryTimeoutError }

// ── 类型定义 ──────────────────────────────────────────────

export interface TimeoutConfig {
  /** 默认超时（毫秒），默认 30000 */
  defaultTimeoutMs: number
  /** 按查询类型的超时覆盖（毫秒） */
  perTypeTimeoutMs: Record<string, number>
}

export interface RunOptions {
  /** 查询类型标签（用于统计和按类型超时） */
  queryType?: string
  /** 请求 ID（用于日志Trace） */
  requestId?: string
  /** 外部 AbortSignal（用于级联取消） */
  abortSignal?: AbortSignal
}

export interface TimeoutStats {
  /** 总执行次数 */
  totalRuns: number
  /** 超时次数 */
  timeoutCount: number
  /** 取消次数（外部 abort） */
  cancelCount: number
  /** 成功次数 */
  successCount: number
}

const DEFAULT_CONFIG: TimeoutConfig = {
  defaultTimeoutMs: 30000,
  perTypeTimeoutMs: {},
}

// ── QueryTimeoutManager ──────────────────────────────────

/**
 * QueryTimeoutManager — 查询超时管理器
 *
 * 封装 withQueryTimeout()，提供统一的超时管理和统计。
 * 可通过 RestApiConfig 传入，在 REST handler 中直接使用。
 */
export class QueryTimeoutManager {
  private config: TimeoutConfig
  private stats: TimeoutStats = {
    totalRuns: 0,
    timeoutCount: 0,
    cancelCount: 0,
    successCount: 0,
  }

  constructor(config?: Partial<TimeoutConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 更新配置
   */
  setConfig(partial: Partial<TimeoutConfig>): void {
    this.config = { ...this.config, ...partial }
  }

  /**
   * 获取当前配置
   */
  getConfig(): Readonly<TimeoutConfig> {
    return Object.freeze({ ...this.config })
  }

  /**
   * 获取统计Info
   */
  getStats(): Readonly<TimeoutStats> {
    return Object.freeze({ ...this.stats })
  }

  /**
   * 重置统计
   */
  resetStats(): void {
    this.stats = { totalRuns: 0, timeoutCount: 0, cancelCount: 0, successCount: 0 }
  }

  /**
   * 在超时保护下执行查询
   *
   * @param fn - 查询执行函数
   * @param options - 执行选项
   * @returns 查询结果
   * @throws QueryTimeoutError 超时时抛出
   */
  async runWithTimeout<T>(
    fn: () => Promise<T>,
    options?: RunOptions,
  ): Promise<T> {
    this.stats.totalRuns++

    // 按查询类型选择超时时间
    const timeoutMs =
      (options?.queryType && this.config.perTypeTimeoutMs[options.queryType]) ??
      this.config.defaultTimeoutMs

    try {
      const result = await withQueryTimeout(
        fn,
        timeoutMs,
        options?.abortSignal,
      )
      this.stats.successCount++
      return result
    } catch (err) {
      // Check if this was a cancellation (external AbortSignal) vs. regular timeout
      const isCancellation = options?.abortSignal?.aborted === true

      if (err instanceof QueryTimeoutError) {
        if (isCancellation) {
          this.stats.cancelCount++
        } else {
          this.stats.timeoutCount++
        }
      } else {
        // 其他Error（非超时）计入正常
        this.stats.successCount++
      }
      throw err
    }
  }

  /**
   * 创建可重复使用的 AbortController + 定时器组合
   * 用于 REST 请求级别的超时控制
   *
   * @param timeoutMs - 超时毫秒数
   * @param signal - 父级 AbortSignal（Optional）
   * @returns AbortController 和清理函数
   */
  createRequestTimeout(
    timeoutMs?: number,
    signal?: AbortSignal,
  ): { controller: AbortController; cancel: () => void } {
    const controller = new AbortController()
    const ms = timeoutMs ?? this.config.defaultTimeoutMs

    const timer = setTimeout(() => {
      controller.abort(new QueryTimeoutError(`Request timed out after ${ms}ms`))
    }, ms)

    if (signal) {
      const onAbort = () => controller.abort(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    }

    const cancel = () => {
      clearTimeout(timer)
      try { controller.abort() } catch { /* ignore */ }
    }

    return { controller, cancel }
  }

  /**
   * 简化版：直接对 Promise 应用超时
   *
   * @param promise - 已有 Promise
   * @param options - 执行选项
   */
  async wrapPromise<T>(
    promise: Promise<T>,
    options?: RunOptions,
  ): Promise<T> {
    return this.runWithTimeout(() => promise, options)
  }
}
