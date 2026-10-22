// ============================================================
// OptimizerBridge — QueryOptimizer ↔ GraphEngine 桥接层
//
// 将 QueryIR 的优化规则（filter pushdown, limit early cutoff）
// 与 GraphEngine 的 StorageProvider 查询路径打通，使 query()
// 能从优化器获益。
// ============================================================

import { GraphEngine } from '../core/graph-engine'
import { QueryPlanner, PlanNodeType, PlanNode } from '../api/query-planner'
import {
  buildIRFromSpec,
  optimizeIR,
  formatPlanExplain,
  QuerySpec,
} from '../api/query-planner'
import { NodeRecord } from '../types'

/**
 * OptimizerBridge — 优化器桥接层
 *
 * 负责将 IR 优化后的 PlanNode 树转译为 GraphEngine 可执行的
 * 存储级操作（通过 StorageProvider 的 scanNodes / getNode 等接口）。
 *
 * 支持的操作：
 * - Scan with filter pushdown（全表扫描 + 预过滤）
 * - Limit early cutoff（早期截断减少扫描量）
 * - Filter（对扫描结果做精确过滤）
 * - Project（字段投影，仅返回指定字段）
 * - Sort（排序）
 * - Skip（跳过前 N 条）
 * - Union（合并多个查询结果）
 */
export class OptimizerBridge {
  private engine: GraphEngine

  constructor(engine: GraphEngine) {
    this.engine = engine
  }

  // ──────────────────────────────────────────
  // 公共 API
  // ──────────────────────────────────────────

  /**
   * 通过优化器执行查询。
   *
   * 流程：
   * 1. 构建 QuerySpec → buildIRFromSpec → PlanNode
   * 2. 优化：optimizeIR（filter pushdown, limit early cutoff）
   * 3. 转译为存储操作并执行
   *
   * @param spec - 查询规格（兼容 Fluent API 的 QuerySpec）
   * @returns 节点记录数组
   */
  async executeOptimized(spec: QuerySpec): Promise<NodeRecord[]> {
    const ir = buildIRFromSpec(spec)
    const optimized = optimizeIR(ir)
    return this._executeOptimizedIR(optimized, spec)
  }

  /**
   * 通过优化器执行查询（字符串版本，仅用于测试）。
   *
   * @param queryString - 查询字符串（保留给 query() Cypher 路径使用）
   * @deprecated 请使用 executeOptimized(spec)
   */
  async executeOptimizedString(_queryString: string): Promise<NodeRecord[]> {
    // 当前 Cypher-lite query() 的字符串解析返回的是 QueryPlan，
    // 不是 QuerySpec。此方法保留为未来扩展使用。
    throw new Error('Use executeOptimized(QuerySpec) or enable optimizer via GraphEngine.query()')
  }

  /**
   * 生成 EXPLAIN 计划。
   *
   * @param spec - 查询规格
   * @returns 可读的计划描述字符串
   */
  explain(spec: QuerySpec): string {
    const ir = buildIRFromSpec(spec)
    const optimized = optimizeIR(ir)
    return formatPlanExplain(optimized)
  }

  // ──────────────────────────────────────────
  // 内部方法
  // ──────────────────────────────────────────

  /**
   * 执行优化后的 IR 计划。
   *
   * 转译步骤：
   * 1. 从计划树中识别 SCAN、NEIGHBORS 等叶子节点
   * 2. 对 SCAN 节点应用 pushedFilters 和 pushedLimit
   * 3. 按树上序执行 FILTER、SORT、LIMIT、PROJECT 等中间节点
   */
  private async _executeOptimizedIR(
    plan: PlanNode,
    spec: QuerySpec,
  ): Promise<NodeRecord[]> {
    // 递归执行 — 先执行子节点收集数据
    let data: NodeRecord[] = await this._executeChildren(plan, spec)

    // 执行当前节点
    data = await this._executeNode(plan, data, spec)

    return data
  }

  /**
   * 递归执行子节点。
   */
  private async _executeChildren(
    plan: PlanNode,
    spec: QuerySpec,
  ): Promise<NodeRecord[]> {
    if (plan.children.length === 0) {
      return []
    }
    // 目前只处理单子节点（绝大多数查询都是线性管道）
    return this._executeOptimizedIR(plan.children[0], spec)
  }

  /**
   * 执行单个计划节点。
   */
  private async _executeNode(
    plan: PlanNode,
    _inputData: NodeRecord[],
    spec: QuerySpec,
  ): Promise<NodeRecord[]> {
    const { details } = plan

    switch (plan.type) {
      // ── 扫描 ──
      case PlanNodeType.SCAN: {
        const typeId = details['typeId'] as number | null | undefined
        const pushedFilters = details['pushedFilters'] as
          | Array<{ field: string; op: string; value: unknown }>
          | undefined
        const pushedLimit = details['pushedLimit'] as number | undefined

        // 使用 GraphEngine 获取所有节点
        let nodes = this._scanAllNodes()

        // 按 typeId 过滤
        if (typeId !== null && typeId !== undefined) {
          nodes = nodes.filter(n => n.type === typeId)
        }

        // 应用下推的过滤条件
        if (pushedFilters && pushedFilters.length > 0) {
          for (const filter of pushedFilters) {
            nodes = nodes.filter(n => {
              const val = this._resolveNodeField(n, filter.field)
              return this._applyPredicate(val, filter.op, filter.value)
            })
          }
        }

        // 应用下推的 limit（早期截断）
        if (pushedLimit !== undefined && pushedLimit > 0) {
          nodes = nodes.slice(0, pushedLimit)
        }

        return nodes
      }

      // ── 邻居遍历 ──
      case PlanNodeType.NEIGHBORS: {
        const maxDepth = (details['maxDepth'] as number) ?? 1
        const edgeType = details['edgeType'] as number | null | undefined
        const pushedFilters = details['pushedFilters'] as
          | Array<{ field: string; op: string; value: unknown }>
          | undefined
        const pushedLimit = details['pushedLimit'] as number | undefined

        const result: NodeRecord[] = []

        // 输入数据来自子节点（SCAN），从中找邻居
        for (const node of _inputData) {
          const visited = new Set<number>()
          await this._collectNeighbors(
            node.id,
            maxDepth,
            visited,
            result,
            edgeType ?? undefined,
          )
        }

        // 应用下推的过滤
        if (pushedFilters && pushedFilters.length > 0) {
          let filtered = [...result]
          for (const filter of pushedFilters) {
            filtered = filtered.filter(n => {
              const val = this._resolveNodeField(n, filter.field)
              return this._applyPredicate(val, filter.op, filter.value)
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

      // ── 过滤 ──
      case PlanNodeType.FILTER: {
        const predicates = details['predicates'] as
          | Array<{ field: string; op: string; value: unknown }>
          | undefined
        const hasFunctionPreds = details['functionPredicates'] === true

        let result = [..._inputData]

        if (predicates && predicates.length > 0) {
          for (const pred of predicates) {
            result = result.filter(n => {
              const val = this._resolveNodeField(n, pred.field)
              return this._applyPredicate(val, pred.op, pred.value)
            })
          }
        }

        // 函数式 predicates（来自 Fluent where 回调）
        if (hasFunctionPreds && spec.predicates && spec.predicates.length > 0) {
          for (const fn of spec.predicates) {
            result = result.filter(fn)
          }
        }

        return result
      }

      // ── 投影 ──
      case PlanNodeType.PROJECT: {
        const fields = details['fields'] as string[] | undefined
        if (!fields || fields.length === 0) return _inputData

        return _inputData.map(node => {
          const projected: Record<string, unknown> = { id: node.id }
          for (const field of fields) {
            const val = this._resolveNodeField(node, field)
            if (val !== undefined) {
              projected[field] = val
            }
          }
          projected['type'] = node.type
          projected['name'] = node.name ?? ''
          projected['props'] = {}
          return projected as unknown as NodeRecord
        })
      }

      // ── 排序 ──
      case PlanNodeType.SORT: {
        const field = details['field'] as string
        const dir = (details['dir'] ?? details['direction']) as string

        return [..._inputData].sort((a, b) => {
          const valA = this._resolveNodeField(a, field)
          const valB = this._resolveNodeField(b, field)

          if (valA == null && valB == null) return 0
          if (valA == null) return 1
          if (valB == null) return -1

          if (typeof valA === 'string' && typeof valB === 'string') {
            return dir === 'asc'
              ? valA.localeCompare(valB)
              : valB.localeCompare(valA)
          }
          return dir === 'asc'
            ? Number(valA) - Number(valB)
            : Number(valB) - Number(valA)
        })
      }

      // ── 限制 ──
      case PlanNodeType.LIMIT: {
        const limit = details['limit'] as number | undefined
        const skip = details['skip'] as number | undefined
        let result = [..._inputData]

        if (skip && skip > 0) {
          result = result.slice(skip)
        }
        if (limit !== undefined) {
          result = result.slice(0, limit)
        }

        return result
      }

      // ── 集合运算 ──
      case PlanNodeType.UNION: {
        if (plan.children.length >= 2) {
          const left = await this._executeOptimizedIR(plan.children[0], spec)
          const right = await this._executeOptimizedIR(plan.children[1], spec)
          const seen = new Set<number>()
          const merged: NodeRecord[] = []
          for (const n of [...left, ...right]) {
            if (!seen.has(n.id)) {
              seen.add(n.id)
              merged.push(n)
            }
          }
          return merged
        }
        return _inputData
      }

      case PlanNodeType.VECTOR_SEARCH:
        // Vector search 需要通过 GraphEngine 的 vectorSearch 调用
        return _inputData

      case PlanNodeType.INDEX_LOOKUP:
        return _inputData

      default:
        return _inputData
    }
  }

  // ──────────────────────────────────────────
  // 存储辅助方法
  // ──────────────────────────────────────────

  /**
   * 通过 GraphEngine 的 _nodeIds 和 getNode 扫描所有节点。
   */
  private _scanAllNodes(): NodeRecord[] {
    const records: NodeRecord[] = []
    // 使用 GraphEngine 的通用的扫描方式：
    // 通过 internal _nodeIds 迭代（与 GraphEngine._scanAll 一致）
    // 但没有实际访问 _scanAll() 的权限，所以使用外部可访问的 scanAllNodes 桥接
    // (在挂载时由 engine 提供)
    if (typeof (this.engine as any).scanAllNodes === 'function') {
      return (this.engine as any).scanAllNodes()
    }
    return []
  }

  /**
   * 递归收集邻居节点。
   */
  private async _collectNeighbors(
    nodeId: number,
    remainingDepth: number,
    visited: Set<number>,
    result: NodeRecord[],
    edgeType?: number,
  ): Promise<void> {
    if (remainingDepth <= 0) return
    if (visited.has(nodeId)) return
    visited.add(nodeId)

    const { nodes } = this.engine.neighbors(nodeId, {
      maxDepth: 1,
      edgeTypeFilter: edgeType !== undefined ? [edgeType] : undefined,
    })

    for (const n of nodes) {
      if (!visited.has(n.id)) {
        result.push(n)
        await this._collectNeighbors(
          n.id,
          remainingDepth - 1,
          visited,
          result,
          edgeType,
        )
      }
    }
  }

  /**
   * 从 NodeRecord 中解析字段值。
   */
  private _resolveNodeField(node: NodeRecord, field: string): unknown {
    const key = field as keyof NodeRecord
    if (key in node) {
      return (node as any)[key]
    }
    return node.props?.[field]
  }

  /**
   * 应用过滤条件。
   */
  private _applyPredicate(
    value: unknown,
    op: string,
    target: unknown,
  ): boolean {
    switch (op) {
      case 'eq':
        return value === target
      case 'neq':
        return value !== target
      case 'gt':
        return (
          typeof value === 'number' &&
          typeof target === 'number' &&
          value > target
        )
      case 'gte':
        return (
          typeof value === 'number' &&
          typeof target === 'number' &&
          value >= target
        )
      case 'lt':
        return (
          typeof value === 'number' &&
          typeof target === 'number' &&
          value < target
        )
      case 'lte':
        return (
          typeof value === 'number' &&
          typeof target === 'number' &&
          value <= target
        )
      case 'prefix':
        return (
          typeof value === 'string' &&
          typeof target === 'string' &&
          value.startsWith(target)
        )
      case 'in':
        return Array.isArray(target) && target.includes(value)
      default:
        return true
    }
  }
}
