// ============================================================
// ast-to-plan-v2.ts — ANTLR Cypher AST → QueryPlan 转换器
//
// 使用 @neo4j-cypher/antlr4 解析 Cypher 查询，
// 将 ANTLR 的 AST 转换为现有的 QueryPlan 结构（query-engine.ts）。
// ============================================================

import { default as antlr4 } from 'antlr4'
import {
  CypherLexer,
  CypherParser,
  CypherListener,
} from '@neo4j-cypher/antlr4'

/**
 * Splits a comma-separated list of values, handling nested brackets.
 */
function _splitListItems(s: string): string[] {
  const items: string[] = []
  let depth = 0
  let current = ''
  let inStr = false
  let strChar = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (ch === strChar) inStr = false
      current += ch
    } else if (ch === "'" || ch === '"') {
      inStr = true
      strChar = ch
      current += ch
    } else if (ch === '[' || ch === '{' || ch === '(') {
      depth++
      current += ch
    } else if (ch === ']' || ch === '}' || ch === ')') {
      depth--
      current += ch
    } else if (ch === ',' && depth === 0) {
      items.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) items.push(current.trim())
  return items
}

// ═══════════════════════════════════════════════════════════════
// QueryPlan 类型定义（与 query-engine.ts 接口兼容）
// ═══════════════════════════════════════════════════════════════

export interface QueryPlan {
  type?: 'QUERY' | 'CREATE' | 'DELETE' | 'SET' | 'MERGE' | 'CALL' | 'USE' | 'CREATE_CONSTRAINT' | 'BEGIN' | 'COMMIT' | 'ROLLBACK'
  useGraph?: string
  explain?: boolean
  profile?: boolean
  indexOp?: 'CREATE' | 'DROP'
  indexLabel?: string
  indexProperty?: string
  scanLabel: string | null
  labelExpr: { type: 'LABEL_EXPR'; items: Array<{ exclude: boolean; name: string }> } | null
  steps: TraverseStep[]
  filters: FilterClause[]
  returnColumns: string[]
  expressionColumns?: Array<{ expression: any; alias: string }>
  constColumns?: Array<{ alias: string; value: unknown }>
  orderBy: Array<{ property: string; direction: 'ASC' | 'DESC' }>
  limit: number | undefined
  skip: number | undefined
  hasMatch?: boolean
  aggregate?: AggregateClause
  groupBy?: string[]
  having?: HavingClause[]
  optionalMatchSteps?: Array<{
    scanLabel: string | null
    steps: TraverseStep[]
    filters: FilterClause[]
  }>
  with?: {
    columns: Array<{ expression: string; alias: string | null }>
    filters: FilterClause[]
    orderBy: Array<{ property: string; direction: 'ASC' | 'DESC' }>
    limit: number | undefined
    skip: number | undefined
    aggregate?: AggregateClause
  }
  unionType?: 'union' | 'union_all' | 'intersect' | 'subtract'
  rightPlan?: QueryPlan
  unwind?: { list: any[]; name: string; var?: string }
  secondUnwind?: { list: any[]; name: string; var?: string }
  caseColumns?: Array<{ expression: any; alias: string }>
  comprehensionColumns?: Array<{ expression: any; alias: string }>
  existsFilters?: Array<{ source: string; edgeLabel: string | null; direction: 'out' | 'in' | 'any'; target: string }>
  listColumns?: Array<{ expression: any; alias: string }>
  callQuery?: QueryPlan
  inTransactions?: boolean
  inTransactionsBatchSize?: number
  callProcedure?: { name: string; args: any[]; yieldItems?: Array<{ name: string; alias: string | null }> }
  forEach?: ForEachClause
  reduce?: { accumulator: string; initial: unknown; variable: string; list: unknown[]; isVarRef: boolean; expression: string }
  loadCsv?: { url: string; rowVariable: string; hasHeaders: boolean; delimiter: string }
  windowFunctions?: Array<{ function: string; partitionBy: string[]; orderBy: Array<{ column: string; direction: 'ASC' | 'DESC' }> }>
  show?: string
  /** CATALOG 操作（多图命名空间） */
  catalogOp?: 'CREATE_DATABASE' | 'DROP_DATABASE' | 'SHOW_DATABASES'
  search?: { targetProperty: string; queryVector: number[]; topK: number }
  createNodes?: Array<{ alias: string; label: string | null; props: Record<string, unknown> | null }>
  createEdges?: Array<{ source: string; target: string; label: string | null; direction: 'out' | 'in' | 'any'; props?: Record<string, unknown> | null }>
  deleteTargets?: string[]
  detachDelete?: boolean
  setClauses?: Array<{ property?: string; value?: unknown; alias?: string; expression?: string; kind?: 'PROP' | 'LABEL' | 'MAP' | 'MAP_APPEND'; labels?: string[]; props?: Record<string, unknown> }>
  removeClauses?: Array<{ type: 'REMOVE_PROP' | 'REMOVE_LABEL'; property?: string; ref?: string; label?: string }>
  mergeNodes?: Array<{ alias: string; label: string | null; props: Record<string, unknown> | null }>
  mergeEdges?: Array<{ source: string; target: string; label: string | null; direction: 'out' | 'in' | 'any' }>
  mergeOnCreate?: Array<{ property: string; value: unknown }>
  mergeOnMatch?: Array<{ property: string; value: unknown }>
  periodicCommit?: { batchSize?: number }
  constraint?: { label: string; property: string }
  [key: string]: any
}

export interface TraverseStep {
  source: string
  direction: 'out' | 'in' | 'any'
  edgeLabel: string | null
  targetAlias: string
  targetLabel: string | null
  targetProps: Record<string, unknown> | null
  edgeProps?: Record<string, unknown> | null
  range?: { min: number; max: number | null }
  pathVariable?: string | null  /** MATCH p = (n)-->() path variable */
}

export interface FilterClause {
  source: string
  property: string
  operator: 'EQ' | 'NEQ' | 'GT' | 'GTE' | 'LT' | 'LTE' | 'IN' | 'STARTS_WITH' | 'ENDS_WITH' | 'CONTAINS' | 'IS_NULL' | 'IS_NOT_NULL'
  value: unknown
  negated?: boolean
  /** 复合表达式（算术/函数）左侧，如 `n.num % 2`。存在时 source/property 为空，执行层用 _evaluateExpression 求值。 */
  expression?: string
}

export interface ForEachClause {
  list: any[]
  name: string
  updates: Array<{
    type: 'CREATE' | 'SET' | 'REMOVE' | 'DELETE' | 'MERGE'
    alias: string
    label?: string
    props?: Record<string, unknown>
    source?: string
    target?: string
    edgeLabel?: string
    direction?: 'out' | 'in' | 'any'
    property?: string
    value?: string
  }>
}

interface AggregateClause {
  function: string  // 'count' | 'sum' | 'avg' | 'max' | 'min' | 'collect'
  column: string
  distinct?: boolean
  alias?: string
}

interface HavingClause {
  aggregate: string
  operator: string
  value: unknown
}

// ═══════════════════════════════════════════════════════════════
// 内部解析中间表示
// ═══════════════════════════════════════════════════════════════

interface ParsedMatch {
  variable: string | null
  label: string | null
  edges: ParsedEdgeStep[]
  properties: Record<string, unknown> | null
  /**
   * Comma-separated pattern parts, each an ordered chain of edge steps.  A
   * single chained pattern like `(a)-->(x)-->(b)` yields one part
   * `[[a→x, x→b]]`; comma-separated parts like `(a)-->(x),(b)-->(x)` yield
   * `[[a→x],[b→x]]`.  This preserves the boundary the flat `edges` array loses,
   * so the executor can treat each part as an independent join pattern instead
   * of chaining them into a single walk.
   */
  parts: ParsedEdgeStep[][]
  /**
   * Additional disjoint bound node patterns from a comma-separated MATCH such
   * as `MATCH (a {name:'A'}), (c {name:'C'}) MATCH (a)-->(b)`.  Each entry is a
   * bare node (no relationship) that must be bound alongside the primary
   * variable so later patterns can join on it (e.g. `c` above).  Without this,
   * the trailing comma-separated bindings are silently dropped.
   */
  extraNodes: Array<{ variable: string; label: string | null; properties: Record<string, unknown> | null }>
}

interface ParsedEdgeStep {
  source: string
  direction: 'out' | 'in' | 'any'
  edgeLabel: string | null
  targetAlias: string
  targetLabel: string | null
  targetProps: Record<string, unknown> | null
  edgeProps?: Record<string, unknown> | null
  range?: { min: number; max: number | null }
  /** relationship variable from `MATCH ()-[a]->()` */
  edgeVariable?: string | null
  /** inline property predicate on the source node, e.g. `MATCH (a {name:'A'})-[*]->(x)` */
  sourceProps?: Record<string, unknown> | null
}

interface ParsedReturn {
  columns: Array<{ expression: string; alias: string | null }>
  orderBy: Array<{ property: string; direction: 'ASC' | 'DESC' }>
  limit: number | undefined
  skip: number | undefined
  aggregate: AggregateClause | undefined
  aggregates: AggregateClause[] | undefined
}

interface ParsedClause {
  type: string
  ctx: any
}

// ═══════════════════════════════════════════════════════════════
// 主入口: 解析 Cypher 查询 → QueryPlan
// ═══════════════════════════════════════════════════════════════

export function parseCypherToPlan(query: string): QueryPlan {
  const plan = buildQueryPlan(query)
  // Post-processing: fix ANTLR return columns that were truncated by unrecognized tokens
  // (e.g., octal 0o77 → "0", sci notation 2E+01 → "2", list [1, 0o77] → "[1")
  postProcessReturnColumns(plan, query)
  return plan
}

/**
 * Fix return columns that ANTLR truncated due to unrecognized tokens.
 * ANTLR Cypher grammar doesn't support octal (0o77) or scientific (2E+01) literals,
 * so these get tokenized as e.g. "0" + "o77". The parser only gets "0" and the
 * remaining token goes to error recovery, resulting in a truncated ReturnItemContext.
 *
 * This function uses the original query text to rebuild any truncated expressions.
 */
function postProcessReturnColumns(plan: QueryPlan, query: string): void {
  // Only process plans with expressionColumns (RETURN or WITH)
  if (!plan.expressionColumns?.length) return

  // A UNION plan (left side merged into `plan`, right side in `plan.rightPlan`)
  // is ALREADY post-processed: `parseUnion` recursed through the full
  // `parseCypherToPlan` on both sides, so each side's RETURN expressions were
  // rebuilt against its own sub-query text.  Running this pass again against the
  // WHOLE union text would rewrite the left side's expression to
  // "… UNION <right>" (the `RETURN\s+(…)$` regex does not stop at UNION).
  if (plan.unionType && plan.rightPlan) return

  // Find the RETURN clause region in the query
  // Use [\s\S] to match across newlines (multi-line queries)
  // Must exclude ORDER BY, GROUP BY, HAVING, LIMIT, SKIP clauses from the return part
  const returnMatch = query.match(/\bRETURN\s+([\s\S]+?)(?:\s+(?:ORDER\s+BY|GROUP\s+BY|HAVING|LIMIT|SKIP)|$)/i)
  if (!returnMatch) return

  const returnPart = returnMatch[1]
  const items = splitByTopLevelCommas(returnPart)

  // ── Detect column count mismatch ──
  // ANTLR's error recovery can produce either too few columns (dropped after unrecognized token)
  // or too many columns (treating list/map internals as separate return items).
  // Rebuild ALL columns from the query text when mismatch is detected.
  let needsRebuild = false
  if (items.length !== plan.expressionColumns.length) {
    needsRebuild = true
  } else {
    // Same count: check if any expression is truncated
    for (let i = 0; i < plan.expressionColumns.length; i++) {
      const antlrExpr = plan.expressionColumns[i].expression
      const queryItem = items[i]?.trim() || ''
      if (!queryItem) continue
      if (antlrExpr !== queryItem) {
        // 提取 AS 前的原始表达式文本
        const rawExpr = queryItem.replace(/\s+AS\s+`?(`)?[^`]+`?$/i, '').trim()
        // Check if it's a genuine truncation
        const isTruncated =
          (rawExpr.startsWith(antlrExpr) && rawExpr !== antlrExpr) ||
          (rawExpr.endsWith('.' + antlrExpr) && rawExpr !== antlrExpr) ||
          (/^\d+$/.test(antlrExpr) && rawExpr.length > antlrExpr.length) ||
          (rawExpr.includes(',') && antlrExpr.includes(','))
        if (rawExpr.endsWith('.' + antlrExpr)) console.error('DEBUG truncation: should be true, raw:', rawExpr, 'antlr:', antlrExpr, 'isTruncated:', isTruncated, 'needsRebuild pre:', needsRebuild)
        if (isTruncated) { needsRebuild = true; break }
      }
    }
  }

  if (needsRebuild) {
    rebuildReturnColumns(plan, items)
    return
  }

  // ── No column count mismatch: fix individual truncated expressions ──
  for (let i = 0; i < items.length; i++) {
    const item = items[i].trim()
    if (!item) continue

    const backtickAsMatch = item.match(/^([\s\S]+?)\s+AS\s+`(\w+)`$/i)
    const asMatch = backtickAsMatch ?? item.match(/^([\s\S]+?)\s+AS\s+(\w+)$/i)
    let rawExpr: string
    let rawAlias: string | null
    if (asMatch) {
      rawExpr = asMatch[1].trim()
      rawAlias = asMatch[2]
    } else {
      rawExpr = item
      rawAlias = null
    }

    const antlrExpr = plan.expressionColumns[i].expression
    // When the expression is already correct but ANTLR's error recovery lost the
    // `AS alias` (e.g. an octal literal `0o2613152366` tokenizes as `0` + `o...`,
    // and the trailing `AS literal` gets swallowed), the alias is wrongly set to
    // the expression itself. Repair the alias even though the expression matches.
    if (rawAlias && plan.expressionColumns[i].alias !== rawAlias) {
      const oldKey = plan.returnColumns[i]
      plan.expressionColumns[i].alias = rawAlias
      plan.returnColumns[i] = rawAlias
      delete plan.returnAliasMap[oldKey]
      plan.returnAliasMap[rawAlias] = rawExpr
      continue
    }
    if (!antlrExpr || antlrExpr === rawExpr) continue

    const isTruncated =
      (typeof antlrExpr === 'string' && typeof rawExpr === 'string' &&
        rawExpr.startsWith(antlrExpr) && rawExpr !== antlrExpr) ||
      (typeof antlrExpr === 'string' && typeof rawExpr === 'string' &&
        rawExpr.endsWith('.' + antlrExpr) && rawExpr !== antlrExpr) ||
      (typeof antlrExpr === 'string' && /^\d+$/.test(antlrExpr) && rawExpr.length > antlrExpr.length) ||
      (typeof antlrExpr === 'string' && typeof rawExpr === 'string' && !rawExpr.includes(antlrExpr))

    if (isTruncated) {
      plan.expressionColumns[i].expression = rawExpr
      if (rawAlias) plan.expressionColumns[i].alias = rawAlias
      const oldKey = plan.returnColumns[i]
      const newKey = rawAlias ?? rawExpr
      if (oldKey !== newKey) {
        plan.returnColumns[i] = newKey
        delete plan.returnAliasMap[oldKey]
        plan.returnAliasMap[newKey] = rawExpr
      } else {
        plan.returnAliasMap[oldKey] = rawExpr
      }
    }
  }
}

/**
 * Rebuild all return columns from the query text when ANTLR parsed fewer columns
 * due to error recovery dropping unrecognized tokens.
 */
function rebuildReturnColumns(plan: QueryPlan, items: string[]): void {
  const newColumns: Array<{ expression: string; alias: string | null }> = []
  const newAliasMap: Record<string, string> = {}
  const newReturnCols: string[] = []

  for (const item of items) {
    const trimmed = item.trim()
    if (!trimmed) continue

    // 支持反引号别名（如 n.name AS `name`）
    const backtickAsMatch = trimmed.match(/^([\s\S]+?)\s+AS\s+`(\w+)`$/i)
    const asMatch = backtickAsMatch ?? trimmed.match(/^([\s\S]+?)\s+AS\s+(\w+)$/i)
    let expression: string
    let alias: string | null
    if (asMatch) {
      expression = asMatch[1].trim()
      alias = asMatch[2]
    } else {
      expression = trimmed
      alias = null
    }

    const key = (alias ?? expression).replace(/^\w+\./, '')
    newAliasMap[key] = expression
    newReturnCols.push(alias ?? expression)
    newColumns.push({ expression, alias: alias ?? expression })
  }

  plan.expressionColumns = newColumns
  plan.returnAliasMap = newAliasMap
  plan.returnColumns = newReturnCols
}

/**
 * Split a string by top-level commas (not inside brackets, parens, or braces).
 */
function splitByTopLevelCommas(s: string): string[] {
  const result: string[] = []
  let depth = 0
  let start = 0
  const matching = { '(': ')', '[': ']', '{': '}' }
  const openers = new Set(['(', '[', '{'])
  const closers = new Set([')', ']', '}'])
  const stack: string[] = []

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (openers.has(ch)) {
      stack.push(ch)
      depth++
    } else if (closers.has(ch)) {
      if (stack.length > 0) {
        const last = stack[stack.length - 1]
        if (matching[last as keyof typeof matching] === ch) {
          stack.pop()
          depth--
        }
      }
    } else if (ch === ',' && depth === 0) {
      result.push(s.substring(start, i))
      start = i + 1
    }
  }
  result.push(s.substring(start))
  return result
}

/**
 * Parse Cypher string into intermediate representation, then convert to QueryPlan.
 */
function buildQueryPlan(query: string): QueryPlan {
  let trimmed = query.trim()
  const upperQ = trimmed.toUpperCase()

  // ── 路径分配预处理: MATCH p = (a)-[*]->(b) → pathVar: 'p' ──
  // ANTLR 不认识 `p = (` 语法，需在 ANTLR 解析前从文本剥离路径变量前缀。
  // 存储到返回值后，从 trimmed 中移除 `\w+ = ` 前缀以便 ANTLR 正常解析模式。
  let pathVar: string | undefined
  const pathMatch = trimmed.match(/^(MATCH\s+)(\w+)\s*=\s*\(/i)
  if (pathMatch) {
    pathVar = pathMatch[2]
    // Strip only the `p = ` path-assignment token, keeping the leading
    // `MATCH ` keyword and the pattern's opening `(`.
    // `pathMatch[0]` already ends with `(`, so resume from that `(` instead of
    // re-adding one (which previously produced a doubled `((` that ANTLR read as
    // a spurious nested node pattern → duplicated traverse step).
    // `MATCH p = (a)-->()`  →  `MATCH (a)-->()`
    trimmed = pathMatch[1] + trimmed.substring(pathMatch.index! + pathMatch[0].length - 1)
  }

  // ── ADMIN COMMANDS: Handle before ANTLR parsing ──
  // These queries are not valid Cypher per the ANTLR grammar (SHOW, BEGIN, etc.)
  // or require custom handling. We detect them by text pattern and return
  // the correct QueryPlan directly.

  // SHOW commands
  if (upperQ === 'SHOW INDEXES') {
    const plan = createEmptyPlan()
    plan.show = { what: 'INDEXES' }
    return plan
  }
  if (upperQ === 'SHOW CONSTRAINTS') {
    const plan = createEmptyPlan()
    plan.show = { what: 'CONSTRAINTS' }
    return plan
  }
  if (upperQ === 'SHOW PROCEDURES') {
    const plan = createEmptyPlan()
    plan.show = { what: 'PROCEDURES' }
    return plan
  }
  if (upperQ === 'SHOW FUNCTIONS') {
    const plan = createEmptyPlan()
    plan.show = { what: 'FUNCTIONS' }
    return plan
  }
  if (upperQ === 'SHOW LABELS') {
    const plan = createEmptyPlan()
    plan.show = { what: 'LABELS' }
    return plan
  }
  if (upperQ === 'SHOW RELATIONSHIPTYPES') {
    const plan = createEmptyPlan()
    plan.show = { what: 'RELATIONSHIPTYPES' }
    return plan
  }

  // SHOW DATABASES
  if (upperQ === 'SHOW DATABASES') {
    const plan = createEmptyPlan()
    plan.catalogOp = 'SHOW_DATABASES'
    return plan
  }

  // Transaction commands
  if (upperQ === 'BEGIN') {
    const plan = createEmptyPlan()
    plan.type = 'BEGIN'
    return plan
  }
  if (upperQ === 'COMMIT') {
    const plan = createEmptyPlan()
    plan.type = 'COMMIT'
    return plan
  }
  if (upperQ === 'ROLLBACK') {
    const plan = createEmptyPlan()
    plan.type = 'ROLLBACK'
    return plan
  }

  // USE database — 命名空间切换
  const useMatch = trimmed.match(/^USE\s+(\w+)$/i)
  if (useMatch) {
    const plan = createEmptyPlan()
    plan.type = 'USE'
    plan.useGraph = useMatch[1]
    return plan
  }

  // CREATE DATABASE name
  const createDbMatch = trimmed.match(/^CREATE\s+DATABASE\s+(\w+)$/i)
  if (createDbMatch) {
    const plan = createEmptyPlan()
    plan.catalogOp = 'CREATE_DATABASE'
    plan.useGraph = createDbMatch[1]
    return plan
  }

  // DROP DATABASE name
  const dropDbMatch = trimmed.match(/^DROP\s+DATABASE\s+(\w+)$/i)
  if (dropDbMatch) {
    const plan = createEmptyPlan()
    plan.catalogOp = 'DROP_DATABASE'
    plan.useGraph = dropDbMatch[1]
    return plan
  }

  // CREATE INDEX ON :Label(prop)
  const createIndexMatch = trimmed.match(/^CREATE\s+INDEX\s+ON\s+:(\w+)\s*\((\w+)\)$/i)
  if (createIndexMatch) {
    const plan = createEmptyPlan()
    plan.indexOp = 'CREATE'
    plan.indexLabel = createIndexMatch[1]
    plan.indexProperty = createIndexMatch[2]
    return plan
  }

  // DROP INDEX ON :Label(prop)
  const dropIndexMatch = trimmed.match(/^DROP\s+INDEX\s+ON\s+:(\w+)\s*\((\w+)\)$/i)
  if (dropIndexMatch) {
    const plan = createEmptyPlan()
    plan.indexOp = 'DROP'
    plan.indexLabel = dropIndexMatch[1]
    plan.indexProperty = dropIndexMatch[2]
    return plan
  }

  // DROP CONSTRAINT name
  const dropConstraintMatch = trimmed.match(/^DROP\s+CONSTRAINT\s+(\w[\w_]*)/i)
  if (dropConstraintMatch) {
    const plan = createEmptyPlan()
    plan.type = 'DROP_CONSTRAINT'
    plan.constraint = { label: '', property: dropConstraintMatch[1] }
    return plan
  }

  // CREATE CONSTRAINT (supports both single and composite properties)
  // Syntax 1: Neon pg-ish "FOR (n:Person) REQUIRE n.age IS UNIQUE"
  const createConstraintMatch = trimmed.match(/^CREATE\s+CONSTRAINT\s+FOR\s+\((\w+):(\w+)\)\s+REQUIRE\s+\(?(\w+\.\w+(?:\s*,\s*\w+\.\w+)*)\)?\s+IS\s+UNIQUE/i)
  if (createConstraintMatch) {
    const plan = createEmptyPlan()
    plan.type = 'CREATE_CONSTRAINT'
    plan.constraint = { label: createConstraintMatch[2], property: createConstraintMatch[3].split('.')[1] }
    return plan
  }
  // Syntax 2: Cypher-standard "ON (n:Person) ASSERT n.age IS UNIQUE"
  const createConstraintMatch2 = trimmed.match(/^CREATE\s+CONSTRAINT\s+ON\s+\((\w+):(\w+)\)\s+ASSERT\s+(\w+)\.(\w+)\s+IS\s+UNIQUE/i)
  if (createConstraintMatch2) {
    const plan = createEmptyPlan()
    plan.type = 'CREATE_CONSTRAINT'
    plan.constraint = { label: createConstraintMatch2[2], property: createConstraintMatch2[4] }
    return plan
  }

  // DESCRIBE — strip prefix, set explain, recurse
  const describeMatch = trimmed.match(/^DESCRIBE\s+(.+)/i)
  if (describeMatch) {
    const innerPlan = buildQueryPlan(describeMatch[1].trim())
    innerPlan.explain = true
    return innerPlan
  }

  // Check for INTERSECT/SUBTRACT
  // These would blow up ANTLR so handle them first.
  const enumMatch = trimmed.match(new RegExp('^(.+?)\\s+(INTERSECT|SUBTRACT)\\s+(.+)$', 'is'))

  // Validate edge patterns before ANTLR: (a)->(b) and (a)<-(b) are invalid
  // Valid patterns: -[*]->, <-[*]-, -[*]-, <-[*]->
  // Find both -> and <- patterns separately (the regex matches edges at node boundaries)
  const edgePattern = trimmed.match(/\([^)]+\)\s*(->|<-)\s*\(/i)
  if (edgePattern) {
    const invalidArrow = edgePattern[1]
    // For <- arrows, check if the character before the arrow is part of a relationship pattern
    // (a)<- is valid IF it's preceded by a relationship detail: (a)<-[: ... is fine
    // The issue: regex matches (a)<-(b) which is the source node + arrow + target node arrow check
    // But (a)<-[:  is valid, while (a)<-(b) without preceding dash is invalid only for outbound
    
    // To handle both valid and invalid cases more precisely:
    // Only trigger for -> patterns. For <- patterns (reverse), the validation is too aggressive.
    if (invalidArrow === '->') {
      const beforeArrow = trimmed.slice(0, edgePattern.index! + edgePattern[0].indexOf(invalidArrow))
      if (!beforeArrow.endsWith('-') && !beforeArrow.endsWith('[')) {
        throw new Error('Invalid edge direction')
      }
    }
    // For <- (reverse edges), don't throw — they are valid in Cypher
    // (a)<-[*]-(b) = valid reverse edge
  }
  if (enumMatch) {
    const leftQuery = enumMatch[1].trim()
    const op = enumMatch[2].toUpperCase()
    const rightQuery = enumMatch[3].trim()
    
    const leftPlan = buildQueryPlan(leftQuery)
    const rightPlan = buildQueryPlan(rightQuery)
    
    const plan = createEmptyPlan()
    Object.assign(plan, leftPlan, {
      unionType: op === 'INTERSECT' ? 'intersect' as const : 'subtract' as const,
      rightPlan: rightPlan,
    })
    return plan
  }

  // ── LOAD CSV ──
  const loadCsvMatch = trimmed.match(/^LOAD CSV FROM\s+'([^']+)'\s+AS\s+(\w+)(?:\s+(WITH HEADERS|WITH NO HEADERS))?(?:\s+FIELDTERMINATOR\s+'([^']+)')?.*$/is)
  if (loadCsvMatch) {
    const plan = createEmptyPlan()
    plan.loadCsv = {
      url: loadCsvMatch[1],
      rowVariable: loadCsvMatch[2],
      hasHeaders: (loadCsvMatch[3] || '').toUpperCase() === 'WITH HEADERS',
      delimiter: loadCsvMatch[4] || ',',
    }
    return plan
  }

  // ── USING INDEX 查询提示提取 ──
  // 语法: MATCH (n:Person) USING INDEX n:Person(name)
  // 在 ANTLR 解析前提取，解析完成后附加到 plan 上
  let usingIndexHint: { var: string; label: string; property: string } | null = null
  const usingIdxMatch = trimmed.match(/\bUSING\s+INDEX\s+(\w+):(\w+)\((\w+)\)/i)
  if (usingIdxMatch) {
    usingIndexHint = {
      var: usingIdxMatch[1],
      label: usingIdxMatch[2],
      property: usingIdxMatch[3],
    }
  }

  const is = new antlr4.InputStream(trimmed)
  const lexer = new CypherLexer(is)
  const tokens = new antlr4.CommonTokenStream(lexer)
  const parser = new CypherParser(tokens)
  parser.buildParseTrees = true

  // ── Suppress ANTLR ConsoleErrorListener stderr noise by swapping process.stderr ──
  // ANTLR's default ConsoleErrorListener calls System.err.println (→ process.stderr.write).
  // We temporarily redirect stderr during parsing to hide these messages.
  // Do NOT use removeErrorListeners() — it interferes with ANTLR's internal error recovery
  // and causes parse failures that would otherwise be tolerated/compensated.
  const origStderrWrite = process.stderr.write.bind(process.stderr)
  // @ts-expect-error - ANTLR stderr redirect (temporarily suppress error output)
  ;(process.stderr as unknown as { write: (...args: unknown[]) => boolean }).write = () => true
  let tree: any
  try {
    tree = parser.cypher()
  } finally {
    ;(process.stderr as unknown as { write: (...args: unknown[]) => boolean }).write = origStderrWrite
  }
  const clauses = collectClauses(tree)

  // Build plan from clauses
  const plan = clausesToPlan(clauses)

  // ── Post-processing: ATTACH pathVar ──
  // When buildQueryPlan strips the `p = ` path-assignment prefix before ANTLR
  // parsing, attach the FIRST path variable name to the plan (additional MATCH
  // path variables are already recorded on their step.pathVariable).
  if (pathVar) {
    plan.pathVar = pathVar
    // Also attach the first path variable to the first traverse step so the
    // executor can bind `p1` to a real path object.
    if (plan.steps.length && !(plan.steps[0] as any).pathVariable) {
      ;(plan.steps[0] as any).pathVariable = pathVar
    }
  }

  // ── Post-processing: FOREACH — ANTLR doesn't support FOREACH syntax ──
  // FOREACH (var IN list | ...) uses | which ANTLR doesn't parse.
  // Extract from original query text as a regex-based fallback.
  if (!plan.forEach) {
    // 使用更宽松的正则（不要求 ) 闭合）
    // Detect MATCH from query text when ANTLR didn't parse it (FOREACH not in grammar)
    const hasMatchInQuery = /MATCH/i.test(trimmed)
    
    const feMatch2 = trimmed.match(/FOREACH\s*\(\s*(\w+)\s+IN\s+(.+?)\s*\|\s*(.+?)\s*\)\s*(\w.*)?$/is) ||
                     trimmed.match(/FOREACH\s*\(\s*(\w+)\s+IN\s+(.+?)\s*\|\s*(.*)/i)
    if (feMatch2) {
      // If there's a MATCH but ANTLR didn't parse it, extract MATCH info from text
      if (hasMatchInQuery && !plan.hasMatch && !plan.scanLabel) {
        const matchPattern = trimmed.match(/MATCH\s*\(\s*(\w+)\s*(?::\s*(\w+))?/)
        if (matchPattern) {
          const matchVar = matchPattern[1]
          const matchLabel = matchPattern[2] || undefined
          plan.hasMatch = true
          plan.scanLabel = matchLabel
          if (matchLabel) {
            plan.labelExpr = matchLabel
          }
          // Set matchAlias for the MATCH variable
          plan.matchAlias = matchVar
          // Scan mode for single-step MATCH
          plan.steps = undefined
        }
      }
      const feVar = feMatch2[1]
      let feListRaw = feMatch2[2].trim()
      const feBody = feMatch2[3].trim()

      // Extract WHERE from list expression: "list_expr WHERE cond" → list_expr
      let feWhere: string | undefined
      const whereInList = feListRaw.match(/^(.+?)\s+WHERE\s+(.+)$/i)
      if (whereInList) {
        feListRaw = whereInList[1].trim()
        feWhere = whereInList[2].trim()
      }

      let feList: any[] = []
      let feIsVarRef = false
      if (feListRaw.startsWith('[') && feListRaw.endsWith(']')) {
        try { feList = JSON.parse(feListRaw) }
        catch { try { feList = JSON.parse(feListRaw.replace(/'/g, '"')) } catch { } }
      } else {
        feIsVarRef = true
        feList = [feListRaw]
      }

      const cleanBody = feBody.replace(/\)\s*\w*\s*$/i, '').trim()
      const operation = parseForeachBody(cleanBody)
      if (operation) {
        if (feWhere) operation.where = feWhere
        plan.forEach = { variable: feVar, name: feVar, list: feList, isVarRef: feIsVarRef, operation }
      }
    }
  }

  // ── Post-processing: CALL subqueries ──
  // ANTLR grammar doesn't support CALL { ... } subqueries natively (stops at '{').
  // Detect CALL subqueries from the original query text and fill in details.
  // Use robust brace-matching to handle nested calls.
  function extractCallSubquery(text) {
    const callMatch = text.match(/^CALL\s*\{/i)
    if (!callMatch) return null
    
    let depth = 0
    let startFound = false
    const startIdx = callMatch.index! + callMatch[0].length - 1 // position of '{'
    
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '{') {
        if (i >= startIdx) { depth++; startFound = true }
      } else if (text[i] === '}' && startFound) {
        depth--
        if (depth === 0) {
          const innerQuery = text.substring(startIdx + 1, i).trim()
          const afterQuery = text.substring(i + 1).trim()
          return { innerQuery, afterQuery }
        }
      }
    }
    return null
  }

  if (trimmed.toUpperCase().startsWith('CALL')) {
    const callInfo = extractCallSubquery(trimmed)
    if (callInfo && callInfo.innerQuery) {
      const subPlan = buildQueryPlan(callInfo.innerQuery)
      plan.type = 'CALL'
      plan.callQuery = subPlan

      // Check for IN TRANSACTIONS in the after-query text
      const txMatch = callInfo.afterQuery.match(/IN\s+TRANSACTIONS(?:\s+OF\s+(\d+)\s+ROWS)?/i)
      if (txMatch) {
        plan.inTransactions = true
        subPlan.inTransactions = true
        if (txMatch[1]) {
          plan.inTransactionsBatchSize = parseInt(txMatch[1], 10)
          subPlan.inTransactionsBatchSize = parseInt(txMatch[1], 10)
        }
      }
    }
  }

  // ── Post-processing: GROUP BY, HAVING from text ──
  // ANTLR grammar doesn't support GROUP BY / HAVING natively.
  // Extract from the RETURN clause text.
  const retMatch = trimmed.match(/RETURN\s+((?:(?!\s+(?:ORDER\s+BY|GROUP\s+BY|HAVING|LIMIT|SKIP)).)*)/is)
  if (retMatch) {
    const afterReturn = trimmed.slice(retMatch.index! + retMatch[0].length)
    
    // GROUP BY
    const groupByMatch = afterReturn.match(/GROUP\s+BY\s+(.+?)(?:\s+(?:ORDER\s+BY|HAVING|LIMIT|SKIP)|$)/is)
    if (groupByMatch) {
      plan.groupBy = groupByMatch[1].trim().split(',').map(g => g.trim().replace(/^\w+\./, ''))
    }

    // HAVING
    const havingMatch = afterReturn.match(/HAVING\s+(.+?)(?:\s+(?:ORDER\s+BY|GROUP\s+BY|LIMIT|SKIP)|$)/is)
    if (havingMatch) {
      plan.having = parseHavingClause(havingMatch[1].trim())
    }

    // ORDER BY — extract from afterReturn if not already set by extractReturn
    // (extractReturn may miss ORDER BY when ANTLR stops at GROUP/HAVING keyword)
    if (!plan.orderBy || plan.orderBy.length === 0) {
      const orderByMatch = afterReturn.match(/ORDER\s+BY\s+(.+?)(?:\s+(?:GROUP\s+BY|HAVING|LIMIT|SKIP)|$)/is)
      if (orderByMatch) {
        const orderByItems = orderByMatch[1].trim().split(',').map(s => s.trim())
        plan.orderBy = orderByItems.map(item => {
          const parts = item.split(/\s+/)
          const prop = parts[0].replace(/^\w+\./, '')
          const dir = parts.slice(1).join(' ').toUpperCase()
          return {
            property: prop,
            direction: dir === 'DESC' ? 'DESC' as const : 'ASC' as const,
          }
        })
      }
    }

    // SKIP — extract if not already set
    if (plan.skip === undefined) {
      const skipMatch = afterReturn.match(/SKIP\s+(\d+)/i)
      if (skipMatch) plan.skip = parseInt(skipMatch[1], 10)
    }

    // LIMIT — extract if not already set
    if (plan.limit === undefined) {
      const limitMatch = afterReturn.match(/LIMIT\s+(\d+)/i)
      if (limitMatch) plan.limit = parseInt(limitMatch[1], 10)
    }
  }

  // ── 附加 USING INDEX 提示 ──
  if (usingIndexHint) {
    ;(plan as any)._indexHint = usingIndexHint
  }

  return plan
}

/**
 * Walk the ANTLR parse tree to collect all top-level clause nodes.
 */
function collectClauses(ctx: any): ParsedClause[] {
  const result: ParsedClause[] = []

  function walk(node: any) {
    if (!node || !node.children) return

    const name = node.constructor?.name ?? ''
    const known: Record<string, string> = {
      MatchClauseContext: 'MATCH',
      ReturnClauseContext: 'RETURN',
      CreateClauseContext: 'CREATE',
      MergeClauseContext: 'MERGE',
      DeleteClauseContext: 'DELETE',
      SetClauseContext: 'SET',
      RemoveClauseContext: 'REMOVE',
      UnwindClauseContext: 'UNWIND',
      ForeachClauseContext: 'FOREACH',
      CallContext: 'CALL',
      WithClauseContext: 'WITH',
    }

    if (name === 'SingleQueryContext') {
      // SingleQuery is a container
    } else if (name === 'MatchClauseContext') {
      // ANTLR 把 OPTIONAL MATCH 也解析为 MatchClauseContext
      // 用文本前缀区分
      const text = getTextRecursive(node).toUpperCase()
      if (text.startsWith('OPTIONAL')) {
        result.push({ type: 'OPTIONAL_MATCH', ctx: node })
      } else {
        result.push({ type: 'MATCH', ctx: node })
      }
      return
    } else if (known[name]) {
      result.push({ type: known[name], ctx: node })
      return
    }

  // OptionalMatchContext — not generated by ANTLR; detected via text prefix in MatchClauseContext
  // No separate case needed here

    if (name === 'RegularQueryContext') {
      // Check for UNION.  A set operator may be separated from the surrounding
      // sub-queries by a newline (multi-line TCK queries use `RETURN 1\nUNION\n
      // RETURN 2`), not just a space, so match the keyword on word boundaries
      // rather than requiring literal spaces around it.
      const text = node.getText().toUpperCase()
      if (/\bUNION\b|\bINTERSECT\b|\bSUBTRACT\b/.test(text)) {
        result.push({ type: 'UNION_QUERY', ctx: node })
        return
      }
    }

    for (const child of node.children) {
      walk(child)
    }
  }

  walk(ctx)
  return result
}

/**
 * Convert collected clauses into a QueryPlan.
 */
function clausesToPlan(clauses: ParsedClause[]): QueryPlan {
  const plan: QueryPlan = createEmptyPlan()
  let hasMatch = false

  // Check for UNION first
  if (clauses.some(c => c.type === 'UNION_QUERY')) {
    return parseUnion(clauses.find(c => c.type === 'UNION_QUERY')!.ctx)
  }

  for (const clause of clauses) {
    switch (clause.type) {
      case 'MATCH': {
        hasMatch = true
        // ── Path assignment detection: MATCH p = (a)-[*]->(b) → pathVar: 'p' ──
        // ANTLR does not understand `p = (` syntax, so extract the path
        // assignment pattern from the clause text via regex.
        const matchCtxText = clause.ctx.getText ? clause.ctx.getText() : ''
        // clause.ctx.getText() may include the leading `MATCH ` keyword (e.g.
        // `MATCH p2 = (:A)<--()`). Tolerate the optional leading `MATCH `.
        const pathAssignMatch = matchCtxText.match(/(?:^|\s)(\w+)\s*=\s*\(/)
        const parsed = extractMatch(clause.ctx)
        if (parsed) {
          // Attach this MATCH clause's path variable to its first traverse step
          // so the executor can bind p1/p2 to real path objects
          // (`MATCH p1 = (:A)-->() MATCH p2 = (:A)<--()`).
          if (pathAssignMatch && parsed.edges.length) {
            ;(parsed.edges[0] as any).pathVariable = pathAssignMatch[1]
          }
          if (!plan.scanLabel && plan.steps.length === 0) {
            plan.scanLabel = parsed.label ?? plan.scanLabel
            // A comma-separated MATCH clause (`MATCH (a)-->(b),(b)-->(b)`) splits
            // into independent parts: the first part drives plan.steps, the
            // remaining parts become independent cross-join patterns so they are
            // not walked as a single chained path.
            const parts = parsed.parts?.length ? parsed.parts : [parsed.edges]
            plan.steps = parts[0] || parsed.edges
            // Preserve the first MATCH clause's source node variable (e.g. `a`
            // in `MATCH (a:A) MATCH (a)-[:R]->(c)`) so the cross-join executor
            // can join the two patterns on the shared bound variable rather than
            // Cartesian-producting them.
            if (parsed.variable) (plan as any).matchVar = parsed.variable
            // Preserve the first node's inline property predicate (e.g.
            // `MATCH (a {name:'A'})-[*]->(x)`) so the variable-length executor can
            // constrain the BFS start node to matching properties.
            if (parsed.properties && plan.steps.length) {
              ;(plan.steps[0] as any).sourceProps = parsed.properties
            }
            // When the first MATCH is a bare node with an inline property
            // predicate but no label (e.g. `MATCH (a {name:'A'}), (c {name:'C'})
            // ...`), there is no traverse step to carry sourceProps, so keep it on
            // the plan for the cross-join bare-node binding.
            if (parsed.properties && !plan.steps.length) {
              ;(plan as any).matchSourceProps = parsed.properties
            }
            // Stage the remaining comma-separated parts (beyond the first) as
            // independent patterns.
            for (let pi = 1; pi < parts.length; pi++) {
              const part = parts[pi]
              if (!part.length) continue
              if (!plan.multiMatch) plan.multiMatch = []
              plan.multiMatch.push({
                scanLabel: parsed.label ?? null,
                steps: part,
                variable: part[0].source || undefined,
              })
            }
            // Stage disjoint comma-separated bound nodes (e.g. `c` in
            // `MATCH (a {name:'A'}),(c {name:'C'}) MATCH (a)-->(b)`) as
            // additional bare-node patterns so the cross-join binds them.
            if (parsed.extraNodes?.length) {
              if (!plan.multiMatch) plan.multiMatch = []
              for (const en of parsed.extraNodes) {
                plan.multiMatch.push({
                  scanLabel: en.label ?? null,
                  steps: [],
                  variable: en.variable,
                  sourceProps: en.properties ?? undefined,
                })
              }
            }
          } else {
            // Second/further independent MATCH clause → stage as an independent
            // pattern for the executor to cross-join (relationship identity
            // `a = b`, path equality `p1 = p2`).
            if (!plan.multiMatch) plan.multiMatch = []
            // A comma-separated MATCH clause (`MATCH (a)-->(x),(b)-->(x)`)
            // decomposes into multiple independent patterns, one per comma part.
            // Chain the edges within each part but treat each part as a distinct
            // pattern so `x` joins on identity rather than being walked as one
            // continuous path.
            const parts = parsed.parts?.length ? parsed.parts : [parsed.edges]
            for (const part of parts) {
              if (!part.length) continue
              plan.multiMatch.push({
                scanLabel: parsed.label ?? null,
                steps: part,
                variable: part[0].source || parsed.variable || undefined,
              })
            }
            // Also stage disjoint comma-separated bound nodes from later clauses.
            if (parsed.extraNodes?.length) {
              for (const en of parsed.extraNodes) {
                plan.multiMatch.push({
                  scanLabel: en.label ?? null,
                  steps: [],
                  variable: en.variable,
                  sourceProps: en.properties ?? undefined,
                })
              }
            }
          }
        }
        break
      }
      case 'OPTIONAL_MATCH': {
        // OPTIONAL MATCH 提取到 optionalMatchSteps
        const parsed = extractMatch(clause.ctx)
        if (parsed) {
          if (!plan.optionalMatchSteps) plan.optionalMatchSteps = []
          plan.optionalMatchSteps.push({
            scanLabel: parsed.label,
            steps: parsed.edges,
            filters: [],
            variableName: parsed.variable || undefined,
          })
        }
        break
      }
      // WHERE is handled inside MATCH clause — no separate case
      // (ANTLR nests WHERE inside MatchClauseContext)
      case 'RETURN': {
        const ret = extractReturn(clause.ctx)
        // Detect the top-level `RETURN DISTINCT` modifier (distinct from the
        // per-aggregate `count(DISTINCT x)` form). The raw clause text is the
        // reliable signal since ANTLR may not expose a dedicated DISTINCT node.
        const retText = clause.ctx ? getTextRecursive(clause.ctx) : ''
        if (/^\s*RETURN\s+DISTINCT\b/i.test(retText)) {
          plan.distinct = true
        }
        // 填充 returnAliasMap：returnColumn → 原始表达式（用于 DML 结果构造 & 表达式求值）
        plan.returnAliasMap = {}
        // 填充 expressionColumns：结构化列Info（用于表达式求值引擎）
        plan.expressionColumns = []
        for (const c of ret.columns) {
          const key = (c.alias ?? c.expression).replace(/^\w+\./, '')
          plan.returnAliasMap[key] = c.expression
          plan.expressionColumns.push({ expression: c.expression, alias: c.alias ?? c.expression })
        }
        // 兼容 _executeQuery：returnColumns 期望字段名（不含变量.前缀），* 则置空
        plan.returnColumns = ret.columns.map(c => {
          const expr = c.alias ?? c.expression
          if (expr === '*') return ''
          // 保留完整的表达式用于 _formatResultRow 中的变量.属性解析
          return expr
        }).filter((v, i, arr) => !(v === '' && i === 0 && arr.length === 1)) // only filter out * alone
        if (ret.columns.length === 1 && ret.columns[0].expression === '*') {
          plan.returnColumns = []
        }
        plan.orderBy = ret.orderBy
        plan.limit = ret.limit
        plan.skip = ret.skip
        // 兼容 _executeQuery：aggregate 需要 type 字段（test expects lowercase, e.g. 'count' not 'Count'）
        if (ret.aggregate) {
          const aggColumn = ret.aggregate.column || ''
          const aliasMatch = aggColumn.match(/AS\s+(\w+)$/i)
          const alias = aliasMatch ? aliasMatch[1] : undefined
          // Split the DISTINCT modifier from the value expression so the graph
          // engine resolves the property correctly and applies unique-count
          // semantics (e.g. `count(DISTINCT n.name)` → field "n.name", distinct).
          const fnFieldMatch = aggColumn.match(/^\w+\(\s*(DISTINCT\s+)?(.+?)\s*\)(?:\s+AS\s+\w+)?$/i)

          const agg: any = {
            function: ret.aggregate.function,
            column: ret.aggregate.column,
            type: ret.aggregate.function,
            field: fnFieldMatch ? fnFieldMatch[2] : undefined,
            distinct: fnFieldMatch ? !!fnFieldMatch[1] : false,
          }
          if (alias) agg.alias = alias
          plan.aggregate = agg

          // Mirror the full aggregate list (multi-aggregate RETURN) by mapping
          // each parsed aggregate through the same DISTINCT/field/alias
          // splitting so `plan.aggregates` carries complete clauses for
          // `RETURN collect(DISTINCT a.x) AS a, collect(DISTINCT b.x) AS b`.
          if (ret.aggregates && ret.aggregates.length > 1) {
            plan.aggregates = ret.aggregates.map((a: any) => {
              const col = a.column || ''
              const am = col.match(/AS\s+(\w+)$/i)
              const fm = col.match(/^\w+\(\s*(DISTINCT\s+)?(.+?)\s*\)(?:\s+AS\s+\w+)?$/i)
              const clause: any = {
                function: a.function,
                column: col,
                type: a.function,
                field: fm ? fm[2] : undefined,
                distinct: fm ? !!fm[1] : false,
              }
              if (am) clause.alias = am[1]
              return clause
            })
          }

          // Implicit GROUP BY: `RETURN n.name, sum(n.num)` groups by the
          // non-aggregate column `n.name`.  ANTLR only sets plan.groupBy for an
          // explicit `GROUP BY` clause (see the post-processing pass below), so
          // harvest the remaining non-aggregate RETURN columns here.  Each key
          // is stripped of its `var.` prefix to match the explicit-GROUP-BY
          // shape (`name`), and bare variable/`*` references are skipped (they
          // are not scalar grouping keys).
          if (!plan.groupBy) {
            const implicitKeys: string[] = []
            for (const c of ret.columns) {
              const cExpr = c.expression
              if (!cExpr) continue
              // Skip aggregate calls (only non-aggregate columns group).
              if (/\b(count|sum|avg|max|min|collect|stdev|stdevp|percentilecont|percentiledisc)\s*\(/i.test(cExpr)) continue
              // Skip list comprehensions (not a scalar grouping key).
              if (cExpr.startsWith('[') && cExpr.includes('IN') && cExpr.includes('|')) continue
              const key = cExpr.includes('.') ? cExpr.split('.').pop()! : cExpr
              if (key && key !== '*' && !implicitKeys.includes(key)) implicitKeys.push(key)
            }
            if (implicitKeys.length) plan.groupBy = implicitKeys
          }
        }

        // Also check return columns for aggregate patterns (fallback)
        if (!ret.aggregate && ret.columns.length > 0) {
          for (const col of ret.columns) {
            const expr = col.expression
            if (/\b(count|sum|avg|max|min|collect)\s*\(/i.test(expr)) {
              const fnMatch = expr.match(/^\s*(count|sum|avg|max|min|collect)\s*\(/i)
              if (fnMatch) {
                const aliasMatch2 = expr.match(/AS\s+(\w+)$/i)
                const alias2 = aliasMatch2 ? aliasMatch2[1] : undefined
                const agg2: any = {
                  function: fnMatch[1].toLowerCase(),
                  column: expr,
                  type: fnMatch[1].toLowerCase(),
                }
                if (alias2) agg2.alias = alias2
                plan.aggregate = agg2
              }
              break
            }
          }
        }
        break
      }
      case 'CREATE': {
        plan.type = 'CREATE'
        const nodes = extractCreateNodes(clause.ctx)
        if (nodes.length) {
          if (plan.createNodes?.length) {
            // 去重：跳过已存在的 alias（边语句中的节点引用已有变量）
            const existingAliases = new Set(plan.createNodes.map(n => n.alias))
            for (const n of nodes) {
              if (!existingAliases.has(n.alias)) {
                plan.createNodes.push(n)
              }
            }
          } else {
            plan.createNodes = nodes
          }
        }
        const edges = extractCreateEdges(clause.ctx)
        if (edges.length) {
          // extractCreateEdges assigns sourceIdx/targetIdx from a *clause-local*
          // nodeToIdx table (starting at 0 for this CREATE clause).  When a
          // later CREATE clause reuses node variables created in an earlier one
          // (e.g. `CREATE (a),(b),(c),(d) CREATE (a)-[:R]->(d)`), those local
          // indices no longer line up with the accumulated global createNodes
          // list.  Re-map each endpoint to the global index via its variable
          // name so the DML layer connects the correct nodes.
          const emitEdges = edges.map((e) => {
            const gSrc = e.source ? plan.createNodes?.findIndex((n: any) => n.alias === e.source) : -1
            const gDst = e.target ? plan.createNodes?.findIndex((n: any) => n.alias === e.target) : -1
            return {
              ...e,
              sourceIdx: gSrc >= 0 ? gSrc : e.sourceIdx,
              targetIdx: gDst >= 0 ? gDst : e.targetIdx,
            }
          })
          plan.createEdges = plan.createEdges?.length ? [...plan.createEdges, ...emitEdges] : emitEdges
        }
        break
      }
      case 'DELETE': {
        plan.type = 'DELETE'
        const targets = extractDeleteTargets(clause.ctx)
        plan.deleteTargets = targets
        plan.detachDelete = isDetachDelete(clause.ctx)
        break
      }
      case 'MERGE': {
        plan.type = 'MERGE'
        const m = extractMerge(clause.ctx)
        plan.mergeNodes = m.nodes
        plan.mergeEdges = m.edges
        // Extract ON CREATE / ON MATCH sets from text
        const mergeText = getTextRecursive(clause.ctx)
        const onCreateMatch = mergeText.match(/ON\s+CREATE\s+SET\s+(.+?)(?:\s+ON\s+MATCH|$)/i)
        if (onCreateMatch) {
          plan.mergeOnCreate = parseSetClausesFromText(onCreateMatch[1])
        }
        const onMatchMatch = mergeText.match(/ON\s+MATCH\s+SET\s+(.+?)(?:\s+ON\s+CREATE|$)/i)
        if (onMatchMatch) {
          plan.mergeOnMatch = parseSetClausesFromText(onMatchMatch[1])
        }
        break
      }
      case 'SET': {
        const sets = extractSetClauses(clause.ctx)
        plan.setClauses = sets
        break
      }
      case 'REMOVE': {
        const removes = extractRemoveClauses(clause.ctx)
        plan.removeClauses = removes
        break
      }
      case 'UNWIND': {
        const u = extractUnwind(clause.ctx)
        if (plan.unwind) {
          plan.secondUnwind = u
        } else {
          plan.unwind = u
        }
        // 收集到多级 UNWIND 数组（支持 N 级 UNWIND 链）
        if (!plan.unwinds) plan.unwinds = []
        plan.unwinds.push(u)
        break
      }
      case 'CALL': {
        plan.type = 'CALL'
        const c = extractCall(clause.ctx)
        if (c.isProcedure) {
          plan.callProcedure = { name: c.procedureName!, args: c.args, yieldItems: c.yieldItems }
        } else {
          plan.callQuery = c.subPlan
          if (c.subPlan?.inTransactions) plan.inTransactions = c.subPlan.inTransactions
          if (c.subPlan?.inTransactionsBatchSize) plan.inTransactionsBatchSize = c.subPlan.inTransactionsBatchSize
        }
        break
      }
      case 'FOREACH': {
        const ctxText = clause.ctx ? getTextRecursive(clause.ctx) : ''
        const feMatch = ctxText.match(/FOREACH\s*\(\s*(\w+)\s+IN\s+(.+?)\s*\|\s*(.+)/is)
        if (feMatch) {
          const feVar = feMatch[1]
          const feListRaw = feMatch[2].trim()
          const feBody = feMatch[3].trim()
          let feList: any[] = []
          let feIsVarRef = false
          let feWhere: string | undefined

          // Strip WHERE from list expression: "list_expr WHERE cond" → list_expr
          let cleanListRaw = feListRaw
          const whereInList = feListRaw.match(/^(.+?)\s+WHERE\s+(.+)$/i)
          if (whereInList) {
            cleanListRaw = whereInList[1].trim()
            feWhere = whereInList[2].trim()
          }

          if (cleanListRaw.startsWith('[') && cleanListRaw.endsWith(']')) {
            try { feList = JSON.parse(cleanListRaw) }
            catch { try { feList = JSON.parse(cleanListRaw.replace(/'/g, '"')) } catch {} }
          } else {
            feIsVarRef = true
            feList = [cleanListRaw]
          }
          // Roll back closing paren from body if the whole clause ends with )
          const cleanBody = feBody.replace(/\)\s*\w*\s*$/i, '').trim()
          const operation = parseForeachBody(cleanBody)
          if (operation) {
            // If WHERE was in list expression, attach it to operation
            if (feWhere) { operation.where = feWhere }
            plan.forEach = { variable: feVar, name: feVar, list: feList, isVarRef: feIsVarRef, operation }
          }
        }
        break
      }
      case 'WITH': {
        const w = extractWith(clause.ctx)
        plan.with = w
        if (!plan.withChain) plan.withChain = []
        plan.withChain.push(w)
        break
      }
    }
  }

  // ── Relationship-list variable-length normalisation ──
  // `MATCH ... WITH [r1, r2] AS rs ... MATCH (first)-[rs*]->(second)` binds `rs`
  // to a LIST of relationships collected earlier in the query; `rs*` then means
  // "walk a path whose relationship sequence is exactly `rs`" — i.e. a fixed
  // hop count equal to the list length, NOT an unbounded `*` (1..∞) walk.  The
  // unbounded reading lets a 1-hop prefix match spuriously (the TCK
  // `Match9 [6]` case returns an extra `(:B)` row), so pin the variable-length
  // range to `{min: len, max: len}` when the edge variable is a WITH list alias.
  const withListLengths = new Map<string, number>()
  for (const w of plan.withChain || []) {
    for (const col of (w as any).columns || []) {
      const expr = col?.expression
      if (!expr || typeof expr !== 'string') continue
      const trimmed = expr.trim()
      // WITH [...] AS rs binds `rs` to a list literal; record its element count
      // so a later `-[rs*]->` can pin the variable-length range to that count.
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        const inner = trimmed.slice(1, -1).trim()
        withListLengths.set(col.alias, inner ? inner.split(',').length : 0)
      }
    }
  }
  if (withListLengths.size) {
    for (const mm of plan.multiMatch || []) {
      for (const st of mm.steps || []) {
        const ev = (st as any).edgeVariable as string | undefined
        const len = ev ? withListLengths.get(ev) : undefined
        if (ev && len !== undefined && (st as any).range) {
          ;(st as any).range = { min: len, max: len }
        }
      }
    }
  }

  // Incorporate WHERE into filters if present
  // WHERE is a sub-clause of MATCH in ANTLR, so collect from MatchClause
  for (const clause of clauses) {
    if (clause.type === 'MATCH' || clause.type === 'OPTIONAL_MATCH') {
      const whereFilters = extractWhereFromMatch(clause.ctx)
      if (clause.type === 'MATCH') {
        // Label predicates (`WHERE a:A`) carry a source-less marker filter and
        // are handled by `labelFilterItems` (query-parser); keeping the marker in
        // `plan.filters` would let a generic filter stage treat it as a property
        // predicate.  Non-label filters still land in `plan.filters`.
        const propFilters = whereFilters.filter((f: any) => !(f.source === '' && f.property === '' && f.expression))
        plan.filters.push(...propFilters)
      } else if (clause.type === 'OPTIONAL_MATCH' && plan.optionalMatchSteps) {
        const lastOptional = plan.optionalMatchSteps[plan.optionalMatchSteps.length - 1]
        lastOptional.filters.push(...whereFilters)
      }
    }
  }

  plan.hasMatch = hasMatch

  // ── Promote WITH ... ORDER BY / LIMIT / SKIP onto the top-level plan ──
  // The WITH clause's ordering/slicing info is parsed into `plan.with`, but the
  // execution layer (_postProcessResults) only reads top-level `plan.orderBy` /
  // `plan.limit` / `plan.skip`. Without this promotion, a bare
  // `WITH x ORDER BY x LIMIT 1` silently drops its ORDER BY and LIMIT (e.g. the
  // entire WithOrderBy TCK suite returned unsorted, unlimited rows).
  // Only promote when the top-level field is still empty, so an explicit
  // RETURN ... ORDER BY (parsed above) always takes precedence.
  if (!plan.orderBy?.length && plan.with?.orderBy?.length) {
    plan.orderBy = plan.with.orderBy
  }
  if (plan.limit === undefined && plan.with?.limit !== undefined) {
    plan.limit = plan.with.limit
  }
  if (plan.skip === undefined && plan.with?.skip !== undefined) {
    plan.skip = plan.with.skip
  }

  // ── DMLX-20: MATCH + REMOVE/SET/DELETE → type = 'MATCH_MODIFY' ──
  if (hasMatch && (plan.setClauses || plan.removeClauses || (plan.type === 'DELETE'))) {
    plan.type = 'MATCH_MODIFY'
  }

  return plan
}

/**
 * Parse HAVING clause like "count(*) > 1" into structured clauses.
 */
function parseHavingClause(text: string): HavingClause[] {
  const clauses: HavingClause[] = []
  // Split by AND/OR at top level
  const parts = text.split(/\s+(?:AND|OR)\s+/i)
  
  for (const part of parts) {
    const match = part.match(/^(\w+(?:\([^)]*\))?)\s*([<>=!]+)\s*(.+)$/)
    if (match) {
      const aggregate = match[1]
      const opText = match[2]
      const valText = match[3].trim()
      
      const opMap: Record<string, string> = {
        '>': 'GT',
        '>=': 'GTE',
        '<': 'LT',
        '<=': 'LTE',
        '=': 'EQ',
        '!=': 'NEQ',
        '<>': 'NEQ',
      }
      
      clauses.push({
        aggregate,
        operator: opMap[opText] || opText,
        value: parseInt(valText, 10) || valText,
      })
    }
  }
  
  return clauses
}

/**
 * Parse SET clauses from text like "n.created_at = timestamp(), n.foo = bar"
 */
function parseSetClausesFromText(text: string): Array<{ property: string; value: unknown }> {
  const results: Array<{ property: string; value: unknown }> = []
  const items = splitByTopLevelComma(text)
  
  for (const item of items) {
    const eqMatch = item.match(/^(\w+)\.(\w+)\s*=\s*(.+)$/)
    if (eqMatch) {
      const valueText = eqMatch[3].trim()
      let value: unknown = valueText
      // Try to parse literal values
      if ((valueText.startsWith("'") && valueText.endsWith("'")) || 
          (valueText.startsWith('"') && valueText.endsWith('"'))) {
        value = valueText.slice(1, -1)
      } else if (valueText === 'true') value = true
      else if (valueText === 'false') value = false
      else if (/^-?\d+$/.test(valueText)) value = parseInt(valueText, 10)
      else if (/^-?\d+\.\d+$/.test(valueText)) value = parseFloat(valueText)
      
      results.push({ property: eqMatch[2], value })
    }
  }
  
  return results
}

/**
 * Split text by comma at top level (not inside parentheses)
 */
function splitByTopLevelComma(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  
  for (const ch of text) {
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) parts.push(current.trim())
  
  return parts
}

/**
 * Parse UNION query: MATCH ... UNION MATCH ...
 */
function parseUnion(unionCtx: any): QueryPlan {
  // ANTLR's RegularQuery for UNION has structure:
  // RegularQuery → SingleQuery (UNION SingleQuery)+
  // We need to split the full text at UNION boundary
  const text: string = unionCtx.getText()
  const plan: QueryPlan = createEmptyPlan()

  // Simple split: find " UNION " (case-insensitive)
  // For complex cases (INTERSECT, SUBTRACT), match the keyword
  const unionMatch = text.match(new RegExp('(.+?)\\s+(UNION\\s*(ALL)?|INTERSECT|SUBTRACT)\\s+(.+)', 'is'))
  if (!unionMatch) return plan

  const leftQuery = unionMatch[1].trim()
  const op = unionMatch[2].toUpperCase()
  const rightQuery = unionMatch[4].trim()

  // Determine union type
  if (op.startsWith('UNION ALL')) plan.unionType = 'union_all'
  else if (op.startsWith('UNION')) plan.unionType = 'union'
  else if (op.startsWith('INTERSECT')) plan.unionType = 'intersect'
  else if (op.startsWith('SUBTRACT')) plan.unionType = 'subtract'

  // Recurse on both sides.  Each side must go through the FULL
  // `parseCypherToPlan` pipeline (including return-column post-processing) so
  // that its RETURN expressions are rebuilt against ITS OWN sub-query text.
  // Calling `buildQueryPlan` directly here leaves the sides un-post-processed,
  // and the outer `postProcessReturnColumns` then runs against the WHOLE union
  // text, polluting the left side's expression with "… UNION <right>".
  plan.rightPlan = parseCypherToPlan(rightQuery)

  // Copy left plan fields into current plan
  const leftPlan = parseCypherToPlan(leftQuery)
  Object.assign(plan, leftPlan, { unionType: plan.unionType, rightPlan: plan.rightPlan })

  return plan
}

// ═══════════════════════════════════════════════════════════════
// Helper: 在子树中查找子规则
// ═══════════════════════════════════════════════════════════════

function findChild(node: any, className: string): any | null {
  if (!node || !node.children) return null
  const name = node.constructor?.name ?? ''
  if (name === className) return node
  for (const child of node.children) {
    const found = findChild(child, className)
    if (found) return found
  }
  return null
}

function findAllChildren(node: any, className: string): any[] {
  const result: any[] = []
  function walk(n: any) {
    if (!n || !n.children) return
    if ((n.constructor?.name ?? '') === className) {
      result.push(n)
    }
    for (const child of n.children) walk(child)
  }
  walk(node)
  return result
}

function getTextRecursive(node: any): string {
  if (!node) return ''
  if (typeof node.getText === 'function') return node.getText()
  if (typeof node.getSymbol === 'function') return node.getSymbol().text ?? ''
  return ''
}

function findSymbolicName(node: any): string | null {
  const sym = findChild(node, 'SymbolicNameContext')
  return sym ? getTextRecursive(sym) : null
}

/** 提取 NodeLabelContext 中的所有标签名（支持多标签 :A:B） */
function extractAllLabels(nodeLabelCtx: any): string[] {
  const labels: string[] = []
  // 尝试通过 findAllChildren 找 SymbolicNameContext
  const syms = findAllChildren(nodeLabelCtx, 'SymbolicNameContext')
  for (const sym of syms) {
    const name = getTextRecursive(sym)
    if (name) labels.push(name)
  }
  if (labels.length) return labels

  // 方法2：用 getText() 获取完整文本
  // ANTLR 4 webpacked bundle 中 constructor.name 可能丢失，但 getText() 在 context 节点有效
  // NodeLabelContext.getText() 返回 ":A:B"
  const text = typeof nodeLabelCtx?.getText === 'function' ? nodeLabelCtx.getText() : ''
  if (text) {
    // 文本如 ":A:B" 或 ": A"（有空格）
    const parts = text.replace(/^:/, '').split(':').filter(Boolean)
    for (const p of parts) {
      const trimmed = p.trim()
      if (trimmed && /^[a-zA-Z_]\w*$/.test(trimmed)) labels.push(trimmed)
    }
  }
  return labels
}

/** 提取 NodeLabelContext 中的所有标签名，用冒号连接 */
function extractLabel(nodeLabelCtx: any): string | null {
  if (!nodeLabelCtx) return null
  const labels = extractAllLabels(nodeLabelCtx)
  return labels.length ? labels.join(':') : null
}

// ═══════════════════════════════════════════════════════════════
// MATCH 提取
// ═══════════════════════════════════════════════════════════════

function extractMatch(matchCtx: any): ParsedMatch | null {
  // Find all NodePattern nodes — there can be multiple (comma-separated)
  const nodePatterns = findAllChildren(matchCtx, 'NodePatternContext')
  if (!nodePatterns.length) return null

  // Use the FIRST node's label as the scanLabel
  // If no explicit label, fall back to the variable name
  const firstPattern = nodePatterns[0]
  const variable = findSymbolicName(findChild(firstPattern, 'VariableContext'))
  const nodeLabel = findChild(firstPattern, 'NodeLabelContext')
  const label = nodeLabel ? extractLabel(nodeLabel) : (variable || null)
  const propsNode = findChild(firstPattern, 'PropertiesContext')
  const properties = propsNode ? extractMapLiteral(propsNode) : null

  // Extract edge steps (PatternElementChain), grouped by PatternElement.
  // A MATCH pattern may contain comma-separated pattern parts, each a
  // PatternElement = NodePattern (PatternElementChain)*. Processing each
  // PatternElement independently ensures a comma-separated chain like
  // `(a)--(b)--(c), (b)--(d)` correctly starts its second part from `b`
  // instead of inheriting the previous part's trailing variable.
  const patternElements = findAllChildren(matchCtx, 'PatternElementContext')
    .filter((pe: any) => (pe.children || []).length > 0)
  const edges: ParsedEdgeStep[] = []

  const buildEdge = (chain: any, source: string): ParsedEdgeStep | null => {
    const relPattern = findChild(chain, 'RelationshipPatternContext')
    const targetPattern = findChild(chain, 'NodePatternContext')

    if (!relPattern || !targetPattern) return null

    // Edge direction
    const hasLeft = findChild(relPattern, 'LeftArrowHeadContext')
    const hasRight = findChild(relPattern, 'RightArrowHeadContext')
    let direction: 'out' | 'in' | 'any' = 'out'

    // Validate edge direction syntax:
    //   (a)-[*]->(b)  — valid OUT (text starts with '-')
    //   (a)<-[*]-(b)  — valid IN (text starts with '<')
    //   (a)-[*]-(b)   — valid ANY (no arrows)
    //   (a)<-[*]->(b) — valid ANY (both arrows)
    //   (a)->(b)      — INVALID (no dash before arrow)
    //   (a)<-(b)      — INVALID (no dash after arrow in reverse)
    const relText = relPattern.getText()
    if (hasRight && !relText.startsWith('-') && !relText.startsWith('<')) {
      throw new Error('Invalid edge direction')
    }

    // Deduct direction from arrow heads
    if (hasLeft && !hasRight) direction = 'in'
    else if (hasLeft && hasRight) direction = 'any'
    else if (!hasLeft && !hasRight) direction = 'any'  // no arrow = undirected

    // ── Relationship variable extraction: MATCH ()-[a]->() → edgeVariable: 'a' ──
    // Within RelationshipPatternContext, the VariableContext child is the
    // relationship variable (distinct from labels/types in RelationshipDetailContext).
    const relVarCtx = findChild(relPattern, 'VariableContext')
    const edgeVariable = relVarCtx ? findSymbolicName(relVarCtx) : null

    // Edge label
    let rangeInfo: { min: number; max: number | null } | undefined = undefined

    const relDetail = findChild(relPattern, 'RelationshipDetailContext')
    let edgeLabel: string | null = null
    let edgeProps: Record<string, unknown> | null = null
    if (relDetail) {
      const relTypes = findChild(relDetail, 'RelationshipTypesContext')
      if (relTypes) {
        // Support multiple types (separated by |)
        const relTypeNames = findAllChildren(relTypes, 'RelTypeNameContext')
        if (relTypeNames?.length) {
          edgeLabel = relTypeNames.map((n: any) => findSymbolicName(n)).filter(Boolean).join('|')
        }
      }

      // VARLEN range
      // A variable-length pattern `()-[r*]-( )` may carry one of
      //   *        → any number of hops (1..∞), min defaults to 1
      //   *n       → exactly n hops
      //   *m..n    → at least m, at most n hops
      //   *m..     → at least m hops (unbounded)
      //   *..n     → at most n hops (min 1)
      // An unbounded upper bound is represented as `max: null`; callers must
      // treat `null` as infinity rather than substituting a finite default.
      if (findChild(relDetail, 'RangeLiteralContext')) {
        const rctx = findChild(relDetail, 'RangeLiteralContext')
        const rangeText = rctx!.getText ? rctx!.getText() : ''
        const cleanRange = rangeText.startsWith('*') ? rangeText.slice(1) : rangeText
        const parts = cleanRange.split('..')
        if (cleanRange === '') {
          // `*` → 1..∞
          rangeInfo = { min: 1, max: null }
        } else if (parts.length === 2) {
          const lo = parts[0] === '' ? 1 : parseInt(parts[0], 10)
          const hi = parts[1] === '' ? null : parseInt(parts[1], 10)
          rangeInfo = { min: Number.isFinite(lo) ? lo : 1, max: hi === null ? null : (Number.isFinite(hi) ? hi : null) }
        } else {
          const val = parseInt(parts[0], 10)
          rangeInfo = { min: Number.isFinite(val) ? val : 1, max: Number.isFinite(val) ? val : 1 }
        }
      }

      // ── Relationship property extraction (edgeProps) ──
      // MATCH ()-[r:KNOWS {name: 'monkey'}]->() — extract {name: 'monkey'}
      const edgePropsNode = findChild(relDetail, 'PropertiesContext')
      if (edgePropsNode) {
        edgeProps = extractMapLiteral(edgePropsNode)
      }
    }

    // Target
    const targetVar = findSymbolicName(findChild(targetPattern, 'VariableContext'))
    const targetLabelCtx = findChild(targetPattern, 'NodeLabelContext')
    const targetLabel = targetLabelCtx ? extractLabel(targetLabelCtx) : null
    const targetPropsNode = findChild(targetPattern, 'PropertiesContext')
    const targetProps = targetPropsNode ? extractMapLiteral(targetPropsNode) : null

    return {
      source,
      direction,
      edgeLabel,
      edgeProps,
      targetAlias: targetVar ?? '',
      targetLabel,
      targetProps,
      ...(rangeInfo ? { range: rangeInfo } : {}),
      ...(edgeVariable ? { edgeVariable } : {}),
    }
  }

  const parts: ParsedEdgeStep[][] = []
  if (patternElements.length) {
    for (const pe of patternElements) {
      const peNodes = findAllChildren(pe, 'NodePatternContext')
      const peChains = findAllChildren(pe, 'PatternElementChainContext')
      // Source of chain ci is the node pattern at index ci within this element.
      let currentSource = peNodes.length ? (findSymbolicName(findChild(peNodes[0], 'VariableContext')) ?? '') : ''
      const partEdges: ParsedEdgeStep[] = []
      for (let ci = 0; ci < peChains.length; ci++) {
        const edge = buildEdge(peChains[ci], currentSource)
        if (edge) {
          edges.push(edge)
          partEdges.push(edge)
        }
        // Advance to the target variable for the next chain in this element.
        currentSource = edge?.targetAlias ?? ''
      }
      if (partEdges.length) parts.push(partEdges)
    }
  } else {
    // Fallback for grammars without PatternElementContext: process flat chains.
    let currentSource = variable ?? ''
    const partEdges: ParsedEdgeStep[] = []
    for (const chain of findAllChildren(matchCtx, 'PatternElementChainContext')) {
      const edge = buildEdge(chain, currentSource)
      if (edge) {
        edges.push(edge)
        partEdges.push(edge)
      }
      currentSource = edge?.targetAlias ?? ''
    }
    if (partEdges.length) parts.push(partEdges)
  }

  // Identify disjoint comma-separated bound nodes: every node pattern whose
  // variable is neither the primary variable nor any edge endpoint.  In
  // `MATCH (a {name:'A'}), (c {name:'C'}) MATCH (a)-->(b)`, `c` is such a node.
  const connectedVars = new Set<string>()
  if (variable) connectedVars.add(variable)
  for (const e of edges) {
    if (e.source) connectedVars.add(e.source)
    if (e.targetAlias) connectedVars.add(e.targetAlias)
  }
  const extraNodes: ParsedMatch['extraNodes'] = []
  for (const np of nodePatterns) {
    const nv = findSymbolicName(findChild(np, 'VariableContext'))
    if (!nv || connectedVars.has(nv)) continue
    const nl = findChild(np, 'NodeLabelContext')
    const nPropsNode = findChild(np, 'PropertiesContext')
    extraNodes.push({
      variable: nv,
      label: nl ? extractLabel(nl) : null,
      properties: nPropsNode ? extractMapLiteral(nPropsNode) : null,
    })
  }

  return {
    variable,
    label,
    edges,
    properties,
    parts,
    extraNodes,
  }
}

/**
 * Extract WHERE clauses embedded inside MATCH clause.
 */
function extractWhereFromMatch(matchCtx: any): FilterClause[] {
  const whereCtx = findChild(matchCtx, 'WhereContext')
  if (!whereCtx) return []
  return extractWhere(whereCtx)
}

/**
 * Extract WHERE filters from a WhereContext.
 * 使用文本正则解析（因为 ANTLR webpack 后 Context 的子节点访问器不可用）。
 */
function extractWhere(whereCtx: any): FilterClause[] {
  const whereText = getTextRecursive(whereCtx)
  return parseWhereClause(whereText)
}

/**
 * 从 WHERE 子句文本中提取所有条件。
 * 用正则拆解 "n.age > 30 AND n.status = \"vip\" OR n.name IN [...]"。
 */
function parseWhereClause(text: string): FilterClause[] {
  const filters: FilterClause[] = []
  if (!text) return filters

  // 移除 "WHERE " 前缀
  const trimmed = text.replace(/^WHERE\s+/i, '').trim()

  // 按 AND/OR 拆分为独立的 comparison
  // 简单拆分：按 " AND " 或 " OR "（不拆 IN [...] 内的内容）
  const conditions = splitByTopLevelAndOr(trimmed)
  
  for (const cond of conditions) {
    const filter = parseSingleCondition(cond)
    if (filter) filters.push(filter)
  }

  return filters
}

/**
 * 按顶层的 AND/OR 拆分条件（不拆分字符串字面量或括号内的内容）。
 */
function splitByTopLevelAndOr(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let inString = false
  let stringChar = ''
  let current = ''

  const tokens = text.split(/\b(AND|OR)\b/i)
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (/^(AND|OR)$/i.test(t)) {
      parts.push(current.trim())
      current = ''
    } else {
      current += t
    }
  }
  if (current.trim()) parts.push(current.trim())

  return parts
}

/**
 * 解析单个条件属性表达式。
 * 支持: prop op value, x IN [...], x IS [NOT] NULL, NOT prop ...
 */
function parseSingleCondition(text: string): FilterClause | null {
  const t = text.trim()
  
  // Handle NOT prefix: "NOT n.name = 'Alice'" → parse "n.name = 'Alice'" with negated flag
  const notMatch = t.match(/^NOT\s+(.+)$/i)
  if (notMatch) {
    const inner = parseSingleCondition(notMatch[1].trim())
    if (inner) {
      inner.negated = true
      return inner
    }
  }
  
  // IS [NOT] NULL
  const isNullMatch = t.match(/^(\w+)\.(\w+)\s+IS\s+(NOT\s+)?NULL$/i)
  if (isNullMatch) {
    return {
      source: isNullMatch[1],
      property: isNullMatch[2],
      operator: isNullMatch[3] ? 'IS_NOT_NULL' as const : 'IS_NULL' as const,
      value: null,
    }
  }

  // IN [...]
  const inMatch = t.match(/^(\w+)\.(\w+)\s+IN\s+(\[.+?\])$/i)
  if (inMatch) {
    let listValue: unknown = inMatch[3]
    try { listValue = JSON.parse(inMatch[3]) } catch {}
    return {
      source: inMatch[1],
      property: inMatch[2],
      operator: 'IN' as const,
      value: listValue,
    }
  }

  // STARTS WITH / ENDS WITH / CONTAINS
  const strMatch = t.match(/^(\w+)\.(\w+)\s+(STARTS\s+WITH|ENDS\s+WITH|CONTAINS)\s+(.+)$/i)
  if (strMatch) {
    let val: unknown = strMatch[4].trim()
    if ((val as string).startsWith("'") || (val as string).startsWith('"')) val = unescapeCypherString((val as string).slice(1, -1))
    else if (/^(true|false)$/i.test(val as string)) val = (val as string).toUpperCase() === 'TRUE'
    else if (/^null$/i.test(val as string)) val = null
    return {
      source: strMatch[1],
      property: strMatch[2],
      operator: strMatch[3].toUpperCase().replace(' ', '_') as FilterClause['operator'],
      value: val,
    }
  }

  // Label predicate `var:Label` / `var:!Label` (e.g. `WHERE a:A`).  Encoded as
  // a source-less filter whose only payload is the `expression` text (`a:A`),
  // plus the raw predicate in `value`.  Because `source`/`property` are empty it
  // can never be mistaken for a constant property filter during the walk; label
  // semantics are applied separately (labelFilterItems for the primary MATCH,
  // and the post-OPTIONAL label filter for OPTIONAL MATCH).
  const labelPredMatch = t.match(/^(\w+)\s*:\s*(!?\w+)$/)
  if (labelPredMatch) {
    const varName = labelPredMatch[1]
    const label = labelPredMatch[2].replace(/^!/, '')
    return {
      source: '',
      property: '',
      operator: 'EQ' as const,
      value: label,
      expression: `${varName}:${labelPredMatch[2]}`,
      negated: labelPredMatch[2].startsWith('!'),
    }
  }

  // =, !=, <>, >, >=, <, <=
  const compMatch = t.match(/^(\w+)\.(\w+)\s*(!?=|<>|[<>]=?)\s*(.+)$/)
  if (compMatch) {
    const opMap: Record<string, FilterClause['operator']> = {
      '=': 'EQ',
      '!=': 'NEQ',
      '<>': 'NEQ',
      '>': 'GT',
      '>=': 'GTE',
      '<': 'LT',
      '<=': 'LTE',
    }
    const operator = opMap[compMatch[3]] ?? 'EQ'
    let value: unknown = compMatch[4].trim()
    // Parse value: string, number, bool, null
    if ((value as string).startsWith("'") || (value as string).startsWith('"')) {
      value = unescapeCypherString((value as string).slice(1, -1))
    } else if (/^-?\d+$/.test(value as string)) {
      value = parseInt(value as string, 10)
    } else if (/^-?\d+\.\d+$/.test(value as string)) {
      value = parseFloat(value as string)
    } else if (/^(true|false)$/i.test(value as string)) {
      value = (value as string).toUpperCase() === 'TRUE'
    } else if (/^null$/i.test(value as string)) {
      value = null
    }
    return { source: compMatch[1], property: compMatch[2], operator, value }
  }

  // 算术/复合表达式比较：`n.num % 2 = 0`、`a.x + b.y > 10`、`n.count + 1 <= 5`。
  // 左侧是带算术运算符的复合表达式（不止「变量.属性」），右侧是标量。
  // 用 `expression`（左侧完整文本）+ operator + value 表示，执行层通过
  // _evaluateExpression(expression, ctx) 求值后比较。
  const arithMatch = t.match(/^(.+?)\s*(!?=|<>|[<>]=?)\s*(-?\d+(?:\.\d+)?|'(?:[^']|'')*'|"(?:[^"]|"")*"|true|false|null)$/i)
  if (arithMatch && /[+\-*/%]/.test(arithMatch[1])) {
    const opMap: Record<string, FilterClause['operator']> = {
      '=': 'EQ', '!=': 'NEQ', '<>': 'NEQ', '>': 'GT', '>=': 'GTE', '<': 'LT', '<=': 'LTE',
    }
    const operator = opMap[arithMatch[2]] ?? 'EQ'
    let value: unknown = arithMatch[3].trim()
    if ((value as string).startsWith("'") || (value as string).startsWith('"')) {
      value = unescapeCypherString((value as string).slice(1, -1))
    } else if (/^-?\d+\.\d+$/.test(value as string)) {
      value = parseFloat(value as string)
    } else if (/^-?\d+$/.test(value as string)) {
      value = parseInt(value as string, 10)
    } else if (/^(true|false)$/i.test(value as string)) {
      value = (value as string).toUpperCase() === 'TRUE'
    } else if (/^null$/i.test(value as string)) {
      value = null
    }
    return { source: '', property: '', operator, value, expression: arithMatch[1].trim() }
  }

  return null
}

// ═══════════════════════════════════════════════════════════════
// RETURN 提取
// ═══════════════════════════════════════════════════════════════

function extractReturn(returnCtx: any): ParsedReturn {
  const columns: Array<{ expression: string; alias: string | null }> = []
  let orderBy: Array<{ property: string; direction: 'ASC' | 'DESC' }> = []
  let limit: number | undefined
  let skip: number | undefined
  let aggregate: AggregateClause | undefined
  let aggregates: AggregateClause[] | undefined

  function walk(node: any) {
    if (!node || !node.children) return
    const name = node.constructor?.name ?? ''

    if (name === 'ReturnItemContext') {
      const text = getTextRecursive(node)
      const flat = text.replace(/\s+/g, ' ')  // 压平所有空白（包括换行）
      const asMatch = flat.match(/^(.+?)\s+AS\s+(\w+)$/i)
      if (asMatch) {
        columns.push({ expression: asMatch[1].trim(), alias: asMatch[2] })
      } else {
        columns.push({ expression: text, alias: null })
      }

      // Check for aggregation — collect every aggregate call, not just the
      // first, so `RETURN collect(DISTINCT a.x) AS a, collect(DISTINCT b.x) AS b`
      // yields two aggregate clauses.  Note percentileDisc/percentileCont are
      // deliberately EXCLUDED here: they carry a two-argument form whose value
      // may be a prior WITH column (not a node property), which the graph
      // engine's aggregation path cannot resolve — they stay on the expression
      // path that raises NumberOutOfRange/ArgumentError correctly.
      if (/\b(count|sum|avg|max|min|collect)\s*\(/i.test(text)) {
        const fnMatch = text.match(/^\s*(count|sum|avg|max|min|collect)\s*\(/i)
        if (fnMatch) {
          const aggClause: AggregateClause = { function: fnMatch[1].toLowerCase(), column: text, distinct: false }
          if (!aggregate) aggregate = aggClause
          if (!aggregates) aggregates = []
          aggregates.push(aggClause)
        }
      }
      return
    }

    if (name === 'SortItemContext') {
      // A sort item is `<expression> [ASC|ASCENDING|DESC|DESCENDING]`. The
      // expression may be an arbitrary composite expression (e.g.
      // `NOT (a.bool AND a.bool2)`, `a.num + a.num2`), not just a bare
      // property. Split on whitespace would truncate it to its first token, so
      // pull the full expression from the grammar's `expression()` child and
      // read the direction from the dedicated direction tokens instead.
      const exprNode = typeof node.expression === 'function' ? node.expression() : null
      const exprText = exprNode ? getTextRecursive(exprNode).trim() : ''
      const isDesc = !!(node.DESC?.() ?? null) || !!(node.DESCENDING?.() ?? null)
      const orderDir = isDesc ? 'DESC' as const : 'ASC' as const
      const orderProp = exprText.replace(/^\w+\./, '')
      orderBy.push({ property: orderProp, expression: exprText, direction: orderDir })
      return
    }

    if (name === 'LimitContext') {
      const intLit = findChild(node, 'IntegerLiteralContext')
      if (intLit) limit = parseInt(getTextRecursive(intLit), 10)
      return
    }

    if (name === 'SkipContext') {
      // `SKIP n` lives in ReturnBody alongside LIMIT, as a `SkipContext` whose
      // integer is an `IntegerLiteralContext` (mirroring `LimitContext`).
      const intLit = findChild(node, 'IntegerLiteralContext')
      if (intLit) skip = parseInt(getTextRecursive(intLit), 10)
      return
    }

    for (const child of node.children) walk(child)
  }

  walk(returnCtx)
  return { columns, orderBy, limit, skip, aggregate, aggregates }
}

// ═══════════════════════════════════════════════════════════════
// CREATE 提取
// ═══════════════════════════════════════════════════════════════

function extractCreateNodes(createCtx: any): Array<{ alias: string; label: string | null; props: Record<string, unknown> | null }> {
  const nodes: Array<{ alias: string; label: string | null; props: Record<string, unknown> | null }> = []
  const nodePatterns = findAllChildren(createCtx, 'NodePatternContext')
  // Map a node variable to its first-created index so a shared source variable
  // across comma-separated patterns (e.g. `(a)-[:T]->(:B), (a)-[:T]->(:C)`)
  // yields a single node rather than a duplicate. Anonymous nodes stay unique.
  const varToIdx = new Map<string, number>()

  for (const np of nodePatterns) {
    const variable = findSymbolicName(findChild(np, 'VariableContext')) ?? ''
    const labelCtx = findChild(np, 'NodeLabelContext')
    const label = labelCtx ? extractLabel(labelCtx) : null
    const propsNode = findChild(np, 'PropertiesContext')
    const props = propsNode ? extractMapLiteral(propsNode) : null
    // Reuse a prior variable's node instead of emitting a duplicate (branching).
    if (variable && varToIdx.has(variable)) {
      continue
    }
    if (variable) varToIdx.set(variable, nodes.length)
    nodes.push({ alias: variable, label, props })
  }

  return nodes
}

/** 从 CREATE ctx 中提取边（关系链） */
function extractCreateEdges(createCtx: any): Array<{
  source: string; target: string; sourceIdx?: number; targetIdx?: number;
  label: string | null; direction: 'out' | 'in' | 'any'
}> {
  const edges: Array<{
    source: string; target: string; sourceIdx?: number; targetIdx?: number;
    label: string | null; direction: 'out' | 'in' | 'any'
  }> = []
  // Map each NodePatternContext object to its dedup'd index, matching the
  // order produced by extractCreateNodes: iterate nodes in document order,
  // dedup only NAMED variables (reuse the first occurrence's index), and give
  // every anonymous node a fresh, monotonically increasing index. This keeps
  // shared middle nodes in a chain (e.g. `()-[:X]-()-[:X]->()`) stable across
  // both edges without inflating indices.
  const nodeToIdx = new Map<any, number>()
  {
    const varToIdx2 = new Map<string, number>()
    let idx = 0
    for (const np of findAllChildren(createCtx, 'NodePatternContext')) {
      const variable = findSymbolicName(findChild(np, 'VariableContext')) ?? ''
      if (variable && varToIdx2.has(variable)) {
        nodeToIdx.set(np, varToIdx2.get(variable)!)
      } else {
        if (variable) varToIdx2.set(variable, idx)
        nodeToIdx.set(np, idx)
        idx++
      }
    }
  }

  const patternElements = findAllChildren(createCtx, 'PatternElementContext')
  for (const pe of patternElements) {
    const peNodes = findAllChildren(pe, 'NodePatternContext')
    if (peNodes.length < 2) continue

    const chainCtxs = findAllChildren(pe, 'PatternElementChainContext')
    for (let ci = 0; ci < chainCtxs.length; ci++) {
      const relPattern = findChild(chainCtxs[ci], 'RelationshipPatternContext')
      if (!relPattern) continue

      const relDetail = findChild(relPattern, 'RelationshipDetailContext')
      let edgeLabel: string | null = null
      let edgeProps: Record<string, unknown> | null = null
      if (relDetail) {
        const typeName = findChild(relDetail, 'RelTypeNameContext')
        edgeLabel = typeName ? findSymbolicName(typeName) : null
        const propsNode = findChild(relDetail, 'PropertiesContext')
        if (propsNode) edgeProps = extractMapLiteral(propsNode)
      }

      const hasLeft = findChild(relPattern, 'LeftArrowHeadContext')
      const hasRight = findChild(relPattern, 'RightArrowHeadContext')
      let direction: 'out' | 'in' | 'any' = 'out'
      if (hasLeft && !hasRight) direction = 'in'
      else if (hasLeft && hasRight) direction = 'any'
      else if (!hasLeft && !hasRight) direction = 'any'

      const srcNode = ci < peNodes.length ? peNodes[ci] : null
      const dstNode = ci + 1 < peNodes.length ? peNodes[ci + 1] : null
      const sourceAlias = srcNode ? findSymbolicName(findChild(srcNode, 'VariableContext')) ?? '' : ''
      const targetAlias = dstNode ? findSymbolicName(findChild(dstNode, 'VariableContext')) ?? '' : ''
      // Dedup'd node indices (stable for shared middle nodes in a chain).
      const baseSrcIdx = srcNode ? nodeToIdx.get(srcNode)! : 0
      const baseTgtIdx = dstNode ? nodeToIdx.get(dstNode)! : baseSrcIdx + 1
      // direction="in"（<-[]-）: Cypher 语法逆序，需要交换 sourceIdx 和 targetIdx
      // 存储层面总是 src→dst，方向用 direction 表示
      const realSrcIdx = direction === 'in' ? baseTgtIdx : baseSrcIdx
      const realTgtIdx = direction === 'in' ? baseSrcIdx : baseTgtIdx
      const realSource = direction === 'in' ? targetAlias : sourceAlias
      const realTarget = direction === 'in' ? sourceAlias : targetAlias
      edges.push({
        source: realSource,
        target: realTarget,
        sourceIdx: realSrcIdx,
        targetIdx: realTgtIdx,
        label: edgeLabel,
        props: edgeProps,
        direction,
      })
    }
  }

  return edges
}

// ═══════════════════════════════════════════════════════════════
// DELETE 提取
// ═══════════════════════════════════════════════════════════════

function extractDeleteTargets(deleteCtx: any): string[] {
  const targets: string[] = []
  const names = findAllChildren(deleteCtx, 'SymbolicNameContext')
  for (const n of names) {
    targets.push(getTextRecursive(n))
  }
  return targets
}

function isDetachDelete(deleteCtx: any): boolean {
  return getTextRecursive(deleteCtx).toUpperCase().startsWith('DETACH')
}

// ═══════════════════════════════════════════════════════════════
// MERGE 提取
// ═══════════════════════════════════════════════════════════════

function extractMerge(mergeCtx: any): { nodes: QueryPlan['mergeNodes']; edges: QueryPlan['mergeEdges'] } {
  const nodes: QueryPlan['mergeNodes'] = []
  const edges: QueryPlan['mergeEdges'] = []

  // MERGE pattern is inside MergeClause → Pattern → PatternPart → AnonymousPatternPart → PatternElement
  // It may be nested several levels deep
  // MERGE pattern: MergeClause → PatternPart → AnonymousPatternPart → PatternElement → NodePattern
  // No intermediate PatternContext in ANTLR. Just find NodePattern directly.
  const nodePatterns = findAllChildren(mergeCtx, 'NodePatternContext')
  for (const np of nodePatterns) {
    const variable = findSymbolicName(findChild(np, 'VariableContext')) ?? ''
    const labelCtx = findChild(np, 'NodeLabelContext')
    const label = labelCtx ? extractLabel(labelCtx) : null
    nodes.push({ alias: variable, label, props: extractMapLiteral(findChild(np, 'PropertiesContext')) ?? null })
  }
  if (!nodePatterns.length) return { nodes, edges }

  // Edge patterns in chains (from PatternElementChain inside PatternElement)
  const chains = findAllChildren(mergeCtx, 'PatternElementChainContext')
  for (const chain of chains) {
    const relPattern = findChild(chain, 'RelationshipPatternContext')
    if (!relPattern) continue

    const relDetail = findChild(relPattern, 'RelationshipDetailContext')
    let edgeLabel: string | null = null
    if (relDetail) {
      const firstType = findChild(relDetail, 'RelTypeNameContext')
      edgeLabel = firstType ? findSymbolicName(firstType) : null
    }

    const hasLeft = findChild(relPattern, 'LeftArrowHeadContext')
    const hasRight = findChild(relPattern, 'RightArrowHeadContext')
    let direction: 'out' | 'in' | 'any' = 'out'
    if (hasLeft && !hasRight) direction = 'in'
    else if (hasLeft && hasRight) direction = 'any'
    else if (!hasLeft && !hasRight) direction = 'any'

    const source = nodes[nodes.length - 1]?.alias ?? ''
    const targetPattern = findChild(chain, 'NodePatternContext')
    if (targetPattern) {
      const tv = findSymbolicName(findChild(targetPattern, 'VariableContext')) ?? ''
      const tlCtx = findChild(targetPattern, 'NodeLabelContext')
      const tl = tlCtx ? findSymbolicName(tlCtx) : null
      nodes.push({ alias: tv, label: tl, props: null })
      edges.push({ source, target: tv, label: edgeLabel, direction })
    }
  }

  return { nodes, edges }
}

// ═══════════════════════════════════════════════════════════════
// SET / REMOVE 提取
// ═══════════════════════════════════════════════════════════════

/** Parse a textual property-map literal `{name:'A', name2:'B', num:5}` (or `{}`)
 *  into a plain object.  Values may be quoted strings, numbers, booleans,
 *  `null`, or nested lists.  Keys are unquoted identifiers or quoted strings. */
function _parseMapLiteral(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const body = text.trim()
  if (!body.startsWith('{') || !body.endsWith('}')) return result
  const inner = body.slice(1, -1).trim()
  if (!inner) return result
  const entries = splitByTopLevelComma(inner)
  for (const entry of entries) {
    const eq = entry.indexOf(':')
    if (eq < 0) continue
    let key = entry.slice(0, eq).trim()
    let valText = entry.slice(eq + 1).trim()
    if ((key.startsWith("'") && key.endsWith("'")) || (key.startsWith('"') && key.endsWith('"'))) {
      key = key.slice(1, -1)
    }
    let val: unknown = valText
    if ((valText.startsWith("'") && valText.endsWith("'")) || (valText.startsWith('"') && valText.endsWith('"'))) {
      val = unescapeCypherString(valText.slice(1, -1))
    } else if (valText === 'true') val = true
    else if (valText === 'false') val = false
    else if (valText === 'null') val = null
    else if (/^-?\d+$/.test(valText)) {
      const n = Number(valText)
      val = Number.isSafeInteger(n) ? n : BigInt(valText)
    } else if (/^-?\d+\.\d+$/.test(valText)) val = parseFloat(valText)
    else if (valText.startsWith('[') && valText.endsWith(']')) {
      val = parseListLiteral(valText)
    }
    result[key] = val
  }
  return result
}

function extractSetClauses(setCtx: any): QueryPlan['setClauses'] {
  const sets: QueryPlan['setClauses'] = []
  const text = getTextRecursive(setCtx)
  // Remove "SET " prefix
  const setText = text.replace(/^SET\s+/i, '')
  // Split by comma at top level
  const items = splitByTopLevelComma(setText)
  for (const item of items) {
    const trimmed = item.trim()

    // Map assignment / append: `n = {name:'A', name2:'B'}` (replace) or
    // `n += {name2:'C'}` (merge).  The optional operator distinguishes MAP vs
    // MAP_APPEND; both carry the parsed property map in `props`.
    const mapMatch = trimmed.match(/^\(?(\w+)\)?\s*(\+=|=)\s*(\{.*\})$/)
    if (mapMatch) {
      const alias = mapMatch[1]
      const op = mapMatch[2]
      const props = _parseMapLiteral(mapMatch[3])
      sets.push({ kind: op === '+=' ? 'MAP_APPEND' : 'MAP', alias, props })
      continue
    }

    // Label assignment: `n:Foo`, `n:Foo:Bar`, or `n :Foo` (whitespace before
    // the colon is legal and ignored).
    const labelMatch = trimmed.match(/^\(?(\w+)\)?\s*:\s*([\w\s:]+)$/)
    if (labelMatch && !trimmed.includes('=')) {
      const alias = labelMatch[1]
      const labels = labelMatch[2].split(':').map(s => s.trim()).filter(Boolean)
      if (labels.length) {
        sets.push({ kind: 'LABEL', alias, labels })
        continue
      }
    }

    // Property assignment: `n.prop = <value>` or `(n).prop = <value>`.
    // The selector may be parenthesized (`(n).name`), which the TCK uses to
    // select a node/relationship via a simple parenthesized expression.
    const eqMatch = trimmed.match(/^\(?(\w+)\)?\.(\w+)\s*(=|\+=)\s*(.+)$/)
    if (eqMatch) {
      const alias = eqMatch[1]
      const propName = eqMatch[2]
      let val: unknown = eqMatch[4].trim()
      let expression: string | undefined
      // Try to parse literal values; otherwise keep the raw text as an
      // expression string so the SET execution block can evaluate it against
      // the matched node (e.g. `n.name + ' was here'`, `a.numbers + [4,5]`).
      if ((val as string).startsWith("'") || (val as string).startsWith('"')) {
        val = (val as string).slice(1, -1)
      } else if (val === 'true') val = true
      else if (val === 'false') val = false
      else if (/^-?\d+$/.test(val as string)) val = parseInt(val as string, 10)
      else if (/^-?\d+\.\d+$/.test(val as string)) val = parseFloat(val as string)
      else {
        expression = val as string
      }
      sets.push({ kind: 'PROP', property: propName, value: val, alias, expression })
    }
  }
  return sets
}

function extractRemoveClauses(removeCtx: any): QueryPlan['removeClauses'] {
  const removes: QueryPlan['removeClauses'] = []
  const text = getTextRecursive(removeCtx)
  // Remove "REMOVE " prefix, split by comma
  const removeText = text.replace(/^REMOVE\s+/i, '')
  const items = splitByTopLevelComma(removeText)
  for (const item of items) {
    const trimItem = item.trim()
    // Detect label removal: `n:Label` or multiple labels `n:L1:L3`
    const labelMatch = trimItem.match(/^(\w+):([\w:]+)$/)
    if (labelMatch) {
      const ref = labelMatch[1]
      for (const label of labelMatch[2].split(':')) {
        if (!label) continue
        removes.push({ type: 'REMOVE_LABEL', ref, label })
      }
    } else {
      // Property removal: n.prop
      const propMatch = trimItem.match(/^(\w+)\.(\w+)$/)
      if (propMatch) {
        removes.push({ type: 'REMOVE_PROP', ref: propMatch[1], property: propMatch[2] })
      } else {
        removes.push({ type: 'REMOVE_PROP', property: trimItem })
      }
    }
  }
  return removes
}

// ═══════════════════════════════════════════════════════════════
// UNWIND 提取
// ═══════════════════════════════════════════════════════════════

function extractUnwind(unwindCtx: any): QueryPlan['unwind'] {
  // The bound variable is the one following `AS`, which is always the LAST
  // VariableContext within the UNWIND clause.  Using findChild (first match)
  // is wrong here: when the list expression itself references a variable —
  // `UNWIND range(0, i) AS j` — the first VariableContext is `i` (from the
  // `range` argument), not the bound `j`.  Take the trailing VariableContext
  // instead so the bound name is correct regardless of the list expression.
  const varCtxs = findAllChildren(unwindCtx, 'VariableContext')
  const varCtx = varCtxs.length ? varCtxs[varCtxs.length - 1] : null
  const name = varCtx ? getTextRecursive(varCtx) : ''

  // List expression
  const expr = findChild(unwindCtx, 'ExpressionContext')
  const text = expr ? getTextRecursive(expr) : ''
  let list: any[] = []
  let varRef: string | undefined

  if (text.startsWith('[') && text.endsWith(']')) {
    // Literal list. Parse elements uniformly: a string literal keeps its
    // quotes as raw text (so `_resolveUnwindList` → `_evaluateExpression`
    // can faithfully restore the string value, including the empty string
    // `''` and a whitespace-only string `' '`). Numbers/booleans/null resolve
    // to their JS values; anything else (temporal constructors, `range(...)`,
    // nested list literals, etc.) stays raw text for the expression engine.
    const inner = text.slice(1, -1).trim()
    if (inner) {
      list = _splitListItems(inner).map(item => {
        const trimmed = item.trim()
        if ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
            (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
          // Keep the quotes: the element is a string literal, not a variable/
          // expression. This preserves the empty string and whitespace.
          return trimmed
        }
        if (trimmed.toLowerCase() === 'true') return true
        if (trimmed.toLowerCase() === 'false') return false
        if (trimmed.toLowerCase() === 'null') return null
        const num = Number(trimmed)
        if (!isNaN(num)) return num
        return trimmed
      })
    } else {
      list = []
    }
  } else {
    // Variable reference
    varRef = text
  }

  return { list, name, var: varRef }
}

// ═══════════════════════════════════════════════════════════════
// FOREACH 提取
// ═══════════════════════════════════════════════════════════════

function extractForEach(foreachCtx: any): ForEachClause {
  const varCtx = findChild(foreachCtx, 'VariableContext')
  const name = varCtx ? getTextRecursive(varCtx) : ''

  // List expression
  const expr = findChild(foreachCtx, 'ExpressionContext')
  const text = expr ? getTextRecursive(expr) : ''
  let list: any[] = []
  if (text.startsWith('[') && text.endsWith(']')) {
    try { list = JSON.parse(text) } catch { try { list = JSON.parse(text.replace(/'/g, '"')) } catch { list = text as unknown[] } }
  }

  // Updates: find sub-clauses
  const updates: ForEachClause['updates'] = []
  const bodyCtx = findAllChildren(foreachCtx, 'ClauseContext')
  for (const bc of bodyCtx) {
    const createCtx = findChild(bc, 'CreateClauseContext')
    if (createCtx) {
      const nodes = extractCreateNodes(createCtx)
      for (const n of nodes) {
        updates.push({ type: 'CREATE', alias: n.alias, label: n.label ?? undefined, props: n.props ?? undefined })
      }
    }
    const setCtx = findChild(bc, 'SetClauseContext')
    if (setCtx) {
      const setClauses = extractSetClauses(setCtx)
      for (const sc of setClauses) {
        updates.push({ type: 'SET', alias: '', property: sc.property, value: sc.value as string })
      }
    }
  }

  return { list, name, updates }
}

// ═══════════════════════════════════════════════════════════════
// CALL 提取
// ═══════════════════════════════════════════════════════════════

function extractCall(callCtx: any): {
  isProcedure: boolean
  procedureName?: string
  args: any[]
  yieldItems?: Array<{ name: string; alias: string | null }>
  subPlan?: QueryPlan
} {
  const text = getTextRecursive(callCtx)

  // Check if it's a subquery (CALL { ... }) or procedure (CALL proc())
  if (text.includes('{')) {
    // Subquery: extract inner query
    const innerMatch = text.match(new RegExp('CALL\\s*\\{([^}]+)\\}', 'is'))
    if (innerMatch) {
      const subPlan = buildQueryPlan(innerMatch[1].trim())
      // Detect IN TRANSACTIONS [OF N ROWS]
      const txMatch = text.match(new RegExp('IN\\s+TRANSACTIONS(?:\\s+OF\\s+(\\d+)\\s+ROWS)?', 'is'))
      if (txMatch) {
        subPlan.inTransactions = true
        if (txMatch[1]) subPlan.inTransactionsBatchSize = parseInt(txMatch[1], 10)
      }
      return { isProcedure: false, args: [], subPlan }
    }
  }

  // Procedure call: CALL namespace.procedure(args) YIELD items
  const procMatch = text.match(new RegExp('CALL\\s+([\\w.]+)\\s*\\(([^)]*)\\)(\\s+YIELD\\s+(.+))?', 'is'))
  if (procMatch) {
    const procedureName = procMatch[1]
    const argsText = procMatch[2].trim()
    const args = argsText ? argsText.split(',').map(a => a.trim()) : []
    const yieldItems: Array<{ name: string; alias: string | null }> = []
    if (procMatch[4]) {
      const yields = procMatch[4].split(',')
      for (const y of yields) {
        const yt = y.trim()
        const asMatch = yt.match(/^(\w+)\s+AS\s+(\w+)$/i)
        if (asMatch) {
          yieldItems.push({ name: asMatch[1], alias: asMatch[2] })
        } else {
          yieldItems.push({ name: yt, alias: null })
        }
      }
    }
    return { isProcedure: true, procedureName, args, yieldItems }
  }

  return { isProcedure: false, args: [] }
}

// ═══════════════════════════════════════════════════════════════
// WITH 提取
// ═══════════════════════════════════════════════════════════════

function extractWith(withCtx: any): QueryPlan['with'] {
  const columns: Array<{ expression: string; alias: string | null }> = []
  const filters: FilterClause[] = []
  let orderBy: Array<{ property: string; direction: 'ASC' | 'DESC' }> = []
  let limit: number | undefined
  let skip: number | undefined
  let aggregate: AggregateClause | undefined

  function walk(node: any) {
    if (!node || !node.children) return
    const name = node.constructor?.name ?? ''

    if (name === 'WhereContext') {
      // `WITH n WHERE <cond>` — extract the trailing filter(s) the same way a
      // MATCH ... WHERE does, so `WITH ... WHERE n.num % 2 = 0` is honored.
      const whereText = getTextRecursive(node)
      filters.push(...parseWhereClause(whereText))
      return
    }
    if (name === 'ReturnItemContext') {
      // WITH uses same ReturnItem structure as RETURN
      const text = getTextRecursive(node)
      const asMatch = text.match(/^(.+?)\s+AS\s+(\w+)$/i)
      if (asMatch) {
        columns.push({ expression: asMatch[1].trim(), alias: asMatch[2] })
      } else {
        columns.push({ expression: text, alias: null })
      }
      return
    }
    if (name.endsWith('Context') && !['SortItemContext', 'LimitContext', 'SkipContext', 'WithClauseContext'].includes(name)) {
      // 某些上下文节点可能直接包含列表字面量而不经过 ReturnItemContext
      // （如 WITH [...] AS x — ANTLR 可能不将其解析为 ReturnItemContext）
      const text = getTextRecursive(node)
      if (text && columns.length === 0) {
        // 尝试从整体文本解析列：WITH <col1>, <col2>, ... 
        const trimmed = text.trim()
        if (trimmed && !trimmed.match(/^(WITH|AS|LIMIT|ORDER|SKIP|WHERE|DISTINCT)\b/i)) {
          // fallback 解析在此场景暂不触发
        }
      }
      for (const child of node.children) walk(child)
      return
    }
    if (name === 'SortItemContext') {
      // See the identical note in `extractReturn`: the sort expression may be a
      // composite expression, so read it from the `expression()` child and the
      // direction from the dedicated ASC/DESC/ASCENDING/DESCENDING tokens.
      const exprNode = typeof node.expression === 'function' ? node.expression() : null
      const exprText = exprNode ? getTextRecursive(exprNode).trim() : ''
      const isDesc = !!(node.DESC?.() ?? null) || !!(node.DESCENDING?.() ?? null)
      const orderDir = isDesc ? 'DESC' as const : 'ASC' as const
      orderBy.push({ property: exprText.replace(/^\w+\./, ''), expression: exprText, direction: orderDir })
      return
    }
    if (name === 'LimitContext') {
      const intLit = findChild(node, 'IntegerLiteralContext')
      if (intLit) limit = parseInt(getTextRecursive(intLit), 10)
      return
    }
    if (name === 'SkipContext') {
      const intLit = findChild(node, 'IntegerLiteralContext')
      if (intLit) skip = parseInt(getTextRecursive(intLit), 10)
      return
    }

    for (const child of node.children) walk(child)
  }

  walk(withCtx)

  // Detect an aggregate call in the WITH projections (e.g.
  // `WITH count(*) AS cnt`) and surface it as `with.aggregate` so the graph
  // engine's `_executeWithClause` folds the rows instead of treating the call
  // as a scalar projection over each row (which would yield count=1).
  if (!aggregate) {
    for (const col of columns) {
      const expr = (col.expression || '').trim()
      // Skip pure identifiers and list comprehensions.
      if (!expr || !/^[a-zA-Z_]\w*\s*\(/.test(expr)) continue
      if (expr.startsWith('[') && expr.includes('IN') && expr.includes('|')) continue
      const m = expr.match(/^(count|sum|avg|max|min|collect|stdev|stdevp|percentilecont|percentiledisc)\s*\(\s*(DISTINCT\s+)?(.*?)\s*\)$/i)
      if (m) {
        // Strip the DISTINCT modifier from the value expression and surface it as
        // a boolean so the graph engine can apply unique-count semantics without
        // mis-parsing `DISTINCT n.name` as a property path.
        aggregate = {
          function: m[1].toLowerCase(),
          type: m[1].toLowerCase(),
          column: expr,
          alias: col.alias || undefined,
          field: m[3] || '*',
          distinct: !!m[2],
        }
        break
      }
    }
  }

  return { columns, filters, orderBy, limit, skip, aggregate }
}

// ═══════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════

/**
 * 将 Cypher 字符串转义序列解析为实际字符。
 * 支持: \\n → 换行, \\t → 制表符, \\r → 回车, \\b → 退格, \\f → 换页,
 *       \\\\ → 反斜杠, \\' → 单引号, \\" → 双引号, \\0 → NUL
 * 以及十六进制转义 \\uXXXX 和 \\xXX
 */
function unescapeCypherString(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[nrtbf0'"\\])/g, (match) => {
    const esc = match[1]
    switch (esc) {
      case 'n':  return '\n'
      case 'r':  return '\r'
      case 't':  return '\t'
      case 'b':  return '\b'
      case 'f':  return '\f'
      case '0':  return '\x00'
      case "'":  return "'"
      case '"':  return '"'
      case '\\': return '\\'
      default:
        if (esc.startsWith('u') || esc.startsWith('x')) {
          try { return String.fromCodePoint(parseInt(esc.slice(1), 16)) } catch { return match }
        }
        return match
    }
  })
}

/**
 * Extract a MapLiteral (e.g., {name: "Alice", age: 30}) into a Record.
 */
function extractMapLiteral(propsCtx: any): Record<string, unknown> | null {
  if (!propsCtx) return null
  const result: Record<string, unknown> = {}

  // 搜索 LiteralEntryContext（直接子节点或嵌套在 MapLiteralContext 下）
  let entries = (propsCtx.children || []).filter((c: any) => (c.constructor?.name ?? '') === 'LiteralEntryContext')
  if (entries.length === 0) {
    // PropertiesContext 的子节点可能是 MapLiteralContext（非 LiteralEntryContext）
    const mapCtx = (propsCtx.children || []).find((c: any) => (c.constructor?.name ?? '').includes('Map'))
    if (mapCtx) {
      entries = (mapCtx.children || []).filter((c: any) => (c.constructor?.name ?? '') === 'LiteralEntryContext')
    }
  }
  for (const entry of entries) {
    const keyCtx = findChild(entry, 'PropertyKeyNameContext')
    const key = keyCtx ? findSymbolicName(keyCtx) : null
    if (!key) continue

    const valueCtx = findChild(entry, 'ExpressionContext')
    let value: unknown = valueCtx ? getTextRecursive(valueCtx) : null

    // Try to parse literal values
    if (typeof value === 'string') {
      if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
        value = unescapeCypherString(value.slice(1, -1))
      } else if (value.startsWith('[') && value.endsWith(']')) {
        // 数组字面量解析
        value = parseListLiteral(value)
      } else if (/^-?\d+$/.test(value)) {
        // Integers outside the safe range are preserved as JS `bigint` rather
        // than a decimal string, so downstream code can distinguish them from
        // string-literal values (e.g. `'42'`) by `typeof` and avoid lossy
        // coercion. Safe integers stay as regular numbers.
        const bigVal = BigInt(value)
        if (bigVal > BigInt(Number.MAX_SAFE_INTEGER) || bigVal < BigInt(Number.MIN_SAFE_INTEGER)) {
          value = bigVal
        } else {
          value = parseInt(value, 10)
        }
      } else if (/^-?\d+\.\d+$/.test(value)) {
        value = parseFloat(value)
      } else if (value.toUpperCase() === 'TRUE') {
        value = true
      } else if (value.toUpperCase() === 'FALSE') {
        value = false
      } else if (value.toUpperCase() === 'NULL') {
        value = null
      }
    }

    result[key] = value
  }

  return Object.keys(result).length > 0 ? result : null
}

/** 智能分割列表字面量（考虑括号/引号内的逗号） */
function smartSplit(text: string): string[] {
  const result: string[] = []
  let depth = 0, inQuote = false, quoteChar = '', cur = ''
  for (const ch of text) {
    if (inQuote) {
      if (ch === quoteChar) inQuote = false
      cur += ch
    } else if (ch === "'" || ch === '"') {
      inQuote = true; quoteChar = ch
      cur += ch
    } else if (ch === '(' || ch === '{' || ch === '[') {
      depth++; cur += ch
    } else if (ch === ')' || ch === '}' || ch === ']') {
      depth--; cur += ch
    } else if (ch === ',' && depth === 0) {
      result.push(cur.trim()); cur = ''
    } else {
      cur += ch
    }
  }
  const rem = cur.trim()
  if (rem) result.push(rem)
  return result
}

/** 解析 Cypher 列表字面量 `[1, 2, 3]` 为 JS 数组 */
function parseListLiteral(text: string): unknown[] {
  const inner = text.slice(1, -1).trim()
  if (!inner) return []
  return smartSplit(inner).map(t => {
    if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
      return t.slice(1, -1)
    }
    if (/^-?\d+$/.test(t)) return parseInt(t, 10)
    if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t)
    if (t.toUpperCase() === 'TRUE') return true
    if (t.toUpperCase() === 'FALSE') return false
    if (t.toUpperCase() === 'NULL') return null
    // 递归解析嵌套列表
    if (t.startsWith('[') && t.endsWith(']')) return parseListLiteral(t)
    return t
  })
}

/**
 * Create an empty QueryPlan with sensible defaults.
 */
function createEmptyPlan(): QueryPlan {
  return {
    type: 'QUERY',
    scanLabel: null,
    labelExpr: null,
    steps: [],
    filters: [],
    returnColumns: [],
    orderBy: [],
    limit: undefined,
    skip: undefined,
  }
}

// ═══════════════════════════════════════════════════════════════
// `parseQuery` 兼容签名 — 可直接替代 query-engine 的 parseQuery
// ═══════════════════════════════════════════════════════════════

/**
 * 与 query-engine.ts 的 parseQuery 签名完全兼容。
 * 接收 Cypher 查询字符串，返回 QueryPlan。
 * 生成的 plan 可以直接传给 _executeQuery。
 *
 * 测试替换方法：
 *   import { parseQueryAntlr } from './ast-to-plan-v2'
 *   // 替换 parseQuery 引用
 */
export function parseQueryAntlr(query: string): QueryPlan {
  return parseCypherToPlan(query)
}

// ═══════════════════════════════════════════════════════════════
// FOREACH body 解析
// ═══════════════════════════════════════════════════════════════

/**
 * 解析 FOREACH 子句的 body 部分到 operation 对象。
 * 支持: CREATE, SET, DELETE, REMOVE, 嵌套 FOREACH
 */
function parseForeachBody(body: string): any {
  body = body.trim()

  // 嵌套 FOREACH: FOREACH (... | ...) — 递归
  const nestedMatch = body.match(/^FOREACH\s*\(/i)
  if (nestedMatch) {
    // Find matching paren
    let depth = 0
    let start = nestedMatch.index! + nestedMatch[0].length - 1 // position of '('
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '(') { if (i >= start) depth++ }
      else if (body[i] === ')' && i >= start) {
        depth--
        if (depth === 0) {
          const innerBody = body.substring(start + 1, i).trim()
          // Parse inner FOREACH
          const innerParts = innerBody.match(/^(\w+)\s+IN\s+(.+?)\s*\|\s*(.+?)$/)
          if (innerParts) {
            const innerListRaw = innerParts[2].trim()
            let innerList: any[] = []
            let innerIsVarRef = false
            if (innerListRaw.startsWith('[') && innerListRaw.endsWith(']')) {
              try { innerList = JSON.parse(innerListRaw) }
              catch { try { innerList = JSON.parse(innerListRaw.replace(/'/g, '"')) } catch {} }
            } else {
              innerIsVarRef = true
              innerList = [innerListRaw]
            }
            const innerOp = parseForeachBody(innerParts[3])
            if (innerOp) {
              return {
                type: 'FOREACH',
                foreach: {
                  variable: innerParts[1],
                  list: innerList,
                  isVarRef: innerIsVarRef,
                  operation: innerOp,
                },
              }
            }
          }
          break
        }
      }
    }
    return null
  }

  // WHERE 从句提取
  let whereFilter: string | undefined
  let bodyWithoutWhere = body
  const whereMatch = body.match(/^(.+?)\s+WHERE\s+(.+?)\s+\|/i)
  if (whereMatch) {
    bodyWithoutWhere = whereMatch[1]
    whereFilter = whereMatch[2].trim()
  } else {
    // WHERE before | (in FOREACH syntax, WHERE is after list, before |)
    // FOREACH (x IN [1,2,3] WHERE x > 1 | CREATE ...)
    const whereParenMatch = body.match(/^(.*?)\s+WHERE\s+(.+?)\s*\|\s*(.+)/is)
    if (whereParenMatch) {
      bodyWithoutWhere = whereParenMatch[1].trim() + ' ' + whereParenMatch[3].trim()
      whereFilter = whereParenMatch[2].trim()
    }
  }

  // Check for MULTI: multiple operations separated by non-in-paren commas or newlines
  // For now, only single operation is supported in basic parsing

  // CREATE
  const createMatch = bodyWithoutWhere.match(/^\s*CREATE\s+(.+)/i)
  if (createMatch) {
    return { type: 'CREATE', where: whereFilter }
  }

  // SET
  const setMatch = bodyWithoutWhere.match(/^\s*SET\s+(.+)/i)
  if (setMatch) {
    const setExprs = setMatch[1].trim()
    const setParts = setExprs.split(',')
    const setClauses: Array<{ property: string; value: string }> = []
    for (const sp of setParts) {
      const [propPart, valPart] = sp.split('=').map((s: string) => s.trim())
      if (propPart && valPart !== undefined) {
        setClauses.push({ property: propPart, value: valPart.replace(/^['"]|['"]$/g, '') })
      }
    }
    return { type: 'SET', where: whereFilter, setClauses }
  }

  // DELETE
  const deleteMatch = bodyWithoutWhere.match(/^\s*DELETE\s+(.+)/i)
  if (deleteMatch) {
    const targets = deleteMatch[1].trim().split(/\s*,\s*/)
    return { type: 'DELETE', where: whereFilter, targets }
  }

  // REMOVE
  const removeMatch = bodyWithoutWhere.match(/^\s*REMOVE\s+(.+)/i)
  if (removeMatch) {
    const targets = removeMatch[1].trim().split(/\s*,\s*/)
    return { type: 'REMOVE', where: whereFilter, targets }
  }

  return { type: 'CREATE', where: whereFilter }
}