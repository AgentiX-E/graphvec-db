/**
 * executor-validate-plan.ts — _validatePlan
 *
 * 从 query-executor.ts 拆分。
 */

import type { QueryPlan } from './query-types'
import { _validateUndefinedVariables, _validateUnknownFunctions, _validateOrderByScope, _validatePatternPosition, _validateWhereSelfPattern, _validateExistsSubqueryClauses, _validateSetOperands, _validateUnionComposition, extractVariablesFromClause, extractMatchVariables } from './executor-validators'
import { globalRegistry as _procedureRegistry } from './procedure-registry'
import { _validateLiterals, _splitTopLevel } from './expression-engine'

export function _validatePlan(plan: QueryPlan, query?: string): void {
  if (!plan || !plan.type) return
  if (!query) return

  // 从 WHERE 子句检测未绑定变量
  const qUpper = query.toUpperCase()

  // ── SyntaxError: UndefinedVariable ──
  // Strip WHERE clauses inside list predicates/comprehensions before validation
  // to avoid false positives on IN-bound variables (e.g., [x IN list WHERE x <> null])
  // Keep original query for other validators
  const queryForVarCheck = _stripListPredicates(query)
  _validateUndefinedVariables(queryForVarCheck, plan)

  // ── SyntaxError: UndefinedVariable (ORDER BY scope) ──
  // A WITH clause resets the variable scope, so ORDER BY may only reference
  // variables still in scope (or projection aliases of its own WITH).
  _validateOrderByScope(query)

  // ── SyntaxError: UndefinedVariable (SET operand) ──
  // `SET a.name = missing` references an unbound variable on the RHS.
  _validateSetOperands(query, plan)

  // ── SyntaxError: DifferentColumnsInUnion / InvalidClauseComposition ──
  // A set operator (UNION/UNION ALL/INTERSECT/SUBTRACT) requires identical
  // column names on both sides and a uniform operator (all plain UNION or all
  // UNION ALL — mixing the two is forbidden).
  _validateUnionComposition(plan, query)

  // ── SyntaxError: UnexpectedSyntax ──
  // A bare pattern (e.g. `(n)-[]->()`) is not a value expression and may only
  // appear in MATCH/CREATE/MERGE/WHERE, never as a RETURN/WITH/SET operand.
  _validatePatternPosition(query)

  // ── SyntaxError: InvalidArgumentType ──
  // A pattern predicate must contain a relationship; a bare node pattern such
  // as `WHERE (n)` is invalid.
  _validateWhereSelfPattern(query)

  // ── SyntaxError: InvalidClauseComposition ──
  // An existential subquery `EXISTS { ... }` may only contain read clauses
  // (MATCH/WHERE/WITH/UNWIND). An update clause (SET/DELETE/MERGE/CREATE/REMOVE)
  // inside it is a compile-time error.
  _validateExistsSubqueryClauses(query)

  // ═══════════════════════════════════════════════════════════════
  // Literals SyntaxError (编译时字面量检查)
  // ═══════════════════════════════════════════════════════════════
  _validateLiterals(query)

  // ── SyntaxError: InvalidDelete ──
  // Deleting a label/type expression (e.g. `DELETE n:Person`, `DELETE r:T`)
  // is a compile-time error.  Deleting a plain variable (`DELETE n`, `DELETE r`)
  // is always legal — relationships need no DETACH, and deleting a node that
  // still has connections is a *runtime* DeleteConnectedNode, not InvalidDelete.
  if (plan.type === 'DELETE' && query) {
    // Match the DELETE clause operand directly: a `:` inside the target list
    // denotes a label/type expression.  Extract only the clause text after
    // DELETE/DETACH DELETE up to the next clause keyword.
    const delClause = query.match(/\b(?:DETACH\s+)?DELETE\s+([\s\S]+?)(?=\s+(?:RETURN|WITH|ORDER\s+BY|SKIP|LIMIT|UNWIND|SET|REMOVE|CREATE|MERGE|MATCH)\b|$)/i)
    if (delClause && /:/.test(delClause[1])) {
      throw Object.assign(new Error('SyntaxError: InvalidDelete'), { tckError: 'InvalidDelete' })
    }
  }

  // ── SyntaxError: UndefinedVariable / InvalidArgumentType on DELETE operands ──
  // DELETE must target bound variables (or property/index projections of one).
  // keyed off the query text rather than plan.type because an expression operand
  // such as `DELETE 1 + 1` is mis-parsed by ANTLR into MATCH_MODIFY (no symbolic
  // name → empty deleteTargets).  Each operand must start with a variable name:
  //   `DELETE x` (x not bound)          → UndefinedVariable
  //   `DELETE 1 + 1` (no leading variable)→ InvalidArgumentType
  if (query && /\b(?:DETACH\s+)?DELETE\b/i.test(query)) {
    const delClause = query.match(/\b(?:DETACH\s+)?DELETE\s+([\s\S]+?)(?=\s+(?:RETURN|WITH|ORDER\s+BY|SKIP|LIMIT|UNWIND|SET|REMOVE|CREATE|MERGE|MATCH)\b|$)/i)
    if (delClause) {
      // Bound identifiers: every node/edge variable (MATCH *and* CREATE/MERGE,
      // which `extractVariablesFromClause` covers), every `AS` alias, and path
      // variables (`MATCH p = ...` / `OPTIONAL MATCH p = ...`).  `DELETE p` for
      // a path variable and `MATCH () CREATE (n) DELETE n` are both legal.
      const bound = new Set<string>(extractVariablesFromClause(query))
      for (const wa of query.matchAll(/\bAS\s+(\w+)/gi)) bound.add(wa[1])
      for (const pv of query.matchAll(/\b(?:OPTIONAL\s+)?MATCH\s+(\w+)\s*=/gi)) bound.add(pv[1])
      for (const raw of delClause[1].split(',')) {
        const t = raw.trim()
        if (!t) continue
        // A valid operand must begin with an identifier (possibly followed by
        // property access / index expressions, e.g. `pathColls.key[0]`).
        const lead = t.match(/^`?([a-zA-Z_]\w*)/)
        if (!lead) {
          throw Object.assign(new Error('SyntaxError: InvalidArgumentType'), { tckError: 'InvalidArgumentType' })
        }
        if (!bound.has(lead[1])) {
          throw Object.assign(new Error('SyntaxError: UndefinedVariable'), { tckError: 'UndefinedVariable' })
        }
      }
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
      // 如果 type() 的参数是节点变量（在 MATCH 中绑定为节点，且不是边），抛出Error
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
  // A projection column that mixes an aggregate call with a non-aggregate
  // (bare variable / property) reference is ambiguous: the implicit grouping
  // is undefined (e.g. `RETURN me.age + count(you.age)`).  Two *separate*
  // columns — one grouping key, one aggregate — are legal (`RETURN n.division,
  // max(n.age)`), and ORDER BY may freely reference an already-projected
  // aggregate (`ORDER BY max(n.age)`), so neither is a conflict.
  if (query && plan.returnColumns?.length) {
    const aggFn = /\b(?:count|sum|avg|max|min|collect|stdev|stdevp|percentileCont|percentileDisc)\s*\(/i
    // Named grouping keys projected by OTHER return columns.  A single property/
    // variable access (e.g. `age`, `me.age`) explicitly returned as its own
    // column is a legal implicit grouping key, so an aggregate column may
    // reference it (`RETURN age, age + count(you.age)` — legal).  Composite
    // expressions (`me.age + you.age`) are NOT named keys (Return6 [21]).
    const returnNamedKeys = new Set<string>()
    for (const rc of plan.returnColumns) {
      if (typeof rc !== 'string') continue
      const t = rc.replace(/'[^']*'/g, "'' ").replace(/"/g, '" "').trim()
      if (!aggFn.test(t) && /^[a-zA-Z_]\w*(\.[a-zA-Z_]\w*)?$/.test(t)) returnNamedKeys.add(t)
    }
    // Also harvest the full `var.prop` forms from expressionColumns (which
    // preserve the variable prefix — e.g. `me.age`) so that a property access
    // used in an aggregate expression resolves against its returned alias.
    for (const ec of (plan.expressionColumns || [])) {
      const expr = typeof ec === 'string' ? ec : (ec as any).expression
      const alias = typeof ec === 'string' ? undefined : (ec as any).alias
      if (typeof expr === 'string' && !aggFn.test(expr) && /^[a-zA-Z_]\w*(\.[a-zA-Z_]\w*)?$/.test(expr.trim())) returnNamedKeys.add(expr.trim())
    }
    for (const rc of plan.returnColumns) {
      if (typeof rc !== 'string') continue
      const t = rc.replace(/'[^']*'/g, "'' ").replace(/"/g, '" "').trim()
      if (!aggFn.test(t) && /^[a-zA-Z_]\w*(\.[a-zA-Z_]\w*)?$/.test(t)) returnNamedKeys.add(t)
    }
    for (const rc of plan.returnColumns) {
      if (typeof rc !== 'string') continue
      // Strip the string literals so their contents are not scanned as variables.
      const col = rc.replace(/'[^']*'/g, "'' ").replace(/"[^"]*"/g, '" "')
      if (!aggFn.test(col)) continue
      // Remove the aggregate call(s) — including their balanced argument lists —
      // so that variables INSIDE a call (e.g. `n.age` in `max(n.age)`) are not
      // mistaken for non-aggregate references.  What remains is the mixing
      // expression: a bare variable there indicates ambiguous grouping.
      let withoutAggs = col
      const callRe = /\b(?:count|sum|avg|max|min|collect|stdev|stdevp|percentileCont|percentileDisc)\s*\(/gi
      let cm: RegExpExecArray | null
      let offset = 0
      while ((cm = callRe.exec(col)) !== null) {
        const start = cm.index + offset
        let depth = 0, j = cm.index + cm[0].length - 1
        for (; j < col.length; j++) {
          if (col[j] === '(') depth++
          else if (col[j] === ')') { depth--; if (depth === 0) break }
        }
        const end = j + 1
        withoutAggs = withoutAggs.slice(0, start) + withoutAggs.slice(end)
        offset -= (end - start)
      }
      // A remaining bare variable / property outside any aggregate call marks
      // the ambiguous mixed expression (e.g. `me.age + count(you.age)`).
      // A function NAME (an identifier immediately followed by `(`) is a nested
      // non-aggregate function wrapping the aggregate — `size(collect(a))` is
      // legal — so skip it instead of misclassifying it as a group key.
      const bareVar = /\b[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)?\b/g
      let bm: RegExpExecArray | null
      while ((bm = bareVar.exec(withoutAggs)) !== null) {
        const name = bm[0]
        if (/^(?:true|false|null|DISTINCT|AS)$/i.test(name)) continue
        // Is this identifier a function call (followed by optional whitespace
        // then `(`)?  If so it is a function name, not a variable reference.
        const after = withoutAggs.slice(bm.index + name.length)
        if (/^[^()]*\(/.test(after)) continue
        // A named grouping key projected by another return column is legal.
        if (returnNamedKeys.has(name)) continue
        throw Object.assign(new Error('SyntaxError: AmbiguousAggregationExpression'), { tckError: 'AmbiguousAggregationExpression' })
      }
    }
  }

  // ── AmbiguousAggregationExpression (WITH mix) ──
  // A WITH projection that mixes an aggregate with a non-aggregate reference is
  // ambiguous unless the reference is a NAMED grouping key: a single property/
  // variable access that is projected via `expr AS alias` in the same WITH
  // (`WITH me.age AS age, me.age + count(you.age)` — legal).  An unnamed property
  // (`WITH me.age + count(you.age)` — illegal) or a composite expression used as
  // the key (`WITH me.age + you.age AS grp, me.age + you.age + count(*)` — illegal)
  // is rejected.  With6 [7] (legal) vs [8][9] (illegal).
  const withCols = (plan.with?.columns || []) as Array<{ expression: unknown; alias?: string | null }>
  if (query && withCols.length) {
    // Named key: the expression text of every `expr AS alias` projection where
    // the expression is a SINGLE property/variable access (e.g. `me.age`), so it
    // may legally be reused as a grouping key alongside an aggregate.
    const namedKeys = new Set<string>()
    // Projected aliases across ALL WITH segments (withChain) — a bare identifier
    // (no `.`) that names a previously projected alias (`WITH age AS age ...
    // WITH age, age + count(...)`) is a legal grouping reference, not an
    // ambiguous property access.
    const allProjectedAliases = new Set<string>()
    const allWithSegs = ((plan as any).withChain?.length ? (plan as any).withChain : [plan.with]) as Array<{ columns: Array<{ expression: unknown; alias?: string | null }> }>
    for (const seg of allWithSegs) {
      for (const col of seg.columns || []) {
        const expr = typeof col.expression === 'string' ? col.expression : (col.expression as any)?.expression || ''
        const t = expr.trim()
        if (col.alias) {
          allProjectedAliases.add(col.alias)
          // Single property/variable access (no arithmetic/composite).
          if (/^[a-zA-Z_]\w*(\.[a-zA-Z_]\w*)?$/.test(t)) namedKeys.add(t)
        }
      }
    }
    const aggFn = /\b(?:count|sum|avg|max|min|collect|stdev|stdevp|percentileCont|percentileDisc)\s*\(/i
    for (const col of withCols) {
      const expr = typeof col.expression === 'string' ? col.expression : (col.expression as any)?.expression || ''
      const strippedLit = expr.replace(/'[^']*'/g, "'' ").replace(/"[^"]*"/g, '" ')
      if (!aggFn.test(strippedLit)) continue
      // Remove aggregate calls (balanced args) so variables inside a call are not
      // mistaken for grouping keys.
      let withoutAggs = strippedLit
      const callRe = /\b(?:count|sum|avg|max|min|collect|stdev|stdevp|percentileCont|percentileDisc)\s*\(/gi
      let cm: RegExpExecArray | null
      let offset = 0
      while ((cm = callRe.exec(strippedLit)) !== null) {
        const start = cm.index + offset
        let depth = 0, j = cm.index + cm[0].length - 1
        for (; j < strippedLit.length; j++) {
          if (strippedLit[j] === '(') depth++
          else if (strippedLit[j] === ')') { depth--; if (depth === 0) break }
        }
        const end = j + 1
        withoutAggs = withoutAggs.slice(0, start) + withoutAggs.slice(end)
        offset -= (end - start)
      }
      // Any remaining property/variable access that is NOT a named key marks an
      // ambiguous mix.  A function name (identifier followed by `(`) is skipped.
      const bareVar = /\b[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)?\b/g
      let bm: RegExpExecArray | null
      while ((bm = bareVar.exec(withoutAggs)) !== null) {
        const name = bm[0]
        if (/^(?:true|false|null|DISTINCT|AS)$/i.test(name)) continue
        if (bm.index > 0 && withoutAggs[bm.index - 1] === '$') continue
        // Skip a previously-stripped balanced aggregate artifact (identifier not
        // a whole token due to the offset splice) — only exact named keys pass.
        if (namedKeys.has(name)) continue
        // A bare alias projected by any WITH segment is a legal grouping reference.
        if (allProjectedAliases.has(name)) continue
        const after = withoutAggs.slice(bm.index + name.length)
        if (/^[^()]*\(/.test(after)) continue
        throw Object.assign(new Error('SyntaxError: AmbiguousAggregationExpression'), { tckError: 'AmbiguousAggregationExpression' })
      }
    }
  }

  // ── SyntaxError: ColumnNameConflict ──
  // A WITH (or RETURN) projection may not forward two columns under the same
  // alias in one clause — `WITH 1 AS a, 2 AS a` names `a` twice and the second
  // binding is ambiguous.  Only consider explicit `expr AS alias` aliases (a
  // bare column carries no explicit alias).
  if (query) {
    const segs = ((plan as any).withChain?.length ? (plan as any).withChain : (plan.with ? [plan.with] : [])) as Array<{ columns: Array<{ expression: unknown; alias?: string | null }> }>
    for (const seg of segs) {
      const seen = new Set<string>()
      for (const col of seg.columns || []) {
        const al = col.alias
        if (!al) continue
        if (seen.has(al)) {
          throw Object.assign(new Error('SyntaxError: ColumnNameConflict'), { tckError: 'ColumnNameConflict' })
        }
        seen.add(al)
      }
    }
    // RETURN-only duplicates (projection without a WITH).
    if (!(plan as any).with) {
      const seen = new Set<string>()
      for (const rc of plan.returnColumns || []) {
        // Only `expr AS alias` style RETURN columns carry an explicit alias.
        const m = (typeof rc === 'string' ? rc : '').match(/\bAS\s+([A-Za-z_]\w*)\s*$/i)
        if (m) {
          const al = m[1]
          if (seen.has(al)) {
            throw Object.assign(new Error('SyntaxError: ColumnNameConflict'), { tckError: 'ColumnNameConflict' })
          }
          seen.add(al)
        }
      }
    }
  }

  // ── SyntaxError: NoExpressionAlias ──
  // Every non-trivial expression in a WITH projection must be aliased via
  // `expr AS alias`; a bare expression or an expression without an alias
  // (`WITH a, count(*)`) is a compile-time error.  A bare variable (`WITH a`)
  // is legal — only an *expression* (an aggregate call, or anything beyond a
  // single variable/property) requires an alias.
  if (query && (plan.with?.columns || []).length) {
    for (const col of plan.with.columns as Array<{ expression: unknown; alias?: string | null }>) {
      const expr = typeof col.expression === 'string' ? col.expression.trim() : ''
      if (!expr) continue
      if (col.alias) continue
      // A bare variable / property access is a legal unaliased column.
      if (/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)?$/.test(expr) || /^\$\w+$/.test(expr)) continue
      // Anything else (aggregate call, arithmetic, map/list literal, etc.) needs
      // an explicit alias.
      throw Object.assign(new Error('SyntaxError: NoExpressionAlias'), { tckError: 'NoExpressionAlias' })
    }
  }

  // ── SyntaxError: NestedAggregation ──
  // An aggregate function may not wrap another aggregate call — their value is
  // only defined after the row set is grouped, so nesting them (`count(count(*))`,
  // `sum(avg(n.x))`) has no well-defined semantics and is a compile-time error.
  // Detect any aggregate call whose balanced argument list itself contains an
  // aggregate call.
  if (query) {
    const aggName = '(?:count|sum|avg|max|min|collect|stdev|stdevp|percentileCont|percentileDisc)'
    const aggCallRe = new RegExp(`\\b${aggName}\\s*\\(`, 'gi')
    let outer: RegExpExecArray | null
    // Re-scan from a fresh copy each outer call so nested args are re-inspected.
    while ((outer = aggCallRe.exec(query)) !== null) {
      // Locate the balanced closing parenthesis for this call.
      let depth = 0
      let j = outer.index + outer[0].length - 1
      let close = -1
      for (; j < query.length; j++) {
        if (query[j] === '(') depth++
        else if (query[j] === ')') { depth--; if (depth === 0) { close = j; break } }
      }
      if (close < 0) break
      const inner = query.slice(outer.index + outer[0].length, close)
      if (new RegExp(`\\b${aggName}\\s*\\(`, 'i').test(inner)) {
        throw Object.assign(new Error('SyntaxError: NestedAggregation'), { tckError: 'NestedAggregation' })
      }
    }
  }

  // ── SyntaxError: NonConstantExpression ──
  // An aggregate argument must be a deterministic expression over the grouped
  // rows.  `rand()` is non-deterministic (evaluated per row), so `count(rand())`
  // or `sum(rand())` is a compile-time error.
  if (query && /\b(?:count|sum|avg|max|min|collect)\s*\(\s*rand\s*\(/i.test(query)) {
    throw Object.assign(new Error('SyntaxError: NonConstantExpression'), { tckError: 'NonConstantExpression' })
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
  // SKIP/LIMIT may take any *constant* expression (an integer literal, or an
  // expression that does not reference variables such as `toInteger(rand()*9)`).
  // Referencing a variable (`SKIP n.count`, `LIMIT n.count`) is rejected at
  // compile time. Detect a variable reference as an identifier that is NOT a
  // function call (not followed by `(`) and is not a literal/keyword/parameter.
  const skipLimitExpr = query.match(/\b(?:SKIP|LIMIT)\s+(.+?)(?=\s+(?:ORDER\s+BY|RETURN|WITH|LIMIT|SKIP)|$)/i)
  if (skipLimitExpr) {
    const expr = skipLimitExpr[1].trim()
    // A variable reference is an identifier followed by `.` (property access)
    // or a bare identifier that is NOT a function call (no `(` after it).
    // Function names and literals are constant expressions and are allowed.
    const varRef = expr.match(/(?:^|[^\w$])([A-Za-z_][A-Za-z0-9_]*)\s*\./i)
    const bareVar = expr.match(/^(?:[^()]*\s)?([A-Za-z_][A-Za-z0-9_]*)$/)
    const isVarReference = (varRef !== null) ||
      (bareVar !== null && !/^(?:true|false|null|toInteger|rand|floor|ceil|round|abs|size|length)$/i.test(bareVar[1]))
    if (isVarReference && !/^\$/.test(expr) && !/^\d+$/.test(expr)) {
      throw Object.assign(new Error('SyntaxError: NonConstantExpression'), { tckError: 'NonConstantExpression' })
    }
  }

  // ── SyntaxError: InvalidAggregation (aggregate function in ORDER BY) ──
  // An ORDER BY item may only reference aggregations that were already
  // projected by a preceding WITH clause (e.g. `WITH avg(x.age) AS avgAge
  // ORDER BY $age + avg(x.age)`). Introducing a *new* aggregation in ORDER BY
  // (`ORDER BY count(n)`, `ORDER BY max(n.num2)`) is a compile-time syntax
  // error. Match each aggregate call against the set of WITH projection
  // expressions (excluding the alias) to tell the two cases apart.
  const orderByClauses = [...query.matchAll(/\bORDER\s+BY\s+(.+?)(?=\s+(?:RETURN|WITH|MATCH|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|LIMIT|SKIP)\b|$)/gi)]
  if (orderByClauses.length) {
    // Collect projected expression texts from every WITH clause (strip `AS alias`).
    const projectedExprs = new Set<string>()
    // Collect projected aliases (the `alias` in `expr AS alias`) — an ORDER BY
    // expression that mixes an aggregate with a bare reference is only
    // unambiguous when the bare reference is one of these aliases.
    const projectedAliases = new Set<string>()
    // Collect NAMED grouping keys: the expression text of every `expr AS alias`
    // projection (the alias is required).  A property access such as `me.age`
    // may legally appear alongside an aggregate in ORDER BY when `me.age` is a
    // named grouping key (`WITH me.age AS age`), but not when it is an unnamed
    // projection (`WITH me.age + you.age`).
    const namedGroupKeys = new Set<string>()
    const withClauses = [...query.matchAll(/\bWITH\s+(.+?)(?=\s+(?:WHERE|MATCH|RETURN|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|ORDER\s+BY|SKIP|LIMIT|CALL)\s|$)/gis)]
    for (const wm of withClauses) {
      const body = wm[1] // keep aliases for alias collection below
      const items = body.split(',').map(s => s.trim()).filter(Boolean)
      for (const it of items) {
        const aliasMatch = it.match(/\s+AS\s+(\w+)\s*$/i)
        if (aliasMatch) projectedAliases.add(aliasMatch[1])
        const exprText = it.replace(/\s+AS\s+\w+$/i, '').trim()
        if (exprText) {
          projectedExprs.add(exprText)
          if (aliasMatch) namedGroupKeys.add(exprText.replace(/\s+/g, ''))
        }
      }
    }
    // Also collect the RETURN projection raw expressions from the query text —
    // `plan.returnColumns` holds only aliases, so the original aggregate text
    // (e.g. `avg(person.age)` in `RETURN avg(person.age) AS avgAge`) must be
    // recovered from the query.  A RETURN clause may legally feed an ORDER BY
    // aggregate (`RETURN n.division, max(n.age) ORDER BY max(n.age)`).
    const returnClause = query.match(/\bRETURN\s+([\s\S]+?)(?=\s+ORDER\s+BY\b|$)/i)
    if (returnClause) {
      for (const item of returnClause[1].split(',')) {
        const aliasMatch = item.match(/\s+AS\s+(\w+)\s*$/i)
        if (aliasMatch) projectedAliases.add(aliasMatch[1])
        const exprText = item.replace(/\s+AS\s+\w+$/i, '').trim()
        if (exprText) projectedExprs.add(exprText)
      }
    }
    for (const obm of orderByClauses) {
      const obExpr = obm[1].replace(/\s+(?:ASC|ASCENDING|DESC|DESCENDING)\b/gi, '')
      // Find each aggregate call, capturing the balanced argument list.
      const aggRe = /\b(count|sum|avg|min|max|collect)\s*\(/gi
      let m: RegExpExecArray | null
      while ((m = aggRe.exec(obExpr)) !== null) {
        const funcStart = m.index
        // locate the closing parenthesis for this call
        let depth = 0, j = m.index + m[0].length - 1
        for (; j < obExpr.length; j++) {
          if (obExpr[j] === '(') depth++
          else if (obExpr[j] === ')') { depth--; if (depth === 0) break }
        }
        if (j >= obExpr.length) j = obExpr.length - 1
        const callText = obExpr.slice(funcStart, j + 1)
        // A call is allowed only if the exact call text appears within a
        // projected expression (RETURN/WITH).  A bare call (`avg(person.age)`)
        // may be embedded in a larger ORDER BY expression (`$age + avg(...) - 1`),
        // so substring matching (whitespace-insensitive) is used.
        const normCall = callText.replace(/\s+/g, '')
        const allowed = [...projectedExprs].some(pe => pe.replace(/\s+/g, '').includes(normCall))
        if (!allowed) {
          throw Object.assign(new Error('SyntaxError: InvalidAggregation'), { tckError: 'InvalidAggregation' })
        }
      }
      // ── AmbiguousAggregationExpression (ORDER BY mix) ──
      // When the ORDER BY item contains an aggregate call, any non-aggregate
      // reference it also contains must be either a named grouping key (an
      // `expr AS alias` projection, e.g. `me.age` in `WITH me.age AS age`) or a
      // projected alias.  An unnamed projection (`WITH me.age + you.age`) mixed
      // with an aggregate (`ORDER BY me.age + you.age + count(*)`) is ambiguous.
      // Strip string literals and every aggregate call (including its balanced
      // argument list); then strip named grouping keys (longest first) and
      // projected aliases.  Any bare identifier that remains is an
      // un-named/non-projected reference → AmbiguousAggregationExpression.
      if (/^\s*(.*)\b(count|sum|avg|max|min|collect|stdev|stdevp|percentileCont|percentileDisc)\s*\(/i.test(obExpr)) {
        const stripped = obExpr
          .replace(/'[^']*'/g, "'' ").replace(/"[^"]*"/g, '" ')
        let withoutAggs = stripped
        const callRe = /\b(?:count|sum|avg|max|min|collect|stdev|stdevp|percentileCont|percentileDisc)\s*\(/gi
        let cm2: RegExpExecArray | null
        let off = 0
        while ((cm2 = callRe.exec(stripped)) !== null) {
          const start = cm2.index + off
          let depth = 0, j2 = cm2.index + cm2[0].length - 1
          for (; j2 < stripped.length; j2++) {
            if (stripped[j2] === '(') depth++
            else if (stripped[j2] === ')') { depth--; if (depth === 0) break }
          }
          const end = j2 + 1
          withoutAggs = withoutAggs.slice(0, start) + withoutAggs.slice(end)
          off -= (end - start)
        }
        // Strip named grouping keys (longest first to avoid `me` matching before
        // `me.age`) and projected aliases from the residue.
        const groupKeys = [...namedGroupKeys].sort((a, b) => b.length - a.length)
        for (const gk of groupKeys) {
          withoutAggs = withoutAggs.split(gk).join(' ')
        }
        // Remove projected aliases as whole-word identifiers.
        for (const al of projectedAliases) {
          withoutAggs = withoutAggs.replace(new RegExp('\\b' + al + '\\b', 'g'), ' ')
        }
        // Remove remaining arithmetic/operator/syntax tokens.
        const bareVar = /\b[a-zA-Z_]\w*\b/g
        let bm2: RegExpExecArray | null
        while ((bm2 = bareVar.exec(withoutAggs)) !== null) {
          const name = bm2[0]
          // A parameter (`$age`) is a literal, not a variable reference — skip it.
          if (bm2.index > 0 && withoutAggs[bm2.index - 1] === '$') continue
          if (/^(?:true|false|null|DISTINCT|AS|ASC|ASCENDING|DESC|DESCENDING)$/i.test(name)) continue
          // A function name (identifier immediately followed by `(`) is a nested
          // non-aggregate function, e.g. `size(collect(a))` — skip it.
          const after = withoutAggs.slice(bm2.index + name.length)
          if (/^[^()]*\(/.test(after)) continue
          throw Object.assign(new Error('SyntaxError: AmbiguousAggregationExpression'), { tckError: 'AmbiguousAggregationExpression' })
        }
      }
    }
  }

  // ── SyntaxError: VariableAlreadyBound ──
  // 1. MATCH (n) CREATE (n:Person) — n 已在 MATCH 中绑定
  // Note: MATCH (x:X), (y:Y) CREATE (x)-[:R]->(y) 是合法的，x/y 在 createNodes 中
  // 仅当 createNode 有 label 或 props（即试图重新定义节点）时才视为 VariableAlreadyBound
  //
  // MERGE is exempt: `MATCH (a) MERGE (b) WITH * OPTIONAL MATCH (a)--(b)` is
  // legal — MERGE binds `b` to an existing node or creates it, and the later
  // OPTIONAL MATCH references the now-bound `b`.  MERGE populates both
  // `createNodes` and `mergeNodes`, so without this guard the MERGE-created `b`
  // is misclassified as a MATCH-bound re-declaration.  Only genuine CREATE is a
  // re-binding violation.
  if (plan.hasMatch && plan.createNodes?.length && plan.type === 'CREATE') {
    const matchVars = extractMatchVariables(query)
    const hasCreateEdges = !!(plan.createEdges && plan.createEdges.length)
    for (const cn of plan.createNodes) {
      if (cn.alias && matchVars.includes(cn.alias)) {
        // A MATCH-bound variable re-used in CREATE is a re-declaration of the
        // node (SyntaxError: VariableAlreadyBound) whenever CREATE is *not* a
        // relationship pattern.  `MATCH (a) CREATE (a)` and
        // `MATCH (a) CREATE (a {name:'foo'})` both re-bind `a` to a new node.
        //
        // The one legal case is a relationship CREATE that merely *references*
        // an already-bound node as an endpoint: `MATCH (a),(b) CREATE (a)-[:R]->(b)`
        // (Create2).  In that case the CREATE clause carries edges, so the
        // variable appears as a node endpoint reference, not a re-declaration.
        if (!hasCreateEdges || cn.label || (cn.props && Object.keys(cn.props).length > 0)) {
          throw Object.assign(new Error('SyntaxError: VariableAlreadyBound'), { tckError: 'VariableAlreadyBound' })
        }
      }
    }
  }
  // 2. CREATE (n:Foo) CREATE (n:Bar) — n 在同一语句中被绑定两次
  // 从 query 文本直接扫描所有 CREATE 中的变量
  // Note: CREATE (a) CREATE (a)-[:R]->(b) 中的 a 是引用已创建的变量，不是重新绑定
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
    // 增强：提取 WITH clause alias（WITH date(x) AS d → d 是有效变量）
    const withAliases = query.matchAll(/WITH\s+.+?\s+AS\s+(\w+)/gi)
    for (const wa of withAliases) boundVars.push(wa[1])
    // 逗号分隔的多个 WITH alias（WITH ... AS otherDate, ... AS otherTime）
    const withAliasesMulti = query.matchAll(/AS\s+(\w+)/gi)
    for (const wa of withAliasesMulti) {
      const idx = query.slice(0, wa.index).lastIndexOf("WITH")
      const afterWith = idx >= 0 ? query.slice(idx + 4, wa.index) : ""
      if (afterWith.includes("MATCH") || afterWith.includes("RETURN") || afterWith.includes("WHERE") || afterWith.includes("CREATE") || afterWith.includes("MERGE")) continue
      boundVars.push(wa[1])
    }
    // 从 returnColumns 检查未定义变量
    if (plan.returnColumns?.length) {
      for (const rc of plan.returnColumns) {
        if (!rc || rc === '*') continue
        const varName = rc.split('.')[0]
        // 跳过 aggregate 函数名、skip/limit/order 关键字、数字开头
        if (!/^[a-zA-Z_]\w*$/.test(varName)) continue
        if (/^(count|sum|avg|max|min|collect)$/i.test(varName)) continue
        // 如果这个变量在 plan 的已定义集合中找不到，也是未定义
        // Note: boundVars 从 text 提取可能不完整
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
    const varLenVars = [...cleaned.matchAll(/\[(\w+)\s*\*/g)].map(m => m[1]).filter(v => v)
    edgeVars.push(...varLenVars)
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
    // WITH <value> AS <alias> conflicts only when the alias is reused as a
    // node/edge variable in a LATER MATCH and <value> is a scalar/expression (not
    // a variable forward of the same kind).  `WITH r1 AS r2 MATCH ()-[r2]-()` is a
    // legal edge forward; `WITH 42 AS n MATCH (n)` conflicts; `MATCH (n) WITH
    // n.name AS n RETURN n` is legal (the alias is shadowed, not re-matched).
    const withBindingMatches = [...query.matchAll(/WITH\s+(.+?)\s+AS\s+(\w+)/ig)]
    for (const wm of withBindingMatches) {
      const wv = wm[2]
      if (!wv) continue
      const valueExpr = wm[1].split(',').pop()!.trim()
      const isVarForward = /^[a-zA-Z_]\w*$/.test(valueExpr) &&
        (matchNodeVars.includes(valueExpr) || edgeVars.includes(valueExpr) || pathAssignments.includes(valueExpr))
      if (isVarForward) continue
      // A node-/edge-typed expression (e.g. `coalesce(b, c)` where b and c are
      // node variables) still yields a node, so reusing its alias as a node in a
      // later MATCH is legal — only scalar/expression values conflict.
      const exprVars = [...valueExpr.matchAll(/[a-zA-Z_]\w*/g)].map(m => m[0])
        .filter(v => v.toLowerCase() !== 'coalesce' && !['null', 'true', 'false'].includes(v))
      const allExprVarsAreEntities = exprVars.length > 0 &&
        exprVars.every(v => matchNodeVars.includes(v) || edgeVars.includes(v) || pathAssignments.includes(v))
      if (allExprVarsAreEntities) continue
      // Only a conflict if this alias is re-bound as node/edge in a MATCH that
      // appears AFTER this WITH clause.
      const afterWith = query.slice((wm.index || 0) + wm[0].length)
      const reuseAsNode = new RegExp(`MATCH\\s+[\\s\\S]*?\\(${wv}(?::|\\))`).test(afterWith)
      const reuseAsEdge = new RegExp(`\\[${wv}\\s*(?::|\\])`).test(afterWith)
      if (reuseAsNode || reuseAsEdge) {
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
    // MATCH (a)-[r]->()-[r]->(a) — 同一关系变量出现在同一条 MATCH 子句中
    // 跨 WITH 的 MATCH 复用边变量不应抛异常，而是返回空结果
    if (query?.includes('MATCH') && !query?.includes('WITH')) {
      // Only relationship variables inside MATCH clauses count as a uniqueness
      // violation (`MATCH (a)-[r]->()-[r]->(a)`).  A MERGE relationship variable
      // (`MERGE (a)-[r]->(b)` where `r` was already MATCH-bound) is a *binding*
      // violation (VariableAlreadyBound), not a uniqueness violation, so strip
      // every MERGE clause before scanning for duplicate relationship variables.
      const matchOnly = query.replace(/\bMERGE\s+[^;]*?(?=\s+(?:RETURN|WITH|CREATE|MATCH|SET|DELETE|REMOVE|UNWIND|ON\s+)\b|$)/gi, '')
      const edgeVars = [...matchOnly.matchAll(/\[(\w+)\]/g)].map(m => m[1])
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

    // ── SyntaxError: InvalidArgumentType（length() on node/edge） ──
    // MATCH (n) RETURN length(n) — length() only valid on paths/strings
    // MATCH ()-[r]->() RETURN length(r) — same
    if (query) {
      const addLengthCheck = (textCaptures: RegExpMatchArray[], contextType: string) => {
        for (const m of textCaptures) {
          const varName = m[1]
          if (contextType === 'node' || contextType === 'edge') {
            throw Object.assign(new Error('SyntaxError: InvalidArgumentType'), { tckError: 'InvalidArgumentType' })
          }
        }
      }
      // length(node_var): node variables appear as (var_name) in MATCH
      const nodeVars = [...query.matchAll(/MATCH\s+(?:\((\w+)\)|\((\w+):)/g)].flatMap(m => m[1] || m[2] ? [m[1] || m[2]] : [])
      const edgeVars = [...query.matchAll(/-\[(\w+)\s*(?::|\])/g)].map(m => m[1]).filter(v => v && v !== '*' && v !== '?')
      for (const nv of nodeVars) {
        if (nv && new RegExp(`\\blength\\(\\s*${nv}\\s*\\)`, 'i').test(query)) {
          throw Object.assign(new Error('SyntaxError: InvalidArgumentType'), { tckError: 'InvalidArgumentType' })
        }
      }
      for (const ev of edgeVars) {
        if (ev && new RegExp(`\\blength\\(\\s*${ev}\\s*\\)`, 'i').test(query)) {
          throw Object.assign(new Error('SyntaxError: InvalidArgumentType'), { tckError: 'InvalidArgumentType' })
        }
      }
    }

    // ── SyntaxError: InvalidAggregation（WHERE 中使用聚合函数） ──
    // MATCH (a) WHERE count(a) > 10 RETURN a
    // Also: RETURN [x IN [1,2,3] | count(*)] — aggregation in list comprehension
    if (query) {
      const aggFuncs = ['count', 'sum', 'avg', 'min', 'max', 'collect']
      // Check WHERE clauses
      if (query.includes('WHERE')) {
        for (const func of aggFuncs) {
          const whereClause = query.split(/WHERE\s+/i).slice(1).join('WHERE ')
          if (!whereClause) break
          const whereBody = whereClause.split(/\s+(WITH|RETURN|CREATE|MERGE|SET|DELETE|ORDER|SKIP|LIMIT)\s+/i)[0]
          if (whereBody && new RegExp(`\\b${func}\\s*\\(`).test(whereBody)) {
            throw Object.assign(new Error('SyntaxError: InvalidAggregation'), { tckError: 'InvalidAggregation' })
          }
        }
      }
      // Check list comprehensions: [x IN list | agg_func(...)]
      const listCompMatch = query.match(/\[[\w.]+\s+IN\s+.+?\|(.+?)\]/g)
      if (listCompMatch) {
        for (const lc of listCompMatch) {
          const body = lc.substring(lc.indexOf('|') + 1, lc.lastIndexOf(']')).trim()
          for (const func of aggFuncs) {
            if (new RegExp(`\\b${func}\\s*\\(`, 'i').test(body)) {
              throw Object.assign(new Error('SyntaxError: InvalidAggregation'), { tckError: 'InvalidAggregation' })
            }
          }
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

  // ═══════════════════════════════════════════════════════════════
  // MERGE 编译期校验
  // ═══════════════════════════════════════════════════════════════
  // MERGE shares CREATE's structural relationship preconditions (a steady type,
  // no variable-length, directional) but additionally enforces variable binding
  // (a MERGE variable must not already be bound by a preceding MATCH/CREATE) and
  // restricts ON CREATE / ON MATCH SET operands to in-scope variables.
  if (query?.toUpperCase().includes('MERGE')) {
    _validateMergeClauses(query, plan)
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
        // 检测双向关系：<-[:R]->（同一个关系同时向左向右，非法的单关系双向）
        // 只匹配 `<-` 紧跟一个 `[...]` 紧跟 `->` 的单关系，不跨中间节点。
        if (/<-\s*\[[^\]]*\]\s*->/.test(createClause)) {
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

  // ═══════════════════════════════════════════════════════════════
  // CALL 校验 — 编译时Error
  // ═══════════════════════════════════════════════════════════════
  if (plan.type === 'CALL' && query) {
    const cp = plan.callProcedure as { name: string; args: any[]; yieldItems?: Array<{ name: string; alias: string | null }> } | undefined
    let resolvedName: string | undefined
    let resolvedArgs: string[] | undefined
    let resolvedYieldItems: Array<{ name: string; alias: string | null }> | undefined

    if (cp && cp.name) {
      resolvedName = cp.name
      resolvedArgs = cp.args?.map(a => String(a)) || []
      resolvedYieldItems = cp.yieldItems
    } else {
      const callFullMatch = query.match(/CALL\s+(\S+?)\s*\(([^)]*)\)\s*(YIELD\s+(.+?))?(?:\s+(?:RETURN|WHERE|WITH|CALL)|$)/is)
      if (callFullMatch) {
        resolvedName = callFullMatch[1].toLowerCase()
        const argsStr = callFullMatch[2].trim()
        resolvedArgs = argsStr ? argsStr.split(',').map(s => s.trim()).filter(Boolean) : []
        const yieldStr = callFullMatch[4]
        if (yieldStr) {
          resolvedYieldItems = yieldStr.split(',').map(s => {
            const as = s.trim().match(/^(\w+)\s+AS\s+(\w+)$/i)
            return as ? { name: as[1], alias: as[2] } : { name: s.trim(), alias: null }
          }).filter(yi => yi.name)
        }
      }
    }


    if (resolvedName) {
      const proc = _procedureRegistry.get(resolvedName)
      if (!proc) {
        throw Object.assign(new Error('ProcedureError: ProcedureNotFound (' + resolvedName + ')'), { tckError: 'ProcedureNotFound' })
      }
      const sigParens = proc.signature.match(/\(([^)]*)\)/)
      const sigArgs = sigParens ? sigParens[1].split(',').filter(s => s.trim().length > 0) : []
      if (resolvedArgs && resolvedArgs.length > sigArgs.length) {
        throw Object.assign(new Error('InvalidNumberOfArguments (' + resolvedName + '): expected ' + sigArgs.length + ', got ' + resolvedArgs.length), { tckError: 'InvalidNumberOfArguments' })
      }
      if (resolvedArgs && query.match(/CALL\s+\S+\s*\(/i) && resolvedArgs.length !== 0 && resolvedArgs.length < sigArgs.length) {
        throw Object.assign(new Error('InvalidNumberOfArguments (' + resolvedName + '): expected ' + sigArgs.length + ', got ' + resolvedArgs.length), { tckError: 'InvalidNumberOfArguments' })
      }
      if (resolvedArgs?.length) {
        const aggFnPattern = /^\s*(?:collect|count|sum|avg|max|min)\s*\(/i
        for (const arg of resolvedArgs) {
          if (aggFnPattern.test(arg)) {
            throw Object.assign(new Error('SyntaxError: InvalidAggregation (' + arg + ')'), { tckError: 'InvalidAggregation' })
          }
        }
        // InvalidArgumentType: literal arg types against signature
        const queryArgsArr = query.match(/CALL\s+\S+?\s*\(([^)]*)\)/i)
        if (queryArgsArr && sigArgs.length > 0) {
          const userArgs = queryArgsArr[1].split(',').map(s => s.trim()).filter(Boolean)
          for (let ai = 0; ai < Math.min(userArgs.length, sigArgs.length); ai++) {
            const sigArg = sigArgs[ai].trim()
            const typeMatch2 = sigArg.match(/::\s*(\w+)/)
            if (typeMatch2) {
              const expType = typeMatch2[1].toUpperCase()
              const userArg = userArgs[ai]
              let userType
              if (userArg === 'true' || userArg === 'false') userType = 'BOOLEAN'
              else if (/^-?\d+\.\d+/.test(userArg)) userType = 'FLOAT'
              else if (/^-?\d+$/.test(userArg)) userType = 'INTEGER'
              else if (/^['"]/.test(userArg)) userType = 'STRING'
              else if (userArg === 'null') userType = 'NULL'
              else continue
              if (expType === 'INTEGER' && (userType === 'BOOLEAN' || userType === 'FLOAT')) {
                throw Object.assign(new Error('SyntaxError: InvalidArgumentType'), { tckError: 'InvalidArgumentType' })
              }
              if (expType === 'BOOLEAN' && (userType === 'INTEGER' || userType === 'FLOAT')) {
                throw Object.assign(new Error('SyntaxError: InvalidArgumentType'), { tckError: 'InvalidArgumentType' })
              }
            }
          }
        }
      }
      if (resolvedYieldItems?.length) {
        const boundVars = new Set()
        // Only scan variables before the CALL (MATCH/WITH etc., not after)
        const beforeCall = query.slice(0, Math.max(0, query.toLowerCase().indexOf('call')))
        const matchClauses = beforeCall.matchAll(/MATCH\s+(.*?)(?:\s+(?:WHERE|WITH|RETURN|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|ORDER\s+BY|SKIP|LIMIT|INVOKE|CALL)\s|$)/gis)
        for (const mc of matchClauses) {
          const clause = mc[1]
          const nodeVars = clause.matchAll(/\((\w+)\s*(?::|\)|{)/g)
          for (const v of nodeVars) if (v[1]) boundVars.add(v[1])
          const edgeVars = clause.matchAll(/\[(\w+)\s*(?::|\]|\))/g)
          for (const v of edgeVars) if (v[1]) boundVars.add(v[1])
        }
        const withClauses = beforeCall.matchAll(/WITH\s+(.+?)(?:\s+(?:WHERE|RETURN|MATCH|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|ORDER\s+BY|SKIP|LIMIT|CALL)\s|$)/gis)
        for (const wc of withClauses) {
          const clause = wc[1]
          const asAliases = clause.matchAll(/\bAS\s+(\w+)/gi)
          for (const a of asAliases) boundVars.add(a[1])
          const bareVars = clause.matchAll(/\b([a-zA-Z_]\w*)\b/g)
          for (const v of bareVars) {
            if (!/^(?:AS|null|true|false)$/i.test(v[1])) boundVars.add(v[1])
          }
        }
        for (const yi of resolvedYieldItems) {
          const yieldName = yi.alias || yi.name
          if (boundVars.has(yieldName)) {
            throw Object.assign(new Error('SyntaxError: VariableAlreadyBound (' + yieldName + ')'), { tckError: 'VariableAlreadyBound' })
          }
        }
        // Check duplicate aliases within the same YIELD
        const allYieldNames = resolvedYieldItems.map(yi => yi.alias || yi.name)
        const seenNames = new Set()
        for (const yn of allYieldNames) {
          if (seenNames.has(yn)) {
            throw Object.assign(new Error('SyntaxError: VariableAlreadyBound (' + yn + ')'), { tckError: 'VariableAlreadyBound' })
          }
          seenNames.add(yn)
        }
      }
    } else {
      // In-query CALL without parentheses but with YIELD - check argument passing mode
      const bareCallMatchY = query.match(/CALL\s+(\S+?)\s+YIELD\s+/i)
      if (bareCallMatchY) {
        const bareNameY = bareCallMatchY[1].toLowerCase()
        const procY = _procedureRegistry.get(bareNameY)
        if (procY) {
          const sigParensY = procY.signature.match(/\(([^)]*)\)/)
          if (sigParensY) {
            const sigArgsY = sigParensY[1].split(',').filter(s => s.trim().length > 0)
            if (sigArgsY.length > 0) {
              throw Object.assign(new Error('SyntaxError: InvalidArgumentPassingMode'), { tckError: 'InvalidArgumentPassingMode' })
            }
          }
        }
      }
      const bareCallMatch = query.match(/CALL\s+(\S+)(?:\s|$)/i)
      if (bareCallMatch) {
        const bareName = bareCallMatch[1].toLowerCase()
        const proc = _procedureRegistry.get(bareName)
        if (!proc) {
          throw Object.assign(new Error('ProcedureError: ProcedureNotFound (' + bareName + ')'), { tckError: 'ProcedureNotFound' })
        }
        // MissingParameter: only throw for required non-optional params
        const sigPa = proc.signature.match(/\(([^)]*)\)/)
        if (sigPa) {
          const sigArgsB = sigPa[1].split(',').filter(s => s.trim().length > 0)
          if (sigArgsB.length > 0) {
            const hasRequiredParams = sigArgsB.some(a => {
              const trimmed = a.trim()
              return !trimmed.endsWith('?') && !/DEFAULT\s/i.test(trimmed)
            })
            if (hasRequiredParams) {
              throw Object.assign(new Error('ParameterMissing'), { tckError: 'MissingParameter' })
            }
          }
        }
        // InvalidArgumentType for bare CALL with parentheses args
        const bareCallArgs = query.match(/CALL\s+(\S+)\s*\(([^)]*)\)/i)
        if (bareCallArgs) {
          const bareName3 = bareCallArgs[1].toLowerCase()
          const proc3 = _procedureRegistry.get(bareName3)
          if (proc3) {
            const sigPa3 = proc3.signature.match(/\(([^)]*)\)/)
            if (sigPa3) {
              const sigArgs3 = sigPa3[1].split(',').filter(s => s.trim().length > 0)
              const userArgs3 = bareCallArgs[2].split(',').map(s => s.trim()).filter(Boolean)
              for (let ai = 0; ai < Math.min(userArgs3.length, sigArgs3.length); ai++) {
                const sigArg = sigArgs3[ai].trim()
                const typeMatch3 = sigArg.match(/::\s*(\w+)/)
                if (typeMatch3) {
                  const expType = typeMatch3[1].toUpperCase()
                  const userArg = userArgs3[ai]
                  let userType
                  if (userArg === 'true' || userArg === 'false') userType = 'BOOLEAN'
                  else if (/^-?\d+\.\d+/.test(userArg)) userType = 'FLOAT'
                  else if (/^-?\d+$/.test(userArg)) userType = 'INTEGER'
                  else if (/^['"]/.test(userArg)) userType = 'STRING'
                  else if (userArg === 'null') userType = 'NULL'
                  else continue
                  if (expType === 'INTEGER' && (userType === 'BOOLEAN' || userType === 'FLOAT')) {
                    throw Object.assign(new Error('SyntaxError: InvalidArgumentType'), { tckError: 'InvalidArgumentType' })
                  }
                  if (expType === 'BOOLEAN' && (userType === 'INTEGER' || userType === 'FLOAT')) {
                    throw Object.assign(new Error('SyntaxError: InvalidArgumentType'), { tckError: 'InvalidArgumentType' })
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // ── SyntaxError: InvalidRelationshipPattern ──
  // Detect variable-length relationship patterns with malformed range syntax
  // that ANTLR silently degrades (hence the @skipGrammarCheck scenarios):
  //   1. `-[:LIKES..]->`  — missing `*` before the range bounds.
  //   2. `-[:LIKES*-2]->` — negative bound (a negative hop count is invalid).
  //   3. `-[:LIKES*0]->`  — zero when not part of an explicit `0..` range.
  // A legal range always appears as `*`, `*min`, `*min..max`, or `*..max`
  // immediately after the relationship type inside square brackets.
  const bracketRelationships = query.match(/\[(?:[^\]]*?)\]/g) || []
  for (const br of bracketRelationships) {
    // Find the variable-length range token (`*`, `*1`, `*1..3`, `*..3`) after
    // the relationship type (a colon-led identifier may precede it).
    const relTypeMatch = br.match(/:\s*[A-Za-z_][A-Za-z0-9_]*/)
    if (!relTypeMatch) continue
    const afterType = br.slice(relTypeMatch.index! + relTypeMatch[0].length)
    // Case 1: type immediately followed by `..` without an intervening `*`.
    if (/^\s*\.\./.test(afterType)) {
      throw Object.assign(new Error('SyntaxError: InvalidRelationshipPattern'), { tckError: 'InvalidRelationshipPattern' })
    }
    // Case 2 & 3: a `*` whose bound is negative (or an explicit `*0`).
    const rangeMatch = afterType.match(/^\s*(\*)()\s*(-?\d+)?(?:\s*\.\.\s*(-?\d+)?)?/)
    if (rangeMatch) {
      const lo = rangeMatch[3]
      const hi = rangeMatch[4]
      if (lo !== undefined && parseInt(lo, 10) < 0) {
        throw Object.assign(new Error('SyntaxError: InvalidRelationshipPattern'), { tckError: 'InvalidRelationshipPattern' })
      }
      if (hi !== undefined && parseInt(hi, 10) < 0) {
        throw Object.assign(new Error('SyntaxError: InvalidRelationshipPattern'), { tckError: 'InvalidRelationshipPattern' })
      }
    }
    // Negative bound may also appear as a bare `*-2` with no dots.
    const negMatch = afterType.match(/^\s*\*\s*(-\d+)/)
    if (negMatch) {
      throw Object.assign(new Error('SyntaxError: InvalidRelationshipPattern'), { tckError: 'InvalidRelationshipPattern' })
    }
  }
}

/** Strip WHERE clauses from list predicates/comprehensions to avoid
 * false-positive UndefinedVariable errors on IN-bound variables.
 * e.g., [x IN collect(r) WHERE x <> null] -> [x IN collect(r)] */
function _stripListPredicates(query: string): string {
  let result = query
  const lcStart = /\[(\w+)\s+IN\s+/gi
  let m: RegExpExecArray | null
  while ((m = lcStart.exec(query)) !== null) {
    let depth = 1
    let i = m.index + 1
    while (i < query.length && depth > 0) {
      if (query[i] === '[') depth++
      else if (query[i] === ']') depth--
      if (depth > 0) i++
    }
    if (depth !== 0) continue
    const body = query.substring(m.index + m[0].length, i)
    const whereStart = body.search(/\bWHERE\s+/i)
    if (whereStart >= 0) {
      // Remove WHERE ... portion, keep the rest + closing bracket
      const prefix = query.substring(0, m.index + m[0].length + whereStart)
      const suffix = query.substring(i)
      result = prefix + suffix
    }
  }
  return result
}


/** MERGE 编译期校验。
 * MERGE 继承了 CREATE 对关系结构的前置约束（单一类型、非变长、有方向），
 * 但额外强制变量绑定约束（MERGE 变量不得已被前置 MATCH/CREATE 绑定）、
 * ON CREATE / ON MATCH SET 的操作数必须是作用域内变量。
 */
function _validateMergeClauses(query: string, plan: QueryPlan): void {
  // 逐条提取 MERGE 子句：MERGE <pattern> 直到下一个子句关键字。
  const mergeClauses = [...query.matchAll(/\bMERGE\s+([\s\S]*?)(?=\s+(?:ON\s+(?:CREATE|MATCH)|CREATE|MATCH|SET|DELETE|REMOVE|WITH|RETURN|UNWIND|MERGE)\b|$)/gi)]
  const preMatchCtx = query.slice(0, Math.max(0, query.toLowerCase().indexOf('merge')))

  // ── 1. 变量重复绑定（VariableAlreadyBound） ──
  // MERGE 变量不得已被前置 MATCH 绑定为节点/关系，或已被前置 CREATE 绑定，
  // 或被 MERGE 用新 label 重新定义。

  // (a) `MATCH (a) MERGE (a)` — MERGE 重新声明已绑定的节点（无 label/props 即
  //     为「重新绑定同一变量」，违反 VariableAlreadyBound）。
  //     仅当 MERGE 子句是一个**裸节点**（不含关系箭头）时才适用：`MERGE (a)`
  //     声明新变量 `a`；`MERGE (a)-->(b)` 中的 `(a)` 是关系端点引用（引用前置
  //     CREATE/MATCH 已绑定的节点），不属于重新绑定。
  for (const mc of mergeClauses) {
    const clause = mc[1]
    if (/(?:-->|<--|->|<-)/.test(clause)) continue  // 关系 MERGE，跳过
    const nodeDecls = [...clause.matchAll(/\(\s*(\w+)\s*(?::|\))/g)]
    for (const nd of nodeDecls) {
      const v = nd[1]
      // 前置作用域中该变量是否已作为节点/关系绑定？
      const preNode = new RegExp(`\\(\\s*${v}\\s*(?::|\\))`).test(preMatchCtx)
      const preRel = new RegExp(`\\[\\s*${v}\\s*(?::|\\])`).test(preMatchCtx)
      if ((preNode || preRel) && v && !/\$/.test(v)) {
        throw Object.assign(new Error('SyntaxError: VariableAlreadyBound'), { tckError: 'VariableAlreadyBound' })
      }
    }
  }

  // (b) 关系变量已绑定：`MATCH (a)-[r]->(b) MERGE (a)-[r]->(b)`。
  const mergeRelDecls = [...query.matchAll(/\bMERGE\s+\([^)]*\)\s*-\s*\[\s*(\w+)\s*(?::|\])/g)]
  for (const rd of mergeRelDecls) {
    const v = rd[1]
    const preRel = new RegExp(`\\[\\s*${v}\\s*(?::|\\])`).test(preMatchCtx)
    const preNode = new RegExp(`\\(\\s*${v}\\s*(?::|\\))`).test(preMatchCtx)
    if ((preRel || preNode) && v) {
      throw Object.assign(new Error('SyntaxError: VariableAlreadyBound'), { tckError: 'VariableAlreadyBound' })
    }
  }

  // (c) `CREATE (a:Foo) MERGE (a)-[r:KNOWS]->(a:Bar)` — a 已被 CREATE 绑定，
  //     MERGE 中 `a:Bar` 又给 a 强加新 label（重新定义）。
  //     提取 MERGE 模式中带 label 的节点变量，检查是否已被前置 CREATE/MATCH 绑定。
  const mergeLabeledNodes = [...query.matchAll(/\bMERGE\s+[^;]*?\(\s*(\w+)\s*:\s*(\w+)/g)]
  for (const mn of mergeLabeledNodes) {
    const v = mn[1]
    // 前置作用域中是否已绑定该变量（节点或关系）？
    const preNode = new RegExp(`\\(\\s*${v}\\s*(?::|\\))`).test(preMatchCtx)
    const preCreate = new RegExp(`\\bCREATE\\s+[^;]*?\\(\\s*${v}\\s*(?::|\\))`).test(preMatchCtx)
    if ((preNode || preCreate) && v) {
      throw Object.assign(new Error('SyntaxError: VariableAlreadyBound'), { tckError: 'VariableAlreadyBound' })
    }
  }

  // ── 4. 关系结构校验（NoSingleRelationshipType / CreatingVarLength） ──
  for (const mc of mergeClauses) {
    const clause = mc[1]
    const hasRelationship = /-->|<--|->|<-/.test(clause)
    if (!hasRelationship && !/\[/.test(clause)) continue

    // 无类型关系：(`->`/`-->`) 但没有 `[:Type]`。
    // `MERGE (a)-->(b)` 和 `MERGE (a)-[r]->(b)` 均无关系类型。
    if (/-->|<--|->|<-/.test(clause) && !/\[[^\]]*:[^\]]*\]/.test(clause)) {
      throw Object.assign(new Error('SyntaxError: NoSingleRelationshipType'), { tckError: 'NoSingleRelationshipType' })
    }
    // 多类型：`MERGE (a)-[:A|:B]->(b)`。
    if (/\[[^\]]*:[^\]]*\|[^\]]*\]/.test(clause)) {
      throw Object.assign(new Error('SyntaxError: NoSingleRelationshipType'), { tckError: 'NoSingleRelationshipType' })
    }
    // 变长关系：`MERGE (a)-[:FOO*2]->(b)`。
    if (/\[[^\]]*\*[^\]]*\]/.test(clause)) {
      throw Object.assign(new Error('SyntaxError: CreatingVarLength'), { tckError: 'CreatingVarLength' })
    }
  }

  // ── 5. 关系 predicate 参数（InvalidParameterUse） ──
  // `MERGE (a)-[r:FOO $param]->(b)` — 关系谓词含 `$param`。
  for (const mc of mergeClauses) {
    if (/\[[^\]]*\$\w+/.test(mc[1])) {
      throw Object.assign(new Error('SyntaxError: InvalidParameterUse'), { tckError: 'InvalidParameterUse' })
    }
  }

  // ── 6. ON CREATE / ON MATCH SET 未定义变量（UndefinedVariable） ──
  // `MERGE (n) ON CREATE SET x.num = 1` — SET 左值 `x` 不在作用域内。
  // 逐条提取 ON CREATE/ON MATCH 的 SET 体，按顶层逗号切分赋值项，对每个项
  // 提取左值变量（`x.prop` / `x:Foo` / `x` 的前导标识符），再判断其是否已由
  // 前置 MATCH/CREATE 或当前 MERGE 绑定。
  const onSetBlocks = [...query.matchAll(/\bON\s+(?:CREATE|MATCH)\s+SET\s+([^;]*?)(?=\s+(?:ON\s+(?:CREATE|MATCH)|RETURN|WITH|MERGE|CREATE|MATCH|DELETE|SET|REMOVE)\b|$)/gi)]
  for (const ob of onSetBlocks) {
    const body = ob[1]
    const assignments = _splitTopLevel(body, ',')
    for (const assign of assignments) {
      // 左值变量是赋值项的前导标识符（在 `.`、`:`、`=`、`+=` 之前）。
      const lvMatch = assign.trim().match(/^(\w+)\s*(?:\.|:|=|\+=)/)
      if (!lvMatch) continue
      const lv = lvMatch[1]
      // MERGE 绑定变量（节点 `(n)` 或关系 `[r]`）+ 前置作用域绑定都合法。
      const isMergeBoundNode = new RegExp(`\\(\\s*${lv}\\s*(?::|\\))`).test(query)
      const isMergeBoundRel = new RegExp(`\\[\\s*${lv}\\s*(?::|\\])`).test(query)
      const preBound = new RegExp(`\\(\\s*${lv}\\s*(?::|\\))`).test(preMatchCtx) || new RegExp(`\\[\\s*${lv}\\s*(?::|\\])`).test(preMatchCtx) || new RegExp(`\\bAS\\s+${lv}\\b`).test(query)
      if (lv && !preBound && !isMergeBoundNode && !isMergeBoundRel) {
        throw Object.assign(new Error('SyntaxError: UndefinedVariable'), { tckError: 'UndefinedVariable' })
      }
    }
  }
}
