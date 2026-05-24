/**
 * EdgeAffinity — 边分片键配置
 *
 * 决定边写入时路由到哪个 Range。
 *
 * 策略选项:
 * - 'source':  根据起点节点路由 (默认，现有行为)
 * - 'target':  根据终点节点路由
 * - 'source-target': 跨 src+dst hash（确保双向边在同一 Range）
 * - 'property:<key>': 根据边上的属性值路由
 */

export type EdgeAffinityStrategy = 'source' | 'target' | 'source-target' | string

export interface EdgeAffinityConfig {
  strategy: EdgeAffinityStrategy
}

export class EdgeAffinity {
  private _strategy: EdgeAffinityStrategy

  constructor(config?: Partial<EdgeAffinityConfig>) {
    this._strategy = config?.strategy ?? 'source'
  }

  /**
   * 计算边的分片键
   *
   * @param src - 起点节点 ID
   * @param dst - 终点节点 ID
   * @param properties - 边的属性（用于 property-based 策略）
   * @returns 用作分片路由键的值
   */
  getPartitionKey(src: number, dst: number, properties?: Record<string, unknown>): number {
    switch (this._strategy) {
      case 'source':
        return src
      case 'target':
        return dst
      case 'source-target': {
        // 确保 (src, dst) 和 (dst, src) 映射到同一个分片
        const a = Math.min(src, dst)
        const b = Math.max(src, dst)
        return a * 31 + b
      }
      default:
        // property-based: strategy = 'property:key'
        if (this._strategy.startsWith('property:')) {
          const key = this._strategy.slice('property:'.length)
          if (properties && key in properties) {
            const val = properties[key]
            return typeof val === 'number' ? val : String(val).length
          }
        }
        // fallback to source
        return src
    }
  }

  /** 当前策略 */
  get strategy(): EdgeAffinityStrategy {
    return this._strategy
  }

  /** 动态修改策略 */
  setStrategy(strategy: EdgeAffinityStrategy): void {
    this._strategy = strategy
  }
}
