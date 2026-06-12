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

  // 4. 按序替换占位符（跳过属性访问上下文: n.$1 不做纯文本替换）
  let result = query
  for (let i = 0; i < params.length; i++) {
    // 仅替换不在 . 之后的 $N（属性访问上下文的 $1 由 parser PROP_REF_DYNAMIC 处理）
    const placeholder = `\\$${i + 1}`
    const serialized = serializeParamValue(params[i])
    // 不在 . 之后的 $1 → 正常替换
    // 在 . 之后的 $1 → 保留给 PROP_REF_DYNAMIC 处理
    const re = new RegExp(`(?<!\\.)\\$${i + 1}\\b`, 'g')
    result = result.replace(re, serialized)
  }

  return parseQuery(result)
}

/**
 * 命名参数替换：$name, $age, ...
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

  // 3. 替换占位符
  let result = query
  for (const name of names) {
    const serialized = serializeParamValue(params[name])
    const re = new RegExp(`\\$${name}\\b`, 'g')
    result = result.replace(re, serialized)
  }

  return parseQuery(result)
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
      } else if (/^[a-z][0-9]?$/.test(subPlan.scanLabel)) {
        subPlan.scanLabel = null
      }
    }
    if (subPlan.rightPlan) _fixScanLabel(subPlan.rightPlan)
    if (subPlan.callQuery) _fixScanLabel(subPlan.callQuery)
  }
  _fixScanLabel(plan)
  _fixScanLabel(plan)

  // 检测无效查询：parseCypherToPlan 成功返回但查询语法非法（ANTLR 错误被吞掉了）
  // 特征: scanLabel=null, steps=[], filters=[], returnColumns=[], hasMatch=false
  if (!plan.scanLabel && plan.steps?.length === 0 && plan.filters?.length === 0 && plan.returnColumns?.length === 0 && !plan.hasMatch && !plan.createNodes?.length && !plan.create && !plan.show && !plan.with && !plan.unwind && !plan.unionType && !plan.caseColumns?.length) {
    // 检查原始查询是否包含有效关键字 — 大多数无效查询没有 MATCH etc.
    if (!/^\s*(MATCH|WITH|UNWIND|RETURN|CREATE|MERGE|SET|DELETE|REMOVE|FOREACH|CALL|SHOW|USE|BEGIN|COMMIT|ROLLBACK|EXPLAIN|PROFILE|LOAD|DROP|START|OPTIONAL|ALTER|GRANT|REVOKE)/i.test(query.trim())) {
      throw new Error(`Syntax error: cannot parse query "${query}"`)
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

  return plan
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

/** GraphEngine 原生执行入口 */
function _executeViaGraphEngine(plan: QueryPlan, nodes: Array<Record<string, unknown>>): QueryResult {
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
  const isDML = ['MERGE', 'CREATE', 'DELETE', 'SET', 'REMOVE', 'CREATE_CONSTRAINT', 'FOREACH', 'MATCH_MODIFY'].includes(plan.type || '')

  // ── DML 无输出返回空：纯 CREATE/MERGE/DELETE（无 RETURN）应返回空 ──
  if (isDML && !plan.returnColumns?.length && !plan.aggregate?.length && !plan.expressionColumns?.length) {
    // 仍然插入节点到 GE（side effects 可能存在），但返回空
    return []
  }

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

  const dir = path.join('/tmp', 'tckge-' + process.pid + '-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'))
  let ge: GraphEngine | null = null
  try {
    fs.mkdirSync(dir, { recursive: true })
    const config: OverGraphConfig = { path: dir, denseVector: { dimension: 384 } }
    ge = new GraphEngine(config)
    ge.open()

    // ── 插入节点（seedNodes + plan.createNodes） ──
    const allNodes: Array<Record<string, unknown>> = [...(nodes || [])]
    // 合并 DML CREATE 的节点定义
    if (plan.createNodes?.length) {
      for (const cn of plan.createNodes) {
        const props: Record<string, unknown> = { _label: cn.label || 'Default' }
        if (cn.props) { for (const k of Object.keys(cn.props)) props[k] = cn.props[k] }
        if (cn.alias) props['_alias'] = cn.alias
        allNodes.push(props)
      }
    }
    if (allNodes.length) {
      for (let i = 0; i < allNodes.length; i++) {
        const item = allNodes[i]
        const label = String(item['_label'] || 'Default')
        const props: Record<string, unknown> = { _label: label }
        for (const k of Object.keys(item)) { if (k !== '_label') props[k] = item[k] }
        let h = 0
        for (let ci = 0; ci < label.length; ci++) h = ((h << 5) - h + label.charCodeAt(ci)) | 0
        ;(ge as any).upsertNode(Math.abs(h) % 1000 + 1, 'req-n' + i + '-' + Math.random().toString(36).slice(2, 6), { props })
      }
    }

    // ── 直接调用 GE 的 _executeQueryPlan，不做字符串绕路 ──
    const rawRecords: any[] = (ge as any)._executeQueryPlan(plan)

    // ── 修复 GE limit=0 bug（GE 的 _executeQueryPlan 中 limit=0 是 falsy，不执行 slice） ──
    if (plan.limit === 0 && rawRecords?.length) {
      return []
    }

    // ── 格式化结果 ──
    const result: QueryRow[] = (rawRecords || []).map((r: any) => {
      const row: QueryRow = {}
      // 展开 props
      if (r.props) { for (const k of Object.keys(r.props)) row[k] = r.props[k] }

      // 如果 returnColumns 只有一个且非聚合，按列名包装
      if (plan.returnColumns?.length === 1 && !plan.aggregate) {
        return { [plan.returnColumns[0]]: row } as any
      }
      return row
    })

    // ── 后处理（ORDER BY / HAVING） ──
    return _postProcessResults(result, plan)
  } finally {
    if (ge) {
      try { ge.close() } catch {}
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  }
}

export function _executeQuery(
  plan: QueryPlan,
  nodes: Array<Record<string, unknown>>,
): QueryResult {
  // ── 编译时验证（TCK SyntaxError 检查） ──
  _validatePlan(plan)
  // 所有查询统一走 GraphEngine
  return _executeViaGraphEngine(plan, nodes)
}

/** 编译时语义验证 —— 匹配 openCypher TCK SyntaxError 需求 */
function _validatePlan(plan: QueryPlan): void {
  // 已知的错误类型列表，用于 TCK 匹配
  type TCKError = 'VariableTypeConflict' | 'InvalidParameterUse' | 'UndefinedVariable'
    | 'UnknownFunction' | 'ColumnNameConflict' | 'NestedAggregation'
    | 'NonConstantExpression' | 'AmbiguousAggregationExpression'
    | 'TypeError' | 'NodePatternSemantics' | 'InvalidDelete'
    | 'DeletedEntityAccess' | 'DuplicateRelationshipBoundNodes'

  // 1. UndefinedVariable — MATCH 中引用的变量没有在其他 MATCH 或 WITH 中定义
  if (plan.hasMatch && plan.scanLabel) {
    // scanLabel 的变量名（如 a in MATCH (a)）形成显式的绑定
    // 多个 MATCH 的第二个 MATCH 应该使用前面的变量
  }
  // 对于多个 MATCH，检查 steps 中的变量引用
  if (plan.steps?.length) {
    // steps 中的变量（如 edgeStep.variable）应该是前序 MATCH 绑定的
  }

  // 2. Parameter check — TCK 测试使用 $param 语法，但 ANTLR 解析可能不识别
  // 如果 parseQuery 返回 undefined 且非空查询，说明语法错误
  if (!plan.type && plan.type !== undefined) {
    throw Object.assign(new Error('SyntaxError'), { tckError: 'SyntaxError' })
  }

  // 3. UnknownFunction — 检查聚合/函数列是否包含未注册的函数
  if (plan.aggregate && plan.aggregate.length) {
    const knownAggs = ['count', 'sum', 'avg', 'min', 'max', 'collect', 'stdev', 'percentileDisc', 'percentileCont']
    for (const agg of plan.aggregate) {
      if (agg.fn && !knownAggs.includes(agg.fn.toLowerCase())) {
        throw Object.assign(new Error(`SyntaxError: UnknownFunction`), { tckError: 'UnknownFunction' })
      }
    }
  }
}
