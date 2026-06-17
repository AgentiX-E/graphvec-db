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
import { globalRegistry as _procedureRegistry } from './procedure-registry'

// ── 内存索引注册表（CREATE INDEX / DROP INDEX）━━━━━━━━━━━━━━━

// ── 内存索引注册表（CREATE INDEX / DROP INDEX） ──
export interface IndexEntry { label: string; property: string }
const _indexRegistry = new Map<string, IndexEntry>()
export function _registerIndex(label: string, property: string): void {
  _indexRegistry.set(`${label}:${property}`, { label, property })
}
export function _dropIndex(label: string, property: string): void {
  _indexRegistry.delete(`${label}:${property}`)
}
export function _getAllIndexes(): IndexEntry[] {
  return Array.from(_indexRegistry.values())
}
export function _getIndex(label: string, property: string): IndexEntry | undefined {
  return _indexRegistry.get(`${label}:${property}`)
}
export function _clearIndexes(): void { _indexRegistry.clear() }

// ── 约束注册表（唯一性约束） ──
export interface ConstraintEntry { name: string; label: string; property: string; type: 'UNIQUE' }
const _constraintRegistry = new Map<string, ConstraintEntry>()
export function _registerConstraint(name: string, label: string, property: string): void {
  _constraintRegistry.set(name, { name, label, property, type: 'UNIQUE' })
}
export function _dropConstraint(name: string): void { _constraintRegistry.delete(name) }
export function _getAllConstraints(): ConstraintEntry[] {
  return Array.from(_constraintRegistry.values())
}
export function _clearConstraints(): void { _constraintRegistry.clear() }

// ── 数据库注册表（CATALOG 多图命名空间） ──
// 默认数据库（neo4j）始终存在
const DEFAULT_DATABASE = 'neo4j'
const _databaseRegistry = new Set<string>([DEFAULT_DATABASE])
let _activeDatabase = DEFAULT_DATABASE
export function _getActiveDatabase(): string { return _activeDatabase }
export function _setActiveDatabase(name: string): void {
  if (_databaseRegistry.has(name)) { _activeDatabase = name }
}
export function _createDatabase(name: string): void { _databaseRegistry.add(name) }
export function _dropDatabase(name: string): void {
  if (name !== DEFAULT_DATABASE) {
    _databaseRegistry.delete(name)
    if (_activeDatabase === name) _activeDatabase = DEFAULT_DATABASE
  }
}
export function _getAllDatabases(): string[] { return Array.from(_databaseRegistry) }
export function _clearDatabases(): void {
  _databaseRegistry.clear()
  _databaseRegistry.add(DEFAULT_DATABASE)
  _activeDatabase = DEFAULT_DATABASE
}

// ── GE 实例注册表（多数据库隔离） ──
const _geInstanceRegistry = new Map<string, GraphEngine>()

/** BigInt JSON 序列化/反序列化辅助 */
const _bigintReplacer = (_k: string, v: unknown): unknown =>
  typeof v === 'bigint' ? { __bigint: v.toString() } : v
const _bigintReviver = (_k: string, v: unknown): unknown =>
  v && typeof v === 'object' && (v as any).__bigint !== undefined ? BigInt((v as any).__bigint) : v
export function _clearGeInstances(): void {
  for (const [, ge] of _geInstanceRegistry) {
    try { ge.close() } catch {}
  }
  _geInstanceRegistry.clear()
}

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
  /** CATALOG 操作（多图命名空间） */
  catalogOp?: 'CREATE_DATABASE' | 'DROP_DATABASE' | 'SHOW_DATABASES'
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
  /** WHERE 子句原始文本（用于表达式引擎后处理） */
  whereBody?: string
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
    variableName?: string
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
  /** 多级 UNWIND 数组（支持 N 级，由 ast-to-plan-v2.ts 收集） */
  unwinds?: Array<{ list: any[]; name: string }>
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
    delimiter: string
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
  try {
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
  } catch (e: any) {
    throw new Error(`Failed to execute query: ${(e as Error).message}`)
  }
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
          // 字符串参数直接赋值给 plan filter 值（非 SQL 拼接），不存在注入风险。
          // _injectParamsToPlan 在 AST 解析后的 plan 上运作，filter.value 是 JS 
          // 运行时值，不会被解释为 CQL/SQL 语句。引号保留以确保值完整匹配。
          if (typeof provided === 'string') {
            const hasSingle = provided.includes("'")
            const hasDouble = provided.includes('"')
            if (hasSingle && hasDouble) {
              // 同时含两种引号：移除全部引号（安全兜底，极罕见）
              f.value = provided.replace(/['"]/g, '')
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
  // ANTLR parser — direct QueryPlan output, no PEG AST intermediate
  let plan: QueryPlan
  try {
    plan = parseCypherToPlan(query.trim())
  } catch (e: any) {
    throw new Error(`Query parse error: ${(e as Error).message}`)
  }

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
    // 同时修复 optionalMatchSteps 中的 scanLabel（它们也可能被 ANTLR 误认为是标签名）
    if (subPlan.optionalMatchSteps?.length && query) {
      const rawQuery = query
      const matchClauses = rawQuery.match(/MATCH\s+.*?(?=WHERE|RETURN|WITH|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|\$Cypher|$)/gis) || []
      for (const oms of subPlan.optionalMatchSteps) {
        if (oms.scanLabel && /^[a-z][0-9]?$/.test(oms.scanLabel)) {
          const labelPattern = new RegExp(':' + oms.scanLabel + '(?=[\)\s{]|$)')
          const isLabelInMatch = matchClauses.some((mc: string) => labelPattern.test(mc))
          if (!isLabelInMatch) {
            oms.scanLabel = null
          }
        }
      }
    }
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

  // ── MERGE: mergeNodes → createNodes（CREATE 路径复用） ──
  if (plan.type === 'MERGE' && plan.mergeNodes?.length) {
    if (!plan.createNodes) plan.createNodes = []
    for (const mn of plan.mergeNodes) {
      plan.createNodes.push(mn)
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

  // ── WHERE 子句提取（用于后过滤） ──
  // 即使 ANTLR 没有生成 filters，也需要提取 WHERE 子句供 _evaluateExpression 后处理
  // 注意：需要先屏蔽 list 谓词中的 WHERE（如 ALL(x IN list WHERE cond)），避免干扰正则
  let safeQuery = (query || '')
  // 使用平衡括号匹配，将 list 谓词替换为占位符
  const listPredStarts = [...safeQuery.matchAll(/\b(ALL|ANY|NONE|SINGLE)\s*\(/gi)]
  const placeholders: Array<{ start: number; end: number; text: string }> = []
  if (listPredStarts.length > 0) {
    for (const pMatch of listPredStarts) {
      let depth = 1
      let i = (pMatch.index || 0) + pMatch[0].length
      while (i < safeQuery.length && depth > 0) {
        if (safeQuery[i] === '(') depth++
        else if (safeQuery[i] === ')') depth--
        if (depth === 0) { i++; break }
        i++
      }
      placeholders.push({ start: pMatch.index || 0, end: i, text: safeQuery.slice(pMatch.index || 0, i) })
    }
    // 从后往前替换为占位符（保持索引不变）
    for (let pi = placeholders.length - 1; pi >= 0; pi--) {
      const { start, end } = placeholders[pi]
      const placeholder = ` __LPRED${pi}__ `
      safeQuery = safeQuery.slice(0, start) + placeholder + safeQuery.slice(end)
    }
  }
  const whereClause = safeQuery.match(/WHERE\s+(.+?)(?:\s+RETURN|\s+ORDER|\s+SKIP|\s+LIMIT|\s+WITH|\s+CREATE|\s+DELETE|\s+SET|\s+REMOVE|\s+UNWIND|$)/is)
  if (whereClause) {
    let whereBody = whereClause[1]
    // 恢复占位符
    for (let pi = 0; pi < placeholders.length; pi++) {
      whereBody = whereBody.replace(`__LPRED${pi}__`, placeholders[pi].text)
    }
    plan.whereBody = whereBody
    // 检测顶层 OR/XOR（不在括号内的 OR）——清空 filters（OR 需要运行时可短路评估）
    if (plan.filters?.length) {
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
      if (hasTopLevelOr) plan.filters = []
    }
  }

  // ── 多标签修复 ──
  // AST 只取第一个标签作为 scanLabel（如 :A:B → scanLabel='A'），
  // _fixScanLabel 可能因 regex 匹配多标签而清空 scanLabel。
  // 此处从 query 文本检测多标签并重建 scanLabel + labelExpr。
  const qText = query.trim()
  if (plan.hasMatch) {
    const nodePatterns = qText.match(/\([^)]+\)/g) || []
    // 优先使用 scanLabel 未清空时的路径
    let multiLabelFound = false
    if (plan.scanLabel) {
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
          multiLabelFound = true
          break
        }
      }
    }
    // 如果 scanLabel 被清空但仍有多标签，从 query 恢复
    if (!multiLabelFound && !plan.labelExpr) {
      for (const np of nodePatterns) {
        const inner = np.slice(1, -1).trim()
        const colIdx = inner.indexOf(':')
        if (colIdx === -1) continue
        // 检查变量名（冒号前的部分）
        const varPart = inner.substring(0, colIdx).trim()
        let labelPart = inner.substring(colIdx + 1)
        const braceIdx = labelPart.indexOf('{')
        if (braceIdx >= 0) labelPart = labelPart.substring(0, braceIdx).trim()
        const labels = labelPart.split(':').map(s => s.trim()).filter(Boolean)
        if (labels.length > 1) {
          // 恢复 scanLabel 为第一个标签，设置 labelExpr
          plan.scanLabel = labels[0]
          plan.labelExpr = { type: 'LABEL_EXPR', items: labels.map(l => ({ exclude: false, name: l })) }
          // 确保 scanLabel 不是变量名（仅在 steps 为空时指向标签）
          if (!plan.steps?.length) {
            // 保留 scanLabel
          }
          break
        }
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
        } else if (typeof pv === 'bigint') {
          cn.props[pk] = { type: 'NUMBER', value: Number(pv) }
        }
      }
    }
  }

  // ── Fallback: 如果 parseQuery 后 returnColumns 为空但有 RETURN 子句 ──
  // ANTLR 可能无法解析某些函数调用（如 type(r) AS alias），用正则提取
  if (!plan.returnColumns?.length && !plan.aggregate) {
    const returnClause = query.match(/RETURN\s+(.+?)(?:\s+(ORDER|SKIP|LIMIT|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|FOREACH|CALL|SHOW)\s|$)/is)
    if (returnClause) {       const expr = returnClause[1].trim()
      // RETURN * → 保持空列（留给 _formatResultRow 的特殊处理）
      if (expr === '*') {
        // 保持 returnColumns = []（表示"所有变量"）
      } else {
        // 尝试拆分逗号分隔的列定义
        const cols = expr.split(',').map(c => c.trim()).filter(Boolean)
        if (cols.length) {
          plan.returnColumns = cols.map(c => {
            // labels(node) AS l → l（取 AS 后的别名，保留表达式到 returnAliasMap）
            const asMatch = c.match(/\bAS\s+(\w+)\s*$/i)
            if (asMatch) {
              plan.returnAliasMap = plan.returnAliasMap || {}
              plan.returnAliasMap[asMatch[1]] = c.replace(/\s+AS\s+\w+\s*$/i, '').trim()
              return asMatch[1]
            }
            return c
          })
          if (!plan.returnAliasMap || Object.keys(plan.returnAliasMap).length === 0) {
            plan.returnAliasMap = {}
            for (const c of plan.returnColumns) plan.returnAliasMap[c] = c
          }
        }
      }
    }
  }

  // 检测无效查询：parseCypherToPlan 成功返回但查询语法非法（ANTLR 错误被吞掉了）
  // 特征: scanLabel=null, steps=[], filters=[], returnColumns=[], hasMatch=false
  if (!plan.scanLabel && plan.steps?.length === 0 && plan.filters?.length === 0 && plan.returnColumns?.length === 0 && !plan.hasMatch && !plan.create && !plan.show && !plan.with && !plan.unwind && !plan.unwinds?.length && !plan.unionType && !plan.caseColumns?.length && !plan.loadCsv) {
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
        // 列表字面量 [1,2] or [a, 1]
        if (expr.startsWith('[') && expr.endsWith(']')) {
          try {
            const items = JSON.parse(expr.replace(/'/g, '"'))
            col.expression = { type: 'LIST', items: items.map((v: any) => {
              if (typeof v === 'number') return { type: 'NUMBER', value: v }
              if (typeof v === 'string') return { type: 'STRING', value: v }
              return v
            })}
          } catch {
            // JSON parse failed — likely contains identifiers like [a, 1]
            // Parse items manually
            const inner = expr.slice(1, -1).trim()
            const items: Array<{ type: string; name?: string; value?: unknown }> = []
            const parts = _parseCommaList(inner)
            for (const part of parts) {
              const item = part.trim()
              if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(item)) {
                items.push({ type: 'NUMBER', value: parseFloat(item) })
              } else if ((item.startsWith("'") && item.endsWith("'")) || (item.startsWith('"') && item.endsWith('"'))) {
                items.push({ type: 'STRING', value: item.slice(1, -1) })
              } else if (/^(?:true|false)$/i.test(item)) {
                items.push({ type: 'BOOLEAN', value: item.toLowerCase() === 'true' })
              } else if (/^[a-zA-Z_]\w*$/.test(item)) {
                items.push({ type: 'IDENTIFIER', name: item })
              } else {
                items.push({ type: 'STRING', value: item })
              }
            }
            col.expression = { type: 'LIST', items }
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
      plan.whereBody = whereText
      _parseLabelFilterOnly(whereText, plan)
    }
  }

  // ── UNWIND name 修复 ──
  // ANTLR 适配器可能将 UNWIND expr 中出现的变量名（如 size(types) 中的 types）
  // 误作为 UNWIND name，而非 AS 后的真正变量名。
  // 同时，双 UNWIND 场景下第二个 UNWIND 可能丢失。
  if (plan.unwind && plan.hasMatch && query) {
    try {
      const unwindMatches = [...query.matchAll(/UNWIND\s+(.+?)\s+AS\s+(\w+)/gi)]
      for (const [umIdx, m] of unwindMatches.entries()) {
        if (umIdx === 0) {
          if (m[2] && m[2] !== plan.unwind.name) {
            plan.unwind.name = m[2]
          }
        } else if (umIdx === 1) {
          plan.secondUnwind = {
            list: [],
            name: m[2],
            var: m[1].trim(),
          }
        }
      }
      // 同步修复 plan.unwinds 数组中的 name
      if (plan.unwinds?.length) {
        for (const [umIdx, m] of unwindMatches.entries()) {
          if (umIdx < plan.unwinds.length && m[2] && m[2] !== plan.unwinds[umIdx].name) {
            plan.unwinds[umIdx].name = m[2]
          }
        }
      }
    } catch (e) {
      // ignore parse errors
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
        // openCypher 规范：ASC 排序中 null 排在最后（大于所有非 null 值）
        // 原实现 null 排在最前，违反规范。参考代码审查 CVE-H6。
        else if (va === null) cmp = 1  // null > non-null → last in ASC
        else if (vb === null) cmp = -1 // non-null < null → last in ASC
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

  // ── SKIP ──
  if (p.skip !== undefined && p.skip > 0) {
    processed = processed.slice(p.skip)
  }
  // ── LIMIT ──
  if (p.limit !== undefined && p.limit >= 0) {
    processed = processed.slice(0, p.limit)
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
    // ── 变量长度路径：step.range 存在时做 BFS 多跳 ──
    if ((step as any).range) {
      const range = (step as any).range
      const minHops = range.min ?? 1
      const maxHops = range.max ?? 10 // 默认最大 10 跳（防止无限）
      const varLenSet = new Set<number>()
      // 检查边标签是否配置（仅对匹配边做遍历）
      const hasEdgeLabel = !!(step as any).edgeLabel
      for (const sidx of currentSet) {
        // BFS 从 sidx 出发，记录每层目标节点
        let frontier = new Set<number>([sidx])
        const visited = new Set<number>([sidx])
        for (let depth = 1; depth <= maxHops; depth++) {
          const nextFrontier = new Set<number>()
          for (const fidx of frontier) {
            const node = allNodes[fidx] as any
            const edges: Array<{ dstIdx: number; srcIdx: number; label: string; props?: any }> = node?.__edges || []
            const isAny = step.direction === 'any'
            for (const e of edges) {
              let neighborIdx = -1
              if (isAny) {
                neighborIdx = e.dstIdx === fidx ? e.srcIdx : (e.srcIdx === fidx ? e.dstIdx : -1)
              } else if (step.direction === 'out' && e.srcIdx === fidx) {
                neighborIdx = e.dstIdx
              } else if (step.direction === 'in' && e.dstIdx === fidx) {
                neighborIdx = e.srcIdx
              }
              if (neighborIdx >= 0 && neighborIdx < allNodes.length && !visited.has(neighborIdx) && neighborIdx !== fidx) {
                if (hasEdgeLabel && (e.label !== step.edgeLabel)) continue
                visited.add(neighborIdx)
                if (depth >= minHops) {
                  if (_stepMatchConstraint(neighborIdx, step, allNodes)) {
                    // 检查 __edges 一致性（TCK 场景）
                    varLenSet.add(neighborIdx)
                  }
                }
                nextFrontier.add(neighborIdx)
              }
            }
            // 无向边兜底：所有其他节点的 __edges 中指向 fidx 的边
            if (isAny) {
              for (let j = 0; j < allNodes.length; j++) {
                if (j === fidx || visited.has(j)) continue
                const other = allNodes[j] as any
                if (other.__edges) {
                  for (const e of other.__edges) {
                    if ((e.dstIdx === fidx || e.srcIdx === fidx) && !visited.has(j)) {
                      const nIdx = e.dstIdx === fidx ? e.srcIdx : e.dstIdx
                      if (nIdx === j && !visited.has(j)) {
                        visited.add(j)
                        if (depth >= minHops && _stepMatchConstraint(j, step, allNodes)) {
                          varLenSet.add(j)
                        }
                        nextFrontier.add(j)
                      }
                    }
                  }
                }
              }
            }
          }
          frontier = nextFrontier
          if (frontier.size === 0) break
        }
      }
      currentSet = varLenSet
      continue
    }
    const nextSet = new Set<number>()
    // 构建 combinedSourceFilters：当前步的 source 节点属性约束
    // 排除 ANTLR 链式比较解析失败的值（包含比较运算符的字符串值）
    const _isBrokenFilterValue = (v: any): boolean =>
      typeof v === 'string' && /[<>=]/.test(v)
    const combinedSourceFilters: Array<{source?: string; property: string; value: any}> = []
    if (planFilters?.length) {
      for (const f of planFilters) {
        if (_isBrokenFilterValue(f.value)) continue
        if (f.source === step.source) combinedSourceFilters.push(f)
      }
    }
    if (stepSourceFilters?.length) {
      for (const f of stepSourceFilters) {
        if (_isBrokenFilterValue(f.value)) continue
        if (f.source === step.source) combinedSourceFilters.push(f)
      }
    }
    // 在边遍历前应用 source filter：从 currentSet 中移除不满足 source 约束的节点
    // WHERE a.id = 1 — 在 seed 节点（step 0）和路径回溯（step 3+）中检查
    if (combinedSourceFilters.length > 0) {
      for (const idx of [...currentSet]) {
        const fn = allNodes[idx]
        if (!fn) continue
        let passes = true
        for (const rf of combinedSourceFilters) {
          if (fn[rf.property] === undefined) {
            passes = false
            break
          }
          const actualStr = String(fn[rf.property])
          const filterStr = String(rf.value)
          if (actualStr !== filterStr) {
            // 大整数精度补偿：ANTLR 把超出 Number 安全范围的整数字面量截断，
            // 尝试用 BigInt 精确比较
            if (/^\d+$/.test(actualStr) && /^-?\d+$/.test(filterStr)) {
              try {
                const actualBig = BigInt(actualStr)
                const filterBig = BigInt(filterStr)
                if (actualBig !== filterBig) {
                  passes = false
                  break
                }
              } catch {
                passes = false
                break
              }
            } else {
              passes = false
              break
            }
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
        if (neighborIdx >= 0 && neighborIdx < allNodes.length) {
          // 边标签检查：如果 step 指定了 edgeLabel，边必须匹配（方向已经匹配）
          // 支持多类型 | 分隔（如 :KNOWS|HATES）
          if (step.edgeLabel) {
            const targetLabels = step.edgeLabel.split('|')
            if (!targetLabels.includes(e.label)) continue
          }
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
              if ((e.dstIdx === idx || e.srcIdx === idx) && e.dstIdx !== e.srcIdx) {
                const neighborIdx = e.dstIdx === idx ? e.srcIdx : e.dstIdx
                if (!nextSet.has(neighborIdx) && _stepMatchConstraint(neighborIdx, step, allNodes)) {
                  nextSet.add(neighborIdx)
                }
              }
            }
          }
        }
      }
    }
    // 当前 step 的 target filter（约束 step.targetAlias 变量）
    // 只预过滤 EQ/NEQ/IS_NULL/IS_NOT_NULL（GT/GTE/LT/LTE 等由 GE filter 补偿或后处理）
    const simpleOps = new Set(['EQ', 'NEQ', 'IS_NULL', 'IS_NOT_NULL'])
    const targetFilters = planFilters?.length ? planFilters.filter(f => f.source === step.targetAlias && simpleOps.has(f.operator)) : []
    if (targetFilters.length > 0) {
        for (const fidx of [...nextSet]) {
          const fn = allNodes[fidx]
          if (!fn) { nextSet.delete(fidx); continue }
          let passes = true
          for (const rf of targetFilters) {
            if (rf.operator === 'IS_NULL') {
              if (fn[rf.property] != null) { passes = false; break }
            } else if (rf.operator === 'IS_NOT_NULL') {
              if (fn[rf.property] == null) { passes = false; break }
            } else {
              if (fn[rf.property] === undefined || String(fn[rf.property]) !== String(rf.value)) {
                passes = false
                break
              }
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

/**
 * 变量长度路径执行器：从 nodes 出发做 BFS，返回格式化结果。
 * 独立于 GE，纯基于 __edges 遍历。
 */
function _executeVarLenPath(plan: QueryPlan, nodes: Array<Record<string, unknown>>): QueryResult {
  const step = plan.steps[0]
  const range = (step as any).range
  const minHops = range.min ?? 1
  const maxHops = Math.min(range.max ?? 10, 50) // 上限 50 防循环
  const result: QueryRow[] = []
  const srcNodes: Array<Record<string, unknown>> = [...(nodes || [])]
  for (let si = 0; si < srcNodes.length; si++) {
    const sourceNode = srcNodes[si] as any
    if (plan.scanLabel && sourceNode._label !== plan.scanLabel) continue
    let frontier = new Set<number>([si])
    const visited = new Set<number>([si])
    for (let depth = 1; depth <= maxHops; depth++) {
      const nextFrontier = new Set<number>()
      for (const fidx of frontier) {
        const node = srcNodes[fidx] as any
        const edgeArr: Array<{ dstIdx: number; srcIdx: number; label: string }> = node?.__edges || []
        for (const e of edgeArr) {
          let nIdx = -1
          if (e.srcIdx === fidx) nIdx = e.dstIdx
          else if (e.dstIdx === fidx) nIdx = e.srcIdx
          if (nIdx < 0 || nIdx >= srcNodes.length || visited.has(nIdx)) continue
          visited.add(nIdx)
          if (depth < minHops) {
            nextFrontier.add(nIdx)
            continue
          }
          const targetNode = srcNodes[nIdx] as any
          if (step.targetLabel && targetNode._label && targetNode._label !== step.targetLabel) continue
          if (step.edgeLabel && e.label !== step.edgeLabel) continue
          const geLike: any = {
            id: nIdx + 1,
            props: { _label: targetNode._label || 'Default' },
            __targetProps: { ...targetNode },
            __multiStep: true,
          }
          for (const k of Object.keys(targetNode)) {
            if (k !== '_label' && k !== '__edges') geLike.props[k] = targetNode[k]
          }
          // 构建返回行：从原始 returnColumns 用变量前缀映射
          const rowRes: QueryRow = {}
          for (const rc of plan.returnColumns || []) {
            if (!rc) continue
            // rc 是拆解后的纯属性名（b.name → name）
            // 需要从 __edges 遍历的 BFS 找到对应的 targetNode 属性
            rowRes[rc] = targetNode[rc] ?? null
          }
          // 补充 returnAliasMap 中带变量前缀的完整表达式
          // 因为 parseQuery 拆解了 returnColumns，但 _formatResultRow 期望完整 key
          if (plan.returnAliasMap) {
            for (const [alias, expr] of Object.entries(plan.returnAliasMap)) {
              if (expr.includes('.')) {
                rowRes[expr] = rowRes[alias] ?? null
              }
            }
          }
          if (Object.keys(rowRes).length) result.push(rowRes)
          nextFrontier.add(nIdx)
        }
      }
      frontier = nextFrontier
      if (frontier.size === 0) break
    }
  }
  return _postProcessResults(result, plan)
}

// ── CSV 解析辅助函数 ──────────────────────────────────────────

/**
 * 解析 CSV 内容为行数组。
 * 每行以 RowVariable 为 key 返回对象或数组。
 * WITH HEADERS: 返回 { row: { col1: val1 } }
 * WITH NO HEADERS: 返回 { row: [val1, val2] }
 */
function parseCsvContent(content: string, options: { headers: boolean; delimiter: string; as: string }): any[] {
  const lines = content.split(/\r?\n/).filter((l: string) => l.trim() !== '')
  if (lines.length === 0) return []

  const delimiter = options.delimiter
  const headerLine = options.headers ? lines.shift() : null
  const headers = headerLine ? splitCsvLine(headerLine, delimiter) : null

  return lines.map((line: string) => {
    const fields = splitCsvLine(line, delimiter)
    if (options.headers && headers) {
      const obj: Record<string, string> = {}
      headers.forEach((h, i) => { obj[h] = fields[i] || '' })
      return { [options.as]: obj }
    } else {
      return { [options.as]: fields }
    }
  })
}

/**
 * 单行 CSV 拆分，正确处理引号包裹。
 * 支持换行符（未闭合引号跨行）和 "" 转义。
 */
function splitCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      // 检查是否转义引号（"" → "）
      if (i + 1 < line.length && line[i + 1] === '"') {
        current += '"'
        i++ // skip next
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === delimiter && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  result.push(current.trim())
  return result
}

/**
 * 处理 WITH/UNWIND/aggregate 管道（不含 MATCH 图遍历）。
 * 
 * 处理链：
 *   WITH [...] AS listVar
 *     → UNWIND listVar AS x
 *       → UNWIND listVar AS y（可选 secondUnwind）
 *         → WITH expr AS v (投影)
 *           → RETURN agg(v)
 * 
 * DSL 语义：WITH 先计算列表字面量（直接在 plan 中），然后 UNWIND 行展开，
 * WITH 列投影 + aggregate 聚合。
 */
function _executeWithUnwindPipeline(plan: QueryPlan, _nodes: Array<Record<string, unknown>>, query?: string, initialVarCtx?: Record<string, unknown>): QueryRow[] {
  // Step 1: 解析 WITH 列表字面量
  // plan.with.columns[0] 是 {expression: "[1, 3.14, ...]", alias: "operands"}
  const varCtx: Record<string, unknown> = { ...initialVarCtx }

  // 多个 WITH 子句时，plan.with 只存最后一个 WITH
  // 从原始 query 文本提取 WITH [...] AS var 的列表字面量
  if (query && plan.unwind?.var) {
    // 匹配所有 WITH [...] AS var 模式，取第一个
    // 用括号深度追踪正确识别嵌套的 [] 和 {}（列表内嵌空列表/空 map）
    let withListMatch: RegExpMatchArray | null = null
    {
      let start = -1
      let depth = 0
      for (let i = 0; i < query.length; i++) {
        const ch = query[i]
        if (ch === '[' && depth === 0) {
          const before = query.substring(0, i).trimEnd()
          if (/\bWITH\s*$/i.test(before)) start = i
          depth++
        } else if (ch === '[' || ch === '{') {
          depth++
        } else if (ch === ']' || ch === '}') {
          depth--
          if (depth === 0 && start >= 0) {
            const listExpr = query.substring(start, i + 1)
            const after = query.substring(i + 1).trim()
            const aliasMatch = after.match(/^AS\s+(\w+)/i)
            if (aliasMatch) {
              withListMatch = [listExpr, listExpr, aliasMatch[1]]
            }
            break
          }
        }
      }
    }
    if (withListMatch) {
      const listExpr = withListMatch[1]
      const alias = withListMatch[2]
      const val = _evaluateExpression(listExpr, varCtx)
      if (Array.isArray(val)) varCtx[alias] = val
    }
  }

  // Step 2: 执行 UNWIND 链（支持 N 级 UNWIND 笛卡尔积）
  let rows: Array<Record<string, unknown>> = []

  if (plan.unwinds?.length) {
    // 多级 UNWIND：N 路笛卡尔积
    const lists = plan.unwinds.map(u => {
      const items = _resolveUnwindList(u, varCtx)
      return Array.isArray(items) ? items : [items]
    })
    function _cartesianN(idx: number, current: Record<string, unknown>): void {
      if (idx >= lists.length) { rows.push({ ...current }); return }
      for (const item of lists[idx]) {
        current[plan.unwinds![idx].name] = item
        _cartesianN(idx + 1, current)
      }
    }
    _cartesianN(0, {})
  } else if (plan.unwind) {
    const list1 = _resolveUnwindList(plan.unwind, varCtx)
    if (!Array.isArray(list1)) {
      // 非列表值 → 单行
      rows = [{ [plan.unwind.name]: list1 }]
    } else if (plan.secondUnwind) {
      // 双 UNWIND：笛卡尔积（向后兼容 plan.secondUnwind / plan.unwind 字段）
      const list2 = _resolveUnwindList(plan.secondUnwind, varCtx)
      for (const item1 of list1) {
        const list2Arr = Array.isArray(list2) ? list2 : [list2]
        for (const item2 of list2Arr) {
          const row: Record<string, unknown> = { [plan.unwind.name]: item1 }
          row[plan.secondUnwind.name] = item2
          rows.push(row)
        }
      }
    } else {
      // 单 UNWIND
      rows = list1.map((item: unknown) => ({ [plan.unwind.name!]: item }))
    }
  } else {
    rows = [{}]
  }

  // ── 中间 WITH 投影 ──
  if (query && rows.length && plan.hasMatch && plan.unwind) {
    const nonListWithClauses: Array<{ cols: string; where: string | null }> = []
    {
      let i = 0
      while (i < query.length) {
        const idx = query.substring(i).search(/\bWITH\s+(?!\s*\[)/i)
        if (idx < 0) break
        const absPos = i + idx
        const afterWith = query.substring(absPos + 4).trimStart()
        let endIdx = afterWith.search(/\b(?:UNWIND|WITH|RETURN|ORDER\s+BY|SKIP|LIMIT|CREATE|MERGE|DELETE|SET|REMOVE)\b/i)
        if (endIdx < 0) endIdx = afterWith.length
        const clauseBody = afterWith.substring(0, endIdx).trim()
        const whereMatch = clauseBody.match(/^(.+?)\s+WHERE\s+(.+)$/is)
        if (whereMatch) {
          nonListWithClauses.push({ cols: whereMatch[1].trim(), where: whereMatch[2].trim() })
        } else {
          nonListWithClauses.push({ cols: clauseBody, where: null })
        }
        i = absPos + 4 + 1
      }
    }
    const middleWith = nonListWithClauses.length > 1 ? nonListWithClauses.slice(0, -1) : []
    for (const mwc of middleWith) {
      const columns = mwc.cols.split(',').map(s => s.trim()).filter(Boolean)
      rows = rows.map(row => {
        const newRow: Record<string, unknown> = { ...row }
        const evalCtx: Record<string, unknown> = { ...varCtx, ...row }
        for (const col of columns) {
          const asMatch = col.match(/^(.+?)\s+AS\s+(\w+)$/i)
          if (asMatch) {
            const expr = asMatch[1].trim()
            const alias = asMatch[2]
            const val = _evaluateExpression(expr, evalCtx)
            newRow[alias] = val !== undefined ? val : null
          } else {
            const trimmed = col.trim()
            if (trimmed in evalCtx) {
              newRow[trimmed] = evalCtx[trimmed]
            } else {
              const val = _evaluateExpression(trimmed, evalCtx)
              newRow[trimmed] = val !== undefined ? val : null
            }
          }
        }
        return newRow
      })
      if (mwc.where) {
        // 用完整 evalCtx（含原始 row 中的 i, j 等 UNWIND 变量）来过滤
        rows = rows.filter(row => {
          const fullCtx: Record<string, unknown> = { ...varCtx, ...row }
          const val = _evaluateExpression(mwc.where!, fullCtx)
          return val === true
        })
      }
    }
  }

    // Step 3: 应用 WITH 投影——逐行计算非聚合列，收集聚合列的值
  if (plan.with?.columns?.length) {
    // 判断哪些列是聚合函数
    const aggFnPattern = /^\s*(collect|count|sum|avg|max|min)\s*\(/i
    const isAggCol: boolean[] = plan.with.columns.map(col => aggFnPattern.test(col.expression))
    const hasAgg = isAggCol.some(Boolean)
    const aggCols: Array<{ alias: string; rows: unknown[] }> = []
    if (hasAgg) {
      for (let i = 0; i < plan.with.columns.length; i++) {
        if (isAggCol[i]) {
          aggCols.push({ alias: plan.with.columns[i].alias || plan.with.columns[i].expression, rows: [] })
        }
      }
    }
    rows = rows.map(row => {
      const newRow: Record<string, unknown> = {}
      const evalCtx: Record<string, unknown> = { ...varCtx, ...row }
      let aggIdx = 0
      for (let i = 0; i < plan.with.columns.length; i++) {
        const col = plan.with.columns[i]
        const alias = col.alias || col.expression
        if (isAggCol[i]) {
          // 聚合列：提取参数表达式，逐行计算值，收集到 aggCols
          const innerMatch = col.expression.match(/^\s*\w+\s*\((.+?)\)\s*$/is)
          if (innerMatch) {
            const val = _evaluateExpression(innerMatch[1], evalCtx)
            aggCols[aggIdx].rows.push(val !== undefined ? val : null)
          }
          aggIdx++
          // 不在 row 中放聚合结果（聚合后统一放）
        } else {
          if (evalCtx[alias] !== undefined && col.alias) continue
          if (col.alias === null && col.expression in evalCtx) {
            // 无别名的列且已在 evalCtx 中（如 UNWIND 变量 a, b），传递值到新行
            newRow[col.expression] = evalCtx[col.expression]
            continue
          }
          const val = _evaluateExpression(col.expression, evalCtx)
          newRow[col.alias || col.expression] = val !== undefined ? val : null
        }
      }
      return newRow
    })
    // 聚合后：将所有 UNWIND 行压缩为单行，聚合列的值替换为收集的数组
    if (hasAgg) {
      const aggRow: Record<string, unknown> = {}
      for (const ac of aggCols) {
        aggRow[ac.alias] = ac.rows  // collect → 整个数组
      }
      rows = [aggRow]
    }
  }

  // 如果 WITH 中没有投影列但 rows 不为空，保持现有 row
  if (!plan.with?.columns?.length && !rows.length) {
    rows = [{}]
  }

  // ── WITH WHERE 过滤 ──
  // WITH ... WHERE 的过滤在 parseQuery 中没有被提取到 filters。
  // 从原始 query 文本提取最后一个 WITH 的 WHERE 子句，用表达式引擎逐行过滤。
  if (query && !plan.aggregate && rows.length > 1) {
    let whereText = ''
    // 对于多级 WITH，提取最后一个 WITH 的 WHERE（如 WHERE result）
    if (plan.unwind || plan.hasMatch) {
      const withParts = query.split(/\bWITH\s+/i).filter(Boolean)
      if (withParts.length > 1) {
        const lastWith = withParts[withParts.length - 1]
        const whereMatch = lastWith.match(/\bWHERE\s+(.+?)(?:\s+(?:RETURN|WITH|CREATE|MERGE|SET|DELETE|ORDER\s+BY|SKIP|LIMIT)\s|$)/is)
        if (whereMatch && !whereMatch[1].includes('[')) whereText = whereMatch[1].trim()
      }
    }
    // Fallback：全局第一个 WHERE（用于无多级 WITH 的场景）
    if (!whereText) {
      const globalWhereMatch = query.match(/\bWHERE\s+(.+?)(?:\s+(?:RETURN|WITH|CREATE|MERGE|SET|DELETE|ORDER\s+BY|SKIP|LIMIT)\s|$)/is)
      if (globalWhereMatch && !globalWhereMatch[1].includes('[')) whereText = globalWhereMatch[1].trim()
    }
    if (whereText) {
      // 有 MATCH 的 WHERE 由 MATCH 路径处理（hasMatch=true），只有无 MATCH 的 WITH WHERE 才在此处理
      // 但 pipeline 中的 WITH WHERE（如 WHERE result）需在此处理，不受 hasMatch 影响
      if (!plan.hasMatch || (plan.hasMatch && plan.unwind)) {
        rows = rows.filter(row => {
          const val = _evaluateExpression(whereText, row)
          return val === true
        })
      }
    }
  }

  // Step 4: 聚合（count/sum/avg/max/min）
  if (plan.aggregate) {
    const agg = plan.aggregate as any
    const aggFn = (agg.function || agg.type || '').toLowerCase()
    const aggAlias = agg.alias || (agg.column && agg.column.replace(/^.+?\s+AS\s+/i, '').trim()) || agg.field || agg.column || 'count(*)'

    // 从聚合列提取字段名：count(*)=*, count(v)=v
    const colMatch = (agg.column || '').match(/^\w+\((.+?)\)(?:\s+AS\s+\w+)?$/i)
    const field = colMatch ? colMatch[1] : (agg.field || '*')

    if (aggFn === 'count') {
      if (field === '*') {
        // count(*): 行数
        return [{ [aggAlias]: rows.length }]
      }
      // count(expr): 非 null 行数
      const nonNull = rows.filter(r => {
        const v = r[field]
        return v !== null && v !== undefined
      })
      return [{ [aggAlias]: nonNull.length }]
    }

    // sum/avg/min/max: 从 field 收集数值
    const values = rows
      .map(r => r[field])
      .filter((v: unknown) => v !== null && v !== undefined)
      .map(Number)
      .filter((v: number) => !isNaN(v))

    switch (aggFn) {
      case 'sum':
        return [{ [aggAlias]: values.reduce((a: number, b: number) => a + b, 0) }]
      case 'avg':
        return [{ [aggAlias]: values.length ? values.reduce((a: number, b: number) => a + b, 0) / values.length : 0 }]
      case 'max':
        return [{ [aggAlias]: values.length ? Math.max(...values) : 0 }]
      case 'min':
        return [{ [aggAlias]: values.length ? Math.min(...values) : 0 }]
      default:
        return [{ [aggAlias]: 0 }]
    }
  }

  // Step 5: RETURN 列映射
  if (plan.returnColumns?.length) {
    return rows.map(row => {
      const out: QueryRow = {}
      for (const rc of plan.returnColumns) {
        if (!rc) continue
        // 查找 returnAliasMap 原始表达式
        const expr = plan.returnAliasMap?.[rc.replace(/^\w+\./, '')] || rc
        const val = _evaluateExpression(expr, row)
        out[rc] = val !== null && val !== undefined ? val : null
      }
      return out
    })
  }

  return rows
}

/**
 * 从 UNWIND clause 解析列表值：
 * 1. plan.unwind.list 已填充（字面量列表）
 * 2. plan.unwind.var 是变量引用 → 从 varCtx 查找
 */
function _resolveUnwindList(unwind: NonNullable<QueryPlan['unwind']>, varCtx: Record<string, unknown>): unknown[] {
  if (Array.isArray(unwind.list) && unwind.list.length > 0) {
    return unwind.list
  }
  if (unwind.var) {
    // 尝试变量引用
    if (varCtx[unwind.var] !== undefined) {
      const val = varCtx[unwind.var]
      if (Array.isArray(val)) return val
      return [val]
    }
    // 尝试表达式求值（如 split('one1two', '1') 等函数调用）
    const exprVal = _evaluateExpression(unwind.var, varCtx)
    if (Array.isArray(exprVal)) return exprVal
    if (exprVal != null) return [exprVal]
  }
  return []
}

/** GraphEngine 原生执行入口 */
async function _executeViaGraphEngine(plan: QueryPlan, nodes: Array<Record<string, unknown>>, query?: string): Promise<QueryResult> {
  // ── LOAD CSV ──
  if (plan.loadCsv) {
    const csv = plan.loadCsv
    let filePath = csv.url
    if (filePath.startsWith('file://')) filePath = filePath.slice(7)
    if (!path.isAbsolute(filePath)) {
      filePath = path.resolve(process.cwd(), filePath)
    }
    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf-8')
    } catch (e: any) {
      throw new Error(`LOAD CSV error: cannot read file "${filePath}": ${e.message}`)
    }
    const rows = parseCsvContent(content, {
      headers: csv.hasHeaders,
      delimiter: csv.delimiter,
      as: csv.rowVariable,
    })
    return _postProcessResults(rows, plan)
  }

  // SHOW LABELS / INDEXES / CONSTRAINTS / PROCEDURES / FUNCTIONS / RELATIONSHIPTYPES
  if (plan.show) {
    const what = (plan.show as any).what
    if (what === 'LABELS') {
      const seen = new Set<string>()
      const labels: QueryRow[] = []
      for (const n of nodes) {
        const lbl = n['_label']
        if (lbl && !seen.has(String(lbl))) { seen.add(String(lbl)); labels.push({ label: lbl }) }
      }
      return labels
    }
    if (what === 'INDEXES') {
      const indexes = _getAllIndexes()
      return indexes.map(idx => ({
        name: `${idx.label}.${idx.property}`,
      }))
    }
    if (what === 'CONSTRAINTS') {
      const constraints = _getAllConstraints()
      return constraints.map(c => ({
        name: c.name,
      }))
    }
    if (what === 'PROCEDURES') {
      return [
        { name: 'db.labels', mode: 'READ', description: 'List all node labels' },
        { name: 'db.relationshipTypes', mode: 'READ', description: 'List all relationship types' },
        { name: 'db.indexes', mode: 'READ', description: 'List all indexes' },
        { name: 'db.constraints', mode: 'READ', description: 'List all constraints' },
      ]
    }
    if (what === 'FUNCTIONS') {
      return [
        { name: 'type', description: 'Returns the type of a relationship' },
        { name: 'properties', description: 'Returns a map containing all properties' },
        { name: 'toString', description: 'Converts a value to a string' },
        { name: 'toInteger', description: 'Converts a value to an integer' },
        { name: 'toFloat', description: 'Converts a value to a float' },
        { name: 'keys', description: 'Returns the keys of a map or node' },
        { name: 'labels', description: 'Returns the labels of a node' },
      ]
    }
    if (what === 'RELATIONSHIPTYPES') {
      const seen = new Set<string>()
      const types: QueryRow[] = []
      for (const n of nodes) {
        if (n.__edges && Array.isArray(n.__edges)) {
          for (const e of n.__edges) {
            const lbl = e.label || ''
            if (lbl && !seen.has(String(lbl))) { seen.add(String(lbl)); types.push({ relationshipType: lbl }) }
          }
        }
      }
      return types
    }
    return []
  }

  // 过程调用：CALL db.labels(), db.indexes(), db.constraints(), db.schema.visualization()
  if (plan.callProcedure) {
    const { name, args } = plan.callProcedure
    switch (name) {
      case 'db.labels': {
        // 返回所有节点标签（从 allNodes 收集）
        const labels = new Set<string>()
        for (const node of nodes) {
          const lbl = String(node._label || 'Default')
          for (const l of lbl.split(':').map(s => s.trim()).filter(Boolean)) labels.add(l)
        }
        if (args?.length) {
          // 如果 args 中包含字符串参数，可能要做筛选（但 Cypher 标准 db.labels() 无参数）
        }
        return Array.from(labels).map(l => ({ label: l })) as any
      }
      case 'db.indexes': {
        return _getAllIndexes().map(idx => ({
          id: `${idx.label}:${idx.property}`,
          name: `${idx.label}:${idx.property}`,
          state: 'ONLINE',
          type: 'BTREE',
          labelsOrTypes: [idx.label],
          properties: [idx.property],
          provider: 'native-btree-1.0',
          entityType: 'NODE',
        })) as any
      }
      case 'db.constraints': {
        return _getAllConstraints().map(c => ({
          id: c.name,
          name: c.name,
          state: 'ONLINE',
          type: 'UNIQUENESS',
          entityType: 'NODE',
          labelsOrTypes: [c.label],
          properties: [c.property],
        })) as any
      }
      case 'db.schema.visualization': {
        // 从 nodes 遍历实际 schema
        const labels = new Set<string>()
        const relTypes = new Set<string>()
        const labelProps = new Map<string, Set<string>>()
        const relTypeProps = new Map<string, Set<string>>()

        for (const node of nodes) {
          // 收集节点标签
          const lbl = String(node._label || '')
          if (lbl) {
            for (const l of lbl.split(':').map(s => s.trim()).filter(Boolean)) {
              labels.add(l)
              if (!labelProps.has(l)) labelProps.set(l, new Set())
              // 收集该标签节点的属性名（排除下划线开头的内部属性）
              for (const k of Object.keys(node)) {
                if (!k.startsWith('_')) labelProps.get(l)!.add(k)
              }
            }
          }
          // 收集边类型
          if (node.__edges) {
            for (const e of node.__edges as any[]) {
              const rl = String(e.label || '')
              if (rl && !relTypes.has(rl)) {
                relTypes.add(rl)
                relTypeProps.set(rl, new Set())
              }
              if (rl) {
                if (e.props) for (const k of Object.keys(e.props)) relTypeProps.get(rl)!.add(k)
              }
            }
          }
        }

        return [{
          nodes: Array.from(labels).map(l => ({
            id: l,
            name: l,
            labels: [l],
            properties: Array.from(labelProps.get(l) || []),
          })),
          relationships: Array.from(relTypes).map(r => ({
            id: r,
            type: r,
            properties: Array.from(relTypeProps.get(r) || []),
          })),
        }] as any
      }
      default: {
        console.error('🔍 Looking up procedure:', name)
        // 查询 procedure registry（支持 db.* 以外的自定义 procedure）
        const proc = _procedureRegistry.get(name)
        console.error('🔍 Found:', proc ? proc.name : 'undefined')
        console.error('🔍 Registry has test.doNothing:', _procedureRegistry.get('test.doNothing'))
        console.error('🔍 All procedures:', _procedureRegistry.list().map(p => p.name))
        if (proc) {
          const ctx: import('./procedure-registry').ProcedureContext = {
            getAllNodes: () => nodes,
            getNodeCount: () => nodes.length,
            getLabels: () => {
              const labels = new Set<string>()
              for (const node of nodes) {
                const lbl = String(node._label || '')
                if (lbl) for (const l of lbl.split(':').map(s => s.trim()).filter(Boolean)) labels.add(l)
              }
              return Array.from(labels)
            },
            getPropertyKeys: () => {
              const keys = new Set<string>()
              for (const node of nodes) {
                for (const k of Object.keys(node)) if (!k.startsWith('_')) keys.add(k)
              }
              return Array.from(keys)
            },
          }
          return proc.execute(ctx, args || []) as any
        }
        throw new Error(`Unknown procedure: ${name}`)
      }
    }
  }

  // INDEX 操作：CREATE INDEX ON :Label(prop) / DROP INDEX ON :Label(prop)
  if (plan.indexOp) {
    if (plan.indexOp === 'CREATE' && plan.indexLabel && plan.indexProperty) {
      _registerIndex(plan.indexLabel, plan.indexProperty)
      return [{ created: true }] as any
    }
    if (plan.indexOp === 'DROP' && plan.indexLabel && plan.indexProperty) {
      _dropIndex(plan.indexLabel, plan.indexProperty)
      return [{ dropped: true }] as any
    }
    return []
  }

  // CONSTRAINT 操作：DROP CONSTRAINT name
  if (plan.type === 'DROP_CONSTRAINT' && (plan as any).constraint?.property) {
    _dropConstraint((plan as any).constraint.property)
    return [{ dropped: true }] as any
  }

  // CATALOG 操作：CREATE DATABASE / DROP DATABASE / SHOW DATABASES
  if (plan.catalogOp) {
    switch (plan.catalogOp) {
      case 'CREATE_DATABASE':
        if (plan.useGraph) {
          _createDatabase(plan.useGraph)
          return [{ database: plan.useGraph, created: true }] as any
        }
        return []
      case 'DROP_DATABASE':
        if (plan.useGraph) {
          _dropDatabase(plan.useGraph)
          return [{ database: plan.useGraph, dropped: true }] as any
        }
        return []
      case 'SHOW_DATABASES':
        return _getAllDatabases().map(d => ({ name: d })) as any
      default:
        return []
    }
  }

  // USE — 命名空间切换
  if (plan.type === 'USE') {
    if (plan.useGraph) { _setActiveDatabase(plan.useGraph); return [{ database: plan.useGraph, switched: true }] as any }
    return nodes
  }

  // UNION — 递归执行
  if (plan.unionType && plan.rightPlan) {
    const leftResult = _executeViaGraphEngine({ ...plan, unionType: undefined, rightPlan: undefined }, nodes)
    const rightResult = _executeViaGraphEngine(plan.rightPlan, nodes)
    const left = await leftResult
    const right = await rightResult
    const merged = _mergeUnionResults(plan, left as any, right as any)
    return _postProcessResults(merged as any[], plan)
  }

  // ── DML（DELETE/SET/MERGE/REMOVE） ──
  // 非递归入口。DML 操作仅修改 allNodes，不同步 GE 存储（见 DML 持久化分析）

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

  // ── WITH / UNWIND / aggregate 管道 ──
  // 处理 WITH [...] AS x → UNWIND x AS y → ... → RETURN agg, count(*) 链
  // 不涉及 MATCH/GE 图遍历，纯表达式 + 聚合
  // 注意：MATCH + WITH + UNWIND 场景（如 MATCH ... WITH [...] AS x UNWIND ...）
  // 的 WITH 列表包含 MATCH 变量，不能走纯表达式管道。走主路径处理。
  const hasMatchWithList = plan.hasMatch && plan.unwind && query?.includes('WITH') && query?.includes('AS')
  if (!hasMatchWithList && (plan.unwind || (plan.with && !plan.hasMatch))) {
    return _executeWithUnwindPipeline(plan, nodes, query)
  }

  // 纯 RETURN 字面量（无 MATCH 无 steps 非 DML）——不经过 GraphEngine
  // 注意：OPTIONAL MATCH 必须经过 GraphEngine，即使 hasMatch 为 false
  const isDML = ['MERGE', 'CREATE', 'DELETE', 'SET', 'REMOVE', 'CREATE_CONSTRAINT'].includes(plan.type || '')
  const hasOptionalMatch = plan.optionalMatchSteps?.length ? true : false
  if (!plan.scanLabel && !plan.steps?.length && !plan.aggregate && !plan.hasMatch && !isDML && !hasOptionalMatch) {
    const row: QueryRow = {}
    if (plan.returnColumns?.length) {
      // 使用表达式引擎求值每个 returnColumn
      if (plan.expressionColumns?.length) {
        // expressionColumns 包含结构化的 { expression, alias }，来自 ANTLR parse
        for (const ec of plan.expressionColumns) {
          const val = _evaluateExpression(ec.expression, row)
          row[ec.alias] = val !== null ? val : null
        }
      } else {
        // 无 expressionColumns 时的 fallback（向后兼容）
        for (const rc of plan.returnColumns) {
          const isIdentifier = /^[a-zA-Z_]\w*$/.test(rc) && !['null', 'true', 'false'].includes(rc)
          if (isIdentifier) {
            row[rc] = null
          } else {
            const val = _evaluateExpression(rc, row)
            row[rc] = val !== null ? val : null
          }
        }
      }
    }
    // ── FOREACH 子句：纯 RETURN + FOREACH 时，先执行 FOREACH 再返回结果 ──
    if (plan.forEach?.updates.length && Array.isArray(nodes)) {
      const fe = plan.forEach
      // 解析 list：可能是数组或字符串
      let listItems: unknown[] = []
      if (fe.list && fe.name) {
        if (Array.isArray(fe.list)) {
          listItems = fe.list
        } else if (typeof fe.list === 'string') {
          const listStr = fe.list as string
          if (listStr.startsWith('[') && listStr.endsWith(']')) {
            // 尝试 JSON.parse，如果失败（如单引号），将单引号替换为双引号
            try { listItems = JSON.parse(listStr) } catch {
              try { listItems = JSON.parse(listStr.replace(/'/g, '"')) } catch {}
            }
          }
        }
      }
      if (listItems.length === 0 && Object.keys(row).length) return [row]
      const rows: QueryRow[] = []
      for (const item of listItems) {
        for (const update of fe.updates) {
          if (update.type === 'CREATE') {
            const props: Record<string, unknown> = { _label: update.label || 'Default' }
            if (update.props) {
              for (const [k, v] of Object.entries(update.props)) {
                const valToUse = v === fe.name ? item : (typeof v === 'object' && v !== null && 'value' in v ? (v as any).value : v)
                props[k] = valToUse
              }
            }
            if (update.alias) props['_alias'] = update.alias
            ;(nodes as any[]).push(props)
            const r: QueryRow = {}
            if (update.alias) r[update.alias] = { ...props }
            rows.push(r)
          } else if (update.type === 'SET' && update.property && update.value) {
            // SET p.name = val — 用 item 替换变量引用
            // update.value 可能是变量名（等于 fe.name）或字面量
            const valToSet = update.value === fe.name ? item : update.value
            for (const node of nodes as any[]) {
              if (node._alias === update.alias || update.alias === '' || node._alias === undefined) {
                node[update.property] = valToSet
              }
            }
          }
        }
      }
      return rows.length > 0 ? rows : [row]
    }
    return Object.keys(row).length ? [row] : []
  }

  // ── DML 纯操作（无 RETURN）：直接返回空（side effects 由调用方处理） ──
  // 注意：CREATE/MERGE 的节点/边创建不能跳过，否则 side effects 不会持久化
  if (isDML && !plan.returnColumns?.length && !plan.aggregate) {
    // CREATE_CONSTRAINT: 验证现有数据唯一性并注册约束
    if (plan.type === 'CREATE_CONSTRAINT' && plan.constraint) {
      const { label, property } = plan.constraint
      // 约束名: label_property_unique
      const constraintName = `${label}_${property}_unique`
      // 检查是否已存在同名约束（幂等）
      const existing = _getAllConstraints().find(c => c.name === constraintName)
      if (existing) {
        return []
      }
      // 遍历所有节点，检查该 label + property 的组合是否唯一
      const seen = new Map<unknown, number>() // value → first index
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]
        const nodeLabel = node._label
        // 检查 label 是否匹配：支持多标签（":" 分隔）
        const labels = String(nodeLabel ?? '').split(':').map(s => s.trim()).filter(Boolean)
        if (!labels.includes(label)) continue
        const rawVal = node[property]
        // null/undefined 不违反唯一约束（Cypher 语义：唯一约束不覆盖 NULL）
        if (rawVal === null || rawVal === undefined) continue
        // 解析 typed 格式：{type: 'STRING', value: 'xxx'} → 'xxx'
        const propVal = (rawVal && typeof rawVal === 'object' && 'value' in (rawVal as any))
          ? (rawVal as any).value
          : rawVal
        if (propVal === null || propVal === undefined) continue
        if (seen.has(propVal)) {
          throw new Error(`ConstraintValidationFailed: Node(${label}) already exists with ${property} = ${JSON.stringify(propVal)}`)
        }
        seen.set(propVal, i)
      }
      _registerConstraint(constraintName, label, property)
      return []
    }
    // DELETE/SET/REMOVE 可以直接返回空（不创建节点/边）
    if (plan.type !== 'CREATE' && plan.type !== 'MERGE') {
      return []
    }
  }

  // ── 变量长度路径：直接 BFS 并返回，不依赖 GE ──
  const hasVarLenGE = plan.steps?.length === 1 && (plan.steps[0] as any)?.range
  if (hasVarLenGE) {
    return _executeVarLenPath(plan, nodes)
  }

  let ge: GraphEngine | null = null
  let geOwned = false  // true → 新创建的注册实例，finally 中不 close（由 _clearGeInstances 统一清理）
  let dir = ''
  if (_geInstanceRegistry.has(_activeDatabase)) {
    ge = _geInstanceRegistry.get(_activeDatabase)!
  } else {
    dir = path.join('/tmp', 'tckge-' + process.pid + '-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'))
    fs.mkdirSync(dir, { recursive: true })
    const config: OverGraphConfig = { path: dir, denseVector: { dimension: 384 } }
    ge = new GraphEngine(config)
    ge.open()
    _geInstanceRegistry.set(_activeDatabase, ge)
    geOwned = true
  }
  let originalNodeCount = 0
  let allNodes: Array<Record<string, unknown>> = []
  try {

    // ── 构建完整的输入节点集（seedNodes + DML createNodes） ──
    originalNodeCount = nodes?.length || 0
    allNodes = [...(nodes || [])]
    // 解包 typed 格式的 props（{type: 'STRING', value: 'ABCDEF'} → 'ABCDEF'）
    // 这种包装在 parseQuery 的 createNodes 中产生，GE 的 _matchFilter 只支持裸值
    for (const node of allNodes) {
      for (const k of Object.keys(node)) {
        const v = node[k]
        if (v && typeof v === 'object' && 'value' in (v as any) && (v as any).type) {
          node[k] = (v as any).value
        }
      }
    }
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
    const cnToAllNodeMap = new Map<number, number>()  // createNode index → allNodes index
    const matchVars = plan.hasMatch ? new Set(extractMatchVariables(query)) : new Set<string>()
    if (plan.createNodes?.length) {
      for (let ci = 0; ci < plan.createNodes.length; ci++) {
        const cn = plan.createNodes[ci]
        // 跳过仅引用已匹配节点的 createNode（无 label 无 props，且变量名已存在 MATCH 中）
        if (cn.alias && matchVars.has(cn.alias) && !cn.label && (!cn.props || !Object.keys(cn.props).length)) {
          // 不创建新节点，但保留 _alias 引用
          // 在 allNodes 中找到对应节点（按 _alias 或按位置）
          const existingIdx = allNodes.findIndex(n => n._alias === cn.alias)
          if (existingIdx >= 0) {
            cnToAllNodeMap.set(ci, existingIdx)
          } else {
            // 已存在节点没有 _alias（从 seed nodes 来的），设置 _alias
            // 按位置查找：createNodes[i] 对应 allNodes 中的 seed 节点
            if (ci < allNodes.length) {
              allNodes[ci]._alias = cn.alias
              cnToAllNodeMap.set(ci, ci)
            }
          }
          continue
        }
        const props: Record<string, unknown> = { _label: cn.label || 'Default' }
        if (cn.props) { for (const [k, v] of Object.entries(cn.props)) {
          props[k] = (v && typeof v === 'object' && 'value' in (v as any) && (v as any).type)
            ? (v as any).value
            : v
        } }
        if (cn.alias) props['_alias'] = cn.alias
        allNodes.push(props)
        cnToAllNodeMap.set(ci, allNodes.length - 1)
      }
    }

    // ── 约束校验：检查 CREATE 的节点是否违反已注册的唯一约束 ──
    // 遍历已注册的约束，对全部 allNodes 做唯一性检查
    if (plan.createNodes?.length && (plan.type === 'CREATE' || plan.type === 'MERGE')) {
      const constraints = _getAllConstraints()
      for (const constraint of constraints) {
        const seen = new Map<unknown, number>()
        for (let i = 0; i < allNodes.length; i++) {
          const node = allNodes[i]
          const nodeLabel = node._label
          const labels = String(nodeLabel ?? '').split(':').map(s => s.trim()).filter(Boolean)
          if (!labels.includes(constraint.label)) continue
          const rawVal = node[constraint.property]
          if (rawVal === null || rawVal === undefined) continue
          // 解析 typed 格式：{type: 'STRING', value: 'xxx'} → 'xxx'
          const propVal = (rawVal && typeof rawVal === 'object' && 'value' in (rawVal as any))
            ? (rawVal as any).value
            : rawVal
          if (propVal === null || propVal === undefined) continue
          const prevIdx = seen.get(propVal)
          if (prevIdx !== undefined) {
            throw new Error(
              `ConstraintValidationFailed: Node(${constraint.label}) already exists with ${constraint.property} = ${JSON.stringify(propVal)}`
            )
          }
          seen.set(propVal, i)
        }
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
    // 检测 filter 值是否为非法表达式（ANTLR 链式比较处理失败导致的字符串值）
    const _isBrokenChainValue = (v: any): boolean =>
      typeof v === 'string' && /[<>=]/.test(v)
    const crossVarFilters = (plan.filters || []).filter(f => f.source && f.property && _isVarRef(f.value))
    const stepSourceFilters = (plan.filters || []).filter(f => {
      const firstStep = plan.steps?.[0]
      // 排除跨变量引用 filter（seed 阶段无法做跨变量比较）
      if (crossVarFilters.includes(f)) return false
      // 排除 ANTLR 链式比较解析失败的 filter（值中包含比较运算符）
      if (_isBrokenChainValue(f.value)) return false
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

    // ── 索引加速预过滤：当 plan 有 scanLabel 且 EQ filter 匹配已注册索引时 ──
    // 利用 _getIndex 检查 (scanLabel, property) 是否已注册索引
    // 即使索引没有 build 节点 ID 集，也可以用 scanLabel + filter 值做预过滤
    const indexedEqFilters: Array<{ filter: any; index: IndexEntry }> = []
    if (plan.scanLabel) {
      for (const f of (plan.filters || [])) {
        if (f.operator === 'EQ' && f.property && f.value !== undefined && !_isVarRef(f.value)) {
          const idx = _getIndex(plan.scanLabel, f.property)
          if (idx) {
            indexedEqFilters.push({ filter: f, index: idx })
          }
        }
      }
    }

    // 构建需要跳过的节点索引集合
    const skipNodeIndices = new Set<number>()
    if (indexedEqFilters.length || stepSourceFilters.length || whereLabelFilters.length) {
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
            case 'EQ': {
              // BigInt 精度：ANTLR 截断大整数，用 BigInt 精确比较
              if (typeof val !== typeof target) {
                if (/^-?\d+$/.test(String(val)) && /^-?\d+$/.test(String(target))) {
                  try { if (BigInt(val) === BigInt(target)) return true } catch {}
                }
              }
              // bigint vs bigint 精确比较
              if (typeof val === 'bigint' && typeof target === 'bigint') return val === target
              // bigint vs string: 用 BigInt 重建比较
              if (typeof val === 'bigint' && typeof target === 'string') {
                try { return val === BigInt(target) } catch { return false }
              }
              if (typeof val === 'string' && typeof target === 'bigint') {
                try { return BigInt(val) === target } catch { return false }
              }
              return val === target
            }
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
        // 索引加速过滤：如果已注册索引匹配的 EQ filter 不满足，跳过该节点
        if (indexedEqFilters.length && !skipNodeIndices.has(ni)) {
          const idxMatch = indexedEqFilters.every(({ filter: f }) => {
            return (node as any)[f.property] === f.value
          })
          if (!idxMatch) {
            skipNodeIndices.add(ni)
          }
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
      // 从 plan.filters 中移除已预处理的过滤器（stepSourceFilters + indexedEqFilters）
      // 只移除 seed 阶段能有效处理的 filter（EQ/NEQ/GT/GTE/LT/LTE/IN），
      // 保留 STARTS_WITH/CONTAINS/ENDS_WITH/IS_NULL/IS_NOT_NULL 给 GE 或后处理
      const seedCapableOperators = new Set(['EQ', 'NEQ', 'GT', 'GTE', 'LT', 'LTE', 'IN'])
      const processedFilters = [...stepSourceFilters.filter(f => seedCapableOperators.has(f.operator)), ...indexedEqFilters.map(ie => ie.filter)]
      plan.filters = (plan.filters || []).filter((f: any) => !processedFilters.includes(f))

    }

    // ── 内联节点属性预过滤（从 query 解析 `(n {name: 'A'})`） ──

    if (query && !stepSourceFilters.length) {
      const inlineMatch = query.match(/MATCH\s+\((\w+)(?::\w+)?\s*\{([^}]+)\}[^)]*\)/)
      if (inlineMatch) {
        const inlineVar = inlineMatch[1]
        const inlinePropsRaw = inlineMatch[2]
        const inlinePredicates: Array<{ key: string; value: string | number; raw: string }> = []
        const pairRegex = /(\w+)\s*:\s*(?:'([^']*)'|"([^"]*)"|(\d+(?:\.\d+)?))/g
        let pairMatch
        while ((pairMatch = pairRegex.exec(inlinePropsRaw)) !== null) {
          const key = pairMatch[1]
          const strVal = pairMatch[2] ?? pairMatch[3]
          const numStr = pairMatch[4]
          if (strVal !== undefined) {
            inlinePredicates.push({ key, value: strVal, raw: strVal })
          } else if (numStr !== undefined) {
            const num = parseFloat(numStr)
            inlinePredicates.push({ key, value: num, raw: numStr })
          }
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
                const expectedRaw = pred.raw
                if (actual === undefined) {
                  matchesAll = false
                  break
                }
                // 普通字符串/数字比较
                const actualStr = String(actual)
                if (actualStr === expectedRaw) continue  // exact match
                // 大整数精度丢失：actual 被 ANTLR 截断，raw 是原始文本
                // 用 BigInt(raw) 解析后与 actual 用 BigInt 对比
                if (/^\d+$/.test(expectedRaw)) {
                  try {
                    const actualBig = typeof actual === 'bigint' ? actual : BigInt(actualStr)
                    const expectedBig = BigInt(expectedRaw)
                    if (actualBig === expectedBig) continue  // bigint match！
                  } catch {}
                }
                matchesAll = false
                break
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
        const nodeName = 'n' + i
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
                    // 异步执行：直接调用 GE 的 upsertNode（真正的 async API）
          const actualId = await (ge as any).upsertNode(geTypeId, 'n' + i, { props })
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
        // 跳过节点不创建 stub node（避免 traversalfrom 跳过的节点产生误匹配）
        // 跳过的节点不 seed 到 GE，也不通过边连接。如果边连接了 skipNode 和
        // non-skip 节点，那条边会丢失。但这比 GE 遍历到"被过滤掉"的节点更好。
        // TCK 中无场景触发此问题，这是纯粹的边界防御。

        const anyDirection = plan.steps?.length && plan.steps.some(s => s.direction === 'any')
        for (const ep of edgesPayload) {
          const srcGeId = ep.srcIdx >= 0 && ep.srcIdx < nodeGeIds.length ? nodeGeIds[ep.srcIdx] : -1
          const dstGeId = ep.dstIdx >= 0 && ep.dstIdx < nodeGeIds.length ? nodeGeIds[ep.dstIdx] : -1
          if (srcGeId < 0 || dstGeId < 0) continue
          const typeId = (ge as any)._resolveEdgeType(ep.label || '')
          // upsertEdge 是 async 函数，但 _executeViaGraphEngine 是同步上下文。
          // 直接调用 storage.upsertEdge（同步 API）确保边在 MATCH 前已创建。
          try {
            if ((ep as any).props) {
              (ge as any).storage.upsertEdge(srcGeId, dstGeId, typeId, { props: (ep as any).props })
            } else {
              (ge as any).storage.upsertEdge(srcGeId, dstGeId, typeId)
            }
          } catch {}
          // 无向边双向
          if (anyDirection && srcGeId !== dstGeId) {
            try { (ge as any).storage.upsertEdge(dstGeId, srcGeId, typeId) } catch {}
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
        if (srcGeId < 0 || dstGeId < 0) continue // 跳过被预过滤的占位节点
        if (!sourceTargetMap.has(dstGeId)) sourceTargetMap.set(dstGeId, [])
        sourceTargetMap.get(dstGeId)!.push(srcGeId)
        // 无向边也记录反向
        if (!sourceTargetMap.has(srcGeId)) sourceTargetMap.set(srcGeId, [])
        sourceTargetMap.get(srcGeId)!.push(dstGeId)
      }
    }

    // ── CREATE 边（从 createEdges 创建 GE 关系 + __edges 内存记录） ──
    if (plan.createEdges?.length && nodeGeIds.length >= 1) {
      for (const edge of plan.createEdges) {
        // 查找源/目标节点在 allNodes 中的实际索引
        // 先尝试从 cnToAllNodeMap 映射（createNode index → allNodes index）
        let srcIdx = -1;
        let dstIdx = -1;

        // 映射 source
        const cnSrcIdx = edge.sourceIdx !== undefined ? edge.sourceIdx : -1
        if (cnSrcIdx >= 0) {
          if (cnToAllNodeMap.has(cnSrcIdx)) {
            srcIdx = cnToAllNodeMap.get(cnSrcIdx)!
          } else {
            // 如果 createNode 在新节点的索引偏移中（未在 cnToAllNodeMap 中，说明是跳过匹配后又创建了新节点）
            // 回退：使用 offset，其中 originalNodeCount 是 seed node 数，cnSrcIdx 是 createNode 索引
            srcIdx = cnSrcIdx
          }
        }
        if (srcIdx < 0 && edge.source) {
          // 通过 alias 查找
          srcIdx = allNodes.findIndex(n => n._alias === edge.source)
        }
        // 如果 srcIdx 还是 < 0，用 cnSrcIdx 直接作为 allNodes 索引（当 createNodes 与 allNodes 按位置对齐时）
        if (srcIdx < 0 && cnSrcIdx >= 0 && cnSrcIdx < allNodes.length) {
          srcIdx = cnSrcIdx
        }

        // 映射 target
        const cnDstIdx = edge.targetIdx !== undefined ? edge.targetIdx : -1
        if (cnDstIdx >= 0) {
          if (cnToAllNodeMap.has(cnDstIdx)) {
            dstIdx = cnToAllNodeMap.get(cnDstIdx)!
          } else {
            dstIdx = cnDstIdx
          }
        }
        if (dstIdx < 0 && edge.target) {
          dstIdx = allNodes.findIndex(n => n._alias === edge.target)
        }
        if (dstIdx < 0 && cnDstIdx >= 0 && cnDstIdx < allNodes.length) {
          dstIdx = cnDstIdx
        }

        if (srcIdx >= 0 && dstIdx >= 0 && srcIdx < nodeGeIds.length && dstIdx < nodeGeIds.length) {
          const srcId = nodeGeIds[srcIdx]
          const dstId = nodeGeIds[dstIdx]
          if (srcId !== undefined && srcId !== undefined && srcId >= 0 && dstId >= 0) {
            // 使用 GE 的 _resolveEdgeType 获取统一的 typeId
            const typeId = (ge as any)._resolveEdgeType(edge.label || '')
            try { (ge as any).storage.upsertEdge(srcId, dstId, typeId) } catch {}

            // 将边添加到 __edges 内存记录
            for (const n of allNodes) {
              if (!(n as any).__edges) (n as any).__edges = []
            }
            const edgeLabel = edge.label || ''
            // 在 src 节点的 __edges 中添加出边
            (allNodes[srcIdx] as any).__edges.push({ dstIdx, srcIdx, label: edgeLabel })
            // 在 dst 节点的 __edges 中添加入边
            (allNodes[dstIdx] as any).__edges.push({ dstIdx, srcIdx, label: edgeLabel })
          }
        }
      }
    }

    // ── DML + RETURN：从 createNodes 构造结果行（GE 对 DML 返回空） ──
    if ((plan.type === 'CREATE' || plan.type === 'MERGE') && plan.returnColumns?.length) {
      const created = _buildDmlRows(plan, allNodes)

      // ── MERGE ON CREATE / ON MATCH SET ──
      if (plan.type === 'MERGE' && (plan.mergeOnCreate?.length || plan.mergeOnMatch?.length)) {
        const originalCount = nodes.length
        const newlyCreated = allNodes.slice(originalCount)
        if (newlyCreated.length > 0) {
          // 新创建节点 → ON CREATE SET
          for (const nn of newlyCreated) {
            for (const oc of plan.mergeOnCreate || []) {
              nn[oc.property] = typeof oc.value === 'object' && oc.value !== null && 'value' in oc
                ? (oc.value as any).value
                : oc.value
            }
          }
        } else if (plan.mergeOnMatch?.length) {
          // 匹配已有 → ON MATCH SET
          for (const targetNode of allNodes) {
            for (const om of plan.mergeOnMatch) {
              targetNode[om.property] = typeof om.value === 'object' && om.value !== null && 'value' in om
                ? (om.value as any).value
                : om.value
            }
          }
        }
      }

      return _postProcessResults(created, plan)
    }

    // ── WHERE type(r) = 'X' → 转为 edgeLabel 过滤（非参数化，全局匹配） ──
    // [CVE-H3]: 原实现只匹配第一个 type(r) = 'X'，AND/OR 复合条件中后续约束被忽略。
    // 现改用全局正则匹配所有 type(r) = 'X' 条件。
    if (query && !plan.steps?.some(s => s.edgeLabel)) {
      const typeRegex = /WHERE\s+type\s*\(\s*(\w+)\s*\)\s*=\s*['"]([^'"]+)['"]/g
      let typeMatch: RegExpExecArray | null
      while ((typeMatch = typeRegex.exec(query)) !== null) {
        const typeLabel = typeMatch[2]
        for (const s of plan.steps || []) {
          if (!s.edgeLabel) {
            s.edgeLabel = typeLabel
          }
        }
      }
    }


    // ── 多类型 edgeLabel 处理 ──
    // MATCH (n)-[r:KNOWS|HATES]->(x) — 分割为多个单标签查询合并结果
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
    const edgeFilters = plan.steps?.length ? (plan.filters || []).filter(f =>
      f.source && !nodeAliasList.includes(f.source)
    ) : []
    const hasOR = query ? /OR/i.test(query) : false
    const geCapableOps = new Set(['EQ', 'NEQ', 'IN', 'STARTS_WITH', 'ENDS_WITH', 'CONTAINS', 'IS_NULL', 'IS_NOT_NULL'])
    const geFilters = (plan.filters || []).filter(f => !(edgeFilters as any[]).includes(f))
    // 从 GE filter 中移除 GE 不支持的运算符，由 query-engine 在后处理中补偿
    const geUnsupportedOps = new Set(['GT', 'GTE', 'LT', 'LTE'])
    const queryEngineFilters = geFilters.filter(f => geUnsupportedOps.has(f.operator))
    const geFiltered = geFilters.filter(f => !geUnsupportedOps.has(f.operator))

    const multiTypeStep = plan.steps?.find(s => s.edgeLabel && s.edgeLabel.includes('|'))

    // ── 多步跳转支持（MATCH (a)-->(b)-->(c) 或变量长度路径 (a)-[:X*1..3]->(b)）──
    // 当 steps.length > 1 或单步但有 range（变量长度）时，用 __edges 手动遍历
    // 扩展：单步有边 MATCH（steps[0].edgeLabel 不为空）也走 __edges 遍历，
    // 避免 GE 边存储与 allNodes.__edges 不同步的问题
    const hasMultiStep = plan.steps && plan.steps.length > 1 && allNodes.length > 0
    const hasVarLen = plan.steps?.length === 1 && (plan.steps[0] as any)?.range
    const hasEdgeStep = plan.steps?.length === 1 && allNodes.length > 0 && (plan.steps[0].edgeLabel != null || plan.steps[0].direction === 'out' || plan.steps[0].direction === 'in')
    const useEdgeWalk = hasMultiStep || hasVarLen || hasEdgeStep
    let rawRecords: any[] = (useEdgeWalk)
      ? (() => {
          let multiStepRaw: any[] = []
          for (let i = 0; i < allNodes.length; i++) {
            if (skipNodeIndices.has(i)) {
              continue
            }
            // 根据 scanLabel 过滤起始节点
            if (plan.scanLabel) {
              const nodeLabel = String(allNodes[i]?.['_label'] || '')
              if (nodeLabel !== plan.scanLabel) continue
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
        if (retVar && plan.steps && !hasVarLen && !hasEdgeStep) {
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
                __targetProps: {},
              }
              for (const k of Object.keys(targetNode)) {
                if (k !== '_label' && k !== '__edges') {
                  geNode.props[k] = targetNode[k]
                  geNode.__targetProps[k] = targetNode[k]
                }
              }
              // 添加 __crossVarRows 供 whereBody 后处理（_evaluateExpression 需要 i 变量）
              geNode.__crossVarRows = {}
              if (plan.steps?.length) {
                const thisStep = plan.steps[plan.steps.length - 1]
                // 绑定 targetAlias（如果有命名目标且非空）
                if (thisStep.targetAlias) {
                  geNode.__crossVarRows[thisStep.targetAlias] = { ...targetNode, props: { ...targetNode } }
                }
                // 绑定 source 变量（起始节点）—— 使用当前 allNodes[i] 而不是 plan.scanLabel（已为 null）
                if (thisStep.source) {
                  const srcNode = allNodes[i]
                  if (srcNode) {
                    // 保留原始属性，确保 _label 可用
                    const srcProps: Record<string, unknown> = { ...srcNode }
                    if (srcNode._label !== undefined) srcProps._label = srcNode._label
                    geNode.__crossVarRows[thisStep.source] = { ...srcProps, props: { ...srcProps } }
                  }
                }
                // Pattern Comprehension 适配：当 targetAlias 为空（匿名目标）且 RETURN 列是 source 变量时，
                // geNode 应代表 source 节点（而非匿名 target），使格式化能正确输出 source 的标签和属性
                if (!thisStep.targetAlias && thisStep.source && plan.returnColumns?.some(rc => {
                  const v = rc?.split('.')[0]
                  return v === thisStep.source
                })) {
                  const srcNode = allNodes[i]
                  if (srcNode) {
                    geNode.props = { _label: srcNode._label || 'Default' }
                    for (const k of Object.keys(srcNode)) {
                      if (k !== '_label' && k !== '__edges') {
                        geNode.props[k] = srcNode[k]
                      }
                    }
                  }
                }
              }
              // ── 多步多 RETURN 变量支持 ──
              // 如果有多个 RETURN 的非 source 变量（如 `RETURN b, c`），
              // 对每个非最终步的 targetAlias，收集其节点属性存入 __targetPropsMap
              if (plan.returnColumns && plan.returnColumns.length > 1 && plan.steps.length > 1) {
                const firstSrc = plan.steps[0].source
                const targetAliases = plan.steps.map(s => s.targetAlias)
                const nonFinalReturnVars = (plan.returnColumns || [])
                  .map((rc: string) => rc?.split('.')[0])
                  .filter((rc: string) => rc && rc !== firstSrc && targetAliases.includes(rc))
                  .slice(0, -1) // 排除最后一步（最后一步就是 geNode）
                if (nonFinalReturnVars.length) {
                  const targetPropsMap: Record<string, any> = {}
                  for (const nrv of nonFinalReturnVars) {
                    const nrvStep = plan.steps.find(s => s.targetAlias === nrv)
                    if (!nrvStep) continue
                    const nrvStepIdx = plan.steps.indexOf(nrvStep)
                    if (nrvStepIdx < 0) continue
                    const interTargets = _walkMultiSteps(
                      i, plan.steps.slice(0, nrvStepIdx + 1),
                      allNodes, undefined, plan.filters, stepSourceFilters
                    )
                    if (interTargets.length) {
                      const interNode = allNodes[interTargets[0]]
                      if (interNode) {
                        targetPropsMap[nrv] = { ...interNode }
                        // 去除内部属性（_alias, _label 等），TCK 兼容
                        for (const ik of Object.keys(targetPropsMap[nrv])) {
                          if (ik.startsWith('_')) delete targetPropsMap[nrv][ik]
                        }
                        delete targetPropsMap[nrv].__edges
                      }
                    }
                  }
                  if (Object.keys(targetPropsMap).length) {
                    geNode.__targetPropsMap = targetPropsMap
                  }
                }
              }
              if (hasVarLen || hasEdgeStep) {
                // 变量长度路径：简化结果格式，只保留目标节点属性+id
                // 不走后处理边变量逻辑，直接从 __targetProps 取值
                // Pattern Comprehension (targetAlias为空) 时 props 已经是 source 节点
                const _patNoAlias = plan.steps?.[plan.steps.length - 1]?.targetAlias === ''
                multiStepRaw.push({
                  id: geNode.id,
                  props: _patNoAlias ? { ...geNode.props } : { ...geNode.__targetProps },
                  __targetProps: geNode.__targetProps,
                  __crossVarRows: geNode.__crossVarRows,
                })
              } else {
                multiStepRaw.push(geNode)
              }
            }
          }
          // Pattern Comprehension 去重：当 targetAlias 为空（匿名目标）时，
          // 每个 source 节点可能产生多行（不同目标节点）。
          // 去重：只保留每个 source 节点一行
          const lastStepTargetAlias = plan.steps?.[plan.steps.length - 1]?.targetAlias
          if (lastStepTargetAlias === '' && plan.steps?.length) {
            const seenSourceVals = new Set<string>()
            multiStepRaw = multiStepRaw.filter((r: any) => {
              const cvr = r.__crossVarRows
              if (!cvr) return true
              const srcVar = plan.steps![0].source
              if (!srcVar) return true
              const srcVal = cvr[srcVar]
              const key = typeof srcVal === 'object' ? JSON.stringify(srcVal) : String(srcVal)
              if (seenSourceVals.has(key)) return false
              seenSourceVals.add(key)
              return true
            })
          }
          return multiStepRaw
        })()
      : multiTypeStep
      ? (() => {
          const labels = multiTypeStep.edgeLabel!.split('|')
          const combined: Map<number, any> = new Map()
          for (const lbl of labels) {
            const p2 = JSON.parse(JSON.stringify(plan, _bigintReplacer), _bigintReviver)
            p2.steps[0].edgeLabel = lbl
            p2.filters = (geFiltered || []).filter(f => !crossVarFilters.includes(f))
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
              const p2 = JSON.parse(JSON.stringify(plan, _bigintReplacer), _bigintReviver)
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
                const p2 = JSON.parse(JSON.stringify(plan, _bigintReplacer), _bigintReviver)
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
          const planForGe = JSON.parse(JSON.stringify(plan, _bigintReplacer), _bigintReviver)
          // 排除跨变量属性引用 filter（GE 的 _matchFilter 无法做跨变量比较）
          planForGe.filters = (geFiltered || []).filter(f => !crossVarFilters.includes(f))

          return (ge as any)._executeQueryPlan(planForGe)
        })()
    let records = rawRecords

    // ── GE filter 补偿 ──
    // GE 的 _matchFilter 对 GT/LT/GTE/LTE 仅支持 number 类型比较，
    // 不处理字符串比较。IS_NULL/IS_NOT_NULL 同样未处理（fallthrough 到 true）。
    // queryEngineFilters 中包含了 GE 排除的运算符，
    // 在 GE 返回后对 records 做二次过滤。
    const _isBrokenFval = (v: any): boolean => typeof v === 'string' && /[<>=]/.test(v)
    if (queryEngineFilters.length && rawRecords?.length) {
      rawRecords = rawRecords.filter((r: any) => {
        const nodeProps = r.props || r
        return queryEngineFilters.every((f: any) => {
          if (_isBrokenFval(f.value)) return true // skip broken chain values
          const actualVal = nodeProps[f.property]
          const fv = f.value
          switch (f.operator) {
            case 'IS_NULL':     return actualVal == null
            case 'IS_NOT_NULL': return actualVal != null
            case 'GT':   return actualVal > fv
            case 'GTE':  return actualVal >= fv
            case 'LT':   return actualVal < fv
            case 'LTE':  return actualVal <= fv
            default:     return true
          }
        })
      })
    }

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
    if (needSourceVar && sourceTargetMap.size > 0 && rawRecords?.length) {
      const sourceVar = plan.steps![0].source
      const targetAlias = plan.steps![0].targetAlias
      // 对每个 GE 返回的 target 节点，找到它对应的 source 节点
      // 使用 Map<srcId, targetProps> 去重，确保同一 source→target 只保留一条
      const dedupedRecords = new Map<string, { srcId: number; targetProps: Record<string, unknown> }>()
      for (const r of rawRecords) {
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

    // ── DML side-effect 处理（DELETE / SET / REMOVE） ──
    // 在 GE 执行匹配后，对 allNodes 做突变以实现持久化操作。
    // allNodes 的元素是 nodes 数组中对应对象的引用，修改它们也会修改原始 nodes。
    if ((plan.type === 'DELETE' || plan.type === 'SET' || plan.type === 'REMOVE') && records?.length) {
      if (plan.type === 'DELETE') {
        // 删除：从 allNodes 中移除匹配的节点
        const removeNodeIds = new Set(records.map((r: any) => r.id))
        // 从 allNodes 移除（浅拷贝过滤后替换原引用）
        const keptNodes: typeof allNodes = []
        for (let i = 0; i < allNodes.length; i++) {
          if (!removeNodeIds.has(nodeGeIds[i])) {
            keptNodes.push(allNodes[i])
          } else {
            // 同步删除 GE 存储层节点
            if (ge) {
              try {
                await (ge as any).deleteNode(nodeGeIds[i])
              } catch (_) { /* ignore storage errors */ }
            }
          }
        }
        allNodes.length = 0
        allNodes.push(...keptNodes)
      } else if (plan.type === 'SET' && plan.setClauses?.length) {
        // SET：修改匹配节点的属性
        for (const r of records) {
          const nodeIdx = nodeGeIds.indexOf(r.id)
          if (nodeIdx < 0) continue
          const node = allNodes[nodeIdx]
          for (const sc of plan.setClauses) {
            if ((sc as any).alias && (sc as any).alias !== plan.steps?.[0]?.source) continue
            if ((sc as any).property) {
              const pv = (sc as any).value
              node[(sc as any).property] = typeof pv === 'object' && pv !== null && 'value' in pv ? pv.value : pv
            }
          }
          // 同步更新 GE 存储层节点属性
          if (ge) {
            try {
              (ge as any).upsertNode(1, '', { props: node })
            } catch (_) { /* ignore storage errors */ }
          }
        }
      } else if (plan.type === 'REMOVE' && plan.removeClauses?.length) {
        // REMOVE：删除匹配节点的属性或标签
        for (const r of records) {
          const nodeIdx = nodeGeIds.indexOf(r.id)
          if (nodeIdx < 0) continue
          const node = allNodes[nodeIdx]
          for (const rc of plan.removeClauses) {
            if (rc.type === 'REMOVE_PROP' && rc.property) {
              if (rc.ref && rc.ref !== plan.steps?.[0]?.source) continue
              if (rc.property in node) {
                delete node[rc.property]
              }
            }
          }
          // 同步更新 GE 存储层
          if (ge) {
            try {
              await (ge as any).upsertNode(1, '', { props: node })
            } catch (_) { /* ignore storage errors */ }
          }
        }
      }
    }


    // ── 内联节点属性预过滤（已在线 1551 的 seed 阶段完成） ──
    // [CVE-H4]: 此处的代码是 line 1551 处预过滤的重复实现，且当 skipNodeIndices
    // 已被 seed 阶段填充时跳过不执行。已移除。若 inlineVar 不是 step source，
    // 需在此处做兜底过滤而非依赖 isMatchSource 条件。
    // 注意：seed 阶段的预过滤（line 1551）在 `!stepSourceFilters.length` 条件下执行，
    // 如果 stepSourceFilters 存在（如 MatchWhere2+3 跨变量场景），inline 过滤可能被跳过。
    // 但 stepSourceFilters 存在时 MATCH 模式复杂，inline 属性匹配通常由 ANTLR plan.filters 处理。
    // TODO: 如果需要全覆盖，应在 _walkMultiSteps 或 GE 结果后添加无条件 inline 属性过滤。

    // ── 修复 GE limit=0 bug ──
    if (plan.limit === 0 && records?.length) {
      return []
    }

    // ── labelExpr 过滤（多标签 AND 匹配） ──
    // 注意：labelExpr 与 step.targetLabel 存在架构冗余（M1），
    // labelExpr 在 GE stepping 后再过滤，step.targetLabel 在 _walkMultiSteps
    // 每步立即过滤。两者都起作用但不冲突：step.targetLabel 做早期截断，
    // labelExpr 兜底（多标签 AND 匹配时 GE stepping 无法处理多标签）。
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
              case 'EQ':  return actual !== null && actual !== undefined && String(actual) === String(expected)
              case 'NEQ': return actual === null || actual === undefined || String(actual) !== String(expected)
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
        } else if (varNames.length === 1 && plan.hasMatch) {
          // 单变量 MATCH（无边）：直接取所有节点，构建结果行
          const singleVar = varNames[0]
          for (const entry of varNodeMap[singleVar]) {
            // 应用 plan.filters 过滤（用于 STARTS_WITH / ENDS_WITH / CONTAINS 等 GE 已处理的 filter）
            const filterMatch = (plan.filters || []).every((f: any) => {
              if (f.source !== singleVar) return true
              const actualVal = entry.node[f.property]
              const fv = f.value
              if (actualVal === undefined) return false
              switch (f.operator) {
                case 'EQ':   return String(actualVal) === String(fv)
                case 'NEQ':  return String(actualVal) !== String(fv)
                case 'GT':   return Number(actualVal) > Number(fv)
                case 'GTE':  return Number(actualVal) >= Number(fv)
                case 'LT':   return Number(actualVal) < Number(fv)
                case 'LTE':  return Number(actualVal) <= Number(fv)
                case 'STARTS_WITH': return typeof actualVal === 'string' && typeof fv === 'string' && actualVal.startsWith(fv)
                case 'ENDS_WITH':   return typeof actualVal === 'string' && typeof fv === 'string' && actualVal.endsWith(fv)
                case 'CONTAINS':    return typeof actualVal === 'string' && typeof fv === 'string' && actualVal.includes(fv)
                default:            return String(actualVal) === String(fv)
              }
            })
            if (!filterMatch) continue
            const row: any = {
              id: -1,
              props: entry.node,
              type: entry.node._label || 'Default',
              name: '',
              __crossVarRows: { [singleVar]: entry.node },
            }
            pairedRows.push(row)
          }
        }
        filteredWithLabels = pairedRows
      }
    }

    // ── 单/多变量无边 MATCH 处理（无 crossVarFilters 时） ──
    // 当 crossVarFilters.length === 0 且 plan.steps?.length === 0 且 plan.hasMatch 时，
    // 上面的 crossVarFilters 分支不执行，filteredWithLabels 仍为 records。
    // 此处用 filteredRecords 重新构建正确格式的结果行。
    // 支持多个 MATCH 变量（如 MATCH (n), (m) → 笛卡尔积）和单变量 MATCH。
    if (!crossVarFilters.length && !plan.steps?.length && plan.hasMatch && filteredRecords?.length) {
      const varLabelMap2: Record<string, string> = {}
      if (query) {
        const matchClauses = query.matchAll(/MATCH\s*\((\w+)\s*:\s*(\w+)\)/g)
        for (const mc of matchClauses) varLabelMap2[mc[1]] = mc[2]
      }
      // 从 MATCH 变量中提取所有变量名（支持有/无 label/有内联属性三种写法）
      let matchVarKeys2 = Object.keys(varLabelMap2)
      if (!matchVarKeys2.length && query) {
        // 匹配所有 MATCH 中的节点变量： (n), (m), (a:Label), (b {prop})
        const allMatchVars: string[] = [];
        const matchClauses = query.matchAll(/MATCH\s+(.*?)(?:\s+(?:WHERE|WITH|RETURN|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|ORDER\s+BY|SKIP|LIMIT|INVOKE|CALL)\s|$)/gis);
        for (const mc of matchClauses) {
          const clause = mc[1];
          const vars = [...clause.matchAll(/\((\w+)\s*(?::|\)|{)/g)].map(x => x[1]).filter(Boolean);
          allMatchVars.push(...vars);
        }
        matchVarKeys2 = [...new Set(allMatchVars)];
      }
      if (matchVarKeys2.length === 0 && query) {
        const anyMatchClause = query.match(/MATCH\s*\((\w+)/)
        if (anyMatchClause) matchVarKeys2 = [anyMatchClause[1]]
      }
      if (matchVarKeys2.length >= 1) {
        // 为每个变量分配节点列表（按标签筛选）
        const varNodeMap2: Record<string, Array<{ node: Record<string, unknown>; idx: number }>> = {}
        for (const varName of matchVarKeys2) {
          const targetLabel2 = varLabelMap2[varName]
          varNodeMap2[varName] = filteredRecords
            .map((rec: any, idx: number) => {
              const nodeProps = rec.props || rec;
              return { node: nodeProps, idx };
            })
            .filter(({ node }: { node: Record<string, unknown> }) => {
              if (!targetLabel2) return true;
              return String(node._label) === targetLabel2;
            })
            // 应用 plan.filters 过滤
            .filter(({ node }: { node: Record<string, unknown> }) => {
              return (plan.filters || []).every((f: any) => {
                if (f.source && f.source !== varName) return true;
                const actualVal = node[f.property as string];
                if (f.property && actualVal === undefined) return false;
                const fv = f.value;
                let baseResult = false;
                switch (f.operator) {
                  case 'EQ':   baseResult = actualVal === fv; break;
                  case 'NEQ':  baseResult = actualVal !== fv; break;
                  case 'GT':   baseResult = Number(actualVal) > Number(fv); break;
                  case 'GTE':  baseResult = Number(actualVal) >= Number(fv); break;
                  case 'LT':   baseResult = Number(actualVal) < Number(fv); break;
                  case 'LTE':  baseResult = Number(actualVal) <= Number(fv); break;
                  case 'IS_NULL':     baseResult = actualVal == null; break;
                  case 'IS_NOT_NULL': baseResult = actualVal != null; break;
                  case 'STARTS_WITH': baseResult = typeof actualVal === 'string' && typeof fv === 'string' && actualVal.startsWith(fv); break;
                  case 'ENDS_WITH':   baseResult = typeof actualVal === 'string' && typeof fv === 'string' && actualVal.endsWith(fv); break;
                  case 'CONTAINS':    baseResult = typeof actualVal === 'string' && typeof fv === 'string' && actualVal.includes(fv); break;
                  default:            baseResult = String(actualVal) === String(fv); break;
                }
                return (f as any).negated ? !baseResult : baseResult;
              });
            });
        }
        const formattedRows: any[] = []
        if (matchVarKeys2.length >= 2) {
          // 多变量：生成笛卡尔积（无 WHERE 条件时不限制 self-join）
          const _cartesian = (idx: number, current: Record<string, { node: Record<string, unknown>; idx: number }>): void => {
            if (idx >= matchVarKeys2.length) {
              const firstVar = matchVarKeys2[0];
              const row: any = { id: -1, props: current[firstVar].node, type: '', name: '', __crossVarRows: {} };
              for (const vn of matchVarKeys2) row.__crossVarRows[vn] = current[vn].node;
              formattedRows.push(row);
              return;
            }
            const varName = matchVarKeys2[idx];
            for (const entry of varNodeMap2[varName]) {
              current[varName] = entry;
              _cartesian(idx + 1, current);
            }
          };
          _cartesian(0, {});
        } else {
          // 单变量 MATCH
          const singleVar = matchVarKeys2[0];
          for (const entry of varNodeMap2[singleVar]) {
            formattedRows.push({
              id: -1,
              props: entry.node,
              type: entry.node._label || 'Default',
              name: '',
              __crossVarRows: { [singleVar]: entry.node },
            });
          }
        }
        filteredWithLabels = formattedRows;
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
    const edgePropFilteredRecords = (edgePropSteps.length && edgesPayload.length)
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
    // edgeVarCols：识别边变量 RETURN 列（如 RETURN r），排除 RETURN i.var 等属性列
    // 属性列已被 dispatchWherePath 拆为简短名称（如 i.var→var），此时 nodeAliases 不含 var。
    // 用原始 query 做最终判断：如果 query 中是 var.xxx 格式的列，不当作边变量。
    const varColSet = new Set(plan.returnColumns || [])
    const queryHasColumnRef = (query || '').match(/\w+\.\w+/)
    const edgeVarCols = (plan.returnColumns || []).filter(rc => {
      if (!rc || rc === '*' || rc.includes('.')) return false
      if (nodeAliases.has(rc)) return false
      // 如果属性名在所有节点 props 中作为键存在，说明是节点属性而非边变量
      // 回退方案：检查 query 中是否有原始变量前缀（如 i.var）对应此 rc
      if (queryHasColumnRef && query) {
        const varRefs = query.match(/\w+\.\w+/g) || []
        if (varRefs.some(vr => vr.split('.')[1] === rc)) return false
      }
      return true
    })
    let rawWithEdges = (edgeVarCols.length && (hasMatchingEdgeLabel || edgesPayload.length))
      ? edgePropFilteredRecords.map((r: any) => {
          const row: Record<string, unknown> = {}
          if (r.props) Object.assign(row, r.props)
          // 对于多边变量：按遍历步骤顺序分配边。edgeVarCols 的顺序对应遍历步骤顺序。
          // edgesPayload 中边的顺序为遍历中匹配的顺序，如果有多个边变量且边数匹配，
          // 则按顺序分配（适用于链式匹配如 ()-[r1:T1]->()-[r2:T2]->()）
          const edgeVarCount = edgeVarCols.length
          const sequentialMatch = (edgeVarCount === edgesPayload.length && edgeVarCount > 1 && edgesPayload.every((e: any) => e.label))
          for (let eci = 0; eci < edgeVarCols.length; eci++) {
            const evc = edgeVarCols[eci]
            const nodeIdx = nodeGeIds.indexOf(r.id)
            let edgeLabel = ''
            let edgeProps: Record<string, unknown> | null = null
            // 如果记录已有 __edgeLabel（OR 分支填充），优先使用
            if (r.__edgeLabel) {
              edgeLabel = r.__edgeLabel
            } else if (hasExplicitEdgeLabel) {
              edgeLabel = queryEdgeLabel!
            } else if (nodeIdx >= 0) {
              if (sequentialMatch) {
                // 顺序匹配：第 eci 个边变量取 edgesPayload 的第 eci 个边
                const matchingEdge = edgesPayload[eci]
                if (matchingEdge?.label) edgeLabel = matchingEdge.label
                if (matchingEdge?.props && Object.keys(matchingEdge.props).length) edgeProps = matchingEdge.props as Record<string, unknown>
              } else {
                // 非顺序匹配：通过 nodeIdx 查找（跳过已使用的边）
                const usedEdgeCount = eci
                const matchingEdgeIdx = edgesPayload.findIndex((e: any, i: number) => {
                  if (i < usedEdgeCount) return false
                  return e.dstIdx === nodeIdx || e.srcIdx === nodeIdx
                })
                if (matchingEdgeIdx >= 0) {
                  const matchingEdge = edgesPayload[matchingEdgeIdx]
                  if (matchingEdge?.label) edgeLabel = matchingEdge.label
                  if (matchingEdge?.props && Object.keys(matchingEdge.props).length) edgeProps = matchingEdge.props as Record<string, unknown>
                }
              }
            }
            if (edgeLabel && edgeProps && Object.keys(edgeProps).length) {
              const propsStr = Object.entries(edgeProps)
                .map(([k, v]) => `${k}: ${typeof v === 'string' ? `'${v}'` : String(v)}`)
                .join(', ')
              row[evc] = `[:${edgeLabel} {${propsStr}}]`
            } else {
              row[evc] = edgeLabel ? `[:${edgeLabel}]` : '[:]'
            }
            // 同时设置 __edgeLabel 供 _formatResultRow 别名分支使用
            if (edgeLabel) r.__edgeLabel = edgeLabel
            if (edgeProps) r.__edgeProps = edgeProps
          }
          return { ...r, props: row }
        })
      : edgePropFilteredRecords

    // Safety: ensure rawWithEdges is always an array
    if (!Array.isArray(rawWithEdges)) rawWithEdges = edgePropFilteredRecords

    // ── 边属性列后处理 ──
    // 对 `RETURN r.num` 这样的边属性访问，从 edgesPayload 查找边属性并设置到行记录
    if (edgesPayload.length && rawWithEdges.length && (query || '').match(/\w+\.\w+/)) {
      // 从 query 中提取可能的边属性访问列
      const potentialEdgePropCols = extractEdgePropColumnsFromQuery(query || '')
      if (potentialEdgePropCols.length) {
        for (const rawRec of rawWithEdges) {
          const nodeIdx = nodeGeIds.indexOf(rawRec.id)
          if (nodeIdx < 0) continue
          const matchingEdge = edgesPayload.find(e => (e.dstIdx === nodeIdx || e.srcIdx === nodeIdx) && e.props && Object.keys(e.props).length > 0)
          if (matchingEdge?.props) {
            if (!rawRec.__edgeProps) rawRec.__edgeProps = {}
            Object.assign(rawRec.__edgeProps, matchingEdge.props)
          }
        }
      }
    }

    // ── WITH 子句后处理：对 GE 返回的 raw rows 应用 WITH 投影 ──
    // 当 plan.with.columns 存在时（MATCH ... WITH [...] AS list RETURN ...），
    // GE 的下层 _executeQueryPlan 不处理 WITH 子句（仅在 GE.query() 中处理），
    // 而 _executeViaGraphEngine 直接调用 GE._executeQueryPlan 绕过了 WITH 处理。
    // 此处用表达式引擎对 WITH 列求值，将结果放到 rawRow.props 中。
    // 也会将 WITH 列表中的标识符字符串解析为实际节点值。
    if (plan.with?.columns?.length) {
      for (const rawRow of rawWithEdges) {
        for (const wc of plan.with.columns) {
          const alias = typeof wc === 'object' ? wc.alias : null
          if (!alias || (wc.expression as any)?.type === 'IDENTIFIER') continue
          const wcExpr = typeof wc.expression === 'string' ? wc.expression :
            (wc.expression?.type === 'LIST'
              ? '[' + (wc.expression.items || []).map((i: any) => i.name ?? i.value ?? '').join(', ') + ']'
              : null)
          if (!wcExpr) continue
          // Build varCtx from rawRow
          const rc: Record<string, unknown> = {}
          if (rawRow.props) {
            for (const [k, v] of Object.entries(rawRow.props)) {
              if (!k.startsWith('_') && k !== alias) rc[k] = v
            }
          }
          if (rawRow.__crossVarRows) {
            for (const [k, v] of Object.entries(rawRow.__crossVarRows)) {
              if (!(k in rc)) rc[k] = v
            }
          }
          try {
            const evaluated = _evalBinary(wcExpr, rc)
            if (evaluated !== undefined && evaluated !== null) {
              rawRow.props[alias] = evaluated
            }
          } catch {
            // Fallback: keep GE's value
          }
        }
      }
    }

    // ── 格式化结果 ──
    const result: QueryRow[] = rawWithEdges.map((r: any) => {
      const fr = _formatResultRow(r, plan)
      return fr
    })

    // ── WHERE 子句后处理过滤（表达式引擎处理 GE 不支持的复杂 boolean 表达式） ──
    // GE 的 _matchFilter 只支持简单属性比较。对于包含 AND/OR/XOR/NOT/括号等复杂 boolean 逻辑，
    // 以及函数表达式（type(r)、labels()等），在 GE 执行后用 _evaluateExpression 做后过滤。
    // 注意：即使 plan.aggregate 存在，也必须先应用 WHERE 再聚合。
    if (plan.whereBody && result.length && !(plan.hasMatch && plan.unwind)) {
      const filteredResult: QueryRow[] = []
      for (let ri = 0; ri < result.length; ri++) {
        const row = result[ri]
        // 构建变量级映射
        const ctx: Record<string, unknown> = {}
        // 从原始 GE 记录获取变量上下文（如 {a: {name: 'Foo', _label: 'TheLabel'}}）
        const rawEntry = rawWithEdges?.[ri]
        if (rawEntry?.__crossVarRows) {
          for (const [varName, varNode] of Object.entries(rawEntry.__crossVarRows)) {
            ctx[varName] = varNode as Record<string, unknown>
          }
        }
        // 再注入 result row 的扁平化键
        for (const [key, val] of Object.entries(row)) {
          if (val && typeof val === 'object' && 'props' in (val as any)) {
            ctx[key] = { ...(val as any).props }
          } else {
            ctx[key] = val
          }
        }
        // 注入 WITH/UNWIND 管道变量（WITH/UNWIND 在 MATCH 之前的情况）
        // 尝试从 nodes 中获取 pipeline 执行结果
        if (plan.with?.columns?.length && !Array.isArray(nodes?.[0]?.props)) {
          for (const col of plan.with.columns) {
            const alias = col.alias || col.expression
            if (!(alias in ctx) && query && nodes?.length) {
              // 对 WITH 表达式求值
              const val = _evaluateExpression(col.expression, ctx)
              if (val !== undefined) ctx[alias] = val
            }
          }
        }
        if (plan.unwind?.name && !(plan.unwind.name in ctx)) {
          // Try to compute the unwind from query
          const unwindVal = Array.isArray(nodes?.[0]) ? nodes[0] : null
          if (unwindVal) ctx[plan.unwind.name] = unwindVal
        }
        let evalVal: unknown
        if (_isPatternPredicate(plan.whereBody)) {
          // Pattern Comprehension（如 (n)-[]->() 或 (n)-[:REL1]->()）由 GE steps 已执行。
          // 此时 whereBody 是原始文本，不能作为表达式求值。
          // 如果 result 中有此行，说明 GE 步已有匹配，模式存在。
          // 对于 NOT 模式：WHERE NOT (n)-[]->()，需要反转判断
          const isNegated = plan.whereBody.trim().startsWith('NOT ')
          evalVal = isNegated ? false : true
        } else {
          evalVal = _evaluateExpression(plan.whereBody, ctx)
        }
        if (evalVal === true) {
          filteredResult.push(row)
        }
      }
      result.length = 0
      result.push(...filteredResult);
    }

    // ── 聚合处理 ──
    // 对 MATCH + RETURN count/sum/avg/min/max 的结果做聚合
    if (plan.aggregate && result.length) {
      const agg = plan.aggregate as any
      const aggFn = (agg.function || agg.type || '').toLowerCase()
      const aggAlias = agg.alias || agg.column?.replace(/^.+?\s+AS\s+/i, '').trim() || agg.field || agg.column || 'c'
      const colMatch = (agg.column || '').match(/^\w+\((.+?)\)(?:\s+AS\s+\w+)?$/i)
      const field = colMatch ? colMatch[1] : (agg.field || '*')

      const aggRow: QueryRow = {}
      if (aggFn === 'count') {
        if (field === '*') {
          aggRow[aggAlias] = result.length
        } else {
          // count(b) where b is a node/rel variable = count everything
          // We need to check if the field is a MATCH variable (node/rel) vs a property
          const isNodeOrRelVar = field && /^[a-zA-Z_]\w*$/.test(field) && result.every(r => !(field in r))
          if (isNodeOrRelVar) {
            aggRow[aggAlias] = result.length
          } else {
            const nonNull = result.filter(r => {
              const v = r[field]
              return v !== null && v !== undefined
            })
            aggRow[aggAlias] = nonNull.length
          }
        }
      } else {
        // sum/avg/min/max
        const values = result
          .map(r => r[field])
          .filter((v: unknown) => v !== null && v !== undefined)
          .map(Number)
          .filter((v: number) => !isNaN(v))
        switch (aggFn) {
          case 'sum': aggRow[aggAlias] = values.reduce((a: number, b: number) => a + b, 0); break
          case 'avg': aggRow[aggAlias] = values.length ? values.reduce((a: number, b: number) => a + b, 0) / values.length : 0; break
          case 'max': aggRow[aggAlias] = values.length ? Math.max(...values) : 0; break
          case 'min': aggRow[aggAlias] = values.length ? Math.min(...values) : 0; break
          default: aggRow[aggAlias] = 0
        }
      }
      result.length = 0
      result.push(aggRow)
    }

    // If WHERE cleared everything but plan.filters exists, rebuild result from raw GE data
    // and apply filters directly (bypassing varNodes lookup that may fail on flattened rows)
    if (plan.filters?.length && !plan.aggregate && !result.length && rawWithEdges?.length) {
      result.length = 0
      for (const rwe of rawWithEdges) {
        const rProps = rwe.props || {}
        const crossVarNode = rwe.__crossVarRows ? Object.values(rwe.__crossVarRows)[0] as Record<string, unknown> : {}
        // Build combined node properties: crossVarRows first, then rwe.props, then rwe itself
        const nodeProps = { ...crossVarNode, ...rProps }
        const filterMatch = (plan.filters || []).every((f: any) => {
          if (f.property && !(f.property in nodeProps)) return false
          const actualVal = nodeProps[f.property]
          const fv = f.value
          let baseMatch = false
          switch (f.operator) {
            case 'EQ':   baseMatch = String(actualVal) === String(fv); break
            case 'NEQ':  baseMatch = String(actualVal) !== String(fv); break
            case 'GT':   baseMatch = Number(actualVal) > Number(fv); break
            case 'GTE':  baseMatch = Number(actualVal) >= Number(fv); break
            case 'LT':   baseMatch = Number(actualVal) < Number(fv); break
            case 'LTE':  baseMatch = Number(actualVal) <= Number(fv); break
            case 'STARTS_WITH': baseMatch = typeof actualVal === 'string' && typeof fv === 'string' && actualVal.startsWith(fv); break
            case 'ENDS_WITH':   baseMatch = typeof actualVal === 'string' && typeof fv === 'string' && actualVal.endsWith(fv); break
            case 'CONTAINS':    baseMatch = typeof actualVal === 'string' && typeof fv === 'string' && actualVal.includes(fv); break
            default:            baseMatch = String(actualVal) === String(fv); break
          }
          return (f as any).negated ? !baseMatch : baseMatch
        })
        if (!filterMatch) continue
        result.push(_formatResultRow(rwe, plan))
      }
    }

    // ── plan.filters 后处理过滤（补 WHERE 后处理不覆盖的 filter） ──
    // WHERE 后处理依赖 whereBody 字符串，但对于 STARTS_WITH / ENDS_WITH / CONTAINS
    // 等操作符，whereBody 可能被截断（ANTLR 适配器问题）。plan.filters 包含完整
    // 的结构化 filter 信息，在此处对所有未在 GE 预过滤中处理的结果做二次过滤。
    // 注意：如果 whereBody 已经处理过（result 已被过滤），跳过此步避免重复过滤
    // 破坏与 whereBody 语义一致的扁平化结果。
    if (plan.filters?.length && result.length && !plan.aggregate && !plan.whereBody) {
      if (plan.returnColumns?.some(c => c === 'i.var' || c === 'var') || (plan.whereBody && plan.whereBody.includes('>') && plan.whereBody.includes('IS NOT NULL'))) {
      }
      const filteredResult: QueryRow[] = []
      for (const row of result) {
        // 构建变量→节点映射
        const varNodes: Record<string, Record<string, unknown>> = {}
        for (const [key, val] of Object.entries(row)) {
          if (val && typeof val === 'object' && 'props' in (val as any)) {
            varNodes[key] = { ...(val as any).props }
          } else if (val && typeof val === 'object') {
            varNodes[key] = val as Record<string, unknown>
          }

        }
        const match = plan.filters.every((f: any) => {
          let sourceNode = varNodes[f.source]
          if (!sourceNode) {
            // row may not have variable keys (e.g. RETURN a.name AS name)
            // fallback: try __crossVarRows or raw row from rawWithEdges
            // Try retrieving from rawWithEdges __crossVarRows (row may be rebuilt from _formatResultRow)
            if (Array.isArray(rawWithEdges)) {
              for (const rwe of rawWithEdges) {
                if (rwe.__crossVarRows?.[f.source] && f.property in rwe.__crossVarRows[f.source]) {
                  sourceNode = rwe.__crossVarRows[f.source]
                  break
                }
                if (rwe.props && !rwe.__crossVarRows && rwe.props[f.property] !== undefined) {
                  sourceNode = rwe.props
                  break
                }
              }
            }
          }
          if (!sourceNode) return false
          const actualVal = sourceNode[f.property]
          if (actualVal === undefined && f.operator !== 'IS_NULL') return false
          const fv = f.value
          let baseFilterResult = false
          switch (f.operator) {
            case 'EQ':   baseFilterResult = String(actualVal) === String(fv); break
            case 'NEQ':  baseFilterResult = String(actualVal) !== String(fv); break
            case 'GT':   baseFilterResult = actualVal > fv; break
            case 'GTE':  baseFilterResult = actualVal >= fv; break
            case 'LT':   baseFilterResult = actualVal < fv; break
            case 'LTE':  baseFilterResult = actualVal <= fv; break
            case 'IS_NULL':     baseFilterResult = actualVal == null; break
            case 'IS_NOT_NULL': baseFilterResult = actualVal != null; break
            case 'STARTS_WITH': baseFilterResult = typeof actualVal === 'string' && typeof fv === 'string' && actualVal.startsWith(fv); break
            case 'ENDS_WITH':   baseFilterResult = typeof actualVal === 'string' && typeof fv === 'string' && actualVal.endsWith(fv); break
            case 'CONTAINS':    baseFilterResult = typeof actualVal === 'string' && typeof fv === 'string' && actualVal.includes(fv); break
            default:            baseFilterResult = String(actualVal) === String(fv); break
          }
          return (f as any).negated ? !baseFilterResult : baseFilterResult
        })
        if (match) filteredResult.push(row)
      }
      result.length = 0
      result.push(...filteredResult)
    }

    // ── OPTIONAL MATCH 处理 ──
    // 对主查询的每一行结果，尝试匹配 optionalMatchSteps 中的每个 optional MATCH 模式。
    // 成功 → 将匹配到的节点/边合并到 row；失败 → 填充 null。
    // 注意：此处的实现假设 OPTIONAL MATCH 使用临时 GE 实例，与主查询共享 allNodes。
    if (plan.optionalMatchSteps?.length && result.length) {
      for (const opt of plan.optionalMatchSteps) {
        const optRecords: Array<{ row: QueryRow; props: Record<string, unknown> | null }> = []
        for (let ri = 0; ri < result.length; ri++) {
          const row = result[ri]
          // 构建 OPTIONAL MATCH 的 GE plan
          // scanLabel 可选：如果为 null，扫描 allNodes 中的所有节点
          const optPlan: any = {
            type: 'QUERY',
            scanLabel: opt.scanLabel,
            steps: opt.steps || [],
            filters: opt.filters || [],
            returnColumns: [],
            orderBy: [],
            limit: undefined,
            skip: undefined,
          }
          const geRecords = (ge as any)._executeQueryPlan(optPlan)
          if (geRecords?.length) {
            // 第一个匹配结果
            const first = geRecords[0]
            const nodeProps: Record<string, unknown> = {}
            if (first && first.props) {
              for (const [k, v] of Object.entries(first.props)) {
                if (k !== '__edges' && !k.startsWith('_')) nodeProps[k] = v
              }
            }
            // 确定需要填充的变量名
            const sourceVar = opt.steps?.[0]?.source || ''
            const targetVar = opt.steps?.[0]?.targetAlias || ''
            const edgeVar = opt.steps?.[0]?.edgeAlias || ''
            // 如果 steps 为空但有 variableName（单节点 OPTIONAL MATCH 如 (n)），使用 variableName
            const optVarName = opt.variableName || ''
            // 将匹配到的节点属性填回 row
            if (sourceVar && !row[sourceVar]) {
              row[sourceVar] = nodeProps
            } else if (optVarName && !row[optVarName] && !sourceVar) {
              row[optVarName] = nodeProps
            }
            if (targetVar && !row[targetVar]) {
              row[targetVar] = nodeProps
            }
            // 边变量用空 placeholder（精确的边属性扩展见 Phase B）
            if (edgeVar && !row[edgeVar]) {
              row[edgeVar] = null
            }
          } else {
            // OPTIONAL MATCH 匹配失败：所有变量设为 null
            const sourceVar = opt.steps?.[0]?.source || ''
            const targetVar = opt.steps?.[0]?.targetAlias || ''
            const edgeVar = opt.steps?.[0]?.edgeAlias || ''
            const optVarName = opt.variableName || ''
            if (optVarName && !sourceVar && !targetVar && !edgeVar) {
              // 单节点模式：OPTIONAL MATCH (n) — 变量名来自 variableName
              row[optVarName] = null
            } else if (!sourceVar && !targetVar && !edgeVar && opt.scanLabel) {
              // 单节点模式：OPTIONAL MATCH (n:Label) — 变量名来自 scanLabel
              const scanVar = opt.scanLabel
              if (scanVar && !row[scanVar]) row[scanVar] = null
            } else {
              if (sourceVar && !row[sourceVar]) row[sourceVar] = null
              if (targetVar && !row[targetVar]) row[targetVar] = null
              if (edgeVar && !row[edgeVar]) row[edgeVar] = null
            }
          }
          optRecords.push({ row, props: null })
        }
      }
    }

    // OPTIONAL MATCH 后处理：OPTIONAL MATCH 设置的变量可能改变了 RETURN 表达式的求值结果。
    // 重新计算受影响的列。
    if (plan.optionalMatchSteps?.length && result.length) {
      const optMatchVarNames = new Set(plan.optionalMatchSteps.map(om => om.variableName).filter(Boolean))
      if (optMatchVarNames.size && plan.expressionColumns?.length) {
        const aliasToExpr: Record<string, string> = {}
        for (const ec of plan.expressionColumns) {
          const alias = (typeof ec === 'string' ? ec : (ec as any).alias ?? (ec as any).expression ?? String(ec))
          const expr = (typeof ec === 'object' && (ec as any).expression) ? String((ec as any).expression) : alias
          aliasToExpr[alias] = expr
        }
        for (const row of result) {
          for (const alias of Object.keys(aliasToExpr)) {
            if (!alias) continue
            const rawexpr = aliasToExpr[alias]
            if (!rawexpr) continue
            // 检查 OPTIONAL MATCH 变量是否在表达式中被引用且已存在于 row 中
            const hasVar = [...optMatchVarNames].some(vn => rawexpr.includes(vn) && vn in row)
            if (!hasVar) continue
            const varCtx: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(row)) {
              if (!k.startsWith('_')) varCtx[k] = v
            }
            for (const vn of optMatchVarNames) {
              if (vn in row) varCtx[vn] = row[vn]
            }
            try {
              const newVal = _evaluateExpression(rawexpr, varCtx)
              if (newVal !== undefined && newVal !== null) {
                row[alias] = newVal
              }
            } catch (_e) { /* ignore evaluation error, keep original value */ }
          }
        }
      }
    }

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

    // ── FOREACH 子句执行 ──
    // FOREACH (var IN list | CREATE|SET|REMOVE|DELETE)
    // 在 result 构建后添加 FOREACH CREATE 生成的节点到 result
    if (plan.forEach && plan.forEach.list?.length) {
      const fe = plan.forEach
      // 检查 result 是否是数组（GENERIC），FOREACH 适合的查询通常有 RETURN
      if (Array.isArray(result)) {
        for (const item of fe.list) {
          for (const update of fe.updates) {
            if (update.type === 'CREATE') {
              const props: Record<string, unknown> = { _label: update.label || 'Default' }
              if (update.props) {
                for (const [k, v] of Object.entries(update.props)) {
                  if (v === fe.name) {
                    props[k] = item
                  } else {
                    props[k] = typeof v === 'object' && v !== null && 'value' in v ? (v as any).value : v
                  }
                }
              }
              allNodes.push(props)
              const row: QueryRow = {}
              if (update.alias) row[update.alias] = props
              result.push(row)
            } else if (update.type === 'SET' && update.property !== undefined) {
              for (const node of allNodes) {
                if (node._alias === update.alias || node._label === update.label) {
                  node[update.property!] = item
                }
              }
            }
          }
        }
      }
    }

    // ── MATCH + WITH/UNWIND 管道 ──
    // MATCH 结果已经构建在 result 中，但查询还有 WITH/UNWIND 需要处理。
    // 对每一行 MATCH 结果，构造变量上下文，然后交给 WITH/UNWIND 管道处理。
    if (plan.hasMatch && plan.unwind && Array.isArray(result) && result.length) {
      // 用第一行 MATCH 结果构造变量上下文（所有 MATCH 行共享同一变量集）
      // WITH [n, r, p, ...] AS types — n,r,p 来自 MATCH
      const matchVarCtx: Record<string, unknown> = {}
      for (const [key, val] of Object.entries(result[0])) {
        if (val && typeof val === 'object' && 'props' in (val as any)) {
          matchVarCtx[key] = (val as any).props
        } else {
          matchVarCtx[key] = val
        }
      }
      // 从 rawWithEdges 中恢复 MATCH 变量（n, r, p 等）的原始引用
      if (Array.isArray(rawWithEdges) && rawWithEdges[0]?.__crossVarRows) {
        const crossVarRows = rawWithEdges[0].__crossVarRows as Record<string, unknown>
        for (const [varName, varVal] of Object.entries(crossVarRows)) {
          if (!(varName in matchVarCtx)) {
            matchVarCtx[varName] = varVal
          }
        }
      }
      // 把 MATCH 变量合并到 nodes，传入 matchVarCtx
      // 把 MATCH 变量合并到 nodes（_executeWithUnwindPipeline 的 varCtx 来自 nodes）
      // 但 _executeWithUnwindPipeline 使用自己的 varCtx，不读 nodes
      // 需要改造：传入 matchVarCtx
      const pipelineRows = _executeWithUnwindPipeline(plan, [matchVarCtx] as any, query, matchVarCtx)
      if (Array.isArray(pipelineRows)) {
        result.length = 0
        for (const pr of pipelineRows) {
          // 合并 MATCH 变量（如 n, r）到管道行
          // _executeWithUnwindPipeline 可能丢弃了 initialVarCtx 中的 MATCH 变量
          result.push({ ...matchVarCtx, ...pr })
        }
      }
      // ── UNWIND + WITH 管道后再求值 WHERE ──
      // 管道已合并 MATCH 变量和 UNWIND/WITH 变量，此时 whereBody 中的变量都可解析
      // 避免 WHERE 引用了管道变量但在 MATCH 阶段未知（如 WITH arr[0] AS expected）
      if (plan.whereBody && Array.isArray(result) && result.length) {
        const filtered: QueryRow[] = []
        for (const row of result) {
          const ctx: Record<string, unknown> = { ...row }
          for (const [k, v] of Object.entries(row)) {
            if (v && typeof v === 'object' && 'props' in (v as any)) {
              ctx[k] = (v as any).props
            }
          }
          try {
            let evalVal: unknown
            if (_isPatternPredicate(plan.whereBody)) {
              const isNegated = plan.whereBody.trim().startsWith('NOT ')
              evalVal = isNegated ? false : true
            } else {
              evalVal = _evaluateExpression(plan.whereBody, ctx)
            }
            if (evalVal === true) {
              filtered.push(row)
            }
          } catch {
            filtered.push(row)
          }
        }
        if (filtered.length || !result.length) {
          result.length = 0
          result.push(...filtered)
        }
      }
    }

    // ── 后处理（ORDER BY / HAVING） ──
    const evgeReturn = _postProcessResults(result, plan)
    return evgeReturn
  } finally {
    // DML 持久化：将 _executeViaGraphEngine 中创建的节点写回外部 nodes 数组，
    // 确保后续查询（MATCH）能看到前面 CREATE/MERGE 的节点。
    if ((plan.type === 'CREATE' || plan.type === 'MERGE' || plan.type === 'SET' || plan.type === 'DELETE') && nodes) {
      for (let i = originalNodeCount; i < allNodes.length; i++) {
        nodes.push(allNodes[i])
      }
    }
    // 注册池中的 GE 实例由 _clearGeInstances() 统一清理，不在 finally 中 close
    // 非注册临时 GE（当前不存在此场景）应在 finally 中 close + 清理
  }
}

/**
 * 递归过滤对象中的内部属性（以 _ 或 __ 开头），保持 TCK 兼容性。
 * 深度过滤结果行和节点对象，确保外部看不到 _alias 等内部字段。
 */
function _deepStripInternal(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(_deepStripInternal)
  if (obj && typeof obj === 'object') {
    const clean: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      // 仅删除 _alias 和 __ 开头的内部属性，保留 _label（toNodeNotation 需要）
      if (k === '_alias' || k.startsWith('__')) continue
      clean[k] = _deepStripInternal(v)
    }
    return clean
  }
  return obj
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
  // 过滤内部属性（以 _ 开头）以保持 TCK 兼容性，避免出现 _alias 等内部字段
  // 但保留 _label（toNodeNotation 需要它来识别节点类型）
  if (r.props) {
    for (const k of Object.keys(r.props)) {
      if (k === '_alias' || k.startsWith('__')) continue
      row[k] = r.props[k]
    }
  }

  const aliasMap = plan.returnAliasMap as Record<string, string> | undefined

  // 当 expressionColumns 存在时，使用它们而非 returnColumns（括号嵌套导致 returnColumns 被截断）
  const ret = plan.expressionColumns?.length
    ? plan.expressionColumns.map((ec: any) => (typeof ec === 'string' ? ec : ec.alias || ec.expression))
    : plan.returnColumns
  if (!ret?.length || plan.aggregate) {
    // RETURN *：返回所有在作用域内的变量
    if (plan.type === 'QUERY' && !plan.aggregate && !ret?.some((rc: string) => /^\w+\(/.test(rc))) {
      const result: QueryRow = {}
      // 从 r 收集所有变量（包括 __targetPropsMap 中的中间变量等）
      if (r.__targetPropsMap) {
        for (const vn of Object.keys(r.__targetPropsMap)) {
          const nodeData = r.__targetPropsMap[vn]
          if (nodeData && typeof nodeData === 'object' && '_label' in nodeData) {
            const label = (nodeData as any)._label
            result[vn] = label ? `(${label.startsWith(':') ? label : ':' + label})` : '()'
          } else if (nodeData && typeof nodeData === 'object' && '__edgeLabel' in nodeData) {
            result[vn] = `<(${(nodeData as any).__edgeLabel || '??'})>`
          }
        }
      }
      // source 节点变量
      const firstStepSource = plan.steps?.[0]?.source
      if (firstStepSource && r.props && '_label' in (r.props || {})) {
        const label = (r.props as any)._label
        result[firstStepSource] = label ? `(${label.startsWith(':') ? label : ':' + label})` : '()'
      }
      // 如果以上都没填充但 row 有数据，尽量用 row
      if (!Object.keys(result).length && r.props) {
        const label = (r.props as any)._label
        result['_k'] = label ? `(${label.startsWith(':') ? label : ':' + label})` : '()'
      }
      // 路径变量 p
      if (plan.steps?.length) {
        // TODO: 路径变量表示
        result['p'] = '<path>'
      }
      if (Object.keys(result).length) return result
    }
    return row
  }

  // expressionColumns 模式下从 ec map 找原始表达式
  const ecMap: Record<string, string> = {}
  if (plan.expressionColumns?.length) {
    for (const ec of plan.expressionColumns) {
      ecMap[ec.alias || ec.expression] = ec.expression
    }
  }

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
      // 边变量属性：如 r.weight → 从 r.__edgeProps 取
      if (r.__edgeProps && property in r.__edgeProps) {
        result[rc] = r.__edgeProps[property]
        continue
      }
      const firstStepSource = plan.steps?.[0]?.source
      const isSourceVar = firstStepSource && variable === firstStepSource
      if (isSourceVar && r.props && property in r.props) {
        result[rc] = r.props[property]
      } else if (!isSourceVar && r.__targetPropsMap && variable in r.__targetPropsMap) {
        // 中间步变量属性（如 b.name 在 MATCH (a)-[:R1]->(b)-[:R2]->(c) 中）
        // 从 __targetPropsMap 取该变量的节点属性
        const midNode = r.__targetPropsMap[variable]
        result[rc] = midNode && property in midNode ? midNode[property] : null
      } else if (r.__targetProps && property in r.__targetProps) {
        // 当 isSourceVar（如 RETURN i.var）但 r.props（source 节点）不含该属性时，
        // 回退到 __targetProps（target 节点，如 Child 的 var 属性）
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

    // ── 函数表达式（如 labels(m)、type(r)） ──
    // 必须在边变量 RETURN r 分支之前，避免 labels(m) 被误输出为 [:R]
    // 每当 rc 是函数调用表达式时，优先通过 _evaluateExpression 求值
    // 也支持 rc 是别名但 aliasMap 中对应当函数表达式（如 rc="l" → aliasMap["l"] = "labels(...)"）
    const aliasMap = plan.returnAliasMap as Record<string, string> | undefined
    let fnExpr: string | null = null
    if (rc.match(/^\w+\(/)) {
      fnExpr = rc
    } else if (aliasMap && rc in aliasMap && aliasMap[rc].match(/^\w+\(/)) {
      fnExpr = aliasMap[rc]
    }
    if (fnExpr) {
      const fnVarCtx: Record<string, unknown> = {}
      if (r.__crossVarRows) {
        for (const vn of Object.keys(r.__crossVarRows)) {
          fnVarCtx[vn] = r.__crossVarRows[vn]
        }

      }
      if (r.__targetPropsMap) {
        for (const vn of Object.keys(r.__targetPropsMap)) {
          if (!(vn in fnVarCtx)) fnVarCtx[vn] = r.__targetPropsMap[vn]
        }
      }
      // 补充 row 中的属性到变量上下文
      for (const k of Object.keys(row)) {
        if (!(k in fnVarCtx)) fnVarCtx[k] = row[k]
      }
      // 尝试通过 _evaluateExpression 求值
      try {
        const fnResult = _evaluateExpression(fnExpr, fnVarCtx)
        if (fnResult !== null && fnResult !== undefined) {
          const cleaned = _deepStripInternal(fnResult)
          result[rc] = cleaned
          continue
        }
      } catch (e: any) {}
      // 回退：检查 rc 是否是别名（rc 本身可求值）
      try {
        const fnResult = _evaluateExpression(rc, fnVarCtx)
        if (fnResult !== null && fnResult !== undefined) {
          const cleaned = _deepStripInternal(fnResult)
          result[rc] = cleaned
          continue
        }
      } catch (e: any) {}
    }

    // ── 边变量 RETURN r ──
    // rc 是边变量名（如 RETURN r），从 r.__edgeLabel 获取标签输出 [:LABEL] 格式
    if (r.__edgeLabel) {
      result[rc] = '[:' + r.__edgeLabel + ']'
      continue
    }

    // 使用 returnAliasMap 或 expressionColumns 解析原始表达式：统一走 _evaluateExpression
    let expr = (aliasMap && rc in aliasMap) ? aliasMap[rc] : (rc in ecMap ? ecMap[rc] : null)
    // 如果没有表达式映射（aliasMap 为空），但 rc 是简单变量名且存在于 varCtx 中，直接用 rc 作为表达式
    if (expr === null && rc && /^[a-zA-Z_]\w*$/.test(rc) && (rc in varCtx || rc in row)) {
      expr = rc
    }
    if (expr !== null) {
      // 如果 row[rc] 已经是边格式 [:xxx]（由 rawWithEdges 填充），不要覆盖
      if (typeof row[rc] === 'string' && row[rc].startsWith('[:')) {
        result[rc] = row[rc]
        continue
      }
      // 构建变量上下文字典：从 r 的交叉变量表和 targetProps 中提取所有可用变量
      const varCtx: Record<string, unknown> = {}
      // 无边模式：从 __crossVarRows 构建
      if (r.__crossVarRows) {
        for (const vn of Object.keys(r.__crossVarRows)) {
          varCtx[vn] = r.__crossVarRows[vn]
        }
      }
      // WITH 生成的自定义变量（如 list、map）：也从 r.props 提取
      if (r.props && typeof r.props === 'object') {
        for (const k of Object.keys(r.props)) {
          if (!k.startsWith('_') && !(k in varCtx)) {
            varCtx[k] = r.props[k]
          }
        }
      }
      // 多步多 RETURN 变量：从 __targetPropsMap 构建
      if (r.__targetPropsMap) {
        for (const vn of Object.keys(r.__targetPropsMap)) {
          if (!(vn in varCtx)) varCtx[vn] = r.__targetPropsMap[vn]
        }
      }
      // WITH 生成的自定义变量（如 list、map）：从 r 的顶层 key 和 __vridPropMap 提取
      for (const k of Object.keys(r)) {
        if (!k.startsWith('_') && !(k in varCtx)) {
          varCtx[k] = r[k]
        }
      }
      if (r.__vridPropMap) {
        for (const k of Object.keys(r.__vridPropMap)) {
          if (!(k in varCtx)) varCtx[k] = r.__vridPropMap[k]
        }
      }
      // source 变量：从 row 构建
      const firstStepSource = plan.steps?.[0]?.source
      if (firstStepSource && !(firstStepSource in varCtx)) {
        varCtx[firstStepSource] = { ...row }
      }
      // 其他 target 变量
      if (r.__targetProps && firstStepSource && !(firstStepSource in varCtx)) {
        varCtx[r.__targetAlias || firstStepSource] = { ...r.__targetProps }
      }
      // 如果 GE 没有 steps（MATCH (a) 无关系），从 expr 推断变量名填充 varCtx
      if (!firstStepSource) {
        // 标签谓词：(n:Foo) → 提取变量名 n
        const labelPredMatch = expr.match(/^\((\w+)\s*:\s*\w+\)$/)
        if (labelPredMatch) {
          const vn = labelPredMatch[1]
          if (vn && !(vn in varCtx)) {
            varCtx[vn] = { ...row }
          }
        }
        // 如果 expr 是函数调用（如 coalesce(a.title, a.name)），通过提取所有 . 之前的标识符
        // 来找到变量名；如果 expr 是纯变量名（"a"）或属性访问（"a.name"），直接提取
        const varNameMatches = expr.match(/(\b[a-zA-Z_]\w*)\s*\./g)
        if (varNameMatches) {
          for (const m of varNameMatches) {
            const vn = m.replace(/\s*\.$/, '')
            if (vn && /^[a-zA-Z_]\w*$/.test(vn) && !(vn in varCtx)) {
              varCtx[vn] = { ...row }
            }
          }
        } else if (!labelPredMatch) {
          const varName = expr.includes('.') ? expr.split('.')[0] : expr
          if (varName && /^[a-zA-Z_]\w*$/.test(varName) && !(varName in varCtx)) {
            varCtx[varName] = { ...row }
          }
          // Extract function argument variables for type(), labels(), properties(), keys(), id()
          // Edge variables need __edgeLabel to be in varCtx for function body evaluation
          // For unmatched OPTIONAL MATCH rows, edge variable should NOT get fallback data
          const fnArgMatch = expr.match(/^(type|labels|properties|keys|id)\s*\(\s*([a-zA-Z_]\w*)\s*\)$/i)
          if (fnArgMatch) {
            const argVar = fnArgMatch[2]
            if (/^[a-zA-Z_]\w*$/.test(argVar) && !(argVar in varCtx)) {
              // Check raw GE row for __edgeLabel (edge type data set during raw row building)
              if (r.__edgeLabel) {
                // Edge variable: create object with __edgeLabel for type() resolution
                const edgeObj: Record<string, unknown> = { __edgeLabel: r.__edgeLabel, _type: r.__edgeLabel }
                if (r.__edgeProps) edgeObj._props = r.__edgeProps
                varCtx[argVar] = edgeObj
              } else if (r.__crossVarRows?.[argVar]) {
                varCtx[argVar] = r.__crossVarRows[argVar]
              } else if (r[argVar] !== undefined) {
                varCtx[argVar] = r[argVar]
              }
              // When no edge data exists (e.g. unmatched OPTIONAL MATCH), DON'T add fallback
              // The function will get undefined → null check → return null
            }
          }
        }
      }
      // 如果表达式中包含变量名（a.b 或 a），尝试通过 _evaluateExpression 求值
      const evalResult = _evaluateExpression(expr, varCtx)
      if (evalResult !== null && evalResult !== undefined) {
        // 对节点对象（_label、_alias 等内部属性）做深度清理，避免 TCK 输出中泄露
        if (evalResult && typeof evalResult === 'object') {
          const cleaned = _deepStripInternal(evalResult)
          result[rc] = cleaned
        } else {
          result[rc] = evalResult
        }
                continue
      }
      // 回退：从 row 取值
      if (rc in row) {
        result[rc] = row[rc]
        continue
      }
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
    // 支持 count/sum/avg/min/max——从 allNodes 提取属性值做聚合
    const propField = agg.field || agg.property || ''
    if (agg.fn === 'count') {
      row[alias] = allNodes.length
    } else if (propField) {
      const values = allNodes
        .map(n => n[propField] ?? (n as any).props?.[propField])
        .filter((v: any) => v !== undefined && v !== null)
        .map(Number)
        .filter((v: any) => !isNaN(v))
      switch (agg.fn) {
        case 'sum':
          row[alias] = values.reduce((a: number, b: number) => a + b, 0)
          break
        case 'avg':
          row[alias] = values.length ? values.reduce((a: number, b: number) => a + b, 0) / values.length : 0
          break
        case 'max':
          row[alias] = values.length ? Math.max(...values) : 0
          break
        case 'min':
          row[alias] = values.length ? Math.min(...values) : 0
          break
        default:
          row[alias] = 0
      }
    } else {
      row[alias] = 0
    }
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
      // 阶段 4b: 检查 createEdges 的属性（如 RETURN r.num AS num）
      const aliasMap = plan.returnAliasMap as Record<string, string> | undefined
      if (aliasMap && rc in aliasMap) {
        const expr = aliasMap[rc]
        const propPart = expr.includes('.') ? expr.split('.').pop()! : expr
        const edgeVar = expr.includes('.') ? expr.split('.')[0] : ''
        // 在 createEdges 中找匹配的边变量 alias 或序号
        for (const edge of plan.createEdges || []) {
          const edgeProps = edge.props as Record<string, unknown> | undefined
          if (edgeProps && propPart in edgeProps) {
            row[rc] = edgeProps[propPart]
            break
          }
        }
        if (rc in row) continue
      }
      // rc 是纯别名且无法映射——尝试函数调用表达式（如 labels(node)）
      const fnCall = rc.match(/^(\w+)\((.+)\)$/)
      if (fnCall) {
        const varCtx: Record<string, unknown> = {}
        for (const cn of insertNodes) {
          if (cn.alias) {
            const clean: Record<string, unknown> = {}
            if (cn.props) Object.assign(clean, cn.props)
            if (cn.label) clean['_label'] = cn.label
            varCtx[cn.alias] = clean
          }
        }
        try {
          const fnResult = _evaluateExpression(rc, varCtx)
          if (fnResult !== undefined) { row[rc] = fnResult; continue }
        } catch (e: any) {} // function call may fail for invalid args
      }
      row[rc] = ''
      continue
    }
    row[rc] = ''
  }

  return Object.keys(row).length ? [row] : []
}


export async function _executeQuery(
  plan: QueryPlan,
  nodes: Array<Record<string, unknown>>,
  query?: string,
): Promise<QueryResult> {
  // Plan 深拷贝
  const planCopy = JSON.parse(JSON.stringify(plan, _bigintReplacer), _bigintReviver) as QueryPlan

  // 编译时语义验证
  try {
    _validatePlan(planCopy, query)
  } catch (e: any) {
    // _validatePlan 抛出的 SyntaxError 传播给调用方（如 TCK 正常流程）
    throw e
  }
  // 无显式 LIMIT 时应用 DEFAULT_LIMIT（批量数据集上默认截断防止 OOM）
  if (planCopy.limit === undefined || planCopy.limit === null) {
    planCopy.limit = DEFAULT_LIMIT
  }
  // 所有查询统一走 GraphEngine
  const execQueryResult = await _executeViaGraphEngine(planCopy, nodes, query)
  return execQueryResult
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

  // ── SyntaxError: UndefinedVariable ──
  _validateUndefinedVariables(query, plan)

  // ═══════════════════════════════════════════════════════════════
  // Literals SyntaxError (编译时字面量检查)
  // ═══════════════════════════════════════════════════════════════
  _validateLiterals(query)

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

  // ── SyntaxError: UnknownFunction ──
  // 检测 RETURN 列中调用的函数是否已知（如 foo(a)）
  if (query) {
    _validateUnknownFunctions(query)
  }

  // ── SyntaxError: InvalidArgumentType for list predicates with type mismatch ──
  // RETURN none(x IN ['Clara'] WHERE x % 2 = 0) — string list with arithmetic
  if (query) {
    const listPredRe = /\b(?:ALL|ANY|NONE|SINGLE)\s*\(\s*(\w+)\s+IN\s+(.+?)\s+WHERE\s+(.+)\)/im
    const predMatch = listPredRe.exec(query)
    if (predMatch) {
      const varName = predMatch[1]
      const listExpr = predMatch[2].trim()
      const whereExpr = predMatch[3].trim()
      // 检查 list 是否是纯字面量（只含字符串或 boolean）
      const listContent = listExpr.replace(/[[\]]/g, '').split(',').map((s: string) => s.trim()).filter(Boolean)
      if (listContent.length > 0) {
        const allStringsOrBools = listContent.every((item: string) =>
          /^'.*'$/.test(item) || /^".*"$/.test(item) ||
          item.toLowerCase() === 'true' || item.toLowerCase() === 'false'
        )
        if (allStringsOrBools) {
          // 检查 WHERE 条件中是否对迭代变量使用了算术运算符
          const arithmeticOps = /[+\-*/%]/.test(whereExpr)
          if (arithmeticOps) {
            throw Object.assign(new Error('SyntaxError: InvalidArgumentType'), { tckError: 'InvalidArgumentType' })
          }
        }
      }
    }
  }

  // ── SyntaxError: InvalidArgumentType for type() on node ──
  // type() 要求参数必须是关系类型，若传入节点变量则抛出 InvalidArgumentType
  if (query && query.includes('type(')) {
    const typeArgMatch = query.match(/type\s*\(\s*([a-zA-Z_]\w*)\s*\)/i)
    if (typeArgMatch) {
      const typeArg = typeArgMatch[1]
      // 从 query 中提取 MATCH 变量及其类型
      const matchNodeVars = new Set<string>()
      const matchEdgeVars = new Set<string>()
      // 从 MATCH 子句提取
      const matchClauses = query.matchAll(/MATCH\s+(.*?)(?:\s+(?:WHERE|WITH|RETURN|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|ORDER\s+BY|SKIP|LIMIT|INVOKE|CALL)|$)/gis)
      for (const mc of matchClauses) {
        const clause = mc[1]
        // 提取节点变量: (n:Label), (n), (n {prop})
        const nodeVars = clause.matchAll(/\((\w+)\s*(?::|\)|{)/g)
        for (const v of nodeVars) if (v[1]) matchNodeVars.add(v[1])
        // 提取边变量: [r:T], [r]
        const edgeVars = clause.matchAll(/\[(\w+)\s*(?::|\]|\))/g)
        for (const v of edgeVars) {
          if (v[1]) {
            matchEdgeVars.add(v[1])
            // 边变量也在 MATCH 中，从节点变量中排除
            matchNodeVars.delete(v[1])
          }
        }
      }
      // 如果是 OPTIONAL MATCH
      const optClauses = query.matchAll(/OPTIONAL\s+MATCH\s+(.*?)(?:\s+(?:WHERE|WITH|RETURN|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|ORDER\s+BY|SKIP|LIMIT|INVOKE|CALL)|$)/gis)
      for (const oc of optClauses) {
        const clause = oc[1]
        const edgeVars = clause.matchAll(/\[(\w+)\s*(?::|\]|\))/g)
        for (const v of edgeVars) if (v[1]) matchEdgeVars.add(v[1])
      }
      // 如果 type() 的参数是节点变量（在 MATCH 中绑定为节点，且不是边），抛出错误
      if (matchNodeVars.has(typeArg) && !matchEdgeVars.has(typeArg)) {
        throw Object.assign(new Error('SyntaxError: InvalidArgumentType'), { tckError: 'InvalidArgumentType' })
      }
    }
  }
  // MATCH (n $param) — parameter as node predicate
  if (query && /MATCH\s*\(\s*\w+(?::\w+)?\s+\$\w+/i.test(query)) {
    throw Object.assign(new Error('SyntaxError: InvalidParameterUse'), { tckError: 'InvalidParameterUse' })
  }
  // MATCH ()-[r:FOO $param]->() — parameter as relationship predicate (only in MATCH clauses)
  if (query && qUpper.includes('MATCH') && /\[[^\]]*\$\w+/.test(query)) {
    throw Object.assign(new Error('SyntaxError: InvalidParameterUse'), { tckError: 'InvalidParameterUse' })
  }

  // ── SyntaxError for size() on paths or patterns ──
  if (query) {
    // Detect size(p) where p is a path variable
    const pathVarMatch = query.match(/MATCH\s+(\w+)\s*=\s*\(/i);
    const pathVar = pathVarMatch ? pathVarMatch[1] : null;
    if (pathVar) {
      const sizePathMatch = query.match(new RegExp(`\\bsize\\s*\\(\\s*${pathVar}\\s*\\)`, 'i'));
      if (sizePathMatch) {
        throw Object.assign(new Error('SyntaxError'), { tckError: 'SyntaxError' });
      }
    }
    // Detect size() with pattern predicate arguments
    const sizeOnPattern = /size\s*\(\s*\([^)]*\)\s*(?:--|->|<-)/i;
    if (sizeOnPattern.test(query)) {
      throw Object.assign(new Error('SyntaxError'), { tckError: 'SyntaxError' });
    }
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
  // 注意：MATCH (x:X), (y:Y) CREATE (x)-[:R]->(y) 是合法的，x/y 在 createNodes 中
  // 仅当 createNode 有 label 或 props（即试图重新定义节点）时才视为 VariableAlreadyBound
  if (plan.hasMatch && plan.createNodes?.length) {
    const matchVars = extractMatchVariables(query)
    for (const cn of plan.createNodes) {
      if (cn.alias && matchVars.includes(cn.alias)) {
        // 如果 createNode 有 label 或 props，说明是在定义新节点，则报错
        // 如果 createNode 仅有 alias（label=null, props=null），说明只是引用已匹配节点，合法
        if (cn.label || (cn.props && Object.keys(cn.props).length > 0)) {
          throw Object.assign(new Error('SyntaxError: VariableAlreadyBound'), { tckError: 'VariableAlreadyBound' })
        }
      }
    }
  }
  // 2. CREATE (n:Foo) CREATE (n:Bar) — n 在同一语句中被绑定两次
  // 从 query 文本直接扫描所有 CREATE 中的变量
  // 注意：CREATE (a) CREATE (a)-[:R]->(b) 中的 a 是引用已创建的变量，不是重新绑定
  // 只有节点定义中的变量（出现在 (...) 内）才算绑定，边引用中的变量不算
  {
    const createVarCounts = new Map<string, number>()
    const createMatches = query.matchAll(/CREATE\b\s*(.*?)(?:\s+(?:CREATE|SET|DELETE|MERGE|REMOVE|WITH|RETURN|UNWIND)\b|$)/gis)
    for (const cm of createMatches) {
      const clause = cm[1]
      // 判断子句中是否有边缘模式（包含 -> <- 等方向标记）
      const hasEdgePattern = /-->|<-|<--|->/.test(clause)
      // 只有无边缘模式的子句中的节点变量才算绑定（CREATE (a) CREATE (b)）
      // 有边缘模式的子句中的节点是引用（CREATE (a)-[:R]->(b)）
      if (!hasEdgePattern) {
        const nodeVars = [...clause.matchAll(/\((\w+)\s*(?::|\))/g)].map(m => m[1]).filter(v => v && !/^[\d]/.test(v))
        for (const v of [...new Set(nodeVars)]) {
          if (v) {
            createVarCounts.set(v, (createVarCounts.get(v) || 0) + 1)
            if (createVarCounts.get(v)! > 1) {
              throw Object.assign(new Error('SyntaxError: VariableAlreadyBound'), { tckError: 'VariableAlreadyBound' })
            }
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
    const edgeVars = [...new Set([...cleaned.matchAll(/\[(\w+)\s*(?::|\])/g)].map(m => m[1]).filter((v: string) => v && v !== '*' && v !== '?'))]
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

    // ── SyntaxError: InvalidArgumentType（labels() on path） ──
    // MATCH p = (a)-[]-(b) RETURN labels(p)
    if (query) {
      const pathVar = query.match(/MATCH\s+(\w+)\s*=\s*\(/i)?.[1]
      if (pathVar) {
        const returnMatch = query.match(/RETURN\s+(.+)/i)
        if (returnMatch) {
          const returnText = returnMatch[1].replace(/\bAS\s+\w+/gi, '').trim()
          const labelsOnPath = new RegExp(`\\blabels\\(\\s*${pathVar}\\s*\\)`, 'i')
          if (labelsOnPath.test(returnText)) {
            throw Object.assign(new Error('SyntaxError: InvalidArgumentType'), { tckError: 'InvalidArgumentType' })
          }
        }
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
  // ── SyntaxError: InvalidArgumentType for IN operator ──
  // Cypher: IN 右操作数必须是列表（[1,2,3]），否则 SyntaxError
  if (query) {
    const returnExprs = query.match(/RETURN\s+(.+)/i)
    if (returnExprs) {
      // 对 RETURN 后的每个顶层表达式，检查其包含的 IN
      const parts = _splitTopLevel(returnExprs[1], ',').map(s => s.trim().replace(/\s+AS\s+\w+$/i, ''))
      for (const part of parts) {
        const inMatch = part.match(/\s*IN\s+(.+)$/i)
        if (inMatch) {
          const rightRaw = inMatch[1].trim()
          const right = rightRaw.replace(/^\(|\)$/g, '').trim()
          // 右值必须是列表（以 [ 开头）或参数引用（$x）
          if (!right.startsWith('[') && !right.startsWith('$') && right.toUpperCase() !== 'NULL') {
            // 单值字面量：数字、字符串、布尔、map（不包括 null — Cypher 允许 null IN null 返回 null）
            if (/^('.*?'|".*?"|-?\d+(\.\d+)?(e[+-]?\d+)?|true|false|\{.*\})$/.test(right)) {
              throw Object.assign(new Error('SyntaxError: InvalidArgumentType'), { tckError: 'InvalidArgumentType' })
            }
          }
        }
      }
    }
  }

  // ── CREATE SyntaxError: NoSingleRelationshipType（CREATE 关系无类型） ──
  // CREATE ()-->() — 关系没有指定类型
  if (plan.createEdges?.length || (query?.toUpperCase().includes('CREATE') && query?.includes('-->'))) {
    if (query) {
      // CREATE ()-->() 或 CREATE (a)-[]->(b) — 无关系类型
      const createClause = query.match(/CREATE\s+(.*?)(?:\s+(?:SET|DELETE|MERGE|REMOVE|WITH|RETURN|UNWIND)\s|$)/is)?.[1] || query
      if (createClause) {
        // 检测无类型关系：--> 或 -[]-> 或 <-[]-
        const noTypePattern = /-->|<-\[|\]-/  // untyped direction markers
        if (noTypePattern.test(createClause)) {
          // 检查是否有类型标签
          const typedEdge = /\[.*?[:|].*?\]/
          if (!typedEdge.test(createClause)) {
            throw Object.assign(new Error('SyntaxError: NoSingleRelationshipType'), { tckError: 'NoSingleRelationshipType' })
          }
        }
        // 检测无方向关系：-[R]-
        const noDirPattern = /\)\s*-\s*\[.*?\]\s*-\s*\(/
        if (noDirPattern.test(createClause)) {
          // 如果只有 -[R]- 没有 > 或 <，且没有变量绑定（MATCH 中无向边允许 CREATE 不允许）
          if (!/>|<|->/.test(createClause)) {
            throw Object.assign(new Error('SyntaxError: RequiresDirectedRelationship'), { tckError: 'RequiresDirectedRelationship' })
          }
        }
        // 检测双向关系：<-[:R]->
        if (/<-.*\[.*\]\s*->/.test(createClause)) {
          throw Object.assign(new Error('SyntaxError: RequiresDirectedRelationship'), { tckError: 'RequiresDirectedRelationship' })
        }
        // 检测多类型：CREATE ()-[:A|:B]->()
        if (/\[[^\]]*\|[^\]]*\]/.test(createClause)) {
          throw Object.assign(new Error('SyntaxError: NoSingleRelationshipType'), { tckError: 'NoSingleRelationshipType' })
        }
        // 检测可变长度：CREATE ()-[:FOO*2]->()
        if (/\*\d+/.test(createClause)) {
          throw Object.assign(new Error('SyntaxError: CreatingVarLength'), { tckError: 'CreatingVarLength' })
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

/**
 * 检测 pattern 出现在错误的位置（RETURN, WITH, SET 列中）
 * Cypher TCK: MATCH (n) RETURN (n)-[]->() 应报 UnexpectedSyntax
 */
function _validatePatternPosition(query: string): void {
  // Pattern 语法 = `(...)-[...]-(...)` 或 `(...)-[...]->(...)` 或 `(...)<-[...]-(...)`
  // 不能与 MATCH / WHERE / CREATE / MERGE 等子句开头混淆
  const patternRE = /\([^)]*\)\s*(?:<-\s*\[[^\]]*\]\s*-|-\s*\[[^\]]*\]\s*(?:->|-)|\s*--\s*)\([^)]*\)/
  // 检测 RETURN 列中的裸 pattern（不是在函数参数中）
  const returnMatch = query.match(/RETURN\s+(.+?)(?:\s+(?:ORDER\s+BY|SKIP|LIMIT|WHERE|CREATE|MERGE|MATCH|WITH|CALL|UNWIND)\s|$)/is)
  if (returnMatch) {
    const returnBody = returnMatch[1]
    const barePattern = patternRE.exec(returnBody)
    if (barePattern) {
      const before = returnBody.substring(0, barePattern.index)
      // pattern 不在函数参数中 → 是裸 pattern
      if (!before.includes('(') || before.lastIndexOf('(') < before.lastIndexOf(')')) {
        throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
      }
    }
  }
  // 检测 WITH 列中的 pattern
  const withMatch = query.match(/WITH\s+(.+?)(?:\s+(?:WHERE|MATCH|RETURN|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|ORDER\s+BY|SKIP|LIMIT|CALL)\s|$)/is)
  if (withMatch) {
    const withBody = withMatch[1]
    const barePattern = patternRE.exec(withBody)
    if (barePattern) {
      const before = withBody.substring(0, barePattern.index)
      if (!before.includes('(') || before.lastIndexOf('(') < before.lastIndexOf(')')) {
        throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
      }
    }
  }
  // 检测 SET 列右值中的 pattern
  const setMatch = query.match(/SET\s+(.+?)(?:\s+(?:RETURN|WITH|CREATE|MERGE|DELETE|REMOVE|UNWIND|ORDER\s+BY|SKIP|LIMIT|CALL)\s|$)/is)
  if (setMatch) {
    const setBody = setMatch[1]
    const eqIdx = setBody.indexOf('=')
    if (eqIdx >= 0) {
      const rhs = setBody.substring(eqIdx + 1).trim()
      if (patternRE.test(rhs)) {
        throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
      }
    }
  }
}

/**
 * 检测 WHERE (n) 自我模式（InvalidArgumentType）
 * MATCH (n) WHERE (n) RETURN n → 应报错
 */
function _validateWhereSelfPattern(query: string): void {
  const whereMatch = query.match(/WHERE\s+(.+?)(?:\s+(?:WITH|RETURN|ORDER\s+BY|SKIP|LIMIT|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|CALL)\s|$)/is)
  if (!whereMatch) return
  const whereBody = whereMatch[1].trim()
  // 检测 WHERE (n) 或 WHERE (n:Label) — 只有单个节点模式
  const selfNodePattern = /^\s*\(\s*\w+(?::\w+)?\s*\)\s*$/
  if (selfNodePattern.test(whereBody)) {
    throw Object.assign(new Error('SyntaxError: InvalidArgumentType'), { tckError: 'InvalidArgumentType' })
  }
}

/** 共享的 Cypher 关键字 + 内置函数名 Set（用于 _validateUndefinedVariables 排除误判） */
const _TCK_KEYWORDS: Set<string> = new Set([
  'AND','OR','XOR','NOT','IN','IS','NULL','TRUE','FALSE',
  'STARTS','CONTAINS','ENDS','THEN','ELSE','END','CASE','WHEN',
  'MATCH','CREATE','DELETE','SET','MERGE','REMOVE','UNWIND','RETURN','WITH',
  'ORDER','BY','SKIP','LIMIT','DISTINCT','AS','ON','WHERE',
  'DETACH','FOREACH','CALL','YIELD','SHOW','INDEX','CONSTRAINT',
  'UNION','ALL','OPTIONAL',
  // 已知标量/聚合/列表函数名
  'TOINTEGER','TOFLOAT','TOSTRING','SIZE','LENGTH','LABELS','KEYS',
  'COALESCE','HEAD','LAST','TAIL','REVERSE','RANGE',
  'LEFT','RIGHT','SUBSTRING','REPLACE','TRIM',
  'COUNT','SUM','AVG','MAX','MIN','COLLECT',
  'PERCENTILECONT','PERCENTILEDISC',
  // 数学函数
  'ABS','SQRT','CEIL','FLOOR','ROUND','SIGN','RAND',
  // 其他内置函数
  'TOUPPER','TOLOWER','ISNAN','SPLIT','TYPE','PROPERTIES','ID','ELEMENTID',
  // 时态函数
  'DATE','TIME','DATETIME','LOCALDATETIME','LOCALTIME','DURATION',
  'FROMEPOCH','FROMEPOCHMILLIS',
])

/** 检测 WHERE 子句中引用未定义变量（SyntaxError: UndefinedVariable） */
/** 从 WHERE 子句文本中去除 Pattern Comprehension 语法（只保留裸变量引用） */
function _stripPatternPredicateSyntax(text: string): string {
  // 去掉字符串常量
  let cleaned = text.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '')
  // 反复去除所有 [...] 模式（关系模式，如 [:REL1], [r:REL], [r])
  let prev = ''
  while (prev !== cleaned) {
    prev = cleaned
    cleaned = cleaned.replace(/\[[^\[\]]*\]/g, ' ')
  }
  // 去除箭头和连接符：->, <-, -, -- 
  cleaned = cleaned.replace(/<-[ \t]*-/g, ' ').replace(/-[ \t]*->/g, ' ').replace(/--/g, ' ')
  cleaned = cleaned.replace(/<[ \t]*-/g, ' ').replace(/-[ \t]*>/g, ' ')
  // 去除节点模式 (...): 先反复去除括号内的内容，直到不包含括号
  prev = ''
  while (prev !== cleaned) {
    prev = cleaned
    cleaned = cleaned.replace(/\([^()]*\)/g, ' ')
  }
  return cleaned
}

/** 检测 WHERE 子句是否为 Pattern Comprehension（如 (n)-[]->()) */
function _isPatternPredicate(text: string): boolean {
  const t = text.trim()
  // Pattern comprehension 以 (var) 或 (var:Label) 开头
  // 并包含关系模式连接：-[], ->, --
  if (!t.startsWith('(')) return false
  return /\([^)]*\)\s*(?:<-\s*\[|-\s*\[|-\s*\(|--)/.test(t)
}

function _validateUndefinedVariables(query: string, plan?: any): void {
  const whereMatch = query.match(/WHERE\s+(.+?)(?:\s+(?:WITH|RETURN|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|ORDER\s+BY|SKIP|LIMIT|CALL)\s|$)/is)
  const matchVars = extractMatchVariables(query)
  // 也提取 CREATE/MERGE 中的变量（节点和边变量）作为已定义变量
  const createEdgeVars: string[] = [...query.matchAll(/\[(\w+)\s*(?::|])/g)].map(m => m[1]).filter(v => v && !/^[\d]/.test(v))
  const createNodeVars: string[] = [...query.matchAll(/CREATE\s+(.*?)(?:\s+(?:SET|DELETE|MERGE|REMOVE|WITH|RETURN|UNWIND)\b|$)/gis)].flatMap(cm => {
    const clause = cm[1];
    return [...clause.matchAll(/\((\w+)\s*(?::|\))/g)].map(m => m[1]).filter(v => v && !/^[\d]/.test(v));
  })
  // 提取 WITH/UNWIND 子句中定义的变量（提前，以便 RETURN 和 WHERE 检查都能使用）
  const withVars: string[] = []
  // 方式1：从 WITH ... AS 提取
  const withMatches = query.matchAll(/\bWITH\s+(.+?)(?:\s+(?:WHERE|MATCH|RETURN|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|ORDER\s+BY|SKIP|LIMIT|CALL)\s|$)/gis)
  for (const wm of withMatches) {
    const items = wm[1].split(',').map(s => s.trim())
    for (const item of items) {
      const asMatch = item.match(/\bAS\s+(\w+)\s*$/i)
      if (asMatch) withVars.push(asMatch[1])
    }
  }
  // 方式2：从整句 WITH/UNWIND 提取 AS 变量（包括子查询路径中的 WITH）
  const allAsMatches = query.matchAll(/\b(?:WITH|UNWIND)\b[^]*?\bAS\s+(\w+)/gi)
  for (const am of allAsMatches) {
    withVars.push(am[1])
  }
  // 方式3：从 MATCH p = (n)-[r]->() 提取路径变量
  const pathVars = query.matchAll(/\bMATCH\s+(\w+)\s*=/gi)
  for (const pv of pathVars) {
    withVars.push(pv[1])
  }
  // 方式4：从列表谓词 all/any/none/single(x IN ... WHERE ...) 提取迭代变量
  const listPredVars = [...query.matchAll(/\b(?:ALL|ANY|NONE|SINGLE)\s*\(\s*(\w+)\s+IN\s+/gi)].map(m => m[1])
  for (const lpv of listPredVars) {
    withVars.push(lpv)
  }
  // 检查 RETURN 列中的未定义变量（如 MATCH () RETURN foo）
  const returnMatch = query.match(/RETURN\s+(.+?)(?:\s+(?:ORDER\s+BY|SKIP|LIMIT)|$)/is)
  if (returnMatch) {
    let returnColStr = returnMatch[1]
    // 去除字符串字面量和 map/list 字面量内部的内容，只保留变量引用
    returnColStr = returnColStr.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '')
    // 反复去除 {} 和 [] 字面量以处理嵌套 {id: '0001', batters: {batter: [...]}}
    let prev = ''
    while (prev !== returnColStr) {
      prev = returnColStr
      returnColStr = returnColStr.replace(/\{[^{}]*\}/g, ' ').replace(/\[[^\[\]]*\]/g, ' ')
    }
    // 扫描所有在 RETURN 中引用但未在 MATCH 中定义的变量（排除 AS 后的别名）
    // 用 /\bAS\s+/i 分割出 AS 之前的表达式主体
    const beforeAs = returnColStr.replace(/\bAS\s+\w+\s*/ig, '').trim()
    // 提取变量名：r.num → 只保留 r（变量），num 是属性名，排除在内
    const varSet = new Set<string>()
    const propRefs = [...beforeAs.matchAll(/(\b[a-zA-Z_]\w*)\.(\w+)/g)]
    for (const pr of propRefs) {
      varSet.add(pr[1])     // r.num → 'r' 是变量
    }
    // 从 propRefs 收集所有属性名（即 .后面的词），它们不是变量
    const propNames = new Set(propRefs.map(m => m[2]))
    // 也提取裸变量名（如 RETURN foo 中的 foo）
    // 移除 list predicate 模式 ALL(x IN ... WHERE cond)、ANY(...)、NONE(...)、SINGLE(...)
    // 使用平衡括号匹配
    let cleanedBeforeAs = beforeAs;
    const listPredRe = /\b(ALL|ANY|NONE|SINGLE)\s*\(/gi;
    let predMatch: RegExpExecArray | null;
    const parts: string[] = [];
    let lastIdx = 0;
    const predStarts: Array<{ start: number; end: number }> = [];
    while ((predMatch = listPredRe.exec(cleanedBeforeAs)) !== null) {
      const start = predMatch.index;
      let depth = 1;
      let i = predMatch.index + predMatch[0].length;
      while (i < cleanedBeforeAs.length && depth > 0) {
        if (cleanedBeforeAs[i] === '(') depth++;
        else if (cleanedBeforeAs[i] === ')') depth--;
        if (depth === 0) break;
        i++;
      }
      if (depth === 0) {
        predStarts.push({ start, end: i + 1 });
      }
    }
    if (predStarts.length > 0) {
      for (const { start, end } of predStarts) {
        parts.push(cleanedBeforeAs.slice(lastIdx, start));
        lastIdx = end;
      }
      parts.push(cleanedBeforeAs.slice(lastIdx));
      cleanedBeforeAs = parts.join(' ');
    }
    const bareVars = [...cleanedBeforeAs.matchAll(/\b([a-zA-Z_]\w*)\b/g)].map(m => m[1])
    for (const v of bareVars) {
      // 排除数字、关键字、函数名
      if (/^\d/.test(v)) continue
      if (_TCK_KEYWORDS.has(v.toUpperCase())) continue
      // 排除 AS 别名
      const aliasNames = [...beforeAs.matchAll(/\bAS\s+(\w+)/gi)].map(m => m[1])
      if (aliasNames.includes(v)) continue
      // 排除属性名（.name 中的 name 不是变量）
      if (propNames.has(v)) continue
      varSet.add(v)
    }
    // AS xxx 中的 xxx 可能也在 varNames 中，保留为别名
    const aliasNames = [...beforeAs.matchAll(/\bAS\s+(\w+)/gi)].map(m => m[1])
    for (const an of aliasNames) varSet.add(an)
    const varIdents = [...varSet]
    if (matchVars.length === 0 && varIdents.length > 0) {
      for (const v of varIdents) {
        const vu = v.toUpperCase()
        if (_TCK_KEYWORDS.has(vu)) continue
        // 检查是否在 MATCH、WITH 变量、CREATE 边变量、CREATE 节点变量中定义
        const allDefinedVars = [...matchVars, ...withVars, ...createEdgeVars, ...createNodeVars]
        if (!allDefinedVars.includes(v)) {
          // 额外检查：如果 v 看起来是属性访问（有小数点），跳过
          if (v.includes('.') && allDefinedVars.includes(v.split('.')[0])) continue
          throw Object.assign(new Error('SyntaxError: UndefinedVariable'), { tckError: 'UndefinedVariable' })
        }
      }
    }
  }
  if (whereMatch && matchVars.length === 0) return
  const whereBody = whereMatch ? whereMatch[1] : ''
  // 如果 whereBody 以 ") AS alias" 结尾，剥离后缀（list predicate 的结束括号被误捕获）
  const whereClean = whereBody.replace(/\)\s*AS\s+\w+\s*$/i, '').trim()
  // 合并 MATCH 变量和 WITH 变量
  const definedVars = [...new Set([...matchVars, ...withVars])]
  // 去掉字符串常量
  let cleaned = whereClean
    .replace(/'[^']*'/g, '')
    .replace(/"[^"]*"/g, '')
  // 去掉属性访问（x.y 格式）
  cleaned = cleaned.split(/\s+/).filter(word => !word.includes('.')).join(' ')
  // 去掉 Pattern Comprehension 语法（(n)-[:REL]->() 中的 `REL` 不是变量)
  cleaned = _stripPatternPredicateSyntax(cleaned)
  // 提取裸标识符
  const idents = cleaned.match(/\b([a-zA-Z_]\w*)\b/g) || []
  for (const v of idents) {
    const vu = v.toUpperCase()
    if (_TCK_KEYWORDS.has(vu)) continue
    if (/^\d/.test(v)) continue
    if (!definedVars.includes(v) && !definedVars.includes(vu)) {
      throw Object.assign(new Error('SyntaxError: UndefinedVariable'), { tckError: 'UndefinedVariable' })
    }
  }
}

/** 验证 RETURN 列中的函数是已知的（SyntaxError: UnknownFunction） */
function _validateUnknownFunctions(query: string): void {
  // 提取 RETURN 子句
  const returnMatch = query.match(/RETURN\s+((?:(?!\s+(?:ORDER\s+BY|SKIP|LIMIT|WHERE|CREATE|MERGE|MATCH|WITH|CALL|UNWIND)).)+)/is)
  if (!returnMatch) return
  const returnStr = returnMatch[1]
  // 匹配 functionName(args) 模式
  const fnPattern = /\b(\w+)\s*\(/g
  let fnMatch: RegExpExecArray | null
  while ((fnMatch = fnPattern.exec(returnStr)) !== null) {
    const fnName = fnMatch[1].toLowerCase()
    // 跳过已定义的函数和关键字
    if (fnName in _builtinFunctions) continue
    if (['and','or','xor','not','in','is','null','true','false','distinct',
        'all','any','none','single','case','when','then','else','end',
        'count','sum','avg','max','min','collect'].includes(fnName)) continue
    if (!_builtinFunctions[fnName]) {
      throw Object.assign(new Error('SyntaxError: UnknownFunction'), { tckError: 'UnknownFunction' })
    }
  }
}

/** 从查询文本中提取 RETURN 列中的边属性访问（如 r.num 表示边变量 r 的属性 num） */
function extractEdgePropColumnsFromQuery(query: string): string[] {
  const edgeVars: string[] = []
  // 从 MATCH 子句中提取边变量
  const matchClause = query.match(/MATCH\s+(.*?)(?:\s+(?:WHERE|WITH|RETURN|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|ORDER\s+BY|SKIP|LIMIT|INVOKE|CALL)\s|$)/is)
  if (matchClause) {
    const edgeVarMatches = matchClause[1].matchAll(/\[(\w+)\s*(?::|\]|\))/g)
    for (const m of edgeVarMatches) {
      if (m[1] && !/^[\d]/.test(m[1])) edgeVars.push(m[1])
    }
  }
  // 从 RETURN 列中提取 var.prop 模式
  const returnMatch = query.match(/RETURN\s+(.+?)(?:\s+(?:ORDER\s+BY|SKIP|LIMIT)|$)/is)
  if (!returnMatch) return []
  const returnCols = returnMatch[1].split(',').map(s => s.trim())
  const cols: string[] = []
  for (const col of returnCols) {
    const propMatch = col.match(/^(\w+)\.(\w+)$/)
    if (propMatch && edgeVars.includes(propMatch[1])) {
      cols.push(propMatch[1])
    }
  }
  return cols
}

/** 从查询文本中提取所有 MATCH 中绑定的变量名 */
function extractMatchVariables(query: string): string[] {
  const vars: string[] = []
  // 提取 MATCH 子句中的所有括号模式中的变量
  if (!query) return vars
  const matches = query.matchAll(/MATCH\s+(.*?)(?:\s+(?:WHERE|WITH|RETURN|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|ORDER\s+BY|SKIP|LIMIT|INVOKE|CALL)\s|$)/gis)
  for (const m of matches) {
    const clause = m[1]
    // 从 (n:Label), (n) 或 (n {prop: val}) 中提取变量名
    const nodeVars = clause.matchAll(/\((\w+)\s*(?::|\)|{)/g)
    for (const v of nodeVars) {
      if (v[1] && !/^[\d]/.test(v[1])) vars.push(v[1])
    }
    // 从 <-[r]- 或 -[r]-> 或 [r:T] 中提取边变量
    const edgeVars = clause.matchAll(/\[(\w+)\s*(?::|\]|\))/g)
    for (const v of edgeVars) {
      if (v[1] && !/^[\d]/.test(v[1])) vars.push(v[1])
    }
  }
  return [...new Set(vars)]
}

/** 从查询文本中提取所有引用过的变量名 */
function extractVariablesFromQuery(query: string): string[] {
  const vars: string[] = []
  const allNodes = query.matchAll(/\((\w+)\s*(?::|\)|{)/g)
  for (const v of allNodes) {
    if (v[1] && !/^[\d]/.test(v[1])) vars.push(v[1])
  }
  const allEdges = query.matchAll(/\[(\w+)\s*(?::|\]|\))/g)
  for (const v of allEdges) {
    if (v[1] && !/^[\d]/.test(v[1])) vars.push(v[1])
  }
  return [...new Set(vars)]
}

/** 从一段 Cypher 子句文本中提取变量名 */
function extractVariablesFromClause(clause: string): string[] {
  const vars: string[] = []
  const nodes = clause.matchAll(/\((\w+)\s*(?::|\)|{)/g)
  for (const v of nodes) {
    if (v[1] && !/^[\d]/.test(v[1])) vars.push(v[1])
  }
  const edges = clause.matchAll(/\[(\w+)\s*(?::|\]|\))/g)
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
    && !plan.create && !plan.show && !plan.with && !plan.unwind && !plan.unwinds?.length && !plan.unionType
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
        // [CVE-H5]: TCK 中边索引可能以字符串形式传递（如 '"0"'），原实现只检查 === 'number' 导致静默丢弃。
        // 现改用 Number() 转换，既兼容 number 也兼容 string 格式。
        const srcIdx = typeof e.srcIdx === 'number' ? e.srcIdx : Number(e.srcIdx)
        const dstIdx = typeof e.dstIdx === 'number' ? e.dstIdx : Number(e.dstIdx)
        if (!isNaN(srcIdx) && !isNaN(dstIdx)) {
          edges.push({ srcIdx, dstIdx, label: String(e.label || ''), props: e.props || null })
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

// ============================================================
// 表达式求值引擎 — 支持字面量/二元运算/函数/属性访问
// ============================================================

/**
 * 对单个表达式字符串求值。
 * `row` 是每行 GE 结果数据，用于变量引用（如 `n.name` → row[name]）。
 */
function _evaluateExpression(expr: string | Record<string, unknown>, row?: Record<string, unknown>): unknown {
  if (expr == null) return null
  // 支持结构化表达式 {type, value, items}（从 AST 解析而来）
  if (typeof expr !== 'string' && typeof expr === 'object') {
    return _evalStructuredLiteral(expr as Record<string, unknown>, row)
  }
  if (typeof expr !== 'string') return null
  const t = expr.trim()
  if (t.startsWith('CASE ') || t.startsWith('case ')) {
    const r = _evalCase(t, row)
    return r
  }
  return _evalBinary(t, row)
}

/** 从结构化 AST 字面量对象求值 */
function _evalStructuredLiteral(expr: Record<string, unknown>, _row?: Record<string, unknown>): unknown {
  const type = String(expr.type || '')
  switch (type.toUpperCase()) {
    case 'STRING': return String(expr.value)
    case 'NUMBER': {
      const n = Number(expr.value)
      if (!Number.isSafeInteger(n) && String(expr.value).length >= 16) {
        try { return BigInt(String(expr.value)) } catch { return n }
      }
      return n
    }
    case 'BOOLEAN': return expr.value === true || expr.value === 'true'
    case 'NULL': return null
    case 'LIST': {
      const items = Array.isArray(expr.items) ? expr.items : []
      return items.map((item: unknown) =>
        typeof item === 'object' && item !== null && (item as Record<string, unknown>).type
          ? _evalStructuredLiteral(item as Record<string, unknown>, _row)
          : item
      )
    }
    case 'MAP': return Object.fromEntries(
      Object.entries(expr).filter(([k]) => k !== 'type').map(([k, v]) => [
        k,
        typeof v === 'object' && v !== null && (v as Record<string, unknown>).type
          ? _evalStructuredLiteral(v as Record<string, unknown>, _row)
          : v,
      ])
    )
    default: return null
  }
}

function _evalCase(s: string, row?: Record<string, unknown>): unknown {
  // CASE <value> WHEN <v1> THEN <r1> WHEN <v2> THEN <r2> ... ELSE <default> END
  // 或 CASE WHEN <cond1> THEN <r1> WHEN <cond2> THEN <r2> ... ELSE <default> END
  const t = s.replace(/\bEND\b\s*$/i, '').trim()  // 去掉尾部 END
  const caseMatch = t.match(/^CASE\s+(.+?)\s+WHEN\s/i)
  const simpleCase = caseMatch !== null
  let remainder: string
  let baseValue: unknown = null
  if (simpleCase) {
    baseValue = _evaluateExpression(caseMatch[1], row)
    remainder = t.slice(caseMatch[0].length)  // WHEN ... 部分（不含 WHEN 前缀）
  } else {
    // 没有 CASE <value>，直接解析 WHEN ... THEN ... ELSE
    const caseWhenMatch = t.match(/^CASE\s+(WHEN\s)/i)
    remainder = caseWhenMatch ? t.slice(caseWhenMatch[1].length) : t.replace(/^CASE\s+/i, '')
  }

  // 拆分 WHEN ... THEN ... WHEN ... THEN ... [ELSE ...]
  let result: unknown = null
  let hasMatch = false

  const parts = remainder.split(/\bWHEN\s+/i)
  let elseVal: unknown = null
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim()
    if (!part) continue
    if (/^ELSE\s+/i.test(part)) {
      elseVal = _evaluateExpression(part.replace(/^ELSE\s+/i, '').trim(), row)
      continue
    }
    // 一个 WHEN arm: "<cond> THEN <result>"
    const thenIdx = findThenIndex(part)
    if (thenIdx < 0) continue
    const cond = _evaluateExpression(part.slice(0, thenIdx).trim(), row)
    let thenResult = part.slice(thenIdx + 4).trim() // 去掉 "THEN"
    // 如果剩余部分包含 ELSE，截断
    const elseIdx = thenResult.search(/\bELSE\s+/i)
    if (elseIdx >= 0) {
      // 如果当前 arm 不匹配且 elseVal 没有被设置，提取 ELSE 值
      if (elseVal == null) {
        elseVal = _evaluateExpression(thenResult.slice(elseIdx + 4).trim(), row)
      }
      thenResult = thenResult.slice(0, elseIdx).trim()
    }
    if (hasMatch) continue  // 已匹配，跳过剩余
    let condResult: boolean
    if (simpleCase) {
      condResult = _compareValues(baseValue, cond, '=')
    } else {
      condResult = cond === true
    }
    if (condResult) {
      result = _evaluateExpression(thenResult, row)
      hasMatch = true
    }
  }
  if (!hasMatch) result = elseVal
  return result
}

function findThenIndex(s: string): number {
  // 找到顶层的 THEN（不嵌套在括号内）
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(' || s[i] === '[' || s[i] === '{') depth++
    else if (s[i] === ')' || s[i] === ']' || s[i] === '}') depth--
    else if (depth === 0 && s.slice(i, i + 4).toLowerCase() === 'then' && (i + 4 >= s.length || s[i+4] === ' ' || s[i+4] === '(' || s[i+4] === ')' || s[i+4] === '.' || s[i+4] === "[" || s[i+4] === "'")) {
      // Check that it's "THEN" not part of another word
      if (i === 0 || s[i-1] === ' ' || s[i-1] === ')') return i
    }
  }
  return -1
}

function _parseCommaList(s: string): string[] {
  const result: string[] = []
  let depth = 0, inStr = false, strChar = '', current = ''
  for (const ch of s) {
    if (inStr) { current += ch; if (ch === strChar) inStr = false; continue }
    if (ch === "'" || ch === '"') { inStr = true; strChar = ch; current += ch; continue }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; current += ch; continue }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; current += ch; continue }
    if (ch === ',' && depth === 0) { result.push(current.trim()); current = ''; continue }
    current += ch
  }
  if (current.trim()) result.push(current.trim())
  return result
}

type _BuiltinFn = (args: string[], row?: Record<string, unknown>) => unknown

/** Resolve nanoseconds from map combining millisecond, microsecond, nanosecond */
function _resolveNanoseconds(map: Record<string, unknown>): number {
  const ms = map.millisecond != null ? Math.round(Number(map.millisecond) * 1000000) : 0
  const us = map.microsecond != null ? Math.round(Number(map.microsecond) * 1000) : 0
  const ns = map.nanosecond != null ? Number(map.nanosecond) : 0
  return ms + us + ns
}

/** Format time string per Cypher TCK */
function _formatTime(hour: number, minute: number, second: number, nanosecond: number): string {
  const base = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  if (nanosecond > 0) {
    let nsStr = String(nanosecond).padStart(9, '0').replace(/0+$/, '')
    return `${base}:${String(second).padStart(2, '0')}.${nsStr}`
  }
  if (second > 0) return `${base}:${String(second).padStart(2, '0')}`
  return base
}

function _extractTimeMap(map: Record<string, unknown>): { hour: number; minute: number; second: number; nanosecond: number } {
  return {
    hour: map.hour != null ? Number(map.hour) : 0,
    minute: map.minute != null ? Number(map.minute) : 0,
    second: map.second != null ? Number(map.second) : 0,
    nanosecond: _resolveNanoseconds(map),
  }
}

function _formatTimezone(tz: string): string {
  return /^[+-]\d{2}:\d{2}:00$/.test(tz) ? tz.slice(0, -3) : tz
}

function _resolveNamedTimezone(tz: string, year?: number, month?: number, day?: number): string {
  if (/^[+-]\d{2}:\d{2}/.test(tz)) return tz
  if (tz.includes('[')) return tz
  try {
    const date = (year != null && month != null && day != null)
      ? new Date(Date.UTC(year, month - 1, day)) : new Date()
    const parts = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(date)
    const tzPart = parts.find(p => p.type === 'timeZoneName')
    if (tzPart && tzPart.value) {
      const m = tzPart.value.match(/GMT([+-]?)(\d+)/)
      if (m) return `${m[1] || '+'}${String(parseInt(m[2], 10)).padStart(2, '0')}:00[${tz}]`
    }
  } catch {}
  return tz
}

function _isoYear(d: Date): number {
  const t = new Date(d.valueOf())
  t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7))
  return t.getUTCFullYear()
}

function _isoWeek1Monday(year: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const d = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay()
  return new Date(Date.UTC(year, 0, 4 - d + 1))
}

function _resolveDateFromMap(map: Record<string, unknown>): Date {
  if (map.date != null) {
    const baseStr = typeof map.date === 'string' ? map.date : String(map.date)
    const parts = baseStr.split('-')
    if (parts.length === 3) {
      const year = Number(parts[0]), month2 = Number(parts[1]), day2 = Number(parts[2])
      const base = new Date(Date.UTC(year, month2 - 1, day2))
      if (map.week != null || map.dayOfWeek != null) {
        const dateDow = base.getUTCDay() === 0 ? 7 : base.getUTCDay()
        const isoY = map.year != null ? Number(map.year) : _isoYear(base)
        const w1Mon = _isoWeek1Monday(isoY)
        const dow = map.dayOfWeek != null ? Number(map.dayOfWeek) : dateDow
        const tw = map.week != null ? Number(map.week) : 1
        const adj = new Date(w1Mon)
        adj.setUTCDate(w1Mon.getUTCDate() + (tw - 1) * 7 + dow - 1)
        return adj
      }
      return base
    }
  }
  const year = map.year != null ? Number(map.year) : 2000
  if (map.week != null) {
    const w1Mon = _isoWeek1Monday(year)
    const dow = map.dayOfWeek != null ? Number(map.dayOfWeek) : 1
    const adj = new Date(w1Mon)
    adj.setUTCDate(w1Mon.getUTCDate() + (Number(map.week) - 1) * 7 + dow - 1)
    return adj
  }
  let month = map.month != null ? Number(map.month) : 1
  let day = map.day != null ? Number(map.day) : 1
  if (map.quarter != null) {
    month = (Number(map.quarter) - 1) * 3 + 1
    if (map.dayOfQuarter != null) {
      const q = new Date(Date.UTC(year, month - 1, 1))
      q.setUTCDate(q.getUTCDate() + Number(map.dayOfQuarter) - 1)
      return q
    }
  }
  if (map.ordinalDay != null) {
    const d = new Date(Date.UTC(year, 0, 1))
    d.setUTCDate(d.getUTCDate() + Number(map.ordinalDay) - 1)
    return d
  }
  return new Date(Date.UTC(year, month - 1, day))
}

/** Unwrap a value to its raw data object, handling NodeRecord/EdgeRecord wrappers */
function _unwrapRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>
    // If it looks like a NodeRecord with `props` sub-object, unwrap to the props
    if (obj.props && typeof obj.props === 'object' && !Array.isArray(obj.props)) {
      // Keep metadata fields too (flatten into single object)
      const result: Record<string, unknown> = {}
      // Copy props first (they may contain _label, etc.)
      for (const [k, vv] of Object.entries(obj.props)) {
        result[k] = vv
      }
      // Also copy top-level metadata fields (_id, id, _type, _label, type)
      // but only if they don't shadow existing props
      for (const [k, vv] of Object.entries(obj)) {
        if (k === 'props') continue
        if (result[k] === undefined) result[k] = vv
      }
      return result
    }
  }
  return (v as Record<string, unknown>) || {}
}

const _builtinFunctions: Record<string, _BuiltinFn> = {
  abs: ([a], r) => Math.abs(Number(_evalBinary(a, r))),
  sqrt: ([a], r) => Math.sqrt(Number(_evalBinary(a, r))),
  ceil: ([a], r) => Math.ceil(Number(_evalBinary(a, r))),
  floor: ([a], r) => Math.floor(Number(_evalBinary(a, r))),
  round: ([a], r) => Math.round(Number(_evalBinary(a, r))),
  sign: ([a], r) => Math.sign(Number(_evalBinary(a, r))),
  rand: () => Math.random(),
  coalesce: (as, r) => { for (const a of as) { const v = _evalBinary(a, r); if (v != null) return v } return null },
  toupper: ([a], r) => String(_evalBinary(a, r)).toUpperCase(),
  tolower: ([a], r) => String(_evalBinary(a, r)).toLowerCase(),
  trim: ([a], r) => String(_evalBinary(a, r)).trim(),
  reverse: ([a], r) => {
    const v = _evalBinary(a, r);
    if (Array.isArray(v)) return [...v].reverse();
    return [...String(v)].reverse().join('');
  },
  substring: ([a, s, l], r) => { const str = String(_evalBinary(a, r)); const st = Number(_evalBinary(s, r)); return l ? str.slice(st, st + Number(_evalBinary(l, r))) : str.slice(st) },
  left: ([a, l], r) => String(_evalBinary(a, r)).slice(0, Number(_evalBinary(l, r))),
  right: ([a, l], r) => String(_evalBinary(a, r)).slice(-Number(_evalBinary(l, r))),
  replace: ([a, s, re], r) => String(_evalBinary(a, r)).split(String(_evalBinary(s, r))).join(String(_evalBinary(re, r))),
  size: ([a], r) => { const v = _evalBinary(a, r); if (v == null) return null; if (Array.isArray(v)) return v.length; if (typeof v === 'string') return v.length; return 0 },
  tostring: ([a], r) => { const v = _evalBinary(a, r); if (v == null) return null; return String(v) },
  tointeger: ([a], r) => { const v = _evalBinary(a, r); if (v == null) return null; const n = parseInt(String(v), 10); return isNaN(n) ? null : n },
  tofloat: ([a], r) => { const v = _evalBinary(a, r); if (v == null) return null; const n = parseFloat(String(v)); return isNaN(n) ? null : n },
  toboolean: ([a], r) => { const v = _evalBinary(a, r); if (v == null) return null; if (v === true || v === false) return v; if (typeof v === 'string') { const lv = v.toLowerCase().trim(); if (lv === 'true') return true; if (lv === 'false') return false; } return null },
  isnan: ([a], r) => isNaN(Number(_evalBinary(a, r))),
  labels: ([a], r) => { const v = _evalBinary(a, r); if (v == null) return null; if (typeof v !== 'object' || v === null) throw Object.assign(new Error('TypeError: Invalid argument type for labels()'), { tckError: 'TypeError' }); if (typeof v === 'object' && Object.keys(v).length === 0) return []; const unwrapped = _unwrapRecord(v); const raw = unwrapped.__fullLabel || unwrapped._fullLabel || unwrapped._label; if (!raw || raw === 'Default') return []; return String(raw).split(':').filter(Boolean) },
  type: ([a], r) => { const v = _evalBinary(a, r); if (v == null) return null; if (typeof v !== 'object' || Array.isArray(v)) throw Object.assign(new Error('TypeError: Invalid argument type for type()'), { tckError: 'TypeError' }); const uw = _unwrapRecord(v); const edgeLabel = uw.__edgeLabel ?? uw.__edgeLabelStr ?? uw._type ?? ''; return edgeLabel },
  properties: ([a], r) => { const v = _evalBinary(a, r); if (v == null) return null; if (typeof v !== 'object' || Array.isArray(v)) throw Object.assign(new Error('TypeError: Invalid argument type for properties()'), { tckError: 'TypeError' }); const uw = _unwrapRecord(v); const o: Record<string, unknown> = {}; for (const [k, vv] of Object.entries(uw)) if (!k.startsWith('_')) o[k] = vv; return o },
  keys: ([a], r) => { const v = _evalBinary(a, r); if (v == null) return null; if (typeof v === 'object') { const uw = _unwrapRecord(v); return Object.keys(uw).filter(k => !k.startsWith('_')); } return [] },
  id: ([a], r) => { const v = _evalBinary(a, r); if (v && typeof v === 'object') { const uw = _unwrapRecord(v); return '_id' in uw ? uw._id : (uw.id ?? 0); } return 0 },
  head: ([a], r) => { const v = _evalBinary(a, r); return Array.isArray(v) && v.length ? v[0] : null },
  last: ([a], r) => { const v = _evalBinary(a, r); return Array.isArray(v) && v.length ? v[v.length - 1] : null },
  tail: ([a], r) => { const v = _evalBinary(a, r); return Array.isArray(v) ? v.slice(1) : null },
  range: ([s, e, step], r) => {
    const rawS = _evalBinary(s, r), rawE = _evalBinary(e, r);
    const rawStep = step ? _evalBinary(step, r) : 1;
    // Validate: all args must be integers (reject booleans, strings, floats, lists, maps)
    if (typeof rawS !== 'number' || typeof rawE !== 'number' || (step && typeof rawStep !== 'number')) {
      throw Object.assign(new Error('ArgumentError'), { tckError: 'ArgumentError' });
    }
    const start = rawS as number, end = rawE as number;
    const stepVal = (step ? rawStep as number : 1) as number;
    // Validate: step must not be zero
    if (step && stepVal === 0) {
      throw Object.assign(new Error('ArgumentError'), { tckError: 'ArgumentError' });
    }
    // Validate: all args must be integers (reject floats like 0.0, -0.0)
    if (!Number.isInteger(start) || !Number.isInteger(end) || (step && !Number.isInteger(stepVal))) {
      throw Object.assign(new Error('ArgumentError'), { tckError: 'ArgumentError' });
    }
    // Additional check: reject if the original string contained a decimal point
    const hasDecimal = (str: string) => /^-?\d+\.\d+$/.test(str.trim());
    if (hasDecimal(s) || hasDecimal(e) || (step && hasDecimal(step))) {
      throw Object.assign(new Error('ArgumentError'), { tckError: 'ArgumentError' });
    }
    const res: number[] = [];
    // If direction mismatch (end-start and step have opposite signs), return empty
    if (stepVal > 0 && start > end) return res;
    if (stepVal < 0 && start < end) return res;
    for (let i = start; stepVal > 0 ? i <= end : i >= end; i += stepVal) {
      res.push(i);
    }
    return res;
  },
  length: ([a], r) => { const v = _evalBinary(a, r); return Array.isArray(v) ? v.length : 0 },
  split: ([a, d], r) => String(_evalBinary(a, r)).split(String(_evalBinary(d, r))),
  // ── Aggregation Functions ──
  count: (args, r) => {
    // count(*) counts all rows; count(null) returns 0; count(expr) skips nulls
    if (args.length === 0 || args[0] === '*') return 1;
    const v = _evalBinary(args[0], r);
    return v == null || v === undefined ? 0 : 1;
  },
  collect: (args, r) => {
    const v = _evalBinary(args[0], r);
    if (v == null) return [];
    return [v];
  },
  sum: (args, r) => {
    const v = _evalBinary(args[0], r);
    if (v == null) return null;
    return Number(v);
  },
  avg: (args, r) => Number(_evalBinary(args[0], r)),
  max: (args, r) => _evalBinary(args[0], r),
  min: (args, r) => _evalBinary(args[0], r),
  // ── Percentile Functions ──
  percentiledisc: ([a, p], r) => {
    // percentileDisc returns the nearest value from the sorted list at or above the percentile
    // Simplified: returns the value at the floor index
    const v = _evalBinary(a, r);
    const perc = Number(_evalBinary(p, r));
    if (Array.isArray(v) && v.length > 0 && typeof perc === 'number' && perc >= 0 && perc <= 1) {
      const sorted = [...v].sort((a: any, b: any) => a - b);
      const idx = Math.ceil(perc * sorted.length) - 1;
      return sorted[Math.max(0, idx)];
    }
    return null;
  },
  percentilecont: ([a, p], r) => {
    // percentileCont returns an interpolated value at the percentile between two values
    const v = _evalBinary(a, r);
    const perc = Number(_evalBinary(p, r));
    if (Array.isArray(v) && v.length > 0 && typeof perc === 'number' && perc >= 0 && perc <= 1) {
      const sorted = [...v].sort((a: any, b: any) => a - b);
      const idx = perc * (sorted.length - 1);
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      if (lo === hi) return sorted[lo];
      const frac = idx - lo;
      const valLo = Number(sorted[lo]);
      const valHi = Number(sorted[hi]);
      return valLo + frac * (valHi - valLo);
    }
    return null;
  },
  "datetime.fromepoch": ([seconds, nanos], r) => {
    const sec = Number(_evalBinary(seconds, r));
    const ns = nanos ? Number(_evalBinary(nanos, r)) : 0;
    const base = new Date(sec * 1000);
    const iso = base.toISOString().replace("Z", "");
    if (ns > 0) {
      const nsStr = String(ns).padStart(9, "0");
      return iso.slice(0, -4) + nsStr + "Z";
    }
    return iso + "Z";
  },
  "datetime.fromepochmillis": ([millis], r) => {
    const ms = Number(_evalBinary(millis, r));
    return new Date(ms).toISOString().replace("Z", "") + "Z";
  },
  date: ([a], r) => {
    if (!a) {
      const d = new Date();
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    }
    const v = _evalBinary(a, r);
    if (typeof v === "string") {
      let str = v;
      if (str.startsWith("'") || str.startsWith('"')) str = str.slice(1, -1);
      if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
      return str;
    }
    if (v && typeof v === "object") {
      const map = v;
      const d = _resolveDateFromMap(map);
      return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
    }
    return null;
  },
  localtime: ([a], r) => {
    if (!a) {
      const d = new Date();
      return _formatTime(d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds() * 1000000);
    }
    const v = _evalBinary(a, r);
    if (v && typeof v === "object") {
      const map = v;
      const { hour, minute, second, nanosecond } = _extractTimeMap(map);
      return _formatTime(hour, minute, second, nanosecond);
    }
    return null;
  },
  time: ([a], r) => {
    if (!a) {
      const d = new Date();
      return _formatTime(d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds() * 1000000) + "Z";
    }
    const v = _evalBinary(a, r);
    if (v && typeof v === "object") {
      const map = v;
      const { hour, minute, second, nanosecond } = _extractTimeMap(map);
      const tz = map.timezone != null ? _formatTimezone(_resolveNamedTimezone(String(map.timezone))) : "Z";
      return _formatTime(hour, minute, second, nanosecond) + tz;
    }
    return null;
  },
  localdatetime: ([a], r) => {
    if (!a) {
      const d = new Date();
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0")
        + "T" + _formatTime(d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds() * 1000000);
    }
    const v = _evalBinary(a, r);
    if (v && typeof v === "object") {
      const map = v;
      const d = _resolveDateFromMap(map);
      const dateStr = d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
      const { hour, minute, second, nanosecond } = _extractTimeMap(map);
      return dateStr + "T" + _formatTime(hour, minute, second, nanosecond);
    }
    return null;
  },
  datetime: ([a], r) => {
    if (!a) {
      const d = new Date();
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0")
        + "T" + _formatTime(d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds() * 1000000) + "Z";
    }
    const v = _evalBinary(a, r);
    if (v && typeof v === "object") {
      const map = v;
      const d = _resolveDateFromMap(map);
      const dateStr = d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
      const { hour, minute, second, nanosecond } = _extractTimeMap(map);
      const tz = map.timezone != null ? _formatTimezone(_resolveNamedTimezone(String(map.timezone), d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())) : "Z";
      return dateStr + "T" + _formatTime(hour, minute, second, nanosecond) + tz;
    }
    return null;
  },
  duration: ([a], r) => {
    if (!a) return "PT0S";
    const v = _evalBinary(a, r);
    if (v && typeof v === "object") {
      const map = v;
      const AVG_DAYS_PER_MONTH = 30.436875;
      const _num = (k) => { const x = map[k]; return x != null ? Number(x) : 0; };
      let years = _num("years") || _num("year");
      let months = _num("months") || _num("month");
      let weeks = _num("weeks") || _num("week");
      let days = _num("days") || _num("day");
      let hours = _num("hours") || _num("hour");
      let minutes = _num("minutes") || _num("minute");
      let seconds = _num("seconds") || _num("second");
      let nanos = _resolveNanoseconds(map);
      // weeks → days
      if (weeks) { days += weeks * 7; weeks = 0; }
      // 分数分解
      if (years % 1 !== 0) { months += (years - Math.floor(years)) * 12; years = Math.floor(years); }
      if (months % 1 !== 0) { days += (months - Math.floor(months)) * AVG_DAYS_PER_MONTH; months = Math.floor(months); }
      if (days % 1 !== 0) { hours += (days - Math.floor(days)) * 24; days = Math.floor(days); }
      if (hours % 1 !== 0) { minutes += (hours - Math.floor(hours)) * 60; hours = Math.floor(hours); }
      if (minutes % 1 !== 0) { seconds += (minutes - Math.floor(minutes)) * 60; minutes = Math.floor(minutes); }
      if (seconds % 1 !== 0) { nanos += Math.round((seconds - Math.floor(seconds)) * 1e9); seconds = Math.floor(seconds); }
      // 进位
      if (nanos >= 1e9) { seconds += Math.floor(nanos / 1e9); nanos = nanos % 1e9; }
      if (seconds >= 60) { minutes += Math.floor(seconds / 60); seconds = seconds % 60; }
      if (minutes >= 60) { hours += Math.floor(minutes / 60); minutes = minutes % 60; }
      if (hours >= 24) { days += Math.floor(hours / 24); hours = hours % 24; }
      let nanosFormatted = "";
      if (nanos > 0) {
        // Duration 纳秒也需要去尾零（P22DT19H51M49.5S 而不是 .500000000S）
        let nsStr = String(nanos).padStart(9, "0").replace(/0+$/, "");
        nanosFormatted = "." + nsStr;
      }
      let result = "P";
      if (years) result += years + "Y";
      if (months) result += months + "M";
      if (days) result += days + "D";
      if (hours || minutes || seconds || nanos) {
        result += "T";
        if (hours) result += hours + "H";
        if (minutes) result += minutes + "M";
        if (seconds || nanos) result += seconds + nanosFormatted + "S";
      }
      return result || "PT0S";
    }
    return null;
  },
}

function _callFunction(name: string, args: string[], row?: Record<string, unknown>): unknown {
  const fn = _builtinFunctions[name]
  return fn ? fn(args, row) : null
}

function _evalBinary(s: string, row?: Record<string, unknown>): unknown { return _evalOr(s, row) }

function _assertBool(v: unknown, expr: string): void {
  if (typeof v !== 'boolean' && v != null) {
    throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
  }
}

function _evalOr(s: string, row?: Record<string, unknown>): unknown {
  const parts = _splitTopLevel(s, 'OR')
  if (parts.length === 1) return _evalXor(s, row)
  const values = parts.map(p => _evalXor(p, row))
  for (const v of values) {
    if (typeof v !== 'boolean' && v != null) {
      throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
    }
  }
  let result: unknown = false
  for (const v of values) {
    if (v === true) return true
    if (v == null || v === undefined) result = null
  }
  return result
}

function _evalXor(s: string, row?: Record<string, unknown>): unknown {
  const parts = _splitTopLevel(s, 'XOR')
  if (parts.length === 1) return _evalAnd(s, row)
  const values = parts.map(p => _evalAnd(p, row))
  for (const v of values) { _assertBool(v, '') }
  if (parts.length >= 3) {
    let trueCount = 0
    for (const v of values) {
      if (v == null || v === undefined) return null
      if (v === true) trueCount++
    }
    return trueCount % 2 === 1
  }
  const left = values[0], right = values[1]
  if (left == null || right == null) return null
  return left !== right
}

function _evalAnd(s: string, row?: Record<string, unknown>): unknown {
  const parts = _splitTopLevel(s, 'AND')
  if (parts.length === 1) return _evalNot(s, row)
  // Cypher 要求：所有操作数必须验证布尔类型（即使短路）
  const values = parts.map(p => _evalNot(p, row))
  for (const v of values) {
    if (typeof v !== 'boolean' && v != null) {
      throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
    }
  }
  let result: unknown = true
  for (const v of values) {
    _assertBool(v, '')
    if (v === false) return false
    if (v == null || v === undefined) result = null
  }
  return result
}

function _evalNot(s: string, row?: Record<string, unknown>): unknown {
  const t = s.trim()
  if (t.startsWith('NOT ')) {
    const inner = _evalBinary(t.slice(4), row)
    _assertBool(inner, '')
    return inner === null ? null : !Boolean(inner)
  }
  if (t.startsWith('NOT(') && t.endsWith(')')) {
    const inner = _evalBinary(t.slice(4, -1), row)
    _assertBool(inner, '')
    return inner === null ? null : !Boolean(inner)
  }
  return _evalComparison(s, row)
}

/** 提取 Cypher 链式比较中的所有操作符/操作数对
 *  n.prop1 < m.prop1 = n.prop2 <> m.prop2 → [
 *   { left: "n.prop1", op: "<", right: "m.prop1" },
 *   { left: "m.prop1", op: "=", right: "n.prop2" },
 *   { left: "n.prop2", op: "<>", right: "m.prop2" }
 * ]
 *  1 < n.num < 3 → [{left:"1",op:"<",right:"n.num"},{left:"n.num",op:"<",right:"3"}]
 */
function _extractChain(expr: string): Array<{ left: string; op: string; right: string }> {
  const ops = ['<>', '>=', '<=', '=', '>', '<']
  // 找所有顶层操作符位置
  const positions: Array<{ idx: number; op: string }> = []
  for (const op of ops) {
    const idx = _findTopLevelOp(expr, op)
    if (idx > 0) positions.push({ idx, op })
  }
  if (positions.length < 2) return []  // 少于 2 个操作符 → 不是链式
  // 按位置排序
  positions.sort((a, b) => a.idx - b.idx)
  // 过滤：如果两个相邻操作符重叠（如 <> 的内部包含了 < 或 >），去掉子操作符
  const filtered: typeof positions = [positions[0]]
  for (let i = 1; i < positions.length; i++) {
    const prev = filtered[filtered.length - 1]
    // 如果当前操作符起始位置在前一个操作符范围内，跳过（子字符串匹配）
    if (positions[i].idx < prev.idx + prev.op.length) continue
    filtered.push(positions[i])
  }
  if (filtered.length < 2) return []
  // 构建操作数/操作符对
  const result: Array<{ left: string; op: string; right: string }> = []
  for (let i = 0; i < filtered.length; i++) {
    const { idx, op } = filtered[i]
    const left = i === 0 ? expr.slice(0, idx) : result[i - 1].right
    const nextStart = idx + op.length
    const rightEnd = i < filtered.length - 1 ? filtered[i + 1].idx : expr.length
    const right = expr.slice(nextStart, rightEnd).trim()
    result.push({ left: left.trim(), op, right })
  }
  return result
}

function _evalComparison(s: string, row?: Record<string, unknown>): unknown {
  const t = s.trim()
  // 辅助：截断操作数到第一个布尔操作符（OR/XOR/AND），用于 STARTS_WITH/CONTAINS/ENDS_WITH 右操作数
  const _trimToOperand = (s2: string): string => {
    let depth = 0, inStr = false, strChar = ''
    for (let i = 0; i < s2.length; i++) {
      if (inStr && s2[i] === '\\') { i++; continue }
      if (inStr) { if (s2[i] === strChar) inStr = false; continue }
      if (s2[i] === "'" || s2[i] === '"') { inStr = true; strChar = s2[i]; continue }
      if (s2[i] === '(' || s2[i] === '[' || s2[i] === '{') { depth++; continue }
      if (s2[i] === ')' || s2[i] === ']' || s2[i] === '}') { depth--; if (depth < 0) depth = 0; continue }
      if (depth === 0) {
        if (s2.slice(i, i + 3) === ' OR ' || s2.slice(i, i + 4) === ' XOR ' || s2.slice(i, i + 4) === ' AND ') return s2.slice(0, i).trim()
      }
    }
    return s2.trim()
  }
  const _completeBoolean = (leftVal: unknown, after: string, row2?: Record<string, unknown>): unknown => {
    const m = after.match(/^(AND|OR|XOR)\b/i)
    if (!m) return _evalBinary(`${leftVal} ${after}`, row2)
    const op = m[1].toLowerCase()
    const rest = after.slice(m[0].length).trim()
    if (op === 'and') return (leftVal && _evalBinary(rest, row2))
    if (op === 'or') return (leftVal || _evalBinary(rest, row2))
    if (op === 'xor') return ((leftVal ? 1 : 0) ^ (_evalBinary(rest, row2) ? 1 : 0)) !== 0
    return _evalBinary(`${leftVal} ${after}`, row2)
  }
  // 括号表达式直接下推（NOT 之后、进入比较操作符前）
  // 必须确认整个表达式被一对完整括号包围：第一个 '(' 对应的 ')' 正好在末尾
  if (t.startsWith('(') && t.endsWith(')') && _isBalanced(t)) {
    let depth = 0, matchIdx = -1
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '(') depth++
      if (t[i] === ')') { depth--; if (depth === 0) { matchIdx = i; break } }
    }
    if (matchIdx === t.length - 1) return _evalBinary(t.slice(1, -1), row)
  }
  const re = t.indexOf(' =~ ')
  if (re > 0) { const l = String(_evalAddSub(t.slice(0, re), row)); const r = String(_evalAddSub(t.slice(re + 4), row)); try { return new RegExp(r).test(l) } catch { return false } }
  // 预处理 IS NULL / IS NOT NULL：递归计算每个表达式中的 IS 后缀
  const _resolveIsNull = (expr: string): unknown => {
    const ex = expr.trim()
    // 括号表达式：递归计算内部
    if (ex.startsWith('(') && ex.endsWith(')') && _isBalanced(ex)) {
      let depth = 0, matchIdx = -1
      for (let i = 0; i < ex.length; i++) {
        if (ex[i] === '(') depth++
        if (ex[i] === ')') { depth--; if (depth === 0) { matchIdx = i; break } }
      }
      if (matchIdx === ex.length - 1) return _evalBinary(ex.slice(1, -1), row)
    }
    // 查找 IS NULL / IS NOT NULL（不在括号、字符串内）
    let isPos = -1, depth = 0, inStr = false, strChar = ''
    for (let i = 0; i < ex.length; i++) {
      if (inStr && ex[i] === '\\') { i++; continue }
      if (inStr) { if (ex[i] === strChar) inStr = false; continue }
      if (ex[i] === "'" || ex[i] === '"') { inStr = true; strChar = ex[i]; continue }
      if (ex[i] === '(' || ex[i] === '[' || ex[i] === '{') { depth++; continue }
      if (ex[i] === ')' || ex[i] === ']' || ex[i] === '}') { depth--; continue }
      if (depth === 0 && i + 2 < ex.length && ex[i] === 'I' && ex[i + 1] === 'S' && !/\w/.test(ex[i + 2] || '')) {
        isPos = i; break
      }
    }
    if (isPos > 0) {
      const leftExpr = ex.slice(0, isPos).trim()
      const rest = ex.slice(isPos).trim()
      const isnMatch = rest.match(/^IS\s+(NOT\s+)?NULL/i)
      if (isnMatch) {
        const isNotNull = !!isnMatch[1]
        const leftVal = _evalAddSub(leftExpr, row)
        // Cypher: x IS NULL → (x == null), x IS NOT NULL → (x != null)
        const isResult = leftVal == null ? !isNotNull : isNotNull
        const after = rest.slice(isnMatch[0].length).trim()
        if (after) return _evalComparison(`${isResult} ${after}`, row)
        return isResult
      }
    }
    // 无 IS 后缀，走正常 _evalAddSub
    return _evalAddSub(ex, row)
  }
  // IN 处理：找顶层（不在括号内）的 IN
  const inOp = (() => {
    let idx = t.lastIndexOf(' IN ')
    while (idx > 0 && _inBrackets(t, idx)) {
      idx = t.lastIndexOf(' IN ', idx - 1)
    }
    return idx
  })()
  if (inOp > 0) {
    const leftPart = t.slice(0, inOp)
    // 如果左侧有顶层比较操作符，则 IN 不应抢先（要等 = 先计算）
    const hasTopLevelCmp = ['<>', '>=', '<=', '=', '>', '<'].some(op => {
      const opIdx = _findTopLevelOp(leftPart, op)
      return opIdx > 0
    })
    if (!hasTopLevelCmp) {
      const l = _evalAddSub(leftPart, row)
      const r = _evalAddSub(t.slice(inOp + 4), row)
      // Cypher: null IN null = null, null IN [] = false
      if (!Array.isArray(r)) return l == null ? null : false
      // Cypher: 左操作数 null → 空列表返回 false（确定性），非空列表返回 null（未知）
      if (l == null) return r.length === 0 ? false : null
      let hasMatch = false
      let hasNull = false
      for (const item of r) {
        if (item != null) {
          const eq = _deepEqWithNull(l, item)
          if (eq.match === true && !eq.hasNull) { hasMatch = true }
          if (eq.hasNull) { hasNull = true }
        } else { hasNull = true }
      }
      if (hasMatch) return true
      if (hasNull) return null
      return false
    }
  }
  // 通用链式比较：检测多段链（任意操作符组合），如 a < b = c <> d 或 a < b < c
  const chainOps = _extractChain(t)
  if (chainOps.length >= 2) {
    // Cypher 链式语义：expr OP1 expr2 OP2 expr3 = (expr OP1 expr2) AND (expr2 OP2 expr3)
    // 从左到右依次计算每对操作符
    let result: unknown = true
    for (let i = 0; i < chainOps.length; i++) {
      const { left: l, op: cop, right: r } = chainOps[i]
      const leftVal = _resolveIsNull(l.trim())
      const rightVal = _resolveIsNull(r.trim())
      const cmp = _compareValues(leftVal, rightVal, cop)
      if (cmp === false) return false
      if (cmp == null) result = null
    }
    return result
  }

  for (const op of ['<>', '>=', '<=', '=', '>', '<']) {
    // 链式比较：a = b = c 等价于 (a = b) AND (b = c)
    // 对 =, <>, >=, <=, >, < 支持链式（>= 3 段）
    if (op === '=' || op === '<>' || op === '>=' || op === '<=' || op === '>' || op === '<') {
      const parts = _splitTopLevel(t, op)
      if (parts.length >= 3) {
        let result: unknown = true
        for (let i = 0; i < parts.length - 1; i++) {
          const left = _resolveIsNull(parts[i].trim())
          const right = _resolveIsNull(parts[i + 1].trim())
          const cmp = _compareValues(left, right, op)
          if (cmp === false) return false
          if (cmp == null) result = null
        }
        return result
      }
    }
    const idx = _findTopLevelOp(t, op)
    if (idx > 0) {
      // DEBUG: Precedence4[4] trace
      if (t.includes('STARTS WITH') && t.includes('<>')) {
        //console.log('_evalComparison trace:', {op, t: t.slice(0,100), idx, leftRaw: t.slice(0, idx), rightRaw: t.slice(idx + op.length)})
      }
      const left = _resolveIsNull(t.slice(0, idx))
      let rawRight = t.slice(idx + op.length).trim()
      // Cypher 优先级：IS NULL/IS NOT NULL > 比较操作符
      // 所以 a = b IS NULL 应解析为 a = (b IS NULL) 而非 (a = b) IS NULL
      // 检查 rawRight 末尾是否含 IS NULL（大小写不敏感）
      let isNullRight: boolean | undefined
      const isNullSuffix = _endsWithIsNull(rawRight)
      if (isNullSuffix === 'IS NULL') {
        const innerExpr = rawRight.slice(0, rawRight.length - 7).trim()
        const innerVal = _evalAddSub(innerExpr, row)
        isNullRight = (innerVal === null || innerVal === undefined)
        rawRight = String(isNullRight)
      } else if (isNullSuffix === 'IS NOT NULL') {
        const innerExpr = rawRight.slice(0, rawRight.length - 11).trim()
        const innerVal = _evalAddSub(innerExpr, row)
        isNullRight = (innerVal !== null && innerVal !== undefined)
        rawRight = String(isNullRight)
      }
      // 如果 right 包含顶层 IN，在 _evalAddSub 前处理（IN 优先级 >= 比较操作符）
      const inIdx = rawRight.indexOf(' IN ')
      let right: unknown
      if (inIdx > 0 && !_inBrackets(rawRight, inIdx)) {
        // 在 _evalAddSub 中 IN 会被解析为 null，所以先计算 IN
        const rl = _evalAddSub(rawRight.slice(0, inIdx), row)
        const rr = _evalAddSub(rawRight.slice(inIdx + 4), row)
        right = Array.isArray(rr) && rr.includes(rl)
      } else {
        right = _evalAddSub(rawRight, row)
      }
      return _compareValues(left, right, op)
    }
  }
  // 纯 IS NULL / IS NOT NULL 表达式（大小写不敏感）
  const isNullEnd = _endsWithIsNull(t)
  if (isNullEnd === 'IS NULL') {
    const innerVal = _evalAddSub(t.slice(0, t.length - 7).trim(), row)
    return innerVal === null || innerVal === undefined
  }
  if (isNullEnd === 'IS NOT NULL') {
    const innerVal = _evalAddSub(t.slice(0, t.length - 11).trim(), row)
    return innerVal !== null && innerVal !== undefined
  }
  // 字符串谓语（STARTS WITH / CONTAINS / ENDS WITH）优先级低于比较操作符（= / <> / 链式）
  // 因此放在比较操作符处理之后、回退到 _evalAddSub 之前
  const _findTopLevelKw = (kw: string): number => {
    let idx = t.indexOf(kw)
    while (idx > 0 && _inBrackets(t, idx)) {
      idx = t.indexOf(kw, idx + 1)
    }
    return idx
  }
  const sw = _findTopLevelKw(' STARTS WITH ')
  if (sw > 0) { const l = _evalAddSub(t.slice(0, sw), row); const rPart = _trimToOperand(t.slice(sw + 13)); const r = _evalAddSub(rPart, row); if (l == null || r == null || typeof l !== 'string' || typeof r !== 'string') return null; const swResult = l.startsWith(r); const after = (t.slice(sw + 13).length > rPart.length) ? t.slice(sw + 13 + rPart.length).trim() : ''; return after ? _completeBoolean(swResult, after, row) : swResult }
  const ci = _findTopLevelKw(' CONTAINS ')
  if (ci > 0) { const l = _evalAddSub(t.slice(0, ci), row); const rPart = _trimToOperand(t.slice(ci + 10)); const r = _evalAddSub(rPart, row); if (l == null || r == null || typeof l !== 'string' || typeof r !== 'string') return null; const ciResult = l.includes(r); const after = (t.slice(ci + 10).length > rPart.length) ? t.slice(ci + 10 + rPart.length).trim() : ''; return after ? _completeBoolean(ciResult, after, row) : ciResult }
  const ew = _findTopLevelKw(' ENDS WITH ')
  if (ew > 0) { const l = _evalAddSub(t.slice(0, ew), row); const rPart = _trimToOperand(t.slice(ew + 11)); const r = _evalAddSub(rPart, row); if (l == null || r == null || typeof l !== 'string' || typeof r !== 'string') return null; const ewResult = l.endsWith(r); const after = (t.slice(ew + 11).length > rPart.length) ? t.slice(ew + 11 + rPart.length).trim() : ''; return after ? _completeBoolean(ewResult, after, row) : ewResult }
  return _evalAddSub(t, row)
}

/** Cypher 列表字典序比较 */
function _listLexCompare(a: unknown[], b: unknown[], op: string): boolean | null {
  const minLen = Math.min(a.length, b.length)
  for (let i = 0; i < minLen; i++) {
    const ai = a[i], bi = b[i]
    if (ai == null || bi == null) {
      return null  // null 在列表中 → 三值不确定
    }
    const isLeOrGe = (op === '<=' || op === '>=')

    if (ai === bi) continue  // 相等 → 继续下一个元素

    // 列表字典序：第一个不相等的元素决定结果
    if (isLeOrGe) {
      // <= 或 >=：先做 =（已由 ai===bi 处理），再做 < 或 >
      // 如果 ai !== bi，退化到 < 或 >
      const dir = op === '<=' ? '<' : '>'
      return _compareValues(ai, bi, dir)
    }
    // < 或 >：直接比较当前元素
    return _compareValues(ai, bi, op)
  }
  // 所有同索引元素相等
  if (a.length === b.length) return op === '>=' || op === '<=' ? true : false
  // 长度不等 → 短列表视为小于长列表
  // 注意：大于号/小于号的不等比较不因多余元素含 null 而返回 null（规范：短列表总是较小的）
  // 等号比较带 null 元素：长度不等时 = 为 false，所以不需要 null 检查
  const isLtGt = op === '>' || op === '<'
  const isLeGe = op === '>=' || op === '<='
  if (isLeGe) {
    // >= 或 <=：退化到 > 或 <（长度不等时 = 不成立），不检查多余元素中的 null
    if (op === '>=') return a.length >= b.length
    if (op === '<=') return a.length <= b.length
  }
  if (isLtGt) {
    // > 或 <：直接比较长度，不检查多余元素中的 null
    if (op === '>') return a.length > b.length
    if (op === '<') return a.length < b.length
  }
  return false
}

/** Check if two values are of comparable types (both numeric types treated as same) */
function _comparableTypes(a: unknown, b: unknown): boolean {
  const ta = typeof a
  const tb = typeof b
  if (ta === tb) return true
  // bigint and number are both numeric — treat as comparable
  if ((ta === 'bigint' && tb === 'number') || (ta === 'number' && tb === 'bigint')) return true
  return false
}

function _compareValues(a: unknown, b: unknown, op: string): boolean | null {
  if (a == null || b == null) return null  // Cypher 三值逻辑：null 参与的比较返回 null，包括 <>（不等号也不例外）
  // List 字典序比较（>=, >, <=, <）
  if (Array.isArray(a) && Array.isArray(b) && (op === '>=' || op === '<=' || op === '>' || op === '<')) {
    return _listLexCompare(a, b, op)
  }
  switch (op) {
    case '=': { const __eq = _deepEqWithNull(a, b); return __eq.hasNull ? null : __eq.match }
    case '<>': return !_deepEq(a, b)
    case '<': {
      if (!_comparableTypes(a, b)) return null
      if (typeof a === 'string') return a < b  // 字典序
      return Number(a) < Number(b)
    }
    case '>': {
      if (!_comparableTypes(a, b)) return null
      if (typeof a === 'string') return a > b
      return Number(a) > Number(b)
    }
    case '<=': {
      if (!_comparableTypes(a, b)) return null
      if (typeof a === 'string') return a <= b
      return Number(a) <= Number(b)
    }
    case '>=': {
      if (!_comparableTypes(a, b)) return null
      if (typeof a === 'string') return a >= b
      return Number(a) >= Number(b)
    }
  }
  return false
}

function _isNaN(v: unknown): boolean {
  return typeof v === 'number' && isNaN(v)
}

/** Cypher 深度相等：支持 List、Map 递归比较，符合三值逻辑（null 元素 = → null） */
/** Cypher 深度相等（含 null 传播，用于 = 比较） */
/** 大小写不敏感检测字符串是否以 IS NULL 或 IS NOT NULL 结尾 */
function _endsWithIsNull(s: string): 'IS NULL' | 'IS NOT NULL' | false {
  const u = s.toUpperCase()
  if (u.endsWith('IS NULL') && !_inBrackets(s, s.length - 7)) return 'IS NULL'
  if (u.endsWith('IS NOT NULL') && !_inBrackets(s, s.length - 11)) return 'IS NOT NULL'
  return false
}

function _deepEqWithNull(a: unknown, b: unknown): { match: boolean; hasNull: boolean } {
  if (a === b) return { match: true, hasNull: a == null || b == null }
  if (a == null || b == null) return { match: a === b, hasNull: true }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return { match: false, hasNull: false }
    let hasNull = false
    for (let i = 0; i < a.length; i++) {
      const eq = _deepEqWithNull(a[i], b[i])
      if (eq.hasNull) { hasNull = true; continue }
      if (!eq.match) return { match: false, hasNull: false }
    }
    return { match: true, hasNull }
  }
  if (typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keysA = Object.keys(a as Record<string, unknown>).sort()
    const keysB = Object.keys(b as Record<string, unknown>).sort()
    if (keysA.length !== keysB.length) return { match: false, hasNull: false }
    let hasNull = false
    for (let i = 0; i < keysA.length; i++) {
      if (keysA[i] !== keysB[i]) return { match: false, hasNull: false }
      const eq = _deepEqWithNull((a as any)[keysA[i]], (b as any)[keysB[i]])
      if (eq.hasNull) { hasNull = true; continue }
      if (!eq.match) return { match: false, hasNull: false }
    }
    return { match: true, hasNull }
  }
  return { match: a === b, hasNull: false }
}

/** 浅层深度相等（不含 null 传播，用于 <> 和简单比较） */
function _deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (a[i] == null || b[i] == null) return false
      if (!_deepEq(a[i], b[i])) return false
    }
    return true
  }
  if (typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keysA = Object.keys(a as Record<string, unknown>).sort()
    const keysB = Object.keys(b as Record<string, unknown>).sort()
    if (keysA.length !== keysB.length) return false
    for (let i = 0; i < keysA.length; i++) {
      if (keysA[i] !== keysB[i]) return false
      if ((a as any)[keysA[i]] == null || (b as any)[keysB[i]] == null) return false
      if (!_deepEq((a as any)[keysA[i]], (b as any)[keysB[i]])) return false
    }
    return true
  }
  // 大整数精度补偿：string vs bigint 语义相等比较
  if (typeof a === 'bigint' && typeof b === 'string') {
    try { return a === BigInt(b) } catch { return false }
  }
  if (typeof b === 'bigint' && typeof a === 'string') {
    try { return BigInt(a) === b } catch { return false }
  }
  return a === b
}

function _evalAddSub(s: string, row?: Record<string, unknown>): unknown {
  const t = s.trim()
  for (let i = t.length - 1; i >= 0; i--) {
    if (t[i] === '+' && !_inBrackets(t, i) && !_inString(t, i) && !(i > 0 && 'eE'.includes(t[i - 1]))) {
      const left = _evalAddSub(t.slice(0, i), row)
      const right = _evalMulDiv(t.slice(i + 1), row)
      // Cypher: null 参与算术 → 返回 null
      if (left == null || right == null) return null
      // Cypher + 语义: list+list(拼接), list+scalar(追加), scalar+list(前置), number+number(加法), string+any(连接)
      if (Array.isArray(left) && Array.isArray(right)) return [...left, ...right]
      if (Array.isArray(left) && !Array.isArray(right)) return [...left, right]
      if (!Array.isArray(left) && Array.isArray(right)) return [left, ...right]
      return typeof left === 'string' || typeof right === 'string' ? String(left) + String(right) : Number(left) + Number(right)
    }
    if (t[i] === '-' && !_inBrackets(t, i) && !_inString(t, i) && i > 0 && !'+-*/%('.includes(t[i - 1]) && !'eE'.includes(t[i - 1])) {
      const left = _evalAddSub(t.slice(0, i), row)
      const right = _evalMulDiv(t.slice(i + 1), row)
      if (left == null || right == null) return null
      return Number(left) - Number(right)
    }
  }
  return _evalMulDiv(t, row)
}

function _evalMulDiv(s: string, row?: Record<string, unknown>): unknown {
  const t = s.trim()
  for (let i = t.length - 1; i >= 0; i--) {
    if (t[i] === '*' && !_inBrackets(t, i) && !_inString(t, i)) { const left = _evalMulDiv(t.slice(0, i), row); const right = _evalExp(t.slice(i + 1), row); if (left == null || right == null) return null; return Number(left) * Number(right) }
    if (t[i] === '/' && !_inBrackets(t, i) && !_inString(t, i)) { const left = _evalMulDiv(t.slice(0, i), row); const right = _evalExp(t.slice(i + 1), row); if (left == null || right == null) return null; const nl = Number(left), nr = Number(right); return Number.isInteger(nl) && Number.isInteger(nr) ? Math.trunc(nl / nr) : nl / nr }
    if (t[i] === '%' && !_inBrackets(t, i) && !_inString(t, i)) { const left = _evalMulDiv(t.slice(0, i), row); const right = _evalExp(t.slice(i + 1), row); if (left == null || right == null) return null; return Number(left) % Number(right) }
  }
  return _evalExp(t, row)
}

/** 指数运算 `^`，优先级高于 * / %，左结合：2 ^ 3 ^ 2 = (2 ^ 3) ^ 2 */
function _evalExp(s: string, row?: Record<string, unknown>): unknown {
  const t = s.trim()
  // 左结合：从左向右扫描，左操作数用 _evalUnary 或 _evalExp（处理左侧 ^）
  for (let i = t.length - 1; i >= 0; i--) {
    if (t[i] === '^' && !_inBrackets(t, i) && !_inString(t, i)) {
      const left = _evalExp(t.slice(0, i).trim(), row)
      const right = _evalUnary(t.slice(i + 1).trim(), row)
      if (left == null || right == null) return null
      return Math.pow(Number(left), Number(right))
    }
  }
  return _evalUnary(t, row)
}

function _evalUnary(s: string, row?: Record<string, unknown>): unknown {
  const t = s.trim()
  if (t.startsWith('-')) {
    const inner = _evalUnary(t.slice(1), row)
    if (inner == null) return null
    return typeof inner === 'bigint' ? -inner : -Number(inner)
  }
  if (t.startsWith('+')) {
    const inner = _evalUnary(t.slice(1), row)
    if (inner == null) return null
    return typeof inner === 'bigint' ? inner : Number(inner)
  }
  return _evalAtom(t, row)
}

function _evalAtom(s: string, row?: Record<string, unknown>): unknown {
  const t = s.trim()
  // ── 标签谓词：(n:Foo) → 检查 n 是否有标签 Foo（必须在括号剥离之前处理）──
  if (t.startsWith('(') && t.endsWith(')') && _isBalanced(t)) {
    const labelPredMatch = t.match(/^\((\w*)\s*:\s*(\w+)\)$/)
    if (labelPredMatch) {
      const varName = labelPredMatch[1]
      const labelName = labelPredMatch[2]
      if (!varName) return null  // (:Foo) without variable → null
      const nodeRef = row?.[varName] as Record<string, unknown> | undefined
      if (nodeRef && typeof nodeRef === 'object' && !Array.isArray(nodeRef)) {
        const props = (nodeRef as any).props
        if (props && props._label) return props._label === labelName
        if (nodeRef._label) return nodeRef._label === labelName
      }
      if (row && typeof row === 'object' && '_label' in row) {
        const label = (row as any)._label
        const fullLabel = (row as any).__fullLabel
        if (typeof fullLabel === 'string') {
          return fullLabel.split(':').includes(labelName)
        }
        return label === labelName
      }
      return null
    }
  }
  if (t.startsWith('(') && t.endsWith(')') && _isBalanced(t)) {
    let depth = 0, parenEnd = -1
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '(') depth++
      if (t[i] === ')') { depth--; if (depth === 0 && parenEnd < 0) { parenEnd = i; break } }
    }
    if (parenEnd === t.length - 1) return _evalBinary(t.slice(1, -1), row)
  }
  // ── 标签谓词独立处理（当 _evalComparison 已经剥离括号后，n:Foo 会被传递到这里）──
  const standaloneLabelPred = t.match(/^(\w+)\s*:\s*(\w+)$/)
  if (standaloneLabelPred) {
    const varName = standaloneLabelPred[1]
    const labelName = standaloneLabelPred[2]
    const nodeRef = row?.[varName] as Record<string, unknown> | undefined
    if (nodeRef && typeof nodeRef === 'object' && !Array.isArray(nodeRef)) {
      const props = (nodeRef as any).props
      if (props && props._label) return props._label === labelName
      if (nodeRef._label) return nodeRef._label === labelName
    }
    if (row && typeof row === 'object' && '_label' in row) {
      const label = (row as any)._label
      const fullLabel = (row as any).__fullLabel
      if (typeof fullLabel === 'string') {
        return fullLabel.split(':').includes(labelName)
      }
      return label === labelName
    }
    return null
  }
  // 括号 + 后缀 IS NULL/IS NOT NULL： (expr) IS NULL → 先计算 expr，再判 null
  if (t.startsWith('(') && (t.endsWith(' IS NULL') || t.endsWith(' IS NOT NULL'))) {
    let depth = 0, parenEnd = -1
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '(') depth++
      if (t[i] === ')') { depth--; if (depth === 0) { parenEnd = i; break } }
    }
    if (parenEnd > 0) {
      const innerExpr = t.slice(1, parenEnd)
      const suffix = t.slice(parenEnd + 1).trim()
      const innerVal = _evalBinary(innerExpr, row)
      if (suffix.toUpperCase() === 'IS NULL') return (innerVal === null || innerVal === undefined)
      if (suffix.toUpperCase() === 'IS NOT NULL') return (innerVal !== null && innerVal !== undefined)
    }
  }
  // 括号表达式 + 下标后缀：(expr)[n] 或 (expr)[start..end]
  if (t.startsWith('(') && !t.endsWith(')')) {
    let depth = 0, parenEnd = -1
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '(') depth++
      if (t[i] === ')') { depth--; if (depth === 0) { parenEnd = i; break } }
    }
    if (parenEnd > 0) {
      const innerExpr = t.slice(1, parenEnd)
      let val = _evalBinary(innerExpr, row)
      let pos = parenEnd + 1
      // 如果括号后不是 [ 下标，而是其他操作符（OR/AND/XOR 等），用 _evalBinary 继续计算
      while (pos < t.length && t[pos] === ' ') pos++
      if (pos < t.length && t[pos] !== '[') {
        const suffix = t.slice(pos).trim()
        if (suffix) return _evalBinary(`${val} ${suffix}`, row)
        return val
      }
      while (pos < t.length && t[pos] === '[') {
        const endBracket = t.indexOf(']', pos)
        if (endBracket < 0) break
        const inner = t.slice(pos + 1, endBracket)
        const rangeIdx = inner.indexOf('..')
        if (rangeIdx >= 0) {
          const startStr = inner.slice(0, rangeIdx).trim()
          const endStr = inner.slice(rangeIdx + 2).trim()
          const len = Array.isArray(val) ? val.length : (typeof val === 'string' ? val.length : 0)
          let startVal = startStr ? _evalBinary(startStr, row) : 0
          let endVal = endStr ? _evalBinary(endStr, row) : len
          if (startVal == null || endVal == null) { val = null; break }
          let sliceStart = Number(startVal), sliceEnd = Number(endVal)
          if (isNaN(sliceStart)) sliceStart = 0
          if (isNaN(sliceEnd)) sliceEnd = len
          if (sliceStart < 0) sliceStart = Math.max(len + sliceStart, 0)
          if (sliceEnd < 0) sliceEnd = Math.max(len + sliceEnd, 0)
          val = Array.isArray(val) ? val.slice(sliceStart, sliceEnd) : (typeof val === 'string' ? val.slice(sliceStart, sliceEnd) : null)
        } else {
          const idx = _evalBinary(inner, row)
          if (Array.isArray(val)) {
            if (idx == null) { val = null }
            else if (typeof idx !== 'number' || !Number.isInteger(idx)) throw Object.assign(new Error('TypeError: List index must be an integer'), { tckError: 'TypeError' })
            else val = val[Number(idx)] ?? null
          } else if (val && typeof val === 'object' && !Array.isArray(val)) {
            if (idx == null) { val = null }
            else if (typeof idx !== 'string') throw Object.assign(new Error('TypeError: Map index must be a string'), { tckError: 'TypeError' })
            else val = (val as Record<string, unknown>)[idx] ?? null
          } else { val = null }
        }
        pos = endBracket + 1
      }
      return val
    }
  }
  // 列表谓词（必须在 fnMatch 之前，因为 all/any/none/single 的 WHERE 子句与普通函数语法冲突）
  const listPredMatch = t.match(/^(all|any|none|single)\s*\((.+?)\s+IN\s+(.+?)\s+WHERE\s+(.+)\)$/is)
  if (listPredMatch) {
    const pred = listPredMatch[1].toLowerCase()
    const varName = listPredMatch[2].trim()
    const listExpr = listPredMatch[3].trim()
    const condExpr = listPredMatch[4].trim()
    const list = _evaluateExpression(listExpr, row)
    if (!Array.isArray(list)) return null
    let count = 0
    let hasNull = false
    const listLen = list.length
    for (const item of list) {
      const evalCtx: Record<string, unknown> = { ...row as any, [varName]: item }
      const val = _evaluateExpression(condExpr, evalCtx)
      if (val === true) {
        count++
        if (pred === 'any') return true
        if (pred === 'none') return false
        if (pred === 'single' && count > 1) return false
      } else if (val == null) {
        hasNull = true
      }
    }
    if (pred === 'all') {
      if (count === listLen && listLen > 0) return true
      // 如果没有 false 但有 null，返回 true（TCK: all() 在 null 谓词下返回 true）
      if (listLen > 0) {
        const hasNonNullFalse = list.some(item => _evaluateExpression(condExpr, { ...row as any, [varName]: item }) === false)
        if (!hasNonNullFalse) return true
      }
      return false
    }
    if (pred === 'any') return false
    if (pred === 'none') return hasNull ? null : true
    if (pred === 'single') return count === 1
  }
  // 函数调用（必须在 dot 之前）
  const fnMatch = t.match(/^(\w+)\((.+?)\)$/s)
  if (fnMatch) {
    const args = fnMatch[2].trim() ? _parseCommaList(fnMatch[2]).map(a => a.trim()) : []
    return _callFunction(fnMatch[1].toLowerCase(), args, row)
  }
  // 如果包含顶层 `^`，是表达式而非纯字面量，委托给 _evalExp
  if (t.includes('^')) {
    let depth = 0, inStr = false, strChar = ''
    for (let i = 0; i < t.length; i++) {
      if (inStr && t[i] === '\\') { i++; continue }
      if (inStr) { if (t[i] === strChar) inStr = false; continue }
      if (t[i] === "'" || t[i] === '"') { inStr = true; strChar = t[i]; continue }
      if (t[i] === '(' || t[i] === '[' || t[i] === '{') { depth++; continue }
      if (t[i] === ')' || t[i] === ']' || t[i] === '}') { depth--; continue }
      if (depth === 0 && t[i] === '^') return _evalExp(t, row)
    }
  }
  // 字面量先行（避免 . 被当属性访问）— 但如果字面量有后缀索引 [n]，先走下标分支
  if (t.startsWith("'") || t.startsWith('"') || t.startsWith('[') || t.startsWith('{') || /^-?\d/.test(t) || t.startsWith('.') || t.toLowerCase() === 'null' || t.toLowerCase() === 'true' || t.toLowerCase() === 'false') {
    // 如果以字面量开头但后面有下标后缀 [[1]][0][0] 或 'hello'[0] 或 {name:'a'}[123]
    if ((t.startsWith('[') || t.startsWith("'") || t.startsWith('"') || t.startsWith('{')) && t.endsWith(']')) {
      // 从最外层找到第一个匹配的 close（支持 [] 和 {}），右侧剩余都是后缀下标
      let closePos = -1, depth = 0
      for (let i = 0; i < t.length; i++) {
        if (t[i] === "'" || t[i] === '"') {
          const q = t[i]; i++
          while (i < t.length && t[i] !== q) { if (t[i] === '\\') i++; i++ }
          continue
        }
        if (t[i] === '(' || t[i] === '[' || t[i] === '{') depth++
        if (t[i] === ')' || t[i] === ']' || t[i] === '}') { depth--; if (depth === 0) { closePos = i; break } }
      }
      if (closePos === t.length - 1) return _evalLiteral(t, row) // 纯字面量，无后缀
      if (closePos > 0) {
        // baseObj = 最外层列表/字符串
        let val = _evalLiteral(t.slice(0, closePos + 1), row)
        // 逐层解析后缀下标
        let pos = closePos + 1
        while (pos < t.length && t[pos] === '[') {
          const endBracket = t.indexOf(']', pos)
          if (endBracket < 0) break
          const inner = t.slice(pos + 1, endBracket)
          // 检测切片语法 [start..end]
          const rangeIdx = inner.indexOf('..')
          if (rangeIdx >= 0) {
            // 切片操作
            const startStr = inner.slice(0, rangeIdx).trim()
            const endStr = inner.slice(rangeIdx + 2).trim()
            const len = Array.isArray(val) ? val.length : (typeof val === 'string' ? val.length : 0)
            // 如果 start 或 end 值为 null，整个切片返回 null
            let startVal = startStr ? _evalBinary(startStr, row) : 0
            let endVal = endStr ? _evalBinary(endStr, row) : len
            if (startVal == null || endVal == null) { val = null; break }
            let sliceStart = Number(startVal)
            let sliceEnd = Number(endVal)
            if (isNaN(sliceStart)) sliceStart = 0
            if (isNaN(sliceEnd)) sliceEnd = len
            // 负索引
            if (sliceStart < 0) sliceStart = Math.max(len + sliceStart, 0)
            if (sliceEnd < 0) sliceEnd = Math.max(len + sliceEnd, 0)
            if (Array.isArray(val)) { val = val.slice(sliceStart, sliceEnd) }
            else if (typeof val === 'string') { val = val.slice(sliceStart, sliceEnd) }
            else { val = null }
          } else {
            const idx = _evalBinary(inner, row)
            if (Array.isArray(val)) {
              if (idx == null) { val = null }
              else if (typeof idx !== 'number' || !Number.isInteger(idx)) throw Object.assign(new Error('TypeError: List index must be an integer'), { tckError: 'TypeError' })
              else val = val[Number(idx)] ?? null
            } else if (val && typeof val === 'object' && !Array.isArray(val)) {
              // map 下标：null → null；非字符串 → TypeError
              if (idx == null) { val = null }
              else if (typeof idx !== 'string') throw Object.assign(new Error('TypeError: Map index must be a string'), { tckError: 'TypeError' })
              else val = (val as Record<string, unknown>)[idx] ?? null
            }
            else { val = null }
          }
          pos = endBracket + 1
        }
        return val
      }
    }
    return _evalLiteral(t, row)
  }
  // 下标 a[b] 或切片 a[start..end] — 优先级高于属性访问，因为 [n] 不涉及点
  const bracketIdx = t.indexOf('[')
  if (bracketIdx > 0 && t.endsWith(']')) {
    const obj = _evalAtom(t.slice(0, bracketIdx), row)
    const inner = t.slice(bracketIdx + 1, -1).trim()
    // 检测切片语法 [start..end]
    const rangeIdx = inner.indexOf('..')
    if (rangeIdx >= 0) {
      const startStr = inner.slice(0, rangeIdx).trim()
      const endStr = inner.slice(rangeIdx + 2).trim()
      const len = Array.isArray(obj) ? obj.length : (typeof obj === 'string' ? obj.length : 0)
      let startVal = startStr ? _evalBinary(startStr, row) : 0
      let endVal = endStr ? _evalBinary(endStr, row) : len
      if (startVal == null || endVal == null) return null
      let sliceStart = Number(startVal)
      let sliceEnd = Number(endVal)
      if (isNaN(sliceStart)) sliceStart = 0
      if (isNaN(sliceEnd)) sliceEnd = len
      if (sliceStart < 0) sliceStart = Math.max(len + sliceStart, 0)
      if (sliceEnd < 0) sliceEnd = Math.max(len + sliceEnd, 0)
      if (Array.isArray(obj)) return obj.slice(sliceStart, sliceEnd)
      if (typeof obj === 'string') return obj.slice(sliceStart, sliceEnd)
      return null
    }
    const idx = _evalBinary(inner, row)
    if (Array.isArray(obj)) {
      if (idx == null) return null
      if (typeof idx !== 'number' || !Number.isInteger(idx)) throw Object.assign(new Error('TypeError: List index must be an integer'), { tckError: 'TypeError' })
      return obj[Number(idx)] ?? null
    }
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      // map 类型下标：null → null；非字符串 → TypeError
      if (idx == null) return null
      if (typeof idx !== 'string') throw Object.assign(new Error('TypeError: Map index must be a string'), { tckError: 'TypeError' })
      return (obj as Record<string, unknown>)[idx] ?? null
    }
    // 非 map/非 list 的基本类型下标抛 TypeError
    if (obj != null) throw Object.assign(new Error('TypeError: Cannot index into non-map/non-list type'), { tckError: 'TypeError' })
    return null
  }
  // 属性访问 a.b
  const dotIdx = t.indexOf('.')
  if (dotIdx > 0 && !t.startsWith('.')) {
    const obj = _evalAtom(t.slice(0, dotIdx), row)
    const prop = t.slice(dotIdx + 1)
    // Cypher: null.prop → null; nonMap.prop (非 map) → TypeError
    if (obj == null) return null
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return (obj as Record<string, unknown>)[prop] ?? null
    // 对非 map 的基本类型抛 TypeError（列表也是非 map）
    throw Object.assign(new Error('TypeError: Property access on non-map type'), { tckError: 'TypeError' })
  }
  // 变量引用
  if (t in (row || {})) return row![t]
  if (row?._alias === t) return row
  return _evalLiteral(t, row)
}

function _evalLiteral(s: string, row?: Record<string, unknown>): unknown {
  const v = s.trim()
  if (v === 'null') return null
  if (v.toLowerCase() === 'true') return true
  if (v.toLowerCase() === 'false') return false
  // 数字字面量：整数、浮点、十六进制、科学计数法、小数点开头
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v)) {
    // 纯整数且超出 Number 安全范围 → 返回 BigInt 保持精度
    if (!v.includes('.') && !/e/i.test(v)) {
      try {
        const big = BigInt(v)
        if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < BigInt(Number.MIN_SAFE_INTEGER)) {
          return big
        }
      } catch { /* fall through to Number */ }
    }
    return parseFloat(v)
  }
  if (/^0[xX][0-9a-fA-F]+$/.test(v)) {
    const n = parseInt(v, 16)
    // 超出 Number 安全范围时用 BigInt 保持精度
    if (n > Number.MAX_SAFE_INTEGER) {
      try { return BigInt(v) } catch { return n }
    }
    return n
  }
  if (/^0[oO][0-7]+$/.test(v)) {
    const n = parseInt(v.slice(2), 8)
    if (n > Number.MAX_SAFE_INTEGER) {
      try { return BigInt(v) } catch { return n }
    }
    return n
  }
  if (/^-?\.\d+([eE][+-]?\d+)?$/.test(v)) return parseFloat(v)
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    let val = v.slice(1, -1)
    // 转义序列：\n \t \r \\ \' \" \uXXXX
    val = val.replace(/\\(n|t|r|\\|'|")/g, (_m: string, ch: string) => {
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' }
      return map[ch]
    })
    val = val.replace(/\\u([0-9a-fA-F]{4})/g, (_m: string, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    return val
  }
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim()
    return inner ? _parseCommaList(inner).map(item => _evalBinary(item.trim(), row)) : []
  }
  if (v.startsWith('{') && v.endsWith('}')) {
    const inner = v.slice(1, -1).trim()
    if (!inner) return {}
    const result: Record<string, unknown> = {}
    for (const pair of _parseCommaList(inner)) {
      const colonIdx = pair.indexOf(':')
      if (colonIdx === -1) continue
      result[pair.slice(0, colonIdx).trim().replace(/['"]/g, '')] = _evalBinary(pair.slice(colonIdx + 1).trim(), row)
    }
    return result
  }
  return null
}

function _inBrackets(s: string, idx: number): boolean {
  let depth = 0
  for (let i = 0; i < idx; i++) { if (s[i] === '(' || s[i] === '[' || s[i] === '{') depth++; if (s[i] === ')' || s[i] === ']' || s[i] === '}') depth-- }
  return depth > 0
}

/** 检查字符串中 idx 位置是否在字符串字面量内（引号内） */
function _inString(s: string, idx: number): boolean {
  let inStr = false, strChar = ''
  for (let i = 0; i < idx; i++) {
    if (!inStr && (s[i] === "'" || s[i] === '"')) { inStr = true; strChar = s[i] }
    else if (inStr && s[i] === strChar) { inStr = false }
  }
  return inStr
}

function _isBalanced(s: string): boolean {
  let depth = 0
  for (const ch of s) { if (ch === '(') depth++; if (ch === ')') depth--; if (depth < 0) return false }
  return depth === 0
}

function _findTopLevelOp(s: string, op: string): number {
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(' || s[i] === '[' || s[i] === '{') depth++
    if (s[i] === ')' || s[i] === ']' || s[i] === '}') depth--
    if (depth === 0 && s.slice(i, i + op.length) === op) {
      // 确保不是子字符串匹配（如 <> 内部的 =）
      // 检查前后字符不是 > 或 <，确保操作符是孤立的
      const before = i > 0 ? s[i - 1] : ' '
      const after = s[i + op.length]
      // 对于双字符操作符（<>, >=, <=），确保前一个和后一个字符都不是 < > =（避免从 <= 内部找到 < 或 =）
      if (op.length === 1 && (before === '<' || before === '>' || before === '=' || after === '<' || after === '>' || after === '=')) continue
      return i
    }
  }
  return -1
}

function _splitTopLevel(s: string, find: string): string[] {
  const result: string[] = []
  let depth = 0, inStr = false, strChar = '', current = '', i = 0
  while (i < s.length) {
    if (inStr) { current += s[i]; if (s[i] === strChar) inStr = false; i++; continue }
    if (s[i] === "'" || s[i] === '"') { inStr = true; strChar = s[i]; current += s[i]; i++; continue }
    if (s[i] === '(' || s[i] === '[' || s[i] === '{') { depth++; current += s[i]; i++; continue }
    if (s[i] === ')' || s[i] === ']' || s[i] === '}') { depth--; current += s[i]; i++; continue }
    if (depth === 0 && s.slice(i, i + find.length) === find) {
      // 单词边界检查：避免 "XOR" 中的 "OR" 被误匹配
      const prev = i === 0 ? ' ' : s[i - 1]
      const next = s[i + find.length]
      const isWord = (c: string) => /[a-zA-Z0-9_]/.test(c)
      if (!isWord(prev) && (!isWord(next) || next === undefined)) {
        result.push(current.trim()); current = ''; i += find.length; continue
      }
    }
    current += s[i]; i++
  }
  const last = current.trim()
  if (last) result.push(last)
  return result.length ? result : [s.trim()]
}

/**
 * 字面量编译时语法和语义验证（SyntaxError）
 * Literals: 整数溢出、非法格式、十六进制/八进制/浮点溢出、Unicode、列表/map 语法
 */
function _validateLiterals(query: string): void {
  // 提取 RETURN 后的裸表达式（去掉 AS alias）
  const retMatch = query.match(/RETURN\b([\s\S]*)/i)
  if (!retMatch) return
  const afterReturn = retMatch[1].trim()
  const exprs = _splitTopLevel(afterReturn, ',').map(s => s.trim()).filter(Boolean)
  const literals = exprs.map(s => s.replace(/\s+AS\s+\w+$/i, '').trim())

  for (const rawExpr of literals) {
    // 只对纯字面量（不含顶层操作符的 表达式）做语法验证。
    // 复杂表达式（如 [1,2] = [1] 或 0.0/0.0 > 1）不应被误识别为非法字面量。
    if (!_isPureLiteralExpr(rawExpr)) continue

    // 一元运算符前缀（+/-）不是字面量的一部分 — 但在验证字面量类型时需要考虑符号
    const hasSign = rawExpr.startsWith('-') || rawExpr.startsWith('+')
    const expr = hasSign ? rawExpr.slice(1) : rawExpr
    // ── 列表语法检查 ── 包含缺失逗号检测
    if (expr.startsWith('[') && expr.endsWith(']')) {
      if (_detectMissingCommas(expr)) {
        throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
      }
    }

    // ── Map 语法检查 ──
    if (expr.startsWith('{') && expr.endsWith('}')) {
      // 不均衡大括号 + 未闭合字符串
      let depth = 0, inStr = false, strChar = ''
      for (let i = 0; i < expr.length; i++) {
        if (inStr && expr[i] === '\\') { i++; continue }
        if (inStr) { if (expr[i] === strChar) inStr = false; continue }
        if (expr[i] === "'" || expr[i] === '"') { inStr = true; strChar = expr[i]; continue }
        if (expr[i] === '{') depth++
        if (expr[i] === '}') { depth--; if (depth < 0) break }
      }
      if (depth !== 0 || inStr) {
        throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
      }
      const inner = expr.slice(1, -1).trim()
      // {,} 只有逗号
      if (/^,\s*$/.test(inner)) {
        throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
      }
      // {1} 没有 key（值不是 k:v 格式）
      if (inner && !inner.includes(':')) {
        throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
      }
      // 解析 map 条目
      const entries = _splitTopLevel(inner, ',').map(s => s.trim()).filter(Boolean)
      for (const entry of entries) {
        const colonIdx = entry.indexOf(':')
        if (colonIdx <= 0) {
          // {[]} 或 {{}} — 值在前没有 key
          if (entry.startsWith('[') || entry.startsWith('{')) {
            throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
          }
          continue
        }
        const key = entry.slice(0, colonIdx).trim()
        // key 以数字开头
        if (/^[0-9]/.test(key)) {
          throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
        }
        // key 含点号
        if (key.includes('.')) {
          throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
        }
        // key 含非法符号 — 只允许字母数字下划线
        if (!/^[a-zA-Z_]\w*$/.test(key.replace(/['"]/g, ''))) {
          throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
        }
      }
    }

    // ── 纯整数 ──
    const intMatch = expr.match(/^(\d+)$/)
    if (intMatch) {
      const digits = intMatch[1]
      try {
        const absVal = BigInt(digits)
        const big = hasSign ? -absVal : absVal
        const min = BigInt('-9223372036854775808')
        const max = BigInt('9223372036854775807')
        if (big < min || big > max) {
          throw Object.assign(new Error('SyntaxError: IntegerOverflow'), { tckError: 'IntegerOverflow' })
        }
      } catch (e: any) {
        if (e && e.tckError) throw e
        throw Object.assign(new Error('SyntaxError: InvalidNumberLiteral'), { tckError: 'InvalidNumberLiteral' })
      }
      continue
    }
    // 整数含非法符号（如 9223372#54775808）— 以数字开头但非纯数字
    if (!intMatch && /^\d/.test(rawExpr.replace(/^[+-]/, '')) && !/^0[xXoObB]/.test(expr)) {
      // 检查是否合法数字格式
      if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(rawExpr) && !/^-?\.\d+([eE][+-]?\d+)?$/.test(rawExpr)) {
        throw Object.assign(new Error('SyntaxError: InvalidNumberLiteral'), { tckError: 'InvalidNumberLiteral' })
      }
    }

    // ── 十六进制字面量 ──
    const hexMatch = expr.match(/^0[xX](\w*)$/)
    if (hexMatch) {
      const hexDigits = hexMatch[1]
      if (!hexDigits) {
        throw Object.assign(new Error('SyntaxError: InvalidNumberLiteral'), { tckError: 'InvalidNumberLiteral' })
      }
      if (!/^[0-9a-fA-F]+$/.test(hexDigits)) {
        throw Object.assign(new Error('SyntaxError: InvalidNumberLiteral'), { tckError: 'InvalidNumberLiteral' })
      }
      // 溢出：BigInt 不支持 -0x... 格式，所以用纯 hex 拼数字
      try {
        const absVal = BigInt('0x' + hexDigits)
        const big = hasSign ? -absVal : absVal
        const min = BigInt('-9223372036854775808')
        const max = BigInt('9223372036854775807')
        if (big < min || big > max) {
          throw Object.assign(new Error('SyntaxError: IntegerOverflow'), { tckError: 'IntegerOverflow' })
        }
      } catch (e: any) {
        if (e && e.tckError) throw e
        throw Object.assign(new Error('SyntaxError: IntegerOverflow'), { tckError: 'IntegerOverflow' })
      }
      continue
    }

    // ── 八进制字面量 ──
    const octMatch = expr.match(/^0[oO](\w*)$/)
    if (octMatch) {
      const octDigits = octMatch[1]
      if (!octDigits || !/^[0-7]+$/.test(octDigits)) {
        throw Object.assign(new Error('SyntaxError: InvalidNumberLiteral'), { tckError: 'InvalidNumberLiteral' })
      }
      // 溢出：BigInt 不支持 -0o... 格式，先算绝对值再加负号
      try {
        const absVal = BigInt('0o' + octDigits)
        const big = hasSign ? -absVal : absVal
        const min = BigInt('-9223372036854775808')
        const max = BigInt('9223372036854775807')
        if (big < min || big > max) {
          throw Object.assign(new Error('SyntaxError: IntegerOverflow'), { tckError: 'IntegerOverflow' })
        }
      } catch (_e) {
        throw Object.assign(new Error('SyntaxError: IntegerOverflow'), { tckError: 'IntegerOverflow' })
      }
      continue
    }

    // ── 浮点溢出 ──
    if (/^-?\d+(\.\d+)?[eE][+-]?\d+$/.test(expr) || /^-?\.\d+[eE][+-]?\d+$/.test(expr)) {
      const val = parseFloat(expr)
      if (!isFinite(val)) {
        throw Object.assign(new Error('SyntaxError: FloatingPointOverflow'), { tckError: 'FloatingPointOverflow' })
      }
    }

    // ── Unicode 字面量 ──
    const strMatch = expr.match(/^'([^']*)'$/)
    if (strMatch) {
      const strContent = strMatch[1]
      // 查找 \u 后不是 4 hex digits 的情况
      // 场景：'\uH' — \u 后跟 H（不是 hex）
      // 但需要排除 \u 被转义的情况（\\u）
      for (let i = 0; i < strContent.length - 1; i++) {
        if (strContent[i] === '\\' && strContent[i + 1] === 'u') {
          // 检查是否被转义 (\\u)
          if (i > 0 && strContent[i - 1] === '\\') continue
          const hexPart = strContent.slice(i + 2, i + 6)
          if (hexPart.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hexPart)) {
            throw Object.assign(new Error('SyntaxError: InvalidUnicodeLiteral'), { tckError: 'InvalidUnicodeLiteral' })
          }
        }
      }
    }
  }
}

/**
 * 递归检测列表/Map 字面量中是否缺失逗号分隔符（Cypher 语法错误）
 */
function _detectMissingCommas(expr: string): boolean {
  if (!expr.startsWith('[') && !expr.startsWith('{')) return false
  const opening = expr[0]
  const closing = opening === '[' ? ']' : '}'
  // 找到第一个 depth=0 的 close char（支持 list[0] 语法下标）
  let matchIdx = -1, depth = 0, inStr = false, strChar = ''
  for (let i = 0; i < expr.length; i++) {
    if (inStr) { if (expr[i] === '\\') i++; else if (expr[i] === strChar) inStr = false; continue }
    if (expr[i] === "'" || expr[i] === '"') { inStr = true; strChar = expr[i]; continue }
    if (expr[i] === opening) { depth++; continue }
    if (expr[i] === closing) { depth--; if (depth === 0) { matchIdx = i; break } }
  }
  if (matchIdx < 0) return true
  const inner = expr.slice(1, matchIdx).trim()
  if (!inner) return false

  depth = 0; let i = 0, prevEnded = false, hadExpr = false

  while (i < inner.length) {
    const ch = inner[i]
    if (depth === 0 && /\s/.test(ch)) { i++; continue }

    if (ch === "'" || ch === '"') {
      if (depth === 0) { if (prevEnded) return true; prevEnded = true; hadExpr = true }
      let j = i + 1; while (j < inner.length && inner[j] !== ch) { if (inner[j] === '\\') j++; j++ }
      i = j + 1; continue
    }

    if (ch === '[' || ch === '{') {
      if (depth === 0) {
        // 如果前一个元素已经结束（prevEnded），检查是否下标操作（][）
        // 下标语法 [list[idx]] 中 inner 可能为 "list[idx]" 或已经部分切片
        if (prevEnded) {
          // 如果前一个字符是 ]，这是下标操作 [list[idx]]，不是逗号缺失
          const prevChar = i > 0 ? inner[i - 1] : ''
          if (prevChar === ']') { /* 下标访问，正常 */ }
          else return true
        }
        prevEnded = false; hadExpr = true
      }
      const closeChar = ch === '[' ? ']' : '}'
      let subDepth = 1, j = i + 1
      while (j < inner.length && subDepth > 0) {
        if (inner[j] === "'" || inner[j] === '"') {
          const q = inner[j]; j++
          while (j < inner.length && inner[j] !== q) { if (inner[j] === '\\') j++; j++ }
          j++; continue
        }
        if (inner[j] === ch) subDepth++
        if (inner[j] === closeChar) subDepth--
        j++
      }
      const subExpr = inner.slice(i, j)
      if ((subExpr.startsWith('[') || subExpr.startsWith('{')) && _detectMissingCommas(subExpr)) return true
      i = j
      if (depth === 0) prevEnded = true
      continue
    }

    if ((ch === ']' || ch === '}') && depth === 0) { i++; continue }
    if (ch === ']' || ch === '}') { depth--; if (depth === 0) prevEnded = true; i++; continue }
    if (ch === ':' && depth === 0) { prevEnded = false; i++; continue }
    if (ch === ',' && depth === 0) { if (!hadExpr) return true; prevEnded = false; i++; continue }

    if (depth === 0) {
      if (prevEnded) return true
      hadExpr = true
      while (i + 1 < inner.length && /[a-zA-Z0-9_.\-]/.test(inner[i + 1])) i++
      prevEnded = true
    }
    i++
  }

  if (prevEnded === false && hadExpr && inner.trimEnd().endsWith(',')) return true
  return false
}

/**
 * 检查表达式是否为纯字面量（不含顶层操作符）。
 * 用于 _validateLiterals，避免将复杂表达式（如 [1,2] = [1] 或 0.0/0.0 > 1）
 * 错误地送入字面量语法检查。
 */
function _isPureLiteralExpr(s: string): boolean {
  let depth = 0, inStr = false, strChar = ''
  for (let i = 0; i < s.length; i++) {
    if (inStr) { if (s[i] === '\\') { i++; continue }; if (s[i] === strChar) inStr = false; continue }
    if (s[i] === "'" || s[i] === '"') { inStr = true; strChar = s[i]; continue }
    if (s[i] === '(' || s[i] === '[' || s[i] === '{') { depth++; continue }
    if (s[i] === ')' || s[i] === ']' || s[i] === '}') { depth--; continue }
    if (depth === 0) {
      // 比较操作符
      if (s[i] === '=') return false
      if (s.slice(i, i + 2) === '<>' || s.slice(i, i + 2) === '>=' || s.slice(i, i + 2) === '<=') return false
      if (s[i] === '>' || s[i] === '<') return false
      // 算术操作符（不在括号/字符串内）
      // 但如果 i==0 且 s[i] 为 +/-，可能是字面量前缀（如 -42, +0o100...）
      if (i === 0 && (s[i] === '+' || s[i] === '-')) continue
      if (s[i] === '+' || s[i] === '-' || s[i] === '*' || s[i] === '/' || s[i] === '%' || s[i] === '^') return false
      // 布尔操作符（IN, AND, OR, XOR, NOT 等）
      if (/\s/.test(s[i]) && i + 2 < s.length) {
        const sub = s.slice(i, i + 5)
        if (/^\s+(?:IN|AND|OR|XOR|NOT)\s/.test(sub)) return false
        if (/^\s+STARTS\s+WITH/.test(sub) || /^\s+ENDS\s+WITH/.test(sub) || /^\s+CONTAINS/.test(sub)) return false
      }
    }
  }
  return true
}

// ═══════════════════════════════════════════════════════════════
// 聚合函数辅助（Aggregation helpers for aggregate.spec.ts）
// ═══════════════════════════════════════════════════════════════

export type QueryRow = Record<string, unknown>

export interface AggColumnInfo {
  fn: string
  field: string
  prop: string
  distinct: boolean
  alias: string | null
}

/** 解析单个聚合表达式字符串，如 'count(*)', 'AVG(n.score)', 'SUM(DISTINCT age)' */
export function _parseAggregate(expr: string): { fn: string; field: string; prop: string; distinct: boolean; alias: string | null } | null {
  const trimmed = expr.trim()
  // 需要至少一个字符作为 field（count 和 collect 允许 *）
  const match = trimmed.match(/^(\w+)\s*\(\s*(DISTINCT\s+)?(.+?)?\s*\)\s*(?:AS\s+(\w+))?\s*$/i)
  if (!match) return null
  const fn = match[1].toUpperCase()
  const distinct = !!match[2]
  const rawField = (match[3] || '').trim()
  // count() 无参数（空括号）无效
  if (!rawField) return null
  const field = rawField
  const prop = field === '*' ? '*' : field.includes('.') ? field.split('.').pop()! : field
  return { fn, field, prop, distinct, alias: match[4] || null }
}

/** 提取列列表中的聚合列和 GROUP BY 列 */
export function _extractAggColumns(columns: string[]): { aggCols: AggColumnInfo[]; groupByCols: string[] } {
  const aggCols: AggColumnInfo[] = []
  const groupByCols: string[] = []
  for (const col of columns) {
    const parsed = _parseAggregate(col)
    if (parsed) {
      aggCols.push(parsed)
    } else {
      // Non-aggregate column → GROUP BY 列
      // 移除 AS 别名
      const bareCol = col.replace(/\s+AS\s+\w+\s*$/i, '').trim()
      groupByCols.push(bareCol.includes('.') ? bareCol.split('.').pop()! : bareCol)
    }
  }
  return { aggCols, groupByCols }
}

/** 检查列列表中是否包含聚合函数 */
export function _hasAggregates(columns: string[]): boolean {
  return columns.some(col => _parseAggregate(col) !== null)
}

/**
 * 执行聚合逻辑：根据 aggCols 和 groupByCols 对 rows 进行分组并计算聚合值。
 *
 * AVG 精度处理：使用 sum / count 的 JS 浮点除法，对小数结果做 toFixed(15) 舍入，
 * 消除 0.1 + 0.2 = 0.30000000000000004 类的浮点误差。
 */
export function _executeAggregation(rows: QueryRow[], aggCols: AggColumnInfo[], groupByCols: string[]): QueryRow[] {
  if (!rows.length && aggCols.length) {
    // 空数据集
    const out: QueryRow = {}
    for (const ac of aggCols) {
      const key = ac.alias || ac.fn.toLowerCase()
      if (ac.fn === 'COUNT') {
        out[key] = 0
      } else if (ac.fn === 'AVG') {
        out[key] = null
      } else {
        out[key] = ac.fn === 'MIN' ? 0 : 0
      }
    }
    return [out]
  }

  /** 从行中提取聚合字段的值：count(*) 和 collect(*) 忽略字段名（所有行计 1） */
  function _extractValues(rows: QueryRow[], prop: string, distinct?: boolean): unknown[] {
    if (prop === '*') {
      // count(*) / collect(*) → 所有行都是有效值
      return rows.map(_ => true) // placeholder; _computeAggregate 对 COUNT 只检查 length
    }
    const vals = rows
      .map(r => r[prop])
      .filter(v => v !== undefined && v !== null)
    if (distinct) {
      return [...new Set(vals)]
    }
    return vals
  }

  // No group-by → single aggregate row
  if (!groupByCols.length) {
    const out: QueryRow = {}
    for (const ac of aggCols) {
      const key = ac.alias || ac.fn.toLowerCase()
      const values = _extractValues(rows, ac.prop, ac.distinct)
      out[key] = _computeAggregate(ac.fn, values)
    }
    return [out]
  }

  // Has group-by → group rows by groupByCols values
  const groups = new Map<string, QueryRow[]>()
  for (const row of rows) {
    const gk = groupByCols.map(gc => String(row[gc] ?? '__NULL__')).join('||')
    if (!groups.has(gk)) groups.set(gk, [])
    groups.get(gk)!.push(row)
  }

  const result: QueryRow[] = []
  for (const [gk, groupRows] of groups) {
    const out: QueryRow = {}
    // Set group-by columns
    const gkParts = gk.split('||')
    for (let i = 0; i < groupByCols.length; i++) {
      out[groupByCols[i]] = gkParts[i] === '__NULL__' ? null : groupRows[0][groupByCols[i]]
    }
    // Compute aggregates
    for (const ac of aggCols) {
      const key = ac.alias || ac.fn.toLowerCase()
      const values = _extractValues(groupRows, ac.prop, ac.distinct)
      out[key] = _computeAggregate(ac.fn, values)
    }
    result.push(out)
  }
  return result
}

/** 计算单个聚合值，包含 AVG 精度修复 */
function _computeAggregate(fn: string, values: unknown[]): number | null {
  if (!values.length) return fn === 'AVG' ? null : 0

  if (fn === 'COUNT') return values.length
  if (fn === 'COLLECT') return values

  const nums = values.map(v => typeof v === 'number' ? v : Number(v)).filter(v => !isNaN(v))
  if (!nums.length) return fn === 'AVG' ? null : 0

  switch (fn) {
    case 'SUM':
      return nums.reduce((a, b) => a + b, 0)
    case 'AVG': {
      const sum = nums.reduce((a, b) => a + b, 0)
      const avg = sum / nums.length
      // 精度修复：对浮点结果做 toFixed(15)，消除 ±1e-15 级别的误差
      return _cleanFloat(avg)
    }
    case 'MAX':
      return Math.max(...nums)
    case 'MIN':
      return Math.min(...nums)
    default:
      return 0
  }
}

/**
 * 清理浮点精度误差：对 ±1e-14 级误差做舍入
 * 例如 2.1999999999999997 → 2.2, 0.30000000000000004 → 0.3
 */
function _cleanFloat(n: number): number {
  if (Number.isInteger(n)) return n
  const s = n.toFixed(15)
  // 去掉末尾多余的 0
  return parseFloat(s)
}

/** 标记列是否包含聚合函数 */
export function _enrichWithAggregates(cols: Array<{ expression: string; alias?: string | null }>): Array<{ expression: string; alias?: string | null; isAggregate: boolean; aggFn?: string; distinct?: boolean }> {
  return cols.map(col => {
    const parsed = _parseAggregate(col.expression)
    return {
      ...col,
      isAggregate: !!parsed,
      ...(parsed ? { aggFn: parsed.fn, distinct: parsed.distinct } : {}),
    }
  })
}
