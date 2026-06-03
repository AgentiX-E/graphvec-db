/**
 * resource-quota.ts — 资源配额管理器
 *
 * 提供对 GraphVec 实例内存、查询速率和连接数的配额管控。
 * 支持每秒查询数自动重置，以及简单内存使用估算。
 */

export interface ResourceQuotaConfig {
  /** 最大内存限制 (MB)，默认 1024 */
  maxMemoryMB?: number
  /** 每秒最大查询数，默认 1000 */
  maxQueriesPerSec?: number
  /** 最大活跃连接数，默认 100 */
  maxConnections?: number
}

const DEFAULTS: Required<ResourceQuotaConfig> = {
  maxMemoryMB: 1024,
  maxQueriesPerSec: 1000,
  maxConnections: 100,
}

export class ResourceQuotaManager {
  private config: Required<ResourceQuotaConfig>
  private queryCount: number = 0
  private resetInterval: ReturnType<typeof setInterval> | null = null

  constructor(config: ResourceQuotaConfig = {}) {
    this.config = { ...DEFAULTS, ...config }
    this._startAutoReset()
  }

  /**
   * 检查是否可以接受新查询。
   * 在当前秒内查询数 < maxQueriesPerSec 时返回 true，否则 false。
   */
  tryAcquire(): boolean {
    if (this.queryCount >= this.config.maxQueriesPerSec) {
      return false
    }
    this.queryCount++
    return true
  }

  /**
   * 当前内存使用 (MB) —— 通过 process.memoryUsage() 估算实际内存。
   */
  getMemoryUsageMB(): number {
    const usage = process.memoryUsage()
    return Math.round(usage.heapUsed / 1024 / 1024)
  }

  /**
   * 重置当前秒的查询计数器。
   */
  reset(): void {
    this.queryCount = 0
  }

  /**
   * 停止自动重置定时器并清理。
   */
  dispose(): void {
    if (this.resetInterval !== null) {
      clearInterval(this.resetInterval)
      this.resetInterval = null
    }
  }

  /**
   * 更新配额配置（立即生效）。
   */
  updateConfig(config: Partial<ResourceQuotaConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /**
   * 获取当前配置（只读副本）。
   */
  getConfig(): Required<ResourceQuotaConfig> {
    return { ...this.config }
  }

  /**
   * 当前秒已处理的查询数。
   */
  getQueryCount(): number {
    return this.queryCount
  }

  /**
   * 每秒自动重置计数器。
   */
  private _startAutoReset(): void {
    this.dispose()
    this.resetInterval = setInterval(() => {
      this.reset()
    }, 1000)
    // 允许进程在定时器未清理时正常退出
    if (this.resetInterval && typeof this.resetInterval === 'object' && 'unref' in this.resetInterval) {
      this.resetInterval.unref()
    }
  }
}
