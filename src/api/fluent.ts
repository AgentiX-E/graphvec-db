// ============================================================
// Fluent API — 链式查询语言 for AgentiX GraphVec
// ============================================================

import { ShardManager } from '../shard/shard-manager'
import { NodeRecord, EdgeRecord } from '../types'

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

  constructor(manager: ShardManager) {
    this.manager = manager
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
   * 内部执行逻辑
   *
   * 流程：
   * 1. 如果是向量搜索路径（有 vector_），优先做向量搜索
   * 2. 如果是 match(typeId) 路径，从存储中按 typeId 获取所有节点
   * 3. 邻居遍历（如果设置了 maxDepth）
   * 4. 应用 predicates（AND 过滤）
   * 5. 排序（orderBy）
   * 6. Skip & Limit
   * 7. 投影（project）
   */
  private async execute(): Promise<NodeRecord[]> {
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
    // 默认实现：尝试从每个 Range 获取节点列表
    // 由于 ShardManager/GraphEngine 没有提供枚举所有节点的 API，
    // 此方法在正式使用时应通过注入的 NodeScanner 或 RangeScanner 实现。
    //
    // 当前返回空数组，测试中通过 MockShardManager 提供数据。
    return []
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
