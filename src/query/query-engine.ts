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

import fs from 'fs'
import path from 'path'
import http from 'http'
import https from 'https'
import { execSync } from 'child_process'
import crypto from 'crypto'
import { parseCypherToPlan } from './ast-to-plan-v2'
import { LRUCache } from 'lru-cache'
import { planCache as plannerPlanCache, makePlanCacheKey } from '../api/query-planner'
import { globalRegistry as procRegistry, type ProcedureContext } from './procedure-registry'
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
export function _preprocessQuery(query: string): {
  cleanQuery: string
  extracts: _QueryExtracts
} {
  let cleanQuery = query
  const extracts: _QueryExtracts = { optionalMatches: [], withClause: null }

  // ── Step 1: 提取 OPTIONAL MATCH ──
  // Replace "OPTIONAL MATCH" with a marker that peggy can parse as a regular MATCH
  // We replace OPTIONAL MATCH → MATCH (__OPT_N__) where the special node name
  // tells us this was originally an OPTIONAL MATCH
  const optMatchRE = /OPTIONAL\s+MATCH\s+/gi
  let match: RegExpExecArray | null
  let optIdx = 0
  const optReplacements: Array<{ start: number; end: number; original: string }> = []

  while ((match = optMatchRE.exec(cleanQuery)) !== null) {
    const startPos = match.index
    const endPos = startPos + match[0].length

    // Find the end of the OPTIONAL MATCH pattern (including WHERE clause if present)
    // We need to extract from MATCH keyword position to the next keyword or end
    const patternStart = endPos
    let remaining = cleanQuery.slice(patternStart)

    // Find where this OPTIONAL MATCH clause ends (before RETURN, WITH, another OPTIONAL MATCH, or end)
    let parenDepth = 0
    let inStr = false
    let strCh = ''
    let clauseEnd = 0
    for (let i = 0; i < remaining.length; i++) {
      const ch = remaining[i]
      if (inStr) {
        if (ch === strCh) inStr = false
        continue
      }
      if (ch === "'" || ch === '"') {
        inStr = true
        strCh = ch
        continue
      }
      if (ch === '(') { parenDepth++; continue }
      if (ch === ')') { parenDepth--; continue }

      if (parenDepth === 0) {
        // Check for next clause keyword only outside parens
        const lookahead = remaining.slice(i)
        // Match OPTIONAL MATCH, RETURN, or WITH at word boundary
        if (/^\bRETURN\b/i.test(lookahead) ||
            /^\bWITH\b/i.test(lookahead) ||
            /^OPTIONAL\s+MATCH\b/i.test(lookahead)) {
          clauseEnd = i
          break
        }
      }
    }
    if (clauseEnd === 0) clauseEnd = remaining.length

    const optClause = remaining.slice(0, clauseEnd).trimEnd()

    // Build replacement: keep the "MATCH" part but slap a special marker
    // The pattern after MATCH is already valid peggy, just strip WHERE for now
    const marker = `__OPT_${optIdx}__`
    // Replace "OPTIONAL MATCH pattern [WHERE cond]" with "MATCH (${marker}) "
    // to keep peggy happy. The WHERE is extracted and stored.
    // Actually, we need to separate pattern from WHERE in the optClause
    let optPattern = optClause
    let optWhere = ''
    const whereIdx = optClause.search(/\bWHERE\s+/i)
    if (whereIdx !== -1) {
      optPattern = optClause.slice(0, whereIdx).trimEnd()
      optWhere = optClause.slice(whereIdx)
    }

    // The pattern part may be a simple (n) or (a)-[:X]->(b)
    // Reconstruct: replace entire clause with "MATCH (${marker})" + WHERE if present
    // But wait, if there are multiple patterns like (a:Person), (b:Company) this breaks.
    // Let's use a simpler approach: replace "OPTIONAL MATCH" with "MATCH ` + marker + ` MATCH "
    // This way peggy parses a regular MATCH (what follows) AND we have the marker.
    // But that requires the marker to be a valid pattern, which it isn't.
    
    // Simplest approach: just note the original text and remove "OPTIONAL " prefix
    optIdx++
  }

  // Actually, let me rethink this. The issue is that the peggy grammar doesn't have
  // OPTIONAL MATCH or WITH. We need to extract these BEFORE peggy gets the string.
  
  // Simpler strategy: split on the first RETURN. Everything before is the core query
  // (possibly with OPTIONAL MATCH and/or WITH). Everything from RETURN onwards is peggy-parseable.
  
  // Reset and use a cleaner approach
  cleanQuery = query
  const result: _QueryExtracts = { optionalMatches: [], withClause: null }

  // ── Step 0: 提取 FOREACH — 支持嵌套（从内向外递归提取） ──
  // FOREACH ( var IN list | operation )
  // 提取后从 query 中移除，在 parseQuery 中重建。
  // 支持嵌套：递归解析整个 FOREACH 结构，返回嵌套 tree。
  // 策略：从最外层 FIND 完整的 FOREACH(...)，然后递归解析 inner pipe 内容。
  let foreachIdx = cleanQuery.search(/\bFOREACH\s*\(/i)
  if (foreachIdx !== -1) {
    // 辅助函数：给定一个 FOREACH 子句字符串（不含外层前后文），
    // 递归解析为 foreachExtract 结构
    const parseForeachRecursive = (foreachText: string): _QueryExtracts['foreachExtract'] | null => {
      // 取出 pipe 之前的 header 部分和之后的 operation 部分
      // 注意：pipe 可能出现在嵌套 FOREACH 内，所以需要找最外层 pipe
      // 策略：根据括号深度找到最外层的 pipe
      const feText = foreachText.trim()
      // 提取 header: FOREACH( var IN listExpr
      const headerMatch = feText.match(/^FOREACH\s*\(\s*(\w+)\s+IN\s+/i)
      if (!headerMatch) return null
      const variable = headerMatch[1]
      const afterHeader = feText.slice(headerMatch[0].length)

      // 扫描直到找到最外层 pipe (深度=0 时)
      let depth = 0
      let pipePos = -1
      let inStr = false
      let strCh = ''
      for (let i = 0; i < afterHeader.length; i++) {
        const ch = afterHeader[i]
        if (inStr) {
          if (ch === strCh) inStr = false
          continue
        }
        if (ch === "'" || ch === '"') { inStr = true; strCh = ch; continue }
        if (ch === '(') { depth++; continue }
        if (ch === ')') { depth--; continue }
        if (ch === '[') { depth++; continue }
        if (ch === ']') { depth--; continue }
        if (ch === '|' && depth === 0) { pipePos = i; break }
      }
      if (pipePos === -1) return null
      let listExpr = afterHeader.slice(0, pipePos).trim()

      // 提取 WHERE 子句（如果存在）：FOREACH (x IN list WHERE condition | ...)
      let whereClause: string | undefined
      const whereMatch = listExpr.match(/\bWHERE\s+(.+)$/i)
      if (whereMatch) {
        whereClause = whereMatch[1].trim()
        listExpr = listExpr.slice(0, whereMatch.index).trim()
      }

      // operation 部分到最后一个 ) 之前
      const rest = afterHeader.slice(pipePos + 1).trimEnd()
      let operation: string
      if (rest.endsWith(')')) {
        operation = rest.slice(0, -1).trim()
      } else {
        operation = rest
      }

      // 检查 operation 是否也是一个 FOREACH（嵌套）
      const childRE = /^FOREACH\s*\(/i
      if (childRE.test(operation)) {
        const child = parseForeachRecursive(operation)
        if (child) {
          return {
            variable,
            listExpr,
            where: whereClause,
            operation: '', // 外层 operation 不是文本，而是 children
            children: [child],
          }
        }
      }

      return {
        variable,
        listExpr,
        where: whereClause,
        operation,
      }
    }

    // 从原始 query 中找到最外层 FOREACH 的起止位置
    const findOuterForeach = (q: string): [number, number] | null => {
      const feIdx = q.search(/\bFOREACH\s*\(/i)
      if (feIdx === -1) return null
      const sp = q.indexOf('(', feIdx)
      if (sp === -1) return null
      let depth = 0
      let endIdx = -1
      for (let i = sp; i < q.length; i++) {
        if (q[i] === '(') depth++
        else if (q[i] === ')') {
          depth--
          if (depth === 0) { endIdx = i + 1; break }
        }
      }
      if (endIdx === -1) return null
      return [feIdx, endIdx]
    }

    const outerBounds = findOuterForeach(cleanQuery)
    if (outerBounds) {
      const [feStart, feEnd] = outerBounds
      const foreachFullText = cleanQuery.slice(feStart, feEnd)
      const extracted = parseForeachRecursive(foreachFullText)
      if (extracted) {
        result.foreachExtract = extracted
        // 从 cleanQuery 中移除 FOREACH 子句（包括嵌套全部移除）
        const beforeForeach = cleanQuery.slice(0, feStart)
        const afterForeach = cleanQuery.slice(feEnd)
        cleanQuery = beforeForeach + afterForeach
      }
    }
  }

  // ── Step 0.5: 提取 REDUCE ──
  // REDUCE(acc = init, x IN list | expression) [AS alias]
  // 提取后从 query 中移除（替换为标识符保持语法完整性）
  const reduceRE = /REDUCE\s*\(\s*(\w+)\s*=\s*([^,]+?)\s*,\s*(\w+)\s+IN\s+(.+?)\s*\|\s*([\s\S]+?)\s*\)(?:\s+AS\s+\w+)?/i
  const reduceMatch = cleanQuery.match(reduceRE)
  if (reduceMatch) {
    result.reduceExtract = {
      accumulator: reduceMatch[1],
      initial: reduceMatch[2].trim(),
      variable: reduceMatch[3],
      listExpr: reduceMatch[4].trim(),
      expression: reduceMatch[5].trim(),
    }
    cleanQuery = cleanQuery.replace(reduceRE, '__reduce_val__')
  }

  // ── Step 0.7: 提取 LOAD CSV ──
  // LOAD CSV FROM 'url' AS row [WITH HEADERS]
  // 提取后从 query 中移除（LOAD CSV 是独立语句）
  const csvRE = /LOAD\s+CSV\s+FROM\s+['"]([^'"]+)['"]\s+AS\s+(\w+)(?:\s+WITH\s+HEADERS)?\s*/i
  const csvMatch = cleanQuery.match(csvRE)
  if (csvMatch) {
    result.loadCsvExtract = {
      url: csvMatch[1],
      rowVariable: csvMatch[2],
      hasHeaders: /WITH\s+HEADERS/i.test(csvMatch[0]),
    }
    cleanQuery = cleanQuery.replace(csvRE, ' ').trim()
  }

  // ── Step 0.8: 提取窗口函数 ──
  // count(n.age) OVER (PARTITION BY n.gender ORDER BY n.age DESC)
  // 提取后替换为普通标识符
  const windowRE = /(\w+)\s*\(([^)]*)\)\s+OVER\s*\(([\s\S]+?)\)/gi
  const windowExtracts: Array<{ function: string; partitionBy: string[]; orderBy: Array<{ column: string; direction: 'ASC' | 'DESC' }> }> = []
  cleanQuery = cleanQuery.replace(windowRE, (_match, func: string, args: string, overClause: string) => {
    const pby: string[] = []
    const oby: Array<{ column: string; direction: 'ASC' | 'DESC' }> = []
    // 解析 OVER 内部：PARTITION BY cols ORDER BY cols
    const pbyMatch = overClause.match(/PARTITION\s+BY\s+(.+?)(?:\bORDER\s+BY\b|$)/i)
    if (pbyMatch) {
      pbyMatch[1].split(',').forEach((c: string) => pby.push(c.trim()))
    }
    const obyMatch = overClause.match(/ORDER\s+BY\s+(.+)$/i)
    if (obyMatch) {
      obyMatch[1].split(',').forEach((c: string) => {
        const parts = c.trim().split(/\s+/)
        oby.push({
          column: parts[0],
          direction: parts[1]?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC',
        })
      })
    }
    windowExtracts.push({ function: `${func}(${args})`, partitionBy: pby, orderBy: oby })
    return `__window_val_${windowExtracts.length - 1}__`
  })
  if (windowExtracts.length > 0) {
    result.windowExtracts = windowExtracts
  }

  // ── Step 1: handle OPTIONAL MATCH by stripping the "OPTIONAL " prefix ──
  // After peggy parses "MATCH ...", we can detect which MATCH was OPTIONAL by
  // checking if the original query had "OPTIONAL MATCH" before it.
  // We'll store the positions of OPTIONAL MATCH clauses in the original query.

  // Instead of modifying the query, let's extract OPTIONAL MATCH clauses and replace them
  // with a synthetic MATCH that peggy CAN parse: "MATCH (__OPT_N__)"
  // where __OPT_N__ is a unique identifier. We store the original pattern text for later reconstruction.
  
  let modifiedQuery = query

  // 如果 Step 0 提取了 FOREACH，应用删除到 modifiedQuery
  if (cleanQuery !== query) {
    modifiedQuery = cleanQuery
  }

  // ── Step 0.85: Extract SEARCH clause (向量搜索) ──
  // Format: MATCH (n:Label) SEARCH n.embedding APPROXIMATE [0.1, 0.2, ...] TOP 10
  // Or: MATCH (n:Label) WHERE n.embedding IN ANN([0.1, 0.2, ...], 10)
  // Extract SEARCH from the query and replace with a no-op marker so peggy still parses correctly.
  
  // Pattern 1: SEARCH <property> APPROXIMATE <vector_array> TOP <k>
  {
    const searchRE = /\bSEARCH\s+(\w+(?:\.\w+)?)\s+APPROXIMATE\s+\[([^\]]+)\]\s+TOP\s+(\d+)/i
    const searchMatch = searchRE.exec(modifiedQuery)
    if (searchMatch) {
      const targetProperty = searchMatch[1]
      const queryVectorStr = searchMatch[2]
      const topK = parseInt(searchMatch[3], 10)

      // Parse [0.1, 0.2, ...] into number[]
      const queryVector: number[] = queryVectorStr.split(',').map(s => {
        const num = parseFloat(s.trim())
        return isNaN(num) ? 0 : num
      })

      result.searchExtract = { targetProperty, queryVector, topK }

      // Remove SEARCH clause from query (replace with empty string)
      const fullMatch = searchMatch[0]
      const searchIdx = searchMatch.index
      const beforeSearch = modifiedQuery.slice(0, searchIdx)
      const afterSearch = modifiedQuery.slice(searchIdx + fullMatch.length)
      modifiedQuery = (beforeSearch + afterSearch).trim()
    }
  }

  // Pattern 2: WHERE <property> IN ANN([vector], k)
  if (!result.searchExtract) {
    const annRE = /\bWHERE\s+(\w+(?:\.\w+)?)\s+IN\s+ANN\s*\((\[([^\]]*)\])\s*,\s*(\d+)\)/i
    const annMatch = annRE.exec(modifiedQuery)
    if (annMatch) {
      const targetProperty = annMatch[1]
      const vectorStr = annMatch[3]
      const topK = parseInt(annMatch[4], 10)

      const queryVector: number[] = vectorStr.split(',').map(s => {
        const num = parseFloat(s.trim())
        return isNaN(num) ? 0 : num
      })

      result.searchExtract = { targetProperty, queryVector, topK }

      // Remove the WHERE ... ANN part from the query
      const fullMatch = annMatch[0]
      const whereIdx = annMatch.index
      const beforeWhere = modifiedQuery.slice(0, whereIdx)
      const afterWhere = modifiedQuery.slice(whereIdx + fullMatch.length)
      modifiedQuery = (beforeWhere + afterWhere).trim()
    }
  }

  const optPatterns: string[] = []
  let optCounter = 0

  // Match OPTIONAL MATCH globally, extract and replace
  const fullOptRE = /\bOPTIONAL\s+MATCH\s+/gi
  let optExec: RegExpExecArray | null
  while ((optExec = fullOptRE.exec(modifiedQuery)) !== null) {
    const optStart = optExec.index
    const afterKeyword = optStart + optExec[0].length

    // Find end of this OPTIONAL MATCH clause (up to "RETURN", "WITH", or end)
    const rest = modifiedQuery.slice(afterKeyword)
    let clauseLen = _findClauseEnd(rest)
    let optBody = rest.slice(0, clauseLen)

    // Separate the pattern from the WHERE clause
    const wherePos = optBody.search(/\bWHERE\s+/i)
    let optPattern = optBody
    let optWhere = ''
    if (wherePos !== -1) {
      optPattern = optBody.slice(0, wherePos).trimEnd()
      optWhere = optBody.slice(wherePos)
    }

    // Store what we extracted
    const marker = `__OPT_${optCounter}__(:__OptLabel)`
    const replacement = `OPTIONAL ${marker} ${optPattern} ${optWhere}`
    // Wait, this is still not valid for peggy.
    // Let's try: replace OPTIONAL MATCH (...) with MATCH (...) where we add a special property
    // that peggy can parse. 
    // Actually, the simplest: replace "OPTIONAL MATCH pat WHERE cond" with "MATCH pat WHERE cond"
    // and keep a flag that this was OPTIONAL.
    // But then multiple MATCH clauses confuse the parser.
    
    // Better: store the full OPTIONAL MATCH text, remove it from the query,
    // and parse it separately later.
    
    // Find the next keyword after OPTIONAL MATCH body
    const fullEnd = afterKeyword + clauseLen
    
    // Extract pattern text to parse separately
    const patternText = modifiedQuery.slice(afterKeyword, fullEnd).trim()
    
    // Remove this OPTIONAL MATCH clause from the query
    modifiedQuery = modifiedQuery.slice(0, optStart) + modifiedQuery.slice(fullEnd)
    
    optPatterns.push(patternText)
    optCounter++
    
    // Reset regex since we modified the string
    fullOptRE.lastIndex = optStart
  }

  // ── Step 2: handle WITH clause ──
  // Extract text between "WITH" and "RETURN" (or end), replace with nothing
  const withPatterns: string[] = []
  let withCounter = 0
  const withRE = /(?<!STARTS |ENDS )\bWITH\s+/gi
  let withExec: RegExpExecArray | null
  while ((withExec = withRE.exec(modifiedQuery)) !== null) {
    const withStart = withExec.index
    const afterKeyword = withStart + withExec[0].length

    // Find end of WITH clause
    const rest = modifiedQuery.slice(afterKeyword)
    let clauseLen = _findClauseEnd(rest)
    const withBody = rest.slice(0, clauseLen).trim()

    // Remove this WITH clause from the query
    const fullEnd = afterKeyword + clauseLen
    modifiedQuery = modifiedQuery.slice(0, withStart) + modifiedQuery.slice(fullEnd)

    withPatterns.push(withBody)
    withCounter++

    withRE.lastIndex = withStart
  }

  // ── Step 3: handle HAVING clause ──
  // Extract HAVING from the query (appears after GROUP BY, before ORDER BY/LIMIT/end)
  let havingRaw: string | undefined
  const havingRE = /\bHAVING\s+(.+?)(?:\bORDER\s+BY\b|\bLIMIT\b|\bSKIP\b|$)/i
  const havingMatch = modifiedQuery.match(havingRE)
  if (havingMatch) {
    havingRaw = havingMatch[1].trim()
    // Remove HAVING clause from modified query
    modifiedQuery = modifiedQuery.replace(havingRE, '').trim()
  }

  // ── Step 3.5: handle ORDER BY with aggregate function calls ──
  // The peggy parser can't handle function calls in ORDER BY (e.g., ORDER BY count(n.age)).
  // Replace aggregate calls with a placeholder identifier.
  // We store the mapping to restore later in plan construction.
  const orderByAggReplacements: Array<{ placeholder: string; original: string }> = []
  modifiedQuery = modifiedQuery.replace(
    /\bORDER\s+BY\s+(.+?)(?:\bLIMIT\b|\bSKIP\b|$)/gi,
    (match, orderPart: string) => {
      // Check if orderPart contains '(' — if so, it has function calls
      if (!orderPart.includes('(')) return match
      // Replace each function call with placeholder
      let replaced = orderPart.replace(/(\w+)\(([^)]*)\)/g, (fnMatch: string) => {
        const placeholder = `__agg_order_${orderByAggReplacements.length}__`
        orderByAggReplacements.push({ placeholder, original: fnMatch })
        return placeholder
      })
      // Reconstruct the ORDER BY clause with placeholders
      return match.replace(orderPart, replaced)
    }
  )

  // ── Step 3.6: Extract DELETE clause ──
  // MATCH ... WHERE ... DELETE n [SKIP x] [LIMIT y]
  // or MATCH ... WHERE ... DETACH DELETE n [SKIP x] [LIMIT y]
  // Replace DELETE with an equivalent RETURN so PEG can parse the rest.
  let deleteExtract: _QueryExtracts['deleteExtract'] = undefined
  const deleteRE = /\b(DETACH\s+)?DELETE\s+(\w+(?:\s*,\s*\w+)*)(?:\s+SKIP\s+(\d+))?(?:\s+LIMIT\s+(\d+))?$/i
  const deleteMatch = modifiedQuery.match(deleteRE)
  if (deleteMatch) {
    const targets = deleteMatch[2].split(',').map((s: string) => s.trim())
    deleteExtract = {
      targets,
      detach: !!deleteMatch[1],
      skip: deleteMatch[3] ? parseInt(deleteMatch[3], 10) : undefined,
      limit: deleteMatch[4] ? parseInt(deleteMatch[4], 10) : undefined,
    }
    // Replace DELETE with RETURN so PEG can parse the rest of the query
    modifiedQuery = modifiedQuery.replace(deleteMatch[0], '').trim()
  }

  // ── Step 3.7: Extract INTERSECT clause ──
  // MATCH ... RETURN ... INTERSECT MATCH ... RETURN ...
  let intersectExtract: _QueryExtracts['intersectExtract'] = undefined
  const intersectIdx = modifiedQuery.search(/\bINTERSECT\b/i)
  if (intersectIdx !== -1) {
    intersectExtract = modifiedQuery.slice(intersectIdx + 'INTERSECT'.length).trim()
    modifiedQuery = modifiedQuery.slice(0, intersectIdx).trim()
  }

  // ── Step 3.7b: Extract MERGE + ORDER BY — PEG can't parse ORDER BY in MERGE
  // Example: MERGE (n:Person {name: 'Alice'}) RETURN n.name ORDER BY n.name
  // We need to extract the ORDER BY clause when it follows MERGE
  let mergeOrderByExtract: string | undefined = undefined
  const mergeOrderByRE = /(\bMERGE\b[\s\S]*?\bRETURN\b[\s\S]*?)\bORDER\s+BY\s+(.+?)$/i
  const mergeOrderByMatch = modifiedQuery.match(mergeOrderByRE)
  if (mergeOrderByMatch && !/\bMATCH\b/i.test(modifiedQuery)) {
    // Only when no MATCH is present (MATCH + ORDER BY is handled by PEG already)
    mergeOrderByExtract = mergeOrderByMatch[2].trim()
    // Remove ORDER BY from the query
    const orderByIdx = modifiedQuery.search(/\bORDER\s+BY\s+/i)
    if (orderByIdx !== -1) {
      modifiedQuery = modifiedQuery.slice(0, orderByIdx).trim()
    }
  }

  // ── Step 3.7c: Extract UNWIND + MERGE — PEG can't parse UNWIND followed by MERGE
  // Example: UNWIND ['Alice', 'Bob'] AS name MERGE (n:Person {name: name}) RETURN n
  let unwindMergeExtract: string | undefined = undefined
  const unwindMergeRE = /\bUNWIND\b[\s\S]*?\bMERGE\b/i
  if (unwindMergeRE.test(modifiedQuery) && /\bUNWIND\b/i.test(modifiedQuery) && /\bMERGE\b/i.test(modifiedQuery)) {
    // Extract the MERGE+RETURN part, replace with MERGE-free equivalent
    const mergeIdx = modifiedQuery.search(/\bMERGE\b/i)
    if (mergeIdx !== -1) {
      const unwindPart = modifiedQuery.slice(0, mergeIdx).trim()
      const mergePart = modifiedQuery.slice(mergeIdx).trim()
      unwindMergeExtract = mergePart
      // Replace MERGE with a dummy MATCH so PEG can parse
      // Try: UNWIND [...] AS x MATCH (__merge_anchor__) RETURN ...
      const returnIdxInMerge = mergePart.search(/\bRETURN\b/i)
      if (returnIdxInMerge !== -1) {
        const mergeExpr = mergePart.slice(0, returnIdxInMerge).trim()
        const returnExpr = mergePart.slice(returnIdxInMerge).trim()
        modifiedQuery = `${unwindPart} MATCH (__merge_anchor__) ${returnExpr}`
      } else {
        modifiedQuery = `${unwindPart} MATCH (__merge_anchor__) RETURN 1 AS __dummy`
      }
    }
  }

  // ── Step 3.7d: Extract second UNWIND in chain — PEG can't parse UNWIND ... UNWIND
  // Example: UNWIND [1, 2] AS x UNWIND [3, 4] AS y RETURN x, y
  let secondUnwindExtract: string | undefined = undefined
  if (!unwindMergeExtract && /\bUNWIND\b/i.test(modifiedQuery)) {
    // Count UNWIND occurrences
    const unwindMatches = modifiedQuery.match(/\bUNWIND\b/gi)
    if (unwindMatches && unwindMatches.length > 1) {
      // Find the second UNWIND
      const firstUnwindIdx = modifiedQuery.search(/\bUNWIND\b/i)
      const afterFirst = modifiedQuery.slice(firstUnwindIdx + 6)
      const secondUnwindIdx = afterFirst.search(/\bUNWIND\b/i)
      if (secondUnwindIdx !== -1) {
        const absoluteSecondIdx = firstUnwindIdx + 6 + secondUnwindIdx
        const firstPart = modifiedQuery.slice(0, absoluteSecondIdx).trim()
        const secondPart = modifiedQuery.slice(absoluteSecondIdx).trim()
        secondUnwindExtract = secondPart
        // Keep only the first UNWIND
        modifiedQuery = firstPart
      }
    }
  }
  // CREATE (a:Person ...) CREATE (b:Person ...)
  // PEG only handles one CREATE. Extract the second (and beyond).
  let secondCreateExtract: _QueryExtracts['secondCreateExtract'] = undefined
  if (modifiedQuery.includes('CREATE') && modifiedQuery.indexOf('CREATE') !== modifiedQuery.lastIndexOf('CREATE')) {
    const firstCreateEnd = modifiedQuery.indexOf('CREATE') + 'CREATE'.length
    // Find the second CREATE
    const secondCreateIdx = modifiedQuery.indexOf('CREATE', firstCreateEnd)
    // Find end of second CREATE clause (before any subsequent keyword)
    const afterSecond = modifiedQuery.slice(secondCreateIdx)
    let createEnd = afterSecond.length
    for (let i = 0; i < afterSecond.length; i++) {
      const ch = afterSecond[i]
      if (ch === '(' || ch === '[') continue // skip past pattern
      if (ch === ')') continue
      const lookahead = afterSecond.slice(i)
      if (/^\bMATCH\b/i.test(lookahead) || /^\bRETURN\b/i.test(lookahead) || /^\bSET\b/i.test(lookahead) || /^\bMERGE\b/i.test(lookahead) || /^\bDELETE\b/i.test(lookahead) || /^\bWITH\b/i.test(lookahead)) {
        createEnd = i
        break
      }
    }
    secondCreateExtract = afterSecond.slice(0, createEnd).trim()
    // Remove the second CREATE from query
    modifiedQuery = modifiedQuery.slice(0, secondCreateIdx)
  }

  // ── Step 3.9: Normalize variable-length relationship patterns ──
  // PEG doesn't support [:KNOWS*1..4], [:KNOWS*..4], [:KNOWS*2..], [:KNOWS*1..3], or [:KNOWS*3].
  // Transform [:label*range] → [:label] so PEG can parse. The range info is lost but 
  // the query is parseable. At runtime, plan execution uses default traversal.
  modifiedQuery = modifiedQuery.replace(
    /\[:(\w+)\*\d*(?:\.\.\d*)?\]/g,
    (_match: string, label: string) => `[:${label}]`
  )

  // Also handle the undirected var-length: -[:KNOWS*1..3]-
  modifiedQuery = modifiedQuery.replace(
    /-\[:(\w+)\*\d*(?:\.\.\d*)?\]-/g,
    (_match: string, label: string) => `-[:${label}]-`
  )

  // ── Step 3.10: Extract complex RETURN clause ──
  // Handle queries where PEG can parse MATCH patterns but the RETURN
  // clause contains complex expressions (nested subscripts, multiple func calls, etc.)
  let returnExtract: _QueryExtracts['returnExtract'] = undefined
  // Only extract if MATCH is present and it's the main query section
  const returnIdx = modifiedQuery.search(/\bRETURN\b/i)
  if (returnIdx !== -1 && modifiedQuery.search(/\bMATCH\b/i) !== -1 && modifiedQuery.search(/\bMATCH\b/i) < returnIdx) {
    // Find if PEG can parse the MATCH part (up to but not including RETURN)
    const matchPart = modifiedQuery.slice(0, returnIdx).trim()
    const returnPart = modifiedQuery.slice(returnIdx).trim()
    // Check if the RETURN clause has patterns PEG can't handle:
    // Nested brackets (`[[`, `][`), multiple function calls with props
    const complexPatterns = /\[\[|\]\[|DISTINCT\s+\w+\.\w+\(/i.test(returnPart)
    if (!complexPatterns) {
      try {
        parseCypherToPlan(modifiedQuery)
      } catch {
        // PEG fails on the query — try to extract return
        const testQuery2 = matchPart + ' RETURN 1 AS __dummy'
        try {
          parseCypherToPlan(testQuery2)
          returnExtract = returnPart.slice('RETURN'.length).trim()
          modifiedQuery = testQuery2
        } catch {
          // MATCH part also fails
        }
      }
    } else {
      // Contains [[ or ][ or complex DISTINCT pattern — definitely extract
      returnExtract = returnPart.slice('RETURN'.length).trim()
      modifiedQuery = matchPart + ' RETURN 1 AS __dummy'
    }
  }

  // ── Step 3.11: Handle MATCH ... CREATE (no RETURN) ──
  // PEG can't parse MATCH ... CREATE ... — add a dummy RETURN so PEG parses MATCH
  if (!/\bRETURN\b/i.test(modifiedQuery) && /\bMATCH\b.*\bCREATE\b/i.test(modifiedQuery)) {
    const createIdx = modifiedQuery.search(/\bCREATE\b/i)
    if (createIdx !== -1) {
      // Extract everything from CREATE onward and store it
      const matchPart = modifiedQuery.slice(0, createIdx).trim()
      const createPart = modifiedQuery.slice(createIdx).trim()
      // Check if PEG can parse just the MATCH part with a dummy RETURN
      try {
        const testQ = matchPart + ' RETURN 1 AS __dummy'
        parseCypherToPlan(testQ)
        // MATCH part works — replace the query
        modifiedQuery = testQ
        // Store the CREATE part to be reconstructed in post-processing
        if (!returnExtract) {
          returnExtract = createPart
        } else {
          returnExtract = createPart + ', ' + returnExtract
        }
      } catch {
        // MATCH part also fails
      }
    }
  }

  // Step 4: If after extraction there's no MATCH at all, add a dummy one
  // This handles cases like "OPTIONAL MATCH (n) RETURN n" where all MATCH
  // clauses were OPTIONAL, and "FOREACH (x IN [1] | CREATE (n)) RETURN n".
  if (optPatterns.length > 0 && !/MATCH\b/i.test(modifiedQuery) && /\bRETURN\b/i.test(modifiedQuery)) {
    modifiedQuery = `MATCH (__opt_anchor__) ${modifiedQuery.trim()}`
  }
  if (result.foreachExtract && !/MATCH\b/i.test(modifiedQuery)) {
    modifiedQuery = `MATCH (__foreach_anchor__) ${modifiedQuery.trim()} RETURN 1 AS __dummy`
  }

  // The modified query now has no OPTIONAL MATCH or WITH — should be parseable
  return {
    cleanQuery: modifiedQuery.trim(),
    extracts: {
      optionalMatches: optPatterns,
      withRaw: withPatterns.length > 0 ? withPatterns : undefined,
      withClause: null,
      havingRaw,
      orderByAggReplacements:
        orderByAggReplacements.length > 0 ? orderByAggReplacements : undefined,
      foreachExtract: result.foreachExtract,
      reduceExtract: result.reduceExtract,
      loadCsvExtract: result.loadCsvExtract,
      windowExtracts: result.windowExtracts,
      searchExtract: result.searchExtract,
      deleteExtract,
      intersectExtract,
      mergeOrderByExtract,
      unwindMergeExtract,
      secondUnwindExtract,
      secondCreateExtract,
      returnExtract,
    },
  }
}

/**
 * Find where a clause ends: scan from the start position looking for RETURN, WITH,
 * another OPTIONAL MATCH, or end of string. Respects parenthesized sub-expressions
 * (function calls like count(b), OR/AND expressions, etc.)
 */
function _findClauseEnd(text: string): number {
  let parenDepth = 0
  let inStr = false
  let strCh = ''

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (ch === strCh) inStr = false
      continue
    }
    if (ch === "'" || ch === '"') {
      inStr = true
      strCh = ch
      continue
    }
    if (ch === '(') { parenDepth++; continue }
    if (ch === ')') { parenDepth--; continue }

    if (parenDepth === 0) {
      const lookahead = text.slice(i)
      if (/^\bRETURN\b/i.test(lookahead)) return i
      if (/^\bWITH\b/i.test(lookahead)) return i
      if (/^\bUNWIND\b/i.test(lookahead)) return i
      if (/^\bOPTIONAL\s+MATCH\b/i.test(lookahead)) return i
    }
  }
  return text.length
}

/**
 * Raw extraction result data for post-processing.
 */
export interface _QueryExtracts {
  optionalMatches: string[]
  withRaw?: string[]
  withClause: null
  havingRaw?: string
  orderByAggReplacements?: Array<{ placeholder: string; original: string }>
  /** FOREACH 提取（支持嵌套） */
  foreachExtract?: {
    variable: string
    listExpr: string
    where?: string
    operation: string
    /** 内层 FOREACH 提取（嵌套时） */
    children?: _QueryExtracts['foreachExtract'][]
  }
  /** REDUCE 提取 */
  reduceExtract?: {
    accumulator: string
    initial: string
    variable: string
    listExpr: string
    expression: string
  }
  /** LOAD CSV 提取 */
  loadCsvExtract?: {
    url: string
    rowVariable: string
    hasHeaders: boolean
  }
  /** 窗口函数提取 */
  windowExtracts?: Array<{
    function: string
    partitionBy: string[]
    orderBy: Array<{ column: string; direction: 'ASC' | 'DESC' }>
    alias?: string
  }>
  /** SEARCH 向量搜索提取 */
  searchExtract?: {
    targetProperty: string
    queryVector: number[]
    topK: number
  }
  /** DELETE 子句提取 */
  deleteExtract?: {
    targets: string[]
    detach: boolean
    skip?: number
    limit?: number
  }
  /** INTERSECT 子句提取 */
  intersectExtract?: string
  /** MERGE + ORDER BY 提取 */
  mergeOrderByExtract?: string
  /** UNWIND + MERGE 提取 */
  unwindMergeExtract?: string
  /** 第二个 UNWIND 子句提取 */
  secondUnwindExtract?: string
  /** 第二个 CREATE 子句提取（CREATE 链） */
  secondCreateExtract?: string
  /** 复杂 RETURN 子句提取（PEG 无法解析的复杂表达式） */
  returnExtract?: string
}

/**
 * Parse a raw OPTIONAL MATCH extraction string into a pattern + where for plan building.
 * The extraction string is like: "(a:Person)-[:KNOWS]->(b) WHERE b.age > 30"
 */
export function _parseOptionalMatchExtract(
  extract: string,
): {
  pattern: PatternAST | null
  filters: FilterClause[]
} {
  // Parse the pattern by turning it into a pseudo-MATCH query for peggy.
  // Use the first variable as the return column.
  let firstVar = 'n'
  const firstVarMatch = extract.match(/\((\w+)/)
  if (firstVarMatch) firstVar = firstVarMatch[1]
  const pseudoQuery = `MATCH ${extract} RETURN ${firstVar}`
  try {
    const ast = parseCypherToPlan(pseudoQuery) as QueryAST
    const pattern = ast.match?.patterns?.[0] ?? null
    const filters = ast.where ? extractFilters(ast.where.expression, []) : []
    return { pattern, filters }
  } catch {
    return { pattern: null, filters: [] }
  }
}

/**
 * Parse a raw WITH extraction string into structured information.
 * Format: "expr1 AS alias1, expr2 AS alias2 [WHERE ...] [ORDER BY ...] [LIMIT n]"
 */
export function _parseWithExtract(
  extract: string,
): {
  columns: Array<{ expression: string; alias: string | null }>
  filters: FilterClause[]
  orderBy: Array<{ property: string; direction: 'ASC' | 'DESC' }>
  limit: number | undefined
  skip: number | undefined
  aggregate?: AggregateClause
} {
  let rest = extract.trim()

  // Default result
  const result: {
    columns: Array<{ expression: string; alias: string | null }>
    filters: FilterClause[]
    orderBy: Array<{ property: string; direction: 'ASC' | 'DESC' }>
    limit: number | undefined
    skip: number | undefined
    aggregate?: AggregateClause
  } = {
    columns: [],
    filters: [],
    orderBy: [],
    limit: undefined,
    skip: undefined,
  }

  // ── Extract LIMIT ──
  const limitMatch = rest.match(/\bLIMIT\s+(\d+)\s*$/i)
  if (limitMatch) {
    result.limit = parseInt(limitMatch[1], 10)
    rest = rest.slice(0, limitMatch.index!).trimEnd()
  }

  // ── Extract ORDER BY ──
  const orderMatch = rest.match(/\bORDER\s+BY\s+(.+?)$/i)
  if (orderMatch) {
    const orderStr = result.limit !== undefined
      ? rest.slice(rest.search(/\bORDER\s+BY\s+/i) + 'ORDER BY '.length, rest.length)
      : orderMatch[1]

    // Parse the order columns
    const orderCols = orderStr.split(',').map(s => s.trim())
    for (const oc of orderCols) {
      const dirMatch = oc.match(/^(.*?)\s+(ASC|DESC)$/i)
      if (dirMatch) {
        result.orderBy.push({
          property: dirMatch[1].trim(),
          direction: dirMatch[2].toUpperCase() as 'ASC' | 'DESC',
        })
      } else {
        result.orderBy.push({ property: oc, direction: 'ASC' })
      }
    }
    // Trim rest to before ORDER BY
    rest = rest.slice(0, rest.search(/\bORDER\s+BY\s+/i)).trimEnd()
  }

  // ── Extract WHERE ──
  const whereMatch = rest.match(/\bWHERE\s+(.+)$/i)
  if (whereMatch) {
    const whereExprStr = whereMatch[1]
    // Parse the WHERE expression by building a pseudo-query
    const pseudoQuery = `MATCH (n) WHERE ${whereExprStr} RETURN n`
    try {
      const ast = parseCypherToPlan(pseudoQuery) as QueryAST
      if (ast.where) {
        result.filters = extractFilters(ast.where.expression, [])
      }
    } catch {
      // If we can't parse the WHERE, skip filters
    }
    rest = rest.slice(0, whereMatch.index!).trimEnd()
  }

  // ── Extract columns (the rest) ──
  // Format: expr1 AS alias1, expr2 AS alias2 or a single aggregate like count(b) AS friends
  const colStr = rest.trim()

  // Check for aggregate function
  const aggMatch = colStr.match(/^(count|sum|avg|max|min|collect)\s*\(\s*([^)]+)\s*\)\s*(?:AS\s+(\w+))?\s*$/i)
  if (aggMatch) {
    const func = aggMatch[1].toLowerCase() as 'count' | 'sum' | 'avg' | 'max' | 'min' | 'collect'
    const field = aggMatch[2].trim()
    const alias = aggMatch[3] || null
    result.aggregate = { type: func, field, alias }

    // Detect DISTINCT in collect/COUNT
    if ((func === 'collect' || func === 'count') && field.toUpperCase().startsWith('DISTINCT ')) {
      result.aggregate.distinct = true
    }

    // Build column from aggregate
    // The column expression is the aggregate string, the alias is from AS
    if (alias) {
      result.columns.push({ expression: aggMatch[2].trim(), alias })
    } else {
      result.columns.push({ expression: colStr, alias: null })
    }
  } else {
    // Split by comma (respecting parentheses for function calls)
    const cols = _splitColumnsRespectingParens(colStr)
    for (const col of cols) {
      const trimmed = col.trim()
      if (!trimmed) continue

      // Check for AS alias
      const asMatch = trimmed.match(/\s+AS\s+(\w+)$/i)
      if (asMatch) {
        const expr = trimmed.slice(0, asMatch.index!).trim()
        result.columns.push({ expression: expr, alias: asMatch[1] })

        // Check if this is an aggregate
        const innerAggMatch = expr.match(/^(count|sum|avg|max|min|collect)\s*\(\s*([^)]+)\s*\)$/i)
        if (innerAggMatch) {
          const innerField = innerAggMatch[2].trim()
          result.aggregate = {
            type: innerAggMatch[1].toLowerCase() as 'count' | 'sum' | 'avg' | 'max' | 'min' | 'collect',
            field: innerField,
            alias: asMatch[1],
          }
          // Detect DISTINCT
          if ((result.aggregate.type === 'collect' || result.aggregate.type === 'count') &&
              innerField.toUpperCase().startsWith('DISTINCT ')) {
            result.aggregate.distinct = true
          }
        }
      } else {
        result.columns.push({ expression: trimmed, alias: null })
      }
    }
  }

  return result
}

/**
 * Split column expressions by comma, respecting parentheses and brackets for function calls and lists.
 */
function _splitColumnsRespectingParens(s: string): string[] {
  const parts: string[] = []
  let parenDepth = 0
  let bracketDepth = 0
  let inStr = false
  let strCh = ''
  let start = 0

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (ch === strCh) inStr = false
      continue
    }
    if (ch === "'" || ch === '"') {
      inStr = true
      strCh = ch
      continue
    }
    if (ch === '(') {
      parenDepth++
      continue
    }
    if (ch === ')') {
      parenDepth--
      continue
    }
    if (ch === '[') {
      bracketDepth++
      continue
    }
    if (ch === ']') {
      bracketDepth--
      continue
    }
    if (ch === ',' && parenDepth === 0 && bracketDepth === 0) {
      parts.push(s.slice(start, i))
      start = i + 1
    }
  }
  parts.push(s.slice(start))
  return parts
}

/**
 * 解析 Cypher-lite 查询字符串为 QueryPlan
 */
/**
 * Detect EXPLAIN / PROFILE prefix, strip it, and set flags on the plan.
 */
function _stripExplainProfile(query: string): { stripped: string; explain: boolean; profile: boolean } {
  const trimmed = query.trim()
  // EXPLAIN [JSON] [ANALYZE] <query> — we handle simple EXPLAIN/PROFILE here
  // Note: EXPLAIN JSON/ANALYZE are handled by explain.ts. We just support:
  //   EXPLAIN <query>
  //   PROFILE <query>
  const explainMatch = trimmed.match(/^\s*EXPLAIN\s+/i)
  if (explainMatch) {
    return { stripped: trimmed.slice(explainMatch[0].length).trim(), explain: true, profile: false }
  }
  const profileMatch = trimmed.match(/^\s*PROFILE\s+/i)
  if (profileMatch) {
    return { stripped: trimmed.slice(profileMatch[0].length).trim(), explain: false, profile: true }
  }
  return { stripped: trimmed, explain: false, profile: false }
}

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
  if (!plan.scanLabel && plan.steps?.length === 0 && plan.filters?.length === 0 && plan.returnColumns?.length === 0 && !plan.hasMatch && !plan.create && !plan.show && !plan.with && !plan.unwind && !plan.unionType && !plan.caseColumns?.length) {
    // 检查原始查询是否包含有效关键字 — 大多数无效查询没有 MATCH etc.
    if (!/^\s*(MATCH|WITH|UNWIND|RETURN|CREATE|MERGE|SET|DELETE|REMOVE|FOREACH|CALL|SHOW|USE|BEGIN|COMMIT|ROLLBACK|EXPLAIN|PROFILE|LOAD|DROP|START|OPTIONAL)/i.test(query.trim())) {
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

// Legacy PEG parseQuery implementation — preserved for reference during migration.
// All preprocessing logic below (lines ~1680-2350) is deprecated and can be removed
// once ANTLR coverage is verified across the full TCK suite.
function _legacyPegParseQuery(_query: string): QueryPlan {
  let directAst: any = null
  try {
    directAst = parseCypherToPlan(_query.trim())
  } catch {}

  if (directAst) {
    // SHOW CONSTRAINTS / INDEXES / PROCEDURES / FUNCTIONS / LABELS / RELATIONSHIPTYPES
    if (directAst.type === 'SHOW') {
      return {
        type: 'QUERY' as const,
        show: directAst.show,
        scanLabel: null,
        labelExpr: null,
        steps: [],
        filters: [],
        returnColumns: [],
        orderBy: [],
      }
    }
    // DROP CONSTRAINT (parse only, execution is a no-op)
    if (directAst.type === 'DROP_CONSTRAINT') {
      return {
        type: 'QUERY' as const,
        scanLabel: null,
        labelExpr: null,
        steps: [],
        filters: [],
        returnColumns: [],
        orderBy: [],
      }
    }
    // CREATE INDEX (parse only, execution is a no-op)
    if (directAst.type === 'CREATE_INDEX') {
      return {
        type: 'QUERY' as const,
        scanLabel: null,
        labelExpr: null,
        steps: [],
        filters: [],
        returnColumns: [],
        orderBy: [],
        indexOp: 'CREATE' as const,
        indexLabel: directAst.label,
        indexProperty: directAst.property,
      }
    }
    // DROP INDEX (parse only, execution is a no-op)
    if (directAst.type === 'DROP_INDEX') {
      return {
        type: 'QUERY' as const,
        scanLabel: null,
        labelExpr: null,
        steps: [],
        filters: [],
        returnColumns: [],
        orderBy: [],
        indexOp: 'DROP' as const,
        indexLabel: directAst.label,
        indexProperty: directAst.property,
      }
    }
    // CREATE — attach periodicCommitHint if present
    if (directAst.type === 'CREATE') {
      const plan: QueryPlan = {
        type: 'CREATE' as const,
        scanLabel: null,
        labelExpr: null,
        steps: [],
        filters: [],
        returnColumns: [],
        orderBy: [],
      }
      if ((directAst as any).periodicCommitHint) {
        plan.periodicCommit = { batchSize: (directAst as any).periodicCommitHint.batchSize }
      }
      return plan
    }
    // EXPLAIN / PROFILE / DESCRIBE — innerStatement is a parsed AST object
    if (directAst.type === 'EXPLAIN') {
      // innerStatement is already a parsed AST object from PEG's recursive rule
      const plan = planFromAST(directAst.innerStatement)
      if (directAst.explainMode === 'describe' || directAst.explainMode === 'text') {
        plan.explain = true
      } else if (directAst.explainMode === 'profile') {
        plan.profile = true
      }
      return plan
    }
    // BEGIN / COMMIT / ROLLBACK 事务语句 — 解析即可，执行留空
    if (directAst.type === 'BEGIN' || directAst.type === 'COMMIT' || directAst.type === 'ROLLBACK') {
      return {
        type: directAst.type as 'BEGIN' | 'COMMIT' | 'ROLLBACK',
        scanLabel: null,
        labelExpr: null,
        steps: [],
        filters: [],
        returnColumns: [],
        orderBy: [],
      }
    }
    // FOREACH — 解析即可，执行留空
    if (directAst.type === 'FOREACH') {
      return {
        type: 'FOREACH',
        scanLabel: null,
        labelExpr: null,
        steps: [],
        filters: [],
        returnColumns: [],
        orderBy: [],
        forEach: _pegForEachToClause(directAst),
      }
    }
    // EXISTS subquery (NEST / SQ2) — 解析即可
    if (directAst.type === 'EXISTS_SUBQUERY') {
      return {
        type: 'EXISTS_SUBQUERY',
        scanLabel: null,
        labelExpr: null,
        steps: [],
        filters: [],
        returnColumns: [],
        orderBy: [],
      }
    }
    // TRANSACTION_CONJUNCT — 复合事务（BEGIN ... COMMIT）
    if (directAst.type === 'TRANSACTION_CONJUNCT') {
      return {
        type: 'TRANSACTION_CONJUNCT',
        end: directAst.end,
        scanLabel: null,
        labelExpr: null,
        steps: [],
        filters: [],
        returnColumns: [],
        orderBy: [],
      }
    }
    // CALL (子查询) — route through planFromAST directly
    if (directAst.type === 'CALL') {
      const plan = planFromAST(directAst)
      return plan
    }
    // CALL_PROCEDURE — route through planFromAST directly
    if (directAst.type === 'CALL_PROCEDURE') {
      const plan = planFromAST(directAst)
      return plan
    }
    // Compound queries (MATCH + WHERE + CREATE/SET/REMOVE + RETURN) — 
    // already parsed directly by PEG. Route through planFromAST directly.
    if (directAst.type === 'QUERY' && (directAst.create || directAst.set || directAst.remove || directAst.delete || directAst.forEach || directAst.match || directAst.unwind || directAst.merge)) {
      // FOREACH-only queries — handle directly without preprocessing
      if (directAst.forEach) {
        const plan = planFromAST(directAst)
        return plan
      }
      // If query contains OPTIONAL MATCH or WITH but directAst didn't parse them,
      // fall through to preprocessing (handles MATCH ... OPTIONAL MATCH ... RETURN cases)
      if (directAst.match && !(directAst as any).optionalMatches && query.includes('OPTIONAL MATCH')) {
        // fall through to preprocessing
      } else if (directAst.match && !(directAst as any).with && query.match(/\bWITH\b/) && query.indexOf('WITH') > query.indexOf('MATCH') && !query.match(/EXISTS\s*\{[^}]+\bWITH\b/i)) {
        // fall through to preprocessing for MATCH ... WITH ... cases
      } else if (directAst.match && query.match(/\bDELETE\b/i) && !(directAst as any).delete) {
        // MATCH ... DELETE — PEG didn't parse DELETE, fall through
      } else if (directAst.match && query.match(/\bDETACH\s+DELETE\b/i) && !(directAst as any).delete) {
        // MATCH ... DETACH DELETE — PEG didn't parse, fall through
      } else if (directAst.type === 'QUERY' && directAst.return && query.match(/\bINTERSECT\b/i) && !(directAst as any).unionType) {
        // RETURN ... INTERSECT — PEG didn't parse, fall through
      } else if (directAst.type === 'QUERY' && directAst.return && query.match(/\bHAVING\b/i) && !(directAst as any).having) {
        // GROUP BY ... HAVING — fall through
      } else if (directAst.type === 'QUERY' && directAst.return && query.match(/\breduce\s*\(/i)) {
        // ... RETURN reduce(...) — PEG can't handle, fall through
      } else if (directAst.match && !(directAst as any).create && query.match(/MATCH.*CREATE\b/i) && query.indexOf('CREATE') > query.indexOf('MATCH') && !query.match(/MATCH.*CREATE\b.*RETURN/i)) {
        // MATCH ... CREATE — No RETURN clause makes PEG fail, fall through
      } else if (directAst.type === 'QUERY' && !Array.isArray(directAst.create) && query.match(/CREATE\b.*\bCREATE\b/i) && query.indexOf('CREATE') !== query.lastIndexOf('CREATE')) {
        // CREATE ... CREATE (second CREATE not parsed)
      } else {
        const plan = planFromAST(directAst)
        if (!plan.periodicCommit && (directAst as any).periodicCommitHint) {
          // TEMP FIX: Ensure periodic commit hint is propagated even if planFromAST misses it
          plan.periodicCommit = { batchSize: (directAst as any).periodicCommitHint.batchSize }
        }
        return plan
      }
    }
    // Anything else that PEG parsed (e.g. regular MATCH queries) — continue to preprocess
  }

  // Guard: PEG returned null or undefined (syntax not supported) — 
  // but don't throw if the query contains special syntax that preprocessing handles
  if (!directAst) {
    const hasSpecial = /\bOPTIONAL MATCH\b|\bWITH\b|\bDELETE\b|\bDETACH\b|\bHAVING\b|\bINTERSECT\b|\bFOREACH\b|\bUNWIND\b|\bMERGE\b|\breduce\s*\(|MATCH.*CREATE|CREATE.*CREATE|\[:\w+\*|\[\[|,\s*\w+\(/.test(query);
    if (!hasSpecial) {
      throw new Error(`Query not parsed: ${query}`)
    }
  }

  // LOAD CSV (parsed by PEG) — only if directAst is non-null
  if (directAst && directAst.type === 'LOAD_CSV') {
    return {
      type: 'LOAD_CSV',
      url: directAst.url?.value ?? '',
      rowVariable: directAst.rowName,
      hasHeaders: directAst.withHeaders ?? false,
      scanLabel: null,
      labelExpr: null,
      steps: [],
      filters: [],
      returnColumns: [],
      orderBy: [],
    }
  }

  // Step 0a: Detect EXPLAIN / PROFILE prefix (backward compat for old-style text stripping)
  const { stripped, explain, profile } = _stripExplainProfile(query)

  // Step 1: Preprocess to extract OPTIONAL MATCH and WITH
  const { cleanQuery, extracts } = _preprocessQuery(stripped)

  // Step 2: Parse the cleaned query with peggy
  let ast: QueryAST
  try {
    ast = parseCypherToPlan(cleanQuery) as QueryAST
  } catch (err: any) {
    throw new Error(`Query parse error: ${err.message}`)
  }

  // Step 3: Post-process to re-attach OPTIONAL MATCH and WITH
  _postProcessAST(ast, extracts)

  const plan = planFromAST(ast)

  // Step 3a: Set EXPLAIN / PROFILE flags (only set when true)
  if (explain) plan.explain = true
  if (profile) plan.profile = true

  // Step 4: Attach FOREACH if extracted（支持嵌套递归构建）
  if (extracts.foreachExtract) {
    plan.forEach = _buildForEachFromExtract(extracts.foreachExtract)
  }

  // Step 5: Attach REDUCE if extracted
  if (extracts.reduceExtract) {
    const listExpr = extracts.reduceExtract.listExpr.trim()
    let list: unknown[] = []
    let isVarRef = true
    if (listExpr.startsWith('[') && listExpr.endsWith(']')) {
      isVarRef = false
      try { list = JSON.parse(listExpr.replace(/'/g, '"')) } catch { list = [] }
    }
    let initial: unknown = extracts.reduceExtract.initial
    // 处理引号包裹的字符串
    if (/^"[^"]*"$/.test(initial as string) || /^'[^']*'$/.test(initial as string)) {
      initial = (initial as string).slice(1, -1)
    } else if (/^\d+(\.\d+)?$/.test(initial as string)) {
      initial = Number(initial)
    } else if (initial === 'true') initial = true
    else if (initial === 'false') initial = false

    plan.reduce = {
      accumulator: extracts.reduceExtract.accumulator,
      initial,
      variable: extracts.reduceExtract.variable,
      list,
      isVarRef,
      expression: extracts.reduceExtract.expression,
    }
  }

  // Step 6: Attach LOAD CSV if extracted
  if (extracts.loadCsvExtract) {
    plan.loadCsv = {
      url: extracts.loadCsvExtract.url,
      rowVariable: extracts.loadCsvExtract.rowVariable,
      hasHeaders: extracts.loadCsvExtract.hasHeaders,
    }
  }

  // Step 7: Attach window functions if extracted
  if (extracts.windowExtracts && extracts.windowExtracts.length > 0) {
    plan.windowFunctions = extracts.windowExtracts
  }

  // Step 8: Attach SEARCH clause if extracted
  if (extracts.searchExtract) {
    plan.search = extracts.searchExtract
  }

  // Step 8.5: Attach complex RETURN expression if extracted
  if (extracts.returnExtract) {
    // Store the raw return expression for plan construction
    if (!plan.expressionColumns) plan.expressionColumns = []
    // Try to split the return extract by commas (best effort)
    const items = extracts.returnExtract.split(',').map((s: string) => s.trim())
    for (const item of items) {
      const asMatch = item.match(/(.+?)\s+AS\s+(\w+)$/i)
      if (asMatch) {
        const expr = asMatch[1].trim()
        const alias = asMatch[2].trim()
        plan.expressionColumns.push({ expression: expr, alias })
        if (!plan.returnColumns.includes(alias)) {
          plan.returnColumns = [alias]
        }
      } else {
        plan.expressionColumns.push({ expression: item, alias: item.replace(/[^a-zA-Z0-9_]/g, '_') })
      }
    }
  }

  // Step 9: Attach periodic commit hint from parsed AST
  if (ast && (ast as any).periodicCommitHint) {
    const hint = (ast as any).periodicCommitHint
    plan.periodicCommit = {
      batchSize: hint.batchSize,
    }
  }

  // Step 10: Propagate SKIP/LIMIT from AST to plan for DELETE queries
  // When DELETE clause was extracted, _postProcessAST set ast.skip/ast.limit
  if (plan.deleteTargets && plan.deleteTargets.length > 0) {
    if (ast.skip !== undefined && plan.skip === undefined) plan.skip = ast.skip
    if (ast.limit !== undefined && plan.limit === undefined) plan.limit = ast.limit
  }

  // Step 11: Handle INTERSECT unionType with rightQuery
  if (ast.unionType === 'intersect' && ast.rightQuery) {
    plan.unionType = 'intersect'
    plan.rightPlan = planFromAST(ast.rightQuery)
  }


  return plan
}

function _mapHavingOperator(op: string): HavingClause['operator'] {
  switch (op) {
    case '>': return 'GT'
    case '>=': return 'GTE'
    case '<': return 'LT'
    case '<=': return 'LTE'
    case '=': return 'EQ'
    case '!=': case '<>': return 'NEQ'
    default: return 'GT'
  }
}

/**
 * Post-process the parsed AST to attach OPTIONAL MATCH and WITH information
 * extracted during preprocessing.
 */
export function _postProcessAST(ast: QueryAST, extracts: _QueryExtracts): void {
  // ── Attach OPTIONAL MATCH ──
  if (extracts.optionalMatches.length > 0) {
    ast.optionalMatches = []
    for (const extract of extracts.optionalMatches) {
      // The extract is the pattern text after "OPTIONAL MATCH "
      // Parse it as a pseudo MATCH query to get the AST nodes.
      // We use the first variable name as the return column.
      let firstVar = 'n'
      const firstVarMatch = extract.match(/\((\w+)/)
      if (firstVarMatch) firstVar = firstVarMatch[1]

      const pseudoQuery = `MATCH ${extract} RETURN ${firstVar}`

      const optMatch: {
        type: 'OPTIONAL_MATCH'
        patterns: PatternAST[]
        where?: WhereClauseAST | null
      } = {
        type: 'OPTIONAL_MATCH',
        patterns: [],
      }

      try {
        const optAst = parseCypherToPlan(pseudoQuery) as QueryAST
        if (optAst.match) {
          optMatch.patterns = optAst.match.patterns
          if (optAst.where) {
            optMatch.where = optAst.where
          }
        }
      } catch {
        // If full parsing fails, try without WHERE
        try {
          const whereIdx = extract.search(/\bWHERE\s+/i)
          const simpleExtract = whereIdx !== -1
            ? extract.slice(0, whereIdx).trimEnd()
            : extract
          const simplePseudo = `MATCH ${simpleExtract} RETURN ${firstVar}`
          const simpleAst = parseCypherToPlan(simplePseudo) as QueryAST
          if (simpleAst.match) {
            optMatch.patterns = simpleAst.match.patterns
          }
        } catch {
          // Cannot parse — skip this optional match pattern
        }
      }

      ast.optionalMatches.push(optMatch)
    }
  }

  // ── Attach WITH ──
  if (extracts.withRaw && extracts.withRaw.length > 0) {
    // Process the WITH clauses left-to-right, but we only keep the last one
    // since chained WITH is handled by projecting within the plan
    const lastWithRaw = extracts.withRaw[extracts.withRaw.length - 1]

    // Parse the WITH body by pretending it's a RETURN clause
    // WITH expr1 AS a1, expr2 AS a2 [WHERE ...] [ORDER BY ...] [LIMIT n]
    // → "MATCH (__with_dummy) RETURN expr1 AS a1, expr2 AS a2"
    // Extract WHERE/ORDER/LIMIT from the raw text first

    const withInfo = _parseWithExtract(lastWithRaw)

    if (withInfo.columns.length > 0) {
      const withClause: WithClauseAST = {
        type: 'WITH',
        columns: withInfo.columns.map(c => ({
          type: 'COLUMN',
          expression: _stringToPrimary(c.expression),
          alias: c.alias,
        })),
      }

      // Attach WHERE
      if (withInfo.filters.length > 0) {
        withClause.where = {
          type: 'WHERE',
          expression: null as unknown as ExpressionAST,
        }
      }

      // Attach ORDER BY
      if (withInfo.orderBy.length > 0) {
        withClause.orderBy = {
          type: 'ORDER_BY',
          columns: withInfo.orderBy.map(o => ({
            type: 'ORDER_COLUMN',
            expression: { type: 'IDENTIFIER', name: o.property },
            direction: o.direction,
          })),
        }
      }

      // Attach LIMIT/SKIP
      withClause.limit = withInfo.limit
      withClause.skip = withInfo.skip

      // Attach aggregate
      if (withInfo.aggregate) {
        withClause.aggregate = withInfo.aggregate
      }

      // Store filter info for planFromAST
      (withClause as any)._filterInfo = withInfo.filters

      ast.with = withClause
    }
  }

  // ── Attach HAVING ────────────────────────────────────────
  if (extracts.havingRaw) {
    const havingRaw = extracts.havingRaw.trim()
    // Parse HAVING clause: aggregation expression [operator] [value]
    // Examples: count(n.age) > 1, count(*) > 999
    const havingParts = havingRaw.match(
      /(\w+(?:\([^)]*\))?)\s*(>|>=|<|<=|=|!=|<>)\s*(\d+(?:\.\d+)?)/i
    )
    if (havingParts) {
      const havingClause: HavingClause = {
        property: havingParts[1].trim(),
        operator: _mapHavingOperator(havingParts[2]),
        value: parseFloat(havingParts[3]),
      }
      // Attach to AST's return.having
      if (ast.return) {
        (ast.return as any).having = [havingClause]
      }
    }
  }

  // ── Attach DELETE ────────────────────────────────────────
  if (extracts.deleteExtract) {
    const de = extracts.deleteExtract
    const deleteClause: any = {
      type: 'DELETE',
      targets: de.targets,
      detach: de.detach,
    }
    ast.delete = deleteClause
    // Propagate SKIP/LIMIT to the AST level if present
    if (de.skip !== undefined) ast.skip = de.skip
    if (de.limit !== undefined) ast.limit = de.limit
  }

  // ── Attach INTERSECT ─────────────────────────────────────
  if (extracts.intersectExtract) {
    // Set unionType to 'intersect' and store the second query as rightQuery
    ast.unionType = 'intersect'
    const intersectText = extracts.intersectExtract.trim()
    try {
      const intersectAst = parseCypherToPlan(intersectText) as QueryAST
      ast.rightQuery = intersectAst
    } catch {
      // If PEG can't parse the right side, just store the raw text for later handling
      ;(ast as any).__intersectRaw = intersectText
    }
  }

  // ── Attach second CREATE (chains) ─────────────────────────
  if (extracts.secondCreateExtract) {
    const secondText = extracts.secondCreateExtract.trim()
    try {
      const secondAst = parseCypherToPlan(secondText) as QueryAST
      if (secondAst.create && ast.create) {
        // Merge patterns from second CREATE into the first
        for (const pat of secondAst.create.patterns) {
          ast.create.patterns.push(pat)
        }
      }
      // Also merge any SET that may have been attached
      if (secondAst.set && ast.set) {
        for (const item of secondAst.set.items) {
          ast.set.items.push(item)
        }
      }
    } catch {
      ;(ast as any).__secondCreateRaw = secondText
    }
  }

  // ── Attach returnExtract (complex RETURN expressions) ──────
  if (extracts.returnExtract) {
    ;(ast as any).__returnExtract = extracts.returnExtract
  }

  // ── Attach MERGE + ORDER BY ──────────────────────────────
  if (extracts.mergeOrderByExtract) {
    // Parse ORDER BY expression and attach to AST
    const orderByColumns = extracts.mergeOrderByExtract.split(',').map(s => {
      const col = s.trim()
      const dirMatch = col.match(/^(.*?)\s+(ASC|DESC)$/i)
      if (dirMatch) {
        return {
          type: 'ORDER_COLUMN' as const,
          expression: { type: 'IDENTIFIER' as const, name: dirMatch[1].trim() },
          direction: dirMatch[2].toUpperCase() as 'ASC' | 'DESC',
        }
      }
      return {
        type: 'ORDER_COLUMN' as const,
        expression: { type: 'IDENTIFIER' as const, name: col },
        direction: 'ASC' as const,
      }
    })
    ast.orderBy = { type: 'ORDER_BY' as const, columns: orderByColumns }
  }

  // ── Attach UNWIND + MERGE ────────────────────────────────
  if (extracts.unwindMergeExtract) {
    // Store the merge text for later processing
    ;(ast as any).__unwindMergeExtract = extracts.unwindMergeExtract
  }

  // ── Attach second UNWIND ─────────────────────────────────
  if (extracts.secondUnwindExtract) {
    // Store the second UNWIND for later processing
    ;(ast as any).__secondUnwindExtract = extracts.secondUnwindExtract
  }

  // ── Restore ORDER BY aggregate replacements ─────────────────
  if (extracts.orderByAggReplacements && extracts.orderByAggReplacements.length > 0) {
    // Store replacements info for planFromAST to use
    (ast as any).__orderByAggReplacements = extracts.orderByAggReplacements
  }
}

/**
 * Convert a string expression to a PrimaryAST (best effort).
 */
function _stringToPrimary(expr: string): PrimaryAST {
  const trimmed = expr.trim()

  // Check if it's a list literal [item1, item2, ...]
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1)
    if (inner.trim() === '') {
      return { type: 'LIST', items: [] }
    }
    const items = inner.split(',').map(s => s.trim()).filter(Boolean)
    const parsedItems: any[] = items.map(item => {
      // Try number
      const num = parseFloat(item)
      if (!isNaN(num) && item !== '') return { type: 'NUMBER', value: num }
      // Try string
      if ((item.startsWith("'") && item.endsWith("'")) || (item.startsWith('"') && item.endsWith('"'))) {
        return { type: 'STRING', value: item.slice(1, -1) }
      }
      // Try boolean
      if (item.toLowerCase() === 'true') return { type: 'BOOLEAN', value: true }
      if (item.toLowerCase() === 'false') return { type: 'BOOLEAN', value: false }
      // Default: identifier
      return { type: 'IDENTIFIER', name: item }
    })
    return { type: 'LIST', items: parsedItems }
  }

  // Check if it's a property ref (name.prop)
  const propMatch = trimmed.match(/^(\w+)\.(\w+)$/)
  if (propMatch) {
    return { type: 'PROP_REF', name: propMatch[1], property: propMatch[2] }
  }

  // Check if it's an identifier
  const identMatch = trimmed.match(/^\w+$/)
  if (identMatch) {
    return { type: 'IDENTIFIER', name: trimmed }
  }

  // Check if it's a number
  const num = parseFloat(trimmed)
  if (!isNaN(num) && trimmed !== '') {
    return { type: 'NUMBER', value: num }
  }

  // Check if it's a string
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return { type: 'STRING', value: trimmed.slice(1, -1) }
  }

  // Default to identifier
  return { type: 'IDENTIFIER', name: trimmed }
}

/**
 * Cached version of parseQuery: checks planCache before parsing.
 * Only caches on success (parse errors still throw without caching).
 */
export function parseQueryCached(
  query: string,
  schema?: import('../schema/schema-types').SchemaDef,
): QueryPlan {
  // Check cache first
  const cached = planCache.get(query)
  if (cached) return cached

  const plan = parseQuery(query)
  planCache.set(query, plan)
  return plan
}

/**
 * 将 AST 转换为 QueryPlan
 *
 * @param ast - parsed query AST
 * @param schema - optional schema for lightweight type validation
 */
export function planFromAST(
  ast: any,
  schema?: import('../schema/schema-types').SchemaDef,
): QueryPlan {
  // TEMP DEBUG: force periodicCommit for CREATE queries
  if (ast.create && (ast as any).periodicCommitHint) {
    const tmpHint = (ast as any).periodicCommitHint
    console.log('[DEBUG planFromAST] periodicCommitHint found, batchSize:', tmpHint.batchSize)
  }

  // ── USE 语句处理 ──────────────────────────────────────────
  if (ast.type === 'USE') {
    return {
      type: 'USE',
      useGraph: ast.name,
      scanLabel: null,
      labelExpr: null,
      steps: [],
      filters: [],
      returnColumns: [],
      orderBy: [],
    }
  }

  // ── CREATE CONSTRAINT 处理 ──────────────────────────────────
  if (ast.type === 'CREATE_CONSTRAINT') {
    return {
      type: 'CREATE_CONSTRAINT',
      scanLabel: null,
      labelExpr: null,
      steps: [],
      filters: [],
      returnColumns: [],
      orderBy: [],
      constraint: {
        label: ast.label,
        property: ast.property,
      },
    }
  }

  const plan: QueryPlan = {
    type: 'QUERY',
    scanLabel: null,
    labelExpr: null,
    steps: [],
    filters: [],
    returnColumns: [],
    orderBy: [],
    limit: ast.limit,
    skip: ast.skip,
    aggregate: ast.return?.aggregate ?? ast.aggregate,
    unionType: ast.unionType,
    rightPlan: ast.rightQuery ? planFromAST(ast.rightQuery) : undefined,
  }

  // ── DML 处理 ────────────────────────────────────────────

  if (ast.forEach) {
    return {
      type: 'FOREACH',
      scanLabel: null,
      labelExpr: null,
      steps: [],
      filters: [],
      returnColumns: [],
      orderBy: [],
      forEach: ast.forEach && typeof ast.forEach === 'object' && (ast.forEach as any).body
        ? _pegForEachToClause(ast.forEach as any)
        : ast.forEach as ForEachClause,
    }
  }

  if (ast.create) {
    plan.type = 'CREATE'
    const { createNodes, createEdges } = planFromCreateClause(ast.create)
    plan.createNodes = createNodes
    plan.createEdges = createEdges
  }

  if (ast.delete) {
    plan.type = 'DELETE'
    plan.deleteTargets = [...ast.delete.targets]
    if (ast.delete.detach) {
      plan.detachDelete = true
    }
    // 如果有 MATCH，继续处理
  }

  if (ast.set) {
    plan.type = 'SET'
    plan.setClauses = planFromSetClause(ast.set)
  }

  if (ast.remove) {
    if (!plan.type) {
      plan.type = 'SET'   // reuse SET type since REMOVE is also a mutation
    }
    plan.removeClauses = planFromRemoveClause(ast.remove)
  }

  if (ast.merge) {
    plan.type = 'MERGE'
    // Handle both single MERGE and multi-MERGE (array)
    const mergeClauses = Array.isArray(ast.merge) ? ast.merge : [ast.merge]
    const allMergeNodes: QueryPlan['mergeNodes'] = []
    const allMergeEdges: QueryPlan['mergeEdges'] = []

    if (mergeClauses.length > 0) {
      const first = mergeClauses[0]
      const { createNodes: mergeNodes, createEdges: mergeEdges } = planFromCreateClause(first)
      allMergeNodes.push(...(mergeNodes ?? []))
      allMergeEdges.push(...(mergeEdges ?? []))
      // For multi-MERGE chains, include all patterns
      for (let i = 1; i < mergeClauses.length; i++) {
        const { createNodes: moreNodes, createEdges: moreEdges } = planFromCreateClause(mergeClauses[i])
        allMergeNodes.push(...(moreNodes ?? []))
        allMergeEdges.push(...(moreEdges ?? []))
      }
      if (first.onCreate) {
        plan.mergeOnCreate = planFromSetClause(first.onCreate)
      }
      if (first.onMatch) {
        plan.mergeOnMatch = planFromSetClause(first.onMatch)
      }
    }

    plan.mergeNodes = allMergeNodes
    plan.mergeEdges = allMergeEdges
  }

  // ── CALL 过程调用处理 ──────────────────────────────────

  if (ast.type === 'CALL_PROCEDURE' && ast.procedureName) {
    plan.type = 'CALL_PROCEDURE'
    plan.callProcedure = {
      name: ast.procedureName,
      args: (ast.arguments ?? []).map((arg: any) => {
        // 处理各种字面量类型
        if (arg.type === 'STRING') return arg.value
        if (arg.type === 'NUMBER') return arg.value
        if (arg.type === 'BOOLEAN') return arg.value
        if (arg.type === 'LIST') return (arg.items ?? []).map((item: any) => item.value ?? item)
        if (arg.type === 'IDENTIFIER') return arg.name
        return arg
      }),
    }
    if (ast.yield) {
      plan.callProcedure.yieldItems = ast.yield.items.map((item: any) => ({
        name: item.name,
        alias: item.alias ?? null,
      }))
    }
    if (ast.orderBy) {
      plan.orderBy = ast.orderBy.columns.map((col: any) => ({
        property: formatColumn(col.expression),
        direction: col.direction as 'ASC' | 'DESC',
      }))
    }
    if (ast.limit !== undefined) plan.limit = ast.limit
    if (ast.skip !== undefined) plan.skip = ast.skip
    return plan
  }

  // ── CALL 子查询处理 ──────────────────────────────────────

  if (ast.type === 'CALL' && ast.query) {
    plan.type = 'CALL'
    plan.callQuery = planFromAST(ast.query, schema)
    // 传递 IN TRANSACTIONS 标志
    if (ast.inTransactions) {
      plan.inTransactions = true
      if (ast.inTransactionsBatchSize !== undefined) {
        plan.inTransactionsBatchSize = ast.inTransactionsBatchSize
      }
    }
    // CALL 外层可有 RETURN / ORDER BY / LIMIT / SKIP
    if (ast.return) {
      if (ast.return.columns && ast.return.columns.length > 0) {
        plan.returnColumns = ast.return.columns.map((col: any) => col.alias ?? formatColumn(col.expression))
      }
    }
    if (ast.orderBy) {
      plan.orderBy = ast.orderBy.columns.map((col: any) => ({
        property: formatColumn(col.expression),
        direction: col.direction as 'ASC' | 'DESC',
      }))
    }
    if (ast.limit !== undefined) plan.limit = ast.limit
    if (ast.skip !== undefined) plan.skip = ast.skip
    return plan
  }

  // ── Lightweight type validation ──────────────────────────
  if (schema) {
    _validateQueryTypes(ast, schema)
  }

  // ── MATCH 处理（可能跟在 DELETE/SET 后，也可能单独存在） ──

  if (ast.match) {
    plan.hasMatch = true
    const pattern = ast.match.patterns[0]
    if (pattern) {
      _applyPatternToPlan(plan, pattern, ast.where)
    }
  }

  // ── OPTIONAL MATCH 处理 ──

  if (ast.optionalMatches && ast.optionalMatches.length > 0) {
    plan.optionalMatchSteps = []
    for (const optMatch of ast.optionalMatches) {
      const pattern = optMatch.patterns[0]
      if (pattern) {
        const tempPlan: QueryPlan = {
          type: 'QUERY',
          scanLabel: null,
          labelExpr: null,
          steps: [],
          filters: [],
          returnColumns: [],
          orderBy: [],
        }
        _applyPatternToPlan(tempPlan, pattern, optMatch.where ?? null)
        plan.optionalMatchSteps.push({
          scanLabel: tempPlan.scanLabel,
          steps: tempPlan.steps,
          filters: tempPlan.filters,
        })
      }
    }
  }

  // ── UNWIND 处理 ──

  if (ast.unwind) {
    plan.unwind = {
      list: ast.unwind.list,
      name: ast.unwind.name,
      var: ast.unwind.var,  // 传递给 _executeUnwind 用于变量引用解析
    }
  }

  // ── UNWIND + MERGE 处理 ──
  // When UNWIND was followed by MERGE, the MERGE was extracted and replaced
  // with a dummy MATCH. We need to reconstruct the merge information.
  const unwindMergeText = (ast as any).__unwindMergeExtract as string | undefined
  if (unwindMergeText) {
    try {
      // Parse the MERGE text as a pseudo query
      const mergePseudo = `MATCH (__dummy__) ${unwindMergeText}`
      const mergeAst = parseCypherToPlan(mergePseudo) as QueryAST
      if (mergeAst.merge) {
        plan.type = 'MERGE'
        const { createNodes: mergeNodes, createEdges: mergeEdges } = planFromCreateClause(mergeAst.merge)
        plan.mergeNodes = mergeNodes
        plan.mergeEdges = mergeEdges
        if (mergeAst.merge.onCreate) {
          plan.mergeOnCreate = planFromSetClause(mergeAst.merge.onCreate)
        }
        if (mergeAst.merge.onMatch) {
          plan.mergeOnMatch = planFromSetClause(mergeAst.merge.onMatch)
        }
      }
    } catch {
      // If we can't parse the merge, try a regex-based approach
      const mergeNodeMatch = unwindMergeText.match(/MERGE\s*\((\w+):(\w+)\s*\{([^}]*)\}/i)
      if (mergeNodeMatch) {
        const alias = mergeNodeMatch[1]
        const label = mergeNodeMatch[2]
        const propsStr = mergeNodeMatch[3]
        const props: Record<string, unknown> = {}
        const propMatches = propsStr.matchAll(/(\w+)\s*:\s*([^,}]+)/g)
        for (const pm of propMatches) {
          props[pm[1]] = pm[2].trim()
        }
        plan.type = 'MERGE'
        plan.mergeNodes = [{ alias, label, props: Object.keys(props).length > 0 ? props : null }]
      }

      // Check for ON CREATE SET
      const onCreateMatch = unwindMergeText.match(/ON\s+CREATE\s+SET\s+(\w+\.(\w+))\s*=\s*(['"]([^'"]+)['"]|true|false|\d+)/i)
      if (onCreateMatch) {
        plan.mergeOnCreate = [{ property: onCreateMatch[2], value: onCreateMatch[4] ?? onCreateMatch[3] }]
      }
    }
  }

  // ── Second UNWIND (UNWIND chain) ──
  const secondUnwindText = (ast as any).__secondUnwindExtract as string | undefined
  if (secondUnwindText) {
    // Parse the second UNWIND as a separate statement
    try {
      const unwindPseudo = `MATCH (__dummy__) ${secondUnwindText}`
      const secondAst = parseCypherToPlan(unwindPseudo) as QueryAST
      if (secondAst.unwind) {
        // Store second UNWIND info in plan
        plan.secondUnwind = {
          list: secondAst.unwind.list,
          name: secondAst.unwind.name,
          var: secondAst.unwind.var,
        }
      }
    } catch {
      // Regex fallback
      const unwindMatch = secondUnwindText.match(/UNWIND\s+(.+?)\s+AS\s+(\w+)/i)
      if (unwindMatch) {
        let list: unknown[] = []
        let isList = true
        const listStr = unwindMatch[1].trim()
        if (listStr.startsWith('[') && listStr.endsWith(']')) {
          try { list = JSON.parse(listStr.replace(/'/g, '"')) } catch { list = [] }
        } else {
          isList = false
          list = [listStr]
        }
        plan.secondUnwind = {
          list: isList ? [list] : [listStr],
          name: unwindMatch[2],
          var: isList ? undefined : unwindMatch[1],
        }
      }
    }
  }

  // ── WITH 处理 ──

  if (ast.with) {
    const withClause = ast.with
    const withFilterInfo = (withClause as any)._filterInfo as FilterClause[] | undefined

    plan.with = {
      columns: withClause.columns.map(col => ({
        expression: col.expression as any,
        alias: col.alias,
      })),
      filters: withFilterInfo ?? [],
      orderBy: withClause.orderBy
        ? withClause.orderBy.columns.map(col => ({
            property: formatColumn(col.expression),
            direction: col.direction as 'ASC' | 'DESC',
          }))
        : [],
      limit: withClause.limit,
      skip: withClause.skip,
      aggregate: withClause.aggregate,
    }
  }

  // ── RETURN 处理 ─────────────────────────────────────────

  if (ast.return) {
    if (ast.return.aggregate) {
      // 聚合函数：用 alias 或字段名作为返回列名
      const agg = ast.return.aggregate
      // Check allCols for alias info (PEG generates this structure)
      let alias = agg.alias ?? agg.field ?? agg.type
      if (ast.return.allCols && ast.return.allCols.length > 0 && !agg.alias) {
        alias = ast.return.allCols[0].alias ?? alias
      }
      plan.aggregate = { type: agg.type, field: agg.field, alias }
      plan.returnColumns = [alias]
    } else {
      // Check for aggregate columns within the column list
      let foundAggregate = false
      for (const col of ast.return.columns) {
        if (col.type === 'AGGREGATE_COLUMN' && col.expression?.type === 'AGGREGATE') {
          const func = String(col.expression.func ?? '')
          const field = String(col.expression.field ?? '')
          const alias = col.alias
          plan.aggregate = { type: func, field, alias }
          foundAggregate = true
        }
      }
      if (!foundAggregate) {
        // Detect CASE expressions and Pattern Comprehensions in RETURN columns
        const caseCols: QueryPlan['caseColumns'] = []
        const compCols: QueryPlan['comprehensionColumns'] = []
        const regularCols: string[] = []
        for (const col of ast.return.columns) {
          if (col.type === 'COLUMN' && col.expression?.type === 'CASE') {
            caseCols.push({
              expression: col.expression,
              alias: col.alias ?? 'case',
            })
            regularCols.push(col.alias ?? 'case')
          } else if (col.type === 'COLUMN' && col.expression?.type === 'PATTERN_COMPREHENSION') {
            const alias = col.alias ?? '_pc_' + regularCols.length
            compCols.push({
              expression: col.expression,
              alias,
            })
            regularCols.push(alias)
          } else if (col.type === 'COLUMN' && (
            col.expression?.type === 'ADD' ||
            col.expression?.type === 'SUBTRACT' ||
            col.expression?.type === 'MULTIPLY' ||
            col.expression?.type === 'DIVIDE' ||
            col.expression?.type === 'MODULO' ||
            col.expression?.type === 'POWER' ||
            col.expression?.type === 'UNARY_MINUS' ||
            col.expression?.type === 'LIST' ||
            col.expression?.type === 'SUBSCRIPT' ||
            col.expression?.type === 'SLICE')) {
            // 列表/下标/切片/加法表达式列 — 尝试编译时常量折叠
            const folded = foldConstantExpression(col.expression)
            if (folded && typeof folded === 'object' && folded.type) {
              // 不可折叠，存为运行时求值列
              const alias = col.alias ?? '_expr_' + regularCols.length
              if (!plan.expressionColumns) plan.expressionColumns = []
              plan.expressionColumns.push({ expression: col.expression, alias })
              regularCols.push(alias)
            } else if (typeof folded === 'string' || typeof folded === 'number' || typeof folded === 'boolean') {
              // 编译时可折叠的纯字面量 — 存为预计算值列
              const alias = col.alias ?? String(folded)
              if (!plan.constColumns) plan.constColumns = []
              plan.constColumns.push({ alias, value: folded })
              regularCols.push(alias)
            } else {
              regularCols.push(String(folded))
            }
          } else {
            regularCols.push(col.alias ?? formatColumn(col.expression))
          }
        }
        plan.returnColumns = regularCols
        if (caseCols.length > 0) {
          plan.caseColumns = caseCols
        }
        if (compCols.length > 0) {
          plan.comprehensionColumns = compCols
        }
      } else {
        // For aggregate columns, set returnColumns from the aggregate info
        const agg = plan.aggregate!
        const unaliased = agg.field ?? agg.type
        // If there are non-aggregate columns too (GROUP BY scenario),
        // include them in returnColumns
        const nonAggCols = ast.return.columns
          .filter(col => col.type !== 'AGGREGATE_COLUMN')
          .map(col => col.alias ?? formatColumn(col.expression))
        plan.returnColumns = [...nonAggCols, agg.alias ?? unaliased]
      }
    }

    // 处理 GROUP BY
    if (ast.groupBy) {
      plan.groupBy = ast.groupBy.map(col => formatColumn(col))
    }

    // 处理 HAVING（从 AST 的 return.having 中读取，由 _postProcessAST 注入）
    if (ast.return && (ast.return as any).having) {
      plan.having = (ast.return as any).having as HavingClause[]
    }

    // 处理 ORDER BY（只有在有 RETURN 时才有效）
    if (ast.orderBy) {
      plan.orderBy = ast.orderBy.columns.map(col => ({
        property: formatColumn(col.expression),
        direction: col.direction as 'ASC' | 'DESC',
      }))
    }

    // Restore ORDER BY aggregate function call placeholders
    const aggReplacements: Array<{ placeholder: string; original: string }> | undefined =
      (ast as any).__orderByAggReplacements
    if (aggReplacements && plan.orderBy) {
      for (const ob of plan.orderBy) {
        for (const r of aggReplacements) {
          if (ob.property === r.placeholder) {
            ob.property = r.original
          }
        }
      }
    }
  }

  return plan
}

/**
 * Apply a MATCH pattern + WHERE to a QueryPlan (shared by regular MATCH and OPTIONAL MATCH).
 */
function _applyPatternToPlan(
  plan: QueryPlan,
  pattern: PatternAST,
  where: WhereClauseAST | null,
): void {
  // Handle both legacy .label and modern .labelExpr
  plan.scanLabel = pattern.node.label ?? (pattern.node.labelExpr?.items?.[0]?.name ?? null)
  plan.labelExpr = pattern.node.labelExpr
    ? { type: 'LABEL_EXPR', items: pattern.node.labelExpr.items }
    : null

  // 处理遍历步骤
  for (const step of pattern.edges) {
    const traverseStep: TraverseStep = {
      source: step.node.name,
      direction: step.edge.direction,
      edgeLabel: typeof step.edge.label === 'object' && step.edge.label?.items ? String(step.edge.label.items[0]?.name ?? '') : String(step.edge.label ?? ''),
      targetAlias: step.node.name,
      targetLabel: step.node.label ?? (step.node.labelExpr?.items?.[0]?.name ?? null),
      targetProps: step.node.props,
    }
    // 如果边模式包含 range，添加到 traverseStep
    if (step.edge.range) {
      traverseStep.range = step.edge.range
    }
    plan.steps.push(traverseStep)
  }

  // 处理 WHERE：分离 EXISTS 和普通 filter
  if (where && where.expression && where.expression !== null) {
    const { exists, filters } = _splitExistsFromWhere(where.expression)
    if (exists.length > 0) {
      if (!plan.existsFilters) plan.existsFilters = []
      plan.existsFilters.push(...exists)
    }
    if (filters.length > 0) {
      plan.filters.push(...filters)
    } else {
      // If the entire WHERE was EXISTS, we should still push something?
      // No — EXISTS alone needs no extra filter.
    }
  }
}

/**
 * 从 WHERE 表达式中分离 EXISTS 子句和普通 filter。
 * EXISTS 子句需要运行时边存在性检查，不能由 _applyWhereFilters 处理。
 */
function _splitExistsFromWhere(
  expr: any,
): { exists: NonNullable<QueryPlan['existsFilters']>; filters: FilterClause[] } {
  const exists: NonNullable<QueryPlan['existsFilters']> = []
  const filters: FilterClause[] = []

  if (!expr) return { exists, filters }

  if (expr.type === 'EXISTS') {
    exists.push({
      source: expr.source,
      edgeLabel: expr.edgeLabel,
      direction: expr.direction,
      target: expr.target,
    })
    // 不生成普通 filter
  } else if (expr.type === 'EXISTS_PATTERNS') {
    for (const p of expr.patterns) {
      exists.push({
        source: p.source,
        edgeLabel: p.edgeLabel,
        direction: p.direction,
        target: p.target,
      })
    }
  } else if (expr.type === 'NOT_EXISTS_PATTERNS') {
    for (const p of expr.patterns) {
      exists.push({
        source: p.source,
        edgeLabel: p.edgeLabel,
        direction: p.direction,
        target: p.target,
        notExists: true,
      })
    }
  } else if (expr.type === 'COUNT_EXISTS_PATTERNS' || expr.type === 'COUNT_SUBQUERY') {
    // COUNT subquery in WHERE — skip, treat as regular compare
    // Just pass through as normal filter
  } else if (expr.type === 'AND') {
    // AND 情况下分别处理左右
    const leftResult = _splitExistsFromWhere(expr.left)
    const rightResult = _splitExistsFromWhere(expr.right)
    exists.push(...leftResult.exists, ...rightResult.exists)
    // 重新组合非 EXISTS 的 filter
    const nonExistsLeft = leftResult.filters
    const nonExistsRight = rightResult.filters
    if (nonExistsLeft.length > 0 && nonExistsRight.length > 0) {
      // 如果有多个普通 filter 且来自 AND，保留它们
      filters.push(...nonExistsLeft, ...nonExistsRight)
    } else if (nonExistsLeft.length > 0) {
      filters.push(...nonExistsLeft)
    } else if (nonExistsRight.length > 0) {
      filters.push(...nonExistsRight)
    }
  } else if (expr.type === 'OR') {
    // OR with EXISTS is complex — for MVP, just fall through to normal extractFilters
    // which will likely return empty filter for EXISTS nodes
    filters.push(...extractFilters(expr, []))
  } else {
    // 普通表达式 → 正常 extractFilters
    filters.push(...extractFilters(expr, []))
  }

  return { exists, filters }
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
        label: item.node.label ?? (item.node.labelExpr?.items?.[0]?.name ?? null),
        props: item.node.props,
      })
    } else if (item.type === 'CREATE_PATH') {
      // 添加起始节点
      createNodes.push({
        alias: item.node.name,
        label: item.node.label ?? (item.node.labelExpr?.items?.[0]?.name ?? null),
        props: item.node.props,
      })
      // 添加边和后续节点
      for (const step of (item.edges || [])) {
        createNodes.push({
          alias: step.node.name,
          label: step.node.label ?? (step.node.labelExpr?.items?.[0]?.name ?? null),
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
  return setClause.items.map(item => {
    if (item.type === 'SET_MAP') {
      return { type: 'SET_MAP', name: item.name, props: item.value } as any
    }
    if (item.type === 'SET_MAP_AUGMENT') {
      return { type: 'SET_MAP_AUGMENT', name: item.name, props: item.value } as any
    }
    if (item.type === 'SET_LABEL') {
      return { type: 'SET_LABEL', name: item.name, labels: item.label?.items?.map((l: any) => l.name) ?? [] } as any
    }
    return ({
      property: formatColumn(item.property),
      value: resolvePrimary(item.value),
    })
  })
}

/**
 * Handle MAP_KEY_ACCESS in runtime evaluation.
 */
function _evaluateMapAccess(expr: any, row: Record<string, unknown>): unknown {
  if (expr?.type === 'MAP_KEY_ACCESS') {
    const mapVal = expr.map as Record<string, any>
    const val = mapVal[expr.key]
    return val?.value ?? val ?? null
  }
  return expr
}

function planFromRemoveClause(removeClause: RemoveClauseAST): QueryPlan['removeClauses'] {
  return removeClause.items.map(item => {
    if (item.type === 'REMOVE_PROP') {
      return { type: 'REMOVE_PROP' as const, property: item.name }
    }
    return { type: 'REMOVE_LABEL' as const, ref: item.ref, label: item.label }
  })
}

// ── 聚合函数 ─────────────────────────────────────────────────

export interface AggregateResult {
  type: 'count' | 'sum' | 'avg' | 'max' | 'min' | 'collect'
  field: string  // 字段名或 '*'
  alias: string | null
  value: number | null | unknown[]
}

/**
 * 计算聚合函数值。
 *
 * 对给定的一组数值应用聚合函数：
 * - count: 返回数组长度
 * - sum: 返回所有值之和
 * - avg: 返回平均值
 * - max: 返回最大值
 * - min: 返回最小值
 *
 * @param fn - 聚合函数类型
 * @param values - 数值数组（count 忽略值内容，只计数）
 * @returns 聚合结果
 *
 * @example
 *   _evaluateAggregate('count', [1, 2, 3])   // { ..., value: 3 }
 *   _evaluateAggregate('sum', [1, 2, 3])      // { ..., value: 6 }
 *   _evaluateAggregate('avg', [1, 2, 3])      // { ..., value: 2 }
 *   _evaluateAggregate('max', [1, 2, 3])      // { ..., value: 3 }
 *   _evaluateAggregate('min', [1, 2, 3])      // { ..., value: 1 }
 */
export function _evaluateAggregate(
  fn: AggregateResult['type'],
  values: unknown[],
  field?: string,
): AggregateResult {
  if (fn === 'count') {
    return { type: 'count', field: field ?? '*', alias: null, value: values.length }
  }

  if (fn === 'collect') {
    const nonNull = values.filter(v => v !== null && v !== undefined)
    return { type: 'collect', field: field ?? '', alias: null, value: nonNull }
  }

  // 对非 count/collect 聚合，过滤出可用的数值
  const numericValues = values.filter(
    (v): v is number => typeof v === 'number' && !Number.isNaN(v)
  )

  if (numericValues.length === 0) {
    return { type: fn, field: field ?? '', alias: null, value: null }
  }

  let value: number
  switch (fn) {
    case 'sum':
      value = numericValues.reduce((a, b) => a + b, 0)
      break
    case 'avg':
      value = numericValues.reduce((a, b) => a + b, 0) / numericValues.length
      break
    case 'max':
      value = Math.max(...numericValues)
      break
    case 'min':
      value = Math.min(...numericValues)
      break
    default:
      value = 0
  }

  return { type: fn, field: field ?? '', alias: null, value }
}

/**
 * 从节点记录列表中计算聚合值，返回 Map<aggregateKey, value>。
 *
 * @param fn - 聚合函数类型
 * @param field - 聚合字段（如 'age' 或 '*'）
 * @param records - 节点记录数组
 * @returns Map，key 是聚合字段名，value 是聚合结果
 */
export function aggregateRecords(
  fn: AggregateResult['type'],
  field: string,
  records: Array<Record<string, unknown>>,
): Map<string, number | null> {
  if (fn === 'count') {
    const result = _evaluateAggregate('count', records, field)
    return new Map([[field, result.value]])
  }

  const values = records.map(r => r[field] as unknown)
  const result = _evaluateAggregate(fn, values, field)
  return new Map([[field, result.value]])
}

// ── 聚合检测 ─────────────────────────────────────────────────

/**
 * Parse an aggregate function call string into structured info.
 * Returns null if the expression is not an aggregate.
 *
 * @example
 *   _parseAggregate('count(*)')       → { fn: 'COUNT', field: '*', distinct: false }
 *   _parseAggregate('COUNT(DISTINCT name)') → { fn: 'COUNT', field: 'name', distinct: true }
 *   _parseAggregate('sum(n.age)')     → { fn: 'SUM', field: 'n.age', distinct: false }
 *   _parseAggregate('n.name')         → null
 */
export interface AggColumnInfo {
  fn: 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX' | 'COLLECT'
  field: string       // The raw field string inside parens
  prop: string        // The property name (after stripping variable prefix)
  distinct: boolean   // Whether DISTINCT is used
  alias: string | null
}

export function _parseAggregate(expr: string): AggColumnInfo | null {
  const trimmed = expr.trim()
  const re = /^(COUNT|SUM|AVG|MIN|MAX|COLLECT)\s*\(\s*(DISTINCT\s+)?(.+?)\s*\)\s*$/i
  const m = trimmed.match(re)
  if (!m) return null

  const field = m[3].trim()
  // Reject empty field like count( )
  if (!field) return null

  const fn = m[1].toUpperCase() as AggColumnInfo['fn']
  const distinct = !!m[2]

  // Extract property name: if field is "n.age", prop = "age"; if "*" or identifier, use as-is
  let prop: string
  if (field === '*') {
    prop = '*'
  } else if (field.includes('.')) {
    prop = field.split('.').pop()!
  } else {
    prop = field
  }

  return { fn, field, prop, distinct, alias: null }
}

/**
 * Check if an expression string is an aggregate function call.
 */
export function _isAggregateExpression(expr: string): boolean {
  return _parseAggregate(expr) !== null
}

/**
 * Extract all aggregate column info from a list of column strings.
 * Returns both aggregate columns and non-aggregate (group-by) columns.
 *
 * @example
 *   _extractAggColumns(['n', 'count(*) AS cnt'])
 *   → { aggCols: [{ fn: 'COUNT', field: '*', ... }], groupByCols: ['n'] }
 */
export interface AggColumnGroup {
  aggCols: AggColumnInfo[]
  groupByCols: string[]
}

export function _extractAggColumns(colExprs: string[]): AggColumnGroup {
  const aggCols: AggColumnInfo[] = []
  const groupByCols: string[] = []

  for (const col of colExprs) {
    // Strip AS alias suffix for detection
    const expr = col.replace(/\s+AS\s+\w+$/i, '').trim()
    const agg = _parseAggregate(expr)
    if (agg) {
      // Extract alias if present
      const asMatch = col.match(/\s+AS\s+(\w+)$/i)
      agg.alias = asMatch ? asMatch[1] : null
      aggCols.push(agg)
    } else {
      // Extract the base expression for group-by
      const baseExpr = col.replace(/\s+AS\s+\w+$/i, '').trim()
      groupByCols.push(baseExpr)
    }
  }

  return { aggCols, groupByCols }
}

// ── 聚合执行 ─────────────────────────────────────────────────

/**
 * Row type for query execution — a flat record mapping aliases to values.
 * Unlike NodeRecord which is a formal node representation, QueryRow is
 * a simple key-value projection used during WITH/RETURN transformation.
 */
export type QueryRow = Record<string, unknown>

/**
 * Execute aggregation over a set of rows.
 *
 * Behavior:
 * - If there are only aggregate columns (no group-by columns): return a single row
 * - If there are both aggregate and non-aggregate columns: group by non-aggregate columns
 *   (SQL standard behavior: every non-aggregate column in SELECT/WITH implicitly
 *   becomes a GROUP BY key)
 *
 * @param rows - Input rows (projected to column expressions)
 * @param aggCols - Aggregate column definitions
 * @param groupByCols - Non-aggregate column expressions for grouping
 * @returns Aggregated rows
 */
export function _executeAggregation(
  rows: QueryRow[],
  aggCols: AggColumnInfo[],
  groupByCols: string[],
  withColAliases?: Array<{ expression: string; alias: string | null }>,
): QueryRow[] {
  if (rows.length === 0) {
    // Empty set: COUNT and SUM return 0, others return null
    if (aggCols.length > 0 && groupByCols.length === 0) {
      const row: QueryRow = {}
      for (const agg of aggCols) {
        const key = agg.alias ?? agg.fn.toLowerCase()
        if (agg.fn === 'COLLECT') {
          row[key] = []
        } else {
          row[key] = (agg.fn === 'COUNT' || agg.fn === 'SUM') ? 0 : null
        }
      }
      return [row]
    }
    return []
  }

  // If no aggregate columns, return rows unchanged
  if (aggCols.length === 0) return rows

  // If only aggregate columns (no group-by): single row
  if (groupByCols.length === 0) {
    const row = _computeAggRow(rows, aggCols, withColAliases)
    return [row]
  }

  // Mixed: group by non-aggregate columns
  // Build group key → aggregated row
  const groups = new Map<string, QueryRow[]>()

  for (const row of rows) {
    // Build group key from group-by columns
    const keyParts: string[] = []
    for (const gb of groupByCols) {
      const val = _resolveExprValue(row, gb, withColAliases)
      const strVal = (val && typeof val === 'object')
        ? JSON.stringify(val)
        : String(val ?? '__NULL__')
      keyParts.push(strVal)
    }
    const key = keyParts.join('||')

    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(row)
  }

  const result: QueryRow[] = []
  for (const groupRows of Array.from(groups.values())) {
    const aggRow = _computeAggRow(groupRows, aggCols, withColAliases)
    // Add the group-by column values
    const firstRow = groupRows[0]
    for (const gb of groupByCols) {
      const val = _resolveExprValue(firstRow, gb, withColAliases)
      // Use the alias as key if present
      const asMatch = gb.match(/\s+AS\s+(\w+)$/i)
      let key: string
      if (asMatch) {
        key = asMatch[1]
      } else if (gb.includes('.')) {
        key = gb.split('.').pop()!  // name → name
      } else {
        key = gb
      }
      if (val !== undefined) {
        aggRow[key] = val
      }
    }
    result.push(aggRow)
  }

  return result
}

/**
 * Compute a single aggregated row from a group of rows.
 */
function _computeAggRow(
  rows: QueryRow[],
  aggCols: AggColumnInfo[],
  withColAliases?: Array<{ expression: string; alias: string | null }>,
): QueryRow {
  const row: QueryRow = {}

  for (const agg of aggCols) {
    const key = agg.alias ?? agg.fn.toLowerCase()
    const values = rows.map(r => _resolveExprValue(r, agg.field, withColAliases))

    switch (agg.fn) {
      case 'COUNT': {
        if (agg.field === '*') {
          row[key] = rows.length
        } else if (agg.distinct) {
          const distinctSet = new Set(values.filter(v => v !== null && v !== undefined))
          row[key] = distinctSet.size
        } else {
          row[key] = rows.length
        }
        break
      }
      case 'COLLECT': {
        const nonNull = values.filter(v => v !== null && v !== undefined)
        if (agg.distinct) {
          const uniqueSet = new Set(nonNull)
          row[key] = Array.from(uniqueSet)
        } else {
          row[key] = nonNull
        }
        break
      }
      case 'SUM': {
        const nums = values.filter((v): v is number => typeof v === 'number' && !Number.isNaN(v))
        row[key] = nums.length > 0 ? nums.reduce((a, b) => a + b, 0) : 0
        break
      }
      case 'AVG': {
        const nums = values.filter((v): v is number => typeof v === 'number' && !Number.isNaN(v))
        row[key] = nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null
        break
      }
      case 'MIN': {
        const nums = values.filter((v): v is number => typeof v === 'number' && !Number.isNaN(v))
        row[key] = nums.length > 0 ? Math.min(...nums) : null
        break
      }
      case 'MAX': {
        const nums = values.filter((v): v is number => typeof v === 'number' && !Number.isNaN(v))
        row[key] = nums.length > 0 ? Math.max(...nums) : null
        break
      }
    }
  }

  return row
}

/**
 * Resolve a column expression value from a row.
 * Handles:
 * - Simple property refs: "name" → row["name"]
 * - Variable.prop refs: "n.name" → row["name"]
 * - Identifiers: "n" → row["n"]
 * - Star: "*" → special marker
 */
function _resolveExprValue(
  row: QueryRow,
  expr: string,
  _withColAliases?: Array<{ expression: string; alias: string | null }>,
): unknown {
  const trimmed = expr.trim()
  if (trimmed === '*') return row

  // Check withColAliases first (for WITH clause column references)
  if (_withColAliases) {
    for (const wc of _withColAliases) {
      if (wc.alias === trimmed) return row[wc.alias]
    }
  }

  if (trimmed.includes('.')) {
    const parts = trimmed.split('.')
    // Try row[property_name] first
    const propPart = parts[parts.length - 1]
    if (propPart in row) return row[propPart]
    // Fallback: try row[variable] then row[variable.prop]
    if (parts[0] in row) {
      const val = row[parts[0]]
      if (val && typeof val === 'object' && propPart in (val as any)) {
        return (val as any)[propPart]
      }
    }
    return undefined
  }

  // Simple identifier
  return row[trimmed]
}

/**
 * Check whether a column list contains any aggregate expressions.
 */
export function _hasAggregates(colExprs: string[]): boolean {
  return colExprs.some(col => {
    const expr = col.replace(/\s+AS\s+\w+$/i, '').trim()
    return _isAggregateExpression(expr)
  })
}

/**
 * Convert a WITH clause raw columns to column expression strings,
 * detecting aggregates and setting the aggregate flag on the plan.
 *
 * @returns Enhanced columns with aggregate detection
 */
export function _enrichWithAggregates(
  columns: Array<{ expression: string; alias: string | null }>,
): Array<{
  expression: string
  alias: string | null
  isAggregate?: boolean
  aggFn?: string
  distinct?: boolean
  aggField?: string
}> {
  return columns.map(col => {
    const agg = _parseAggregate(col.expression)
    if (agg) {
      return {
        ...col,
        isAggregate: true,
        aggFn: agg.fn,
        distinct: agg.distinct,
        aggField: agg.field,
      }
    }
    return { ...col, isAggregate: false }
  })
}

// ── 独立查询执行器（测试用） ──────────────────────────────

/**
 * Result of a query execution — a list of flat rows.
 */
export type QueryResult = QueryRow[]

/**
 * Standalone query execution for aggregation testing.
 * Executes a parsed QueryPlan against supplied in-memory node data,
 * supporting MATCH, OPTIONAL MATCH, WITH (including aggregation),
 * and RETURN (including aggregation).
 *
 * This is a test-focused execution layer that doesn't require a
 * full GraphEngine. It operates on a simple list of node records.
 *
 * @param plan - The parsed QueryPlan
 * @param nodes - In-memory node records to query against
 * @returns QueryResult rows
 */
/**
 * Resolve a property expression like "n.age" or "age" or "n" against a node record.
 * Node records have flat keys (e.g., "age", "name", "id"), or they may have a "props" sub-object.
 *
 * Returns the resolved value, or undefined if not found.
 */
function _resolveProperty(node: Record<string, unknown>, expr: string): unknown {
  // Handle dotted expressions like "n.age" → look for "age" key
  let key = expr
  if (expr.includes('.')) {
    key = expr.split('.').pop()!
  }

  // Direct key match
  if (key in node) return node[key]

  // Match against "name" field
  if (key === 'name' && 'name' in node) return node.name

  // Check "props" sub-object
  const props = (node as any).props
  if (props && typeof props === 'object' && key in props) {
    return props[key]
  }

  // If expr is just a variable name (like "n"), return the entire node
  if (!expr.includes('.') && !(key in node)) {
    return node
  }

  return undefined
}

/**
 * 执行 MERGE 操作，支持 ON CREATE SET 和 ON MATCH SET 条件写。
 *
 * MERGE 语义：
 * 1. 尝试匹配现有节点（按 label + props）
 * 2. 匹配成功 → 执行 ON MATCH SET（如果提供）
 * 3. 匹配失败 → 创建新节点并执行 ON CREATE SET（如果提供）
 *
 * @param plan - MERGE QueryPlan
 * @param nodes - 现存节点列表（会被修改：匹配时更新，未匹配时追加新节点）
 * @returns 匹配或创建后的节点行
 */
function _executeMerge(
  plan: QueryPlan,
  nodes: Array<Record<string, unknown>>,
): QueryResult {
  const mergeNodes = plan.mergeNodes!
  const rows: QueryRow[] = []

  for (const mergeNode of mergeNodes) {
    // Resolve props from PEG AST to plain values
    const resolvedProps: Record<string, unknown> = {}
    if (mergeNode.props) {
      for (const [key, val] of Object.entries(mergeNode.props)) {
        resolvedProps[key] = _resolvePegValue(val)
      }
    }

    // Step 1: Try to match existing node by label + props
    let matched: Record<string, unknown> | null = null
    let matchedIndex = -1

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      let matches = true

      // Check label
      if (mergeNode.label) {
        const nodeLabel = node['_label'] as string | undefined
        if (nodeLabel !== undefined && nodeLabel !== mergeNode.label) {
          matches = false
        }
      }

      // Check properties (all must match)
      if (matches && mergeNode.props) {
        for (const [key, val] of Object.entries(resolvedProps)) {
          const nodeVal = node[key]
          if (nodeVal !== val) {
            matches = false
            break
          }
        }
      }

      if (matches) {
        matched = node
        matchedIndex = i
        break
      }
    }

    if (matched) {
      // MATCHED — apply ON MATCH SET
      if (plan.mergeOnMatch && plan.mergeOnMatch.length > 0) {
        for (const clause of plan.mergeOnMatch) {
          // clause.property is just the property name (e.g., 'x'), not 'n.x'
          nodes[matchedIndex][clause.property] = clause.value
        }
      }
      rows.push({ ...nodes[matchedIndex] })
    } else {
      // NOT MATCHED — create new node
      const newNode: Record<string, unknown> = {}

      // Set type/label
      if (mergeNode.label) {
        newNode['_label'] = mergeNode.label
      }

      // Set merge props (resolved)
      if (mergeNode.props) {
        for (const [key, val] of Object.entries(resolvedProps)) {
          newNode[key] = val
        }
      }

      // Apply ON CREATE SET
      if (plan.mergeOnCreate && plan.mergeOnCreate.length > 0) {
        for (const clause of plan.mergeOnCreate) {
          // clause.property is just the property name
          newNode[clause.property] = clause.value
        }
      }

      nodes.push(newNode)
      rows.push({ ...newNode })
    }
  }

  return rows
}

/**
 * 对单个候选行执行 MERGE，支持属性值中的变量引用。
 * 用于 UNWIND + MERGE 场景。
 */
function _executeMergeOnCandidate(
  plan: QueryPlan,
  mergeNode: NonNullable<QueryPlan['mergeNodes']>[number],
  nodes: Array<Record<string, unknown>>,
  context: Record<string, unknown>,
): QueryRow[] {
  const rows: QueryRow[] = []

  // Resolve props, substituting variable references from the context
  const resolvedProps: Record<string, unknown> = {}
  if (mergeNode.props) {
    for (const [key, val] of Object.entries(mergeNode.props)) {
      // Resolve PEG values and substitute variables from context
      const rawVal = _resolvePegValue(val)
      if (typeof rawVal === 'string' && rawVal in context) {
        // Variable reference: substitute with context value
        resolvedProps[key] = context[rawVal]
      } else {
        resolvedProps[key] = rawVal
      }
    }
  }

  // Step 1: Try to match existing node by label + props
  let matched: Record<string, unknown> | null = null
  let matchedIndex = -1

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    let matches = true

    // Check label
    if (mergeNode.label) {
      const nodeLabel = node['_label'] as string | undefined
      if (nodeLabel !== undefined && nodeLabel !== mergeNode.label) {
        matches = false
      }
    }

    // Check properties (all must match) — use already resolved props
    if (matches && mergeNode.props) {
      for (const [key, val] of Object.entries(resolvedProps)) {
        const nodeVal = node[key]
        if (nodeVal !== val) {
          matches = false
          break
        }
      }
    }

    if (matches) {
      matched = node
      matchedIndex = i
      break
    }
  }

  if (matched) {
    // MATCHED — apply ON MATCH SET
    if (plan.mergeOnMatch && plan.mergeOnMatch.length > 0) {
      for (const clause of plan.mergeOnMatch) {
        nodes[matchedIndex][clause.property] = clause.value
      }
    }
    rows.push({ ...nodes[matchedIndex] })
  } else {
    // NOT MATCHED — create new node
    const newNode: Record<string, unknown> = {}

    if (mergeNode.label) {
      newNode['_label'] = mergeNode.label
    }

    if (mergeNode.props) {
      for (const [key, val] of Object.entries(resolvedProps)) {
        newNode[key] = val
      }
    }

    // Apply ON CREATE SET
    if (plan.mergeOnCreate && plan.mergeOnCreate.length > 0) {
      for (const clause of plan.mergeOnCreate) {
        newNode[clause.property] = clause.value
      }
    }

    nodes.push(newNode)
    rows.push({ ...newNode })
  }

  return rows
}

/**
 * 将 PEG AST 值格式解析为普通 JavaScript 值。
 * PEG AST: { type: 'NUMBER', value: 1 } → 1
 * 如果是普通值则原样返回。
 */
function _resolvePegValue(val: unknown): unknown {
  if (val && typeof val === 'object' && 'type' in (val as object) && 'value' in (val as object)) {
    const astVal = val as { type: string; value: unknown }
    return astVal.value
  }
  return val
}

/**
 * 构建目标节点 ID 集合，用于 DETACH DELETE 的边清理。
 *
 * 候选行可能是以下两种形式之一：
 * 1. { n: nodeObj } — 有边遍历的 MATCH（如 MATCH (a)-[:EDGE]->(b)）
 * 2. nodeObj — 简单 MATCH（如 MATCH (n:Label) 无遍历）
 */
function _buildTargetNodeIds(candidate: Record<string, unknown>, targetAliases: Set<string>): Set<string> {
  const ids = new Set<string>()
  for (const alias of targetAliases) {
    const nodeObj = _resolveDeleteTarget(candidate, alias)
    if (nodeObj && typeof nodeObj === 'object' && (nodeObj as any)._id) {
      ids.add(String((nodeObj as any)._id))
    }
  }
  return ids
}

/**
 * 从候选行中解析出目标节点对象。
 *
 * 处理两种候选形式：
 * 1. { n: nodeObj } — 候选行是一个对象，节点绑定在别名 key 下
 * 2. candidate 本身就是 nodeObj — 简单 MATCH，候选行即是节点对象
 */
function _resolveDeleteTarget(candidate: Record<string, unknown>, alias: string): unknown {
  // 检查候选行是否有 alias 作为 key
  if (alias in candidate) {
    return candidate[alias]
  }
  // 无 key 匹配时检查候选行自身是否有 _id（简单 MATCH 场景）
  if ((candidate as any)._id !== undefined) {
    return candidate
  }
  return undefined
}

/**
 * 执行 USE graph_name — 切换图命名空间上下文。
 *
 * 在多图场景下，data 可以按图组织（如 { graph1: [...], graph2: [...] }），
 * USE 用于切换到指定图的数据。当前实现返回当前数据作为上下文切换确认，
 * 真正的图存储切换由 multi-engine 层处理。
 *
 * @param name - 图名称
 * @param data - 当前节点数据
 * @returns 当前数据（执行成功）
 */
function _executeUse(name: string, data: Array<Record<string, unknown>>): QueryResult {
  return data
}

// ═══════════════════════════════════════════════════════════════
// GraphEngine 原生执行器（替换 daemon HTTP IPC + 手写执行逻辑）
// ═══════════════════════════════════════════════════════════════

/** 从 orderBy 中提取字段名，去除节点前缀 */
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

/**
 * 后处理：ORDER BY → HAVING
 * 注：GE 的 _executeQueryPlan 已处理 MATCH/WHERE/聚合/列投影/GROUP BY/SKIP/LIMIT，
 * 但 ORDER BY 和 HAVING 需要在此补完。
 */
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

  // 纯 RETURN 字面量（无 MATCH 无 steps）——不经过 GraphEngine
  if (!plan.scanLabel && !plan.steps?.length && !plan.aggregate && !plan.hasMatch) {
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

    // ── 插入节点 ──
    if (nodes?.length) {
      for (let i = 0; i < nodes.length; i++) {
        const item = nodes[i]
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

      // 如果 returnColumns 是 ['n']（RETURN n），包装为 {n: {props}}
      if (plan.returnColumns?.length === 1 && plan.returnColumns[0] === 'n' && !plan.aggregate) {
        return { n: row } as any
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
  // 所有查询统一走 GraphEngine
  return _executeViaGraphEngine(plan, nodes)
}
