/**
 * query-engine.ts — Cypher-lite AST → Fluent API Transformer
 *
 * 将 peggy 解析出的 AST 转换为 OverGraph Fluent API 调用链。
 * 主要转换：
 *   MATCH (a:Person)-[:KNOWS]->(b) WHERE b.age > 30 RETURN b.name
 *   → engine.scan('Person').as('a').traverse('out').filter('age', '>', 30).as('b').return(['name'])
 *
 * 多跳支持：
 *   MATCH (a)-[:KNOWS]->(b)-[:WORKS_AT]->(c) WHERE c.name = "Acme" RETURN a.name
 *   → engine.scan('KNOWS' direction: 'out').traverse('out', 'WORKS_AT').filter('name', 'EQ', "Acme").as('c').return(['name'])
 *
 * 注意：当前实现依赖 OverGraph 的 Fluent API，未完全覆盖所有匹配模式。
 * 复杂的多跳路径展开使用 expandPath() 算法。
 *
 * 支持 DML 语句：
 *   CREATE (n:Label {prop: "val"})
 *   CREATE (a)-[:KNOWS]->(b)
 *   MATCH (n) DELETE n
 *   MATCH (n) SET n.name = "val"
 *   MERGE (n:Label {id: 1})
 */

import { parser } from './cypher-lite-parser'

// ── AST 类型 ─────────────────────────────────────────────────

export interface QueryAST {
  type: 'QUERY'
  match?: {
    type: 'MATCH'
    patterns: PatternAST[]
  }
  where?: WhereClauseAST | null
  return?: ReturnClauseAST
  orderBy?: OrderByAST | null
  limit?: number | undefined
  skip?: number | undefined
  aggregate?: AggregateClause
  unionType?: 'union' | 'union_all' | 'intersect' | 'subtract'
  rightQuery?: QueryAST
  // DML fields
  create?: CreateClauseAST
  delete?: DeleteClauseAST
  set?: SetClauseAST
  merge?: MergeClauseAST
}

export interface CreateClauseAST {
  type: 'CREATE'
  patterns: CreateNodeItemAST[]
}

export interface CreateNodeItemAST {
  type: 'CREATE_NODE' | 'CREATE_PATH'
  node: NodePatternAST
  edges?: EdgeStepAST[]
}

export interface DeleteClauseAST {
  type: 'DELETE'
  targets: string[]
}

export interface SetClauseAST {
  type: 'SET'
  items: SetItemAST[]
}

export interface SetItemAST {
  type: 'SET_ITEM'
  property: PrimaryAST
  value: PrimaryAST
}

export interface MergeClauseAST {
  type: 'MERGE'
  patterns: CreateNodeItemAST[]
}

export interface PatternAST {
  type: 'PATH'
  node: NodePatternAST
  edges: EdgeStepAST[]
}

export interface NodePatternAST {
  type: 'NODE'
  name: string
  label: string | null
  props: Record<string, unknown> | null
}

export interface EdgeStepAST {
  edge: {
    type: 'EDGE'
    name: string | null
    label: string | null
    direction: 'out' | 'in' | 'any'
  }
  node: NodePatternAST
}

export interface WhereClauseAST {
  type: 'WHERE'
  expression: ExpressionAST
}

export type ExpressionAST =
  | { type: 'OR'; left: ExpressionAST; right: ExpressionAST | ExpressionAST[] }
  | { type: 'AND'; left: ExpressionAST; right: ExpressionAST | ExpressionAST[] }
  | { type: 'COMPARISON'; operator: string; left: PrimaryAST; right: PrimaryAST }
  | PrimaryAST

export type PrimaryAST =
  | { type: 'PROP_REF'; name: string; property: string }
  | { type: 'STRING'; value: string }
  | { type: 'NUMBER'; value: number }
  | { type: 'BOOLEAN'; value: boolean }
  | { type: 'IDENTIFIER'; name: string }
  | { type: 'OR' } // placeholder - never matched as Primary
  | { type: 'AND' }
  | { type: 'COMPARISON' }

export interface ReturnClauseAST {
  type: 'RETURN'
  columns: ColumnAST[]
  aggregate?: AggregateClause
}

export interface ColumnAST {
  type: 'COLUMN'
  expression: PrimaryAST
  alias: string | null
}

export interface OrderByAST {
  type: 'ORDER_BY'
  columns: OrderColumnAST[]
}

export interface OrderColumnAST {
  type: 'ORDER_COLUMN'
  expression: PrimaryAST
  direction: 'ASC' | 'DESC'
}

// ── 聚合子句 ─────────────────────────────────────────────────

export interface AggregateClause {
  type: 'count' | 'sum' | 'avg' | 'max' | 'min'
  field?: string  // 如 n.age
  alias?: string  // AS alias
}

// ── Query Plan ─────────────────────────────────────────────────

export interface QueryPlan {
  /** 操作类型 */
  type?: 'QUERY' | 'CREATE' | 'DELETE' | 'SET' | 'MERGE'
  /** 起始节点标签扫描（如果 MATCH 节点指定了 label） */
  scanLabel: string | null
  /** 遍历步骤 */
  steps: TraverseStep[]
  /** WHERE 过滤器 */
  filters: FilterClause[]
  /** RETURN 列 */
  returnColumns: string[]
  /** ORDER BY */
  orderBy: Array<{ property: string; direction: 'ASC' | 'DESC' }>
  /** LIMIT */
  limit: number | undefined
  /** SKIP */
  skip: number | undefined
  /** 聚合子句（如 count, sum, avg, max, min） */
  aggregate?: AggregateClause
  /** 集合运算类型 */
  unionType?: 'union' | 'union_all' | 'intersect' | 'subtract'
  /** 集合运算右半部分 */
  rightPlan?: QueryPlan
  // DML fields
  /** CREATE 节点 */
  createNodes?: Array<{
    alias: string
    label: string | null
    props: Record<string, unknown> | null
  }>
  /** CREATE 边 */
  createEdges?: Array<{
    source: string
    target: string
    label: string | null
    direction: 'out' | 'in' | 'any'
  }>
  /** DELETE 目标 */
  deleteTargets?: string[]
  /** SET 子句 */
  setClauses?: Array<{
    property: string
    value: unknown
  }>
  /** MERGE 节点 */
  mergeNodes?: Array<{
    alias: string
    label: string | null
    props: Record<string, unknown> | null
  }>
  mergeEdges?: Array<{
    source: string
    target: string
    label: string | null
    direction: 'out' | 'in' | 'any'
  }>
}

export interface TraverseStep {
  source: string // 源节点的别名
  direction: 'out' | 'in' | 'any'
  edgeLabel: string | null
  targetAlias: string
  targetLabel: string | null
  targetProps: Record<string, unknown> | null
}

export interface FilterClause {
  source: string
  property: string
  operator: 'EQ' | 'NEQ' | 'GT' | 'GTE' | 'LT' | 'LTE'
  value: unknown
}

// ── 参数化查询 ──────────────────────────────────────────────

/**
 * 安全地转义字符串值，防止 Cypher 注入。
 *
 * 转义策略（适配 Cypher-lite 解析器规则）：
 * - 如果字符串不含 `'`，使用单引号包裹（无转义需要）
 * - 如果字符串含 `'` 但不含 `"`，使用双引号包裹
 * - 如果字符串同时含 `'` 和 `"`，移除所有 `'` 和 `"` 后使用单引号包裹
 *
 * 所有不可见控制字符（\x00-\x08\x0B\x0C\x0E-\x1F）一律移除。
 */
function escapeString(val: string): string {
  // 移除控制字符
  const cleaned = val.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')

  if (cleaned.includes("'") && !cleaned.includes('"')) {
    // 字符串含单引号但不含双引号 → 用双引号包裹
    return `"${cleaned}"`
  }
  if (cleaned.includes("'") && cleaned.includes('"')) {
    // 同时含两种引号 → 移除全部引号后单引号包裹
    const sanitized = cleaned.replace(/['"]/g, '')
    return `'${sanitized}'`
  }
  // 不含单引号 → 单引号包裹（最常用路径）
  return `'${cleaned}'`
}

/**
 * 序列化参数值为 Cypher-lite 查询可安全嵌入的字符串。
 *
 * - 字符串: 用引号包裹，自动选择安全的引号类型
 * - 数字/布尔: 直接转换为字符串
 * - 数组: 递归展开为 `[val, val, ...]` 形式
 * - null/undefined: 转换为 `null`
 */
function serializeParamValue(val: unknown): string {
  if (typeof val === 'string') {
    return escapeString(val)
  }
  if (typeof val === 'number' || typeof val === 'boolean') {
    return String(val)
  }
  if (val === null || val === undefined) {
    return 'null'
  }
  if (Array.isArray(val)) {
    return `[${val.map(serializeParamValue).join(', ')}]`
  }
  // 兜底：JSON 序列化
  return escapeString(JSON.stringify(val))
}

/**
 * 解析 Cypher-lite 查询字符串为 QueryPlan，支持参数化查询
 * 以防注入风险。
 *
 * 参数占位符格式：$1, $2, ..., $N
 * 参数会被安全地序列化并替换到查询语句中。
 *
 * @param query - 查询字符串（可包含 $N 占位符）
 * @param params - 可选参数数组
 * @returns QueryPlan
 *
 * @example
 *   execQuery('MATCH (n:Person) WHERE n.name = $1', ['Alice'])
 *   execQuery('MATCH (n:Person) WHERE n.age IN $1', [[25, 30, 35]])
 */
export function execQuery(query: string, params?: unknown[]): QueryPlan {
  if (!params || params.length === 0) {
    return parseQuery(query)
  }

  // 1. 统计占位符数量
  const placeholderMatches = query.match(/\$(\d+)/g)
  const placeholderCount = placeholderMatches
    ? new Set(placeholderMatches.map(m => m)).size
    : 0

  // 2. 验证参数数量
  if (placeholderCount !== params.length) {
    throw new Error(
      `Parameter count mismatch: query has ${placeholderCount} placeholder(s) but ${params.length} parameter(s) provided`
    )
  }

  // 3. 从最大占位符索引确定实际需要替换的数量
  const maxIdx = placeholderMatches
    ? Math.max(...placeholderMatches.map(m => parseInt(m.slice(1), 10)))
    : 0

  if (maxIdx !== params.length) {
    throw new Error(
      `Parameter count mismatch: query references ${maxIdx} placeholder(s) but ${params.length} parameter(s) provided`
    )
  }

  // 4. 按序替换占位符
  let result = query
  for (let i = 0; i < params.length; i++) {
    const placeholder = `\\$${i + 1}`
    const serialized = serializeParamValue(params[i])
    // 使用全局替换（RegExp），同个占位符可能出现在查询中多次
    const re = new RegExp(placeholder, 'g')
    result = result.replace(re, serialized)
  }

  return parseQuery(result)
}

// ── 解析 + 转换 ──────────────────────────────────────────────

/**
 * 解析 Cypher-lite 查询字符串为 QueryPlan
 */
export function parseQuery(query: string): QueryPlan {
  let ast: QueryAST
  try {
    ast = parser.parse(query) as QueryAST
  } catch (err: any) {
    throw new Error(`Query parse error: ${err.message}`)
  }
  return planFromAST(ast)
}

/**
 * 将 AST 转换为 QueryPlan
 */
export function planFromAST(ast: QueryAST): QueryPlan {
  const plan: QueryPlan = {
    type: 'QUERY',
    scanLabel: null,
    steps: [],
    filters: [],
    returnColumns: [],
    orderBy: [],
    limit: ast.limit,
    skip: ast.skip,
    aggregate: ast.aggregate,
    unionType: ast.unionType,
    rightPlan: ast.rightQuery ? planFromAST(ast.rightQuery) : undefined,
  }

  // ── DML 处理 ────────────────────────────────────────────

  if (ast.create) {
    plan.type = 'CREATE'
    const { createNodes, createEdges } = planFromCreateClause(ast.create)
    plan.createNodes = createNodes
    plan.createEdges = createEdges
  }

  if (ast.delete) {
    plan.type = 'DELETE'
    plan.deleteTargets = [...ast.delete.targets]
    // 如果有 MATCH，继续处理
  }

  if (ast.set) {
    plan.type = 'SET'
    plan.setClauses = planFromSetClause(ast.set)
  }

  if (ast.merge) {
    plan.type = 'MERGE'
    const { createNodes: mergeNodes, createEdges: mergeEdges } = planFromCreateClause(ast.merge)
    plan.mergeNodes = mergeNodes
    plan.mergeEdges = mergeEdges
  }

  // ── MATCH 处理（可能跟在 DELETE/SET 后，也可能单独存在） ──

  if (ast.match) {
    const pattern = ast.match.patterns[0]
    if (pattern) {
      plan.scanLabel = pattern.node.label

      // 处理遍历步骤
      for (const step of pattern.edges) {
        plan.steps.push({
          source: step.node.name,
          direction: step.edge.direction,
          edgeLabel: step.edge.label,
          targetAlias: step.node.name,
          targetLabel: step.node.label,
          targetProps: step.node.props,
        })
      }

      // 处理 WHERE
      if (ast.where) {
        plan.filters.push(...extractFilters(ast.where.expression, plan.steps))
      }
    }
  }

  // ── RETURN 处理 ─────────────────────────────────────────

  if (ast.return) {
    if (ast.return.aggregate) {
      // 聚合函数：用 alias 或字段名作为返回列名
      const agg = ast.return.aggregate
      plan.aggregate = agg
      plan.returnColumns = [agg.alias ?? agg.field ?? agg.type]
    } else {
      plan.returnColumns = ast.return.columns.map(col =>
        col.alias ?? formatColumn(col.expression)
      )
    }

    // 处理 ORDER BY（只有在有 RETURN 时才有效）
    if (ast.orderBy) {
      plan.orderBy = ast.orderBy.columns.map(col => ({
        property: formatColumn(col.expression),
        direction: col.direction as 'ASC' | 'DESC',
      }))
    }
  }

  return plan
}

// ── DML 帮助函数 ───────────────────────────────────────────

function planFromCreateClause(createClause: CreateClauseAST): {
  createNodes: QueryPlan['createNodes']
  createEdges: QueryPlan['createEdges']
} {
  const createNodes: QueryPlan['createNodes'] = []
  const createEdges: QueryPlan['createEdges'] = []

  for (const item of createClause.patterns) {
    if (item.type === 'CREATE_NODE') {
      createNodes.push({
        alias: item.node.name,
        label: item.node.label,
        props: item.node.props,
      })
    } else if (item.type === 'CREATE_PATH') {
      // 添加起始节点
      createNodes.push({
        alias: item.node.name,
        label: item.node.label,
        props: item.node.props,
      })
      // 添加边和后续节点
      for (const step of (item.edges || [])) {
        createNodes.push({
          alias: step.node.name,
          label: step.node.label,
          props: step.node.props,
        })
        createEdges.push({
          source: item.node.name,
          target: step.node.name,
          label: step.edge.label,
          direction: step.edge.direction,
        })
      }
    }
  }

  return { createNodes, createEdges }
}

function planFromSetClause(setClause: SetClauseAST): QueryPlan['setClauses'] {
  return setClause.items.map(item => ({
    property: formatColumn(item.property),
    value: resolvePrimary(item.value),
  }))
}

// ── 帮助函数 ─────────────────────────────────────────────────

function extractFilters(expr: ExpressionAST, steps: TraverseStep[]): FilterClause[] {
  if (expr.type === 'AND') {
    const left = extractFilters(expr.left, steps)
    const right = extractFilters(
      // 如果 right 是数组
      Array.isArray(expr.right) ? expr.right[0] : expr.right,
      steps,
    )
    return [...left, ...right]
  }

  if (expr.type === 'COMPARISON') {
    const left = expr.left
    const right = expr.right
    let propRef: PrimaryAST
    let value: unknown

    if (left.type === 'PROP_REF' && right.type !== 'PROP_REF') {
      propRef = left
      value = resolvePrimary(right)
    } else if (right.type === 'PROP_REF' && left.type !== 'PROP_REF') {
      propRef = right
      value = resolvePrimary(left)
    } else {
      return [] // 不支持 prop = prop 比较
    }

    return [{
      source: propRef.name,
      property: propRef.property,
      operator: expr.operator as FilterClause['operator'],
      value,
    }]
  }

  return []
}

function resolvePrimary(p: PrimaryAST): unknown {
  switch (p.type) {
    case 'STRING': return p.value
    case 'NUMBER': return p.value
    case 'BOOLEAN': return p.value
    case 'IDENTIFIER': return p.name
    default: return null
  }
}

function formatColumn(expr: PrimaryAST): string {
  if (expr.type === 'PROP_REF') return expr.property
  if (expr.type === 'IDENTIFIER') return expr.name
  if (expr.type === 'STRING') return expr.value
  if (expr.type === 'NUMBER') return String(expr.value)
  return String(expr)
}
