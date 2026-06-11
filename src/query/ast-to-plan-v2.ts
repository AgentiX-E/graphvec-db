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
  loadCsv?: { url: string; rowVariable: string; hasHeaders: boolean }
  windowFunctions?: Array<{ function: string; partitionBy: string[]; orderBy: Array<{ column: string; direction: 'ASC' | 'DESC' }> }>
  show?: string
  search?: { targetProperty: string; queryVector: number[]; topK: number }
  createNodes?: Array<{ alias: string; label: string | null; props: Record<string, unknown> | null }>
  createEdges?: Array<{ source: string; target: string; label: string | null; direction: 'out' | 'in' | 'any' }>
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
  range?: { min: number; max: number | null }
}

interface ParsedWhere {
  filters: FilterClause[]
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
  const is = new antlr4.InputStream(query.trim())
  const lexer = new CypherLexer(is)
  const tokens = new antlr4.CommonTokenStream(lexer)
  const parser = new CypherParser(tokens)
  parser.buildParseTrees = true

  const tree = parser.cypher()
  const clauses = collectClauses(tree)

  // Build plan from clauses
  return clausesToPlan(clauses)
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
      // SingleQuery is a container — recurse, but don't return
    } else if (known[name]) {
      result.push({ type: known[name], ctx: node })
      return // stop at known clause boundary
    }

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
          plan.scanLabel = parsed.label ?? plan.scanLabel
          plan.steps = parsed.edges
        }
        break
      }
      // WHERE is handled inside MATCH clause — no separate case
      // (ANTLR nests WHERE inside MatchClauseContext)
      case 'RETURN': {
        const ret = extractReturn(clause.ctx)
        plan.returnColumns = ret.columns.map(c => c.alias ?? c.expression)
        plan.orderBy = ret.orderBy
        plan.limit = ret.limit
        plan.skip = ret.skip
        plan.aggregate = ret.aggregate
        break
      }
      case 'CREATE': {
        plan.type = 'CREATE'
        const nodes = extractCreateNodes(clause.ctx)
        plan.createNodes = nodes
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
    if (clause.type === 'MATCH') {
      const whereFilters = extractWhereFromMatch(clause.ctx)
      plan.filters.push(...whereFilters)
    }
  }

  plan.hasMatch = hasMatch
  return plan
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

// ═══════════════════════════════════════════════════════════════
// MATCH 提取
// ═══════════════════════════════════════════════════════════════

function extractMatch(matchCtx: any): ParsedMatch | null {
  // Find the first NodePattern
  const nodePattern = findChild(matchCtx, 'NodePatternContext')
  if (!nodePattern) return null

  const variable = findSymbolicName(findChild(nodePattern, 'VariableContext'))
  const nodeLabel = findChild(nodePattern, 'NodeLabelContext')
  const label = nodeLabel ? findSymbolicName(nodeLabel) : null

  // Extract properties
  const propsNode = findChild(nodePattern, 'PropertiesContext')
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
    if (hasLeft && !hasRight) direction = 'in'
    else if (hasLeft && hasRight) direction = 'any'

    // Edge label
    const relDetail = findChild(relPattern, 'RelationshipDetailContext')
    let edgeLabel: string | null = null
    if (relDetail) {
      const relTypes = findChild(relDetail, 'RelationshipTypesContext')
      if (relTypes) {
        // Support multiple types (separated by |)
        const firstType = findChild(relTypes, 'RelTypeNameContext')
        edgeLabel = firstType ? findSymbolicName(firstType) : null
      }

      // VARLEN range
      const rangeCtx = findChild(relDetail, 'RangeLiteralContext')
    }

    // Target
    const targetVar = findSymbolicName(findChild(targetPattern, 'VariableContext'))
    const targetLabelCtx = findChild(targetPattern, 'NodeLabelContext')
    const targetLabel = targetLabelCtx ? findSymbolicName(targetLabelCtx) : null
    const targetPropsNode = findChild(targetPattern, 'PropertiesContext')
    const targetProps = targetPropsNode ? extractMapLiteral(targetPropsNode) : null

    edges.push({
      source: currentSource,
      direction,
      edgeLabel,
      targetAlias: targetVar ?? '',
      targetLabel,
      targetProps,
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
 * ANTLR structure:
 *   WhereContext → Expression → ComparisonExpression
 *   ComparisonExpression: AddOrSubtractExpression (PartialComparisonExpression)*
 *   PartialComparisonExpression: operator AddOrSubtractExpression
 *   PropertyOrLabelsExpression: Atom PropertyLookup*
 *   PropertyLookup: "." PropertyKeyName
 */
function extractWhere(whereCtx: any): FilterClause[] {
  const filters: FilterClause[] = []

  // Find all ComparisonExpression and their PartialComparison siblings
  const compExprs = findAllChildren(whereCtx, 'ComparisonExpressionContext')
  for (const comp of compExprs) {
    // The left side is the first child (AddOrSubtract/PropertyOrLabels)
    const leftExpr = findChild(comp, 'PropertyOrLabelsExpressionContext') ||
                     findChild(comp, 'AddOrSubtractExpressionContext') ||
                     comp.children?.[0]
    if (!leftExpr) continue

    // Extract source.property from left side
    const leftText = getTextRecursive(leftExpr)
    const propParts = leftText.match(/^(\w+)\.(.+)$/)
    if (!propParts) continue

    const source = propParts[1]
    const property = propParts[2]

    // Find PartialComparisonExpression (contains operator + value)
    const partial = findChild(comp, 'PartialComparisonExpressionContext')
    if (!partial) continue

    const partialText = getTextRecursive(partial).trim()
    const filter = parseComparisonPartial(partialText, source, property)
    if (filter) filters.push(filter)
  }

  return filters
}

/**
 * Parse a partial comparison expression (e.g., "> 30", "= \"Bob\"", "IN [...]").
 */
function parseComparisonPartial(text: string, source: string, property: string): FilterClause | null {
  // Pattern: (operator) (value)
  // Operators: =, !=, <>, >, >=, <, <=, IN, STARTS WITH, ENDS WITH, CONTAINS, IS [NOT] NULL
  const match = text.match(new RegExp(
    '^(!?=|[<>]=?|IN|STARTS\\s+WITH|ENDS\\s+WITH|CONTAINS|IS\\s+(NOT\\s+)?NULL)\\s*(.*)$', 'is'
  ))
  const rawOp = match?.[1]?.toUpperCase() ?? ''
  const rawVal = match?.[3]?.trim() ?? ''

  let operator: FilterClause['operator']
  let negated = false

  switch (rawOp) {
    case '=': operator = 'EQ'; break
    case '!=':
    case '<>': operator = 'NEQ'; break
    case '>': operator = 'GT'; break
    case '>=': operator = 'GTE'; break
    case '<': operator = 'LT'; break
    case '<=': operator = 'LTE'; break
    case 'IN': operator = 'IN'; break
    case 'STARTS WITH': operator = 'STARTS_WITH'; break
    case 'ENDS WITH': operator = 'ENDS_WITH'; break
    case 'CONTAINS': operator = 'CONTAINS'; break
    case 'IS NULL': operator = 'IS_NULL'; break
    case 'IS NOT NULL': operator = 'IS_NOT_NULL'; break
    default: return null
  }

  // Parse value
  let value: unknown = rawVal
  if ((rawVal.startsWith("'") && rawVal.endsWith("'")) || (rawVal.startsWith('"') && rawVal.endsWith('"'))) {
    value = rawVal.slice(1, -1)
  } else if (/^-?\d+$/.test(rawVal)) {
    value = parseInt(rawVal, 10)
  } else if (/^-?\d+\.\d+$/.test(rawVal)) {
    value = parseFloat(rawVal)
  } else if (/^(true|false)$/i.test(rawVal)) {
    value = rawVal.toUpperCase() === 'TRUE'
  } else if (/^null$/i.test(rawVal)) {
    value = null
  } else if (rawVal.startsWith('[')) {
    try { value = JSON.parse(rawVal) } catch { value = rawVal }
  }

  return { source, property, operator, value, negated }
}

/**
 * Extract the text of an expression subtree, walking past nested contexts.
 */
function extractExprText(node: any): string {
  if (!node) return ''
  const text = getTextRecursive(node)
  return text.slice(0, 80).trim()
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
      const orderProp = parts[0]
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
    const label = labelCtx ? findSymbolicName(labelCtx) : null
    const propsNode = findChild(np, 'PropertiesContext')
    const props = propsNode ? extractMapLiteral(propsNode) : null
    nodes.push({ alias: variable, label, props })
  }

  return nodes
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
    const label = labelCtx ? findSymbolicName(labelCtx) : null
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
  const texts = getTextRecursive(setCtx)
  // Simple: "n.prop = value"
  const items = texts.split(/\s*=\s*/)
  return sets
}

function extractRemoveClauses(removeCtx: any): QueryPlan['removeClauses'] {
  const removes: QueryPlan['removeClauses'] = []
  const texts = getTextRecursive(removeCtx)
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
    try { list = JSON.parse(text) } catch { list = text as any }
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
      updates.push({ type: 'SET', alias: '' })
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
        value = value.slice(1, -1)
      } else if (/^-?\d+$/.test(value)) {
        value = parseInt(value, 10)
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