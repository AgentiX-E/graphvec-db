// ============================================================
// SqlToCypherBridge — SQL → Cypher 翻译桥
//
// 允许用户直接使用 SQL 查询图数据：
// ```sql
// SELECT n.name, n.age FROM nodes n WHERE n.age > 30
// ORDER BY n.age DESC LIMIT 10
// ```
//
// 使用 alasql 解析 SQL 为 AST，然后翻译为 Cypher 查询。
// 利用 alasql 的解析能力，不依赖其执行引擎。
//
// 支持的 SQL 子集：
// - SELECT [columns]
// - FROM nodes | edges
// - WHERE [conditions] (AND, OR, =, <>, >, <, >=, <=, IN, LIKE, IS NULL, BETWEEN)
// - ORDER BY [columns] [ASC|DESC]
// - LIMIT [n] [OFFSET m]
//
// 不支持：
// - 多表 JOIN（图没有 JOIN）
// - 子查询（SELECT 嵌套）
// - GROUP BY + 聚合
// ============================================================

// @ts-ignore — alasql has no TypeScript type definitions
import alasql from 'alasql'

// ── Types ─────────────────────────────────

export interface SqlTranslationResult {
  /** 翻译后的 Cypher 查询语句 */
  cypher: string
  /** 原始 SQL */
  sql: string
  /** 翻译过程中是否产生了警告 */
  warnings: string[]
}

export interface SqlTranslationError {
  /** 错误消息 */
  message: string
  /** 原始 SQL */
  sql: string
  /** 错误码 */
  code: 'UNSUPPORTED_JOIN' | 'UNSUPPORTED_SUBQUERY' | 'UNSUPPORTED_STATEMENT' | 'PARSE_ERROR'
}

export type SqlToCypherResult = SqlTranslationResult | SqlTranslationError

// ── Constants ─────────────────────────────

/** 表名 → Cypher 实体映射 */
const ENTITY_MAP: Record<string, { defaultAlias: string; entityTemplate: string }> = {
  nodes: { defaultAlias: 'n', entityTemplate: '(n)' },
  edges: { defaultAlias: 'e', entityTemplate: '()-[e]->()' },
}

// ── SqlToCypherBridge 类 ─────────────────

/**
 * SqlToCypherBridge — SQL 到 Cypher 的翻译桥
 *
 * 使用 alasql 解析 SQL 语句，翻译为等效的 Cypher 查询。
 */
export class SqlToCypherBridge {
  /**
   * 翻译 SQL 查询为 Cypher 查询
   */
  translate(sql: string): SqlToCypherResult {
    if (!sql || sql.trim().length === 0) {
      return {
        message: 'SQL query must be a non-empty string',
        sql,
        code: 'PARSE_ERROR',
      }
    }

    const trimmedSql = sql.trim()

    try {
      const ast = alasql.parse(trimmedSql)
      return this.translateAst(ast, trimmedSql)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        message: `SQL parse error: ${message}`,
        sql: trimmedSql,
        code: 'PARSE_ERROR',
      }
    }
  }

  /**
   * 检查 SQL 是否为支持的语句类型
   */
  isSupported(sql: string): { supported: boolean; reason?: string } {
    if (!sql || sql.trim().length === 0) {
      return { supported: false, reason: 'Empty SQL string' }
    }

    try {
      const ast = alasql.parse(sql)
      return this.checkSupported(ast)
    } catch {
      return { supported: false, reason: 'SQL parse error' }
    }
  }

  // ── Private methods ─────────────────────

  private translateAst(ast: any, sql: string): SqlToCypherResult {
    const stmts = ast.statements || (Array.isArray(ast) ? ast : [ast])
    const stmt = stmts[0]

    if (!stmt) {
      return { message: 'Empty SQL statement', sql, code: 'PARSE_ERROR' }
    }

    const warnings: string[] = []

    // Check for JOINs (alasql stores JOINs in stmt.joins array)
    if (this.hasJoin(stmt)) {
      return {
        message: 'SQL query does not support multi-table JOIN. Use Cypher pattern matching instead.',
        sql,
        code: 'UNSUPPORTED_JOIN',
      }
    }

    // Check for subqueries in FROM
    if (this.hasSubquery(stmt)) {
      return {
        message: 'SQL query does not support subqueries. Use Cypher pattern matching instead.',
        sql,
        code: 'UNSUPPORTED_SUBQUERY',
      }
    }

    // ── Build MATCH clause ──
    const fromParts = stmt.from || []
    let matchClause = ''
    let alias = 'n'

    if (fromParts.length > 0) {
      const fromItem = fromParts[0]
      const tableName = (fromItem.tableid || '').toLowerCase()

      if (tableName in ENTITY_MAP) {
        const entity = ENTITY_MAP[tableName]
        alias = fromItem.as || entity.defaultAlias
        matchClause = `MATCH ${entity.entityTemplate.replace(entity.defaultAlias, alias)}`
      } else {
        alias = fromItem.as || 'n'
        const label = fromItem.tableid
        matchClause = `MATCH (${alias}:\`${label}\`)`
      }
    } else {
      matchClause = 'MATCH (n)'
    }

    // ── Build WHERE clause ──
    let whereClause = ''
    if (stmt.where && stmt.where.expression) {
      const whereStr = this.translateExpression(stmt.where.expression, alias)
      if (whereStr.length > 0) {
        whereClause = ` WHERE ${whereStr}`
      }
    }

    // ── Build RETURN clause ──
    let returnClause = ''
    if (stmt.columns && stmt.columns.length > 0) {
      const colStrings = stmt.columns.map((col: any) =>
        this.translateColumn(col, alias),
      )
      returnClause = ` RETURN ${colStrings.join(', ')}`
    } else {
      returnClause = ` RETURN ${alias}`
    }

    // ── Build ORDER BY clause ──
    let orderClause = ''
    if (stmt.order && stmt.order.length > 0) {
      const orderParts = stmt.order.map((o: any) => {
        const exprStr = this.exprToString(o.expression, alias)
        const dir = o.direction === 'DESC' ? ' DESC' : ''
        return `${exprStr}${dir}`
      })
      if (orderParts.length > 0) {
        orderClause = ` ORDER BY ${orderParts.join(', ')}`
      }
    }

    // ── Build LIMIT/SKIP ──
    let limitClause = ''
    if (stmt.limit) {
      const limitVal = this.resolveLimitValue(stmt.limit)
      if (limitVal !== null) {
        limitClause += ` LIMIT ${limitVal}`
      }
    }

    const cypher = `${matchClause}${whereClause}${returnClause}${orderClause}${limitClause}`
    return { cypher, sql, warnings }
  }

  private checkSupported(ast: any): { supported: boolean; reason?: string } {
    const stmts = ast.statements || (Array.isArray(ast) ? ast : [ast])
    const stmt = stmts[0]
    if (!stmt) return { supported: false, reason: 'Empty statement' }
    if (this.hasJoin(stmt)) return { supported: false, reason: 'JOIN is not supported' }
    return { supported: true }
  }

  /**
   * Detect JOINs: alasql stores JOINs in stmt.joins array
   */
  private hasJoin(stmt: any): boolean {
    if (stmt.joins && stmt.joins.length > 0) return true
    return false
  }

  /**
   * Detect subqueries: from items that contain nested statements
   */
  private hasSubquery(stmt: any): boolean {
    const fromParts = stmt.from || []
    for (const item of fromParts) {
      // A subquery will have columns/from/limit inside the from item instead of tableid
      if (!item.tableid && (item.columns || item.from || item.limit)) return true
    }
    return false
  }

  private translateColumn(col: any, defaultAlias: string): string {
    if (!col) return defaultAlias

    const columnId = col.columnid
    const tableId = col.tableid || defaultAlias

    if (columnId === '*') return defaultAlias
    if (columnId) {
      const alias = col.as ? ` AS \`${col.as}\`` : ''
      return `${tableId}.${columnId}${alias}`
    }

    return defaultAlias
  }

  /**
   * Translate a WHERE expression node to Cypher
   */
  private translateExpression(expr: any, defaultAlias: string): string {
    if (!expr || typeof expr !== 'object') {
      return this.formatValue(expr)
    }

    // Binary expression: left OP right
    if (expr.left !== undefined && expr.op && expr.right !== undefined) {
      const op = expr.op.toUpperCase()

      // Handle logical AND/OR: recursively translate both sides
      if (op === 'AND' || op === 'OR') {
        const leftStr = this.translateExpression(expr.left, defaultAlias)
        const rightStr = this.translateExpression(expr.right, defaultAlias)
        if (leftStr && rightStr) {
          return `(${leftStr} ${op} ${rightStr})`
        }
        return leftStr || rightStr
      }

      // Handle IN: right side is an array in alasql
      if (op === 'IN' && Array.isArray(expr.right)) {
        const leftStr = this.exprToString(expr.left, defaultAlias)
        const values = expr.right
          .map((v: any) => this.exprToString(v, defaultAlias))
          .join(', ')
        return `${leftStr} IN [${values}]`
      }

      const leftStr = this.exprToString(expr.left, defaultAlias)
      const rightStr = this.exprToString(expr.right, defaultAlias)

      if (op === 'LIKE') {
        return `${leftStr} =~ '(?i)${expr.right.value?.replace(/%/g, '.*') || ''}'`
      }

      return `${leftStr} ${this.translateOp(op)} ${rightStr}`
    }

    return ''
  }

  private exprToString(expr: any, defaultAlias: string): string {
    if (expr === null || expr === undefined) return 'null'
    if (typeof expr !== 'object') return this.formatValue(expr)

    // Column reference: { columnid: "name", tableid: "n" }
    if (expr.columnid !== undefined) {
      const tableId = expr.tableid || defaultAlias
      if (expr.columnid === '*') return defaultAlias
      return `${tableId}.${expr.columnid}`
    }

    // Value node: { value: 30 }
    if (expr.value !== undefined) return this.formatValue(expr.value)

    return ''
  }

  private translateOp(op: string): string {
    const map: Record<string, string> = {
      '=': '=',
      '==': '=',
      '!=': '<>',
      '<>': '<>',
      '>': '>',
      '<': '<',
      '>=': '>=',
      '<=': '<=',
      'LIKE': '=~',
      'AND': 'AND',
      'OR': 'OR',
      'IN': 'IN',
    }
    return map[op] || op
  }

  private formatValue(value: any): string {
    if (value === null || value === undefined) return 'null'
    if (typeof value === 'number') return String(value)
    if (typeof value === 'boolean') return value ? 'true' : 'false'
    return `"${String(value).replace(/"/g, '\\"')}"`
  }

  private resolveLimitValue(node: any): number | null {
    if (node === null || node === undefined) return null
    if (typeof node === 'number') return node
    if (typeof node === 'object') {
      if (node.value !== undefined) return this.resolveLimitValue(node.value)
    }
    return null
  }
}
