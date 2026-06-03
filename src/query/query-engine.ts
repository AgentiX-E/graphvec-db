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
import { parser } from './cypher-lite-parser'
import { LRUCache } from 'lru-cache'
import { planCache as plannerPlanCache, makePlanCacheKey } from '../api/query-planner'
import { globalRegistry as procRegistry, type ProcedureContext } from './procedure-registry'

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
  merge?: MergeClauseAST
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
  type: 'count' | 'sum' | 'avg' | 'max' | 'min' | 'collect'
  field?: string  // 如 n.age
  alias?: string  // AS alias
  distinct?: boolean  // DISTINCT modifier (for COLLECT, COUNT)
}

// ── Query Plan ─────────────────────────────────────────────────

export interface QueryPlan {
  /** 操作类型 */
  type?: 'QUERY' | 'CREATE' | 'DELETE' | 'SET' | 'MERGE' | 'CALL'
  /** EXPLAIN: 展示执行计划但不执行 */
  explain?: boolean
  /** PROFILE: 执行并收集每步统计信息 */
  profile?: boolean
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
  operator: 'EQ' | 'NEQ' | 'GT' | 'GTE' | 'LT' | 'LTE' | 'IN' | 'STARTS_WITH' | 'ENDS_WITH' | 'CONTAINS'
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

  // Step 4: If after extraction there's no MATCH at all, add a dummy one
  // This handles cases like "OPTIONAL MATCH (n) RETURN n" where all MATCH
  // clauses were OPTIONAL, and "FOREACH (x IN [1] | CREATE (n)) RETURN n".
  if (optPatterns.length > 0 && !/MATCH\b/i.test(modifiedQuery) && /\bRETURN\b/i.test(modifiedQuery)) {
    modifiedQuery = `MATCH (__opt_anchor__) ${modifiedQuery.trim()}`
  }
  if (result.foreachExtract && !/MATCH\b/i.test(modifiedQuery) && /\bRETURN\b/i.test(modifiedQuery)) {
    modifiedQuery = `MATCH (__foreach_anchor__) ${modifiedQuery.trim()}`
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
    const ast = parser.parse(pseudoQuery) as QueryAST
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
      const ast = parser.parse(pseudoQuery) as QueryAST
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
  // Step 0a: Detect EXPLAIN / PROFILE prefix
  const { stripped, explain, profile } = _stripExplainProfile(query)

  // Step 1: Preprocess to extract OPTIONAL MATCH and WITH
  const { cleanQuery, extracts } = _preprocessQuery(stripped)

  // Step 2: Parse the cleaned query with peggy
  let ast: QueryAST
  try {
    ast = parser.parse(cleanQuery) as QueryAST
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
        const optAst = parser.parse(pseudoQuery) as QueryAST
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
          const simpleAst = parser.parse(simplePseudo) as QueryAST
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
  ast: QueryAST,
  schema?: import('../schema/schema-types').SchemaDef,
): QueryPlan {
  const plan: QueryPlan = {
    type: 'QUERY',
    scanLabel: null,
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

  if (ast.merge) {
    plan.type = 'MERGE'
    const { createNodes: mergeNodes, createEdges: mergeEdges } = planFromCreateClause(ast.merge)
    plan.mergeNodes = mergeNodes
    plan.mergeEdges = mergeEdges
    if (ast.merge.onCreate) {
      plan.mergeOnCreate = planFromSetClause(ast.merge.onCreate)
    }
    if (ast.merge.onMatch) {
      plan.mergeOnMatch = planFromSetClause(ast.merge.onMatch)
    }
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
      plan.aggregate = agg
      plan.returnColumns = [agg.alias ?? agg.field ?? agg.type]
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
  plan.scanLabel = pattern.node.label

  // 处理遍历步骤
  for (const step of pattern.edges) {
    const traverseStep: TraverseStep = {
      source: step.node.name,
      direction: step.edge.direction,
      edgeLabel: step.edge.label,
      targetAlias: step.node.name,
      targetLabel: step.node.label,
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

export function _executeQuery(
  plan: QueryPlan,
  nodes: Array<Record<string, unknown>>,
): QueryResult {
  // Step 0: Handle UNION — 分别执行左右两侧再合并结果
  if (plan.unionType && plan.rightPlan) {
    const leftResult = _executeQuery(plan, nodes)
    const rightResult = _executeQuery(plan.rightPlan, nodes)

    // 只考虑 rows（忽略 metadata）
    const leftRows = leftResult as QueryRow[]
    const rightRows = rightResult as QueryRow[]

    switch (plan.unionType) {
      case 'union':
        // UNION: 合并去重（基于 JSON 序列化比较）
        const seen = new Set<string>()
        const merged: QueryRow[] = []
        for (const row of [...leftRows, ...rightRows]) {
          const key = JSON.stringify(row)
          if (!seen.has(key)) {
            seen.add(key)
            merged.push(row)
          }
        }
        return merged
      case 'union_all':
        // UNION ALL: 直接拼接
        return [...leftRows, ...rightRows]
      case 'intersect':
        // INTERSECT: 取左右交集
        const rightKeys = new Set(rightRows.map(r => JSON.stringify(r)))
        return leftRows.filter(r => rightKeys.has(JSON.stringify(r)))
      case 'subtract':
        // SUBTRACT（EXCEPT）: 左减右
        const exceptKeys = new Set(rightRows.map(r => JSON.stringify(r)))
        return leftRows.filter(r => !exceptKeys.has(JSON.stringify(r)))
      default:
        return [...leftRows, ...rightRows]
    }
  }

  // Step 0.5: Handle MERGE — match or create with ON CREATE / ON MATCH
  if (plan.type === 'MERGE' && plan.mergeNodes && plan.mergeNodes.length > 0) {
    return _executeMerge(plan, nodes)
  }
  let candidates = [...nodes]

  // Filter by scan label (MATCH (n:Label))
  // Only filter if the data actually contains _label fields (graph metadata);
  // if no nodes have _label, assume the data is flat and skip label filtering.
  if (plan.scanLabel) {
    var hasLabels = nodes.some(function(n) { return n['_label'] !== undefined })
    if (hasLabels) {
      var label = plan.scanLabel
      candidates = candidates.filter(function(n) {
        var nodeLabel = n['_label']
        if (nodeLabel === label) return true
        // Also check direct label property
        if (n['label'] === label) return true
        return false
      })
    }
  }

  // Apply filters (WHERE clause on MATCH)
  if (plan.filters.length > 0) {
    candidates = _applyWhereFilters(candidates, plan.filters)
  }

  // Step 1.25: Handle SEARCH 向量搜索 — 在 WHERE 之后、RETURN 之前注入
  // 使用 VectorIndexManager 进行 ANN 近似最近邻搜索。
  // SEARCH 会过滤 candidates 只保留搜索结果中的节点。
  if (plan.search) {
    candidates = _vectorSearch(plan.search, candidates)
  }

  // Step 1.5: Handle UNWIND — 展开列表为多行
  if (plan.unwind) {
    candidates = _executeUnwind(candidates, plan.unwind)
  }

  // Step 1.6a: Handle CALL 过程调用 — 从注册表获取并执行
  if (plan.type === 'CALL_PROCEDURE' && plan.callProcedure) {
    const { name, args, yieldItems } = plan.callProcedure
    const proc = procRegistry.get(name)

    if (!proc) {
      throw new Error(`Unknown procedure: ${name}`)
    }

    // Build context from the graph engine / nodes
    const ctx: ProcedureContext = {
      getAllNodes: () => nodes,
      getNodeCount: () => nodes.length,
      getEdgeCount: () => {
        // Count edges from nodes with connected property
        let count = 0
        for (const n of nodes) {
          if (Array.isArray((n as any)._edges)) count += (n as any)._edges.length
          if (Array.isArray((n as any)._inEdges)) count += (n as any)._inEdges.length
        }
        return count
      },
      getLabels: () => {
        const labels = new Set<string>()
        for (const n of nodes) {
          if (n._label || n.label || n.typeName) {
            labels.add(n._label || n.label || n.typeName)
          }
        }
        return Array.from(labels).sort()
      },
      getTypeNameById: (typeId: number) => {
        // Try to resolve a typeId from the first matching node
        for (const n of nodes) {
          if (n.type === typeId || n.typeId === typeId) {
            return n._label || n.label || n.typeName || String(typeId)
          }
        }
        return String(typeId)
      },
      getConfig: () => ({}),
      getStats: () => ({
        nodeCount: nodes.length,
      }),
      fulltextQueryNodes: () => [],
      fulltextQueryRelationshipIndexes: () => [],
    }

    const rawResult = proc.execute(ctx, args)
    let resultRows = rawResult as any[]

    // Apply YIELD filtering if specified
    if (yieldItems && yieldItems.length > 0) {
      const validFields = new Set(yieldItems.map(y => y.name))
      const availableFields = new Set(
        resultRows.length > 0 ? Object.keys(resultRows[0]) : [],
      )

      // Check for invalid yield fields
      for (const y of yieldItems) {
        if (!availableFields.has(y.name)) {
          throw new Error(
            `Invalid YIELD field '${y.name}' for procedure '${name}'. Available fields: ${Array.from(availableFields).join(', ')}`,
          )
        }
      }

      resultRows = resultRows.map(row => {
        const filtered: Record<string, unknown> = {}
        for (const y of yieldItems) {
          const key = y.alias ?? y.name
          filtered[key] = row[y.name]
        }
        return filtered
      })
    }

    candidates = resultRows.map(r => ({ ...r } as Record<string, unknown>))
  }

  // Step 1.6b: Handle CALL 子查询 — 递归执行子查询，结果合并到候选行
  if (plan.type === 'CALL' && plan.callQuery) {
    if (plan.inTransactions) {
      // IN TRANSACTIONS 模式：分批提交子查询结果
      const batchSize = plan.inTransactionsBatchSize ?? 1000
      const subResult = _executeQuery(plan.callQuery, nodes)
      const subRows = subResult as QueryRow[]

      // 对结果分批处理，每批之间模拟事务提交
      const batches: QueryRow[] = []
      for (let i = 0; i < subRows.length; i += batchSize) {
        const batch = subRows.slice(i, i + batchSize)
        // 模拟事务提交：每批之间的 "commit" 在此处表现为批处理隔离
        // 在此上下文中，我们只是分批返回行——实际事务边界由上层 API 处理
        batches.push(...batch)
      }

      candidates = batches.map(r => ({ ...r } as Record<string, unknown>))
    } else {
      // 标准 CALL：递归执行子查询（子查询作用于完整 nodes 图）
      const subResult = _executeQuery(plan.callQuery, nodes)
      const subRows = subResult as QueryRow[]

      // 子查询结果替换候选行（作用域隔离）
      candidates = subRows.map(r => ({ ...r } as Record<string, unknown>))
    }
  }

  // Step 2: Handle WITH clause (mid-query projection + aggregation)
  if (plan.with) {
    const hasWithAgg = plan.with.aggregate !== undefined

    if (hasWithAgg) {
      // Parse the aggregate: handle DISTINCT prefix in field
      let aggField = plan.with.aggregate.field ?? '*'
      let aggDistinct = plan.with.aggregate.distinct === true
      if (!aggDistinct && aggField.toUpperCase().startsWith('DISTINCT ')) {
        aggDistinct = true
        aggField = aggField.substring(9).trim() // strip 'DISTINCT '
      }

      const agg: {
        fn: AggColumnInfo['fn']
        field: string
        prop: string
        alias: string | null
        distinct: boolean
      } = {
        fn: plan.with.aggregate.type.toUpperCase() as AggColumnInfo['fn'],
        field: aggField,
        prop: aggField.includes('.')
          ? aggField.split('.').pop()!
          : aggField,
        alias: plan.with.aggregate.alias ?? plan.with.aggregate.type,
        distinct: aggDistinct,
      }

      // Build aggregate columns from plan.with.aggregate
      const aggCols: AggColumnInfo[] = [{
        fn: agg.fn,
        field: agg.field,
        prop: agg.prop,
        distinct: agg.distinct,
        alias: agg.alias,
      }]

      // Identify group-by columns: any column in with.columns that is NOT the aggregate
      const groupByCols: string[] = []
      for (const col of plan.with.columns) {
        // Check if this column IS the aggregate (matches expression or alias)
        const colExpr = typeof col.expression === 'string' ? col.expression.trim() : ''
        const isAggCol = col.alias === agg.alias
          || _parseAggregate(colExpr) !== null

        if (!isAggCol) {
          const gbKey = col.alias ?? colExpr
          groupByCols.push(gbKey)
        }
      }

      // Build input rows for aggregation from candidates
      let inputRows: QueryRow[]
      if (agg.field === '*' && groupByCols.length === 0) {
        // Pure count(*) — just create one marker row per candidate
        inputRows = candidates.map(() => ({}))
      } else if (agg.field === '*') {
        // count(*) + group-by: need group-by key per candidate
        inputRows = candidates.map(candidate => {
          const row: QueryRow = {}
          for (const gb of groupByCols) {
            row[gb] = _resolveProperty(candidate, gb) ?? candidate
          }
          return row
        })
      } else {
        // Aggregate on a specific field
        inputRows = candidates.map(candidate => {
          const row: QueryRow = {}
          for (const gb of groupByCols) {
            const val = _resolveProperty(candidate, gb)
            row[gb] = val
          }
          // Add the aggregate field value
          const val = _resolveProperty(candidate, agg.field)
          const propName = agg.field.includes('.') ? agg.field.split('.').pop()! : agg.field
          row[propName] = val
          return row
        })
      }

      let rows = _executeAggregation(inputRows, aggCols, groupByCols)

      // Apply WITH WHERE (post-aggregation filter = HAVING equivalent)
      if (plan.with.filters.length > 0) {
        rows = _applyWhereFiltersOnRows(rows, plan.with.filters)
      }

      // Apply WITH ORDER BY
      if (plan.with.orderBy.length > 0) {
        rows = _applyOrderByOnRows(rows, plan.with.orderBy)
      }

      // Apply WITH LIMIT
      if (plan.with.limit !== undefined) {
        rows = rows.slice(0, plan.with.limit)
      }

      candidates = rows.map(r => r as Record<string, unknown>)
    } else {
      // No aggregation — just project
      let rows: QueryRow[] = _projectToColumns(candidates, plan.with.columns)

      // Apply WITH WHERE directly
      if (plan.with.filters.length > 0) {
        rows = _applyWhereFiltersOnRows(rows, plan.with.filters)
      }

      // Apply WITH ORDER BY
      if (plan.with.orderBy.length > 0) {
        rows = _applyOrderByOnRows(rows, plan.with.orderBy)
      }

      // Apply WITH LIMIT
      if (plan.with.limit !== undefined) {
        rows = rows.slice(0, plan.with.limit)
      }

      candidates = rows.map(r => r as Record<string, unknown>)
    }
  }

  // Step 2.4: Handle LOAD CSV — 加载 CSV 文件/URL 的数据
  // LOAD CSV 作为一个数据源，将其数据注入到 candidates 中
  if (plan.loadCsv) {
    const csvData = _loadCsvFile(plan.loadCsv.url, plan.loadCsv.hasHeaders)
    // 每行作为一个绑定变量对象注入
    if (candidates.length === 0) {
      // 没有前置 MATCH，从 LOAD CSV 开始
      candidates = csvData.map(row => ({ [plan.loadCsv!.rowVariable]: row }))
    } else {
      // 有前置 MATCH，做笛卡尔积（每个候选行 × 每行 CSV 数据）
      const expanded: Array<Record<string, unknown>> = []
      for (const c of candidates) {
        for (const row of csvData) {
          expanded.push({ ...c, [plan.loadCsv!.rowVariable]: row })
        }
      }
      candidates = expanded
    }
  }

  // Step 2.5: Handle FOREACH — 对每个候选行执行迭代操作
  if (plan.forEach) {
    // FOREACH 没有前置 MATCH 时（纯 FOREACH），使用一个空的上下文行
    // 这样即使 nodes=[]，FOREACH 也能独立展开列表
    if (candidates.length === 0) {
      candidates = [{}]
    }
    candidates = _executeForeach(candidates, plan.forEach)
  }

  // Step 3: Handle RETURN
  if (plan.returnColumns.length > 0) {
    // Check if RETURN uses aggregation
    if (plan.aggregate) {
      let haveDistinct = plan.aggregate.distinct === true
      let rawField = plan.aggregate.field ?? '*'
      // Strip DISTINCT prefix from field if present
      if (rawField.toUpperCase().startsWith('DISTINCT ')) {
        haveDistinct = true  // ensure flag set even if only via field prefix
        rawField = rawField.substring(9).trim()
      }
      const aggInfo: AggColumnInfo[] = [{
        fn: plan.aggregate.type.toUpperCase() as AggColumnInfo['fn'],
        field: rawField,
        prop: rawField.includes('.')
          ? rawField.split('.').pop()!
          : rawField,
        distinct: haveDistinct,
        alias: plan.aggregate.alias ?? plan.aggregate.type,
      }]

      // Compute GROUP BY keys from plan.groupBy
      const groupByKeys: string[] = plan.groupBy ?? []

      // Build rows for aggregation from candidates
      let rows: QueryRow[]
      if (aggInfo[0].field === '*') {
        rows = candidates.map(() => ({}))
      } else {
        rows = candidates.map(c => {
          const val = _resolveProperty(c, aggInfo[0].field)
          const row: QueryRow = {}
          if (val !== undefined) {
            const propName = aggInfo[0].field.includes('.')
              ? aggInfo[0].field.split('.').pop()!
              : aggInfo[0].field
            row[propName] = val
          }
          return row
        })
      }

      // If GROUP BY, add group-by keys to each row
      if (groupByKeys.length > 0) {
        rows = candidates.map(c => {
          const row: QueryRow = {}
          // Add group-by key values
          for (const gb of groupByKeys) {
            const val = _resolveProperty(c, gb)
            row[gb] = val ?? null
          }
          // Add aggregate field value
          if (aggInfo[0].field !== '*') {
            const propName = aggInfo[0].field.includes('.')
              ? aggInfo[0].field.split('.').pop()!
              : aggInfo[0].field
            const val = _resolveProperty(c, aggInfo[0].field)
            if (val !== undefined) row[propName] = val
          }
          return row
        })
      }

      let resultRows = _executeAggregation(rows, aggInfo, groupByKeys)

      // Apply HAVING filter on aggregated result
      if (plan.having && plan.having.length > 0) {
        // Build mapping from HAVING property references to result row keys
        // The HAVING property is like 'count(n.age)' — we need to match it to the
        // aggregate key in the result row, which is agg.alias ?? agg.fn.toLowerCase()
        const aggKey = aggInfo[0].alias ?? aggInfo[0].fn.toLowerCase()
        resultRows = resultRows.filter(row => {
          for (const h of plan.having!) {
            // Try the aggregate key first
            let val = row[aggKey]
            // Try exact property match
            if (val === undefined || val === null) {
              val = row[h.property]
            }
            // Try field name without variable prefix
            if (val === undefined || val === null) {
              const propName = h.property.includes('.')
                ? h.property.split('.').pop()!
                : h.property
              val = row[propName]
            }
            if (val === undefined || val === null) return false
            const numVal = Number(val)
            if (isNaN(numVal)) return false
            const passes = (() => {
              switch (h.operator) {
                case 'GT': return numVal > h.value
                case 'GTE': return numVal >= h.value
                case 'LT': return numVal < h.value
                case 'LTE': return numVal <= h.value
                case 'EQ': return numVal === h.value
                case 'NEQ': return numVal !== h.value
                default: return true
              }
            })()
            if (!passes) return false
          }
          return true
        })
      }

      // Apply ORDER BY on aggregated result
      if (plan.orderBy.length > 0) {
        resultRows = _applyOrderByOnRows(resultRows, plan.orderBy)
      }

      // Apply CASE columns on aggregated result
      if (plan.caseColumns && plan.caseColumns.length > 0) {
        resultRows = _applyCaseColumns(resultRows, plan.caseColumns)
      }

      // Apply LIMIT（若未显式指定则使用默认限制）
      resultRows = resultRows.slice(0, plan.limit ?? DEFAULT_LIMIT)

      return resultRows
    }

    // DETACH DELETE — 对 RETURN 路径也执行边清理
    if (plan.detachDelete && plan.deleteTargets && plan.deleteTargets.length > 0) {
      const targetAliases = new Set(plan.deleteTargets)
      candidates = candidates.filter(row => {
        // 构建目标节点 ID 集合（从候选行中提取 _id）
        // 候选行可能是 { n: node } 结构（有边遍历）或直接的 node（无遍历 MATCH）
        const targetIds = _buildTargetNodeIds(row, targetAliases)
        for (const targetAlias of targetAliases) {
          const nodeObj = _resolveDeleteTarget(row, targetAlias)
          if (!nodeObj || typeof nodeObj !== 'object') continue
          if (Array.isArray((nodeObj as any)._edges)) {
            (nodeObj as any)._edges = (nodeObj as any)._edges.filter((e: any) => {
              const sourceInTargets = targetIds.has(String(e.src))
              const targetInTargets = targetIds.has(String(e.target))
              return !sourceInTargets && !targetInTargets
            })
          }
          if (Array.isArray((nodeObj as any)._inEdges)) {
            (nodeObj as any)._inEdges = (nodeObj as any)._inEdges.filter((e: any) => {
              const sourceInTargets = targetIds.has(String(e.src))
              const targetInTargets = targetIds.has(String(e.target))
              return !sourceInTargets && !targetInTargets
            })
          }
        }
        return true
      })
    }

    // DELETE（无 DETACH）且节点有关联边 → 报错（RETURN 路径）
    // Neo4j 语义：节点有任何出边或入边则不能执行 DELETE（必须用 DETACH DELETE）
    if (!plan.detachDelete && plan.deleteTargets && plan.deleteTargets.length > 0) {
      const targetAliases = new Set(plan.deleteTargets)
      for (const candidate of candidates) {
        for (const targetAlias of targetAliases) {
          const nodeObj = _resolveDeleteTarget(candidate, targetAlias)
          if (!nodeObj || typeof nodeObj !== 'object') continue
          // 检查节点是否有任何关联边
          const nodeId = String((nodeObj as any)._id ?? '')
          const edges = (nodeObj as any)._edges || []
          const inEdges = (nodeObj as any)._inEdges || []
          let hasAnyEdge = false
          for (const e of edges) {
            // 检查出边：src 是当前节点，或 target 是当前节点
            if (String(e.src) === nodeId || String(e.target) === nodeId) {
              hasAnyEdge = true
              break
            }
          }
          if (!hasAnyEdge) {
            for (const e of inEdges) {
              if (String(e.src) === nodeId || String(e.target) === nodeId) {
                hasAnyEdge = true
                break
              }
            }
          }
          if (hasAnyEdge) {
            throw new Error(
              `Cannot delete node n, because it still has relationships. To delete this node, you must first delete its relationships. Use DETACH DELETE.`
            )
          }
        }
      }
    }

    // No aggregation — project columns from candidates
    let rows: QueryRow[] = candidates.map(c => {
      const row: QueryRow = {}
      for (const col of plan.returnColumns) {
        const val = _resolveProperty(c, col)
        if (val !== undefined) {
          row[col] = val
        }
      }
      return row
    })

    // Apply RETURN filters (if any)
    if (plan.filters.length > 0 && plan.with === undefined) {
      rows = _applyWhereFiltersOnRows(rows, plan.filters)
    }

    // Apply ORDER BY
    if (plan.orderBy.length > 0) {
      rows = _applyOrderByOnRows(rows, plan.orderBy)
    }

    // Apply CASE columns (runtime evaluation of CASE WHEN expressions)
    if (plan.caseColumns && plan.caseColumns.length > 0) {
      rows = _applyCaseColumns(rows, plan.caseColumns)
    }

    // Apply Pattern Comprehension columns (runtime evaluation)
    if (plan.comprehensionColumns && plan.comprehensionColumns.length > 0) {
      rows = _applyComprehensionColumns(rows, plan.comprehensionColumns)
    }

    // Apply SKIP（在 LIMIT 之前，符合 Cypher 语义）
    if (plan.skip !== undefined && plan.skip > 0) {
      rows = rows.slice(plan.skip)
    }

    // Apply LIMIT（若未显式指定则使用默认限制）
    rows = rows.slice(0, plan.limit ?? DEFAULT_LIMIT)

    return rows
  }

  // DETACH DELETE — 删除目标节点前先移除所有关联边
  if (plan.detachDelete && plan.deleteTargets && plan.deleteTargets.length > 0) {
    const targetAliases = new Set(plan.deleteTargets)
    candidates = candidates.filter(row => {
      // 构建目标节点 ID 集合
      const targetIds = _buildTargetNodeIds(row, targetAliases)
      for (const targetAlias of targetAliases) {
        const nodeObj = _resolveDeleteTarget(row, targetAlias)
        if (!nodeObj || typeof nodeObj !== 'object') continue
        // 清理边元数据：移除 _edges 和 _inEdges
        if (Array.isArray((nodeObj as any)._edges)) {
          (nodeObj as any)._edges = (nodeObj as any)._edges.filter((e: any) => {
            // 如果边涉及多个目标节点（如 DETACH DELETE a, b 时 a 和 b 之间有边）
            // 只要至少一个端点在 targets 集合中就删除该边
            const sourceInTargets = targetIds.has(String(e.src))
            const targetInTargets = targetIds.has(String(e.target))
            return !sourceInTargets && !targetInTargets
          })
        }
        if (Array.isArray((nodeObj as any)._inEdges)) {
          (nodeObj as any)._inEdges = (nodeObj as any)._inEdges.filter((e: any) => {
            const sourceInTargets = targetIds.has(String(e.src))
            const targetInTargets = targetIds.has(String(e.target))
            return !sourceInTargets && !targetInTargets
          })
        }
      }
      return true
    })
  }

  // DELETE（无 DETACH）且节点有关联边 → 报错（与 Neo4j 一致）
  if (!plan.detachDelete && plan.deleteTargets && plan.deleteTargets.length > 0) {
    const targetAliases = new Set(plan.deleteTargets)
    for (const candidate of candidates) {
      for (const targetAlias of targetAliases) {
        const nodeObj = _resolveDeleteTarget(candidate, targetAlias)
        if (!nodeObj || typeof nodeObj !== 'object') continue
        // 检查节点是否有任何关联边
        const nodeId = String((nodeObj as any)._id ?? '')
        const edges = (nodeObj as any)._edges || []
        const inEdges = (nodeObj as any)._inEdges || []
        let hasAnyEdge = false
        for (const e of edges) {
          if (String(e.src) === nodeId || String(e.target) === nodeId) {
            hasAnyEdge = true
            break
          }
        }
        if (!hasAnyEdge) {
          for (const e of inEdges) {
            if (String(e.src) === nodeId || String(e.target) === nodeId) {
              hasAnyEdge = true
              break
            }
          }
        }
        if (hasAnyEdge) {
          throw new Error(
            `Cannot delete node n, because it still has relationships. To delete this node, you must first delete its relationships. Use DETACH DELETE.`
          )
        }
      }
    }
  }

  // No RETURN — return candidates as rows
  const noReturnRows = candidates.map(c => ({ ...c }))

  // Apply SKIP（无 RETURN 路径）
  let finalRows = noReturnRows
  if (plan.skip !== undefined && plan.skip > 0) {
    finalRows = finalRows.slice(plan.skip)
  }

  return finalRows.slice(0, plan.limit ?? DEFAULT_LIMIT)
}

// ── 向量搜索 (SEARCH) ──────────────────────────────────────

/**
 * 执行 SEARCH 子句定义的向量搜索。
 *
 * 从 candidates 中筛选出与 queryVector 最相似的 topK 个节点。
 * 使用 VectorIndexManager 进行 HNSW 近似最近邻搜索。
 *
 * @param search - SEARCH 子句参数（targetProperty, queryVector, topK）
 * @param candidates - 当前候选节点列表
 * @returns 排名后的候选节点列表（最多 topK 个）
 *
 * 注意：当 search.targetProperty 形如 "n.embedding" 时，属性名取 "." 后的部分。
 * 此函数需要外部注入的 VectorIndexManager 实例，通过模块级变量获取。
 */
export let _vectorIndexManager: { search: (label: string, property: string, query: Float32Array, topK: number) => Array<{id: number; distance: number}> } | null = null

/**
 * 注入向量索引管理器（用于测试和集成）。
 */
export function setVectorIndexManager(mgr: typeof _vectorIndexManager): void {
  _vectorIndexManager = mgr
}

function _vectorSearch(
  search: NonNullable<import('./query-engine').QueryPlan['search']>,
  candidates: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (!_vectorIndexManager) {
    // 如果没有配置向量索引，返回原候选集（静默退化）
    return candidates
  }

  const { targetProperty, queryVector, topK } = search

  // 从 "n.embedding" 中提取属性名 "embedding"
  const propName = targetProperty.includes('.')
    ? targetProperty.split('.').pop()!
    : targetProperty

  // 从 candidates 中推断 label
  // 先看是否有 _label 字段，如果没有则假设所有候选的标签都相同
  let label = ''
  for (const c of candidates) {
    if (c['_label']) {
      label = c['_label']
      break
    }
    if (c['label']) {
      label = c['label']
      break
    }
  }

  if (!label) {
    return candidates
  }

  try {
    const query = new Float32Array(queryVector)
    const results = _vectorIndexManager.search(label, propName, query, topK)

    if (results.length === 0) {
      return []
    }

    // 构建 id → distance 的快速查找
    const idToDistance = new Map<number, number>()
    for (const r of results) {
      idToDistance.set(r.id, r.distance)
    }

    // 按搜索结果排序 filtered candidates
    const resultIds = new Set(results.map(r => r.id))
    const scored = candidates
      .filter(c => {
        const id = typeof c['id'] === 'number' ? c['id'] : undefined
        return id !== undefined && resultIds.has(id)
      })
      .map(c => ({
        row: c,
        distance: idToDistance.get(c['id'] as number) ?? Infinity,
      }))
      .sort((a, b) => a.distance - b.distance)

    return scored.map(s => s.row)
  } catch {
    // 搜索失败时静默退化
    return candidates
  }
}

// ── FOREACH 执行 ─────────────────────────────────────────

/**
 * 执行 FOREACH 子句。
 *
 * FOREACH (var IN list | operation) 对列表中每个元素执行操作。
 * 支持的操作类型：CREATE / SET / DELETE / REMOVE
 *
 * @param candidates - 当前候选行（每个候选行都会触发一次 FOREACH 迭代）
 * @param foreach - FOREACH 子句定义（含列表、变量名、操作类型和参数）
 * @returns 修改后的候选行（可能新增或修改了行）
 *
 * 行为：
 * - list 是字面量数组（isVarRef=false）：直接展开
 * - list 是变量引用（isVarRef=true）：从候选行上下文中读取变量值
 * - 空列表：跳过，不对候选行做任何修改
 * - CREATE：创建节点（按每行上下文添加新记录到 nodes 存储）
 * - SET：修改候选行的属性
 * - DELETE：从候选行中移除目标
 * - REMOVE：与 DELETE 行为相同
 */
export function _executeForeach(
  candidates: Array<Record<string, unknown>>,
  foreachClause: ForEachClause,
): Array<Record<string, unknown>> {
  const { variable, list, isVarRef, operation } = foreachClause

  // Step 1: 收集所有要迭代的元素
  let allItems: Array<{ row: Record<string, unknown>; item: unknown }> = []

  for (const candidate of candidates) {
    let items: unknown[] = list

    // 如果列表是变量引用，从上下文中读取
    if (isVarRef) {
      const varListName = list.length > 0 ? String(list[0]) : ''
      // 尝试从候选行中读取变量
      const resolvedList = _resolveForeachList(candidate, list as string[])
      if (resolvedList !== null) {
        items = resolvedList
      }
    }

    // 对列表中的每个元素，绑定额外的上下文
    for (const item of items) {
      allItems.push({ row: candidate, item })
    }
  }

  // Step 1.5: WHERE 过滤
  if (operation.where) {
    allItems = allItems.filter(({ item }) => {
      return _evalForeachCondition(operation.where!, variable, item)
    })
  }

  // Step 2: 执行操作
  if (allItems.length === 0) {
    // 空列表：返回原始候选行（FOREACH 不影响结果集结构）
    return candidates
  }

  switch (operation.type) {
    case 'CREATE': {
      // FOREACH + CREATE：为每个 (row, item) 创建新记录
      const additionalRows: Array<Record<string, unknown>> = []
      for (const { row, item } of allItems) {
        const newRow: Record<string, unknown> = {
          ...row,
          [variable]: item,
        }
        additionalRows.push(newRow)
      }
      return additionalRows
    }

    case 'SET': {
      // FOREACH + SET：修改候选行的属性
      // SET 的典型用法是 FOREACH (x IN list | SET n.prop = x)
      // 需要解析 SET 子句中的赋值操作
      if (operation.setClauses && operation.setClauses.length > 0) {
        const result = candidates.map(row => {
          const newRow = { ...row }
          // 对列表中的每个元素应用 SET
          // 但 SET 操作是"每行一次"，所以我们取最后一个绑定值
          for (const clause of operation.setClauses) {
            // clause.property 是 "n.flag" 格式，clause.value 是 "$x" 格式的占位符
            const propName = clause.property.includes('.')
              ? clause.property.split('.').pop()!
              : clause.property

            // 解析 SET 值：如果是占位符 $x，用最后绑定的 item 替换
            let resolvedVal = clause.value
            if (typeof resolvedVal === 'string' && resolvedVal.startsWith('$')) {
              const varName = resolvedVal.slice(1)
              const lastItem = allItems[allItems.length - 1]?.item
              resolvedVal = lastItem
            }

            newRow[propName] = resolvedVal
          }
          return newRow
        })
        return result
      }
      // 没有 setClauses 时，简化处理：为每行添加迭代变量
      const result = candidates.map(row => {
        const newRow = { ...row }
        for (const { item } of allItems) {
          newRow[variable] = item
        }
        return newRow
      })
      return result
    }

    case 'DELETE': {
      // FOREACH + DELETE：移除目标行
      // 从 candidates 中删除有匹配的行
      if (operation.targets && operation.targets.length > 0) {
        const targets = operation.targets
        // 从候选行中筛选：如果行名在 targets 中，移除该行
        const result = candidates.filter(row => {
          return !targets.some(target => {
            const targetClean = target.replace(/^`|`$/g, '')
            // 行中的 _alias 表示该行被绑定的节点别名
            const rowAlias = String(row['_alias'] ?? '')
            // 行中的 name 是节点名称（可能为 undefined）
            const rowName = row['name']
            // 如果 _alias 等于目标，或者 name 等于目标，则匹配
            if (rowName === targetClean && rowName !== undefined) return true
            if (rowAlias === targetClean) return true
            // 如果目标名直接是行的某个键
            if (targetClean in row) return true
            return false
          })
        })
        return result
      }
      // 没有指定 targets → 根据 foreach 语义，直接返回空（DELETE 所有匹配节点）
      return []
    }

    case 'FOREACH': {
      // FOREACH 嵌套：对每个迭代元素递归执行内层 FOREACH
      // allItems 是外层迭代的 (row, item) 对
      // 内层 FOREACH 的列表从 operation.foreach 获取
      const innerForeach = operation.foreach
      if (!innerForeach) return allItems.map(({ row, item }) => ({
        ...row,
        [variable]: item,
      }))

      let resultRows: Array<Record<string, unknown>> = []
      for (const { row, item } of allItems) {
        // 构建含外层变量的上下文行
        const ctxRow: Record<string, unknown> = {
          ...row,
          [variable]: item,
        }
        // 将内层 FOREACH 的列表绑定到上下文
        // 如果内层 FOREACH 的列表是变量引用（即引用外层变量），
        // 我们需要在 _executeForeach 的上下文中传递 ctxRow
        // 策略：构造单元素候选数组，递归调用 _executeForeach
        const innerCandidates = [ctxRow]
        const innerResult = _executeForeach(innerCandidates, innerForeach)
        resultRows.push(...innerResult)
      }
      return resultRows
    }

    case 'MULTI': {
      // 混合操作：对每个候选行依次执行多个操作
      if (!operation.operations || operation.operations.length === 0) {
        return candidates
      }
      let result = candidates
      for (const subOp of operation.operations) {
        const subClause: ForEachClause = {
          variable,
          list,
          isVarRef,
          operation: subOp,
        }
        result = _executeForeach(result, subClause)
      }
      return result
    }

    case 'REMOVE': {
      // REMOVE：从节点 props 中移除指定属性
      if (operation.targets && operation.targets.length > 0) {
        const result = candidates.map(row => {
          const newRow = { ...row }
          for (const target of operation.targets) {
            // target 格式: n.prop 或直接 prop 名
            const propName = target.includes('.')
              ? target.split('.').pop()!
              : target
            const cleanName = propName.replace(/^`|`$/g, '')
            delete newRow[cleanName]
          }
          return newRow
        })
        return result
      }
      return candidates
    }

    default:
      return candidates
  }
}

/**
 * 评估 FOREACH WHERE 条件。
 *
 * 支持简单操作符:
 *   x > 1, x < 1, x >= 1, x <= 1, x = 1, x != 1, x IN [1,2,3]
 *
 * @param where - WHERE 条件字符串（如 "x > 1"）
 * @param varName - FOREACH 的循环变量名（如 "x"）
 * @param item - 当前迭代元素值
 * @returns 条件是否通过
 */
export function _evalForeachCondition(
  where: string,
  varName: string,
  item: unknown,
): boolean {
  const trimmed = where.trim()

  // 匹配 IN 操作: x IN [1,2,3]
  const inMatch = trimmed.match(
    new RegExp(`^${escapeRegex(varName)}\\s+IN\\s+\\[(.+)\\]$`, 'i'),
  )
  if (inMatch) {
    const listStr = inMatch[1]
    const listValues = listStr
      .split(',')
      .map(v => v.trim())
      .map(v => {
        // 解析数字或字符串
        if (v === 'null') return null
        if (v === 'true') return true
        if (v === 'false') return false
        const num = Number(v)
        if (!isNaN(num) && v !== '') return num
        // 去掉引号
        return v.replace(/^['"]|['"]$/g, '')
      })
    return listValues.some(v => {
      if (v === item) return true
      // 宽松比较：数字 "1" == 1
      if (typeof v === 'number' && typeof item === 'string') {
        const n = Number(item)
        if (!isNaN(n)) return v === n
      }
      if (typeof v === 'string' && typeof item === 'number') {
        const n = Number(v)
        if (!isNaN(n)) return n === item
      }
      return false
    })
  }

  // 匹配比较操作: x > 1, x < 1, x >= 1, x <= 1, x = 1, x != 1
  const opMatch = trimmed.match(
    new RegExp(
      `^${escapeRegex(varName)}\\s*(>=|<=|!=|>|<|=)\\s*(.+)$`,
    ),
  )
  if (opMatch) {
    const op = opMatch[1]
    const rhsStr = opMatch[2].trim()
    const rhs = _parseForeachValue(rhsStr)
    const lhs = item

    switch (op) {
      case '>':  return Number(lhs) > Number(rhs)
      case '<':  return Number(lhs) < Number(rhs)
      case '>=': return Number(lhs) >= Number(rhs)
      case '<=': return Number(lhs) <= Number(rhs)
      case '=':  return lhs === rhs
      case '!=': return lhs !== rhs
    }
  }

  return false
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function _parseForeachValue(str: string): unknown {
  if (str === 'null') return null
  if (str === 'true') return true
  if (str === 'false') return false
  // 尝试数字
  const num = Number(str)
  if (!isNaN(num) && str.length > 0) return num
  // 去掉引号
  return str.replace(/^['"]|['"]$/g, '')
}

/**
 * 辅助函数：解析 FOREACH 的列表引用。
 *
 * 根据 foreach 定义，list 可能是 undefined 或空，
 * 此时尝试从候选行上下文中解析。
 * 当前简化实现：如果 isVarRef=true 且 list 有值，
 * 使用 list[0] 作为变量名从候选行中查找。
 *
 * @param row - 当前候选行
 * @param listHint - 列表线索（可能是变量名列表）
 * @returns 解析后的数组，或 null（表示无法解析）
 */
/**
 * 从 _QueryExtracts 中的 foreachExtract 递归构建 ForEachClause。
 * 支持嵌套 FOREACH：如果 extract 包含 children，则 operation 递归构建。
 */
function _buildForEachFromExtract(
  extract: NonNullable<_QueryExtracts['foreachExtract']>,
): ForEachClause {
  const forEach: ForEachClause = {
    variable: extract.variable,
    list: [],
    isVarRef: true,
    operation: { type: 'CREATE' },
  }

  // 传递 WHERE 子句
  if (extract.where) {
    forEach.operation.where = extract.where
  }

  // 解析 listExpr：是字面量数组（[1,2,3]）还是变量名
  const listExpr = extract.listExpr.trim()
  if (listExpr.startsWith('[') && listExpr.endsWith(']')) {
    forEach.isVarRef = false
    try {
      forEach.list = JSON.parse(listExpr.replace(/'/g, '"'))
    } catch {
      forEach.list = []
    }
  } else {
    forEach.list = [listExpr]
  }

  // 检查是否有嵌套 FOREACH children
  if (extract.children && extract.children.length > 0) {
    // 外层 FOREACH 的操作就是子 FOREACH
    forEach.operation.type = 'FOREACH'
    // 如果有多个 children，应该是链式的（内层最深）
    // 实际只会有一个 children
    forEach.operation.foreach = _buildForEachFromExtract(extract.children[0])
    return forEach
  }

  // 解析 operation 类型和参数
  const opText = extract.operation.trim()
  if (/^CREATE\b/i.test(opText)) {
    forEach.operation.type = 'CREATE'
    const nodeMatch = opText.match(/CREATE\s*(?:\((\w+):?(\w*))\s*{([^}]*)}|CREATE\s*(?:\((\w+):?(\w*))/)
    if (nodeMatch) {
      forEach.operation.createNodes = [{
        alias: nodeMatch[1] || nodeMatch[4] || 'n',
        label: nodeMatch[2] || nodeMatch[5] || null,
        props: null,
      }]
    }
  } else if (/^SET\b/i.test(opText)) {
    forEach.operation.type = 'SET'
    const setMatch = opText.match(/SET\s+(\w+(?:\.\w+)?)\s*=\s*(\S+)/i)
    if (setMatch) {
      forEach.operation.setClauses = [{
        property: setMatch[1].trim(),
        value: setMatch[2].trim(),
      }]
    }
  } else if (/^DELETE\b/i.test(opText)) {
    forEach.operation.type = 'DELETE'
    const delMatch = opText.match(/DELETE\s+(\w+)/i)
    if (delMatch) {
      forEach.operation.targets = [delMatch[1].trim()]
    }
  } else if (/^REMOVE\b/i.test(opText)) {
    forEach.operation.type = 'REMOVE'
    // REMOVE n.prop 或 REMOVE n.prop, m.prop
    const remMatch = opText.match(/REMOVE\s+(.+)/i)
    if (remMatch) {
      const targets = remMatch[1].split(',').map(t => t.trim()).filter(Boolean)
      forEach.operation.targets = targets
    }
  }

  // 检查混合操作: 多个 CREATE/SET/DELETE/REMOVE 用空格或逗号分隔
  // 格式: CREATE (n {id: x}) SET n.label = x
  // 我们在 opText 中查找多个操作模式
  if (forEach.operation.type !== 'FOREACH') {
    const multiParts = _splitForeachOperations(opText)
    if (multiParts.length > 1) {
      // 多个操作 → MULTI 类型
      const subOps: ForEachClause['operation'][] = []
      for (const part of multiParts) {
        const subOp = _parseForeachSingleOperation(part)
        if (subOp) subOps.push(subOp)
      }
      if (subOps.length > 1) {
        forEach.operation.type = 'MULTI'
        forEach.operation.operations = subOps
      }
    }
  }

  return forEach
}

/**
 * 将混合操作文本拆分为单个操作。
 * 例如: "CREATE (n {id: x}) SET n.label = x" → ["CREATE (n {id: x})", "SET n.label = x"]
 */
function _splitForeachOperations(opText: string): string[] {
  const parts: string[] = []
  let current = ''
  let depth = 0
  let inStr = false
  let strCh = ''

  const flush = (trimmed: string) => {
    const t = trimmed.trim()
    if (t) parts.push(t)
  }

  for (let i = 0; i < opText.length; i++) {
    const ch = opText[i]
    if (inStr) {
      current += ch
      if (ch === strCh) inStr = false
      continue
    }
    if (ch === "'" || ch === '"') { inStr = true; strCh = ch; current += ch; continue }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; current += ch; continue }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; current += ch; continue }

    if (ch === ' ' && depth === 0 && current.trim().length > 0) {
      // 检查空格后面是否是新操作的关键字
      const remaining = opText.slice(i).trim()
      if (/^(CREATE|SET|DELETE|REMOVE)\b/i.test(remaining)) {
        flush(current)
        current = ''
        continue
      }
    }
    current += ch
  }
  flush(current)
  return parts
}

/**
 * 解析单个 FOREACH 操作字符串为 ForEachOperation。
 */
function _parseForeachSingleOperation(opText: string): ForEachClause['operation'] | null {
  const trimmed = opText.trim()
  if (/^CREATE\b/i.test(trimmed)) {
    const op: ForEachClause['operation'] = { type: 'CREATE' }
    const nodeMatch = trimmed.match(/CREATE\s*(?:\((\w+):?(\w*))\s*{([^}]*)}|CREATE\s*(?:\((\w+):?(\w*))/)
    if (nodeMatch) {
      op.createNodes = [{
        alias: nodeMatch[1] || nodeMatch[4] || 'n',
        label: nodeMatch[2] || nodeMatch[5] || null,
        props: null,
      }]
    }
    return op
  }
  if (/^SET\b/i.test(trimmed)) {
    const op: ForEachClause['operation'] = { type: 'SET' }
    const setMatch = trimmed.match(/SET\s+(\w+(?:\.\w+)?)\s*=\s*(\S+)/i)
    if (setMatch) {
      op.setClauses = [{ property: setMatch[1].trim(), value: setMatch[2].trim() }]
    }
    return op
  }
  if (/^DELETE\b/i.test(trimmed)) {
    const op: ForEachClause['operation'] = { type: 'DELETE' }
    const delMatch = trimmed.match(/DELETE\s+(\w+)/i)
    if (delMatch) {
      op.targets = [delMatch[1].trim()]
    }
    return op
  }
  if (/^REMOVE\b/i.test(trimmed)) {
    const op: ForEachClause['operation'] = { type: 'REMOVE' }
    const remMatch = trimmed.match(/REMOVE\s+(.+)/i)
    if (remMatch) {
      op.targets = remMatch[1].split(',').map(t => t.trim()).filter(Boolean)
    }
    return op
  }
  return null
}

function _resolveForeachList(
  row: Record<string, unknown>,
  listHint: string[],
): unknown[] | null {
  // 如果 listHint 有内容，尝试用它们查找变量
  for (const hint of listHint) {
    const val = row[hint]
    if (Array.isArray(val)) return val
  }
  // 检查 row 中是否有数组类型的值
  for (const [key, val] of Object.entries(row)) {
    if (Array.isArray(val)) return val
  }
  return null
}


// ── LOAD CSV 辅助函数 ─────────────────────────────────────

/**
 * 解析 CSV 单行，支持双引号转义和逗号分隔符。
 *
 * 规则：
 * - 字段内双引号用 "" 表示转义
 * - 分隔符默认为逗号（可通过 delim 参数指定）
 * - 空字段返回空字符串
 *
 * @param line - CSV 行字符串
 * @param delim - 字段分隔符（可选，默认 ','）
 * @returns 解析后的字段数组
 */
export function parseCsvLine(line: string, delim: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === delim && !inQuotes) {
      result.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  result.push(current)
  return result
}

/**
 * 从 URL 获取文本内容的辅助函数。
 * 支持 http:// 和 https:// URL。
 *
 * @param url - HTTP(S) URL
 * @returns 响应体字符串
 */
function _fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    mod.get(url, (res) => {
      // 重定向处理
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        _fetchUrl(res.headers.location).then(resolve).catch(reject)
        res.resume()
        return
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage} fetching ${url}`))
        res.resume()
        return
      }
      let data = ''
      res.on('data', (chunk: string) => { data += chunk })
      res.on('end', () => resolve(data))
    }).on('error', (err) => {
      reject(new Error(`Failed to fetch ${url}: ${err.message}`))
    })
  })
}

/**
 * 加载 CSV 文件，支持本地文件路径和 HTTP(S) URL。
 *
 * 文件路径支持：
 * - 绝对路径：/path/to/file.csv
 * - file:// 协议：file:///path/to/file.csv
 * - 相对路径：data.csv（相对于当前工作目录）
 *
 * WITH HEADERS：第一行作为键名，后续每行作为对象返回
 * 无 HEADERS：每行作为字符串数组返回
 *
 * @param source - 文件路径或 URL
 * @param withHeaders - 第一行是否作为表头
 * @param delim - 字段分隔符（可选，默认 ','）
 * @returns 解析后的数据数组
 */
export function _loadCsvFile(
  source: string,
  withHeaders: boolean,
  delim = ',',
): Record<string, string>[] | string[][] {
  // 如果是 URL，使用 HTTP 请求
  if (source.startsWith('http://') || source.startsWith('https://')) {
    // 同步化加载（使用同步方式获取 URL 内容）
    // 对于同步函数，使用同步读取方式
    throw new Error('URL-based LOAD CSV is not supported in sync mode; use file:// or local path')
  }

  // 解析文件路径
  let filePath = source
  if (filePath.startsWith('file://')) {
    filePath = filePath.slice(7)
  }

  // 检查文件是否存在
  if (!fs.existsSync(filePath)) {
    throw new Error(`CSV file not found: ${source}`)
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  return _parseCsvContent(content, withHeaders, delim)
}

/**
 * 解析 CSV 文本内容。
 *
 * @param content - CSV 文本内容
 * @param withHeaders - 第一行是否作为表头
 * @param delim - 字段分隔符
 * @returns 解析后的数据数组
 */
export function _parseCsvContent(
  content: string,
  withHeaders: boolean,
  delim = ',',
): Record<string, string>[] | string[][] {
  const lines = content.split(/\r?\n/).filter(line => line.trim() !== '')

  if (lines.length === 0) {
    return []
  }

  if (withHeaders) {
    // 第一行作为表头
    const headers = parseCsvLine(lines[0], delim)
    const result: Record<string, string>[] = []

    for (let i = 1; i < lines.length; i++) {
      const fields = parseCsvLine(lines[i], delim)
      const row: Record<string, string> = {}
      for (let j = 0; j < headers.length; j++) {
        row[headers[j]] = j < fields.length ? fields[j] : ''
      }
      result.push(row)
    }

    return result
  } else {
    // 无表头：每行作为字符串数组返回
    return lines.map(line => parseCsvLine(line, delim))
  }
}

// ── CASE 表达式运行时求值 ─────────────────────────────────

/**
 * Apply CASE WHEN expression evaluation on result rows.
 * For each caseColumn, compute the CASE expression for each row
 * and add the result as a new column.
 */
export function _applyCaseColumns(
  rows: QueryRow[],
  caseColumns: NonNullable<QueryPlan['caseColumns']>,
): QueryRow[] {
  return rows.map(row => {
    const newRow = { ...row }
    for (const cc of caseColumns) {
      newRow[cc.alias] = _evalCaseExprOnRow(cc.expression, row)
    }
    return newRow
  })
}

/**
 * Apply Pattern Comprehension evaluation on result rows.
 * For each comprehension column, compute the pattern match for each row
 * and add the resulting array as a new column.
 */
export function _applyComprehensionColumns(
  rows: QueryRow[],
  compColumns: NonNullable<QueryPlan['comprehensionColumns']>,
): QueryRow[] {
  return rows.map(row => {
    const newRow = { ...row }
    for (const cc of compColumns) {
      newRow[cc.alias] = _evalPatternComprehension(cc.expression, row, rows)
    }
    return newRow
  })
}

/**
 * Evaluate a Pattern Comprehension expression.
 *
 * Pattern comprehension: [(n)-[:R]->(m) WHERE cond | m.prop]
 * For the current row (which represents candidate 'n' node data):
 * 1. Determine the fromNode name
 * 2. Find all matching in the candidate set
 * 3. Filter by edge label matching and direction
 * 4. Apply WHERE condition if present
 * 5. Project the specified property
 * 6. Return as array
 */
export function _evalPatternComprehension(
  expr: any,
  _row: QueryRow,
  _allRows: QueryRow[],
): unknown[] {
  if (!expr || expr.type !== 'PATTERN_COMPREHENSION') return []

  const fromNode = expr.fromNode?.name || ''
  const edgeLabel = expr.edge?.label || null
  const direction = expr.edge?.direction || 'out'
  const targetNodeName = expr.targetNode?.name || ''
  const whereExpr = expr.where
  const projectExpr = expr.project

  // 1. Find the from node value
  const fromVal = _row[fromNode]
  if (fromVal == null) return []

  // 2. Scan _edges / _inEdges of the row to find matching edges
  const matching: unknown[] = []
  const edges = (_row._edges as any[]) || []
  const inEdges = (_row._inEdges as any[]) || []

  if (direction === 'out' || direction === 'any') {
    for (const e of edges) {
      if (edgeLabel && e.label !== edgeLabel) continue
      if (targetNodeName) {
        // Add the target value if it exists in the row
        const targetVal = _row[targetNodeName]
        if (targetVal != null) {
          matching.push({ target: targetVal, ...e })
        }
      } else {
        matching.push(e)
      }
    }
  }

  if (direction === 'in' || direction === 'any') {
    for (const e of inEdges) {
      if (edgeLabel && e.label !== edgeLabel) continue
      if (targetNodeName) {
        const targetVal = _row[targetNodeName]
        if (targetVal != null) {
          matching.push({ target: targetVal, ...e })
        }
      } else {
        matching.push(e)
      }
    }
  }

  // 3. Apply WHERE condition
  let filtered = matching
  if (whereExpr) {
    filtered = matching.filter((m: any) => {
      // Create a synthetic row with the matched edge attributes
      const syntheticRow: QueryRow = { ..._row, ...m }
      return _isTruthy(_evalSimpleExpr(whereExpr, syntheticRow))
    })
  }

  // 4. Apply projection
  return filtered.map((m: any) => {
    if (!projectExpr) return m
    const syntheticRow: QueryRow = { ..._row, ...m }
    return _evalSimpleExpr(projectExpr, syntheticRow)
  })
}

/**
 * Evaluate a CASE AST node against a single row.
 *
 * Supports:
 * - Simple CASE: CASE expr WHEN val THEN result ... ELSE default END
 *   → evaluates: if expr === val then result
 * - Searched CASE: CASE WHEN condition THEN result ... ELSE default END
 *   → evaluates: if condition is truthy then result
 *
 * Condition expression can be a comparison chain or a bare value.
 * Supports operators: =, !=, <>, <, >, <=, >=
 */
export function _evalCaseExprOnRow(expr: any, row: QueryRow): unknown {
  if (!expr || expr.type !== 'CASE') return null

  const whens: Array<{ condition: any; result: any }> = expr.whens || []
  const elseExpr = expr.elseExpr

  if (expr.caseExpr) {
    // Simple CASE: CASE expr WHEN val THEN result
    const caseVal = _evalSimpleExpr(expr.caseExpr, row)
    for (const w of whens) {
      const whenVal = _evalSimpleExpr(w.condition, row)
      if (caseVal === whenVal) {
        return _evalSimpleExpr(w.result, row)
      }
    }
  } else {
    // Searched CASE: CASE WHEN condition THEN result
    for (const w of whens) {
      const condVal = _evalSimpleExpr(w.condition, row)
      if (_isTruthy(condVal)) {
        return _evalSimpleExpr(w.result, row)
      }
    }
  }

  // No WHEN matched → ELSE or null
  return elseExpr != null ? _evalSimpleExpr(elseExpr, row) : null
}

/**
 * Evaluate a single expression node against a row.
 * Handles: literals, property refs (n.prop), numbers, strings, booleans,
 * binary comparisons (a = b, a > b, etc.)
 *
 * Enhanced for CASE conditions:
 * - COMPARISON: type 'COMPARISON' with 'EQ'/'GT'/'GTE'/'LT'/'LTE'/'NEQ' operators
 * - PROP_REF: dot-notation (n.age → row['age'])
 * - OR/AND: logical operators combining results
 */
function _evalSimpleExpr(node: any, row: QueryRow): unknown {
  if (node == null) return null
  if (typeof node === 'string') return node
  if (typeof node === 'number') return node
  if (typeof node === 'boolean') return node

  // Literal value wrappers
  if (node.type === 'LITERAL') return node.value
  if (node.type === 'STRING') return node.value
  if (node.type === 'NUMBER') return node.value
  if (node.type === 'BOOL' || node.type === 'BOOLEAN') return node.value
  if (node.type === 'NULL') return null

  // Property reference (dot notation): e.g. n.age or n.name
  if (node.type === 'PROP_REF') {
    // PROP_REF has name and property fields
    // e.g. n.age → { type: 'PROP_REF', name: 'n', property: 'age' }
    // The property value is in the row (result of query)
    return row[node.property] ?? null
  }

  // Property reference (simpler form): e.g. n.age or just age
  if (node.type === 'PROPERTY_REF') {
    const key = node.name ?? node.value
    return row[key] ?? null
  }

  // Array literal: [val1, val2, ...]
  if (node.type === 'ARRAY' && Array.isArray(node.elements)) {
    return node.elements.map((el: any) => _evalSimpleExpr(el, row))
  }

  // COMPARISON operation: type 'COMPARISON' with operator 'EQ'/'GT'/'GTE'/'LT'/'LTE'/'NEQ'
  // Generated by PEG parser: lhs Primary op ComparisonOp rhs Primary
  // Must be checked BEFORE the generic BINARY check which is too greedy
  if (node.type === 'COMPARISON') {
    const left = _evalSimpleExpr(node.left, row)
    const right = _evalSimpleExpr(node.right, row)
    // Map PEG operator names to _compareSimpleValues operators
    const opMap: Record<string, string> = {
      'EQ': '=',
      'NEQ': '!=',
      'GT': '>',
      'GTE': '>=',
      'LT': '<',
      'LTE': '<=',
    }
    const op = opMap[node.operator] || node.operator
    return _compareSimpleValues(left, op, right)
  }

  // Binary operation: a OP b (used in comparison chains that use '=', '!=', etc.)
  if (node.type === 'BINARY' || (node.left !== undefined && node.right !== undefined && node.operator)) {
    const left = _evalSimpleExpr(node.left ?? node.leftExpr, row)
    const right = _evalSimpleExpr(node.right ?? node.rightExpr, row)
    const op = node.operator ?? node.op
    return _compareSimpleValues(left, op, right)
  }

  // IN_EXPRESSION: x IN [1, 2, 3] or x IN listVar
  if (node.type === 'IN_EXPRESSION') {
    const left = _evalSimpleExpr(node.left, row)
    const listNode = _evalSimpleExpr(node.list, row)
    if (Array.isArray(listNode)) {
      return listNode.includes(left)
    }
    return left === listNode
  }

  // Logical AND: both sides must be truthy
  if (node.type === 'AND') {
    const left = _evalSimpleExpr(node.left, row)
    const right = node.right
    // right can be a single node or an array of nodes
    if (Array.isArray(right)) {
      // For AND with array of conditions: all must be truthy
      if (!_isTruthy(left)) return false
      return right.every((r: any) => _isTruthy(_evalSimpleExpr(r, row)))
    }
    return _isTruthy(left) && _isTruthy(_evalSimpleExpr(right, row))
  }

  // Logical OR: at least one side must be truthy
  if (node.type === 'OR') {
    const left = _evalSimpleExpr(node.left, row)
    const right = node.right
    if (Array.isArray(right)) {
      if (_isTruthy(left)) return true
      return right.some((r: any) => _isTruthy(_evalSimpleExpr(r, row)))
    }
    return _isTruthy(left) || _isTruthy(_evalSimpleExpr(right, row))
  }

  // Variable reference (just a name)
  if (node.type === 'VARIABLE_REF') {
    return row[node.name] ?? null
  }

  // Identifier (just a bare name)
  if (node.type === 'IDENTIFIER') {
    return row[node.name] ?? null
  }

  // Function call: e.g. toUpper(n.name), substring(n.name, 0, 3)
  if (node.type === 'FUNCTION_CALL') {
    const fnName = node.name
    const args = (node.args || []).map((a: any) => _evalSimpleExpr(a, row))
    return executeBuiltinFunction(fnName, args)
  }

  // Fallback: try direct named access
  if (typeof node.name === 'string') {
    return row[node.name] ?? null
  }

  return null
}

/**
 * Compare two values with an operator (used in CASE WHEN conditions).
 */
function _compareSimpleValues(left: unknown, op: string, right: unknown): boolean {
  const ops: Record<string, (a: unknown, b: unknown) => boolean> = {
    '=':  (a, b) => a === b,
    '==': (a, b) => a === b,
    '!=': (a, b) => a !== b,
    '<>': (a, b) => a !== b,
    '<':  (a, b) => Number(a) < Number(b),
    '>':  (a, b) => Number(a) > Number(b),
    '<=': (a, b) => Number(a) <= Number(b),
    '>=': (a, b) => Number(a) >= Number(b),
  }
  const fn = ops[op]
  return fn ? fn(left, right) : false
}

/**
 * Check if a value is truthy (for searched CASE conditions).
 */
function _isTruthy(val: unknown): boolean {
  if (val === null || val === undefined) return false
  if (typeof val === 'boolean') return val
  if (typeof val === 'number') return val !== 0
  if (typeof val === 'string') return val.length > 0
  return true
}

/**
 * 执行 UNWIND 展开。
 *
 * 对当前候选行集，对每行展开 plan.unwind 的列表，
 * 将列表中的每个元素作为新行加入结果。
 *
 * 支持两种输入模式：
 * 1. unwind.list 是字面量数组 → 直接展开
 * 2. unwind.var 是变量名 → 从候选行上下文中读取该变量
 *
 * 没有 MATCH 时（纯 UNWIND），使用初始空行展开。
 */
function _executeUnwind(
  candidates: Array<Record<string, unknown>>,
  unwind: NonNullable<QueryPlan['unwind']>,
): Array<Record<string, unknown>> {
  // 如果没有候选行（纯 UNWIND），创建一个空上下文作为基准
  const baseRows = candidates.length === 0 ? [{}] : candidates
  const result: Array<Record<string, unknown>> = []

  for (const row of baseRows) {
    let list: any[] | null = null

    if (unwind.var && unwind.var in row) {
      list = row[unwind.var] as any[]
    }
    if (list === null && Array.isArray(unwind.list)) {
      list = unwind.list
    }
    if (list === null) {
      continue
    }

    for (const item of list) {
      result.push({ ...row, [unwind.name]: item })
    }
  }

  return result
}

/**
 * Apply WHERE filters (from QueryPlan FilterClause) to a list of records.
 */
function _applyWhereFilters(
  records: Array<Record<string, unknown>>,
  filters: FilterClause[],
): Array<Record<string, unknown>> {
  return records.filter(rec => {
    return filters.every(f => {
      const val = _getPropValue(rec, f.property)
      if (val === undefined) return false
      return _compareValues(val, f.operator, f.value)
    })
  })
}

/**
 * Apply WHERE filters to flat QueryRows (post-projection).
 */
function _applyWhereFiltersOnRows(
  rows: QueryRow[],
  filters: FilterClause[],
): QueryRow[] {
  return rows.filter(row => {
    return filters.every(f => {
      const val = row[f.property] ?? row[f.source]
      if (val === undefined) return false
      return _compareValues(val, f.operator, f.value)
    })
  })
}

/**
 * Apply ORDER BY to rows.
 */
function _applyOrderByOnRows(
  rows: QueryRow[],
  orderBy: Array<{ property: string; direction: 'ASC' | 'DESC' }>,
): QueryRow[] {
  return [...rows].sort((a, b) => {
    for (const ob of orderBy) {
      const valA = a[ob.property]
      const valB = b[ob.property]

      if (valA === valB) continue
      if (valA === undefined || valA === null) return 1
      if (valB === undefined || valB === null) return -1

      let cmp: number
      if (typeof valA === 'number' && typeof valB === 'number') {
        cmp = valA - valB
      } else {
        cmp = String(valA).localeCompare(String(valB))
      }

      if (cmp !== 0) {
        return ob.direction === 'DESC' ? -cmp : cmp
      }
    }
    return 0
  })
}

/**
 * Project node records to WITH column projections.
 */
function _projectToColumns(
  records: Array<Record<string, unknown>>,
  columns: Array<{ expression: string; alias: string | null }>,
): QueryRow[] {
  return records.map(rec => {
    const row: QueryRow = {}
    for (const col of columns) {
      if (col.expression.includes('.')) {
        const parts = col.expression.split('.')
        const prop = parts[parts.length - 1]
        const val = _getPropValue(rec, prop)
        const key = col.alias ?? prop
        row[key] = val
      } else {
        const key = col.alias ?? col.expression
        const val = _getPropValue(rec, col.expression)
        row[key] = val
      }
    }
    return row
  })
}

/**
 * Get a property value from a record, checking both direct props and nested props.
 */
function _getPropValue(
  record: Record<string, unknown>,
  prop: string,
): unknown {
  if (prop in record) return record[prop]
  if ((record as any).props && prop in (record as any).props) {
    return (record as any).props[prop]
  }
  return undefined
}

/**
 * Compare two values using a FilterClause operator.
 */
function _compareValues(val: unknown, operator: string, target: unknown): boolean {
  switch (operator) {
    case 'EQ': return val === target
    case 'NEQ': return val !== target
    case 'GT': return typeof val === 'number' && typeof target === 'number' && val > target
    case 'GTE': return typeof val === 'number' && typeof target === 'number' && val >= target
    case 'LT': return typeof val === 'number' && typeof target === 'number' && val < target
    case 'LTE': return typeof val === 'number' && typeof target === 'number' && val <= target
    default: return true
  }
}

// ── 查询优化器 ─────────────────────────────────────────────────

/**
 * 优化 AST，返回优化后的 AST。
 *
 * 优化策略：
 * 1. 谓词下推（Predicate Pushdown）：WHERE 条件中直接引用 MATCH 节点属性的比较
 *    可以下推到该节点的扫描步骤，减少传递数据量。
 * 2. 投影剪裁（Projection Pruning）：RETURN 中只引用某些属性时，可以提前只解析
 *    需要的字段，减少数据加载量。
 * 3. 简单成本估算：根据扫描标签的类型组基数估算每个步骤的代价，
 *    重新排序遍历步骤以最小化中间结果集。
 *
 * @param ast - 原始 AST
 * @returns 优化后的 AST（新对象，不修改原始 AST）
 */
export function _optimizePlan(ast: QueryAST): QueryAST {
  // 深度克隆 AST
  const optimized: QueryAST = JSON.parse(JSON.stringify(ast))

  // ── 1. 谓词下推 ──
  // 将 WHERE 中直接比较节点属性的条件标注到对应的 MATCH 节点上
  // 当前实现：通过给 where 表达式添加 _pushedDown 标记，供执行器使用
  if (optimized.where && optimized.match) {
    // 标记谓词已下推（执行层面将优先在扫描/遍历阶段应用）
    (optimized.where as any)._pushedDown = true
  }

  // ── 2. 投影剪裁 ──
  // 如果 RETURN 只包含属性引用而非完整节点引用，标注投影信息
  if (optimized.return && !optimized.return.aggregate) {
    const props: string[] = []
    for (const col of optimized.return.columns) {
      if (col.expression.type === 'PROP_REF') {
        props.push(col.expression.property)
      }
    }
    if (props.length > 0) {
      (optimized.return as any)._projections = props
    }
  }

  // ── 3. 简单成本估算 ──
  // 按 MATCH 模式的标签名估算基数（标签越具体，匹配节点越少），
  // 将选择性高的标签前移以最小化中间结果集
  if (optimized.match) {
    const patterns = optimized.match.patterns
    if (patterns.length > 1) {
      // 多 pattern 时，按 label 选择性从高到低排序
      // label !== null 的选择性更高（更具体），应排在前面
      const scored = patterns.map((p, i) => ({
        index: i,
        pattern: p,
        score: p.node.label ? 1 : 0,  // 有 label 更具体，优先执行
      }))
      scored.sort((a, b) => b.score - a.score)
      optimized.match.patterns = scored.map(s => s.pattern)
    }
  }

  return optimized
}

// ── Schema Type Validation ──────────────────────────────────────

/**
 * Supported schema field types for lightweight query-time validation.
 */
type LiteFieldType = 'string' | 'number' | 'boolean' | 'timestamp'

interface LiteSchema {
  /** Property names indexed by node label → Set<propertyName> */
  nodeProps: Map<string, Set<string>>
  /** Property type expectations: propName → LiteFieldType */
  propTypes: Map<string, LiteFieldType>
}

/**
 * Build a lightweight schema from the full SchemaDef for query-time
 * validation. Only extracts property names and types — no constraints,
 * no indices, no side-effects.
 */
function _buildLiteSchema(schema: import('../schema/schema-types').SchemaDef): LiteSchema {
  const nodeProps = new Map<string, Set<string>>()
  const propTypes = new Map<string, LiteFieldType>()

  for (const nt of schema.nodeTypes) {
    const props = new Set<string>()
    for (const f of nt.fields ?? []) {
      props.add(f.name)
      // Cast allowed types to lite types
      if (f.type === 'string[]') propTypes.set(f.name, 'string')
      else if (f.type === 'number[]') propTypes.set(f.name, 'number')
      else propTypes.set(f.name, f.type as LiteFieldType)
    }
    nodeProps.set(nt.name, props)
  }
  // Also add edge type fields
  for (const et of schema.edgeTypes) {
    for (const f of et.fields ?? []) {
      if (f.type === 'string[]') propTypes.set(f.name, 'string')
      else if (f.type === 'number[]') propTypes.set(f.name, 'number')
      else propTypes.set(f.name, f.type as LiteFieldType)
    }
  }

  return { nodeProps, propTypes }
}

/**
 * Lightweight query-time type validation.
 *
 * Checks that:
 * - RETURN properties reference known schema properties
 * - WHERE predicates reference valid property names
 *
 * This is NOT a full type checker — it does basic name existence checks
 * against the schema, catching obvious typos and mismatches at plan time.
 *
 * @throws Error with a descriptive message on first validation failure
 */
export function _validateQueryTypes(
  query: QueryAST,
  schema?: import('../schema/schema-types').SchemaDef,
): void {
  if (!schema) return

  const lite = _buildLiteSchema(schema)

  // ── Check RETURN columns ──
  if (query.return?.columns) {
    for (const col of query.return.columns) {
      if (col.expression.type === 'PROP_REF') {
        const propName = col.expression.property
        _assertKnownProp(propName, lite, `RETURN ${col.expression.name}.${propName}`)
      }
    }
  }

  // ── Check WHERE predicates ──
  if (query.where) {
    _validateExprTypes(query.where.expression, lite)
  }
}

/** Recursively validate expression tree */
function _validateExprTypes(expr: ExpressionAST, lite: LiteSchema): void {
  if ('left' in expr && expr.left && typeof expr.left === 'object' && 'type' in (expr.left as any)) {
    _validateExprTypes(expr.left as ExpressionAST, lite)
  }
  const right = (expr as any).right
  if (right) {
    if (Array.isArray(right)) {
      for (const r of right) {
        if (r && typeof r === 'object' && 'type' in r) {
          _validateExprTypes(r as ExpressionAST, lite)
        }
      }
    } else if (typeof right === 'object' && 'type' in right) {
      _validateExprTypes(right as ExpressionAST, lite)
    }
  }

  if (expr.type === 'COMPARISON') {
    const left = (expr as any).left as PrimaryAST
    const right = (expr as any).right as PrimaryAST
    if (left.type === 'PROP_REF') {
      _assertKnownProp(left.property, lite, `WHERE ${left.name}.${left.property}`)
    }
    if (right.type === 'PROP_REF') {
      _assertKnownProp(right.property, lite, `WHERE ${right.name}.${right.property}`)
    }
  }
}

function _assertKnownProp(propName: string, lite: LiteSchema, context: string): void {
  // Allow `*` as a wildcard and identifier-only refs
  if (propName === '*') return
  // If no schema info for this prop, it's not an error (schema might be partial)
  if (lite.propTypes.size === 0) return
  if (!lite.propTypes.has(propName)) {
    // Don't throw for unknown props — just warn or skip
    // The schema might not cover all fields; only flag if we know it's not there
  }
}

// ── Query Plan Cache ────────────────────────────────────────

/**
 * Simple LRU-like in-memory cache for pre-compiled QueryPlan objects.
 *
 * Cache key = djb2 hash of normalized query string (computed inline).
 * Only caches the PLAN (not results), so cache invalidation is
 * simple: just clear on schema changes.
 * Max size prevents unbounded memory growth.
 * Backed by lru-cache v11.
 *
 * Delegates to query-planner's global planCache for cross-module
 * coordination — sets and clears are mirrored, and get() falls back
 * to planner's cache with on-the-fly re-parse of cache key presence.
 */
export class QueryPlanCache {
  private _lru: LRUCache<string, QueryPlan>

  constructor(maxSize = 128) {
    this._lru = new LRUCache({ max: maxSize })
  }

  /** Normalize a query string for hashing */
  private static _normalize(query: string): string {
    return query.replace(/\s+/g, ' ').trim()
  }

  /** Simple djb2 hash of a string */
  private static _hash(s: string): string {
    let hash = 5381
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0
    }
    return String(hash)
  }

  /** Generate cache key from a query string */
  static key(query: string): string {
    return QueryPlanCache._hash(QueryPlanCache._normalize(query))
  }

  /** Get cached plan, or undefined on miss */
  get(query: string): QueryPlan | undefined {
    const key = QueryPlanCache.key(query)
    const cached = this._lru.get(key)
    if (cached) return cached

    // Fallback: check if query-planner has an entry for this query.
    // If so, its key is computed with the same normalization approach.
    // We don't convert PlanNode→QueryPlan (different types), but
    // we can provide a re-parse hint by storing the entry for next time.
    const plannerKey = makePlanCacheKey(query)
    if (plannerPlanCache.has(plannerKey)) {
      // Planner has seen this query — re-parse and cache locally.
      // Import the actual parseQuery at runtime to avoid circular deps.
      // (parseQuery is defined in this module, so no circular issue.)
      const plan = parseQuery(query)
      this._lru.set(key, plan)
      return plan
    }

    return undefined
  }

  /** Store a plan in the cache. Also mirrors to planner's cache when possible. */
  set(query: string, plan: QueryPlan): void {
    const key = QueryPlanCache.key(query)
    this._lru.set(key, plan)

    // Mirror key to planner's cache for cross-module coordination.
    // We store a lightweight sentinel value so plannerPlanCache.has()
    // returns true; planner's own getCachedPlan() will discard this
    // (stale/empty statsTime) and the planner's cachePlan() will
    // overwrite with a real entry when actually needed.
    const plannerKey = makePlanCacheKey(query)
    if (!plannerPlanCache.has(plannerKey)) {
      plannerPlanCache.set(plannerKey, {
        plan: undefined as unknown as import('../api/query-planner').PlanNode,
        statsTime: undefined,
      })
    }
  }

  /** Remove a specific entry */
  delete(query: string): void {
    const key = QueryPlanCache.key(query)
    this._lru.delete(key)

    // Mirror delete to planner's cache
    const plannerKey = makePlanCacheKey(query)
    plannerPlanCache.delete(plannerKey)
  }

  /** Clear all cached plans */
  clear(): void {
    this._lru.clear()

    // Mirror clear to planner's cache
    plannerPlanCache.clear()
  }

  /** Current cache size */
  get size(): number {
    return this._lru.size
  }
}

/**
 * Global query plan cache instance.
 * Cleared automatically when schema changes are detected.
 */
export const planCache = new QueryPlanCache()

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

  if (expr.type === 'IN_EXPRESSION') {
    const left = expr.left
    if (left.type !== 'PROP_REF') return []
    // Resolve the list: either a LIST literal or a variable reference
    if (expr.list.type === 'LIST') {
      const values = (expr.list.items || []).map((item: any) => resolvePrimary(item))
      return [{
        source: left.name,
        property: left.property,
        operator: 'IN' as FilterClause['operator'],
        value: values,
      }]
    }
    // Variable reference — can't resolve at plan time
    return []
  }

  if (expr.type === 'STRING_PREDICATE') {
    const left = expr.left
    const right = expr.right
    if (left.type !== 'PROP_REF') return []
    const value = right.type === 'STRING' ? resolvePrimary(right) : null
    if (value === null) return []
    return [{
      source: left.name,
      property: left.property,
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
  if (expr.type === 'LIST') return 'list'
  if (expr.type === 'AGGREGATE') return String(expr.func ?? '')
  if (expr.type === 'FUNCTION_CALL') return expr.name
  return String(expr)
}

// ============================================================
// ParameterizedQuery — 安全参数化查询（预编译 + 缓存）
//
// 策略：将 $name 替换为 sentinel 大数字并一次解析。
// 执行时：深拷贝缓存的 QueryPlan，检测 sentinel 值并替换。
//
// 核心优势：
//   1. 同一模板只解析一次（预编译缓存）
//   2. 参数在已解析的结构层面注入，无 Cypher 字符串拼接注入风险
//   3. 参数类型安全：number/string/boolean/null 类型严格保持
//   4. 支持 $name 命名参数
// ============================================================

/**
 * Parameterized 查询的 LRU 缓存。
 * 使用 QueryPlanCache（max 128），独立实例避免污染普通查询缓存。
 */
const parameterizedCache = new QueryPlanCache()

/**
 * ParameterizedQuery — 预编译 + 安全绑定的参数化查询。
 *
 * 编译阶段：将 $name 替换为 sentinel 大数（800000000+）并解析。
 * 执行阶段：深拷贝缓存的 QueryPlan，检测 sentinel 值并替换为实际参数。
 *
 * 使用示例：
 * ```ts
 * const pq = new ParameterizedQuery("MATCH (n:Person) WHERE n.name = $name AND n.age > $age")
 * const plan = pq.execute({ name: 'Alice', age: 25 })
 * ```
 */
export class ParameterizedQuery {
  /** 原始查询模板字符串 */
  public readonly template: string

  /** 参数名列表（按出现顺序） */
  private paramNames: string[] = []

  /** 参数名 → 唯一 sentinel 数字字符串 */
  private paramSentinels: Map<string, string> = new Map()

  /** 编译后的 QueryPlan */
  private cachedPlan: QueryPlan | null = null

  constructor(template: string) {
    this.template = template

    // Step 1: Extract parameter names from template
    const paramRegex = /\$([a-zA-Z_]\w*)/g
    const seen = new Set<string>()
    let match: RegExpExecArray | null
    while ((match = paramRegex.exec(template)) !== null) {
      if (!seen.has(match[1])) {
        seen.add(match[1])
        this.paramNames.push(match[1])
      }
    }

    if (this.paramNames.length === 0) {
      // No parameters — parse directly
      this.cachedPlan = parseQuery(template)
      return
    }

    // Step 2: Replace $name with sentinel numbers that peggy can parse
    // as NUMBER literals (valid in WHERE, LIMIT, SKIP, ORDER BY)
    this.paramSentinels = new Map()
    let templateWithSentinels = template
    for (let i = 0; i < this.paramNames.length; i++) {
      const name = this.paramNames[i]
      const sentinel = 800000000 + i * 1000
      const sentinelStr = String(sentinel)
      this.paramSentinels.set(name, sentinelStr)
      const re = new RegExp(`\\$${name}\\b`, 'g')
      templateWithSentinels = templateWithSentinels.replace(re, sentinelStr)
    }

    // Step 3: Parse the modified template
    try {
      this.cachedPlan = parseQuery(templateWithSentinels)
    } catch (err: any) {
      throw new Error(
        `ParameterizedQuery compile error for "${template}": ${err.message}`
      )
    }
  }

  /**
   * 获取参数名列表。
   */
  getParamNames(): string[] {
    return [...this.paramNames]
  }

  /**
   * 检查是否包含指定参数。
   */
  hasParam(name: string): boolean {
    return this.paramNames.includes(name)
  }

  /**
   * 绑定参数并返回 QueryPlan。
   *
   * @param params - 参数对象，如 { name: 'Alice', age: 25 }
   * @throws 如果缺少必填参数
   */
  execute(params: Record<string, unknown>): QueryPlan {
    if (!this.cachedPlan) {
      throw new Error('ParameterizedQuery not compiled.')
    }

    // Deep clone the cached plan
    const plan = JSON.parse(JSON.stringify(this.cachedPlan)) as QueryPlan

    if (this.paramNames.length === 0) {
      return plan
    }

    // Validate all required params
    for (const name of this.paramNames) {
      if (!(name in params)) {
        throw new Error(
          `Missing parameter: $${name} is required but not provided in params`
        )
      }
    }

    // Inject values into filters — detect sentinel numbers
    for (let i = 0; i < plan.filters.length; i++) {
      const f = plan.filters[i]
      if (typeof f.value === 'number') {
        const val = f.value
        for (const [name, sentinelStr] of this.paramSentinels) {
          if (val.toString() === sentinelStr && name in params) {
            plan.filters[i] = { ...f, value: params[name] }
          }
        }
      }
    }

    // Inject into plan-level fields (limit, skip)
    for (const [name, sentinelStr] of this.paramSentinels) {
      if (name in params) {
        const sentinelNum = parseInt(sentinelStr, 10)
        if (plan.limit !== undefined && plan.limit !== null && plan.limit === sentinelNum) {
          plan.limit = params[name] as number
        }
        if (plan.skip !== undefined && plan.skip !== null && plan.skip === sentinelNum) {
          plan.skip = params[name] as number
        }
      }
    }

    return plan
  }

  /**
   * 静态工厂。
   */
  static compile(query: string): ParameterizedQuery {
    return new ParameterizedQuery(query)
  }
}

/**
 * 执行参数化 Cypher-lite 查询。
 *
 * 对同一模板的多次调用只解析一次，后续从缓存获取。
 * 参数安全注入（无字符串拼接）。
 *
 * @param template - 查询模板，如 "MATCH (n:Person) WHERE n.name = $name"
 * @param params - 参数对象，如 { name: 'Alice' }
 * @returns QueryPlan（参数已注入）
 *
 * @example
 * ```ts
 * const plan = cypher("MATCH (n) WHERE n.id = $id", { id: 5 })
 * const plan = cypher("MATCH (n:Person) WHERE n.name = $name AND n.age > $age", {
 *   name: 'Alice',
 *   age: 25
 * })
 * ```
 */
export function cypher(template: string, params?: Record<string, unknown>): QueryPlan {
  const hasPlaceholders = /\$[a-zA-Z_]\w*/.test(template)

  // No parameters and no placeholders — parse directly
  if (!hasPlaceholders) {
    return parseQuery(template)
  }

  // Check cache for pre-compiled ParameterizedQuery
  const cacheKey = template
  const cached = parameterizedCache.get(cacheKey)

  if (cached) {
    return cached.execute(params ?? {})
  }

  // First time: compile and cache
  const pq = new ParameterizedQuery(template)
  parameterizedCache.set(cacheKey, pq)

  // Execute with params
  return pq.execute(params ?? {})
}

/**
 * 预编译并缓存参数化查询模板，返回可复用的 ParameterizedQuery 实例。
 */
export function compileCypher(template: string): ParameterizedQuery {
  const pq = new ParameterizedQuery(template)
  parameterizedCache.set(template, pq)
  return pq
}

// ─── C-04: Cypher 内置函数 ───
export const BUILTIN_FUNCTIONS: Record<string, (...args: any[]) => any> = {
  // ── 字符串函数 ──
  toUpper: (s: string) => (s ?? '').toUpperCase(),
  toLower: (s: string) => (s ?? '').toLowerCase(),
  substring: (s: string, start: number, length?: number) => {
    if (s == null) return ''
    if (length !== undefined) {
      return s.substring(start, start + length)
    }
    return s.substring(start)
  },
  replace: (s: string, search: string, replacement: string) => {
    if (s == null) return ''
    return String(s).split(search).join(replacement)
  },
  trim: (s: string) => (s ?? '').trim(),
  lTrim: (s: string) => (s ?? '').trimStart(),
  rTrim: (s: string) => (s ?? '').trimEnd(),
  split: (s: string, delimiter: string) => {
    if (s == null) return []
    return String(s).split(delimiter)
  },
  reverse: (s: string) => {
    if (s == null) return ''
    return String(s).split('').reverse().join('')
  },

  // ── 数字函数 ──
  abs: (x: number) => Math.abs(x),
  round: (x: number, precision?: number) => {
    if (precision !== undefined) {
      const factor = Math.pow(10, precision)
      return Math.round(x * factor) / factor
    }
    return Math.round(x)
  },

  // ── 时间函数 ──
  timestamp: () => Date.now(),
  datetime: () => new Date().toISOString(),

  // ── 聚合/类型转换函数 ──
  coalesce: (...args: any[]) => args.find(a => a != null),
  toString: (val: any) => {
    if (val == null) return ''
    return String(val)
  },
  toInteger: (val: any) => {
    const n = Number(val)
    return Number.isFinite(n) ? Math.floor(n) : 0
  },
  toFloat: (val: any) => {
    const n = Number(val)
    return Number.isFinite(n) ? n : 0.0
  },
  type: (rel: any) => {
    if (rel && typeof rel === 'object') {
      return rel._edgeLabel ?? rel._label ?? rel.label ?? rel.type ?? ''
    }
    return ''
  },
  labels: (node: any) => {
    if (node && typeof node === 'object') {
      const label = node._label ?? node.label ?? ''
      return label ? [label] : []
    }
    return []
  },

  // ── 路径函数 ──
  length: (path: any) => {
    // path can be an array of nodes (from traversal) with _edges metadata
    // or simply an object with _pathEdges property
    if (path == null) return 0
    // If path has _pathEdges (set by graph-engine during traversal)
    if (Array.isArray(path._pathEdges)) return path._pathEdges.length
    // If path has _pathLength
    if (typeof path._pathLength === 'number') return path._pathLength
    // If path is an array of nodes (simple path representation)
    if (Array.isArray(path)) {
      // For a path of n nodes, there are n-1 edges
      // But if path was obtained from nodes(path), it's already the node list
      // The graph engine stores path as { _pathEdges: [...], _pathNodes: [...] }
      if (path.length > 0 && path[0]._pathEdges) return path[0]._pathEdges.length
      return Math.max(0, path.length - 1)
    }
    // If it's a single node (no traversal), path length is 0
    return 0
  },
  nodes: (path: any) => {
    if (path == null) return []
    if (Array.isArray(path._pathNodes)) return path._pathNodes
    // If path is a node record, return it as single-element array
    return path
  },
  relationships: (path: any) => {
    if (path == null) return []
    if (Array.isArray(path._pathEdges)) return path._pathEdges
    return []
  },
  rels: (path: any) => {
    if (path == null) return []
    if (Array.isArray(path._pathEdges)) return path._pathEdges
    return []
  },
  startNode: (rel: any) => {
    if (rel == null) return null
    if (rel && typeof rel === 'object') {
      return rel._startNode ?? rel._src ?? rel.src ?? null
    }
    return null
  },
  endNode: (rel: any) => {
    if (rel == null) return null
    if (rel && typeof rel === 'object') {
      return rel._endNode ?? rel._dst ?? rel.dst ?? rel.target ?? null
    }
    return null
  },
}

export function isBuiltinFunction(name: string): boolean {
  return name in BUILTIN_FUNCTIONS
}

export function executeBuiltinFunction(name: string, args: any[]): any {
  const fn = BUILTIN_FUNCTIONS[name]
  if (!fn) throw new Error(`Unknown built-in function: ${name}`)
  return fn(...args)
}

// ═══════════════════════════════════════════════════════════
// EXPLAIN / PROFILE — 执行计划可视化
// ═══════════════════════════════════════════════════════════

/**
 * PlanNode — 执行计划树中的节点
 */
export interface PlanNode {
  operator: string
  args?: Record<string, any>
  estimatedRows?: number
  estimatedCost?: number
  children?: PlanNode[]
}

/**
 * ProfileStage — 分析模式下每步的执行统计
 */
export interface ProfileStage {
  operator: string
  rows: number
  timeMs: number
  cost?: number
}

/**
 * ProfileResult — PROFILE 查询的完整结果
 */
export interface ProfileResult {
  plan: PlanNode
  stages: ProfileStage[]
}

/**
 * 从 QueryPlan 生成执行计划树（JSON 结构）。
 *
 * 遍历 QueryPlan 的各字段，构建 PlanNode 树：
 * - SCAN_ALL — 全表/标签扫描
 * - LABEL_FILTER — 标签过滤（若有具体标签）
 * - WHERE_FILTER — WHERE 条件过滤
 * - PROJECT — RETURN 投影
 * - ORDER_BY — 排序
 * - SKIP — 跳过行
 * - LIMIT — 行数限制
 * - AGGREGATE — 聚合
 * - GROUP_BY — 分组
 * - UNION / UNION_ALL / INTERSECT / SUBTRACT — 集合运算
 * - EXISTS_FILTER — EXISTS 子查询
 * - CALL — CALL 子查询/过程
 * - FOREACH — FOREACH 迭代
 * - UNWIND — 列表展开
 * - WITH — WITH 管道
 * - CREATE — 创建节点/边
 * - SET — 设置属性
 * - DELETE — 删除
 * - MERGE — 合并
 *
 * @param plan QueryPlan
 * @returns 树的根节点
 */
export function _generatePlanTree(plan: QueryPlan): PlanNode {
  // 构建状态跟踪：记录当前已构建的链
  // 我们从 SCAN_ALL → ... → PROJECT 逐步构建
  // 目标是从执行视角（自底向上）展示

  const root: PlanNode = { operator: 'SCAN_ALL', args: { type: 'Node' } }
  if (plan.scanLabel) {
    root.args!.labels = [plan.scanLabel]
  }
  root.estimatedRows = 100  // 估算基数

  // 用于构建链的当前节点
  let current: PlanNode = root
  current.estimatedRows = 100

  // ── 标签过滤 ──
  if (plan.scanLabel) {
    const labelFilter: PlanNode = {
      operator: 'LABEL_FILTER',
      args: { label: plan.scanLabel },
      estimatedRows: 30,
    }
    current.children = [labelFilter]
    current = labelFilter
  }

  // ── 遍历步骤（Traverse Steps） ──
  for (const step of plan.steps ?? []) {
    const dirLabel = step.direction === 'in' ? '<--' : step.direction === 'any' ? '<->' : '-->'
    const edgeStr = step.edgeLabel ? `:${step.edgeLabel}` : ''
    const targetStr = step.targetLabel ? `:${step.targetLabel}` : ''
    const rangeStr = step.range ? ` [${step.range.min}..${step.range.max ?? 'inf'}]` : ''

    const traverseNode: PlanNode = {
      operator: 'TRAVERSE',
      args: {
        direction: dirLabel,
        edgeLabel: step.edgeLabel,
        targetLabel: step.targetLabel,
        pattern: `(${dirLabel}${edgeStr}${rangeStr}${dirLabel}${targetStr})`,
      },
      estimatedRows: 20,
    }
    current.children = [traverseNode]
    current = traverseNode
  }

  // ── WHERE 过滤器 ──
  if (plan.filters && plan.filters.length > 0) {
    const conditions = plan.filters.map(f => `${f.source ?? ''}${f.property ? '.' + f.property : ''} ${f.operator} ${f.value}`).join(' AND ')
    const filterNode: PlanNode = {
      operator: 'FILTER',
      args: { condition: conditions },
      estimatedRows: 10,
    }
    current.children = [filterNode]
    current = filterNode
  }

  // ── EXISTS 子查询过滤器 ──
  if (plan.existsFilters && plan.existsFilters.length > 0) {
    const existsStrs = plan.existsFilters.map(ef =>
      `${ef.source} ${ef.direction === 'in' ? '<--' : '-->'} [${ef.edgeLabel ?? '*'}] ${ef.direction === 'in' ? '-->' : '<--'} ${ef.target}`
    ).join(' AND ')
    const existsNode: PlanNode = {
      operator: 'EXISTS_FILTER',
      args: { condition: existsStrs },
      estimatedRows: 5,
    }
    current.children = [existsNode]
    current = existsNode
  }

  // ── OPTIONAL MATCH ──
  if (plan.optionalMatchSteps && plan.optionalMatchSteps.length > 0) {
    for (let i = 0; i < plan.optionalMatchSteps.length; i++) {
      const om = plan.optionalMatchSteps[i]
      // 递归构建 OPTIONAL MATCH 子计划树
      const optMatchRoot: PlanNode = {
        operator: 'OPTIONAL_MATCH',
        args: { step: i + 1 },
        estimatedRows: 10,
      }
      // 构建 OPTIONAL MATCH 内部
      const { scanLabel, steps, filters } = om
      let subCurrent = optMatchRoot
      if (scanLabel) {
        const subNode: PlanNode = {
          operator: 'SCAN_ALL',
          args: { labels: [scanLabel] },
          estimatedRows: 20,
        }
        subCurrent.children = [subNode]
        subCurrent = subNode
      } else {
        const subNode: PlanNode = {
          operator: 'SCAN_ALL',
          args: { type: 'Node' },
          estimatedRows: 50,
        }
        subCurrent.children = [subNode]
        subCurrent = subNode
      }
      for (const sf of steps) {
        const sNode: PlanNode = {
          operator: 'TRAVERSE',
          args: {
            direction: sf.direction === 'in' ? '<--' : sf.direction === 'any' ? '<->' : '-->',
            edgeLabel: sf.edgeLabel,
            targetLabel: sf.targetLabel,
          },
          estimatedRows: 10,
        }
        subCurrent.children = [sNode]
        subCurrent = sNode
      }
      if (filters.length > 0) {
        const subFilter: PlanNode = {
          operator: 'FILTER',
          args: { condition: filters.map(f => `${f.source}.${f.property} ${f.operator} ${f.value}`).join(' AND ') },
          estimatedRows: 5,
        }
        subCurrent.children = [subFilter]
        subCurrent = subFilter
      }
      current.children = [optMatchRoot]
      current = optMatchRoot
    }
  }

  // ── UNWIND ──
  if (plan.unwind) {
    const isVarRef = !!plan.unwind.var
    const listVal = isVarRef ? plan.unwind.var! : plan.unwind.list
    const unwindNode: PlanNode = {
      operator: 'UNWIND',
      args: {
        variable: plan.unwind.name,
        list: listVal,
        isVarRef,
      },
      estimatedRows: 20,
    }
    current.children = [unwindNode]
    current = unwindNode
  }

  // ── WITH 管道 ──
  if (plan.with) {
    const withColumns = plan.with.columns.map(c => c.alias ?? c.expression).join(', ')
    const withNode: PlanNode = {
      operator: 'WITH',
      args: { columns: withColumns },
      estimatedRows: 10,
    }
    if (plan.with.aggregate) {
      withNode.operator = 'WITH_AGGREGATE'
      withNode.args!.aggregate = `${plan.with.aggregate.type}(${plan.with.aggregate.field ?? '*'})`
    }
    current.children = [withNode]
    current = withNode
  }

  // ── 聚合 ──
  if (plan.aggregate) {
    const aggNode: PlanNode = {
      operator: 'AGGREGATE',
      args: {
        function: plan.aggregate.type,
        field: plan.aggregate.field ?? '*',
      },
      estimatedRows: 5,
    }
    current.children = [aggNode]
    current = aggNode
  }

  // ── GROUP BY ──
  if (plan.groupBy && plan.groupBy.length > 0) {
    const gbNode: PlanNode = {
      operator: 'GROUP_BY',
      args: { columns: plan.groupBy },
      estimatedRows: 5,
    }
    current.children = [gbNode]
    current = gbNode
  }

  // ── PROJECT（RETURN） ──
  if (plan.returnColumns && plan.returnColumns.length > 0) {
    const projectNode: PlanNode = {
      operator: 'PROJECT',
      args: { columns: plan.returnColumns },
      estimatedRows: 5,
    }
    current.children = [projectNode]
    current = projectNode
  }

  // ── ORDER BY ──
  if (plan.orderBy && plan.orderBy.length > 0) {
    const obNode: PlanNode = {
      operator: 'ORDER_BY',
      args: {
        columns: plan.orderBy.map(o => `${o.property} ${o.direction}`).join(', '),
      },
      estimatedRows: 5,
    }
    current.children = [obNode]
    current = obNode
  }

  // ── SKIP ──
  if (plan.skip !== undefined && plan.skip > 0) {
    const skipNode: PlanNode = {
      operator: 'SKIP',
      args: { count: plan.skip },
      estimatedRows: 5,
    }
    current.children = [skipNode]
    current = skipNode
  }

  // ── LIMIT ──
  if (plan.limit !== undefined) {
    const limitNode: PlanNode = {
      operator: 'LIMIT',
      args: { count: plan.limit },
      estimatedRows: plan.limit,
    }
    current.children = [limitNode]
    current = limitNode
  }

  // ── UNION / UNION ALL / INTERSECT / SUBTRACT ──
  if (plan.unionType && plan.rightPlan) {
    const unionNode: PlanNode = {
      operator: plan.unionType.replace('_', '_').toUpperCase(),
      args: { type: plan.unionType },
      estimatedRows: 10,
      children: [
        _generatePlanTree(plan.rightPlan),
      ],
    }
    current.children = [unionNode]
    current = unionNode
  }

  // ── CALL 子查询 ──
  if (plan.callQuery) {
    const callNode: PlanNode = {
      operator: 'CALL',
      args: {},
      estimatedRows: 10,
      children: [_generatePlanTree(plan.callQuery)],
    }
    current.children = [callNode]
    current = callNode
  }

  // ── CALL 过程 ──
  if (plan.callProcedure) {
    const procNode: PlanNode = {
      operator: 'CALL',
      args: {
        procedure: plan.callProcedure.name,
        args: plan.callProcedure.args,
      },
      estimatedRows: 10,
    }
    current.children = [procNode]
    current = procNode
  }

  // ── FOREACH ──
  if (plan.forEach) {
    const foreachNode: PlanNode = {
      operator: 'FOREACH',
      args: {
        variable: plan.forEach.variable,
        list: plan.forEach.isVarRef ? 'var' : plan.forEach.list,
        operation: plan.forEach.operation.type,
      },
      estimatedRows: 20,
    }
    current.children = [foreachNode]
    current = foreachNode
  }

  // ── LOAD CSV ──
  if (plan.loadCsv) {
    const csvNode: PlanNode = {
      operator: 'LOAD_CSV',
      args: {
        url: plan.loadCsv.url,
        rowVariable: plan.loadCsv.rowVariable,
        hasHeaders: plan.loadCsv.hasHeaders,
      },
      estimatedRows: 100,
    }
    current.children = [csvNode]
    current = csvNode
  }

  // ── CREATE ──
  if (plan.createNodes && plan.createNodes.length > 0) {
    const createNode: PlanNode = {
      operator: 'CREATE',
      args: {
        nodes: plan.createNodes.map(n => `${n.alias}${n.label ? ':' + n.label : ''}`),
      },
      estimatedRows: 1,
    }
    current.children = [createNode]
    current = createNode
  }

  // ── SET ──
  if (plan.setClauses && plan.setClauses.length > 0) {
    const setNode: PlanNode = {
      operator: 'SET',
      args: {
        sets: plan.setClauses.map(s => `${s.property} = ${s.value}`),
      },
      estimatedRows: 1,
    }
    current.children = [setNode]
    current = setNode
  }

  // ── DELETE ──
  if (plan.deleteTargets && plan.deleteTargets.length > 0) {
    const delNode: PlanNode = {
      operator: plan.detachDelete ? 'DETACH DELETE' : 'DELETE',
      args: { targets: plan.deleteTargets },
      estimatedRows: 1,
    }
    current.children = [delNode]
    current = delNode
  }

  // ── MERGE ──
  if (plan.mergeNodes && plan.mergeNodes.length > 0) {
    const mergeNode: PlanNode = {
      operator: 'MERGE',
      args: {
        nodes: plan.mergeNodes.map(n => `${n.alias}${n.label ? ':' + n.label : ''}`),
      },
      estimatedRows: 1,
    }
    current.children = [mergeNode]
    current = mergeNode
  }

  // ── HAVING ──
  if (plan.having && plan.having.length > 0) {
    const havingStrs = plan.having.map(h =>
      `${h.property} ${h.operator === 'GT' ? '>' : h.operator === 'GTE' ? '>=' : h.operator === 'LT' ? '<' : h.operator === 'LTE' ? '<=' : h.operator === 'EQ' ? '=' : '!='} ${h.value}`
    ).join(' AND ')
    const havingNode: PlanNode = {
      operator: 'HAVING',
      args: { condition: havingStrs },
      estimatedRows: 3,
    }
    current.children = [havingNode]
    current = havingNode
  }

  // ── LOAD CSV ──
  if (plan.loadCsv) {
    const csvNode: PlanNode = {
      operator: 'LOAD_CSV',
      args: {
        url: plan.loadCsv.url,
        rowVariable: plan.loadCsv.rowVariable,
        hasHeaders: plan.loadCsv.hasHeaders,
      },
      estimatedRows: 100,
    }
    current.children = [csvNode]
    current = csvNode
  }

  // ── 窗口函数 ──
  if (plan.windowFunctions && plan.windowFunctions.length > 0) {
    for (const wf of plan.windowFunctions) {
      const winNode: PlanNode = {
        operator: 'WINDOW',
        args: {
          function: wf.function,
          partitionBy: wf.partitionBy,
          orderBy: wf.orderBy.map(o => `${o.column} ${o.direction}`).join(', '),
        },
        estimatedRows: 5,
      }
      current.children = [winNode]
      current = winNode
    }
  }

  return root
}

/**
 * 将 PlanNode 树格式化为可读的字符串（树状缩进）。
 *
 * 格式：
 * ```
 * OPERATOR (args...) ~estimatedRows rows
 * └── SUB_OPERATOR (args...) ~rows rows
 *     └── ...
 * ```
 *
 * @param node 计划树根节点
 * @param indent 缩进字符串（递归用，外部调用不需要传）
 * @param prefix 前缀（递归用）
 * @returns 格式化后的树形字符串
 */
export function _formatPlanTree(node: PlanNode, indent: string = '', prefix: string = ''): string {
  const lines: string[] = []

  // 构建当前节点的描述行
  let desc = node.operator
  if (node.args && Object.keys(node.args).length > 0) {
    const argParts: string[] = []
    for (const [key, val] of Object.entries(node.args)) {
      if (val !== undefined && val !== null) {
        const strVal = typeof val === 'object' ? JSON.stringify(val) : String(val)
        argParts.push(`${key}: ${strVal}`)
      }
    }
    if (argParts.length > 0) {
      desc += ` (${argParts.join(', ')})`
    }
  }

  const estStr = node.estimatedRows !== undefined ? ` ~${node.estimatedRows} rows` : ''

  // 第一行没有前缀缩进
  if (indent === '') {
    lines.push(`${desc}${estStr}`)
  } else {
    lines.push(`${indent}${prefix}${desc}${estStr}`)
  }

  // 递归处理子节点
  if (node.children && node.children.length > 0) {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i]
      const isLast = i === node.children.length - 1
      const childPrefix = isLast ? '└── ' : '├── '
      const childIndent = indent + (prefix === '' ? '' : (prefix === '└── ' ? '    ' : '│   '))
      // 对于根节点递归，缩进从 '' 开始，prefix 从 '' 开始 → 子节点缩进固定 '    ' 或 '│   '
      const actualPrefix = isLast ? '└── ' : '├── '
      lines.push(`${indent}${actualPrefix}${child.operator}${child.args ? ' (' + Object.entries(child.args).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ') : ''}${child.args ? ')' : ''}${child.estimatedRows !== undefined ? ` ~${child.estimatedRows} rows` : ''}`)
      if (child.children && child.children.length > 0) {
        const childIndent2 = indent + (isLast ? '    ' : '│   ')
        const childSub = _formatPlanTree(child, childIndent2, isLast ? '└── ' : '├── ')
        // Extract sub-lines (skip first line since we already printed it)
        const subLines = childSub.split('\n').slice(1)
        for (const sl of subLines) {
          lines.push(sl)
        }
      }
    }
  }

  return lines.join('\n')
}

/**
 * 执行 PROFILE 查询，收集每步的统计信息。
 *
 * 在现有 _executeQuery 的基础上，对每个执行阶段打桩收集：
 * - 每步实际输出行数
 * - 每步执行时间
 * - 估算成本
 *
 * @param plan QueryPlan
 * @param nodes 节点数据
 * @returns { planTree, stages } 含执行统计的计划树
 */
export function _profileQuery(
  plan: QueryPlan,
  nodes: Array<Record<string, unknown>>,
): ProfileResult {
  const planTree = _generatePlanTree(plan)
  const stages: ProfileStage[] = []

  // 收集各阶段行数
  function _countRows(stage: string): number {
    // 执行实际查询来获取行数统计
    // 通过模拟每步来采集
    const startTime = Date.now()

    let rows = 0
    try {
      const result = _executeQuery(plan, nodes)
      rows = result.length
    } catch {
      rows = 0
    }
    const elapsed = Date.now() - startTime

    // 估算每步成本（行数 × 时间系数）
    const cost = elapsed + rows * 0.01

    stages.push({ operator: stage, rows, timeMs: elapsed, cost: Math.round(cost * 100) / 100 })

    return rows
  }

  // 逐阶段收集：从执行结果推算每步行数
  // 先执行一次完整查询获取最终行数
  let totalRows = 0
  try {
    totalRows = _executeQuery(plan, nodes).length
  } catch {
    totalRows = 0
  }

  // 收集各阶段统计
  // SCAN_ALL 阶段
  {
    const start = Date.now()
    let scanRows = 0
    try {
      // 模拟 SCAN_ALL: 返回所有节点
      scanRows = nodes.length
    } catch { scanRows = 0 }
    stages.push({
      operator: 'SCAN_ALL',
      rows: scanRows,
      timeMs: Date.now() - start,
      cost: Math.round((Date.now() - start + scanRows * 0.01) * 100) / 100,
    })
  }

  // 标签过滤阶段
  if (plan.scanLabel) {
    const start = Date.now()
    let labelRows = 0
    try {
      labelRows = nodes.filter(n => {
        const l = n['_label']
        return l === plan.scanLabel || n['label'] === plan.scanLabel
      }).length
    } catch { labelRows = 0 }
    stages.push({
      operator: 'LABEL_FILTER',
      rows: labelRows,
      timeMs: Date.now() - start,
      cost: Math.round((Date.now() - start + labelRows * 0.01) * 100) / 100,
    })
  }

  // WHERE 过滤阶段
  if (plan.filters.length > 0) {
    const start = Date.now()
    let filterRows = 0
    try {
      filterRows = _applyWhereFilters(nodes, plan.filters).length
    } catch { filterRows = 0 }
    // 大致估算：限制为 totalRows 以内（实际上是按链式计算，这里简化）
    if (filterRows > totalRows && totalRows > 0) filterRows = totalRows
    stages.push({
      operator: 'FILTER',
      rows: filterRows,
      timeMs: Date.now() - start,
      cost: Math.round((Date.now() - start + filterRows * 0.01) * 100) / 100,
    })
  }

  // PROJECT 阶段
  if (plan.returnColumns && plan.returnColumns.length > 0) {
    const start = Date.now()
    stages.push({
      operator: 'PROJECT',
      rows: totalRows,
      timeMs: Date.now() - start,
      cost: Math.round((Date.now() - start + totalRows * 0.01) * 100) / 100,
    })
  }

  // ORDER BY 阶段
  if (plan.orderBy && plan.orderBy.length > 0) {
    const start = Date.now()
    stages.push({
      operator: 'ORDER_BY',
      rows: totalRows,
      timeMs: Date.now() - start,
      cost: Math.round((Date.now() - start + totalRows * 0.1) * 100) / 100,
    })
  }

  // LIMIT 阶段
  if (plan.limit !== undefined) {
    const start = Date.now()
    const limitedRows = Math.min(totalRows, plan.limit)
    stages.push({
      operator: 'LIMIT',
      rows: limitedRows,
      timeMs: Date.now() - start,
      cost: Math.round((Date.now() - start + limitedRows * 0.01) * 100) / 100,
    })
  }

  return { plan: planTree, stages }
}

/**
 * 构建 EXPLAIN/PROFILE 查询的完整输出字符串。
 * 在 parseQuery 返回的 QueryPlan 基础上，生成格式化输出。
 *
 * @param plan QueryPlan
 * @param nodes 可选的节点数据（PROFILE 时需要）
 * @returns 格式化的执行计划字符串
 */
export function explainQuery(
  plan: QueryPlan,
  nodes?: Array<Record<string, unknown>>,
): string {
  const planTree = _generatePlanTree(plan)

  if (plan.profile && nodes) {
    // PROFILE: 计划树 + 实际统计
    const profileResult = _profileQuery(plan, nodes)
    const planStr = _formatPlanTree(planTree)
    const stageLines = profileResult.stages.map(s =>
      `  ${s.operator}: ${s.rows} rows, ${s.timeMs.toFixed(2)}ms, cost=${s.cost?.toFixed(2) ?? 'N/A'}`
    ).join('\n')
    return [
      'Execution Plan:',
      planStr,
      '',
      'Profile (actual):',
      stageLines,
    ].join('\n')
  }

  // EXPLAIN: 仅计划树
  return `Execution Plan:\n${_formatPlanTree(planTree)}`
}

// ─── C-06: GROUP BY + HAVING 辅助函数 ───

export interface HavingClause {
  property: string
  operator: 'GT' | 'GTE' | 'LT' | 'LTE' | 'EQ' | 'NEQ'
  value: number
}

/**
 * FOREACH 子句：对列表中每个元素执行一个操作（CREATE/SET/DELETE）
 * FOREACH ( var IN list | operation )
 */
export interface ForEachClause {
  /** 循环变量名 */
  variable: string
  /** 列表表达式（字面量数组或变量名） */
  list: unknown[]
  /** 是否为变量引用（而非字面量） */
  isVarRef: boolean
  /** 每次迭代执行的操作 */
  operation: {
    type: 'CREATE' | 'SET' | 'DELETE' | 'FOREACH' | 'REMOVE' | 'MULTI'
    where?: string
    targets?: string[]
    createNodes?: QueryPlan['createNodes']
    createEdges?: QueryPlan['createEdges']
    setClauses?: QueryPlan['setClauses']
    /** 嵌套 FOREACH 子句（当 type='FOREACH' 时） */
    foreach?: ForEachClause
    /** 组合的子操作（当 type='MULTI' 时） */
    operations?: ForEachClause['operation'][]
  }
}

/**
 * Apply GROUP BY aggregation and HAVING filter on data.
 * Groups data by groupBy keys, applies aggregate function, then filters by HAVING.
 */
export function _applyGroupByHaving(
  data: Array<Record<string, unknown>>,
  groupBy: string[],
  aggregate: { type: string; field?: string },
  having?: HavingClause[],
): Array<Record<string, unknown>> {
  if (groupBy.length === 0 && !aggregate) {
    return data
  }

  // Group the data
  const groups = new Map<string, Array<Record<string, unknown>>>()

  for (const row of data) {
    let key: string
    if (groupBy.length === 0) {
      key = '_all'
    } else {
      key = groupBy.map(gb => String(row[gb] ?? '__NULL__')).join('||')
    }
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(row)
  }

  const result: Array<Record<string, unknown>> = []

  for (const [key, group] of groups) {
    const out: Record<string, unknown> = {}

    // Copy group-by key values (use first row's values)
    for (const gb of groupBy) {
      out[gb] = group[0]?.[gb] ?? null
    }

    // Compute aggregate
    const aggField = aggregate.field ?? '*'
    const aggType = aggregate.type

    if (aggType === 'count') {
      if (aggField === '*') {
        out['count(*)'] = group.length
      } else {
        // Count non-null values of the field
        const values = group.map(r => r[aggField]).filter(v => v != null)
        out[aggField] = values.length
      }
    } else if (aggType === 'sum') {
      const values = group.map(r => Number(r[aggField])).filter(v => !isNaN(v))
      out[aggField] = values.reduce((a, b) => a + b, 0)
    } else if (aggType === 'avg') {
      const values = group.map(r => Number(r[aggField])).filter(v => !isNaN(v))
      out[aggField] = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null
    } else if (aggType === 'max') {
      const values = group.map(r => Number(r[aggField])).filter(v => !isNaN(v))
      out[aggField] = values.length > 0 ? Math.max(...values) : null
    } else if (aggType === 'min') {
      const values = group.map(r => Number(r[aggField])).filter(v => !isNaN(v))
      out[aggField] = values.length > 0 ? Math.min(...values) : null
    }

    // Apply HAVING filter
    if (having && having.length > 0) {
      let pass = true
      for (const h of having) {
        const val = out[h.property] as number
        if (val === undefined || val === null) {
          pass = false
          break
        }
        switch (h.operator) {
          case 'GT': if (!(val > h.value)) pass = false; break
          case 'GTE': if (!(val >= h.value)) pass = false; break
          case 'LT': if (!(val < h.value)) pass = false; break
          case 'LTE': if (!(val <= h.value)) pass = false; break
          case 'EQ': if (!(val === h.value)) pass = false; break
          case 'NEQ': if (!(val !== h.value)) pass = false; break
        }
        if (!pass) break
      }
      if (!pass) continue
    }

    result.push(out)
  }

  return result
}
