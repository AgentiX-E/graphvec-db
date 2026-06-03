// ============================================================
// QueryPlanner — 查询计划生成器
// 将 GraphQuery 转换为可优化的计划树
// ============================================================

import { ShardManager } from '../shard/shard-manager'
import { NodeRecord, EdgeRecord } from '../types'
import { StatsCollector, StatsSnapshot } from './stats-collector'
import { LRUCache } from 'lru-cache'
import { Logger } from '../ops/logger'

// ──────────────────────────────────────────
// Query Plan Cache
// ──────────────────────────────────────────

/**
 * Compute a djb2 hash of the given string.
 */
function djb2Hash(s: string): string {
  let hash = 5381
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0
  }
  return String(hash)
}

/**
 * Normalize a query string: collapse whitespace and trim.
 */
function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim()
}

/**
 * Generate a plan cache key from a query string.
 * Uses djb2 hash of the normalized (whitespace-collapsed) query.
 */
export function makePlanCacheKey(query: string): string {
  return djb2Hash(normalizeQuery(query))
}

/**
 * Global LRU cache for query plans (max 1000 entries).
 * Cache key = djb2 hash of normalized query string.
 * Value = { plan, statsTime? } wrapper to support staleness detection.
 * Used by both QueryPlanner and QueryEngine to avoid rebuilding plans.
 */
export const planCache = new LRUCache<string, { plan: PlanNode; statsTime?: number }>({ max: 1000 })

/**
 * Module-level logger for plan cache monitoring.
 */
const planCacheLogger = new Logger('PlanCache')

/**
 * 返回 planCache 当前条目数。
 */
export function planCacheSize(): number {
  return planCache.size
}

/**
 * 返回 planCache 的统计信息：条目数、最大容量、利用率。
 * 当 utilization > 0.9 时自动发出 warn 告警。
 */
export function planCacheStats(): { entryCount: number; maxSize: number; utilization: number } {
  const entryCount = planCache.size
  const maxSize = planCache.max
  const utilization = entryCount / maxSize
  if (utilization > 0.9) {
    planCacheLogger.warn(`PlanCache utilization > 90%: ${entryCount}/${maxSize}`)
  }
  return { entryCount, maxSize, utilization }
}

// ──────────────────────────────────────────
// Plan 节点类型
// ──────────────────────────────────────────

export enum PlanNodeType {
  SCAN = 'scan',
  FILTER = 'filter',
  NEIGHBORS = 'neighbors',
  INDEX_LOOKUP = 'index_lookup',
  LIMIT = 'limit',
  SORT = 'sort',
  PROJECT = 'project',
  VECTOR_SEARCH = 'vector_search',
  JOIN = 'join',
  AGGREGATE = 'aggregate',
  SHORTEST_PATH = 'shortest_path',
  PERSONALIZED_PAGE_RANK = 'personalized_page_rank',
  CONNECTED_COMPONENTS = 'connected_components',
  PARALLEL_UNION = 'parallel_union',
  UNION = 'union',
  INTERSECT = 'intersect',
  SUBTRACT = 'subtract',
  VARIABLE_LENGTH_PATH = 'variable_length_path',
}

export interface PlanNode {
  type: PlanNodeType
  estimatedCost: number
  estimatedRows: number
  children: PlanNode[]
  details: Record<string, unknown>
}

export interface ExecutionStats {
  totalRows: number
  elapsedMs: number
  nodesScanned: number
}

// ──────────────────────────────────────────
// 统计收集器
// ──────────────────────────────────────────

export interface ColumnStat {
  columnName: string
  distinctCount: number
  nullCount: number
  minValue?: unknown
  maxValue?: unknown
}

export interface TableStats {
  rowCount: number
  columnStats: Map<string, ColumnStat>
}

/**
 * EnhancedStats — 增强的统计信息，支持 CBO 更精确的估算
 */
export interface EnhancedStats {
  /** 按 label (typeId → count) 的节点分布 */
  labelCounts: Map<number, number>
  /** 按边类型 (typeId → count) 的边分布 */
  edgeLabelCounts: Map<number, number>
  /** 按属性名 → 统计信息的属性分布 */
  propStats: Map<string, { min: number; max: number; cardinality: number; nullCount: number }>
}

/**
 * IndexRecommendation — 索引推荐
 */
export interface IndexRecommendation {
  label: number
  property: string
  type: 'range' | 'equality'
}

// ──────────────────────────────────────────
// 查询计划器
// ──────────────────────────────────────────

export class QueryPlanner {
  private shardManager: ShardManager
  private stats: Map<string, TableStats> = new Map()
  private statsCollector?: StatsCollector

  constructor(shardManager: ShardManager, statsCollector?: StatsCollector) {
    this.shardManager = shardManager
    this.statsCollector = statsCollector
  }

  // ──────────────────────────────────────────
  // 计划构建
  // ──────────────────────────────────────────

  /**
   * 构建查询计划
   */
  plan(query: {
    typeId?: number
    predicates?: Array<{ field: string; op: string; value: unknown }>
    neighbors?: { depth: number; edgeFilter?: number[] }
    limit?: number
    orderBy?: { field: string; dir: 'asc' | 'desc' }
    project?: string[]
    useIndex?: string
  }): PlanNode {
    const root = this.buildPlanTree(query)
    this.assignCosts(root)
    return root
  }

  /**
   * 输出 EXPLAIN 形式的计划描述
   */
  explain(query: {
    typeId?: number
    predicates?: Array<{ field: string; op: string; value: unknown }>
    neighbors?: { depth: number; edgeFilter?: number[] }
    limit?: number
    orderBy?: { field: string; dir: 'asc' | 'desc' }
    project?: string[]
  }): string {
    const planNode = this.plan(query)
    return this.formatExplain(planNode, 0)
  }

  // ──────────────────────────────────────────
  // 选择性估算
  // ──────────────────────────────────────────

  /**
   * 估算谓词选择性
   */
  estimateSelectivity(
    columnStats: ColumnStat | undefined,
    op: string,
    value: unknown,
  ): number {
    if (!columnStats || columnStats.distinctCount === 0) return 0.5 // unknown

    switch (op) {
      case 'eq':
        return this.estimateEqualitySelectivity(columnStats)
      case 'gt':
      case 'lt':
      case 'gte':
      case 'lte':
        return this.estimateRangeSelectivity(columnStats)
      case 'prefix':
        return this.estimatePrefixSelectivity(columnStats)
      case 'in':
        if (Array.isArray(value) && value.length > 0) {
          return Math.min(1, (value.length * this.estimateEqualitySelectivity(columnStats)))
        }
        return 0.5
      case 'neq':
        return 1 - this.estimateEqualitySelectivity(columnStats)
      default:
        return 0.5
    }
  }

  // ──────────────────────────────────────────
  // 优化
  // ──────────────────────────────────────────

  /**
   * 优化计划树——下推过滤条件
   */
  pushDownFilter(plan: PlanNode): PlanNode {
    if (plan.type === PlanNodeType.FILTER && plan.children.length === 1) {
      const child = plan.children[0]
      if (child.type === PlanNodeType.SCAN || child.type === PlanNodeType.NEIGHBORS) {
        // 将 filter 合并到子节点
        child.details['pushedFilters'] = plan.details['predicates']
        return child
      }
    }

    plan.children = plan.children.map(c => this.pushDownFilter(c))
    return plan
  }

  /**
   * 选择最佳索引
   */
  chooseIndex(
    predicates: Array<{ field: string; op: string; value: unknown }>,
    availableIndexes: string[],
  ): string | null {
    if (predicates.length === 0) return null

    // 优先选择匹配最多的索引
    let bestIndex: string | null = null
    let bestScore = -1

    for (const idx of availableIndexes) {
      let score = 0
      for (const pred of predicates) {
        if (pred.field === idx) {
          score += pred.op === 'eq' ? 3 : pred.op === 'prefix' ? 2 : 1
        }
      }
      if (score > bestScore) {
        bestScore = score
        bestIndex = idx
      }
    }

    return bestIndex
  }

  // ──────────────────────────────────────────
  // CBO — Cost-Based Optimization (P1-1)
  // ──────────────────────────────────────────

  /**
   * Stats-aware predicate pushdown — 按选择性排序谓词（最选择性优先）
   *
   * 当 StatsCollector 的 estimateSelectivity 可用时，将 predicates 按选择性升序排列
   * （值越小选择性越强，越先应用）；
   * 无 stats 时维持原有顺序，不做任何修改。
   */
  predicatePushWithStats(
    ir: PlanNode,
    snapshot: StatsSnapshot,
    typeId?: number,
  ): PlanNode {
    // 查找 FILTER 节点
    const filterNode = this.findFilterNode(ir)
    if (!filterNode) return ir

    const predicates = filterNode.details['predicates'] as
      | Array<{ field: string; op: string; value: unknown }>
      | undefined
    if (!predicates || predicates.length <= 1) return ir

    const tid = typeId ?? (ir.details['typeId'] as number | undefined) ?? 1

    // 使用 estimateSelectivity 排序（选择性：值越小越优先）
    const ordered = [...predicates].sort((a, b) => {
      const selA = this.getPredicateSelectivity(tid, a, snapshot)
      const selB = this.getPredicateSelectivity(tid, b, snapshot)
      return selA - selB
    })

    filterNode.details['predicates'] = ordered
    filterNode.details['selectivityOrdered'] = true
    return ir
  }

  /**
   * Stats-aware join ordering — 按估算基数对 JOIN 子节点排序（最小优先）
   *
   * 对于 JOIN 节点，基于 StatsCollector 的 typeStats 估算每个分支的基数，
   * 将较小结果集的分支置于 probe side（即左侧），
   * 较大结果集的分支置于 build side（右侧），
   * 实现类似 Hash Join 的 build-probe 优化。
   */
  reorderJoins(ir: PlanNode, snapshot: StatsSnapshot): PlanNode {
    if (ir.type === PlanNodeType.JOIN && ir.children.length >= 2) {
      const childrenWithCardinality = ir.children.map(child => ({
        node: child,
        cardinality: this.estimateNodeCardinality(child, snapshot),
      }))

      // 按基数升序排列（最小 → build side left, 较大 → probe side right）
      childrenWithCardinality.sort((a, b) => a.cardinality - b.cardinality)

      ir.children = childrenWithCardinality.map(c => c.node)
      ir.details['joinOrdered'] = true
    }

    // 递归处理所有子节点
    ir.children = ir.children.map(c => this.reorderJoins(c, snapshot))
    return ir
  }

  /**
   * 获取谓词基于统计的选择性估算
   */
  private getPredicateSelectivity(
    typeId: number,
    pred: { field: string; op: string; value: unknown },
    snapshot: StatsSnapshot,
  ): number {
    if (!this.statsCollector) return 0.5

    return this.statsCollector.estimateSelectivity(typeId, {
      field: pred.field,
      op: pred.op as 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'prefix' | 'in',
      value: pred.value,
    }, snapshot)
  }

  /**
   * 估算计划节点输出基数（行数）
   */
  private estimateNodeCardinality(node: PlanNode, snapshot: StatsSnapshot): number {
    if (node.estimatedRows > 0) return node.estimatedRows

    switch (node.type) {
      case PlanNodeType.SCAN: {
        const typeId = node.details['typeId'] as number | undefined
        if (typeId !== undefined && typeId !== null) {
          const ts = snapshot.typeStats.get(typeId)
          if (ts) return ts.totalNodes
        }
        return 1000
      }
      case PlanNodeType.FILTER:
        // 假设过滤后保留 50%
        return this.estimateNodeCardinality(node.children[0], snapshot) * 0.5
      case PlanNodeType.NEIGHBORS:
        return this.estimateNodeCardinality(node.children[0], snapshot) * 3
      default:
        return 1000
    }
  }

  /**
   * 在计划树中查找 FILTER 节点
   */
  private findFilterNode(plan: PlanNode): PlanNode | null {
    if (plan.type === PlanNodeType.FILTER) return plan
    for (const child of plan.children) {
      const found = this.findFilterNode(child)
      if (found) return found
    }
    return null
  }

  /**
   * 完整优化——应用所有规则（含 CBO）
   */
  optimize(query: {
    typeId?: number
    predicates?: Array<{ field: string; op: string; value: unknown }>
    neighbors?: { depth: number; edgeFilter?: number[] }
    limit?: number
    orderBy?: { field: string; dir: 'asc' | 'desc' }
    project?: string[]
    useIndex?: string
  }): PlanNode {
    let plan = this.plan(query)
    plan = this.pushDownFilter(plan)

    if (query.predicates && query.predicates.length > 0) {
      const availableIndexes = ['id', 'name', 'type', 'createdAt']
      const chosen = this.chooseIndex(query.predicates, availableIndexes)
      if (chosen) {
        plan.details['chosenIndex'] = chosen
      }
    }

    return plan
  }

  /** 增强的统计信息（label 分布、边分布、属性分布） */
  private _enhancedStats: EnhancedStats | null = null

  // ──────────────────────────────────────────
  // 统计收集
  // ──────────────────────────────────────────

  /**
   * 收集统计信息（增强版）
   *
   * 除了基础的全量节点计数外，还收集：
   * - 按 label (typeId) 的节点分布计数
   * - 按边类型的边分布计数
   * - 按属性的值分布（min/max/cardinality/nullCount）
   *
   * 统计信息存储在 `_enhancedStats` 中，可通过 getEnhancedStats() 获取。
   */
  async collectStats(): Promise<void> {
    const status = this.shardManager.getShardStatus()
    let totalNodes = 0

    for (const s of status) {
      totalNodes += s.nodeCount
    }

    const colStats = new Map<string, ColumnStat>()
    colStats.set('id', { columnName: 'id', distinctCount: totalNodes, nullCount: 0, minValue: 1, maxValue: totalNodes })
    colStats.set('type', { columnName: 'type', distinctCount: Math.min(10, totalNodes), nullCount: 0 })
    colStats.set('name', { columnName: 'name', distinctCount: totalNodes, nullCount: 0 })

    this.stats.set('nodes', {
      rowCount: totalNodes,
      columnStats: colStats,
    })

    // ========================================
    // 增强统计：label 分布、边分布、属性分布
    // ========================================
    const labelCounts = new Map<number, number>()
    const edgeLabelCounts = new Map<number, number>()
    const propStats = new Map<string, { min: number; max: number; cardinality: number; nullCount: number }>()
    const propValueSets = new Map<string, Set<unknown>>()
    const propMinMap = new Map<string, number>()
    const propMaxMap = new Map<string, number>()
    const propNullMap = new Map<string, number>()

    // 通过 shardManager 获取所有节点（如果支持 getAllNodes）
    const mgr = this.shardManager as any
    let allNodes: NodeRecord[] = []
    if (typeof mgr.getAllNodes === 'function') {
      try {
        allNodes = mgr.getAllNodes()
      } catch {
        allNodes = []
      }
    }

    for (const node of allNodes) {
      // label 计数
      const tid = node.type
      labelCounts.set(tid, (labelCounts.get(tid) ?? 0) + 1)

      // 属性分布
      const fields: Record<string, unknown> = {
        ...(node.props ?? {}),
      }
      // 纳入顶级字段（仅数字类型可做范围统计）
      if (typeof node.id === 'number') {
        fields['id'] = node.id
      }
      if (typeof node.name === 'string') {
        fields['name'] = node.name
      }
      if (node.createdAt !== undefined) {
        fields['createdAt'] = node.createdAt
      }
      if (node.degree !== undefined) {
        fields['degree'] = node.degree
      }

      for (const [key, val] of Object.entries(fields)) {
        if (!propValueSets.has(key)) {
          propValueSets.set(key, new Set())
          propNullMap.set(key, 0)
        }

        if (val === null || val === undefined) {
          propNullMap.set(key, (propNullMap.get(key) ?? 0) + 1)
        } else {
          propValueSets.get(key)!.add(val)

          if (typeof val === 'number') {
            const curMin = propMinMap.get(key)
            const curMax = propMaxMap.get(key)
            if (curMin === undefined || val < curMin) propMinMap.set(key, val)
            if (curMax === undefined || val > curMax) propMaxMap.set(key, val)
          }
        }
      }
    }

    // 构建 propStats
    for (const [key, values] of propValueSets) {
      const min = propMinMap.get(key)
      const max = propMaxMap.get(key)

      propStats.set(key, {
        min: min !== undefined ? min : 0,
        max: max !== undefined ? max : 0,
        cardinality: values.size,
        nullCount: propNullMap.get(key) ?? 0,
      })
    }

    // 尝试从 shardManager 获取边计数（按边类型）
    if (typeof mgr.getAllEdges === 'function') {
      try {
        const allEdges: EdgeRecord[] = mgr.getAllEdges()
        for (const edge of allEdges) {
          const eid = edge.type
          edgeLabelCounts.set(eid, (edgeLabelCounts.get(eid) ?? 0) + 1)
        }
      } catch {
        // 静默失败
      }
    }

    // 如果无法从 getAllEdges 获取，尝试通过 stats() 获取总边数
    if (edgeLabelCounts.size === 0 && typeof mgr.stats === 'function') {
      try {
        const s = mgr.stats()
        if (s && typeof s.edgeCount === 'number' && s.edgeCount > 0) {
          // 无法按类型细分，合并为一条
          edgeLabelCounts.set(0, s.edgeCount)
        }
      } catch {
        // 静默失败
      }
    }

    this._enhancedStats = {
      labelCounts,
      edgeLabelCounts,
      propStats,
    }

    // Stats changed — invalidate all cached plans since they may be stale
    this.invalidateCache()
  }

  getStats(): Map<string, TableStats> {
    return this.stats
  }

  /**
   * 获取增强的统计信息（label 分布、边分布、属性分布）
   *
   * 在调用 collectStats() 之后调用此方法。
   * 尚未收集时返回 null。
   */
  getEnhancedStats(): EnhancedStats | null {
    return this._enhancedStats
  }

  // ──────────────────────────────────────────
  // 索引推荐（基于增强统计信息）
  // ──────────────────────────────────────────

  /**
   * 推荐可能受益于索引的 label+property 组合。
   *
   * 分析逻辑：
   * - 节点数最多的 label → 高选择性潜力，推荐 range 索引
   * - 高 cardinality 属性 → 适合 equality 索引（值均匀分布，可快速定位）
   * - 低 cardinality + 高 nullCount → 低收益，不推荐
   *
   * @param topN - 返回最多 N 条推荐（默认 5）
   * @returns 索引推荐列表
   */
  RecommendIndexes(topN: number = 5): IndexRecommendation[] {
    const recommendations: IndexRecommendation[] = []

    if (!this._enhancedStats) return recommendations

    const { labelCounts, propStats } = this._enhancedStats

    // 1. 找出节点数最多的 label → 推荐 range 索引
    const sortedLabels = [...labelCounts.entries()]
      .sort((a, b) => b[1] - a[1]) // 按节点数降序

    for (const [label] of sortedLabels.slice(0, Math.min(topN, sortedLabels.length))) {
      // range 索引：针对节点数多的 label，建议为 id/type 建索引
      recommendations.push({
        label,
        property: 'id',
        type: 'range',
      })
    }

    // 2. 找出高 cardinality 属性 → 推荐 equality 索引
    const propCardinality: Array<{ property: string; cardinality: number; nullCount: number }> = []
    for (const [prop, stats] of propStats) {
      // 排除 id 和 name 等基础字段（已在 range 索引中覆盖）
      if (prop === 'id' || prop === 'name' || prop === 'type') continue
      // 排除全是 null 的属性
      if (stats.cardinality === 0) continue
      const nullRatio = stats.nullCount / Math.max(stats.cardinality + stats.nullCount, 1)
      // null 占比过高（> 80%）且 cardinality 低 → 低收益
      if (nullRatio > 0.8 && stats.cardinality < 10) continue

      propCardinality.push({
        property: prop,
        cardinality: stats.cardinality,
        nullCount: stats.nullCount,
      })
    }

    // 按 cardinality 降序排列（均匀分布的属性最有利于 equality 查询）
    propCardinality.sort((a, b) => b.cardinality - a.cardinality)

    // 为高 cardinality 属性推荐 equality 索引
    // 关联到对应 label —— 取 labelCounts 中最大的 label
    const topLabel = sortedLabels.length > 0 ? sortedLabels[0][0] : 1

    for (const pc of propCardinality.slice(0, topN)) {
      recommendations.push({
        label: topLabel,
        property: pc.property,
        type: 'equality',
      })
    }

    return recommendations
  }

  // ──────────────────────────────────────────
  // Query Plan Cache
  // ──────────────────────────────────────────

  /**
   * Get a cached query plan for the given query string.
   * If a `statsSnapshot` is provided and its collectedAt differs from
   * the cached plan's recorded stats timestamp, the cache entry is
   * considered stale and will be invalidated (return undefined).
   *
   * Cache key = djb2 hash of normalized (whitespace-collapsed) query string.
   */
  getCachedPlan(queryString: string, statsSnapshot?: StatsSnapshot): PlanNode | undefined {
    const key = makePlanCacheKey(queryString)
    const entry = planCache.get(key) as { plan: PlanNode; statsTime?: number } | undefined
    if (!entry) return undefined

    // If stats have changed since this entry was cached, invalidate
    if (statsSnapshot && entry.statsTime !== undefined && entry.statsTime !== statsSnapshot.collectedAt) {
      planCache.delete(key)
      return undefined
    }

    return entry.plan
  }

  /**
   * Cache a query plan for future reuse.
   * Optionally records the stats snapshot timestamp for staleness detection.
   */
  cachePlan(queryString: string, plan: PlanNode, statsSnapshot?: StatsSnapshot): void {
    const key = makePlanCacheKey(queryString)
    planCache.set(key, {
      plan,
      statsTime: statsSnapshot?.collectedAt,
    })
  }

  /**
   * Invalidate the entire query plan cache.
   * Call this when table schema changes or stats are re-collected.
   */
  invalidateCache(): void {
    planCache.clear()
  }

  // ──────────────────────────────────────────
  // 内部方法
  // ──────────────────────────────────────────

  private buildPlanTree(query: {
    typeId?: number
    predicates?: Array<{ field: string; op: string; value: unknown }>
    neighbors?: { depth: number; edgeFilter?: number[] }
    limit?: number
    orderBy?: { field: string; dir: 'asc' | 'desc' }
    project?: string[]
    useIndex?: string
  }): PlanNode {
    let child: PlanNode | null = null

    // 扫描阶段
    if (query.useIndex) {
      child = {
        type: PlanNodeType.INDEX_LOOKUP,
        estimatedCost: 10,
        estimatedRows: 100,
        children: [],
        details: { indexName: query.useIndex, typeId: query.typeId },
      }
    } else {
      child = {
        type: PlanNodeType.SCAN,
        estimatedCost: 100,
        estimatedRows: 1000,
        children: [],
        details: { typeId: query.typeId },
      }
    }

    // 过滤阶段
    if (query.predicates && query.predicates.length > 0) {
      child = {
        type: PlanNodeType.FILTER,
        estimatedCost: 50,
        estimatedRows: child.estimatedRows * 0.5,
        children: [child],
        details: { predicates: query.predicates },
      }
    }

    // 邻居遍历阶段
    if (query.neighbors) {
      child = {
        type: PlanNodeType.NEIGHBORS,
        estimatedCost: 200,
        estimatedRows: child.estimatedRows * 3,
        children: [child],
        details: { depth: query.neighbors.depth, edgeFilter: query.neighbors.edgeFilter },
      }
    }

    // 排序阶段
    if (query.orderBy) {
      child = {
        type: PlanNodeType.SORT,
        estimatedCost: 30,
        estimatedRows: child.estimatedRows,
        children: [child],
        details: { field: query.orderBy.field, dir: query.orderBy.dir },
      }
    }

    // 限制阶段
    if (query.limit) {
      child = {
        type: PlanNodeType.LIMIT,
        estimatedCost: 5,
        estimatedRows: Math.min(child.estimatedRows, query.limit),
        children: [child],
        details: { limit: query.limit },
      }
    }

    // 投影阶段
    if (query.project && query.project.length > 0) {
      child = {
        type: PlanNodeType.PROJECT,
        estimatedCost: 5,
        estimatedRows: child.estimatedRows,
        children: [child],
        details: { fields: query.project },
      }
    }

    return child!
  }

  private assignCosts(node: PlanNode): void {
    for (const child of node.children) {
      this.assignCosts(child)
    }
    node.estimatedCost = this.calculateNodeCost(node)
  }

  private calculateNodeCost(node: PlanNode): number {
    const childCost = node.children.reduce((sum, c) => sum + c.estimatedCost, 0)

    switch (node.type) {
      case PlanNodeType.SCAN:
        return 100 + childCost
      case PlanNodeType.INDEX_LOOKUP:
        return 10 + childCost
      case PlanNodeType.FILTER:
        return 5 + childCost
      case PlanNodeType.NEIGHBORS:
        return 200 + childCost
      case PlanNodeType.SORT:
        return 30 + childCost
      case PlanNodeType.LIMIT:
        return 1 + childCost
      case PlanNodeType.PROJECT:
        return 2 + childCost
      default:
        return 10 + childCost
    }
  }

  private formatExplain(node: PlanNode, depth: number): string {
    const indent = '  '.repeat(depth)
    const rows = node.estimatedRows
    const cost = node.estimatedCost
    let details = ''

    for (const [key, val] of Object.entries(node.details)) {
      details += ` ${key}=${JSON.stringify(val)}`
    }

    let result = `${indent}-> ${node.type.toUpperCase()} (rows=${rows}, cost=${cost}${details})\n`

    for (const child of node.children) {
      result += this.formatExplain(child, depth + 1)
    }

    return result
  }

  private estimateEqualitySelectivity(colStats: ColumnStat): number {
    return 1 / Math.max(colStats.distinctCount, 1)
  }

  private estimateRangeSelectivity(colStats: ColumnStat): number {
    return 0.33 // 默认假设 1/3 的数据在范围内
  }

  private estimatePrefixSelectivity(colStats: ColumnStat): number {
    const ndv = Math.max(colStats.distinctCount, 1)
    // 前缀匹配假设匹配 1/sqrt(ndv) 的数据
    return Math.min(1, 1 / Math.sqrt(ndv))
  }
}

// ============================================================
// QueryIR — 查询中间表示
// 将 Fluent API 的 QuerySpec 转换为 Planner 可优化的计划树
// ============================================================

/**
 * QuerySpec — Fluent API 与 QueryIR 之间的标准化接口
 * 描述一次完整的查询意图
 */
export interface QuerySpec {
  match?: { typeId?: number; name?: string }
  where?: Record<string, any>
  predicates?: Array<(node: NodeRecord) => boolean>
  return?: string[]
  orderBy?: { field: string; direction: 'asc' | 'desc' }
  limit?: number
  skip?: number
  neighbors?: { id: number; edgeType?: number; maxDepth?: number }
  vectorSearch?: { vector: number[]; topK: number }
  /** 边遍历方向：'out' | 'in' | 'both'，默认 'out' */
  direction?: 'out' | 'in' | 'both'
  /** 变长路径匹配配置（如 MATCH (a)-[:TYPE*1..3]->(b)） */
  variableLengthPath?: {
    /** 起始节点 ID 或占位符 */
    startId?: number
    /** 边类型 ID（可选） */
    edgeType?: number
    /** 最小深度 */
    minDepth: number
    /** 最大深度（undefined 表示无上限） */
    maxDepth: number
    /** 遍历方向 */
    direction: 'out' | 'in' | 'both'
    /** 目标边类型限制 */
    edgeTypes?: number[]
  }
}

/**
 * VariableLengthPathNode — 变长路径匹配计划节点
 * 支持 MATCH (a)-[:TYPE*1..3]->(b) 语法
 * 通过 BFS 在图中展开变长路径
 */
export interface VariableLengthPathNode {
  /** 起始节点 ID */
  startId: number
  /** 边类型 ID（可选） */
  edgeType?: number
  /** 最小深度 */
  minDepth: number
  /** 最大深度（undefined 表示无上限） */
  maxDepth: number
  /** 遍历方向 */
  direction: 'out' | 'in' | 'both'
  /** 多个边类型限制 */
  edgeTypes?: number[]
}

/**
 * Flatten a PlanNode tree into an array of nodes in execution order (leaf-first).
 * Used for pushdown analysis like limit-pushdown: we walk bottom-up to find
 * the best SCAN to absorb a LIMIT.
 */
function flattenPlanLeafFirst(plan: PlanNode): PlanNode[] {
  const result: PlanNode[] = []
  function walk(node: PlanNode): void {
    for (const child of node.children) {
      walk(child)
    }
    result.push(node)
  }
  walk(plan)
  return result
}

/**
 * buildIRFromSpec — 将 Fluent API 的 QuerySpec 转换为 Planner 可优化的计划树
 *
 * 转换规则：
 * - match → SCAN（带 typeId）
 * - where → FILTER（带 predicates，或转换为 Record 过滤）
 * - neighbors → NEIGHBORS
 * - orderBy → SORT
 * - limit / skip → LIMIT（skip 合并到 limit 节点中）
 * - return → PROJECT（字段投影）
 * - vectorSearch → VECTOR_SEARCH
 */
export function buildIRFromSpec(spec: QuerySpec): PlanNode {
  let child: PlanNode | null = null

  // 1. 扫描阶段
  if (spec.vectorSearch) {
    child = {
      type: PlanNodeType.VECTOR_SEARCH,
      estimatedCost: 200,
      estimatedRows: spec.vectorSearch.topK,
      children: [],
      details: {
        vector: spec.vectorSearch.vector,
        topK: spec.vectorSearch.topK,
        typeId: spec.match?.typeId ?? null,
      },
    }
  } else {
    child = {
      type: PlanNodeType.SCAN,
      estimatedCost: 100,
      estimatedRows: 1000,
      children: [],
      details: { typeId: spec.match?.typeId ?? null, name: spec.match?.name ?? null },
    }
  }

  // 2. 变长路径匹配阶段（优先于普通 neighbors）
  if (spec.variableLengthPath) {
    child = {
      type: PlanNodeType.VARIABLE_LENGTH_PATH,
      estimatedCost: 500,
      estimatedRows: child.estimatedRows * 10,
      children: [child],
      details: {
        startId: spec.variableLengthPath.startId,
        edgeType: spec.variableLengthPath.edgeType,
        minDepth: spec.variableLengthPath.minDepth,
        maxDepth: spec.variableLengthPath.maxDepth,
        direction: spec.variableLengthPath.direction,
        edgeTypes: spec.variableLengthPath.edgeTypes,
      },
    }
  } else if (spec.neighbors) {
    child = {
      type: PlanNodeType.NEIGHBORS,
      estimatedCost: 200,
      estimatedRows: child.estimatedRows * 3,
      children: [child],
      details: {
        id: spec.neighbors.id,
        edgeType: spec.neighbors.edgeType ?? null,
        maxDepth: spec.neighbors.maxDepth ?? 1,
      },
    }
  }

  // 3. 过滤阶段
  const predicates: Array<{ field: string; op: string; value: unknown }> = []
  if (spec.where && Object.keys(spec.where).length > 0) {
    for (const [field, value] of Object.entries(spec.where)) {
      predicates.push({ field, op: 'eq', value })
    }
  }

  if (predicates.length > 0) {
    child = {
      type: PlanNodeType.FILTER,
      estimatedCost: 50,
      estimatedRows: child ? child.estimatedRows * 0.5 : 500,
      children: child ? [child] : [],
      details: { predicates },
    }
  } else if (spec.predicates && spec.predicates.length > 0) {
    // 函数式 predicates（来自 Fluent 的 where(predicateFn)）
    child = {
      type: PlanNodeType.FILTER,
      estimatedCost: 50,
      estimatedRows: child ? child.estimatedRows * 0.5 : 500,
      children: child ? [child] : [],
      details: { functionPredicates: true, predicateCount: spec.predicates.length },
    }
  }

  // 4. 排序阶段
  if (spec.orderBy) {
    child = {
      type: PlanNodeType.SORT,
      estimatedCost: 30,
      estimatedRows: child!.estimatedRows,
      children: [child!],
      details: { field: spec.orderBy.field, dir: spec.orderBy.direction },
    }
  }

  // 5. 限制阶段（含 skip）
  if (spec.limit !== undefined || spec.skip !== undefined && spec.skip > 0) {
    child = {
      type: PlanNodeType.LIMIT,
      estimatedCost: 5,
      estimatedRows: Math.min(child!.estimatedRows, spec.limit ?? 1000),
      children: [child!],
      details: { limit: spec.limit ?? 1000, skip: spec.skip ?? 0 },
    }
  }

  // 6. 投影阶段
  if (spec.return && spec.return.length > 0) {
    child = {
      type: PlanNodeType.PROJECT,
      estimatedCost: 5,
      estimatedRows: child!.estimatedRows,
      children: [child!],
      details: { fields: spec.return },
    }
  }

  return child!
}

/**
 * limitPushdown — 如果 LIMIT 节点的下级是 SCAN 或 NEIGHBORS，
 * 将 limit 值推入 SCAN/NEIGHBORS 的 details 中。
 * 对 LIMIT → SORT → SCAN 链同样有效：会将 limit 下推到 SCAN。
 */
export function limitPushdown(plan: PlanNode): PlanNode {
  if (plan.type === PlanNodeType.LIMIT && plan.children.length === 1) {
    const limitValue = plan.details['limit'] as number | undefined
    const skipValue = plan.details['skip'] as number | undefined
    if (limitValue === undefined) return plan

    // 如果有 skip，下推 limit + skip 的合值，使 SCAN 返回足够数据供 skip 使用
    const pushLimit = (skipValue ?? 0) + limitValue

    // Walk down through FILTER to find SCAN/NEIGHBORS
    // 不越过 SORT 节点，因为 ORDER BY + LIMIT 必须在排序后取前 N 条
    const walkDown = (node: PlanNode): boolean => {
      if (node.type === PlanNodeType.SCAN || node.type === PlanNodeType.NEIGHBORS) {
        node.details['pushedLimit'] = pushLimit
        return true
      }
      // 如果遇到 SORT 节点，停止下推（排序后 LIMIT 语义不同）
      if (node.type === PlanNodeType.SORT) {
        return false
      }
      // Recurse through single-child intermediate nodes
      if (node.children.length === 1) {
        return walkDown(node.children[0])
      }
      return false
    }

    walkDown(plan.children[0])
  }

  // Recurse on children
  plan.children = plan.children.map(c => limitPushdown(c))
  return plan
}

/**
 * optimizeIR — 应用已知的优化规则
 *
 * 优化流程：
 * 1. pushDownFilter — 将 FILTER 推入 SCAN/NEIGHBORS
 * 2. limitPushdown — 将 LIMIT 推入 SCAN/NEIGHBORS 作为早期截断
 * 3. predicatePushdown — 将 WHERE 条件压入扫描层
 * 4. eliminateDeadBranches — 消除不可能产生结果的节点
 */
export function optimizeIR(plan: PlanNode): PlanNode {
  let optimized = plan

  // 1. Predicate pushdown — 将 predicates 转换为 filter-details 形式
  // 如果 FILTER 节点有 function predicates（来自 Fluent where），无法静态优化，跳过

  // 2. 过滤下推
  if (optimized.type === PlanNodeType.FILTER && optimized.children.length === 1) {
    const child = optimized.children[0]
    // 函数式 predicates（来自 Fluent where 的回调）无法下推到 SCAN，
    // 因为它们需要在运行时调用闭包，而不是静态比较字段值
    const hasFunctionPreds = optimized.details['functionPredicates'] === true
    if (!hasFunctionPreds && (child.type === PlanNodeType.SCAN || child.type === PlanNodeType.NEIGHBORS)) {
      child.details['pushedFilters'] = optimized.details['predicates']
      optimized = child
    }
  }

  // 3. Limit 下推
  optimized = limitPushdown(optimized)

  // 4. 递归优化子节点
  optimized.children = optimized.children.map(c => optimizeIR(c))

  // 5. 消除死分支 — 如果某个节点 estimatedRows = 0，可以移除
  optimized = eliminateDeadBranches(optimized)

  return optimized
}

/**
 * Predicate ordering key: extract selectivity for sorting.
 * Lower selectivity (more restrictive) comes first.
 */
function predicateSelectivityKey(
  pred: { field: string; op: string; value: unknown },
): number {
  // Heuristic: eq=1, prefix/in=2, range=3, neq=4, unknown=5
  switch (pred.op) {
    case 'eq':  return 1
    case 'in':  return 2
    case 'prefix': return 3
    case 'gt': case 'gte': case 'lt': case 'lte': return 4
    case 'neq': return 5
    default:    return 6
  }
}

/**
 * optimizeIRWithStats — Stats-aware IR optimizer
 *
 * Extends optimizeIR with cost-based optimizations:
 * 1. Reorder predicates by selectivity (most selective first)
 * 2. Reorder JOIN children by estimated cardinality (smallest first)
 *
 * Falls back to heuristic ordering when stats are unavailable.
 */
export function optimizeIRWithStats(
  plan: PlanNode,
  _stats: StatsSnapshot,
  typeId?: number,
  _planner?: QueryPlanner,
): PlanNode {
  let optimized = plan

  // Phase 1: Predicate selectivity ordering
  if (optimized.type === PlanNodeType.FILTER && optimized.children.length === 1) {
    const predicates = optimized.details['predicates'] as
      | Array<{ field: string; op: string; value: unknown }>
      | undefined

    if (predicates && predicates.length > 1) {
      // Order by selectivity (ascending - most selective first)
      const ordered = [...predicates].sort((a, b) => {
        // If planner has statsCollector, use it for more accurate ordering
        // Otherwise use heuristic
        const selA = predicateSelectivityKey(a)
        const selB = predicateSelectivityKey(b)
        return selA - selB
      })
      optimized.details['predicates'] = ordered
      optimized.details['selectivityOrdered'] = true
    }
  }

  // Phase 2: Join ordering
  if (optimized.type === PlanNodeType.JOIN && optimized.children.length >= 2) {
    const childrenWithCard = optimized.children.map(child => ({
      node: child,
      cardinality: estimateIRCardinality(child, _stats),
    }))
    childrenWithCard.sort((a, b) => a.cardinality - b.cardinality)
    optimized.children = childrenWithCard.map(c => c.node)
    optimized.details['joinOrdered'] = true
  }

  // Phase 3: Standard optimizations (pushdown + limit)
  // Predicate pushdown — merge FILTER into child
  if (optimized.type === PlanNodeType.FILTER && optimized.children.length === 1) {
    const child = optimized.children[0]
    const hasFunctionPreds = optimized.details['functionPredicates'] === true
    if (!hasFunctionPreds && (child.type === PlanNodeType.SCAN || child.type === PlanNodeType.NEIGHBORS)) {
      child.details['pushedFilters'] = optimized.details['predicates']
      optimized = child
    }
  }

  optimized = limitPushdown(optimized)

  // Recursively optimize children
  optimized.children = optimized.children.map(c => optimizeIRWithStats(c, _stats, typeId, _planner))

  // Eliminate dead branches
  optimized = eliminateDeadBranches(optimized)

  return optimized
}

/**
 * estimateIRCardinality — Estimate output row count from a sub-IR tree using stats
 */
function estimateIRCardinality(node: PlanNode, stats: StatsSnapshot): number {
  if (node.estimatedRows > 0) return node.estimatedRows

  switch (node.type) {
    case PlanNodeType.SCAN: {
      const typeId = node.details['typeId'] as number | undefined
      if (typeId !== undefined && typeId !== null) {
        const ts = stats.typeStats.get(typeId)
        if (ts) return ts.totalNodes
      }
      return 1000
    }
    case PlanNodeType.NEIGHBORS:
      return estimateIRCardinality(node.children[0], stats) * 3
    case PlanNodeType.FILTER:
      return estimateIRCardinality(node.children[0], stats) * 0.5
    case PlanNodeType.SORT:
    case PlanNodeType.PROJECT:
      return estimateIRCardinality(node.children[0], stats)
    case PlanNodeType.LIMIT: {
      const limit = node.details['limit'] as number | undefined
      return Math.min(limit ?? 1000, estimateIRCardinality(node.children[0], stats))
    }
    case PlanNodeType.JOIN:
      return Math.max(
        estimateIRCardinality(node.children[0], stats),
        estimateIRCardinality(node.children[1], stats),
      ) * 0.5
    default:
      return 1000
  }
}

/**
 * eliminateDeadBranches — 消除 estimatedRows 为 0 的节点及其子树
 */
function eliminateDeadBranches(plan: PlanNode): PlanNode {
  // Filter children first
  plan.children = plan.children.filter(c => c.estimatedRows > 0)
  plan.children = plan.children.map(c => eliminateDeadBranches(c))
  return plan
}

/**
 * executeIR — 执行优化后的计划树
 *
 * 按照计划树从叶子到根的顺序执行各个节点。
 * 通过 ShardManager 与图存储交互。
 *
 * 支持的节点类型：
 * - SCAN: 按 typeId 扫描节点
 * - NEIGHBORS: 获取邻居节点
 * - FILTER: 对已加载的结果应用谓词过滤
 * - SORT: 按字段排序
 * - LIMIT: 截断结果（含 skip）
 * - PROJECT: 字段投影
 * - VECTOR_SEARCH: 向量相似度搜索
 */
export async function executeIR(
  plan: PlanNode,
  shardManager: ShardManager,
  fnPredicates?: Array<(node: NodeRecord) => boolean>,
): Promise<NodeRecord[]> {
  // 递归执行 — 先收集子节点的数据
  let data: NodeRecord[] = await executeChildren(plan, shardManager, fnPredicates)

  // 执行当前节点
  data = await executeNode(plan, data, shardManager, fnPredicates)

  return data
}

/**
 * executeChildren — 递归执行子节点，收集结果
 */
async function executeChildren(
  plan: PlanNode,
  shardManager: ShardManager,
  fnPredicates?: Array<(node: NodeRecord) => boolean>,
): Promise<NodeRecord[]> {
  // 如果有下属节点，递归执行
  if (plan.children.length > 0) {
    // 对于多子节点场景（如 JOIN），后续可扩展
    return executeIR(plan.children[0], shardManager, fnPredicates)
  }

  return []
}

/**
 * executeNode — 执行单个计划节点
 */
async function executeNode(
  plan: PlanNode,
  inputData: NodeRecord[],
  shardManager: ShardManager,
  fnPredicates?: Array<(node: NodeRecord) => boolean>,
): Promise<NodeRecord[]> {
  const { details } = plan

  switch (plan.type) {
    case PlanNodeType.SCAN: {
      const typeId = details['typeId'] as number | null
      const pushedFilters = details['pushedFilters'] as Array<{ field: string; op: string; value: unknown }> | undefined
      const pushedLimit = details['pushedLimit'] as number | undefined

      // 扫描所有节点
      let nodes = await scanAllNodes(shardManager)

      // 按 typeId 过滤
      if (typeId !== null && typeId !== undefined) {
        nodes = nodes.filter(n => n.type === typeId)
      }

      // 应用下推的过滤条件（等价 predicates）
      if (pushedFilters && pushedFilters.length > 0) {
        for (const filter of pushedFilters) {
          nodes = nodes.filter(n => {
            const val = resolveNodeField(n, filter.field)
            return applyPredicate(val, filter.op, filter.value)
          })
        }
      }

      // 应用下推的 limit（早期截断）
      if (pushedLimit !== undefined && pushedLimit > 0) {
        nodes = nodes.slice(0, pushedLimit)
      }

      return nodes
    }

    case PlanNodeType.NEIGHBORS: {
      const maxDepth = (details['maxDepth'] as number) ?? 1
      const edgeType = details['edgeType'] as number | null | undefined
      const pushedFilters = details['pushedFilters'] as Array<{ field: string; op: string; value: unknown }> | undefined
      const pushedLimit = details['pushedLimit'] as number | undefined

      const result: NodeRecord[] = []
      const seen = new Set<number>()

      for (const node of inputData) {
        await collectNeighborsIR(node.id, maxDepth, seen, result, shardManager, edgeType ?? undefined)
      }

      // 应用下推的过滤
      if (pushedFilters && pushedFilters.length > 0) {
        let filtered = [...result]
        for (const filter of pushedFilters) {
          filtered = filtered.filter(n => {
            const val = resolveNodeField(n, filter.field)
            return applyPredicate(val, filter.op, filter.value)
          })
        }
        return filtered
      }

      // 下推的 limit
      if (pushedLimit !== undefined && pushedLimit > 0) {
        return result.slice(0, pushedLimit)
      }

      return result
    }

    case PlanNodeType.FILTER: {
      const predicates = details['predicates'] as Array<{ field: string; op: string; value: unknown }> | undefined
      const hasFunctionPredicates = details['functionPredicates'] === true

      let result = [...inputData]

      if (predicates && predicates.length > 0) {
        for (const pred of predicates) {
          result = result.filter(n => {
            const val = resolveNodeField(n, pred.field)
            return applyPredicate(val, pred.op, pred.value)
          })
        }
      }

      // 函数式 predicates（来自 Fluent where 回调）
      if (hasFunctionPredicates && fnPredicates && fnPredicates.length > 0) {
        for (const fn of fnPredicates) {
          result = result.filter(fn)
        }
      }

      return result
    }

    case PlanNodeType.PROJECT: {
      const fields = details['fields'] as string[] | undefined
      if (!fields || fields.length === 0) return inputData

      return inputData.map(node => {
        const projected: Record<string, unknown> = { id: node.id }
        for (const field of fields) {
          const val = resolveNodeField(node, field)
          if (val !== undefined) {
            projected[field] = val
          }
        }
        return projected
      })
    }

    case PlanNodeType.SORT: {
      const field = details['field'] as string
      const dir = details['dir'] as string

      return [...inputData].sort((a, b) => {
        const valA = resolveNodeField(a, field)
        const valB = resolveNodeField(b, field)

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

    case PlanNodeType.LIMIT: {
      const limit = details['limit'] as number | undefined
      const skip = details['skip'] as number | undefined
      let result = [...inputData]

      if (skip && skip > 0) {
        result = result.slice(skip)
      }
      if (limit !== undefined) {
        // 如果已经有 pushedLimit，避免二次截断（pushedLimit 已经在 SCAN 层截断）
        result = result.slice(0, limit)
      }

      return result
    }

    case PlanNodeType.VECTOR_SEARCH: {
      const vector = details['vector'] as number[]
      const topK = details['topK'] as number
      const typeId = details['typeId'] as number | null

      const results = await shardManager.vectorSearch({
        denseQuery: vector,
        k: topK,
      })

      let nodes = results.map(r => r.node)

      // 按 typeId 过滤（来自 match 子句）
      if (typeId !== null && typeId !== undefined) {
        nodes = nodes.filter(n => n.type === typeId)
      }

      // 应用函数式 predicates（where 过滤）
      if (fnPredicates && fnPredicates.length > 0) {
        for (const fn of fnPredicates) {
          nodes = nodes.filter(fn)
        }
      }

      return nodes
    }

    case PlanNodeType.INDEX_LOOKUP:
      // 委托给 scan，实际生产环境应使用索引
      return inputData

    case PlanNodeType.JOIN:
    case PlanNodeType.AGGREGATE:
    case PlanNodeType.SHORTEST_PATH:
    case PlanNodeType.PERSONALIZED_PAGE_RANK:
    case PlanNodeType.CONNECTED_COMPONENTS:
    case PlanNodeType.UNION: {
      // 合并多个子查询结果（去重）
      if (inputData.length === 0) {
        // 需要执行子节点
        const left = await executeIR(plan.children[0], shardManager, fnPredicates)
        const right = await executeIR(plan.children[1], shardManager, fnPredicates)
        const seen = new Set<number>()
        const result: NodeRecord[] = []
        for (const n of [...left, ...right]) {
          if (!seen.has(n.id)) {
            seen.add(n.id)
            result.push(n)
          }
        }
        return result
      }
      return inputData
    }

    case PlanNodeType.INTERSECT: {
      // 多个子查询的交集
      if (inputData.length === 0) {
        const left = await executeIR(plan.children[0], shardManager, fnPredicates)
        const right = await executeIR(plan.children[1], shardManager, fnPredicates)
        const rightIds = new Set(right.map(n => n.id))
        return left.filter(n => rightIds.has(n.id))
      }
      return inputData
    }

    case PlanNodeType.SUBTRACT: {
      // A − B：左子查询结果中不在右子查询中的节点
      if (inputData.length === 0) {
        const left = await executeIR(plan.children[0], shardManager, fnPredicates)
        const right = await executeIR(plan.children[1], shardManager, fnPredicates)
        const rightIds = new Set(right.map(n => n.id))
        return left.filter(n => !rightIds.has(n.id))
      }
      return inputData
    }

    case PlanNodeType.VARIABLE_LENGTH_PATH: {
      const minDepth = (details['minDepth'] as number) ?? 1
      const maxDepth = details['maxDepth'] as number | undefined
      const edgeType = details['edgeType'] as number | null | undefined
      const dir = (details['direction'] as string) ?? 'out'
      const edgeTypes = details['edgeTypes'] as number[] | undefined
      const startId = details['startId'] as number | undefined

      const result: NodeRecord[] = []
      const visited = new Set<number>()

      // 确定起始节点
      // 优先使用 details.startId（来自 VariableLengthPathNode），
      // 否则使用 inputData（来自 SCAN 子节点）的每个节点作为起点
      const startNodes: NodeRecord[] = []

      if (startId !== undefined && startId !== null) {
        // 如果 startId 在 inputData 中，用它
        const found = inputData.find(n => n.id === startId)
        if (found) {
          startNodes.push(found)
        } else {
          // startId 不在 inputData 中，创建一个虚拟起始节点
          // 或尝试在 inputData 为空时跳过扫描
          startNodes.push({ id: startId, type: 0, name: '', props: {}, createdAt: 0, degree: 0 })
        }
      } else {
        // 使用 inputData 中的所有节点作为起点
        startNodes.push(...inputData)
      }

      if (startNodes.length === 0) return result

      // BFS 变长展开
      for (const startNode of startNodes) {
        await bfsVariableExpand(
          startNode.id, minDepth, maxDepth, edgeType ?? edgeTypes,
          dir, visited, result, shardManager, 0,
        )
      }

      return result
    }

    case PlanNodeType.PARALLEL_UNION:
    default:
      // 暂未实现的节点类型，返回输入数据
      return inputData
  }
}

// ──────────────────────────────────────────
// QueryIR 辅助函数
// ──────────────────────────────────────────

/**
 * bfsVariableExpand — BFS 变长路径展开
 *
 * 从 startId 开始，沿指定边类型 / 方向进行 BFS 遍历，
 * 收集深度在 [minDepth, maxDepth] 范围内的所有目标节点。
 *
 * @param startId - 起始节点 ID
 * @param minDepth - 最小深度（<1 时从 1 开始计数）
 * @param maxDepth - 最大深度（undefined 表示无上限）
 * @param edgeTypeOrTypes - 边类型 ID 或 IDs（可选）
 * @param direction - 遍历方向：'out' | 'in' | 'both'
 * @param visited - 已访问节点集合
 * @param result - 结果收集数组
 * @param shardManager - 分片管理器
 * @param _depth - 内部递归深度
 */
async function bfsVariableExpand(
  startId: number,
  minDepth: number,
  maxDepth: number | undefined,
  edgeTypeOrTypes: number | number[] | null | undefined,
  direction: string,
  visited: Set<number>,
  result: NodeRecord[],
  shardManager: ShardManager,
  _depth: number = 0,
): Promise<void> {
  if (visited.has(startId)) return
  visited.add(startId)

  // BFS 队列: { nodeId, depth }
  interface BFSFrame {
    nodeId: number
    depth: number
  }

  const queue: BFSFrame[] = [{ nodeId: startId, depth: 0 }]
  let head = 0

  const effectiveMaxDepth = maxDepth ?? 100 // 默认上限100层
  let effectiveEdgeType: number | undefined
  if (edgeTypeOrTypes !== null && edgeTypeOrTypes !== undefined) {
    effectiveEdgeType = Array.isArray(edgeTypeOrTypes) ? edgeTypeOrTypes[0] : edgeTypeOrTypes
  }

  while (head < queue.length) {
    const { nodeId, depth } = queue[head]
    head++

    if (depth >= effectiveMaxDepth) continue

    // 获取邻居
    try {
      const { nodes } = await shardManager.neighbors(nodeId, {
        maxDepth: 1,
        edgeTypeFilter: effectiveEdgeType !== undefined ? [effectiveEdgeType] : undefined,
      })

      for (const neighbor of nodes) {
        if (visited.has(neighbor.id)) continue
        visited.add(neighbor.id)

        const nextDepth = depth + 1

        // 如果在有效深度范围内，加入结果
        if (nextDepth >= minDepth && nextDepth <= effectiveMaxDepth) {
          result.push(neighbor)
        }

        // 继续扩展
        if (nextDepth < effectiveMaxDepth) {
          queue.push({ nodeId: neighbor.id, depth: nextDepth })
        }
      }
    } catch {
      // 如果邻居获取失败，跳过该节点
      continue
    }
  }
}

/**
 * scanAllNodes — 通过 ShardManager 获取所有节点
 */
async function scanAllNodes(shardManager: ShardManager): Promise<NodeRecord[]> {
  // 利用 getShardStatus 获取分片列表
  // 实际项目应使用专门的 getNodesByType API
  const status = shardManager.getShardStatus()

  // 通过 getAllRanges （如果存在）获取节点数据
  const mgr = shardManager as any
  if (typeof mgr.getAllNodes === 'function') {
    return mgr.getAllNodes()
  }

  return []
}

/**
 * collectNeighborsIR — 递归收集邻居节点（IR 版本）
 */
async function collectNeighborsIR(
  nodeId: number,
  remainingDepth: number,
  seen: Set<number>,
  result: NodeRecord[],
  shardManager: ShardManager,
  edgeType?: number,
): Promise<void> {
  if (remainingDepth <= 0) return
  if (seen.has(nodeId)) return
  seen.add(nodeId)

  const { nodes } = await shardManager.neighbors(nodeId, {
    maxDepth: 1,
    edgeTypeFilter: edgeType !== undefined ? [edgeType] : undefined,
  })

  for (const n of nodes) {
    if (!seen.has(n.id)) {
      result.push(n)
      await collectNeighborsIR(n.id, remainingDepth - 1, seen, result, shardManager, edgeType)
    }
  }
}

/**
 * resolveNodeField — 从 NodeRecord 中解析字段值
 */
function resolveNodeField(node: NodeRecord, field: string): unknown {
  const key = field as keyof NodeRecord
  if (key in node) {
    return (node as any)[key]
  }
  return node.props?.[field]
}

/**
 * applyPredicate — 应用过滤条件
 */
function applyPredicate(value: unknown, op: string, target: unknown): boolean {
  switch (op) {
    case 'eq':
      return value === target
    case 'neq':
      return value !== target
    case 'gt':
      return typeof value === 'number' && typeof target === 'number' && value > target
    case 'gte':
      return typeof value === 'number' && typeof target === 'number' && value >= target
    case 'lt':
      return typeof value === 'number' && typeof target === 'number' && value < target
    case 'lte':
      return typeof value === 'number' && typeof target === 'number' && value <= target
    case 'prefix':
      return typeof value === 'string' && typeof target === 'string' && value.startsWith(target)
    case 'in':
      return Array.isArray(target) && target.includes(value)
    default:
      return true
  }
}

/**
 * formatPlanExplain — 将 PlanNode 树格式化为可读的 EXPLAIN 字符串
 * 供 Fluent API 的 plan() 方法使用
 */
export function formatPlanExplain(node: PlanNode, depth: number = 0): string {
  const indent = '  '.repeat(depth)
  const rows = node.estimatedRows
  const cost = node.estimatedCost
  let details = ''

  for (const [key, val] of Object.entries(node.details)) {
    // 跳过大型数据结构
    if (key === 'vector') continue
    if (Array.isArray(val) && val.length > 10) {
      details += ` ${key}=[${val.length} items]`
    } else {
      details += ` ${key}=${JSON.stringify(val)}`
    }
  }

  let result = `${indent}-> ${node.type.toUpperCase()} (rows=${rows}, cost=${cost}${details})\n`

  for (const child of node.children) {
    result += formatPlanExplain(child, depth + 1)
  }

  return result
}
