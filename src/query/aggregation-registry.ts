// ============================================================
// AggregationRegistry — 用户定义聚合函数（UDA）注册系统
//
// 参照 ProcedureRegistry 设计，支持注册自定义聚合函数，
// 内置 count / sum / avg / min / max 聚合器。
// 每个聚合器包含初始化、累加、合并（并行）、完成四个阶段，
// 满足 UDA 通用模式（Accumulator / Merge / Finalize）。
// ============================================================

export interface Accumulator {
  /** 当前累加的值 */
  state: unknown
  /** 累加一条记录 */
  accumulate(value: unknown): void
  /** 合并另一个累加器（用于并行聚合） */
  merge(other: Accumulator): void
  /** 完成聚合，返回最终结果 */
  finalize(): unknown
  /** 重置累加器 */
  reset(): void
}

export type AccumulatorFactory = () => Accumulator

export interface AggregationEntry {
  name: string
  description?: string
  factory: AccumulatorFactory
}

// ── 内置累加器实现 ─────────────────────────────────────────

class CountAccumulator implements Accumulator {
  state: number = 0

  accumulate(_value: unknown): void {
    this.state++
  }

  merge(other: Accumulator): void {
    this.state += (other as CountAccumulator).state
  }

  finalize(): unknown {
    return this.state
  }

  reset(): void {
    this.state = 0
  }
}

class SumAccumulator implements Accumulator {
  state: number = 0

  accumulate(value: unknown): void {
    const n = typeof value === 'number' ? value : Number(value)
    if (!isNaN(n)) {
      this.state += n
    }
  }

  merge(other: Accumulator): void {
    this.state += (other as SumAccumulator).state
  }

  finalize(): unknown {
    return this.state
  }

  reset(): void {
    this.state = 0
  }
}

class AvgAccumulator implements Accumulator {
  private sum: number = 0
  private count: number = 0
  state: { sum: number; count: number } = { sum: 0, count: 0 }

  accumulate(value: unknown): void {
    const n = typeof value === 'number' ? value : Number(value)
    if (!isNaN(n)) {
      this.sum += n
      this.count++
    }
  }

  merge(other: Accumulator): void {
    const o = other as AvgAccumulator
    this.sum += o.sum
    this.count += o.count
  }

  finalize(): unknown {
    if (this.count === 0) return null
    return this.sum / this.count
  }

  reset(): void {
    this.sum = 0
    this.count = 0
  }
}

class MinAccumulator implements Accumulator {
  state: number | null = null

  accumulate(value: unknown): void {
    const n = typeof value === 'number' ? value : Number(value)
    if (!isNaN(n)) {
      if (this.state === null || n < this.state) {
        this.state = n
      }
    }
  }

  merge(other: Accumulator): void {
    const o = other as MinAccumulator
    if (o.state !== null) {
      if (this.state === null || o.state < this.state) {
        this.state = o.state
      }
    }
  }

  finalize(): unknown {
    return this.state
  }

  reset(): void {
    this.state = null
  }
}

class MaxAccumulator implements Accumulator {
  state: number | null = null

  accumulate(value: unknown): void {
    const n = typeof value === 'number' ? value : Number(value)
    if (!isNaN(n)) {
      if (this.state === null || n > this.state) {
        this.state = n
      }
    }
  }

  merge(other: Accumulator): void {
    const o = other as MaxAccumulator
    if (o.state !== null) {
      if (this.state === null || o.state > this.state) {
        this.state = o.state
      }
    }
  }

  finalize(): unknown {
    return this.state
  }

  reset(): void {
    this.state = null
  }
}

class CountDistinctAccumulator implements Accumulator {
  private set = new Set<string>()
  state: number = 0

  accumulate(value: unknown): void {
    this.set.add(String(value))
  }

  merge(other: Accumulator): void {
    const o = other as CountDistinctAccumulator
    for (const v of o.set) {
      this.set.add(v)
    }
  }

  finalize(): unknown {
    return this.set.size
  }

  reset(): void {
    this.set.clear()
  }
}

// ── 聚合注册器 ─────────────────────────────────────────────

export class AggregationRegistry {
  private aggregations = new Map<string, AggregationEntry>()

  constructor() {
    this.registerBuiltins()
  }

  /** 注册自定义聚合函数 */
  register(name: string, factory: AccumulatorFactory, description?: string): void {
    if (this.aggregations.has(name)) {
      throw new Error(`Aggregation "${name}" is already registered`)
    }
    this.aggregations.set(name, { name, factory, description })
  }

  /** 检查聚合函数是否已注册 */
  has(name: string): boolean {
    return this.aggregations.has(name)
  }

  /** 获取聚合函数工厂 */
  getFactory(name: string): AccumulatorFactory | undefined {
    return this.aggregations.get(name)?.factory
  }

  /** 创建聚合累加器实例 */
  createAccumulator(name: string): Accumulator {
    const factory = this.getFactory(name)
    if (!factory) {
      throw new Error(`Unknown aggregation: "${name}". Registered: ${this.list().map(e => e.name).join(', ')}`)
    }
    return factory()
  }

  /** 列出所有已注册的聚合函数 */
  list(): Array<{ name: string; description?: string }> {
    const result: Array<{ name: string; description?: string }> = []
    for (const entry of this.aggregations.values()) {
      result.push({ name: entry.name, description: entry.description })
    }
    return result
  }

  /** 对一组值运行聚合 */
  aggregate(name: string, values: unknown[]): unknown {
    const acc = this.createAccumulator(name)
    for (const v of values) {
      acc.accumulate(v)
    }
    return acc.finalize()
  }

  /** 分组聚合：按 groupKey 分组后对每个组运行聚合 */
  groupAggregate(
    name: string,
    items: Array<{ groupKey: unknown; value: unknown }>,
  ): Map<unknown, unknown> {
    const groups = new Map<unknown, Accumulator>()

    for (const item of items) {
      if (!groups.has(item.groupKey)) {
        groups.set(item.groupKey, this.createAccumulator(name))
      }
      groups.get(item.groupKey)!.accumulate(item.value)
    }

    const result = new Map<unknown, unknown>()
    for (const [key, acc] of groups) {
      result.set(key, acc.finalize())
    }
    return result
  }

  /** 注销聚合函数 */
  unregister(name: string): boolean {
    return this.aggregations.delete(name)
  }

  /** 清除所有注册（包括内置） */
  clear(): void {
    this.aggregations.clear()
  }

  // ── 内置聚合 ──────────────────────────────────

  private registerBuiltins(): void {
    this.register('count', () => new CountAccumulator(), 'Count of values')
    this.register('sum', () => new SumAccumulator(), 'Sum of numeric values')
    this.register('avg', () => new AvgAccumulator(), 'Average (arithmetic mean) of numeric values')
    this.register('min', () => new MinAccumulator(), 'Minimum numeric value')
    this.register('max', () => new MaxAccumulator(), 'Maximum numeric value')
    this.register('count_distinct', () => new CountDistinctAccumulator(), 'Count of distinct values')
  }
}

/** 全局共享实例 */
export const aggregationRegistry = new AggregationRegistry()
