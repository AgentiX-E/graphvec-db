/**
 * executor-validate-plan.ts — _validatePlan
 *
 * 从 query-executor.ts 拆分。
 */

import type { QueryPlan } from './query-types'
import { _validateUndefinedVariables, _validateUnknownFunctions, _validateOrderByScope, _validatePatternPosition, _validateWhereSelfPattern, _validateExistsSubqueryClauses, extractVariablesFromClause } from './executor-validators'
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
      // If any多个不同聚合函数
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
    const withClauses = [...query.matchAll(/\bWITH\s+(.+?)(?=\s+(?:WHERE|MATCH|RETURN|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|ORDER\s+BY|SKIP|LIMIT|CALL)\s|$)/gis)]
    for (const wm of withClauses) {
      const body = wm[1].replace(/\s+AS\s+\w+\s*(?=,|$)/gi, '') // strip trailing aliases
      const items = body.split(',').map(s => s.trim()).filter(Boolean)
      for (const it of items) {
        // strip a remaining `AS alias`
        const exprText = it.replace(/\s+AS\s+\w+$/i, '').trim()
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
        // A call is allowed only if the exact call text is already projected.
        const allowed = [...projectedExprs].some(pe => pe.replace(/\s+/g, '') === callText.replace(/\s+/g, ''))
        if (!allowed) {
          throw Object.assign(new Error('SyntaxError: InvalidAggregation'), { tckError: 'InvalidAggregation' })
        }
      }
    }
  }

  // ── SyntaxError: VariableAlreadyBound ──
  // 1. MATCH (n) CREATE (n:Person) — n 已在 MATCH 中绑定
  // Note: MATCH (x:X), (y:Y) CREATE (x)-[:R]->(y) 是合法的，x/y 在 createNodes 中
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
    // MATCH (a)-[r]->()-[r]->(a) — 同一关系变量出现在同一条 MATCH 子句中
    // 跨 WITH 的 MATCH 复用边变量不应抛异常，而是返回空结果
    if (query?.includes('MATCH') && !query?.includes('WITH')) {
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

