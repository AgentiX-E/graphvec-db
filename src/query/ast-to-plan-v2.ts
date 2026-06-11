// ============================================================
// ast-to-plan-v2.ts — ANTLR Cypher AST → QueryPlan 转换器
//
// 使用 @neo4j-cypher/antlr4 解析 Cypher 查询，
// 将 ANTLR 的 AST 转换为现有的 QueryPlan 结构。
// ============================================================

import { parser } from './cypher-lite-parser'
// 不再使用 PEG parser
// 导入 ANTLR parser
import { default as antlr4 } from 'antlr4'
import { CypherLexer, CypherParser, CypherListener } from '@neo4j-cypher/antlr4'

// ── 导出 Plan 类型 ──
export type PlanType = 'QUERY' | 'CREATE' | 'MERGE' | 'FOREACH' | 'EXISTS_SUBQUERY'
  | 'CALL' | 'CALL_PROCEDURE' | 'TRANSACTION_CONJUNCT'
  | 'BEGIN' | 'COMMIT' | 'ROLLBACK'
  | 'SHOW' | 'DROP_CONSTRAINT' | 'CREATE_INDEX' | 'DROP_INDEX'
  | 'USE' | 'EXPLAIN'

export interface TraverseStep {
  source: string
  direction: 'out' | 'in'
  edgeLabel: string | null
  targetAlias: string
  targetLabel: string | null
  targetProps: Record<string, unknown> | null
  range?: { min: number; max?: number }
}

export interface QueryPlan {
  type: PlanType
  scanLabel: string | null
  labelExpr: string | null
  steps: TraverseStep[]
  filters: any[]
  returnColumns: string[]
  orderBy: any[]
  explain?: boolean
  profile?: boolean
  // ... keeping minimal for now
  [key: string]: any
}

// ── Helper: 访问 ANTLR 上下文的子节点 ──

/**
 * 从 ANTLR AST 中提取 Cypher 查询中的关键元素。
 * 使用递归遍历而非 Listener，因为我们需要从根向上构建结构。
 */

interface ParsedQuery {
  type: 'MATCH_QUERY' | 'CREATE_QUERY' | 'RETURN_ONLY'
  match: {
    nodeLabel: string | null
    edges: Array<{
      label: string | null
      direction: 'out' | 'in'
    }>
  } | null
  where: any[]  // 暂时留空
  return: {
    columns: string[]
    orderBy: any[]
    limit: number | null
    skip: number | null
  } | null
  clauses: string[]  // UNWIND, FOREACH, DELETE, etc.
}

/**
 * Parse a Cypher query string using ANTLR and extract query plan fields.
 */
export function parseCypher(query: string): ParsedQuery {
  const is = new antlr4.InputStream(query.trim())
  const lexer = new CypherLexer(is)
  const tokens = new antlr4.CommonTokenStream(lexer)
  const parser = new CypherParser(tokens)
  parser.buildParseTrees = true
  
  const tree = parser.cypher()
  return extractQueryInfo(tree)
}

/**
 * Walk the ANTLR parse tree and extract query information.
 */
function extractQueryInfo(ctx: any): ParsedQuery {
  const result: ParsedQuery = {
    type: 'RETURN_ONLY',
    match: null,
    where: [],
    return: null,
    clauses: [],
  }

  const clauses = findClauses(ctx)
  
  // Extract MATCH
  for (const clause of clauses) {
    if (clause.type === 'MATCH') {
      result.type = 'MATCH_QUERY'
      result.match = extractMatchPattern(clause.ctx)
    } else if (clause.type === 'CREATE') {
      result.type = 'CREATE_QUERY'
      result.clauses.push('CREATE')
    } else if (clause.type === 'RETURN') {
      result.return = extractReturn(clause.ctx)
    } else if (clause.type === 'WHERE') {
      // WHERE is contained within MATCH clause in ANTLR
    } else {
      result.clauses.push(clause.type)
    }
  }

  return result
}

/**
 * Walk tree to find top-level clause contexts (MATCH, RETURN, etc.)
 */
function findClauses(ctx: any): Array<{ type: string; ctx: any }> {
  const found: Array<{ type: string; ctx: any }> = []
  
  function walk(node: any) {
    if (!node || !node.children) return
    
    const name = node.constructor?.name ?? ''
    
    if (name === 'MatchClauseContext') {
      found.push({ type: 'MATCH', ctx: node })
      return  // don't recurse deeper into match
    }
    if (name === 'ReturnClauseContext') {
      found.push({ type: 'RETURN', ctx: node })
      return
    }
    if (name === 'CreateClauseContext') {
      found.push({ type: 'CREATE', ctx: node })
      return
    }
    if (name === 'MergeClauseContext') {
      found.push({ type: 'MERGE', ctx: node })
      return
    }
    if (name === 'DeleteClauseContext') {
      found.push({ type: 'DELETE', ctx: node })
      return
    }
    if (name === 'SetClauseContext') {
      found.push({ type: 'SET', ctx: node })
      return
    }
    if (name === 'RemoveClauseContext') {
      found.push({ type: 'REMOVE', ctx: node })
      return
    }
    if (name === 'UnwindClauseContext') {
      found.push({ type: 'UNWIND', ctx: node })
      return
    }
    if (name === 'ForeachClauseContext') {
      found.push({ type: 'FOREACH', ctx: node })
      return
    }
    if (name === 'CallContext') {
      found.push({ type: 'CALL', ctx: node })
      return
    }
    
    for (const child of node.children) {
      walk(child)
    }
  }
  
  walk(ctx)
  return found
}

/**
 * Extract MATCH pattern: node labels and edge patterns.
 */
function extractMatchPattern(matchCtx: any) {
  let nodeLabel: string | null = null
  const edges: Array<{ label: string | null; direction: 'out' | 'in' }> = []

  function walk(node: any) {
    if (!node || !node.children) return
    
    const name = node.constructor?.name ?? ''
    
    if (name === 'NodeLabelContext') {
      const sym = findFirst(node, 'SymbolicNameContext')
      if (sym) nodeLabel = sym.getText()
    }
    if (name === 'RelationshipPatternContext') {
      const relDetail = findFirst(node, 'RelationshipDetailContext')
      let label: string | null = null
      if (relDetail) {
        const relType = findFirst(relDetail, 'RelTypeNameContext')
        if (relType) {
          const sym = findFirst(relType, 'SymbolicNameContext')
          if (sym) label = sym.getText()
        }
      }
      const hasLeft = findFirst(node, 'LeftArrowHeadContext')
      const hasRight = findFirst(node, 'RightArrowHeadContext')
      let direction: 'out' | 'in' = 'out'
      if (hasLeft && !hasRight) direction = 'in'
      else if (hasLeft && hasRight) direction = 'out'  // bidirectional treated as out
      
      edges.push({ label, direction })
    }
    
    for (const child of node.children) {
      walk(child)
    }
  }
  
  walk(matchCtx)
  return { nodeLabel, edges }
}

/**
 * Extract RETURN clause: columns, ORDER BY, LIMIT, SKIP.
 */
function extractReturn(returnCtx: any) {
  const columns: string[] = []
  let orderBy: any[] = []
  let limit: number | null = null
  let skip: number | null = null

  function walk(node: any) {
    if (!node || !node.children) return
    const name = node.constructor?.name ?? ''
    
    if (name === 'ReturnItemContext') {
      const text = node.getText()
      // Check for alias: "expr AS alias"
      const asMatch = text.match(/^(.+?)\s+AS\s+(\w+)$/i)
      if (asMatch) {
        columns.push(asMatch[2])
      } else {
        columns.push(text)
      }
      return  // don't recurse into expression tree
    }
    if (name === 'SortItemContext') {
      orderBy.push(node.getText())
      return
    }
    if (name === 'LimitContext') {
      const num = findFirst(node, 'IntegerLiteralContext')
      if (num) limit = parseInt(num.getText(), 10)
      return
    }

    for (const child of node.children) {
      walk(child)
    }
  }
  
  walk(returnCtx)
  return { columns, orderBy, limit, skip }
}

/**
 * Find first child of a specific type in the subtree.
 */
function findFirst(node: any, className: string): any | null {
  if (!node || !node.children) return null
  const name = node.constructor?.name ?? ''
  if (name === className) return node
  
  for (const child of node.children) {
    const found = findFirst(child, className)
    if (found) return found
  }
  return null
}

// ═══════════════════════════════════════════════════════════════
// 转换: ParsedQuery → QueryPlan
// ═══════════════════════════════════════════════════════════════

export function parsedQueryToPlan(pq: ParsedQuery): QueryPlan {
  const plan: QueryPlan = {
    type: 'QUERY',
    scanLabel: pq.match?.nodeLabel ?? null,
    labelExpr: null,
    steps: (pq.match?.edges ?? []).map(e => ({
      source: '',
      direction: e.direction,
      edgeLabel: e.label,
      targetAlias: '',
      targetLabel: null,
      targetProps: null,
    })),
    filters: pq.where,
    returnColumns: pq.return?.columns ?? [],
    orderBy: (pq.return?.orderBy ?? []).map((o: string) => ({
      property: o,
      direction: 'ASC' as const,
    })),
  }

  // 去掉 SELECT * 占位符
  if (plan.returnColumns.length === 1 && plan.returnColumns[0] === '*') {
    plan.returnColumns = []
  }

  return plan
}
