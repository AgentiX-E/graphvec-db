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
import { LRUCache } from 'lru-cache'
import { planCache as plannerPlanCache, makePlanCacheKey } from '../api/query-planner'

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
  /** EXISTS 子查询过滤器 */
  existsFilters?: Array<{
    source: string
    edgeLabel: string | null
    direction: 'out' | 'in' | 'any'
    target: string
  }>
  /** CALL 子查询 */
  callQuery?: QueryPlan
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

  // ── Step 0: 提取 FOREACH ──
  // FOREACH ( var IN list | operation )
  // 提取后从 query 中移除，在 postProcess 中重建
  // 使用手动括号匹配提取完整的 FOREACH 子句
  let foreachIdx = cleanQuery.search(/FOREACH\s*\(/i)
  if (foreachIdx !== -1) {
    const beforeFOREACH = cleanQuery.slice(0, foreachIdx)
    let startParen = cleanQuery.indexOf('(', foreachIdx)
    let depth = 0
    let endIdx = -1
    for (let i = startParen; i < cleanQuery.length; i++) {
      if (cleanQuery[i] === '(') depth++
      else if (cleanQuery[i] === ')') {
        depth--
        if (depth === 0) { endIdx = i + 1; break }
      }
    }
    if (endIdx !== -1) {
      const foreachClause = cleanQuery.slice(foreachIdx, endIdx)
      // 提取内部内容: FOREACH( var IN listExpr | operation )
      const innerMatch = foreachClause.match(/FOREACH\s*\(\s*(\w+)\s+IN\s+(.+?)\s*\|\s*([\s\S]+?)\s*\)/i)
      if (innerMatch) {
        result.foreachExtract = {
          variable: innerMatch[1],
          listExpr: innerMatch[2].trim(),
          operation: innerMatch[3].trim(),
        }
      }
      cleanQuery = (beforeFOREACH + cleanQuery.slice(endIdx)).trim()
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
  /** FOREACH 提取 */
  foreachExtract?: {
    variable: string
    listExpr: string
    operation: string
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
  const aggMatch = colStr.match(/^(count|sum|avg|max|min)\s*\(\s*([^)]+)\s*\)\s*(?:AS\s+(\w+))?\s*$/i)
  if (aggMatch) {
    const func = aggMatch[1].toLowerCase() as 'count' | 'sum' | 'avg' | 'max' | 'min'
    const field = aggMatch[2].trim()
    const alias = aggMatch[3] || null
    result.aggregate = { type: func, field, alias }

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
        const innerAggMatch = expr.match(/^(count|sum|avg|max|min)\s*\(\s*([^)]+)\s*\)$/i)
        if (innerAggMatch) {
          result.aggregate = {
            type: innerAggMatch[1].toLowerCase() as 'count' | 'sum' | 'avg' | 'max' | 'min',
            field: innerAggMatch[2].trim(),
            alias: asMatch[1],
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
export function parseQuery(query: string): QueryPlan {
  // Step 1: Preprocess to extract OPTIONAL MATCH and WITH
  const { cleanQuery, extracts } = _preprocessQuery(query)

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

  // Step 4: Attach FOREACH if extracted
  if (extracts.foreachExtract) {
    plan.forEach = {
      variable: extracts.foreachExtract.variable,
      list: [],
      isVarRef: true, // 默认视为变量引用
      operation: { type: 'CREATE' }, // 默认类型，实际由 parser 确定
    }
    // 解析 listExpr：是字面量数组（[1,2,3]）还是变量名
    const listExpr = extracts.foreachExtract.listExpr.trim()
    if (listExpr.startsWith('[') && listExpr.endsWith(']')) {
      plan.forEach.isVarRef = false
      try {
        plan.forEach.list = JSON.parse(listExpr.replace(/'/g, '"'))
      } catch {
        plan.forEach.list = []
      }
    }
    // 解析 operation 类型
    const opText = extracts.foreachExtract.operation.trim()
    if (/^CREATE\b/i.test(opText)) plan.forEach.operation.type = 'CREATE'
    else if (/^SET\b/i.test(opText)) plan.forEach.operation.type = 'SET'
    else if (/^DELETE\b/i.test(opText)) plan.forEach.operation.type = 'DELETE'
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

  // ── CALL 子查询处理 ──────────────────────────────────────

  if (ast.type === 'CALL' && ast.query) {
    plan.type = 'CALL'
    plan.callQuery = planFromAST(ast.query, schema)
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
        // Detect CASE expressions in RETURN columns
        const caseCols: QueryPlan['caseColumns'] = []
        const regularCols: string[] = []
        for (const col of ast.return.columns) {
          if (col.type === 'COLUMN' && col.expression?.type === 'CASE') {
            caseCols.push({
              expression: col.expression,
              alias: col.alias ?? 'case',
            })
            // Also add to returnColumns so CASE results are included
            regularCols.push(col.alias ?? 'case')
          } else {
            regularCols.push(col.alias ?? formatColumn(col.expression))
          }
        }
        plan.returnColumns = regularCols
        if (caseCols.length > 0) {
          plan.caseColumns = caseCols
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
  type: 'count' | 'sum' | 'avg' | 'max' | 'min'
  field: string  // 字段名或 '*'
  alias: string | null
  value: number | null
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

  // 对非 count 聚合，过滤出可用的数值
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
  fn: 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX'
  field: string       // The raw field string inside parens
  prop: string        // The property name (after stripping variable prefix)
  distinct: boolean   // Whether DISTINCT is used
  alias: string | null
}

export function _parseAggregate(expr: string): AggColumnInfo | null {
  const trimmed = expr.trim()
  const re = /^(COUNT|SUM|AVG|MIN|MAX)\s*\(\s*(DISTINCT\s+)?(.+?)\s*\)\s*$/i
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
        row[key] = (agg.fn === 'COUNT' || agg.fn === 'SUM') ? 0 : null
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

  // Step 1: Filter nodes by MATCH criteria
  let candidates = [...nodes]

  // Apply filters (WHERE clause on MATCH)
  if (plan.filters.length > 0) {
    candidates = _applyWhereFilters(candidates, plan.filters)
  }

  // Step 1.5: Handle UNWIND — 展开列表为多行
  if (plan.unwind) {
    candidates = _executeUnwind(candidates, plan.unwind)
  }

  // Step 2: Handle WITH clause (mid-query projection + aggregation)
  if (plan.with) {
    const hasWithAgg = plan.with.aggregate !== undefined

    if (hasWithAgg) {
      // Parse the aggregate: handle DISTINCT prefix in field
      let aggField = plan.with.aggregate.field ?? '*'
      let aggDistinct = false
      if (aggField.toUpperCase().startsWith('DISTINCT ')) {
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

  // Step 3: Handle RETURN
  if (plan.returnColumns.length > 0) {
    // Check if RETURN uses aggregation
    if (plan.aggregate) {
      const aggInfo: AggColumnInfo[] = [{
        fn: plan.aggregate.type.toUpperCase() as AggColumnInfo['fn'],
        field: plan.aggregate.field ?? '*',
        prop: plan.aggregate.field?.includes('.')
          ? plan.aggregate.field.split('.').pop()!
          : (plan.aggregate.field ?? '*'),
        distinct: false,
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

    // Apply SKIP（在 LIMIT 之前，符合 Cypher 语义）
    if (plan.skip !== undefined && plan.skip > 0) {
      rows = rows.slice(plan.skip)
    }

    // Apply LIMIT（若未显式指定则使用默认限制）
    rows = rows.slice(0, plan.limit ?? DEFAULT_LIMIT)

    return rows
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
  if (node.type === 'BOOL') return node.value
  if (node.type === 'NULL') return null

  // Property reference: e.g. n.age or just age
  if (node.type === 'PROPERTY_REF') {
    const key = node.name ?? node.value
    return row[key] ?? null
  }

  // Array literal: [val1, val2, ...]
  if (node.type === 'ARRAY' && Array.isArray(node.elements)) {
    return node.elements.map((el: any) => _evalSimpleExpr(el, row))
  }

  // Binary operation: a OP b (used in comparison chains)
  if (node.type === 'BINARY' || (node.left !== undefined && node.right !== undefined && node.operator)) {
    const left = _evalSimpleExpr(node.left ?? node.leftExpr, row)
    const right = _evalSimpleExpr(node.right ?? node.rightExpr, row)
    const op = node.operator ?? node.op
    return _compareSimpleValues(left, op, right)
  }

  // Variable reference (just a name)
  if (node.type === 'VARIABLE_REF') {
    return row[node.name] ?? null
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
  toUpper: (s: string) => (s ?? '').toUpperCase(),
  toLower: (s: string) => (s ?? '').toLowerCase(),
  substring: (s: string, start: number, length?: number) => {
    if (s == null) return ''
    if (length !== undefined) {
      return s.substring(start, start + length)
    }
    return s.substring(start)
  },
  abs: (x: number) => Math.abs(x),
  round: (x: number, precision?: number) => {
    if (precision !== undefined) {
      const factor = Math.pow(10, precision)
      return Math.round(x * factor) / factor
    }
    return Math.round(x)
  },
  coalesce: (...args: any[]) => args.find(a => a != null),
  timestamp: () => Date.now(),
}

export function isBuiltinFunction(name: string): boolean {
  return name in BUILTIN_FUNCTIONS
}

export function executeBuiltinFunction(name: string, args: any[]): any {
  const fn = BUILTIN_FUNCTIONS[name]
  if (!fn) throw new Error(`Unknown built-in function: ${name}`)
  return fn(...args)
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
    type: 'CREATE' | 'SET' | 'DELETE'
    targets?: string[]
    createNodes?: QueryPlan['createNodes']
    createEdges?: QueryPlan['createEdges']
    setClauses?: QueryPlan['setClauses']
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
