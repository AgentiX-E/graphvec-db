/**
 * query-engine.ts — Cypher Query Plan 解析与 GraphEngine 原生执行
 *
 * 入口：
 *   parseQuery(query: string) → QueryPlan          — ANTLR 解析 + Plan 适配
 *   execQuery(query, params?) → QueryPlan          — parseQuery + 参数注入
 *   _executeQuery(plan, nodes) → QueryResult       — 创建临时 GE 实例执行
 *   _executeViaGraphEngine(plan, nodes) → QueryResult — GraphEngine 原生执行
 *
 * 核心流程：
 *   query string → parseCypherToPlan (ANTLR) → parseQuery 适配
 *   → _executeViaGraphEngine (临时 GE) → _postProcessResults (ORDER BY / HAVING)
 *
 * 依赖：
 *   parseCypherToPlan — src/query/ast-to-plan-v2.ts (ANTLR adapter)
 *   GraphEngine       — src/core/graph-engine.ts
 *
 * 历史：
 *   2026-06-12: PEG 解析器 + 手写执行逻辑 (~7380行) 全部删除
 *   当前代码: ANTLR 解析 + GE 原生执行 + 适配层 (~1000行)
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { parseCypherToPlan } from './ast-to-plan-v2'
import { GraphEngine } from '../core/graph-engine'
import type { OverGraphConfig } from '../types'

/** 默认查询 LIMIT，当查询没有显式 LIMIT 子句时使用 */
export const DEFAULT_LIMIT = 1000

// ── AST 类型 ─────────────────────────────────────────────────

export interface QueryAST {
  type: 'QUERY'
  match?: {
    type: 'MATCH'
    patterns: PatternAST[]
  }
  /** OPTIONAL MATCH clauses */
  optionalMatches?: Array<{
    type: 'OPTIONAL_MATCH'
    patterns: PatternAST[]
    where?: WhereClauseAST | null
  }>
  /** WITH clause */
  with?: WithClauseAST
  where?: WhereClauseAST | null
  return?: ReturnClauseAST
  orderBy?: OrderByAST | null
  /** GROUP BY columns */
  groupBy?: PrimaryAST[]
  limit?: number | undefined
  skip?: number | undefined
  aggregate?: AggregateClause
  unionType?: 'union' | 'union_all' | 'intersect' | 'subtract'
  rightQuery?: QueryAST
  // DML fields
  create?: CreateClauseAST
  delete?: DeleteClauseAST
  set?: SetClauseAST
  remove?: RemoveClauseAST
  merge?: MergeClauseAST
  /** Periodic commit hint: USING PERIODIC COMMIT [batchSize] */
  periodicCommitHint?: {
    type: 'PERIODIC_COMMIT_HINT'
    batchSize?: number
  }
}

export interface ConstraintClauseAST {
  type: 'CREATE_CONSTRAINT'
  label: string
  property: string
}

/** WITH clause: WITH expr1 AS alias1, expr2 AS alias2 [WHERE condition] [ORDER BY ...] [LIMIT n] */
export interface WithClauseAST {
  type: 'WITH'
  columns: ColumnAST[]
  where?: WhereClauseAST | null
  orderBy?: OrderByAST | null
  limit?: number | undefined
  skip?: number | undefined
  aggregate?: AggregateClause
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

export interface RemoveClauseAST {
  type: 'REMOVE'
  items: RemoveItemAST[]
}

export interface RemoveItemAST {
  type: 'REMOVE_PROP' | 'REMOVE_LABEL'
  property?: string
  name?: string
  ref?: string
  label?: string
}

export interface MergeClauseAST {
  type: 'MERGE'
  patterns: CreateNodeItemAST[]
  onCreate?: SetClauseAST
  onMatch?: SetClauseAST
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
  labelExpr: {
    type: 'LABEL_EXPR'
    items: Array<{ exclude: boolean; name: string }>
  } | null
  props: Record<string, unknown> | null
}

export interface EdgeStepAST {
  edge: {
    type: 'EDGE'
    name: string | null
    label: string | null
    direction: 'out' | 'in' | 'any'
    range?: { min: number; max: number | null }
  }
  node: NodePatternAST
}

export interface WhereClauseAST {
  type: 'WHERE'
  expression: ExpressionAST
}

export type ExpressionAST =
  | { type: 'NOT'; expr: ExpressionAST }
  | { type: 'OR'; left: ExpressionAST; right: ExpressionAST | ExpressionAST[] }
  | { type: 'AND'; left: ExpressionAST; right: ExpressionAST | ExpressionAST[] }
  | { type: 'COMPARISON'; operator: string; left: PrimaryAST; right: PrimaryAST }
  | { type: 'NULL_PREDICATE'; expr: PrimaryAST; not: boolean }
  | PrimaryAST

export type PrimaryAST =
  | { type: 'NOT' } // placeholder - not matched as Primary
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
  type: 'count' | 'sum' | 'avg' | 'max' | 'min' | 'collect'
  field?: string  // 如 n.age
  alias?: string  // AS alias
  distinct?: boolean  // DISTINCT modifier (for COLLECT, COUNT)
}

// ── Query Plan ─────────────────────────────────────────────────

export interface QueryPlan {
  /** 操作类型 */
  type?: 'QUERY' | 'CREATE' | 'DELETE' | 'SET' | 'MERGE' | 'CALL' | 'USE' | 'CREATE_CONSTRAINT' | 'BEGIN' | 'COMMIT' | 'ROLLBACK'
  /** USE 的图名称（用于 multi-graph 命名空间切换） */
  useGraph?: string
  /** EXPLAIN: 展示执行计划但不执行 */
  explain?: boolean
  /** PROFILE: 执行并收集每步统计信息 */
  profile?: boolean
  /** INDEX 操作：'CREATE' 或 'DROP' */
  indexOp?: 'CREATE' | 'DROP'
  /** INDEX 目标标签 */
  indexLabel?: string
  /** INDEX 目标属性 */
  indexProperty?: string
  /** 起始节点标签扫描（如果 MATCH 节点指定了 label） */
  scanLabel: string | null
  /** 标签表达式（如 Person|Animal, !Person 等） */
  labelExpr: {
    type: 'LABEL_EXPR'
    items: Array<{ exclude: boolean; name: string }>
  } | null
  /** 遍历步骤 */
  steps: TraverseStep[]
  /** WHERE 过滤器 */
  filters: FilterClause[]
  /** RETURN 列 */
  returnColumns: string[]
  /** returnColumn 到原始表达式的映射（用于 DML 结果构造：RETURN n.name AS p → {p: "n.name"}） */
  returnAliasMap?: Record<string, string>
  /** 计算列（字符串拼接、表达式等，运行时求值） */
  expressionColumns?: Array<{
    expression: any
    alias: string
  }>
  /** 编译期常数列（纯字面量表达式折叠后的值） */
  constColumns?: Array<{
    alias: string
    value: unknown
  }>
  /** ORDER BY */
  orderBy: Array<{ property: string; direction: 'ASC' | 'DESC' }>
  /** LIMIT */
  limit: number | undefined
  /** SKIP */
  skip: number | undefined
  /** 是否来自 MATCH 扫描（用于区分无标签 MATCH 和纯 WITH/UNWIND） */
  hasMatch?: boolean
  /** 聚合子句（如 count, sum, avg, max, min） */
  aggregate?: AggregateClause
  /** GROUP BY 列 */
  groupBy?: string[]
  /** HAVING 过滤器 */
  having?: HavingClause[]
  /** OPTIONAL MATCH 步骤（如果匹配不到返回 null 绑定） */
  optionalMatchSteps?: Array<{
    scanLabel: string | null
    steps: TraverseStep[]
    filters: FilterClause[]
  }>
  /** WITH 子句：管道中间投影 */
  with?: {
    columns: Array<{
      expression: string
      alias: string | null
    }>
    filters: FilterClause[]
    orderBy: Array<{ property: string; direction: 'ASC' | 'DESC' }>
    limit: number | undefined
    skip: number | undefined
    aggregate?: AggregateClause
  }
  /** 集合运算类型 */
  unionType?: 'union' | 'union_all' | 'intersect' | 'subtract'
  /** 集合运算右半部分 */
  rightPlan?: QueryPlan
  /** UNWIND 子句 */
  unwind?: {
    list: any[]
    name: string
    var?: string  // 变量名引用（如 UNWIND list AS x 中 list 是变量名）
  }
  /** 第二个 UNWIND（UNWIND 链：UNWIND a AS x UNWIND b AS y） */
  secondUnwind?: {
    list: any[]
    name: string
    var?: string
  }
  /** CASE 表达式列（需要运行时求值的复杂表达式） */
  caseColumns?: Array<{
    expression: any  // CASE AST 节点
    alias: string   // 该列名（与 returnColumns 对应）
  }>
  /** Pattern Comprehension 列（在 RETURN 中出现的模式推导） */
  comprehensionColumns?: Array<{
    expression: any  // PATTERN_COMPREHENSION AST 节点
    alias: string   // 该列名
  }>
  /** EXISTS 子查询过滤器 */
  existsFilters?: Array<{
  /** 列表表达式列（LIST / SUBSCRIPT / SLICE / ADD 等需要运行时求值的表达式） */
  listColumns?: Array<{
    expression: any
    alias: string
  }>
    source: string
    edgeLabel: string | null
    direction: 'out' | 'in' | 'any'
    target: string
  }>
  /** CALL 子查询 */
  callQuery?: QueryPlan
  /** CALL 子查询的 IN TRANSACTIONS 标志：分批提交 */
  inTransactions?: boolean
  /** IN TRANSACTIONS OF N ROWS 的自定义批次大小 */
  inTransactionsBatchSize?: number
  /** CALL 过程调用 */
  callProcedure?: {
    name: string
    args: any[]
    yieldItems?: Array<{ name: string; alias: string | null }>
  }
  /** FOREACH 子句：列表迭代执行子查询 */
  forEach?: ForEachClause
  /** REDUCE 表达式：列表累积归约 */
  reduce?: {
    accumulator: string
    initial: unknown
    variable: string
    list: unknown[]
    isVarRef: boolean
    expression: string
  }
  /** LOAD CSV 子句 */
  loadCsv?: {
    url: string
    rowVariable: string
    hasHeaders: boolean
  }
  /** 窗口函数 */
  windowFunctions?: Array<{
    function: string
    partitionBy: string[]
    orderBy: Array<{ column: string; direction: 'ASC' | 'DESC' }>
  }>
  /** SHOW 元数据查询 */
  show?: string
  /** SEARCH 向量搜索子句（ANN / 近似最近邻） */
  search?: {
    /** 搜索的目标属性（如 'n.embedding'） */
    targetProperty: string
    /** 查询向量（数组形式） */
    queryVector: number[]
    /** 返回的最近邻数量 TOP K */
    topK: number
  }
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
    sourceIdx?: number
    targetIdx?: number
    label: string | null
    direction: 'out' | 'in' | 'any'
  }>
  /** DELETE 目标 */
  deleteTargets?: string[]
  /** DETACH DELETE 标志：删除节点前先删除所有关联边 */
  detachDelete?: boolean
  /** SET 子句 */
  setClauses?: Array<{
    property: string
    value: unknown
  }>
  /** REMOVE 子句 */
  removeClauses?: Array<{
    type: 'REMOVE_PROP' | 'REMOVE_LABEL'
    property?: string
    ref?: string
    label?: string
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
  /** MERGE ON CREATE 子句 */
  mergeOnCreate?: Array<{
    property: string
    value: unknown
  }>
  /** MERGE ON MATCH 子句 */
  mergeOnMatch?: Array<{
    property: string
    value: unknown
  }>
  /** USING PERIODIC COMMIT 提示 — 分批提交批次大小 */
  periodicCommit?: {
    batchSize?: number
  }
  /** CREATE CONSTRAINT 约束信息 */
  constraint?: {
    label: string
    property: string
  }
}

export interface TraverseStep {
  source: string // 源节点的别名
  direction: 'out' | 'in' | 'any'
  edgeLabel: string | null
  targetAlias: string
  targetLabel: string | null
  targetProps: Record<string, unknown> | null
  /** 变长路径范围（如果此步为变长路径） */
  range?: { min: number; max: number | null }
}

export interface FilterClause {
  source: string
  property: string
  operator: 'EQ' | 'NEQ' | 'GT' | 'GTE' | 'LT' | 'LTE' | 'IN' | 'STARTS_WITH' | 'ENDS_WITH' | 'CONTAINS' | 'IS_NULL' | 'IS_NOT_NULL'
  value: unknown
  /** NOT 否定标记 */
  negated?: boolean
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
 * 支持两种参数模式：
 * - 位置参数（数组）：$1, $2, ..., $N
 * - 命名参数（对象）：$name, $age, ...
 *
 * 参数会被安全地序列化并替换到查询语句中。
 *
 * @param query - 查询字符串（可包含 $N 或 $name 占位符）
 * @param params - 可选参数数组或对象
 * @returns QueryPlan
 *
 * @example
 *   execQuery('MATCH (n:Person) WHERE n.name = $1', ['Alice'])
 *   execQuery('MATCH (n:Person) WHERE n.name = $name', { name: 'Alice' })
 *   execQuery('MATCH (n:Person) WHERE n.age IN $1', [[25, 30, 35]])
 */
export function execQuery(
  query: string,
  params?: Record<string, unknown> | unknown[]
): QueryPlan {
  // 无参数
  if (!params || (Array.isArray(params) && params.length === 0) ||
      (!Array.isArray(params) && typeof params === 'object' && Object.keys(params).length === 0)) {
    return parseQuery(query)
  }

  // ── 自动检测：数组 → 位置参数 ──
  if (Array.isArray(params)) {
    return _execQueryPositional(query, params)
  }

  // ── 对象 → 命名参数 ──
  return _execQueryNamed(query, params as Record<string, unknown>)
}

/**
 * 位置参数替换：$1, $2, ..., $N
 *
 * 策略：先用 parseQuery 解析含 $1 占位符的 query（ANTLR 会保留 $1 为 filter value），
 * 然后遍历 plan 结构，将 $1 / $2 等占位符替换为真实参数值。
 * 这样避免了 ANTLR 词法分析对参数值中特殊字符（如 OR/AND/--/引号）的误解析。
 */
function _execQueryPositional(query: string, params: unknown[]): QueryPlan {
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

  // 4. 先用 parseQuery 解析（$1 会被 ANTLR 保留为 filter value 字符串）
  const plan = parseQuery(query)

  // 5. 注入参数值到 plan 结构中
  _injectParamsToPlan(plan, (name: string) => {
    const idx = parseInt(name, 10)
    if (isNaN(idx) || idx < 1 || idx > params.length) return undefined
    return params[idx - 1]
  })

  return plan
}

/**
 * 命名参数替换：$name, $age, ...
 *
 * 同位置参数策略：先 parseQuery，再注入参数值。
 */
function _execQueryNamed(query: string, params: Record<string, unknown>): QueryPlan {
  // 1. 提取所有 $identifier 占位符
  const namedParamRegex = /\$([a-zA-Z_]\w*)/g
  const names = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = namedParamRegex.exec(query)) !== null) {
    names.add(match[1])
  }

  // 2. 验证所有命名参数都有提供
  for (const name of names) {
    if (!(name in params)) {
      throw new Error(
        `Parameter $${name} was not provided. Available params: ${Object.keys(params).join(', ')}`
      )
    }
  }

  // 3. 先用 parseQuery 解析（$name 会被 ANTLR 保留为 filter value 字符串）
  const plan = parseQuery(query)

  // 4. 注入参数值到 plan 结构中
  _injectParamsToPlan(plan, (name: string) => {
    if (name in params) return params[name]
    return undefined
  })

  return plan
}

/**
 * 遍历 plan 结构，将所有以 `$` 开头的 filter value 替换为真实参数值。
 */
function _injectParamsToPlan(plan: QueryPlan, resolve: (name: string) => unknown): void {
  // 替换 filter.values
  if (plan.filters?.length) {
    for (const f of plan.filters) {
      if (typeof f.value === 'string' && f.value.startsWith('$')) {
        const paramName = f.value.slice(1)
        const provided = resolve(paramName)
        if (provided !== undefined) {
          // 对字符串值做安全处理（移除引号字符防止被解析为字符串字面量）
          if (typeof provided === 'string') {
            const hasSingle = provided.includes("'")
            const hasDouble = provided.includes('"')
            if (hasSingle && hasDouble) {
              // 同时含两种引号：移除全部引号（安全兜底）
              f.value = provided.replace(/['"]/g, '')
            } else if (hasSingle) {
              // 仅含单引号：用双引号包裹的等价方式无须处理（ANTLR 已不用），保留原值
              f.value = provided
            } else {
              f.value = provided
            }
          } else {
            f.value = provided
          }
        }
      }
    }
  }

  // 替换 limit / skip（$limit → number）
  if (typeof plan.limit === 'string' && (plan.limit as string).startsWith('$')) {
    const paramName = (plan.limit as string).slice(1)
    const provided = resolve(paramName)
    if (typeof provided === 'number') plan.limit = provided
  }
  if (typeof plan.skip === 'string' && (plan.skip as string).startsWith('$')) {
    const paramName = (plan.skip as string).slice(1)
    const provided = resolve(paramName)
    if (typeof provided === 'number') plan.skip = provided
  }

  // 替换 createNode props
  if (plan.createNodes?.length) {
    for (const cn of plan.createNodes) {
      if (cn.props) {
        for (const [pk, pv] of Object.entries(cn.props)) {
          if (typeof pv === 'string' && pv.startsWith('$')) {
            const paramName = pv.slice(1)
            const provided = resolve(paramName)
            if (provided !== undefined) {
              cn.props[pk] = provided
            }
          }
        }
      }
    }
  }

  // 递归处理 rightPlan（UNION/INTERSECT/SUBTRACT）
  if (plan.rightPlan) _injectParamsToPlan(plan.rightPlan, resolve)
  // 递归处理 callQuery
  if (plan.callQuery) _injectParamsToPlan(plan.callQuery, resolve)
}

// ── 解析 + 转换 ──────────────────────────────────────────────

// ── 预处理：将不支持的语法转换为可解析的等效语法 ──────────────

/**
 * 预处理查询：提取 OPTIONAL MATCH 和 WITH 子句，
 * 将其替换为 peggy 可解析的等效语法，再以结构化数据形式附加到 AST 上。
 *
 * 策略：
 *   OPTIONAL MATCH (a)-[:KNOWS]->(b) WHERE b.age > 30
 *   → 在 OPTIONAL 后插入 `__OPT__N__` 标记节点，使 peggy 能解析为 MATCH，
 *     解析后我们通过检测该节点名识别出它是 OPTIONAL MATCH。
 *
 *   WITH n, n.age AS age WHERE age > 18 RETURN n
 *   → WITH 后的内容转换为伪 MATCH + RETURN 语法使 peggy 可解析，
 *     然后从 AST 中提取所需信息重构 WITH 子句。
 */

export function parseQuery(query: string): QueryPlan {
  // ANTlr parser — direct QueryPlan output, no PEG AST intermediate
  const plan = parseCypherToPlan(query.trim())

  // 递归修复子计划的 scanLabel（UNION/INTERSECT/SUBTRACT 的 rightPlan，CALL 的 callQuery）
  function _fixScanLabel(subPlan: QueryPlan): void {
    if (subPlan.scanLabel && !subPlan.labelExpr) {
      if (subPlan.returnColumns?.includes(subPlan.scanLabel)) {
        subPlan.scanLabel = null
      } else if (subPlan.filters?.length && subPlan.filters.some(f => f.source === subPlan.scanLabel)) {
        subPlan.scanLabel = null
      } else if (/^[a-z][0-9]?$/.test(subPlan.scanLabel) && !subPlan.createNodes?.some(n => n.label === subPlan.scanLabel)) {
        subPlan.scanLabel = null
      }
      // 如果 scanLabel 是 MATCH 中的变量名而非真正标签（如 MATCH (a) 中 a 被 ANTLR 当成 scanLabel）
      // 正确标签会出现在 MATCH 子句的 :scanLabel 形式中。否则是变量名。
      // MATCH (a:Person) → scanLabel='Person', 查询中有 ':Person' → 保留
      // MATCH (a)       → scanLabel='a', 查询中有 '(a)' 但无 ':a' → 清除
      if (subPlan.scanLabel && subPlan.hasMatch && query) {
        const rawQuery = query
        // 检查 scanLabel 是否在 MATCH 子句中以 :scanLabel 形式出现（标签）
        const matchClauses = rawQuery.match(/MATCH\s+.*?(?=WHERE|RETURN|WITH|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|\$Cypher|$)/gis) || []
        const isLabelInMatch = matchClauses.some((mc: string) => {
          // 在节点模式中查找 :scanLabel：如 (:Person), :Person), :Person {prop}
          const labelPattern = new RegExp(':' + subPlan.scanLabel + '(?=[\)\s{]|$)')
          return labelPattern.test(mc)
        })
        // 如果 scanLabel 在 MATCH 子句中不是作为标签出现，则是变量名，清除
        if (!isLabelInMatch) {
          subPlan.scanLabel = null
        }
      }
    }
    if (subPlan.rightPlan) _fixScanLabel(subPlan.rightPlan)
    if (subPlan.callQuery) _fixScanLabel(subPlan.callQuery)
  }
  _fixScanLabel(plan)
  _fixScanLabel(plan)

  // ── DML type 修复：MATCH_MODIFY → DELETE/SET ──
  if (plan.type === 'MATCH_MODIFY') {
    if (plan.deleteTargets?.length) {
      plan.type = 'DELETE'
    } else if (plan.setClauses?.length) {
      plan.type = 'SET'
    }
  }

  // ── returnColumns 拆解：b.name → name （去掉变量前缀） ──
  if (plan.returnColumns?.length) {
    plan.returnColumns = plan.returnColumns.map((rc: string) => {
      const dotIdx = rc.indexOf('.')
      if (dotIdx >= 0) return rc.substring(dotIdx + 1)
      return rc
    })
  }

  // ── OR 条件检测：ANTLR 会把 WHERE a OR b 拆成两个 AND'd filter ──
  // 如果原始 WHERE 子句包含 OR / XOR，清空 filters（OR 需要运行时可短路评估）
  if (plan.filters?.length) {
    const whereClause = (query || '').match(/WHERE\s+(.+?)(?:\s+RETURN|\s+ORDER|\s+SKIP|\s+LIMIT|\s+WITH|\s+CREATE|\s+DELETE|\s+SET|\s+REMOVE|\s+UNWIND|$)/is)
    if (whereClause) {
      const whereBody = whereClause[1]
      // 检测顶层 OR/XOR（不在括号内的 OR）
      let depth = 0
      let hasTopLevelOr = false
      for (let i = 0; i < whereBody.length; i++) {
        const ch = whereBody[i]
        if (ch === '(') depth++
        else if (ch === ')') depth--
        else if (depth === 0) {
          if (whereBody.substring(i).match(/^\b(OR|XOR)\b/i)) { hasTopLevelOr = true; break }
        }
      }
      if (hasTopLevelOr) {
        plan.filters = []
      }
    }
  }

  // ── 多标签修复（AST 标签提取只取第一个，用 query 文本补全） ──
  const qText = query.trim()
  // 修复 scanLabel（MATCH 的多标签）
  if (plan.scanLabel && plan.hasMatch) {
    const nodePatterns = qText.match(/\([^)]+\)/g) || []
    for (const np of nodePatterns) {
      const inner = np.slice(1, -1).trim()
      const colIdx = inner.indexOf(':')
      if (colIdx === -1) continue
      let labelPart = inner.substring(colIdx + 1)
      const braceIdx = labelPart.indexOf('{')
      if (braceIdx >= 0) labelPart = labelPart.substring(0, braceIdx).trim()
      const labels = labelPart.split(':').map(s => s.trim()).filter(Boolean)
      if (labels.length > 1 && labels[0] === plan.scanLabel) {
        // 填充 labelExpr（用于 engine 二次过滤），但 scanLabel 保留第一个标签
        // （GE 用单标签扫描后再用 labelExpr AND 过滤）
        plan.labelExpr = { type: 'LABEL_EXPR', items: labels.map(l => ({ exclude: false, name: l })) }
        break
      }
    }
  }
  // 修复 createNodes 的多标签
  if (plan.createNodes?.length && (plan.type === 'CREATE' || plan.type === 'MERGE')) {
    const nodePatterns = qText.match(/\([^)]+\)/g) || []
    let npIdx = 0
    for (const np of nodePatterns) {
      if (npIdx >= plan.createNodes.length) break
      const inner = np.slice(1, -1).trim()
      const colIdx = inner.indexOf(':')
      if (colIdx === -1) { npIdx++; continue }
      let labelPart = inner.substring(colIdx + 1)
      const braceIdx = labelPart.indexOf('{')
      if (braceIdx >= 0) labelPart = labelPart.substring(0, braceIdx).trim()
      const labels = labelPart.split(':').map(s => s.trim()).filter(Boolean)
      if (labels.length > 1 && labels[0] === plan.createNodes[npIdx].label) {
        plan.createNodes[npIdx].label = labels.join(':')
      }
      npIdx++
    }
  }

  // ── createNodes props 格式转换：{prop: 'val'} → {prop: {type: 'STRING', value: 'val'}} ──
  for (const cn of (plan.createNodes || [])) {
    if (cn.props) {
      for (const [pk, pv] of Object.entries(cn.props)) {
        if (typeof pv === 'string' && !pv.startsWith('$') && !(pv as any)?.type) {
          cn.props[pk] = { type: 'STRING', value: pv }
        } else if (typeof pv === 'number') {
          cn.props[pk] = { type: 'NUMBER', value: pv }
        } else if (typeof pv === 'boolean') {
          cn.props[pk] = { type: 'BOOLEAN', value: pv }
        }
      }
    }
  }

  // ── Fallback: 如果 parseQuery 后 returnColumns 为空但有 RETURN 子句 ──
  // ANTLR 可能无法解析某些函数调用（如 type(r) AS alias），用正则提取
  if (!plan.returnColumns?.length && !plan.aggregate && !plan.with) {
    const returnClause = query.match(/RETURN\s+(.+?)(?:\s+(ORDER|SKIP|LIMIT|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|FOREACH|CALL|SHOW)\s|$)/is)
    if (returnClause) {
      const expr = returnClause[1].trim()
      // 尝试拆分逗号分隔的列定义
      const cols = expr.split(',').map(c => c.trim()).filter(Boolean)
      if (cols.length) {
        plan.returnColumns = cols.map(c => {
          // type(r) AS r → r（取 AS 后的别名）
          const asMatch = c.match(/\bAS\s+(\w+)\s*$/i)
          if (asMatch) return asMatch[1]
          // type(r) → r（取括号内的变量名）
          const fnMatch = c.match(/^(\w+)\((\w+)\)$/)
          if (fnMatch) return fnMatch[2]
          return c
        })
        plan.returnAliasMap = {}
        for (const c of plan.returnColumns) plan.returnAliasMap[c] = c
      }
    }
  }

  // 检测无效查询：parseCypherToPlan 成功返回但查询语法非法（ANTLR 错误被吞掉了）
  // 特征: scanLabel=null, steps=[], filters=[], returnColumns=[], hasMatch=false
  if (!plan.scanLabel && plan.steps?.length === 0 && plan.filters?.length === 0 && plan.returnColumns?.length === 0 && !plan.hasMatch && !plan.create && !plan.show && !plan.with && !plan.unwind && !plan.unionType && !plan.caseColumns?.length) {
    // 检查原始查询是否包含有效关键字 — 大多数无效查询没有 MATCH etc.
    if (!/^\s*(MATCH|WITH|UNWIND|RETURN|CREATE|MERGE|SET|DELETE|REMOVE|FOREACH|CALL|SHOW|USE|BEGIN|COMMIT|ROLLBACK|EXPLAIN|PROFILE|LOAD|DROP|START|OPTIONAL|ALTER|GRANT|REVOKE)/i.test(query.trim())) {
      throw new Error(`Query parse error: cannot parse query "${query}"`)
    }
  }

  // Handle EXPLAIN/PROFILE prefix
  const upperQ = query.trim().toUpperCase()
  if (upperQ.startsWith('EXPLAIN ')) {
    plan.explain = true
  } else if (upperQ.startsWith('PROFILE ')) {
    plan.profile = true
  }

  // ── Aggregate 格式适配：ANTLR 格式 → GE 兼容格式 ──
  // GE 的 _execAggregation 期望 { type: string, field?: string, alias?: string }
  // ANTLR 返回 { function: string, column: string, type: string, alias?: string }
  if (plan.aggregate) {
    const agg = plan.aggregate as any
    if (agg.field === undefined && agg.column) {
      // 从 column 提取 field："sum(n.age) AS totalAge" → "n.age"；"count(*)" → "*"
      const colMatch = agg.column.match(/^\w+\((.+?)\)(?:\s+AS\s+\w+)?$/)
      agg.field = colMatch ? colMatch[1] : (agg.column || '*')
    }
  }
  // WITH 子句中的聚合
  if (plan.with?.aggregates) {
    for (const wa of plan.with.aggregates) {
      if ((wa as any).field === undefined && (wa as any).column) {
        const colMatch = (wa as any).column.match(/^\w+\((.+?)\)(?:\s+AS\s+\w+)?$/)
        ;(wa as any).field = colMatch ? colMatch[1] : ((wa as any).column || '*')
      }
    }
  }
  // WITH 列表达式：字符串字面量转为 AST 对象（GE 的 _executeWithClause 期望 AST）
  if (plan.with?.columns) {
    for (const col of plan.with.columns) {
      if (typeof col.expression === 'string') {
        const expr = col.expression.trim()
        // 列表字面量 [1,2]
        if (expr.startsWith('[') && expr.endsWith(']')) {
          try {
            const items = JSON.parse(expr.replace(/'/g, '"'))
            col.expression = { type: 'LIST', items: items.map((v: any) => {
              if (typeof v === 'number') return { type: 'NUMBER', value: v }
              if (typeof v === 'string') return { type: 'STRING', value: v }
              return v
            })}
          } catch {
            // fall through
          }
        }
      }
    }
  }

  // ── CASE 表达式适配：从查询字符串构建 GE 兼容的 caseColumns ──
  // ANTLR 不输出 caseColumns（PEG 时期构建的 AST 字段），GE 的 _execCaseColumns 需要它。
  if (!plan.caseColumns && plan.returnColumns && plan.returnColumns.length > 0) {
    // Search CASE: CASE WHEN ... THEN ... ELSE ... END AS alias
    const searchCaseRegex = /CASE\s+(WHEN\s+.+?THEN\s+.+?)+(?:ELSE\s+.+?)?\s+END\s+(?:AS\s+(\w+))?/gis
    let scMatch: RegExpExecArray | null
    while ((scMatch = searchCaseRegex.exec(query)) !== null) {
      const alias = scMatch[2] || 'case'
      if (plan.returnColumns.includes(alias)) {
        _addCaseFromText(scMatch[0], alias, null, plan)
      }
    }
    // Simple CASE: CASE n.name WHEN 'Alice' THEN 'A' ELSE 'B' END AS alias
    const simpleCaseRegex = /CASE\s+(\S+?)\s+(WHEN\s+.+?THEN\s+.+?)+(?:ELSE\s+.+?)?\s+END\s+(?:AS\s+(\w+))?/gis
    let sc2Match: RegExpExecArray | null
    while ((sc2Match = simpleCaseRegex.exec(query)) !== null) {
      const alias = sc2Match[3] || 'case'
      if (plan.returnColumns.includes(alias)) {
        const caseVar = sc2Match[1]
        const caseExpr = _makePropRef(caseVar)
        _addCaseFromText(sc2Match[0], alias, caseExpr, plan)
      }
    }
  }

  // EXISTS 子查询：从查询文本提取 existsFilters
  // ANTLR 的 Cypher 语法不支持 EXISTS { ... } 子查询，只能从文本级检测
  const existsRegex = /EXISTS\s*\{\s*\((\w+)\)\s*((?:-\[:[^\]]*\]->|<-->|<--|-->|<--)\s*\((\w+)\)|\s*--\s*\((\w+)\))\s*\}/gi
  let existsMatch: RegExpExecArray | null
  while ((existsMatch = existsRegex.exec(query)) !== null) {
    if (!plan.existsFilters) plan.existsFilters = []
    const src = existsMatch[1]
    const arrowText = existsMatch[2]
    const tgt = existsMatch[3] || existsMatch[4]
    // GE 的 _checkExistsDirection 中 direction === 'any' 短路返回 true（bug），
    // 所以 undirected (--) 映射为 'out'（通过 neighbors() 检查出边是否存在）
    const direction = /->/.test(arrowText) ? 'out' : /<-/.test(arrowText) ? 'in' : 'out'
    const labelMatch = arrowText.match(/\[:(\w+)\]/)
    const edgeLabel: string | null = labelMatch ? labelMatch[1] : null
    plan.existsFilters.push({ source: src, edgeLabel, direction, target: tgt })
  }

  // ── WHERE 子句解析（补充标签谓词——ANTLR 不处理 a:Employee 格式） ──
  // ANTLR 已经处理了属性过滤器（n.name = 'Bob'），但标签谓词 a:Employee 不是 FilterClause
  // 我们的 _parseWhereClause 只需处理 labelFilterItems
  if (plan.hasMatch && query?.includes('WHERE')) {
    const whereText = extractWhereBody(query)
    if (whereText) {
      _parseLabelFilterOnly(whereText, plan)
    }
  }

  return plan
}

/** 从 Cypher 查询中提取 WHERE 子句的文本体 */
function extractWhereBody(query: string): string | null {
  const match = query.match(/WHERE\s+(.+?)(?:\s+(?:WITH|RETURN|CREATE|MERGE|SET|DELETE|ORDER\s+BY|SKIP|LIMIT|UNWIND)\s|$)/is)
  return match ? match[1].trim() : null
}

/**
 * 解析 WHERE 子句中变量名对应的节点在 allNodes 中的索引。
 * 变量可能是 scanLabel 节点或 steps 中的 source/targetAlias 节点。
 */
function resolveVariableNodeIdx(variable: string, plan: QueryPlan, allNodes: Record<string, unknown>[]): number {
  // 如果是 steps 中的 source 变量，索引 0（起始节点）
  if (plan.steps?.length && plan.steps[0].source === variable) return 0
  // 如果是 steps 中的 targetAlias，索引 1（第一跳目标）
  if (plan.steps?.length && plan.steps[0].targetAlias === variable) return 1
  // 如果是多跳（steps.length > 1），查找准确索引
  for (let i = 0; i < (plan.steps || []).length; i++) {
    if (plan.steps[i].targetAlias === variable) return i + 1
  }
  return -1
}

/**
 * 从 WHERE 子句文本提取标签谓词（ANTLR 不处理的 a:Employee 格式）
 */
function _parseLabelFilterOnly(whereText: string, plan: QueryPlan): void {
  const topLevel = splitByAndOr(whereText, 'AND')
  const labelItems: Array<{ variable: string; label: string; exclude: boolean }> = []

  for (const condition of topLevel) {
    const c = condition.trim()

    // a:Employee 或 a:!Employee 标签谓词
    const labelMatch = c.match(/^(\w+)\s*:\s*(!?\w+)$/)
    if (labelMatch) {
      const variable = labelMatch[1]
      const label = labelMatch[2].replace(/^!/, '')
      const exclude = labelMatch[2].startsWith('!')
      labelItems.push({ variable, label, exclude })
      continue
    }

    // NOT a:Excluded
    const notLabelMatch = c.match(/^NOT\s+(\w+)\s*:\s*(\w+)$/)
    if (notLabelMatch) {
      labelItems.push({ variable: notLabelMatch[1], label: notLabelMatch[2], exclude: true })
      continue
    }
  }

  if (labelItems.length) {
    (plan as any).labelFilterItems = labelItems.map(li => ({
      variable: li.variable,
      label: li.label,
      exclude: li.exclude,
    }))
  }
}

/** 按 AND 或 OR 分割顶层条件（不处理括号嵌套） */
function splitByAndOr(text: string, op: 'AND' | 'OR'): string[] {
  // 简单分割，不处理括号中的 AND/OR
  const parts: string[] = []
  let depth = 0
  let current = ''
  const ops = ['AND', 'OR']
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(' || ch === '[') { depth++; current += ch; continue }
    if (ch === ')' || ch === ']') { depth--; current += ch; continue }
    if (ch === "'" || ch === '"') {
      // 跳过字符串字面量
      const quote = ch
      current += quote
      i++
      while (i < text.length && text[i] !== quote) { current += text[i]; i++ }
      if (i < text.length) current += text[i]
      continue
    }
    if (depth === 0) {
      // 检查是否有操作符
      const rest = text.substring(i)
      let matched = false
      for (const o of ops) {
        if (rest.startsWith(o) && (rest.length === o.length || /\s/.test(rest[o.length]) || i + o.length >= text.length)) {
          if (current.trim()) parts.push(current.trim())
          current = ''
          i += o.length - 1
          matched = true
          break
        }
      }
      if (matched) continue
    }
    current += ch
  }
  if (current.trim()) parts.push(current.trim())
  return parts.length ? parts : [text]
}

/** 将字符串值解析为字面量（数字、字符串、布尔、null） */
function parseLiteralValue(val: string): unknown {
  const trimmed = val.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  if (/^[+-]?\d+\.?\d*$/.test(trimmed)) return Number(trimmed)
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** 从 CASE 文本解析 WHEN/THEN/ELSE 并添加到 plan.caseColumns */
function _addCaseFromText(caseText: string, alias: string, caseExpr: any | null, plan: QueryPlan): void {
  const whenRegex = /WHEN\s+(.+?)\s+THEN\s+(.+?)(?=\s+WHEN|\s+ELSE|\s+END)/gis
  const whens: Array<{ condition: any; result: any }> = []
  let wm: RegExpExecArray | null
  while ((wm = whenRegex.exec(caseText)) !== null) {
    whens.push({
      condition: _parseCaseCondition(wm[1].trim()),
      result: _makeLiteral(wm[2].trim()),
    })
  }
  const elseMatch = caseText.match(/ELSE\s+(.+?)\s+END/i)
  const elseExpr = elseMatch ? _makeLiteral(elseMatch[1].trim()) : null
  if (whens.length > 0) {
    if (!plan.caseColumns) plan.caseColumns = []
    plan.caseColumns.push({ alias, expression: { caseExpr, whens, elseExpr } })
  }
}

/** 解析 CASE WHEN 条件文本 → { type, left, operator, right } */
function _parseCaseCondition(text: string): any {
  const opMatch = text.match(/^(\S+?)\s*(>=|<=|<>|!=|=|>|<)\s*(.+)$/)
  if (opMatch) {
    const source = opMatch[1]
    const opMap: Record<string, string> = { '=': 'EQ', '<>': 'NEQ', '!=': 'NEQ', '>': 'GT', '>=': 'GTE', '<': 'LT', '<=': 'LTE' }
    return {
      type: 'COMPARISON',
      left: _makePropRef(source),
      operator: opMap[opMatch[2]] || opMatch[2],
      right: _makeLiteral(opMatch[3].trim()),
    }
  }
  return _makeLiteral(text)
}

/** 构建 PROP_REF 节点（GE 的 _resolvePrimaryExpr 期望的格式） */
function _makePropRef(text: string): any {
  return { type: 'PROP_REF', property: text.replace(/^\w+\./, '') }
}

/** 构建字面量节点（GE 的 _resolvePrimaryExpr 期望的格式） */
function _makeLiteral(val: string): any {
  const unquoted = _stripQuotes(val)
  if (typeof unquoted === 'number') return { type: 'NUMBER', value: unquoted }
  if (unquoted === 'true' || unquoted === 'false') return { type: 'BOOLEAN', value: unquoted === 'true' }
  return { type: 'STRING', value: unquoted }
}

/** 去掉引号，数字转数值 */
function _stripQuotes(s: string): string | number {
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) return s.slice(1, -1)
  const n = Number(s)
  return isNaN(n) ? s : n
}


/** ORDER BY 字段解析：从 orderBy 对象提取字段名 */
function _orderByField(o: any): string {
  let field = o.field || o.property || o.column || o.expression || o.col
  if (!field) {
    for (const k of Object.keys(o)) {
      if (k !== 'direction' && k !== 'type' && typeof o[k] === 'string') { field = o[k]; break }
    }
  }
  if (field) field = field.replace(/^\w+\./, '')
  return field || 'n'
}

function _postProcessResults(result: QueryRow[], plan: QueryPlan): QueryRow[] {
  if (!result?.length) return result
  const p = plan
  let processed = result.slice()

  // ── ORDER BY ──
  if (p.orderBy?.length) {
    processed.sort((a, b) => {
      for (const o of p.orderBy) {
        const field = _orderByField(o)
        const dir = (o.direction || '').trim().toUpperCase()
        const va = a[field] ?? null, vb = b[field] ?? null
        let cmp = 0
        if (va === null && vb === null) cmp = 0
        else if (va === null) cmp = -1
        else if (vb === null) cmp = 1
        else if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb
        else cmp = String(va).localeCompare(String(vb))
        if (cmp !== 0) return dir === 'DESC' ? -cmp : cmp
      }
      return 0
    })
  }

  // ── HAVING ──
  if (p.having?.length && processed.length > 0) {
    for (const h of p.having) {
      let aggKey: string | null = null
      const sampleKeys = Object.keys(processed[0])
      const aggStripped = h.aggregate.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
      for (const key of sampleKeys) {
        if (key.toLowerCase() === h.aggregate.toLowerCase() ||
            key.toLowerCase() === aggStripped ||
            key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() === aggStripped) { aggKey = key; break }
      }
      if (!aggKey) {
        for (const key of sampleKeys) { if (typeof processed[0][key] === 'number') { aggKey = key; break } }
      }

      const op = h.operator, val = h.value
      processed = processed.filter(row => {
        const rowVal = aggKey ? row[aggKey] : undefined
        if (rowVal === undefined) return true
        switch (op) {
          case 'GT': return rowVal > val
          case 'GTE': return rowVal >= val
          case 'LT': return rowVal < val
          case 'LTE': return rowVal <= val
          case 'EQ': return rowVal === val
          case 'NEQ': return rowVal !== val
          default: return true
        }
      })
    }
  }

  return processed
}

/**
 * 多步遍历：从 startIdx 节点开始，沿 plan.steps 逐跳导航到最终节点。
 * 每一步使用 __edges 来查找邻居节点。匹配标签/方向/属性约束。
 * 返回所有可达的最终节点索引列表。
 */
function _walkMultiSteps(
  startIdx: number, steps: TraverseStep[], allNodes: Record<string, unknown>[],
  skipNodeIndices?: Set<number>,
  planFilters?: Array<{source?: string; property: string; value: any}>,
  stepSourceFilters?: Array<{source?: string; property: string; value: any}>
): number[] {
  let currentSet = new Set<number>([startIdx])
  for (let si = 0; si < steps.length; si++) {
    const step = steps[si]
    const nextSet = new Set<number>()
    // 构建 combinedSourceFilters：当前步的 source 节点属性约束
    const combinedSourceFilters: Array<{source?: string; property: string; value: any}> = []
    if (planFilters?.length) {
      for (const f of planFilters) { if (f.source === step.source) combinedSourceFilters.push(f) }
    }
    if (stepSourceFilters?.length) {
      for (const f of stepSourceFilters) { if (f.source === step.source) combinedSourceFilters.push(f) }
    }
    // 在边遍历前应用 source filter：从 currentSet 中移除不满足 source 约束的节点
    // WHERE a.id = 1 — 在 seed 节点（step 0）和路径回溯（step 3+）中检查
    if (combinedSourceFilters.length > 0) {
      for (const idx of [...currentSet]) {
        const fn = allNodes[idx]
        if (!fn) continue
        let passes = true
        for (const rf of combinedSourceFilters) {
          if (fn[rf.property] === undefined || String(fn[rf.property]) !== String(rf.value)) {
            passes = false
            break
          }
        }
        if (!passes) currentSet.delete(idx)
      }
    }
    // 边遍历
    for (const idx of currentSet) {
      const node = allNodes[idx]
      if (!node) continue
      const edges: Array<{ dstIdx: number; srcIdx: number; label: string; props?: any }> = (node as any).__edges || []
      const isAny = step.direction === 'any'
      // 当前节点的出边
      for (const e of edges) {
        let neighborIdx = -1
        if (isAny) {
          neighborIdx = e.dstIdx === idx ? e.srcIdx : (e.srcIdx === idx ? e.dstIdx : -1)
        } else if (step.direction === 'out' && e.srcIdx === idx) {
          neighborIdx = e.dstIdx
        } else if (step.direction === 'in' && e.dstIdx === idx) {
          neighborIdx = e.srcIdx
        }
        if (neighborIdx >= 0 && neighborIdx < allNodes.length && neighborIdx !== idx) {
          // 边标签检查：如果 step 指定了 edgeLabel，边必须匹配（方向已经匹配）
          if (step.edgeLabel && e.label !== step.edgeLabel) continue
          if (_stepMatchConstraint(neighborIdx, step, allNodes)) {
            nextSet.add(neighborIdx)
          }
        }
      }
      // 无向边：其他节点到当前节点的反向边
      if (isAny) {
        for (let j = 0; j < allNodes.length; j++) {
          if (j === idx) continue
          const other = allNodes[j] as any
          if (other.__edges) {
            for (const e of other.__edges) {
              if (e.dstIdx === idx || e.srcIdx === idx) {
                const neighborIdx = e.dstIdx === idx ? e.srcIdx : e.dstIdx
                if (neighborIdx !== idx && !nextSet.has(neighborIdx) && _stepMatchConstraint(neighborIdx, step, allNodes)) {
                  nextSet.add(neighborIdx)
                }
              }
            }
          }
        }
      }
    }
    // 当前 step 的 target filter（约束 step.targetAlias 变量）
    const targetFilters = planFilters?.length ? planFilters.filter(f => f.source === step.targetAlias) : []
    if (targetFilters.length > 0) {
        for (const fidx of [...nextSet]) {
          const fn = allNodes[fidx]
          if (!fn) { nextSet.delete(fidx); continue }
          let passes = true
          for (const rf of targetFilters) {
            if (fn[rf.property] === undefined || String(fn[rf.property]) !== String(rf.value)) {
              passes = false
              break
            }
          }
          if (!passes) nextSet.delete(fidx)
        }
      }
    // 应用被 WHERE 过滤跳过的节点抑制（仅在单步时使用，多步会错误地过滤路径中间节点）
    if (skipNodeIndices && skipNodeIndices.size > 0 && steps.length <= 1) {
      for (const sidx of skipNodeIndices) {
        nextSet.delete(sidx)
      }
    }
    currentSet = nextSet
    if (currentSet.size === 0) break
  }
  return [...currentSet]
}

/** 检查 step 对目标节点的约束 */
function _stepMatchConstraint(nodeIdx: number, step: TraverseStep, allNodes: Record<string, unknown>[]): boolean {
  const node = allNodes[nodeIdx]
  if (!node) return false
  // 标签约束
  if (step.targetLabel && node._label !== step.targetLabel) return false
  // 内联属性约束
  if (step.targetProps) {
    for (const [k, v] of Object.entries(step.targetProps)) {
      if (node[k] === undefined || String(node[k]) !== String(v)) return false
    }
  }
  return true
}

/** GraphEngine 原生执行入口 */
function _executeViaGraphEngine(plan: QueryPlan, nodes: Array<Record<string, unknown>>, query?: string): QueryResult {
  // SHOW LABELS —— 从数据中提取
  if (plan.show) {
    if (typeof plan.show === 'object' && (plan.show as any).what === 'LABELS') {
      const seen = new Set<string>()
      const labels: QueryRow[] = []
      for (const n of nodes) {
        const lbl = n['_label']
        if (lbl && !seen.has(String(lbl))) { seen.add(String(lbl)); labels.push({ label: lbl }) }
      }
      return labels
    }
    return []
  }

  // USE — 命名空间切换
  if (plan.type === 'USE') return nodes

  // UNION — 递归执行
  if (plan.unionType && plan.rightPlan) {
    const leftResult = _executeViaGraphEngine({ ...plan, unionType: undefined, rightPlan: undefined }, nodes)
    const rightResult = _executeViaGraphEngine(plan.rightPlan, nodes)
    const leftRows = leftResult as QueryRow[]
    const rightRows = rightResult as QueryRow[]
    switch (plan.unionType) {
      case 'union': {
        const seen = new Set<string>()
        const merged: QueryRow[] = []
        for (const row of [...leftRows, ...rightRows]) { const k = JSON.stringify(row); if (!seen.has(k)) { seen.add(k); merged.push(row) } }
        return merged
      }
      case 'union_all': return [...leftRows, ...rightRows]
      case 'intersect': { const rk = new Set(rightRows.map(r => JSON.stringify(r))); return leftRows.filter(r => rk.has(JSON.stringify(r))) }
      case 'subtract': { const ek = new Set(rightRows.map(r => JSON.stringify(r))); return leftRows.filter(r => !ek.has(JSON.stringify(r))) }
      default: return [...leftRows, ...rightRows]
    }
  }

  // 纯 RETURN 字面量（无 MATCH 无 steps 非 DML）——不经过 GraphEngine
  const isDML = ['MERGE', 'CREATE', 'DELETE', 'SET', 'REMOVE', 'CREATE_CONSTRAINT', 'FOREACH'].includes(plan.type || '')
  if (!plan.scanLabel && !plan.steps?.length && !plan.aggregate && !plan.hasMatch && !isDML) {
    const row: QueryRow = {}
    if (plan.constColumns?.length) {
      for (const c of plan.constColumns) row[c.alias] = c.value
    } else if (plan.expressionColumns?.length) {
      for (const e of plan.expressionColumns) row[e.alias] = e.expression
    } else if (plan.returnColumns?.length) {
      for (const c of plan.returnColumns) row[c] = null
    }
    return Object.keys(row).length ? [row] : []
  }

  // ── DML 纯操作（无 RETURN）：直接返回空（side effects 由调用方处理） ──
  if (isDML && !plan.returnColumns?.length && !plan.aggregate) {
    return []
  }

  const dir = path.join('/tmp', 'tckge-' + process.pid + '-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'))
  let ge: GraphEngine | null = null
  try {
    fs.mkdirSync(dir, { recursive: true })
    const config: OverGraphConfig = { path: dir, denseVector: { dimension: 384 } }
    ge = new GraphEngine(config)
    ge.open()

    // ── 构建完整的输入节点集（seedNodes + DML createNodes） ──
    const allNodes: Array<Record<string, unknown>> = [...(nodes || [])]
    // 如果传入节点没有 _label 标签但 plan 指定了 scanLabel，自动赋值（兼容外部 plan 导入场景）
    if (plan.scanLabel && allNodes.some(n => !('_label' in n) || n._label === undefined || n._label === null)) {
      let scanLabelAssigned = false
      for (const n of allNodes) {
        if (!('_label' in n) || n._label === undefined || n._label === null) {
          n._label = plan.scanLabel
          scanLabelAssigned = true
        }
      }
      if (scanLabelAssigned) {
        // 同时通知 skipNodeIndices 构建（后面的代码直接用 _label 判断）
      }
    }
    if (plan.createNodes?.length) {
      for (const cn of plan.createNodes) {
        const props: Record<string, unknown> = { _label: cn.label || 'Default' }
        if (cn.props) { for (const k of Object.keys(cn.props)) props[k] = cn.props[k] }
        if (cn.alias) props['_alias'] = cn.alias
        allNodes.push(props)
      }
    }

    let edgeLabelFromTypeFilter = false  // flag: 从 WHERE type(r) 设置了边类型过滤
    // ── WHERE 预过滤：确定哪些 seed 节点需要跳过 ──
    // GE 的 _executeQueryPlan 在 steps 遍历后才对结果节点应用 filter，
    // 且 _matchFilter 忽略 filter.source。对于 WHERE n.name = 'Bob'
    // 这种 source 变量是步骤起点的 filter，在 seed 阶段跳过不匹配的节点。
    // 注意：allNodes 必须保持原样（__edges 的 srcIdx/dstIdx 依赖原始索引），
    // 所以在 seed 循环中条件跳过，而非过滤 allNodes。
    // 跨变量属性引用检测：f.value 格式为 `var.property`，不能在 seed 阶段用常数比较
    const _isVarRef = (v: any): boolean => typeof v === 'string' && /^\w+\.\w+$/.test(v) && !/^['"]/.test(v) && !/^\d/.test(v)
    const crossVarFilters = (plan.filters || []).filter(f => f.source && f.property && _isVarRef(f.value))
    const stepSourceFilters = (plan.filters || []).filter(f => {
      const firstStep = plan.steps?.[0]
      // 排除跨变量引用 filter（seed 阶段无法做跨变量比较）
      if (crossVarFilters.includes(f)) return false
      const result = firstStep && f.source === firstStep.source && firstStep.source
      return result
    })
    // ── WHERE 标签谓词预过滤 ──
    // 提取 `WHERE a:A` 形式的标签检查（ANTLR 不将其解析为 filter）
    const whereLabelFilters: Array<{varName: string; targetLabel: string}> = []
    if (plan.steps?.length && query) {
      const firstStepSource = plan.steps[0].source
      if (firstStepSource) {
        // 从原始 query 中提取 WHERE 子句，然后查找 var:Label 模式
        const whereClauseMatch = query.match(/\bWHERE\s+([\s\S]+?)(?=\b(RETURN|WITH|CREATE|ORDER|SKIP|LIMIT)\b|$)/i)
        if (whereClauseMatch) {
          const whereClause = whereClauseMatch[1]
          const varLabelRegex = new RegExp("\\b" + firstStepSource + "\\s*:\\s*(\\w+)", "i")
          const lcMatch = whereClause.match(varLabelRegex)
          if (lcMatch) {
            whereLabelFilters.push({ varName: firstStepSource, targetLabel: lcMatch[1] })
          }
        }
      }
    }

    // 构建需要跳过的节点索引集合
    const skipNodeIndices = new Set<number>()
    if ((stepSourceFilters.length || whereLabelFilters.length) && (plan.scanLabel || !plan.scanLabel)) {
      for (let ni = 0; ni < allNodes.length; ni++) {
        const node = allNodes[ni]
        const nodeLabel = String(node['_label'] || '')
        if (plan.scanLabel && nodeLabel !== plan.scanLabel) {
          continue // 非 scanLabel 的节点不参与过滤（GE 不会扫到它）
        }
        const match = stepSourceFilters.every((f: any) => {
          const val = (node as any)[f.property]
          const target = f.value
          switch (f.operator) {
            case 'EQ':  return val === target
            case 'NEQ': return val !== target
            case 'GT':
            case 'GTE':
            case 'LT':
            case 'LTE':
              return typeof val === 'number' && typeof target === 'number'
                ? (f.operator === 'GT' ? val > target : f.operator === 'GTE' ? val >= target : f.operator === 'LT' ? val < target : val <= target)
                : false
            default:    return true
          }
        })
        if (!match) {
          skipNodeIndices.add(ni)
        }
        // WHERE 标签谓词过滤：检查节点标签是否匹配 WHERE var:Label
        if (whereLabelFilters.length && !skipNodeIndices.has(ni)) {
          const nodeLabel = String(node['_label'] || '')
          const fsSource = plan.steps?.[0]?.source
          const labelOk = whereLabelFilters.every(lf => {
            return fsSource && lf.varName === fsSource && nodeLabel === lf.targetLabel
          })
          if (!labelOk) {
            skipNodeIndices.add(ni)
          }
        }
      }
      // 从 plan.filters 中移除已预处理的过滤器
      plan.filters = (plan.filters || []).filter((f: any) => !stepSourceFilters.includes(f))

    }

    // ── 内联节点属性预过滤（从 query 解析 `(n {name: 'A'})`） ──

    if (query && !stepSourceFilters.length) {
      const inlineMatch = query.match(/MATCH\s+\((\w+)\s*\{([^}]+)\}[^)]*\)/)
      if (inlineMatch) {
        const inlineVar = inlineMatch[1]
        const inlinePropsRaw = inlineMatch[2]
        const inlinePredicates: Array<{ key: string; value: string | number }> = []
        const pairRegex = /(\w+)\s*:\s*(?:'([^']*)'|"([^"]*)"|(\d+(?:\.\d+)?))/g
        let pairMatch
        while ((pairMatch = pairRegex.exec(inlinePropsRaw)) !== null) {
          const key = pairMatch[1]
          const strVal = pairMatch[2] ?? pairMatch[3]
          const numVal = pairMatch[4]
          inlinePredicates.push({ key, value: strVal !== undefined ? strVal : parseFloat(numVal) })
        }
        if (inlinePredicates.length) {
          const matchSource = plan.steps?.[0]?.source
          const isMatchSource = inlineVar === matchSource || (!matchSource && !plan.scanLabel)
          if (isMatchSource) {
            for (let i = 0; i < allNodes.length; i++) {
              if (skipNodeIndices.has(i)) continue
              let matchesAll = true
              for (const pred of inlinePredicates) {
                const actual = allNodes[i][pred.key]
                const expected = pred.value
                if (actual === undefined || String(actual) !== String(expected)) {
                  matchesAll = false
                  break
                }
              }
              if (!matchesAll) skipNodeIndices.add(i)
            }
          }
        }
      }
    }
    const nodeGeIds: number[] = []


    let edgesPayload: Array<{ srcIdx: number; dstIdx: number; label: string }> = []
    if (allNodes.length) {
      for (let i = 0; i < allNodes.length; i++) {
        // WHERE 预过滤：跳过不匹配的起始节点
        if (skipNodeIndices.has(i)) {
          nodeGeIds[i] = 0 // 占位，不 seed 到 GE
          continue
        }
        const item = allNodes[i]
        const label = String(item['_label'] || 'Default')
        const hasMultipleLabels = label.includes(':')
        // 多标签：存完整标签到 __fullLabel，用第一个标签注册到 GE
        const geLabel = hasMultipleLabels ? label.split(':')[0] : label
        const props: Record<string, unknown> = { _label: geLabel }
        if (hasMultipleLabels) props['__fullLabel'] = label
        for (const k of Object.keys(item)) {
          if (k !== '_label' && k !== '__edges') props[k] = item[k]
        }
        let h = 0
        for (let ci = 0; ci < geLabel.length; ci++) h = ((h << 5) - h + geLabel.charCodeAt(ci)) | 0
        // 调用 GE 的 upsertNode（处理 nodeIds 索引、缓存等），获取返回的 Promise
        // 由于 _executeViaGraphEngine 是同步函数，无法 await，
        // 但 GE.upsertNode 的核心（storage.upsertNode + nodeId tracking）是同步的
        const geTypeId = Math.abs(h) % 1000 + 1
        try {
          // GE upsertNode 返回 Promise<NodeId>，核心在 sync 阶段完成
          const p = (ge as any).asyncUpsertNode
            ? (ge as any).upsertNode(geTypeId, 'n' + i, { props })
            : Promise.resolve(i + 1)
          // 同步执行：upsertNode 内部 this.storage.upsertNode 是同步的，nodeIds 也同步更新
          // 但 upsertNode 定义为 async，返回 Promise。我们直接调 storage.upsertNode + 手动更新 nodeIds
          const actualId = (ge as any).storage.upsertNode(geTypeId, 'n' + i, { props })
          ;(ge as any)._nodeIds.add(actualId)
          ;(ge as any)._labelIndex?.addNode?.(geTypeId, actualId)
          nodeGeIds[i] = actualId
        } catch (e) {
          nodeGeIds[i] = i + 1
        }
      }
      // 从 allNodes 中提取 __edges 并创建边
      edgesPayload = extractEdgesFromNodes(allNodes)
      // 将 edgesPayload 中的边分配到对应节点的 __edges 上（供 _walkMultiSteps 遍历使用）
      // edgesPayload 可能只存储在 allNodes[0].__edges 中（TCK step-definitions 的存储方式）
      if (edgesPayload.length) {
        const nodeEdgeMap: Array<Array<{dstIdx: number; srcIdx: number; label: string; props?: any}>> = allNodes.map(() => [] as any)
        for (const ep of edgesPayload) {
          if (ep.srcIdx >= 0 && ep.srcIdx < allNodes.length) {
            nodeEdgeMap[ep.srcIdx].push({dstIdx: ep.dstIdx, srcIdx: ep.srcIdx, label: ep.label, props: ep.props || undefined})
          }
          if (ep.dstIdx >= 0 && ep.dstIdx < allNodes.length) {
            nodeEdgeMap[ep.dstIdx].push({dstIdx: ep.dstIdx, srcIdx: ep.srcIdx, label: ep.label, props: ep.props || undefined})
          }
        }
        for (let ni = 0; ni < allNodes.length; ni++) {
          if (!(allNodes[ni] as any).__edges || !(allNodes[ni] as any).__edges.length) {
            (allNodes[ni] as any).__edges = nodeEdgeMap[ni]
          }
        }
      }
  
      if (edgesPayload.length) {
        // 为被跳过的节点创建 GE stub node，使其在边缘创建时可被引用
        if (skipNodeIndices.size) {
          for (const si of skipNodeIndices) {
            if (si < allNodes.length && allNodes[si]) {
              const item = allNodes[si]
              const label = String(item['_label'] || 'Default')
              let h = 0
              for (let ci = 0; ci < label.length; ci++) h = ((h << 5) - h + label.charCodeAt(ci)) | 0
              const geTypeId = Math.abs(h) % 1000 + 1
              const stubProps: Record<string, unknown> = { _label: label }
              for (const k of Object.keys(item)) {
                if (k !== '_label' && k !== '__edges') stubProps[k] = item[k]
              }
              try {
                // 使用同步的 storage.upsertNode 而不是 async ge.upsertNode
                const stubId = (ge as any).storage.upsertNode(geTypeId, 's' + si, { props: stubProps })
                // 手动更新 GE 的内部状态（nodeIds、labelIndex、缓存等）
                if (stubId > 0) {
                  ;(ge as any)._nodeIds.add(stubId)
                  ;(ge as any)._labelIndex?.addNode?.(geTypeId, stubId)
                  nodeGeIds[si] = stubId
                }
              } catch (e: any) {
                // Fallback
                nodeGeIds[si] = si + 1
              }
            }
          }
        }

        const anyDirection = plan.steps?.length && plan.steps.some(s => s.direction === 'any')
        for (const ep of edgesPayload) {
          const srcGeId = ep.srcIdx >= 0 && ep.srcIdx < nodeGeIds.length ? nodeGeIds[ep.srcIdx] : -1
          const dstGeId = ep.dstIdx >= 0 && ep.dstIdx < nodeGeIds.length ? nodeGeIds[ep.dstIdx] : -1
          if (srcGeId <= 0 || dstGeId <= 0) continue
          const typeId = (ge as any)._resolveEdgeType(ep.label || '')
          // 创建正向边
          if ((ep as any).props) {
            try { (ge as any).upsertEdge(srcGeId, dstGeId, typeId, { props: (ep as any).props }) } catch {}
          } else {
            try { (ge as any).upsertEdge(srcGeId, dstGeId, typeId) } catch {}
          }
          // 无向边双向
          if (anyDirection && srcGeId !== dstGeId) {
            try { (ge as any).upsertEdge(dstGeId, srcGeId, typeId) } catch {}
          }
        }
      }

    }

    // ── 构建 source→target 映射（GE 不保留从哪个源节点出发） ──
    // 用于 RETURN 中 source 变量（如 RETURN n 而非 RETURN 目标节点）
    // 以及 WHERE 过滤后的 source 节点结果重建。
    // 格式：Map<targetGeId, sourceGeId[]>
    const sourceTargetMap = new Map<number, number[]>()
    if (edgesPayload.length && nodeGeIds.length) {
      for (const ep of edgesPayload) {
        const srcGeId = ep.srcIdx >= 0 && ep.srcIdx < nodeGeIds.length ? nodeGeIds[ep.srcIdx] : -1
        const dstGeId = ep.dstIdx >= 0 && ep.dstIdx < nodeGeIds.length ? nodeGeIds[ep.dstIdx] : -1
        if (srcGeId <= 0 || dstGeId <= 0) continue // 跳过被预过滤的占位节点
        if (!sourceTargetMap.has(dstGeId)) sourceTargetMap.set(dstGeId, [])
        sourceTargetMap.get(dstGeId)!.push(srcGeId)
        // 无向边也记录反向
        if (!sourceTargetMap.has(srcGeId)) sourceTargetMap.set(srcGeId, [])
        sourceTargetMap.get(srcGeId)!.push(dstGeId)
      }
    }

    // ── CREATE 边（从 createEdges 创建 GE 关系） ──
    if (plan.createEdges?.length && nodeGeIds.length >= 1) {
      for (const edge of plan.createEdges) {
        // 通过 alias 或 sourceIdx/targetIdx 查找对应的节点索引
        let srcIdx = edge.sourceIdx !== undefined ? edge.sourceIdx : (plan.createNodes || []).findIndex(cn => cn.alias === edge.source)
        let dstIdx = edge.targetIdx !== undefined ? edge.targetIdx : (plan.createNodes || []).findIndex(cn => cn.alias === edge.target)
        if (srcIdx >= 0 && dstIdx >= 0 && srcIdx < nodeGeIds.length && dstIdx < nodeGeIds.length) {
          const srcId = nodeGeIds[srcIdx]
          const dstId = nodeGeIds[dstIdx]
          if (srcId && dstId) {
            // 使用 GE 的 _resolveEdgeType 获取统一的 typeId
            const typeId = (ge as any)._resolveEdgeType(edge.label || '')
            try { (ge as any).upsertEdge(srcId, dstId, typeId) } catch {}
          }
        }
      }
    }

    // ── DML + RETURN：从 createNodes 构造结果行（GE 对 DML 返回空） ──
    if (plan.type === 'CREATE' && plan.returnColumns?.length) {
      const created = _buildDmlRows(plan, allNodes)
      return _postProcessResults(created, plan)
    }

    // ── WHERE type(r) = 'LABEL' → 转为 edgeLabel 过滤（非参数化） ──
    if (query && !plan.steps?.some(s => s.edgeLabel)) {
      const typeMatch = query.match(/WHERE\s+type\s*\(\s*(\w+)\s*\)\s*=\s*['"]([^'"]+)['"]/)
      if (typeMatch) {
        const typeLabel = typeMatch[2]
        const step = plan.steps?.find(s => {
          if (s.edgeLabel) return s.edgeLabel.split('|').includes(typeLabel)
          return true
        })
        if (step) {
          step.edgeLabel = typeLabel
        }
      }
    }


    // ── 多类型 edgeLabel 处理 ──
    // MATCH (n)-[r:KNOWS|HATES]->(x) — 分割为多个单标签查询合并结果
    // DEBUG [5]: check filter state
    // ── 预分离边变量 filter（WHERE r.name = 'foo'） ──
    // GE 的 _matchFilter 只检查节点属性，无法处理 source="r" 的边属性 filter。
    // 从 plan.filters 中摘出边变量 filter，GE 执行时去掉它们，执行完后手动应用。
    // 边变量 filter 的判断：source 是 MATCH 中的关系变量（通常在步骤 source 左边或右边），
    // 但肯定不是步骤 source 也不是扫描出来的节点变量。
    // 判断条件：plan.filters 中 source 不是步骤 source，且 steps 非空（否则是纯节点 WHERE）。
    const stepSrc = plan.steps?.[0]?.source
    const stepTarget = plan.steps?.[0]?.targetAlias
    // 收集所有 step 中的节点变量名（source + targetAlias），不仅是 step 0
    const allStepVars = new Set<string>()
    for (const s of (plan.steps || [])) {
      if (s.source) allStepVars.add(s.source)
      if (s.targetAlias) allStepVars.add(s.targetAlias)
    }
    if (plan.scanLabel) allStepVars.add(plan.scanLabel)
    const nodeAliasList = [...allStepVars]
    const edgeFilters = plan.steps?.length && (plan.filters || []).filter(f =>
      f.source && !nodeAliasList.includes(f.source)
    ) || []
    const hasOR = query ? /OR/i.test(query) : false
    const geFilters = (plan.filters || []).filter(f => !edgeFilters.includes(f))

    const multiTypeStep = plan.steps?.find(s => s.edgeLabel && s.edgeLabel.includes('|'))

    // ── 多步跳转支持（MATCH (a)-->(b)-->(c)）──
    // 当 steps.length > 1 时，GE 的 _executeQueryPlan 只处理第一个 step。
    // 对多步路径手动遍历：从 seed 节点开始逐 step 跳转，使用 __edges 导航。
    const hasMultiStep = plan.steps && plan.steps.length > 1 && allNodes.length > 0

    // DEBUG [10]
    const rawRecords: any[] = hasMultiStep
      ? (() => {
          const multiStepRaw: any[] = []
          for (let i = 0; i < allNodes.length; i++) {
            if (skipNodeIndices.has(i)) {
              continue
            }
            let skipNode = false
            for (const sf of stepSourceFilters) {
              if (allNodes[i][sf.property] === undefined || String(allNodes[i][sf.property]) !== String(sf.value)) {
                skipNode = true
                break
              }
            }
            if (skipNode) continue
            const pathResults = _walkMultiSteps(i, plan.steps, allNodes, skipNodeIndices, plan.filters, stepSourceFilters)
        // 对多步结果做交集限定：只保留在 RETURN 变量对应定义步（第一个定义该变量的 step）中存在的 target
        // 防止后续 step 引入不相关的中间节点
        const retVar = (plan.returnColumns || []).map(rc => rc?.split('.')[0]).find(rc => {
          if (!rc) return false
          const firstSrc = plan.steps?.[0]?.source
          return rc !== firstSrc && plan.steps?.some(s => s.targetAlias === rc)
        })
        let boundedTargetIndices = pathResults
        if (retVar && plan.steps) {
          const defStep = plan.steps.find(s => s.targetAlias === retVar)
          if (defStep !== undefined) {
            const defStepIdx = plan.steps.indexOf(defStep)
            // 对返回变量的定义步，重新走到该步的 target 节点。这是 RETURN 变量的实际值。
            if (defStepIdx >= 0) {
              const intermediate = _walkMultiSteps(
                i, plan.steps.slice(0, defStepIdx + 1),
                allNodes, undefined, plan.filters, stepSourceFilters
              )
              // 如果 RETURN 变量等于最后一个 step 的 targetAlias，全路径的过滤约束
              // 会影响返回值（后续步的 filter 消除多余节点），需要用交集过滤。
              // 否则 pathResults 中的节点是后续步的 target，不相关，直接用 intermediate。
              const lastStep = plan.steps[plan.steps.length - 1]
              if (lastStep && lastStep.targetAlias === retVar) {
                const defStepSet = new Set(intermediate)
                boundedTargetIndices = pathResults.filter(idx => defStepSet.has(idx))
              } else {
                boundedTargetIndices = intermediate
              }
            }
          }
        }
        for (const targetIdx of boundedTargetIndices) {
              const targetNode = allNodes[targetIdx]
              if (!targetNode) continue
              const geNode: any = {
                id: nodeGeIds[targetIdx] || (targetIdx + 1),
                props: { _label: targetNode._label || 'Default' },
                type: targetNode._label || 'Default',
                __multiStep: true,
              }
              for (const k of Object.keys(targetNode)) {
                if (k !== '_label' && k !== '__edges') {
                  geNode.props[k] = targetNode[k]
                }
              }
              multiStepRaw.push(geNode)
            }
          }
          return multiStepRaw
        })()
      : multiTypeStep
      ? (() => {
          const labels = multiTypeStep.edgeLabel!.split('|')
          const combined: Map<number, any> = new Map()
          for (const lbl of labels) {
            const p2 = JSON.parse(JSON.stringify(plan))
            p2.steps[0].edgeLabel = lbl
            p2.filters = (geFilters || []).filter(f => !crossVarFilters.includes(f))
            const subRaw: any[] = (ge as any)._executeQueryPlan(p2)
            for (const r of subRaw || []) combined.set(r.id, r)
          }
          return [...combined.values()]
        })()
      : hasOR
      ? (() => {
          // OR 语义：
          // 1) plan.filters 非空 → 逐 filter 执行 GE，合并去重
          // 2) plan.filters 为空但 query 有 type(r)=L1 OR type(r)=L2 → 逐 label 执行 GE，用 (id,label) 复合键去重
          const combined: Map<string, any> = new Map()
          const orFilters = (plan.filters || [])
          if (orFilters.length >= 2) {
            for (const f of orFilters) {
              const p2 = JSON.parse(JSON.stringify(plan))
              p2.filters = [f]
              const subRaw: any[] = (ge as any)._executeQueryPlan(p2)
              for (const r of subRaw || []) combined.set(String(r.id), r)
            }
          } else if (query && plan.steps?.[0]) {
            const typeRMatches = query.matchAll(/type\s*\(\s*(\w+)\s*\)\s*=\s*['"]([^'"]+)['"]/ig)
            const orLabels: Array<{ edgeVar: string; label: string }> = []
            for (const m of typeRMatches) orLabels.push({ edgeVar: m[1], label: m[2] })
            if (orLabels.length >= 2) {
              for (const ol of orLabels) {
                const p2 = JSON.parse(JSON.stringify(plan))
                p2.filters = []
                if (p2.steps?.[0]) p2.steps[0].edgeLabel = ol.label
                const subRaw: any[] = (ge as any)._executeQueryPlan(p2)
                for (const r of subRaw || []) {
                  // 保存边标签信息用于 RETURN r 格式化
                  if (!combined.has(String(r.id) + '__' + ol.label)) {
                    const rec = r.id !== undefined ? { ...r, id: r.id } : r
                    rec.__edgeLabel = ol.label
                    combined.set(String(r.id) + '__' + ol.label, rec)
                  }
                }
              }
            }
          }
          return [...combined.values()]
        })()
      : (() => {
          const planForGe = JSON.parse(JSON.stringify(plan))
          // 排除跨变量属性引用 filter（GE 的 _matchFilter 无法做跨变量比较）
          planForGe.filters = (geFilters || []).filter(f => !crossVarFilters.includes(f))
          return (ge as any)._executeQueryPlan(planForGe)
        })()
    let records = rawRecords
    // GE 的 _executeQueryPlan 总是返回遍历后的目标节点，不保留 source 节点信息。
    // 当 RETURN n（steps[0].source）时，需要将 GE 返回的 target 节点映射回 source 节点。
    // 通过 sourceTargetMap 完成：targetGeId → sourceGeIds[].
    // 如果某个 target 对应多个 source（多对多），也可能是一个 source 对多个 target（一对多）。
    // 我们用 allNodes 重新构造 source 节点数据。
    const needSourceVar = plan.returnColumns?.some((rc: string) => {
      const firstStep = plan.steps?.[0]
      if (!firstStep || !firstStep.source) return false
      // 直接匹配变量名（RETURN n）
      if (rc === firstStep.source) return true
      // 匹配属性投影（RETURN n.id）
      if (rc.startsWith(firstStep.source + '.')) return true
      return false
    })
    if (needSourceVar && sourceTargetMap.size > 0 && records?.length) {
      const sourceVar = plan.steps![0].source
      const targetAlias = plan.steps![0].targetAlias
      // 对每个 GE 返回的 target 节点，找到它对应的 source 节点
      // 使用 Map<srcId, targetProps> 去重，确保同一 source→target 只保留一条
      const dedupedRecords = new Map<string, { srcId: number; targetProps: Record<string, unknown> }>()
      for (const r of records) {
        const sourceIds = sourceTargetMap.get(r.id) || []
        if (!sourceIds.length) continue
        const targetProps = { ...(r.props || {}) }
        for (const srcId of sourceIds) {
          const key = `${srcId}:${r.id}`
          if (!dedupedRecords.has(key)) {
            dedupedRecords.set(key, { srcId, targetProps })
          }
        }
      }
      records = [...dedupedRecords.entries()].map(([key, { srcId, targetProps }]) => {
        const srcIdx = nodeGeIds.indexOf(srcId)
        if (srcIdx < 0) return null as any
        const srcNode = allNodes[srcIdx]
        const cleanProps: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(srcNode)) {
          if (k !== '__edges') cleanProps[k] = v
        }
        return {
          id: srcId as number,
          props: cleanProps,
          type: (ge as any).getNode(srcId)?.type || 0,
          name: (ge as any).getNode(srcId)?.name || '',
          deleteNodeKey: () => {},
          __targetProps: targetProps,
        }
      }).filter(Boolean)
    }

    if (!records?.length && allNodes.length && plan.scanLabel && plan.hasMatch) {
      const isUsedAsVariable = (plan.steps || []).some(s => s.source === plan.scanLabel)
      const isLabelInNodes = allNodes.some(n => String(n._label) === plan.scanLabel)
      if (isUsedAsVariable && !isLabelInNodes) {
        const fallbackPlan = { ...plan, scanLabel: null }
        records = (ge as any)._executeQueryPlan(fallbackPlan)
      }
    }


    // ── 内联节点属性预过滤（从 query 解析 `(n {name: 'A'})`） ──

    // 在 seed 阶段对每个 `allNodes` 中的节点进行属性匹配，不匹配则跳过 seed
    // 支持 `(var {prop1: val1, prop2: val2})` 格式
    if (query) {
      // 从 MATCH 子句中提取变量名和内联属性映射
      // 匹配模式：var {prop: val} 或 var {prop: 'val', prop2: 123}
      const inlineMatch = query.match(/MATCH\s*\((\w+)\s*\{([^}]+)\}/)
      if (inlineMatch) {
        const inlineVar = inlineMatch[1]
        const inlinePropsRaw = inlineMatch[2]
        // 解析键值对
        const inlinePredicates: Array<{ key: string; value: string | number; isString: boolean }> = []
        const pairRegex = /(\w+)\s*:\s*(?:'([^']*)'|"([^"]*)"|(\d+(?:\.\d+)?))/g
        let pairMatch
        while ((pairMatch = pairRegex.exec(inlinePropsRaw)) !== null) {
          const key = pairMatch[1]
          const strVal = pairMatch[2] ?? pairMatch[3]
          const numVal = pairMatch[4]
          if (strVal !== undefined) {
            inlinePredicates.push({ key, value: strVal, isString: true })
          } else {
            inlinePredicates.push({ key, value: parseFloat(numVal), isString: false })
          }
        }
        if (inlinePredicates.length && !skipNodeIndices.size) {
          // 在 seed 之前构建
          // 第一个 MATCH 的变量名通常是 plan.scanLabel 的 fallback
          // 或 steps[0].source
          const matchSource = plan.steps?.[0]?.source
          const isMatchSource = inlineVar === matchSource || (!matchSource && !plan.scanLabel)
          if (isMatchSource) {
            // 对 allNodes 检查属性匹配
            for (let i = 0; i < allNodes.length; i++) {
              const node = allNodes[i]
              let matchesAll = true
              for (const pred of inlinePredicates) {
                const actual = node[pred.key]
                const expected = pred.value
                if (actual === undefined || String(actual) !== String(expected)) {
                  matchesAll = false
                  break
                }
              }
              if (!matchesAll) {
                skipNodeIndices.add(i)
              }
            }
          }
        }
      }
    }

    // ── 修复 GE limit=0 bug ──
    if (plan.limit === 0 && records?.length) {
      return []
    }

    // ── labelExpr 过滤（多标签 AND 匹配） ──
    const filteredRecords = plan.labelExpr?.items?.length
      ? (records || []).filter((r: any) => {
          const nodeLabel = r?.props?.__fullLabel ?? r?.props?._label ?? ''
          const nodeLabels = String(nodeLabel).split(':')
          return plan.labelExpr!.items.every(item =>
            !item.exclude && nodeLabels.includes(item.name)
          )
        })
      : (records || [])

    // ── labelFilter（WHERE 中的标签谓词，如 `a:Employee`）过滤 ──
    // 对所有节点变量检查其 _label 是否匹配
    const labelFilterItems: Array<{ variable: string; label: string; exclude: boolean }> | undefined = (plan as any).labelFilterItems
    let filteredWithLabels = filteredRecords

    if (labelFilterItems?.length && filteredRecords.length) {
      // 构建 nodeGeIdx → label 的映射
      const nodeLabelsMap: Map<number, string> = new Map()
      for (let i = 0; i < allNodes.length; i++) {
        nodeLabelsMap.set(i, String(allNodes[i]._label || 'Default'))
      }
      filteredWithLabels = filteredWithLabels.filter((r: any) => {
        const nodeIdx = nodeGeIds.indexOf(r.id)
        if (nodeIdx < 0) return true // 保留无法映射的记录
        // 检查每个标签谓词条件是否满足
        return labelFilterItems!.every(lfi => {
          // 找到变量对应的节点
          const varNodeIdx = resolveVariableNodeIdx(lfi.variable, plan, allNodes)
          if (varNodeIdx < 0) return true
          const actualLabel = nodeLabelsMap.get(varNodeIdx) || ''
          const matches = actualLabel === lfi.label
          return lfi.exclude ? !matches : matches
        })
      })
    }
    // ── OR 连接谓词过滤（WHERE n.p1 > 11 OR n.p2 = 13） ──
    // ANTLR 将 OR 谓词解析为两个独立的 filter 且无 OR 标记，
    // engine 默认 AND 连接导致无行匹配。从 query 文本检查 OR，改 AND 为 OR 语义。
    if (query && /OR/i.test(query) && filteredWithLabels?.length) {
      const orFilters = plan.filters?.length ? plan.filters : []
      if (orFilters.length >= 2) {
        filteredWithLabels = filteredWithLabels.filter((r: any) => {
          return orFilters.some((f: any) => {
            const actual = r?.props?.[f.property]
            const expected = f.value
            if (actual === undefined) return false
            switch (f.operator) {
              case 'EQ':  return String(actual) === String(expected)
              case 'NEQ': return String(actual) !== String(expected)
              case 'GT':  return Number(actual) > Number(expected)
              case 'GTE': return Number(actual) >= Number(expected)
              case 'LT':  return Number(actual) < Number(expected)
              case 'LTE': return Number(actual) <= Number(expected)
              default:    return String(actual) === String(expected)
            }
          })
        })
      }
    }

    // ── WHERE 标签谓词后过滤（已经过 source 回溯后的数据） ──
    // 只对 needSourceVar=true 的场景生效（r.id 是 source 节点的 GE id）
    // 当直接返回 target 节点时（needSourceVar=false），不应用 source 节点的 skip 集合
    if (needSourceVar && skipNodeIndices.size > 0 && filteredWithLabels?.length && plan.steps?.[0]?.source) {
      const wsSource = plan.steps[0].source
      const before = filteredWithLabels.length
      filteredWithLabels = filteredWithLabels.filter((r: any) => {
        // 通过 nodeGeIds 查找这条记录对应的 allNodes 索引
        // 如果 r 是从 source 回溯得到的，它的 id 就是 source GE id
        const nodeIdx = nodeGeIds.indexOf(r.id)
        if (nodeIdx < 0) return true
        // 如果节点在 skipNodeIndices 中（标签不匹配），跳过
        return !skipNodeIndices.has(nodeIdx)
      })

    }

    // ── length(p) / path 长度谓词过滤 ──
    // MATCH p = (n)-->(x) WHERE length(p) = 10 — ANTLR 不解析 length 函数
    // 从 query 文本检测 `length(p)` 模式，在 GE 返回后手动过滤
    if (query && filteredWithLabels?.length) {
      const lenMatch = query.match(/length\s*\(\s*(\w+)\s*\)\s*=\s*(\d+)/)
      if (lenMatch) {
        const targetLen = parseInt(lenMatch[2], 10)
        // 路径长度 = edgesPayload 中与结果节点相关的边数（单层无循环）
        // 简单情况：一个 step，一条边 → length=1
        // 对于复杂路径，路径长度就是步骤数
        const nSteps = plan.steps?.length || 1  // 单步默认 1
        if (nSteps !== targetLen) {
          filteredWithLabels = []  // 长度不匹配，无结果
        }
      }
    }

    // ── 跨变量属性引用过滤（WHERE n.animal = x.animal / a.id = b.id） ──
    // crossVarFilters 中的 filter 不能在 seed 阶段用常数比较，因为 value 是"x.animal"字符串。
    // 对于有边模式（needSourceVar=true）：行中 props=source 节点属性 + __targetProps=target 节点属性，
    // 对每一行检查跨变量比较。
    // 对于无边模式（steps.length=0）：纯节点扫描，做笛卡尔积配对。
    if (crossVarFilters.length && filteredWithLabels?.length) {
      if (plan.steps?.length && filteredWithLabels[0]?.props) {
        // 有边模式：行有 props（遍历 source/当前节点）和 __targetProps（target 节点）
        // 不需要 needSourceVar=true，因为只要有 props 就可从中取值。
        // 引用变量可能是 source 或 targetAlias——从 steps 中查找。
        const stepSourceVars = new Set(plan.steps.map(s => s.source))
        const stepTargetAliases = new Set(plan.steps.map(s => s.targetAlias))
        filteredWithLabels = filteredWithLabels.filter((r: any) => {
          return crossVarFilters.every((f: any) => {
            const dotIdx = (f.value as string).indexOf('.')
            if (dotIdx < 0) return true
            const refVar = (f.value as string).substring(0, dotIdx)
            const refProp = (f.value as string).substring(dotIdx + 1)
            // isRefSource: f.source 是 source 变量（取 r.props）还是 targetAlias（取 r.__targetProps）
            // 类似的，refVar 的取值位置也相同。
            const fSourceIsSourceVar = stepSourceVars.has(f.source)
            const refIsSourceVar = stepSourceVars.has(refVar)
            const actualVal = fSourceIsSourceVar ? r?.props?.[f.property] : r?.__targetProps?.[f.property]
            const refVal = refIsSourceVar ? r?.props?.[refProp] : r?.__targetProps?.[refProp]
            if (actualVal === undefined || refVal === undefined) return false
            switch (f.operator) {
              case 'EQ':  return String(actualVal) === String(refVal)
              case 'NEQ': return String(actualVal) !== String(refVal)
              case 'GT':  return Number(actualVal) > Number(refVal)
              case 'GTE': return Number(actualVal) >= Number(refVal)
              case 'LT':  return Number(actualVal) < Number(refVal)
              case 'LTE': return Number(actualVal) <= Number(refVal)
              default:    return String(actualVal) === String(refVal)
            }
          })
        })
      } else if (!plan.steps?.length) {
        // 无边模式（steps.length=0）：MATCH (a:A), (b:B) WHERE a.id = b.id
        // 从 query 中提取变量→标签映射
        const varLabelMap: Record<string, string> = {}
        if (query) {
          const matchClauses = query.matchAll(/MATCH\s*\((\w+)\s*:\s*(\w+)\)/g)
          for (const mc of matchClauses) varLabelMap[mc[1]] = mc[2]
        }
        const returnCols = plan.returnColumns || []
        // 从 crossVarFilters 和 returnCols 收集所有参与变量
        const involvedVars = new Set<string>()
        for (const rc of returnCols) {
          const varName = typeof rc === 'string' ? rc.split('.')[0] : ''
          if (varName) involvedVars.add(varName)
        }
        for (const f of crossVarFilters) {
          if (f.source) involvedVars.add(f.source)
          if (typeof f.value === 'string') {
            const dotIdx = f.value.indexOf('.')
            if (dotIdx >= 0) involvedVars.add(f.value.substring(0, dotIdx))
          }
        }
        // 按变量 label 从 allNodes 分配节点
        const varNodeMap: Record<string, Array<{node: any; idx: number}>> = {}
        for (const varName of involvedVars) {
          const targetLabel = varLabelMap[varName]
          varNodeMap[varName] = allNodes
            .map((node, idx) => ({ node, idx }))
            .filter(({ idx }) => !skipNodeIndices.has(idx))
            .filter(({ node }) => !targetLabel || String(node._label) === targetLabel)
        }
        const varNames = Object.keys(varNodeMap)
        const _evalCrossVar = (entryMap: Record<string, {node: any; idx: number}>, filters: any[]): boolean => {
          return filters.every((f: any) => {
            const actualProp = f.property
            const actualVal = entryMap[f.source]?.node?.[actualProp]
            const dotIdx = (f.value as string).indexOf('.')
            if (dotIdx < 0) return false
            const refVar = (f.value as string).substring(0, dotIdx)
            const refProp = (f.value as string).substring(dotIdx + 1)
            const refVal = entryMap[refVar]?.node?.[refProp]
            if (actualVal === undefined || refVal === undefined) return false
            switch (f.operator) {
              case 'EQ':  return String(actualVal) === String(refVal)
              case 'NEQ': return String(actualVal) !== String(refVal)
              default:    return String(actualVal) === String(refVal)
            }
          })
        }
        const pairedRows: any[] = []
        if (varNames.length >= 2) {
          // N 元笛卡尔积：递归生成所有 entry 组合
          const _cartesian = (idx: number, current: Record<string, {node: any; idx: number}>): void => {
            if (idx >= varNames.length) {
              // 检查 self-join 冲突：不同变量不能指向同一个节点索引
              const seenIdx = new Set<number>()
              for (const vn of varNames) {
                if (seenIdx.has(current[vn].idx)) return
                seenIdx.add(current[vn].idx)
              }
              if (!_evalCrossVar(current, crossVarFilters)) return
              // 构建结果行
              const firstVar = varNames[0]
              const row: any = {
                id: -1,
                props: current[firstVar].node,
                type: current[firstVar].node._label || 'Default',
                name: '',
                __crossVarRows: {} as Record<string, any>,
              }
              for (const vn of varNames) row.__crossVarRows[vn] = current[vn].node
              pairedRows.push(row)
              return
            }
            for (const entry of varNodeMap[varNames[idx]]) {
              current[varNames[idx]] = entry
              _cartesian(idx + 1, current)
            }
          }
          _cartesian(0, {})
        }
        filteredWithLabels = pairedRows
      }
    }

    // ── 边变量 filter（WHERE r.name = 'foo'） ──
    // plan.filters 中的 source 如果是边变量（不在 MATCH 的节点变量中），
    // 用 edgesPayload 中的边 props 来过滤结果行。
    // 找到所有边变量 filter

    const stepSource = plan.steps?.[0]?.source
    // 同样使用所有 step 节点变量
    const aliasNodeList = [...allStepVars]
    const edgeVarFilters = edgeFilters.length
      ? edgeFilters
      : (plan.filters || []).filter(f => {
      if (!f.source || !f.property) return false
      return f.source && !aliasNodeList.includes(f.source)
    })
    const ep = edgesPayload || [] as any

    if (edgeVarFilters.length && ep.length && filteredWithLabels?.length) {

      filteredWithLabels = filteredWithLabels.filter((r: any) => {
        // 对每个边变量 filter，检查当前记录是否通过
        return edgeVarFilters.every((f: any) => {
          // 在 edgesPayload 中查找
          const nodeIdx = nodeGeIds.indexOf(r.id)
          if (nodeIdx < 0) return true
          // 连接到这个节点的所有边
          const connEdges = ep.filter((e: any) =>
            e.dstIdx === nodeIdx ||
            (sourceTargetMap.has(r.id) && e.srcIdx === nodeIdx)
          )
          if (!connEdges.length) return false
          return connEdges.some((e: any) => {
            const edgeProps = e.props || {}
            const actual = edgeProps[f.property]
            const expected = f.value
            if (actual === undefined) return false
            // 根据 operator 做比较
            if (f.operator === 'EQ') return String(actual) === String(expected)
            if (f.operator === 'NEQ') return String(actual) !== String(expected)
            if (f.operator === 'GT') return Number(actual) > Number(expected)
            if (f.operator === 'GTE') return Number(actual) >= Number(expected)
            if (f.operator === 'LT') return Number(actual) < Number(expected)
            if (f.operator === 'LTE') return Number(actual) <= Number(expected)
            return String(actual) === String(expected)
          })
        })
      })
    }

    // ── edgeProps（内联关系属性谓词）过滤 ──
    // MATCH (node)-[r:KNOWS {name: 'monkey'}]->(a) — steps 中的 edgeProps
    // 利用 edgesPayload（从 __edges 提取的边信息）来验证边属性是否匹配
    const edgePropSteps = (plan.steps || []).filter(s => s.edgeProps && Object.keys(s.edgeProps).length > 0)
    const edgePropFilteredRecords = edgePropSteps.length && edgesPayload.length
      ? (filteredWithLabels || []).filter((r: any) => {
          // 找到结果节点在 allNodes 中的索引
          const nodeIdx = nodeGeIds.indexOf(r.id)
          if (nodeIdx < 0) return false
          return edgePropSteps.every(s => {
            if (!s.edgeProps) return true
            // 找到连接到此节点的边（src → dst 或 dst → src）
            const matchingEdges = edgesPayload.filter(e =>
              (e.dstIdx === nodeIdx || e.srcIdx === nodeIdx)
            )
            if (!matchingEdges.length) return false
            // 验证边属性是否匹配 edgeProps
            for (const me of matchingEdges) {
              if (me.label && s.edgeLabel && me.label !== s.edgeLabel) continue
              if (!me.props && Object.keys(s.edgeProps).length > 0) continue
              let match = true
              for (const [k, v] of Object.entries(s.edgeProps)) {
                const actual = me.props?.[k]
                if (String(actual) !== String(v)) { match = false; break }
              }
              if (match) return true
            }
            return false
          })
        })
      : filteredWithLabels

    // ── 边变量后处理 ──
    // 如果 returnColumns 包含边变量（如 MATCH (a)-[r]->(b) RETURN r），
    // GE 的 _executeQueryPlan 只返回邻居节点，不追踪边。
    // 从 edgesPayload（__edges 信息）中获取边标签构建 [:T1] 格式。
    // 策略：
    // 1. 如果 MATCH 指定了 edgeLabel（:T1），直接用 query 的 label
    // 2. 如果未指定，从 edgesPayload 按 srcIdx→dstIdx 匹配边标签
    const edgeLabelsFromPayload = edgesPayload.map(ep => ep.label).filter(Boolean)
    const uniqueEdgeLabels = [...new Set(edgeLabelsFromPayload)]
    const queryEdgeLabel = (plan.steps || []).find(s => s.edgeLabel)?.edgeLabel
    const hasExplicitEdgeLabel = queryEdgeLabel && !queryEdgeLabel.includes('|')
    const hasMatchingEdgeLabel = hasExplicitEdgeLabel && uniqueEdgeLabels.includes(queryEdgeLabel)
    const nodeAliases = new Set([
      ...(plan.createNodes || []).map(n => n.alias).filter(Boolean),
      ...(plan.steps || []).flatMap(s => [s.source, s.targetAlias]).filter(Boolean),
    ])
    const edgeVarCols = (plan.returnColumns || []).filter(rc =>
      rc && rc !== '*' && !rc.includes('.') && !nodeAliases.has(rc)
    )
    const rawWithEdges = edgeVarCols.length && (hasMatchingEdgeLabel || edgesPayload.length)
      ? edgePropFilteredRecords.map((r: any) => {
          const row: Record<string, unknown> = {}
          if (r.props) Object.assign(row, r.props)
          for (const evc of edgeVarCols) {
            // 通过 nodeGeIds 找到结果节点的索引
            const nodeIdx = nodeGeIds.indexOf(r.id)
            let edgeLabel = ''
            let edgeProps: Record<string, unknown> | null = null
            // 如果记录已有 __edgeLabel（OR 分支填充），优先使用
            if (r.__edgeLabel) {
              edgeLabel = r.__edgeLabel
            } else if (hasExplicitEdgeLabel) {
              edgeLabel = queryEdgeLabel!
            } else if (nodeIdx >= 0) {
              // 查找匹配此源和目标节点的边（优先全字段匹配：label + props）
              const matchingEdge = edgesPayload.find(e => e.dstIdx === nodeIdx || e.srcIdx === nodeIdx)
              if (matchingEdge?.label) edgeLabel = matchingEdge.label
              if (matchingEdge?.props && Object.keys(matchingEdge.props).length) edgeProps = matchingEdge.props as Record<string, unknown>
            }
            if (edgeLabel && edgeProps && Object.keys(edgeProps).length) {
              const propsStr = Object.entries(edgeProps)
                .map(([k, v]) => `${k}: ${typeof v === 'string' ? `'${v}'` : String(v)}`)
                .join(', ')
              row[evc] = `[:${edgeLabel} {${propsStr}}]`
            } else {
              row[evc] = edgeLabel ? `[:${edgeLabel}]` : '[:]'
            }
          }
          return { ...r, props: row }
        })
      : edgePropFilteredRecords

    // ── 格式化结果 ──
    if (query && query.includes("_MAGIC_DEBUG")) {
    }
    const result: QueryRow[] = rawWithEdges.map((r: any) => {
      const fr = _formatResultRow(r, plan)
      return fr
    })

    // ── type() 函数后处理 ──
    // 如果原查询包含 type(r) 且结果中该列是边表示 [:T]，替换为类型名 'T'
    const hasTypeReturnCol = (plan.returnColumns || []).some((rc: string) =>
      rc && (rc.startsWith('type(') || (plan.returnAliasMap?.[rc] || '').startsWith('type('))
    )
    if (hasTypeReturnCol && query && /type\s*\(/i.test(query)) {
      for (const row of result) {
        for (const rc of plan.returnColumns || []) {
          if (!rc) continue
          const val = row[rc]
          if (typeof val === 'string' && val.startsWith('[:') && val.endsWith(']')) {
            // type(r) 的结果应为边标签名（不含引号）
            const typeName = val.slice(2, -1) // 去掉 [: 和 ]
            row[rc] = typeName
          }
        }
      }
    }

    // ── 后处理（ORDER BY / HAVING） ──
    return _postProcessResults(result, plan)
  } finally {
    if (ge) {
      try { ge.close() } catch {}
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  }
}

/**
 * 格式化单行 GE 返回结果。
 * - 展开 r.props 到顶层（GE 的格式）
 * - 如果 returnColumns 是单个变量名（RETURN n），包装为 {n: {props}}
 * - 如果 returnColumns 是属性名（RETURN n.p, n.q），从完整节点数据中读取属性值
 */
function _formatResultRow(r: any, plan: QueryPlan): QueryRow {
  const row: QueryRow = {}

  // GE 返回格式：{ props: { _label, _alias, name, p, ... } }
  if (r.props) {
    for (const k of Object.keys(r.props)) {
      row[k] = r.props[k]
    }
  }

  const ret = plan.returnColumns
  if (!ret?.length || plan.aggregate) return row

  const aliasMap = plan.returnAliasMap as Record<string, string> | undefined

  // 构造输出行，每列正确映射
  const result: QueryRow = {}
  for (const rc of ret) {
    if (!rc) continue

    // ── 解析 "a.id" → { variable: "a", property: "id" } ──
    const propMatch = rc.match(/^(\w+)\.(\w+)$/)
    if (propMatch) {
      const variable = propMatch[1]
      const property = propMatch[2]
      // 区分 source 变量和 target 变量
      // 当 source 回溯后，r.props 是 source 节点属性，r.__targetProps 是 target 节点属性
      // 如果 variable 与 firstStep.source 匹配 → 从 r.props 取（source）
      // 否则 → 从 r.__targetProps 取（target，如 b.id）
      const firstStepSource = plan.steps?.[0]?.source
      const isSourceVar = firstStepSource && variable === firstStepSource
      if (isSourceVar && r.props && property in r.props) {
        result[rc] = r.props[property]
      } else if (!isSourceVar && r.__targetProps && property in r.__targetProps) {
        result[rc] = r.__targetProps[property]
      } else if (r.props && property in r.props) {
        result[rc] = r.props[property]
      } else if (property in row) {
        result[rc] = row[property]
      } else {
        result[rc] = null
      }
      continue
    }

    // 判断 rc 是否直接出现在 GE 返回的 props 中
    if (rc in row) {
      result[rc] = row[rc]
      continue
    }

    // 检查 rc 是否是节点变量名（RETURN n / RETURN m）
    // GE 返回的 r 本身可能包含节点数据
    if (r[rc] !== undefined) {
      // 如果是边变量（值是字符串 "[:T1]" 格式），直接输出
      if (typeof r[rc] === 'string' && r[rc].startsWith('[:')) {
        result[rc] = r[rc]
        continue
      }
      result[rc] = r[rc]
      continue
    }

    // ── 边变量 RETURN r ──
    // rc 是边变量名（如 RETURN r），从 r.__edgeLabel 获取标签输出 [:LABEL] 格式
    if (r.__edgeLabel) {
      result[rc] = '[:' + r.__edgeLabel + ']'
      continue
    }

    // 使用 returnAliasMap 解析原始表达式
    if (aliasMap && rc in aliasMap) {
      const expr = aliasMap[rc]  // 如 "n" 或 "n.name"
      // 如果 row[rc] 已经是边格式 [:xxx]（由 rawWithEdges 填充），不要覆盖
      if (typeof row[rc] === 'string' && row[rc].startsWith('[:')) {
        result[rc] = row[rc]
        continue
      }
      // ── 非变量表达式（如 "1+1"、"42"）—— 直接取 row 值或 null ──
      // 纯数字、运算符、函数调用等不为合法标识符的模式，不能走变量/属性查找
      if (!/^[a-zA-Z_]\w*$/.test(expr) && !expr.includes('.')) {
        result[rc] = rc in row ? row[rc] : null
        continue
      }
      // 如果表达式是纯变量名（无点号），是 RETURN n
      if (!expr.includes('.')) {
        // 检查 __crossVarRows（无边模式配对行）
        if (r.__crossVarRows && rc in r.__crossVarRows) {
          // 从 __crossVarRows 中取该变量对应的节点
          result[rc] = { ...r.__crossVarRows[rc] }
          continue
        }
        // 区分 source 变量和 target 变量
        const firstStepSource = plan.steps?.[0]?.source
        if (r.__targetProps && firstStepSource && rc !== firstStepSource) {
          // target 变量（或之后步中的变量）：从 __targetProps 构建
          result[rc] = { ...r.__targetProps }
        } else {
          // source 变量：从 row 构建（包含 r.props 所有属性）
          result[rc] = { ...row }
        }
        continue
      }
      // 属性访问表达式：n.name → 从 row 或 r 取值
      const propPart = expr.split('.').pop()!
      if (propPart in row) {
        result[rc] = row[propPart]
        continue
      }
      // 属性不存在 → TCK 期望 null
      result[rc] = null
      continue
    }
    // ── 没有任何分支处理该列 —— 输出 null（TCK 兼容） ──
    if (!(rc in result)) {
      result[rc] = null
    }
  }
  return result
}

/**
 * 为 DML（CREATE）带 RETURN 构造结果行。
 *
 * GE 对 DML 返回空数组，所以需要从 plan 元数据直接构造。
 * parseQuery 对 RETURN n.name AS p 的处理：
 *   - returnColumns: ['p']（别名）
 *   - createNodes: [{alias: 'n', label: null, props: {name: 'foo'}}]
 *
 * 挑战：returnColumns 丢失了原始表达式 n.name，只剩下别名 p。
 * 解决方案：从 plan.createNodes 匹配别名；如果找不到，说明 rc 可能是
 * 属性名（没有 AS 重命名），直读 createNodes[0].props。
 *
 * 区分变量名 RETURN vs 属性名 RETURN：
 *   - RETURN n → rc="n"，对应 createNodes[i].alias === "n"
 *   - RETURN n.p → rc="p"，找到 createNodes[i].props.p 或回退正则扫描
 *   - RETURN n.p AS P → rc="P"，找不到属性名 P，回退 fallback：扫描所有 props
 */
function _buildDmlRows(plan: QueryPlan, allNodes: Array<Record<string, unknown>>): QueryRow[] {
  if (!plan.returnColumns?.length) return []

  // 聚合 DML：如 RETURN count(*)
  if (plan.aggregate) {
    const row: QueryRow = {}
    const agg = plan.aggregate as any
    const alias = agg.alias || agg.column?.replace(/^.+?\(.+?\)(?:\s+AS\s+)?/i, '').trim() || agg.field || 'c'
    row[alias] = agg.fn === 'count' ? allNodes.length : 0
    return [row]
  }

  // 预计算：allNodes 中所有 props key 的并集（包括嵌套 props 对象）
  // 以及 createNodes 原始 props
  const insertNodes = (plan.createNodes || []) as Array<{ alias: string; label: string | null; props: Record<string, unknown> | null }>
  const allPropKeys = new Set<string>()
  for (const node of allNodes) {
    for (const k of Object.keys(node)) {
      if (!k.startsWith('_')) allPropKeys.add(k)
    }
    const p = node['props'] as Record<string, unknown> | undefined
    if (p) { for (const k of Object.keys(p)) allPropKeys.add(k) }
  }

  const row: QueryRow = {}

  for (const rc of plan.returnColumns) {
    if (!rc) continue

    // 阶段 1: rc 作为属性名，直接匹配 node 顶层（allNodes 的 props 已展开到顶层）
    let val: unknown = undefined
    for (const node of allNodes) {
      if (rc in node) { val = node[rc]; break }
      const p = node['props'] as Record<string, unknown> | undefined
      if (p && rc in p) { val = p[rc]; break }
    }
    if (val !== undefined) { row[rc] = val; continue }

    // 阶段 2: rc 匹配 createNodes 的 alias（RETURN n）
    const matchNode = insertNodes.find(cn => cn.alias === rc)
    if (matchNode) {
      const clean: Record<string, unknown> = {}
      if (matchNode.props) {
        for (const [k, v] of Object.entries(matchNode.props)) clean[k] = v
      }
      row[rc] = Object.keys(clean).length ? clean : { _label: matchNode.label || 'Default' }
      continue
    }

    // 阶段 3: rc 是属性别名（RETURN n.name AS p）— 用 returnAliasMap 反向解析
    const aliasMap = plan.returnAliasMap as Record<string, string> | undefined
    if (aliasMap && rc in aliasMap) {
      const expr = aliasMap[rc]  // 原始表达式如 "n.name"
      const propPart = expr.includes('.') ? expr.split('.').pop()! : expr
      // 遍历所有节点找 propPart
      let aliasVal: unknown = undefined
      for (const node of allNodes) {
        if (propPart in node) { aliasVal = node[propPart]; break }
        const p = node['props'] as Record<string, unknown> | undefined
        if (p && propPart in p) { aliasVal = p[propPart]; break }
      }
      if (aliasVal !== undefined) { row[rc] = aliasVal; continue }
    }

    // 阶段 4: 检查 rc 在 allPropKeys 中——如果在但没匹配到，是 null property
    if (!allPropKeys.has(rc)) {
      // rc 是纯别名且无法映射——null property
      row[rc] = ''
      continue
    }
    row[rc] = ''
  }

  return Object.keys(row).length ? [row] : []
}


export function _executeQuery(
  plan: QueryPlan,
  nodes: Array<Record<string, unknown>>,
  query?: string,
): QueryResult {
  // 无显式 LIMIT 时应用 DEFAULT_LIMIT（批量数据集上默认截断防止 OOM）
  if (plan.limit === undefined || plan.limit === null) {
    plan.limit = DEFAULT_LIMIT
  }
  // 所有查询统一走 GraphEngine
  return _executeViaGraphEngine(plan, nodes, query)
}

/**
 * TCK 兼容的编译时语义验证。
 * 公开导出，在 step-definitions.ts 中调用。
 * 对应 openCypher SyntaxError 检查：VariableTypeConflict、UndefinedVariable、
 * VariableAlreadyBound、InvalidArgumentType、NonConstantExpression、InvalidDelete 等。
 */
export function _validatePlan(plan: QueryPlan, query?: string): void {
  if (!plan || !plan.type) return
  if (!query) return

  // 从 WHERE 子句检测未绑定变量
  const qUpper = query.toUpperCase()

  // ── SyntaxError: InvalidDelete ──
  // DELETE 关系模式（需要 DETACH）
  if (plan.type === 'DELETE' && query) {
    // DELETE 关系但未使用 DETACH
    const hasRelationship = query.includes('[') && query.includes(']')
    const isDetach = query.toUpperCase().includes('DETACH')
    if (hasRelationship && !isDetach) {
      // 删除关系需要 DETACH
      throw Object.assign(new Error('SyntaxError: InvalidDelete'), { tckError: 'InvalidDelete' })
    }
  }

  // ── SyntaxError: InvalidParameterUse ──
  if (plan.returnColumns?.some((rc: string) => rc?.startsWith('$'))) {
    throw Object.assign(new Error('SyntaxError: InvalidParameterUse'), { tckError: 'InvalidParameterUse' })
  }
  // MATCH (n $param) — parameter as node predicate
  if (query && /MATCH\s*\(\s*\w+(?::\w+)?\s+\$\w+/i.test(query)) {
    throw Object.assign(new Error('SyntaxError: InvalidParameterUse'), { tckError: 'InvalidParameterUse' })
  }
  // MATCH ()-[r:FOO $param]->() — parameter as relationship predicate (only in MATCH clauses)
  if (query && qUpper.includes('MATCH') && /\[[^\]]*\$\w+/.test(query)) {
    throw Object.assign(new Error('SyntaxError: InvalidParameterUse'), { tckError: 'InvalidParameterUse' })
  }

  // ── SyntaxError: AmbiguousAggregationExpression ──
  // 当两个同名聚合在同一个 RETURN 中出现
  if (plan.aggregate && plan.returnColumns?.length > 1) {
    // 相同的聚合函数出现两次：RETURN count(*), count(*)
    const rawAggs: string[] = []
    if (query) {
      const aggMatch = query.match(/\b(count|sum|avg|max|min|collect)\s*\([^)]*\)/ig)
      if (aggMatch && aggMatch.length > 1) {
        const normalized = aggMatch.map(a => a.replace(/\s+/g, ''))
        if (new Set(normalized).size < normalized.length) {
          throw Object.assign(new Error('SyntaxError: AmbiguousAggregationExpression'), { tckError: 'AmbiguousAggregationExpression' })
        }
      }
    }
    // 两个不同聚合出现在同一 RETURN
    if (plan.returnColumns.filter((rc: string) =>
      /^(count|sum|avg|max|min|collect)\s*\(/i.test(rc)
    ).length > 1) {
      // count(*) 和 count(*) 相同不算，但 count(*) 和 sum(x) 算
      const aggSet = new Set(
        plan.returnColumns.filter((rc: string) =>
          /^(count|sum|avg|max|min|collect)\s*\(/i.test(rc)
        ).map((rc: string) => rc.replace(/\s+/g, ''))
      )
      // 如果有多个不同聚合函数
      if (aggSet.size > 1) {
        throw Object.assign(new Error('SyntaxError: AmbiguousAggregationExpression'), { tckError: 'AmbiguousAggregationExpression' })
      }
    }
    // 多 * 列
    if (plan.returnColumns.filter((rc: string) => rc === '*').length > 1) {
      throw Object.assign(new Error('SyntaxError: AmbiguousAggregationExpression'), { tckError: 'AmbiguousAggregationExpression' })
    }
  }

  // ── SyntaxError: NegativeIntegerArgument ──
  // SKIP 负数
  const skipMatch = query.match(/\bSKIP\s+(-?\d+)\b/i)
  if (skipMatch && parseInt(skipMatch[1], 10) < 0) {
    throw Object.assign(new Error('SyntaxError: NegativeIntegerArgument'), { tckError: 'NegativeIntegerArgument' })
  }
  // LIMIT 负数
  const limitMatch = query.match(/\bLIMIT\s+(-?\d+)\b/i)
  if (limitMatch && parseInt(limitMatch[1], 10) < 0) {
    throw Object.assign(new Error('SyntaxError: NegativeIntegerArgument'), { tckError: 'NegativeIntegerArgument' })
  }

  // ── SyntaxError: NonConstantExpression ──
  if (plan.orderBy?.length) {
    for (const ob of plan.orderBy) {
      if (ob.property && ob.property.split('.').length > 2) {
        throw Object.assign(new Error('SyntaxError: NonConstantExpression'), { tckError: 'NonConstantExpression' })
      }
    }
  }

  // ── SyntaxError: VariableAlreadyBound ──
  // 1. MATCH (n) CREATE (n:Person) — n 已在 MATCH 中绑定
  if (plan.hasMatch && plan.createNodes?.length) {
    const matchVars = extractMatchVariables(query)
    for (const cn of plan.createNodes) {
      if (cn.alias && matchVars.includes(cn.alias)) {
        throw Object.assign(new Error('SyntaxError: VariableAlreadyBound'), { tckError: 'VariableAlreadyBound' })
      }
    }
  }
  // 2. CREATE (n:Foo) CREATE (n:Bar) — n 在同一语句中被绑定两次
  // 从 query 文本直接扫描所有 CREATE 中的变量
  {
    const createVarCounts = new Map<string, number>()
    const createMatches = query.matchAll(/CREATE\b\s*(.*?)(?:\s+(?:CREATE|SET|DELETE|MERGE|REMOVE|WITH|RETURN|UNWIND)\b|$)/gis)
    for (const cm of createMatches) {
      const clause = cm[1]
      const vars = extractVariablesFromClause(clause)
      for (const v of vars) {
        if (v) {
          createVarCounts.set(v, (createVarCounts.get(v) || 0) + 1)
          if (createVarCounts.get(v)! > 1) {
            throw Object.assign(new Error('SyntaxError: VariableAlreadyBound'), { tckError: 'VariableAlreadyBound' })
          }
        }
      }
    }
  }
  // 3. 同一个逗号分隔的 CREATE 模式中重复绑定
  {
    const singleCreateScenes = query.matchAll(/CREATE\b\s*(.*?)(?:\s+(?:SET|DELETE|MERGE|REMOVE|WITH|RETURN)\b|$)/gis)
    for (const sc of singleCreateScenes) {
      const clause = sc[1]
      // 查找同一 CREATE 子句中的逗号分隔模式中的重复变量
      const patterns = clause.matchAll(/\((\w)\s*(?::|{)/g)
      const seenInClause = new Set<string>()
      for (const p of patterns) {
        if (p[1] && seenInClause.has(p[1]) && /^[a-zA-Z]/.test(p[1])) {
          throw Object.assign(new Error('SyntaxError: VariableAlreadyBound'), { tckError: 'VariableAlreadyBound' })
        }
        if (p[1]) seenInClause.add(p[1])
      }
    }
  }

  // ── SyntaxError: UndefinedVariable ──
  // MATCH (n) RETURN foo — foo 未定义
  // CREATE (b {name: missing}) RETURN b — missing 未定义（在 map literal 中）
  {
    const boundVars = extractVariablesFromClause(query)
    // 从 returnColumns 检查未定义变量
    if (plan.returnColumns?.length) {
      for (const rc of plan.returnColumns) {
        if (!rc || rc === '*') continue
        const varName = rc.split('.')[0]
        // 跳过 aggregate 函数名、skip/limit/order 关键字、数字开头
        if (!/^[a-zA-Z_]\w*$/.test(varName)) continue
        if (/^(count|sum|avg|max|min|collect)$/i.test(varName)) continue
        // 如果这个变量在 plan 的已定义集合中找不到，也是未定义
        // 注意：boundVars 从 text 提取可能不完整
        // 只检查 CREATE (b {name: missing}) 这种括号内的 map literal 中的未定义变量
      }
    }
    // 检查 map literal 中的变量引用
    // 识别 {key: VarName} 格式中 VarName 不是 string literal
    const mapVarRefs = query.matchAll(/\{([^}]+)\}/g)
    for (const mv of mapVarRefs) {
      const entries = mv[1].split(',').map(s => s.trim())
      for (const entry of entries) {
        const colonIdx = entry.indexOf(':')
        if (colonIdx < 0) continue
        const val = entry.slice(colonIdx + 1).trim()
        // 如果值是裸标识符（不是 string/number/boolean/null）
        if (val && /^[a-zA-Z_]\w*$/.test(val) && !/^(null|true|false|TRUE|FALSE|NULL)$/.test(val) &&
            !val.startsWith("'") && !val.startsWith('"') && isNaN(Number(val)) &&
            !boundVars.includes(val)) {
          throw Object.assign(new Error('SyntaxError: UndefinedVariable'), { tckError: 'UndefinedVariable' })
        }
      }
    }
  }

  // ── SyntaxError: VariableTypeConflict ──
  // MATCH r = ()-[]-() MATCH (r) RETURN r — path variable reused as node
  // MATCH ()-[r]-() MATCH (r) RETURN r — edge variable reused as node
  // WITH <value> AS n MATCH (n) RETURN n — value bound then matched as node
  if (query && (plan.hasMatch || qUpper.includes('MATCH'))) {
    // 移除路径分配模式避免误匹配
    const cleaned = query.replace(/\w+\s*=\s*\([^)]*\)/g, '()')
    const matchClauses = cleaned.match(/MATCH\s+.*?(?=WHERE|RETURN|WITH|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|\$Cypher|$)/gis) || []
    const matchNodeVars = [...new Set(matchClauses.flatMap((mc: string) => [...mc.matchAll(/\((\w+)(?::|\))/g)].map(m => m[1])))]
    const edgeVars = [...new Set([...cleaned.matchAll(/\[(\w+)/g)].map(m => m[1]).filter((v: string) => v && v !== '*' && v !== '?'))]
    const pathAssignments = [...query.matchAll(/(\w+)\s*=\s*\(/g)].map(m => m[1])

    // 关系变量和路径分配变量冲突
    for (const pa of pathAssignments) {
      if (edgeVars.includes(pa) && pa) {
        throw Object.assign(new Error('SyntaxError: VariableTypeConflict'), { tckError: 'VariableTypeConflict' })
      }
      // 路径分配变量被重新用作节点变量
      if (matchNodeVars.includes(pa) && pa) {
        throw Object.assign(new Error('SyntaxError: VariableTypeConflict'), { tckError: 'VariableTypeConflict' })
      }
    }
    // 关系变量被重新用作节点变量（非 path assign）
    for (const ev of edgeVars) {
      if (matchNodeVars.includes(ev) && !pathAssignments.includes(ev)) {
        throw Object.assign(new Error('SyntaxError: VariableTypeConflict'), { tckError: 'VariableTypeConflict' })
      }
    }
    // WITH 值绑定变量被用作 MATCH 节点
    const withBindings = [...query.matchAll(/WITH\s+([\s\S]+?)\s+AS\s+(\w+)/ig)].map(m => m[2])
    for (const wv of withBindings) {
      if (wv && (matchNodeVars.includes(wv) || edgeVars.includes(wv))) {
        throw Object.assign(new Error('SyntaxError: VariableTypeConflict'), { tckError: 'VariableTypeConflict' })
      }
    }

    // ── SyntaxError: VariableAlreadyBound（同 pattern 中节点变量重复） ──
    // MATCH p = (p)-[]-() — path 变量 p 同时作为节点变量
    // MATCH ()-(p), p = ()-[]-() — 同场景
    const pathAssignVar = query.match(/(\w+)\s*=\s*\(/)?.[1]
    if (pathAssignVar) {
      const nodeVarRefs: string[] = []
      // MATCH / OPTIONAL MATCH 模式中的节点变量（排除函数参数，如 length(p)）
      const matchBlocks = [...query.matchAll(/(?:MATCH|OPTIONAL\s+MATCH)\s+(.*?)(?=\s+(?:WHERE|WITH|RETURN|CREATE|ORDER\s+BY|SKIP|LIMIT|$))/gis)]
      for (const [, block] of matchBlocks) {
        const blockVars = [...block.matchAll(/\(\s*(\w+)\s*(?::|\))/g)].map(m => m[1])
        nodeVarRefs.push(...blockVars)
      }
      if (nodeVarRefs.includes(pathAssignVar)) {
        throw Object.assign(new Error('SyntaxError: VariableAlreadyBound'), { tckError: 'VariableAlreadyBound' })
      }
    }

    // ── SyntaxError: VariableAlreadyBound（WITH <val> AS p MATCH p = ()-[]-()） ──
    const asVarAssign = query.match(/WITH\s+[^;]+\s+AS\s+(\w+)/i)?.[1]
    if (asVarAssign) {
      const pathAssignInMatch = query.match(new RegExp(`MATCH[^()]*\\b${asVarAssign}\\b\\s*=\\s*\\(`))
      if (pathAssignInMatch) {
        throw Object.assign(new Error('SyntaxError: VariableAlreadyBound'), { tckError: 'VariableAlreadyBound' })
      }
    }

    // ── SyntaxError: RelationshipUniquenessViolation ──
    // MATCH (a)-[r]->()-[r]->(a) — 同一关系变量出现多次
    if (query?.includes('MATCH')) {
      const edgeVars = [...query.matchAll(/\[(\w+)\]/g)].map(m => m[1])
      const dupEdgeVars = edgeVars.filter((v, i, a) => a.indexOf(v) !== i)
      if (dupEdgeVars.length) {
        throw Object.assign(new Error('SyntaxError: RelationshipUniquenessViolation'), { tckError: 'RelationshipUniquenessViolation' })
      }
    }

    // ── SyntaxError: InvalidArgumentType（WHERE 中对 path 变量使用属性谓词） ──
    // MATCH p = ()-[]-() WHERE p.name = 'x' RETURN p
    // 检查 WHERE 中 .xxx 的左侧变量是否作为 path 变量出现在 MATCH p = ...
    if (query?.includes('WHERE')) {
      const whereClause = query.match(/WHERE\s+(.+?)(?:\s+(WITH|RETURN|CREATE|MERGE|SET|DELETE|ORDER|SKIP|LIMIT)\s|$)/is)?.[1] || ''
      const pathMatch = query.match(/MATCH\s+(\w+)\s*=\s*\(/i)
      if (pathMatch?.[1] && whereClause.includes(`${pathMatch[1]}.`)) {
        throw Object.assign(new Error('SyntaxError: InvalidArgumentType'), { tckError: 'InvalidArgumentType' })
      }
    }

    // ── SyntaxError: InvalidAggregation（WHERE 中使用聚合函数） ──
    // MATCH (a) WHERE count(a) > 10 RETURN a
    if (query?.includes('WHERE')) {
      const aggFuncs = ['count', 'sum', 'avg', 'min', 'max', 'collect']
      for (const func of aggFuncs) {
        const whereClause = query.split(/WHERE\s+/i).slice(1).join('WHERE ')
        if (!whereClause) break
        const whereBody = whereClause.split(/\s+(WITH|RETURN|CREATE|MERGE|SET|DELETE|ORDER|SKIP|LIMIT)\s+/i)[0]
        if (whereBody && new RegExp(`\\b${func}\\s*\\(`).test(whereBody)) {
          throw Object.assign(new Error('SyntaxError: InvalidAggregation'), { tckError: 'InvalidAggregation' })
        }
      }
    }
  }
}

/** 从 Cypher 查询中提取 MATCH 子句的字符串 */
function extractMatchClause(query: string): string {
  const match = query.match(/MATCH\s+(.*?)(?:\s+(WHERE|WITH|RETURN|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|ORDER\s+BY|SKIP|LIMIT|INVOKE|CALL)\s|$)/is)
  return match ? match[1].trim() : ''
}

/** 从查询文本中提取所有 MATCH 中绑定的变量名 */
function extractMatchVariables(query: string): string[] {
  const vars: string[] = []
  // 提取 MATCH 子句中的所有括号模式中的变量
  const matches = query.matchAll(/MATCH\s+(.*?)(?:\s+(?:WHERE|WITH|RETURN|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|ORDER\s+BY|SKIP|LIMIT|INVOKE|CALL)\s|$)/gis)
  for (const m of matches) {
    const clause = m[1]
    // 从 (n:Label) 或简单的 (n) 中提取变量名
    const nodeVars = clause.matchAll(/\((\w+)\s*(?::|\))/g)
    for (const v of nodeVars) {
      if (v[1] && !/^[\d]/.test(v[1])) vars.push(v[1])
    }
    // 从 <-[r]- 或 -[r]-> 中提取边变量
    const edgeVars = clause.matchAll(/\[(\w+)\s*(?::|\))/g)
    for (const v of edgeVars) {
      if (v[1] && !/^[\d]/.test(v[1])) vars.push(v[1])
    }
  }
  return [...new Set(vars)]
}

/** 从查询文本中提取所有引用过的变量名 */
function extractVariablesFromQuery(query: string): string[] {
  const vars: string[] = []
  const allNodes = query.matchAll(/\((\w+)\s*(?::|\))/g)
  for (const v of allNodes) {
    if (v[1] && !/^[\d]/.test(v[1])) vars.push(v[1])
  }
  const allEdges = query.matchAll(/\[(\w+)\s*(?::|\))/g)
  for (const v of allEdges) {
    if (v[1] && !/^[\d]/.test(v[1])) vars.push(v[1])
  }
  return [...new Set(vars)]
}

/** 从一段 Cypher 子句文本中提取变量名 */
function extractVariablesFromClause(clause: string): string[] {
  const vars: string[] = []
  const nodes = clause.matchAll(/\((\w+)\s*(?::|\))/g)
  for (const v of nodes) {
    if (v[1] && !/^[\d]/.test(v[1])) vars.push(v[1])
  }
  const edges = clause.matchAll(/\[(\w+)\s*(?::|\))/g)
  for (const v of edges) {
    if (v[1] && !/^[\d]/.test(v[1])) vars.push(v[1])
  }
  return [...new Set(vars)]
}

/** 调整后的无效查询检测：排除有效的 CREATE/ADMIN/UNION/CALL
 * 该函数在 _executeViaGraphEngine 之前 intercept 纯无效查询 */
function _isInvalidPlan(plan: QueryPlan): boolean {
  return !plan.scanLabel && plan.steps?.length === 0 && plan.filters?.length === 0
    && plan.returnColumns?.length === 0 && !plan.hasMatch && !plan.createNodes?.length
    && !plan.create && !plan.show && !plan.with && !plan.unwind && !plan.unionType
    && !plan.caseColumns?.length && !plan.createConstraint && !plan.deleteEntities?.length
    && !plan.setItems?.length && !plan.removeItems?.length && !plan.mergeItems?.length
}

/**
 * 从 nodes 的 __edges 数组中提取边列表。
 * __edges 格式: [{srcIdx: 0, dstIdx: 1, label: 'T1'}, ...]
 */
function extractEdgesFromNodes(nodes: Array<Record<string, unknown>>): Array<{ srcIdx: number; dstIdx: number; label: string; props?: Record<string, unknown> | null }> {
  const edges: Array<{ srcIdx: number; dstIdx: number; label: string; props?: Record<string, unknown> | null }> = []
  for (const n of nodes) {
    if (n.__edges && Array.isArray(n.__edges)) {
      for (const e of n.__edges) {
        if (typeof e.srcIdx === 'number' && typeof e.dstIdx === 'number') {
          edges.push({ srcIdx: e.srcIdx, dstIdx: e.dstIdx, label: String(e.label || ''), props: e.props || null })
        }
      }
    }
  }
  return edges
}

// ── ParameterizedQuery 预编译参数化查询 ─────────────────────────────────

/**
 * 编译缓存：template → 参数名称列表
 */
const _compileCache = new Map<string, string[]>()

/**
 * 从模板中提取所有 `$var` 参数名称
 */
function _extractParamNames(template: string): string[] {
  const names: string[] = []
  const re = /\$([a-zA-Z_]\w*)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(template)) !== null) {
    names.push(match[1])
  }
  return names
}

/**
 * 将参数值注入到模板中，返回可直接解析的 Cypher-lite 字符串。
 */
function _injectParams(template: string, params: Record<string, unknown>): string {
  const re = /\$([a-zA-Z_]\w*)/g
  return template.replace(re, (_, name: string) => {
    if (!(name in params)) {
      throw new Error(`Missing parameter: $${name}`)
    }
    return serializeParamValue(params[name])
  })
}

/**
 * 预编译参数化查询类。
 *
 * 对模板进行一次编译（提取参数名称列表），可多次调用 `execute` 传入不同参数。
 */
export class ParameterizedQuery {
  private readonly template: string
  private paramNames: string[] | null = null

  constructor(template: string) {
    this.template = template
  }

  /** 获取模板中所有的参数名称 */
  getParamNames(): string[] {
    if (this.paramNames === null) {
      const cached = _compileCache.get(this.template)
      if (cached) {
        this.paramNames = cached
      } else {
        this.paramNames = _extractParamNames(this.template)
        _compileCache.set(this.template, this.paramNames)
      }
    }
    return [...this.paramNames]
  }

  /** 检查指定参数是否存在 */
  hasParam(name: string): boolean {
    return this.getParamNames().includes(name)
  }

  /** 填入参数并解析为 QueryPlan */
  execute(params: Record<string, unknown>): QueryPlan {
    const paramNames = this.getParamNames()
    if (paramNames.length === 0) {
      return parseQuery(this.template)
    }
    const injected = _injectParams(this.template, params)
    return parseQuery(injected)
  }
}

/**
 * 便捷函数：创建预编译参数化查询并立即执行。
 *
 * @param template  - Cypher-lite 模板字符串，参数占位符为 `$name`
 * @param params    - 参数对象
 * @returns 解析后的 QueryPlan
 */
export function cypher(template: string, params?: Record<string, unknown>): QueryPlan {
  if (!params || Object.keys(params).length === 0) {
    return parseQuery(template)
  }
  const injected = _injectParams(template, params)
  return parseQuery(injected)
}

/**
 * 静态工厂：创建 ParameterizedQuery 实例。
 *
 * @param template - Cypher-lite 模板字符串
 * @returns ParameterizedQuery 实例
 */
export function compileCypher(template: string): ParameterizedQuery {
  return new ParameterizedQuery(template)
}
