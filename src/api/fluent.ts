// ============================================================
// Fluent API — 链式查询语言 for AgentiX GraphVec
// ============================================================

import { ShardManager } from '../shard/shard-manager'
import { NodeRecord, EdgeRecord } from '../types'
import {
  buildIRFromSpec,
  optimizeIR,
  executeIR,
  QuerySpec,
  PlanNode,
  formatPlanExplain,
} from './query-planner'

/**
 * GraphQuery — 流式图查询接口
 *
 * 支持链式调用：match → where → neighbors → return
 * 内部维护查询状态，return() 最终执行查询，调用 ShardManager 接口。
 *
 * 使用示例：
 *   const q = new GraphQuery(manager)
 *   const nodes = await q.match(1).where(n => n.name.startsWith('A')).neighbors(2).return()
 */
export class GraphQuery {
  private manager: ShardManager

  // 查询状态
  private currentTypeId: number | null = null
  private predicates: Array<(node: NodeRecord) => boolean> = []
  private maxDepth: number = 0
  private edgeFilter: number[] | null = null
  private limit_: number | null = null
  private skip_: number = 0
  private orderField_: string | null = null
  private orderDir_: 'asc' | 'desc' = 'asc'
  private projectFields_: string[] | null = null
  private vector_: { vector: number[]; k: number } | null = null

  /**
   * 是否启用查询优化器（QueryIR）。
   * 启用后，execute() 会通过 QueryIR (buildIRFromSpec → optimizeIR → executeIR) 执行。
   * 默认禁用以保持向后兼容。
   */
  private useOptimizer_: boolean = false

  constructor(manager: ShardManager) {
    this.manager = manager
  }

  /**
   * 启用或禁用查询优化器
   * @param enabled 是否启用
   */
  enableOptimizer(enabled: boolean = true): GraphQuery {
    this.useOptimizer_ = enabled
    return this
  }

  /**
   * 设置节点类型过滤（起点）
   */
  match(typeId?: number): GraphQuery {
    this.currentTypeId = typeId ?? null
    return this
  }

  /**
   * 条件过滤（AND 语义，可多次调用）
   */
  where(predicate: (node: NodeRecord) => boolean): GraphQuery {
    this.predicates.push(predicate)
    return this
  }

  /**
   * 遍历邻居节点
   * @param depth 遍历深度（默认 1）
   * @param edgeTypeFilter 边类型过滤
   */
  neighbors(depth: number = 1, edgeTypeFilter?: number[]): GraphQuery {
    this.maxDepth = depth
    this.edgeFilter = edgeTypeFilter ?? null
    return this
  }

  /**
   * 限制返回数量
   */
  limit(n: number): GraphQuery {
    this.limit_ = n
    return this
  }

  /**
   * 跳过前 n 个结果
   */
  skip(n: number): GraphQuery {
    this.skip_ = n
    return this
  }

  /**
   * 自定义属性投影（只保留指定字段）
   */
  project(fields: string[]): GraphQuery {
    this.projectFields_ = fields
    return this
  }

  /**
   * 排序
   * @param field 排序字段（支持 name、id、createdAt、或 props 中的字段）
   * @param direction 排序方向
   */
  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): GraphQuery {
    this.orderField_ = field
    this.orderDir_ = direction
    return this
  }

  /**
   * 向量相似度搜索
   * @param vector 查询向量
   * @param k 返回 Top-K 结果
   */
  vectorSimilarity(vector: number[], k: number = 10): GraphQuery {
    this.vector_ = { vector, k }
    return this
  }

  /**
   * 更新边的属性（upsert 语义 — 存在则更新，不存在则创建）
   * @param src 源节点 ID
   * @param dst 目标节点 ID
   * @param typeId 边类型
   * @param updates 要更新/设置的属性
   */
  async updateEdge(src: number, dst: number, typeId: number, updates?: Record<string, unknown>): Promise<void> {
    await this.manager.upsertEdge(src, dst, typeId, {
      props: updates as any,
    })
  }

  /**
   * 删除边
   * @param src 源节点 ID
   * @param dst 目标节点 ID
   * @param typeId 边类型
   */
  async deleteEdge(src: number, dst: number, typeId: number): Promise<void> {
    await this.manager.deleteEdge(src, dst, typeId)
  }

  /**
   * 执行查询并返回节点结果
   */
  async return(): Promise<NodeRecord[]> {
    return this.execute()
  }

  /**
   * 执行查询并返回计数
   */
  async count(): Promise<number> {
    const nodes = await this.execute()
    return nodes.length
  }

  /**
   * 输出当前查询的调试表示
   */
  toString(): string {
    const parts: string[] = ['GraphQuery']
    if (this.currentTypeId !== null) parts.push(`match(${this.currentTypeId})`)
    if (this.predicates.length > 0) parts.push(`where(${this.predicates.length} predicates)`)
    if (this.maxDepth > 0) parts.push(`neighbors(depth=${this.maxDepth}, edgeFilter=${JSON.stringify(this.edgeFilter) ?? 'all'})`)
    if (this.vector_) parts.push(`vectorSimilarity(k=${this.vector_.k})`)
    if (this.limit_ !== null) parts.push(`limit(${this.limit_})`)
    if (this.skip_ > 0) parts.push(`skip(${this.skip_})`)
    if (this.orderField_) parts.push(`orderBy(${this.orderField_}, ${this.orderDir_})`)
    if (this.projectFields_) parts.push(`project(${this.projectFields_.join(',')})`)
    return parts.join(' → ')
  }

  /**
   * plan — 输出当前查询的优化计划（EXPLAIN），不实际执行
   *
   * 使用 QueryIR 构建计划树，应用优化，然后返回可读的计划描述。
   * 适用于调试、性能分析、查询调优。
   *
   * @returns 查询计划的可读字符串描述
   */
  plan(): string {
    const spec = this.buildQuerySpec()
    const plan = buildIRFromSpec(spec)
    const optimized = optimizeIR(plan)
    return formatPlanExplain(optimized, 0)
  }

  /**
   * 构建当前查询的 QuerySpec（供 IR 使用）
   */
  private buildQuerySpec(): QuerySpec {
    const spec: QuerySpec = {}

    if (this.currentTypeId !== null || this.maxDepth > 0) {
      spec.match = { typeId: this.currentTypeId ?? undefined }
    }

    if (this.predicates.length > 0) {
      spec.predicates = [...this.predicates]
    }

    if (this.maxDepth > 0) {
      spec.neighbors = {
        id: 0, // 占位，实际运行时由 scan 阶段决定
        edgeType: this.edgeFilter?.[0] ?? undefined,
        maxDepth: this.maxDepth,
      }
    }

    if (this.orderField_) {
      spec.orderBy = { field: this.orderField_, direction: this.orderDir_ }
    }

    if (this.limit_ !== null) {
      spec.limit = this.limit_
    }

    if (this.skip_ > 0) {
      spec.skip = this.skip_
    }

    if (this.projectFields_ && this.projectFields_.length > 0) {
      spec.return = [...this.projectFields_]
    }

    if (this.vector_) {
      spec.vectorSearch = { vector: this.vector_.vector, topK: this.vector_.k }
    }

    return spec
  }

  /**
   * 内部执行逻辑
   *
   * 当 useOptimizer_ 启用时，通过 QueryIR 执行：
   *   buildIRFromSpec → optimizeIR → executeIR
   *
   * 未启用时，保持原始执行路径。
   *
   * 流程（原始路径）：
   * 1. 如果是向量搜索路径（有 vector_），优先做向量搜索
   * 2. 如果是 match(typeId) 路径，从存储中按 typeId 获取所有节点
   * 3. 邻居遍历（如果设置了 maxDepth）
   * 4. 应用 predicates（AND 过滤）
   * 5. 排序（orderBy）
   * 6. Skip & Limit
   * 7. 投影（project）
   */
  private async execute(): Promise<NodeRecord[]> {
    // ── QueryIR 优化路径 ──
    if (this.useOptimizer_) {
      const spec = this.buildQuerySpec()
      const plan = buildIRFromSpec(spec)
      const optimized = optimizeIR(plan)
      const fnPreds = this.predicates.length > 0 ? [...this.predicates] : undefined
      return executeIR(optimized, this.manager, fnPreds)
    }

    // ── 原始执行路径（向后兼容） ──
    let nodes: NodeRecord[] = []

    if (this.vector_ !== null) {
      // 向量搜索路径
      const results = await this.manager.vectorSearch({
        denseQuery: this.vector_.vector,
        k: this.vector_.k,
      })
      nodes = results.map(r => r.node)
      if (this.currentTypeId !== null) {
        nodes = nodes.filter(n => n.type === this.currentTypeId)
      }
    } else {
      // 通过 ShardManager 的 getShardStatus 获取所有 Range，
      // 然后扫描节点数据。由于 ShardManager 没有直接的按 type 查询 API，
      // 这里通过通知 ShardManager 扫描来实现。
      // 实际使用时，依赖 ShardManager 提供 getNodesByType 或类似方法，
      // 或者由外部注入候选节点列表。
      // 当前实现保留 mark，由子类或 mock 覆盖 scanAllRanges 提供数据。
      nodes = await this.scanAllRanges()
      if (this.currentTypeId !== null) {
        nodes = nodes.filter(n => n.type === this.currentTypeId)
      }
    }

    // 邻居遍历
    if (this.maxDepth > 0) {
      nodes = await this.expandNeighbors(nodes)
    }

    // 应用 predicates（AND 过滤）
    for (const pred of this.predicates) {
      nodes = nodes.filter(pred)
    }

    // 排序
    if (this.orderField_) {
      nodes = this.applyOrder(nodes)
    }

    // Skip & Limit
    if (this.skip_ > 0) {
      nodes = nodes.slice(this.skip_)
    }
    if (this.limit_ !== null) {
      nodes = nodes.slice(0, this.limit_)
    }

    // 投影
    if (this.projectFields_) {
      nodes = this.applyProjection(nodes)
    }

    return nodes
  }

  /**
   * 邻居展开：从当前节点集出发，按 maxDepth 展开邻居
   */
  private async expandNeighbors(seedNodes: NodeRecord[]): Promise<NodeRecord[]> {
    const result: NodeRecord[] = []
    const seen = new Set<number>()

    for (const node of seedNodes) {
      await this.collectNeighbors(node.id, this.maxDepth, seen, result)
    }

    return result
  }

  /**
   * 递归收集邻居
   */
  private async collectNeighbors(
    nodeId: number,
    remainingDepth: number,
    seen: Set<number>,
    result: NodeRecord[],
  ): Promise<void> {
    if (remainingDepth <= 0) return
    if (seen.has(nodeId)) return
    seen.add(nodeId)

    const { nodes } = await this.manager.neighbors(nodeId, {
      maxDepth: 1,
      edgeTypeFilter: this.edgeFilter ?? undefined,
    })

    for (const n of nodes) {
      if (!seen.has(n.id)) {
        result.push(n)
        await this.collectNeighbors(n.id, remainingDepth - 1, seen, result)
      }
    }
  }

  /**
   * 扫描所有 Range 获取候选节点
   *
   * 标记为 protected 以便测试时通过继承覆盖。
   * 产品中可以通过注入外部扫描器或通过 PatternMatch API 实现。
   */
  protected async scanAllRanges(): Promise<NodeRecord[]> {
    // 默认实现：遍历所有 Range 收集节点
    // 注入的 ShardManager 必须提供 getAllRanges()，否则返回空
    const shardManager = (this as any).manager
    if (!shardManager || typeof shardManager.getAllRanges !== 'function') {
      return []
    }
    const ranges = shardManager.getAllRanges()
    if (ranges.size === 0) return []

    const results: NodeRecord[] = []
    for (const [rangeId, range] of ranges) {
      try {
        const nodes = await range.read(async (engine: any) => {
          // 通过 labelEngine 枚举所有类型的节点
          return (await engine.findNodesByType(0).catch(() => [])) as any
        })
        results.push(...nodes)
      } catch {
        // 跳过无法读取的 Range
      }
    }
    return results
  }

  /**
   * 应用排序
   */
  private applyOrder(nodes: NodeRecord[]): NodeRecord[] {
    const field = this.orderField_!
    const dir = this.orderDir_

    return [...nodes].sort((a, b) => {
      const valA = this.resolveField(a, field)
      const valB = this.resolveField(b, field)

      if (valA == null && valB == null) return 0
      if (valA == null) return 1
      if (valB == null) return -1

      if (typeof valA === 'string' && typeof valB === 'string') {
        return dir === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA)
      }
      return dir === 'asc'
        ? Number(valA) - Number(valB)
        : Number(valB) - Number(valA)
    })
  }

  /**
   * 从节点中解析字段值（支持 props 中的嵌套字段）
   */
  private resolveField(node: NodeRecord, field: string): unknown {
    const key = field as keyof NodeRecord
    if (key in node) {
      return (node as any)[key]
    }
    return node.props?.[field]
  }

  /**
   * 应用投影：只保留指定字段
   */
  private applyProjection(nodes: NodeRecord[]): NodeRecord[] {
    return nodes.map(node => {
      const projected: any = { id: node.id }
      for (const field of this.projectFields_!) {
        const val = this.resolveField(node, field)
        if (val !== undefined) {
          projected[field] = val
        }
      }
      return projected as NodeRecord
    })
  }
}

/**
 * UnionQuery — 多个查询的并集
 *
 * 使用示例：
 *   const q1 = new GraphQuery(manager).match(1)
 *   const q2 = new GraphQuery(manager).match(2)
 *   const result = await union(q1, q2).return()
 */
export class UnionQuery {
  private queries: GraphQuery[]
  private manager: ShardManager
  private limit_: number | null = null
  private skip_ = 0

  constructor(...queries: GraphQuery[]) {
    if (queries.length < 2) {
      throw new Error('UnionQuery requires at least 2 queries')
    }
    this.manager = queries[0]['manager']
    this.queries = queries
  }

  limit(n: number): this {
    this.limit_ = n
    return this
  }

  skip(n: number): this {
    this.skip_ = n
    return this
  }

  async return(): Promise<NodeRecord[]> {
    const all = await Promise.all(this.queries.map(q => q.return()))
    const seen = new Set<number>()
    const result: NodeRecord[] = []
    for (const nodes of all) {
      for (const n of nodes) {
        if (!seen.has(n.id)) {
          seen.add(n.id)
          result.push(n)
        }
      }
    }
    if (this.skip_ > 0) result.splice(0, this.skip_)
    if (this.limit_ !== null) result.splice(this.limit_)
    return result
  }
}

/**
 * IntersectQuery — 多个查询的交集
 */
export class IntersectQuery {
  private queries: GraphQuery[]
  private manager: ShardManager
  private limit_: number | null = null
  private skip_ = 0

  constructor(...queries: GraphQuery[]) {
    if (queries.length < 2) {
      throw new Error('IntersectQuery requires at least 2 queries')
    }
    this.manager = queries[0]['manager']
    this.queries = queries
  }

  limit(n: number): this {
    this.limit_ = n
    return this
  }

  skip(n: number): this {
    this.skip_ = n
    return this
  }

  async return(): Promise<NodeRecord[]> {
    // 先执行所有查询
    const allResults = await Promise.all(this.queries.map(q => q.return()))
    if (allResults.length === 0) return []

    // 交集：从第一个结果开始逐层过滤
    let result = allResults[0]
    for (let i = 1; i < allResults.length; i++) {
      const ids = new Set(allResults[i].map(n => n.id))
      result = result.filter(n => ids.has(n.id))
    }
    if (this.skip_ > 0) result.splice(0, this.skip_)
    if (this.limit_ !== null) result.splice(this.limit_)
    return result
  }
}

/**
 * SubtractQuery — A − B：在 A 中不在 B 中的节点
 */
export class SubtractQuery {
  private queries: GraphQuery[]
  private manager: ShardManager
  private limit_: number | null = null
  private skip_ = 0

  constructor(a: GraphQuery, b: GraphQuery) {
    this.manager = a['manager']
    this.queries = [a, b]
  }

  limit(n: number): this {
    this.limit_ = n
    return this
  }

  skip(n: number): this {
    this.skip_ = n
    return this
  }

  async return(): Promise<NodeRecord[]> {
    const [aResults, bResults] = await Promise.all([
      this.queries[0].return(),
      this.queries[1].return(),
    ])
    const bIds = new Set(bResults.map(n => n.id))
    let result = aResults.filter(n => !bIds.has(n.id))
    if (this.skip_ > 0) result.splice(0, this.skip_)
    if (this.limit_ !== null) result.splice(this.limit_)
    return result
  }
}

/** 静态工厂方法 */
export function union(...queries: GraphQuery[]): UnionQuery {
  return new UnionQuery(...queries)
}

export function intersect(...queries: GraphQuery[]): IntersectQuery {
  return new IntersectQuery(...queries)
}

export function subtract(a: GraphQuery, b: GraphQuery): SubtractQuery {
  return new SubtractQuery(a, b)
}
