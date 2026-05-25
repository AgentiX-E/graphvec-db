// ============================================================
// QueryPlanner — 查询计划生成器
// 将 GraphQuery 转换为可优化的计划树
// ============================================================

import { ShardManager } from '../shard/shard-manager'
import { NodeRecord, EdgeRecord } from '../types'

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

// ──────────────────────────────────────────
// 查询计划器
// ──────────────────────────────────────────

export class QueryPlanner {
  private shardManager: ShardManager
  private stats: Map<string, TableStats> = new Map()

  constructor(shardManager: ShardManager) {
    this.shardManager = shardManager
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

  /**
   * 完整优化——应用所有规则
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

  // ──────────────────────────────────────────
  // 统计收集
  // ──────────────────────────────────────────

  /**
   * 收集统计信息
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
  }

  getStats(): Map<string, TableStats> {
    return this.stats
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
      details: { vector: spec.vectorSearch.vector, topK: spec.vectorSearch.topK },
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

  // 2. 邻居遍历阶段（在过滤之前，因为 neighbors 在 Fluent 中通常比 where 更早链式调用）
  if (spec.neighbors) {
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
    if (limitValue === undefined) return plan

    // Walk down through SORT, FILTER to find SCAN/NEIGHBORS
    const walkDown = (node: PlanNode): boolean => {
      if (node.type === PlanNodeType.SCAN || node.type === PlanNodeType.NEIGHBORS) {
        node.details['pushedLimit'] = limitValue
        return true
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
        // Preserve type and props to satisfy NodeRecord interface
        projected['type'] = node.type
        projected['name'] = node.name ?? ''
        projected['props'] = {}
        return projected as unknown as NodeRecord
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

      const results = await shardManager.vectorSearch({
        denseQuery: vector,
        k: topK,
      })

      return results.map(r => r.node)
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
