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
  setClauses?: Array<{ property: string; value: unknown }>
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
}

export interface FilterClause {
  source: string
  property: string
  operator: 'EQ' | 'NEQ' | 'GT' | 'GTE' | 'LT' | 'LTE' | 'IN' | 'STARTS_WITH' | 'ENDS_WITH' | 'CONTAINS' | 'IS_NULL' | 'IS_NOT_NULL'
  value: unknown
  negated?: boolean
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
}

interface ParsedReturn {
  columns: Array<{ expression: string; alias: string | null }>
  orderBy: Array<{ property: string; direction: 'ASC' | 'DESC' }>
  limit: number | undefined
  skip: number | undefined
  aggregate: AggregateClause | undefined
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
  return plan
}

/**
 * Parse Cypher string into intermediate representation, then convert to QueryPlan.
 */
function buildQueryPlan(query: string): QueryPlan {
  const trimmed = query.trim()
  const upperQ = trimmed.toUpperCase()

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
  ;(process.stderr as any).write = () => true
  let tree: any
  try {
    tree = parser.cypher()
  } finally {
    ;(process.stderr as any).write = origStderrWrite
  }
  const clauses = collectClauses(tree)

  // Build plan from clauses
  const plan = clausesToPlan(clauses)

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
      // Check for UNION
      const text = node.getText().toUpperCase()
      if (text.includes(' UNION ')) {
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
        const parsed = extractMatch(clause.ctx)
        if (parsed) {
          // 如果是第一个 MATCH，设置 scanLabel 和 steps
          // 如果是后续 MATCH（逗号分隔），作为额外 scan + steps
          if (!plan.scanLabel && plan.steps.length === 0) {
            plan.scanLabel = parsed.label ?? plan.scanLabel
            plan.steps = parsed.edges
          } else {
            // 第二个/更多 MATCH 暂存到 additionalMatches
            const existingSteps = plan.steps
            plan.steps = existingSteps.concat(parsed.edges)
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
          })
        }
        break
      }
      // WHERE is handled inside MATCH clause — no separate case
      // (ANTLR nests WHERE inside MatchClauseContext)
      case 'RETURN': {
        const ret = extractReturn(clause.ctx)
        // 填充 returnAliasMap：returnColumn → 原始表达式（用于 DML 结果构造 & 表达式求值）
        plan.returnAliasMap = {}
        // 填充 expressionColumns：结构化列信息（用于表达式求值引擎）
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
          
          const agg: any = {
            function: ret.aggregate.function,
            column: ret.aggregate.column,
            type: ret.aggregate.function,
          }
          if (alias) agg.alias = alias
          plan.aggregate = agg
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
          plan.createEdges = plan.createEdges?.length ? [...plan.createEdges, ...edges] : edges
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
        plan.unwind = u
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
        const f = extractForEach(clause.ctx)
        plan.forEach = f
        break
      }
      case 'WITH': {
        plan.with = extractWith(clause.ctx)
        break
      }
    }
  }

  // Incorporate WHERE into filters if present
  // WHERE is a sub-clause of MATCH in ANTLR, so collect from MatchClause
  for (const clause of clauses) {
    if (clause.type === 'MATCH' || clause.type === 'OPTIONAL_MATCH') {
      const whereFilters = extractWhereFromMatch(clause.ctx)
      if (clause.type === 'MATCH') {
        plan.filters.push(...whereFilters)
      } else if (clause.type === 'OPTIONAL_MATCH' && plan.optionalMatchSteps) {
        const lastOptional = plan.optionalMatchSteps[plan.optionalMatchSteps.length - 1]
        lastOptional.filters.push(...whereFilters)
      }
    }
  }

  plan.hasMatch = hasMatch

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

  // Recurse on both sides
  plan.rightPlan = buildQueryPlan(rightQuery)

  // Copy left plan fields into current plan
  const leftPlan = buildQueryPlan(leftQuery)
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

  // Extract edge steps (PatternElementChain)
  const chains = findAllChildren(matchCtx, 'PatternElementChainContext')
  const edges: ParsedEdgeStep[] = []

  let currentSource = variable ?? ''
  for (const chain of chains) {
    const relPattern = findChild(chain, 'RelationshipPatternContext')
    const targetPattern = findChild(chain, 'NodePatternContext')

    if (!relPattern || !targetPattern) continue

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
    else if (!hasLeft && !hasRight) direction = 'any'  // 无箭头 = 无向

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
      if (findChild(relDetail, 'RangeLiteralContext')) {
        const rctx = findChild(relDetail, 'RangeLiteralContext')
        const rangeText = rctx!.getText ? rctx!.getText() : ''
        const cleanRange = rangeText.startsWith('*') ? rangeText.slice(1) : rangeText
        const parts = cleanRange.split('..')
        if (parts.length === 2) {
          rangeInfo = { min: parseInt(parts[0], 10), max: parseInt(parts[1], 10) }
        } else {
          const val = parseInt(parts[0], 10)
          rangeInfo = { min: val, max: val }
        }
      }

      // ── 关系属性提取（edgeProps） ──
      // MATCH ()-[r:KNOWS {name: 'monkey'}]->() — 提取 {name: 'monkey'}
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

    edges.push({
      source: currentSource,
      direction,
      edgeLabel,
      edgeProps,
      targetAlias: targetVar ?? '',
      targetLabel,
      targetProps,
      ...(rangeInfo ? { range: rangeInfo } : {}),
    })

    currentSource = targetVar ?? ''
  }

  return {
    variable,
    label,
    edges,
    properties,
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

  function walk(node: any) {
    if (!node || !node.children) return
    const name = node.constructor?.name ?? ''

    if (name === 'ReturnItemContext') {
      const text = getTextRecursive(node)
      const asMatch = text.match(/^(.+?)\s+AS\s+(\w+)$/i)
      if (asMatch) {
        columns.push({ expression: asMatch[1].trim(), alias: asMatch[2] })
      } else {
        columns.push({ expression: text, alias: null })
      }

      // Check for aggregation
      if (!aggregate && /\b(count|sum|avg|max|min|collect)\s*\(/i.test(text)) {
        const fnMatch = text.match(/^\s*(count|sum|avg|max|min|collect)\s*\(/i)
        if (fnMatch) {
          aggregate = { function: fnMatch[1].toLowerCase(), column: text, distinct: false }
        }
      }
      return
    }

    if (name === 'SortItemContext') {
      const sortText = getTextRecursive(node)
      const parts = sortText.split(/\s+/)
      const orderProp = parts[0].replace(/^\w+\./, '')
      const orderDir = parts[1]?.toUpperCase() === 'DESC' ? 'DESC' as const : 'ASC' as const
      orderBy.push({ property: orderProp, direction: orderDir })
      return
    }

    if (name === 'LimitContext') {
      const intLit = findChild(node, 'IntegerLiteralContext')
      if (intLit) limit = parseInt(getTextRecursive(intLit), 10)
      return
    }

    for (const child of node.children) walk(child)
  }

  walk(returnCtx)
  return { columns, orderBy, limit, skip, aggregate }
}

// ═══════════════════════════════════════════════════════════════
// CREATE 提取
// ═══════════════════════════════════════════════════════════════

function extractCreateNodes(createCtx: any): Array<{ alias: string; label: string | null; props: Record<string, unknown> | null }> {
  const nodes: Array<{ alias: string; label: string | null; props: Record<string, unknown> | null }> = []
  const nodePatterns = findAllChildren(createCtx, 'NodePatternContext')

  for (const np of nodePatterns) {
    const variable = findSymbolicName(findChild(np, 'VariableContext')) ?? ''
    const labelCtx = findChild(np, 'NodeLabelContext')
    const label = labelCtx ? extractLabel(labelCtx) : null
    const propsNode = findChild(np, 'PropertiesContext')
    const props = propsNode ? extractMapLiteral(propsNode) : null
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
  // Track global index of NodePatternContext across all PatternElements within this CREATE
  let nodeIdx = 0

  const patternElements = findAllChildren(createCtx, 'PatternElementContext')
  for (const pe of patternElements) {
    const peNodes = findAllChildren(pe, 'NodePatternContext')
    if (peNodes.length < 2) { nodeIdx += peNodes.length; continue }

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
      const baseSrcIdx = nodeIdx + ci
      const baseTgtIdx = sourceAlias && sourceAlias === targetAlias ? nodeIdx + ci : nodeIdx + ci + 1
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
    nodeIdx += peNodes.length
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

function extractSetClauses(setCtx: any): QueryPlan['setClauses'] {
  const sets: QueryPlan['setClauses'] = []
  const text = getTextRecursive(setCtx)
  // Remove "SET " prefix
  const setText = text.replace(/^SET\s+/i, '')
  // Split by comma at top level
  const items = splitByTopLevelComma(setText)
  for (const item of items) {
    const eqMatch = item.match(/^(\w+)\.(\w+)\s*=\s*(.+)$/)
    if (eqMatch) {
      let val: unknown = eqMatch[3].trim()
      // Try to parse literal values
      if ((val as string).startsWith("'") || (val as string).startsWith('"')) {
        val = (val as string).slice(1, -1)
      } else if (val === 'true') val = true
      else if (val === 'false') val = false
      else if (/^-?\d+$/.test(val as string)) val = parseInt(val as string, 10)
      else if (/^-?\d+\.\d+$/.test(val as string)) val = parseFloat(val as string)
      sets.push({ property: eqMatch[2], value: val })
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
    // Detect label removal: n:Label
    const labelMatch = trimItem.match(/^(\w+):(\w+)$/)
    if (labelMatch) {
      removes.push({ type: 'REMOVE_LABEL', ref: labelMatch[1], label: labelMatch[2] })
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
  const varCtx = findChild(unwindCtx, 'VariableContext')
  const name = varCtx ? getTextRecursive(varCtx) : ''

  // List expression
  const expr = findChild(unwindCtx, 'ExpressionContext')
  const text = expr ? getTextRecursive(expr) : ''
  let list: any[] = []
  let varRef: string | undefined

  if (text.startsWith('[') && text.endsWith(']')) {
    // Literal list
    try {
      list = JSON.parse(text)
    } catch {
      list = text as any
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
    try { list = JSON.parse(text) } catch { try { list = JSON.parse(text.replace(/'/g, '"')) } catch { list = text as any } }
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
  let aggregate: AggregateClause | undefined

  function walk(node: any) {
    if (!node || !node.children) return
    const name = node.constructor?.name ?? ''

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
    if (name === 'SortItemContext') {
      const sortText = getTextRecursive(node)
      const parts = sortText.split(/\s+/)
      orderBy.push({ property: parts[0], direction: parts[1]?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC' })
      return
    }
    if (name === 'LimitContext') {
      const intLit = findChild(node, 'IntegerLiteralContext')
      if (intLit) limit = parseInt(getTextRecursive(intLit), 10)
      return
    }

    for (const child of node.children) walk(child)
  }

  walk(withCtx)
  return { columns, filters, orderBy, limit, skip: undefined, aggregate }
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

  const entries = findAllChildren(propsCtx, 'LiteralEntryContext')
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
        // 大整数保持字符串精度（超过 JS Number.MAX_SAFE_INTEGER）
        const bigVal = BigInt(value)
        if (bigVal > BigInt(Number.MAX_SAFE_INTEGER) || bigVal < BigInt(Number.MIN_SAFE_INTEGER)) {
          value = value  // 保持字符串以保留精度
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

/** 解析 Cypher 列表字面量 `[1, 2, 3]` 为 JS 数组 */
function parseListLiteral(text: string): unknown[] {
  const inner = text.slice(1, -1).trim()
  if (!inner) return []
  return inner.split(',').map(s => {
    const t = s.trim()
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