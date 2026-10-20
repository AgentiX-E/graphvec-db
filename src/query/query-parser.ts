/**
 * query-parser.ts — Cypher-lite 查询解析
 *
 * 从 query-engine.ts 拆分。
 * 包含所有解析、参数化、执行计划构建逻辑。
 */

import { parseCypherToPlan } from './ast-to-plan-v2'
import { _evaluateExpression, _postProcessResults, QueryRow, _parseAggregate, _parseNestedAggregate, _extractAggColumns, _hasAggregates, _executeAggregation, _enrichWithAggregates, _validateLiterals, _bigintReplacer, _bigintReviver, _parseCommaList } from './expression-engine'
import { executeVarLenPath } from './var-length-path'
import type { QueryPlan, FilterClause, TraverseStep, EdgeStepAST, PatternAST, WhereClauseAST, ColumnAST, ExpressionAST, PrimaryAST, AggregateClause } from './query-types'
import type { OverGraphConfig } from '../types'

// ── AST 类型 ─────────────────────────────────────────────────

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
 * @param params - Optional参数数组或对象
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
  try {
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
  } catch (e: any) {
    throw new Error(`Failed to execute query: ${(e as Error).message}`)
  }
}

/**
 * 位置参数替换：$1, $2, ..., $N
 *
 * 策略：先用 parseQuery 解析含 $1 占位符的 query（ANTLR 会保留 $1 为 filter value），
 * 然后遍历 plan 结构，将 $1 / $2 等占位符替换为真实参数值。
 * 这样避免了 ANTLR 词法分析对参数值中特殊字符（如 OR/AND/--/引号）的误解析。
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

  // 4. 先用 parseQuery 解析（$1 会被 ANTLR 保留为 filter value 字符串）
  const plan = parseQuery(query)

  // 5. 注入参数值到 plan 结构中
  _injectParamsToPlan(plan, (name: string) => {
    const idx = parseInt(name, 10)
    if (isNaN(idx) || idx < 1 || idx > params.length) return undefined
    return params[idx - 1]
  })

  return plan
}

/**
 * 命名参数替换：$name, $age, ...
 *
 * 同位置参数策略：先 parseQuery，再注入参数值。
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

  // 3. 先用 parseQuery 解析（$name 会被 ANTLR 保留为 filter value 字符串）
  const plan = parseQuery(query)

  // 4. 注入参数值到 plan 结构中
  _injectParamsToPlan(plan, (name: string) => {
    if (name in params) return params[name]
    return undefined
  })

  return plan
}

/**
 * 遍历 plan 结构，将所有以 `$` 开头的 filter value 替换为真实参数值。
 */
function _injectParamsToPlan(plan: QueryPlan, resolve: (name: string) => unknown): void {
  // 替换 filter.values
  if (plan.filters?.length) {
    for (const f of plan.filters) {
      if (typeof f.value === 'string' && f.value.startsWith('$')) {
        const paramName = f.value.slice(1)
        const provided = resolve(paramName)
        if (provided !== undefined) {
          // 字符串参数直接赋值给 plan filter 值（非 SQL 拼接），不存在注入风险。
          // _injectParamsToPlan 在 AST 解析后的 plan 上运作，filter.value 是 JS 
          // 运行时值，不会被解释为 CQL/SQL 语句。引号保留以确保值完整匹配。
          if (typeof provided === 'string') {
            const hasSingle = provided.includes("'")
            const hasDouble = provided.includes('"')
            if (hasSingle && hasDouble) {
              // 同时含两种引号：移除全部引号（安全兜底，极罕见）
              f.value = provided.replace(/['"]/g, '')
            } else {
              f.value = provided
            }
          } else {
            f.value = provided
          }
        }
      }
    }
  }

  // 替换 limit / skip（$limit → number）
  if (typeof plan.limit === 'string' && (plan.limit as string).startsWith('$')) {
    const paramName = (plan.limit as string).slice(1)
    const provided = resolve(paramName)
    if (typeof provided === 'number') plan.limit = provided
  }
  if (typeof plan.skip === 'string' && (plan.skip as string).startsWith('$')) {
    const paramName = (plan.skip as string).slice(1)
    const provided = resolve(paramName)
    if (typeof provided === 'number') plan.skip = provided
  }

  // 替换 createNode props
  if (plan.createNodes?.length) {
    for (const cn of plan.createNodes) {
      if (cn.props) {
        for (const [pk, pv] of Object.entries(cn.props)) {
          if (typeof pv === 'string' && pv.startsWith('$')) {
            const paramName = pv.slice(1)
            const provided = resolve(paramName)
            if (provided !== undefined) {
              cn.props[pk] = provided
            }
          }
        }
      }
    }
  }

  // 替换 with.columns 中的 $param 占位符
  if (plan.with?.columns) {
    for (const wc of plan.with.columns) {
      if (typeof wc.expression === 'string' && wc.expression.startsWith('$')) {
        const paramName = wc.expression.slice(1)
        const provided = resolve(paramName)
        if (provided !== undefined) {
          wc.expression = provided
        }
      }
    }
  }

  // 替换 expressionColumns 中的 $param 占位符
  if (plan.expressionColumns?.length) {
    for (const ec of plan.expressionColumns) {
      if (typeof ec.expression === 'string' && ec.expression.startsWith('$')) {
        const paramName = ec.expression.slice(1)
        const provided = resolve(paramName)
        if (provided !== undefined) {
          ec.expression = provided
        }
      }
    }
  }

  // 递归处理 rightPlan（UNION/INTERSECT/SUBTRACT）
  if (plan.rightPlan) _injectParamsToPlan(plan.rightPlan, resolve)
  // 递归处理 callQuery
  if (plan.callQuery) _injectParamsToPlan(plan.callQuery, resolve)
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
 *     然后从 AST 中提取所需Info重构 WITH 子句。
 */

export function parseQuery(query: string): QueryPlan {
  return _cachedParseQuery(query)
}

function _parseQueryImpl(query: string): QueryPlan {
  // ANTLR parser — direct QueryPlan output, no PEG AST intermediate
  let plan: QueryPlan
  try {
    plan = parseCypherToPlan(query.trim())
  } catch (e: any) {
    throw new Error(`Query parse error: ${(e as Error).message}`)
  }

  // 递归修复子计划的 scanLabel（UNION/INTERSECT/SUBTRACT 的 rightPlan，CALL 的 callQuery）
  function _isValidLabel(label: string): boolean {
    // 合法的标签名只包含字母、数字（不能以数字开头）、允许下划线
    return /^[a-zA-Z_]\w*$/.test(label)
  }
  function _fixScanLabel(subPlan: QueryPlan): void {
    // 
    // 清除 labelExpr 中的所有非法标签名（从 WITH date({...}) 误解析的）
    if (subPlan.labelExpr?.items) {
      const validItems = subPlan.labelExpr.items.filter(item => _isValidLabel(item.name))
      subPlan.labelExpr.items = validItems
      if (validItems.length === 0) subPlan.labelExpr = undefined
    }
    if (subPlan.scanLabel && !subPlan.labelExpr) {
      // 清除非法标签（如 ANTLR 从 WITH date({...}) 中误解析的逗号分隔内容）
      if (subPlan.scanLabel && !_isValidLabel(subPlan.scanLabel)) {
        subPlan.scanLabel = null
        return
      }
      if (subPlan.returnColumns?.includes(subPlan.scanLabel)) {
        subPlan.scanLabel = null
      } else if (subPlan.filters?.length && subPlan.filters.some(f => f.source === subPlan.scanLabel)) {
        subPlan.scanLabel = null
      } else if (/^[a-z][0-9]?$/.test(subPlan.scanLabel) && !subPlan.createNodes?.some(n => n.label === subPlan.scanLabel)) {
        subPlan.scanLabel = null
      }
      // 如果 scanLabel 是 MATCH 中的变量名而非真正标签（如 MATCH (a) 中 a 被 ANTLR 当成 scanLabel）
      // 正确标签会出现在 MATCH 子句的 :scanLabel 形式中。否则是变量名。
      // MATCH (a:Person) → scanLabel='Person', 查询中有 ':Person' → 保留
      // MATCH (a)       → scanLabel='a', 查询中有 '(a)' 但无 ':a' → 清除
      if (subPlan.scanLabel && subPlan.hasMatch && query) {
        const rawQuery = query
        // 检查 scanLabel 是否在 MATCH 子句中以 :scanLabel 形式出现（标签）
        const matchClauses = rawQuery.match(/MATCH\s+.*?(?=WHERE|RETURN|WITH|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|\$Cypher|$)/gis) || []
        const isLabelInMatch = matchClauses.some((mc: string) => {
          // 在节点模式中查找 :scanLabel：如 (:Person), :Person), :Person {prop}
          // `\s*` tolerates a space after the colon (`(n: Label)`), which ANTLR
          // folds into the SymbolicName but our trim-based label extraction strips.
          const labelPattern = new RegExp(':' + '\\s*' + subPlan.scanLabel + '(?=[\)\\s{]|$)')
          return labelPattern.test(mc)
        })
        // 如果 scanLabel 在 MATCH 子句中不是作为标签出现，则是变量名，清除
        if (!isLabelInMatch) {
          subPlan.scanLabel = null
        }
      }
    }
    if (subPlan.rightPlan) _fixScanLabel(subPlan.rightPlan)
    if (subPlan.callQuery) _fixScanLabel(subPlan.callQuery)
    // 同时修复 optionalMatchSteps 中的 scanLabel（它们也可能被 ANTLR 误认为是标签名）
    if (subPlan.optionalMatchSteps?.length && query) {
      const rawQuery = query
      const matchClauses = rawQuery.match(/MATCH\s+.*?(?=WHERE|RETURN|WITH|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|\$Cypher|$)/gis) || []
      for (const oms of subPlan.optionalMatchSteps) {
        if (oms.scanLabel && /^[a-z][0-9]?$/.test(oms.scanLabel)) {
          const labelPattern = new RegExp(':' + oms.scanLabel + '(?=[\)\\s{]|$)')
          const isLabelInMatch = matchClauses.some((mc: string) => labelPattern.test(mc))
          if (!isLabelInMatch) {
            oms.scanLabel = null
          }
        }
      }
    }
    // Fix multiMatch scanLabels too: a bare `MATCH (n)` variable is recorded as
    // scanLabel='n' by extractMatch (label falls back to the variable name), but
    // `n` is a variable, not a label. Clear it unless `:n` appears as a real
    // label in a MATCH clause (same rule as optionalMatchSteps above).
    if (subPlan.multiMatch?.length && query) {
      const rawQuery = query
      const matchClauses = rawQuery.match(/MATCH\s+.*?(?=WHERE|RETURN|WITH|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|\$Cypher|$)/gis) || []
      for (const mm of subPlan.multiMatch) {
        if (mm.scanLabel) {
          // `\s*` tolerates a space after the colon (`(n: Label)`) — see the
          // primary scanLabel fix above.
          const labelPattern = new RegExp(':' + '\\s*' + mm.scanLabel + '(?=[\)\\s{]|$)')
          const isLabelInMatch = matchClauses.some((mc: string) => labelPattern.test(mc))
          if (!isLabelInMatch) {
            mm.scanLabel = null
          }
        }
      }
    }
  }
  _fixScanLabel(plan)
  _fixScanLabel(plan)

  // ── Extract path variables from MATCH p = (n)-->() patterns ──
  // ANTLR does not recognise path variable assignment; inject into plan.steps
  // The path variable belongs to the FIRST MATCH clause only (plan.steps maps
  // to that clause), so anchor to the query start — a later `MATCH p = ...`
  // (e.g. `MATCH ()-[r:EDGE]-() MATCH p = (n)-[*0..1]-...`) must NOT attach its
  // path variable to the leading anonymous step, otherwise `p` leaks onto the
  // wrong step and the executor mis-routes that pattern into the path branch.
  if (plan.steps?.length && query) {
    const pvMatch = query.match(/^\s*MATCH\s+(\w+)\s*=\s*\(\s*(\w+)/i)
    if (pvMatch && pvMatch[1] !== pvMatch[2]) {
      plan.steps[0].pathVariable = pvMatch[1]
    }
  }
  // Also handle path variables in optional MATCH
  if (plan.optionalMatchSteps?.length && query) {
    const optMatches = [...query.matchAll(/OPTIONAL\s+MATCH\s+(\w+)\s*=\s*\(/gi)]
    let idx = 0
    for (const om of plan.optionalMatchSteps) {
      if (idx < optMatches.length && om.steps?.length) {
        const pv = optMatches[idx][1]
        om.steps[0].pathVariable = pv
      }
      idx++
    }
  }

  // ── DML type 映射：MATCH_MODIFY → SET/DELETE ──
  // 如果 MATCH_MODIFY 只有一种 DML 操作，细化为准确类型
  if (plan.type === 'MATCH_MODIFY') {
    const hasSet = !!plan.setClauses?.length
    const hasRemove = !!plan.removeClauses?.length
    const hasDelete = !!plan.deleteClauses?.length || !!plan.deleteTargets?.length
    if (hasSet && !hasRemove && !hasDelete) {
      plan.type = 'SET'
    } else if (hasDelete && !hasSet && !hasRemove) {
      plan.type = 'DELETE'
    } else if (hasRemove && !hasSet && !hasDelete) {
      plan.type = 'REMOVE'
    }
    // 混合 DML 操作保持 MATCH_MODIFY
  }

  // ── MERGE: mergeNodes → createNodes（CREATE 路径复用） ──
  // Each mergeNode is tagged `_isMerge` (by reference) so the executor can
  // distinguish "match-or-create" nodes from plain CREATE nodes in a mixed
  // `CREATE ... MERGE ...` query.  MERGE must first look for an existing
  // matching node (reuse + ON MATCH) before falling back to creation (ON CREATE);
  // plain CREATE always materializes a new node.
  if (plan.type === 'MERGE' && plan.mergeNodes?.length) {
    if (!plan.createNodes) plan.createNodes = []
    for (const mn of plan.mergeNodes) {
      (mn as any)._isMerge = true
      plan.createNodes.push(mn)
    }
  }

  // ── returnColumns 拆解：b.name → name （去掉变量前缀） ──
  // Only strip the variable prefix on a *top-level* `var.prop` reference
  // (`b.name` → `name`).  A `.` inside a function call (`sum(n.num)`,
  // `collect(a.id)`) or a decimal literal (`1.5`) must be preserved verbatim,
  // otherwise `indexOf('.')` would wrongly truncate `sum(n.num)` to `num)`.
  //
  // Collision guard: when several *different* variables project the *same*
  // property name (`RETURN a.id, b.id`), blindly stripping the prefixes would
  // collapse both columns into a single `id` and silently drop one of them
  // (and `returnAliasMap` would keep only the last).  In that case the full
  // `var.prop` form is kept as the column key (`a.id`, `b.id`) so the two
  // columns stay distinct — matching the TCK header `| a.id | b.id |`.
  const _propOf = (s: string): string | null =>
    /^[a-zA-Z_]\w*\.[a-zA-Z_]\w*$/.test(s) ? s.split('.').pop()! : null
  const _rcPropCounts = new Map<string, number>()
  for (const rc of plan.returnColumns || []) {
    const p = _propOf(rc)
    if (p != null) _rcPropCounts.set(p, (_rcPropCounts.get(p) || 0) + 1)
  }
  // A `var.prop` column keeps its prefix iff its bare property name appears more
  // than once across the projection (i.e. it would collide after stripping).
  const _stripProp = (s: string): string => {
    const p = _propOf(s)
    if (p == null) return s
    return (_rcPropCounts.get(p) || 0) > 1 ? s : p
  }
  if (plan.returnColumns?.length) {
    plan.returnColumns = plan.returnColumns.map(_stripProp)
  }
  // expressionColumns 的 alias/expression 也应同步更新
  if (plan.expressionColumns?.length) {
    plan.expressionColumns = plan.expressionColumns.map((ec: any) => {
      const expr = typeof ec === 'string' ? ec : ec.expression || ec.alias || ec
      const alias = ec.alias || expr
      // 只在顶层拆分 b.name → name，跳过表达式内的 .（如 1.5, func().prop）
      // Note: 不修改 expression（用于求值），只修改 alias（用作结果列名）
      // 但同属性多列碰撞时保留 var.prop 形式（见上方 collision guard）。
      let dotIdx = -1
      const _topLevelProp = /^[a-zA-Z_]\w*\.[a-zA-Z_]\w*$/.test(alias)
      if (_topLevelProp) {
        dotIdx = alias.indexOf('.')
      }
      const cleanExpr = dotIdx >= 0 ? alias.substring(dotIdx + 1) : expr
      const cleanAlias = _stripProp(alias)
      return { expression: expr, alias: cleanAlias }
    })
    // 同步更新 returnAliasMap
    if (plan.returnAliasMap) {
      const newAliasMap: Record<string, string> = {}
      for (const [key, val] of Object.entries(plan.returnAliasMap)) {
        const cleanKey = _stripProp(key)
        // 保留原始表达式值（如 'd.year'），不裁剪为 'year'
        newAliasMap[cleanKey] = val
      }
      plan.returnAliasMap = newAliasMap
    }
  }

  // ── WHERE 子句提取（用于后过滤） ──
  // 即使 ANTLR 没有生成 filters，也需要提取 WHERE 子句供 _evaluateExpression 后处理
  // Note: 需要先屏蔽 list 谓词中的 WHERE（如 ALL(x IN list WHERE cond)），避免干扰正则
  let safeQuery = (query || '')
  // 使用平衡括号匹配，将 list 谓词替换为占位符
  const listPredStarts = [...safeQuery.matchAll(/\b(ALL|ANY|NONE|SINGLE)\s*\(/gi)]
  const placeholders: Array<{ start: number; end: number; text: string }> = []
  if (listPredStarts.length > 0) {
    for (const pMatch of listPredStarts) {
      let depth = 1
      let i = (pMatch.index || 0) + pMatch[0].length
      while (i < safeQuery.length && depth > 0) {
        if (safeQuery[i] === '(') depth++
        else if (safeQuery[i] === ')') depth--
        if (depth === 0) { i++; break }
        i++
      }
      placeholders.push({ start: pMatch.index || 0, end: i, text: safeQuery.slice(pMatch.index || 0, i) })
    }
    // 从后往前替换为占位符（保持索引不变）
    for (let pi = placeholders.length - 1; pi >= 0; pi--) {
      const { start, end } = placeholders[pi]
      const placeholder = ` __LPRED${pi}__ `
      safeQuery = safeQuery.slice(0, start) + placeholder + safeQuery.slice(end)
    }
  }
  const wholeWhereBody = _extractWhereBodyBraceAware(safeQuery)
  if (wholeWhereBody) {
    let whereBody = wholeWhereBody
    // 恢复占位符
    for (let pi = 0; pi < placeholders.length; pi++) {
      whereBody = whereBody.replace(`__LPRED${pi}__`, placeholders[pi].text)
    }
    plan.whereBody = whereBody
    // 检测顶层 OR/XOR（不在括号内的 OR）——清空 filters（OR 需要运行时可短路评估）
    if (plan.filters?.length) {
      let depth = 0
      let hasTopLevelOr = false
      for (let i = 0; i < whereBody.length; i++) {
        const ch = whereBody[i]
        if (ch === '(') depth++
        else if (ch === ')') depth--
        else if (depth === 0) {
          if (whereBody.substring(i).match(/^\b(OR|XOR)\b/i)) { hasTopLevelOr = true; break }
        }
      }
      if (hasTopLevelOr) plan.filters = []
    }
  }

  // ── 多标签修复 ──
  // AST 只取第一个标签作为 scanLabel（如 :A:B → scanLabel='A'），
  // _fixScanLabel 可能因 regex 匹配多标签而清空 scanLabel。
  // 此处从 query 文本检测多标签并重建 scanLabel + labelExpr。
  const qText = query.trim()
  if (plan.hasMatch) {
    // 只匹配真正的 MATCH 子句中的节点模式 (var:Label)，排除 WITH 中的函数调用如 date({...})
    const matchClauseText = (qText.match(/MATCH\s*.*?(?=WHERE|RETURN|WITH|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|$)/gis) || [''])[0]
    const nodePatterns = matchClauseText.match(/\([^)]+\)/g) || []
    // 优先使用 scanLabel 未清空时的路径
    let multiLabelFound = false
    if (plan.scanLabel) {
      for (const np of nodePatterns) {
        const inner = np.slice(1, -1).trim()
        const colIdx = inner.indexOf(':')
        if (colIdx === -1) continue
        let labelPart = inner.substring(colIdx + 1)
        const braceIdx = labelPart.indexOf('{')
        if (braceIdx >= 0) labelPart = labelPart.substring(0, braceIdx).trim()
        const labels = labelPart.split(':').map(s => s.trim()).filter(Boolean)
        if (labels.length > 1 && labels[0] === plan.scanLabel) {
          // 填充 labelExpr（用于 engine 二次过滤），但 scanLabel 保留第一个标签
          // （GE 用单标签扫描后再用 labelExpr AND 过滤）
          plan.labelExpr = { type: 'LABEL_EXPR', items: labels.map(l => ({ exclude: false, name: l })) }
          multiLabelFound = true
          break
        }
      }
    }
    // 如果 scanLabel 被清空但仍有多标签，从 query 恢复
    if (!multiLabelFound && !plan.labelExpr) {
      for (const np of nodePatterns) {
        const inner = np.slice(1, -1).trim()
        const colIdx = inner.indexOf(':')
        if (colIdx === -1) continue
        // 检查变量名（冒号前的部分）
        const varPart = inner.substring(0, colIdx).trim()
        let labelPart = inner.substring(colIdx + 1)
        const braceIdx = labelPart.indexOf('{')
        if (braceIdx >= 0) labelPart = labelPart.substring(0, braceIdx).trim()
        const labels = labelPart.split(':').map(s => s.trim()).filter(Boolean)
        if (labels.length > 1) {
          // 恢复 scanLabel 为第一个标签，设置 labelExpr
          plan.scanLabel = labels[0]
          plan.labelExpr = { type: 'LABEL_EXPR', items: labels.map(l => ({ exclude: false, name: l })) }
          // 确保 scanLabel 不是变量名（仅在 steps 为空时指向标签）
          if (!plan.steps?.length) {
            // 保留 scanLabel
          }
          break
        }
      }
    }
  }
  // 修复 createNodes 的多标签
  if (plan.createNodes?.length && (plan.type === 'CREATE' || plan.type === 'MERGE')) {
    const nodePatterns = qText.match(/\([^)]+\)/g) || []
    let npIdx = 0
    for (const np of nodePatterns) {
      if (npIdx >= plan.createNodes.length) break
      const inner = np.slice(1, -1).trim()
      const colIdx = inner.indexOf(':')
      if (colIdx === -1) { npIdx++; continue }
      let labelPart = inner.substring(colIdx + 1)
      const braceIdx = labelPart.indexOf('{')
      if (braceIdx >= 0) labelPart = labelPart.substring(0, braceIdx).trim()
      const labels = labelPart.split(':').map(s => s.trim()).filter(Boolean)
      if (labels.length > 1 && labels[0] === plan.createNodes[npIdx].label) {
        plan.createNodes[npIdx].label = labels.join(':')
      }
      npIdx++
    }
  }

  // ── createNodes props 格式转换：{prop: 'val'} → {prop: {type: 'STRING', value: 'val'}} ──
  for (const cn of (plan.createNodes || [])) {
    if (cn.props) {
      for (const [pk, pv] of Object.entries(cn.props)) {
        if (typeof pv === 'string' && !pv.startsWith('$') && !(pv as any)?.type) {
          cn.props[pk] = { type: 'STRING', value: pv }
        } else if (typeof pv === 'number') {
          cn.props[pk] = { type: 'NUMBER', value: pv }
        } else if (typeof pv === 'boolean') {
          cn.props[pk] = { type: 'BOOLEAN', value: pv }
        } else if (typeof pv === 'bigint') {
          cn.props[pk] = { type: 'BIGINT', value: pv }
        }
      }
    }
  }

  // ── Fallback: 如果 parseQuery 后 returnColumns 为空但有 RETURN 子句 ──
  // ANTLR 可能无法解析某些函数调用（如 type(r) AS alias），用正则提取
  if (!plan.returnColumns?.length && !plan.aggregate) {
    // Locate the main RETURN (skip RETURN inside `exists { ... }` subqueries).
    const mainRetIdx = _findMainReturnIndex(query)
    const returnClause = mainRetIdx >= 0
      ? query.slice(mainRetIdx).match(/^\s*(.+?)(?:\s+(ORDER|SKIP|LIMIT|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|FOREACH|CALL|SHOW)\s|$)/is)
      : null
    if (returnClause) {       const expr = returnClause[1].trim()
      // RETURN * → 保持空列（留给 _formatResultRow 的特殊处理）
      if (expr === '*') {
        // 保持 returnColumns = []（表示"所有变量"）
      } else {
        // 尝试拆分逗号分隔的列定义
        const cols = expr.split(',').map(c => c.trim()).filter(Boolean)
        if (cols.length) {
          plan.returnColumns = cols.map(c => {
            // labels(node) AS l → l（取 AS 后的别名，保留表达式到 returnAliasMap）
            const asMatch = c.match(/\bAS\s+(\w+)\s*$/i)
            if (asMatch) {
              plan.returnAliasMap = plan.returnAliasMap || {}
              plan.returnAliasMap[asMatch[1]] = c.replace(/\s+AS\s+\w+\s*$/i, '').trim()
              return asMatch[1]
            }
            return c
          })
          if (!plan.returnAliasMap || Object.keys(plan.returnAliasMap).length === 0) {
            plan.returnAliasMap = {}
            for (const c of plan.returnColumns) plan.returnAliasMap[c] = c
          }
          // ANTLR failed to produce `ReturnItemContext` nodes for these columns
          // (nested function calls such as `collect(nodes(p))` trip it up), so
          // `expressionColumns` and `aggregate` were left unset.  Rebuild them
          // from the raw column text so aggregation + implicit grouping still
          // work: `RETURN collect(nodes(p)) AS paths, length(p) AS l ORDER BY l`
          // must fold on `collect` grouped by `l`.
          const AGG_FNS = new Set(['count','sum','avg','max','min','collect','stdev','stdevp'])
          const aggList: any[] = []
          const rebuiltExprCols: Array<{ expression: string; alias: string | null }> = []
          const implicitKeys: string[] = []
          for (const c of cols) {
            const asMatch = c.match(/^(.+?)\s+AS\s+(\w+)\s*$/i)
            const exprText = asMatch ? asMatch[1].trim() : c.trim()
            const alias = asMatch ? asMatch[2] : null
            rebuiltExprCols.push({ expression: exprText, alias })
            const aggMatch = exprText.match(/^(\w+)\(\s*(.+?)\s*\)$/i)
            if (aggMatch && AGG_FNS.has(aggMatch[1].toLowerCase())) {
              const distinctMatch = exprText.match(/^\w+\(\s*(DISTINCT\s+)?(.+?)\s*\)$/i)
              aggList.push({
                function: aggMatch[1].toLowerCase(),
                column: exprText,
                type: aggMatch[1].toLowerCase(),
                alias: alias || '',
                field: distinctMatch ? distinctMatch[2] : aggMatch[2],
                distinct: distinctMatch ? !!distinctMatch[1] : undefined,
              })
            } else if (alias) {
              // Non-aggregate aliased column → implicit grouping key.
              implicitKeys.push(alias)
            }
          }
          if (aggList.length) {
            plan.aggregate = aggList[0]
            plan.aggregates = aggList
            if (!plan.groupBy && implicitKeys.length) plan.groupBy = implicitKeys
          }
          plan.expressionColumns = rebuiltExprCols
        }
      }
    }
  }

  // 检测无效查询：parseCypherToPlan 成功返回但查询语法非法（ANTLR Error被吞掉了）
  // 特征: scanLabel=null, steps=[], filters=[], returnColumns=[], hasMatch=false
  if (!plan.scanLabel && plan.steps?.length === 0 && plan.filters?.length === 0 && plan.returnColumns?.length === 0 && !plan.hasMatch && !plan.create && !plan.show && !plan.with && !plan.unwind && !plan.unwinds?.length && !plan.unionType && !plan.caseColumns?.length && !plan.loadCsv) {
    // 检查原始查询是否包含有效关键字 — 大多数无效查询没有 MATCH etc.
    if (!/^\s*(MATCH|WITH|UNWIND|RETURN|CREATE|MERGE|SET|DELETE|REMOVE|FOREACH|CALL|SHOW|USE|BEGIN|COMMIT|ROLLBACK|EXPLAIN|PROFILE|LOAD|DROP|START|OPTIONAL|ALTER|GRANT|REVOKE)/i.test(query.trim())) {
      throw new Error(`Query parse error: cannot parse query "${query}"`)
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
      // Extract `field` (the aggregate's value expression) from `column`:
      // "sum(n.age) AS totalAge" → "n.age"; "count(*)" → "*"; "count(DISTINCT r)"
      // → "r".  When the aggregate call is wrapped in an outer expression
      // (`count(a) > 0`, `count(a) + 3`), the whole column is NOT a pure call,
      // so extract the argument with a non-anchored match and leave the outer
      // tail (`> 0`) to be applied by the expression-evaluation path.
      const colMatch = agg.column.match(/^\w+\(\s*(?:DISTINCT\s+)?(.+?)\s*\)(?:\s+AS\s+\w+)?$/i)
      const argMatch = agg.column.match(/^\w+\(\s*(?:DISTINCT\s+)?(.+?)\s*\)/)
      agg.field = colMatch ? colMatch[1] : (argMatch ? argMatch[1] : (agg.column || '*'))
    }
    // GE 兼容：把 column 中的函数名也设为 alias（GE 用 alias 做 props key）
    // count(*) → alias = 'count'，sum(n.age) → alias = 'sum'
    // Only bind the alias to the function name when the column's leading call
    // is the aggregate itself (a *pure* aggregate call).  A nested aggregate
    // (`size(collect(a))`) starts with the outer function `size`, whose name is
    // NOT the aggregate's alias — leaving `size` as the alias would corrupt the
    // result key and skip the outer-expression application, so the alias is left
    // undefined and the executor derives it from the full column text.
    if (!agg.alias && agg.column) {
      const fnMatch = agg.column.match(/^(\w+)\(/i)
      if (fnMatch && fnMatch[1].toLowerCase() === String(agg.function).toLowerCase()) {
        agg.alias = fnMatch[1]
      }
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
  // ── Fallback: 如果 ANTLR 没有解析出 WITH columns（空数组），从 query 文本提取 ──
  // ANTLR 对 `tail(nodes(p)) AS nodes` 等函数调用+AS 别名的解析失败时，
  // plan.with.columns 为空但 plan.returnAliasMap 不为空。
  // 需要从 WITH 子句文本填充表情表达式。
  // A list comprehension (`[x IN collect(p) | head(nodes(x))] AS p`) also trips
  // ANTLR (`no viable alternative at input '[x IN ...'`), leaving a truncated
  // `["[x"]` column — detect an unbalanced `[` opening and re-extract from text.
  const _hasListComprehension = (q: string): boolean => /\[\s*\w+\s+IN\b[^\]]*\|\s*/.test(q)
  const _withColumnsTruncated = (cols?: Array<{ expression: unknown }>): boolean =>
    !!cols && cols.length > 0 && cols.some(c => {
      const e = typeof c.expression === 'string' ? c.expression.trim() : ''
      return e.startsWith('[') && !e.endsWith(']')
    })
  const shouldRebuildWith = plan.with && Array.isArray(plan.with.columns) &&
    (plan.with.columns.length === 0 || (_hasListComprehension(query) && _withColumnsTruncated(plan.with.columns)))
  if (shouldRebuildWith && query) {
    const withMatch = query.match(/WITH\s+(.+?)(?:\s+(RETURN|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|FOREACH|CALL|SHOW|WITH|OPTIONAL|MATCH|ORDER|SKIP|LIMIT|WHERE)\s|$)/is)
    if (withMatch) {
      const withBody = withMatch[1].trim()
      // 按逗号分割 WITH 列（括号/引号感知，list comprehension 的 `|` / `IN`
      // 位于 `[]` 内不会误切分）
      const colParts = _splitWithColumns(withBody)
      // Rebuild from scratch only when the ANTLR columns were truncated (or
      // empty); otherwise keep the authoritative ANTLR result.
      if (plan.with.columns.length === 0 || _withColumnsTruncated(plan.with.columns)) {
        plan.with.columns.length = 0
        for (const part of colParts) {
          // AS 别名：tail(nodes(p)) AS nodes → expression="tail(nodes(p))", alias="nodes"
          const asMatch = part.match(/^(.+?)\s+AS\s+(\w+)$/i)
          if (asMatch) {
            plan.with.columns.push({
              expression: asMatch[1].trim(),
              alias: asMatch[2],
            })
          } else {
            // 无 AS 别名：直接作为表达式
            plan.with.columns.push({
              expression: part,
              alias: null,
            })
          }
        }
      }
    }
  }

  // WITH 列表达式：字符串字面量转为 AST 对象（GE 的 _executeWithClause 期望 AST）
  if (plan.with?.columns) {
    for (const col of plan.with.columns) {
      if (typeof col.expression === 'string') {
        const expr = col.expression.trim()
        // A list comprehension (`[x IN collect(p) | head(nodes(x))]`) or a
        // pattern comprehension (`[p = (a)-[*]->(b) | p]`) is NOT a plain list
        // literal — keep it as raw expression text so the expression engine
        // materialises per-row and folds/quantifies itself, rather than
        // converting the `... | ...` body into a bogus single-string LIST item.
        // Both carry the `|` separator; a plain list literal never does.
        if (expr.includes('|')) {
          continue
        }
        // 列表字面量 [1,2] or [a, 1]
        if (expr.startsWith('[') && expr.endsWith(']')) {
          try {
            const items = JSON.parse(expr.replace(/'/g, '"'))
            col.expression = { type: 'LIST', items: items.map((v: any) => {
              if (typeof v === 'number') return { type: 'NUMBER', value: v }
              if (typeof v === 'string') return { type: 'STRING', value: v }
              return v
            })}
          } catch {
            // JSON parse failed — likely contains identifiers like [a, 1]
            // Parse items manually
            const inner = expr.slice(1, -1).trim()
            const items: Array<{ type: string; name?: string; value?: unknown }> = []
            const parts = _parseCommaList(inner)
            for (const part of parts) {
              const item = part.trim()
              if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(item)) {
                items.push({ type: 'NUMBER', value: parseFloat(item) })
              } else if ((item.startsWith("'") && item.endsWith("'")) || (item.startsWith('"') && item.endsWith('"'))) {
                items.push({ type: 'STRING', value: item.slice(1, -1) })
              } else if (/^(?:true|false)$/i.test(item)) {
                items.push({ type: 'BOOLEAN', value: item.toLowerCase() === 'true' })
              } else if (/^\{/.test(item)) {
                // map 字面量：保留原始字符串，让执行时解析
                items.push({ type: 'STRING', value: item })
              } else if (/^[a-zA-Z_]\w*$/.test(item)) {
                items.push({ type: 'IDENTIFIER', name: item })
              } else {
                items.push({ type: 'STRING', value: item })
              }
            }
            col.expression = { type: 'LIST', items }
          }
        }
      }
    }
  }

  // ── Detect aggregate functions in WITH/RETURN columns and synthesize plan.aggregate ──
  // ANTLR does not set plan.aggregate when aggregation is in WITH or RETURN.
  // Only match actual aggregate functions — non-aggregate function expressions like
  // date(), datetime(), coalesce(), etc. must not set plan.aggregate.
  // Only match pure aggregate functions (not nested inside list comprehensions).
  if (!plan.aggregate) {
    const AGG_FNS = new Set(['count','sum','avg','max','min','collect','stdev','stdevp','percentilecont','percentiledisc'])
    // Detect the aggregate from the RETURN columns first.  `plan.aggregate`
    // describes the *RETURN* aggregate, so a WITH aggregate (`WITH count(*) AS
    // count RETURN count > 0 AS nonEmpty`) must NOT be promoted onto it — that
    // was previously picked up via `plan.with.columns` and turned the RETURN
    // expression into a bogus `count(*)`, dropping `count > 0 AS nonEmpty`.
    // Only fall back to `plan.with.columns` when the RETURN carried no columns
    // (ANTLR dropped them), never when the RETURN already projected its own.
    const columns = (plan.expressionColumns?.length ? plan.expressionColumns : (plan.with?.columns?.length ? plan.with.columns : []))
    const aggregated: any[] = []
    for (const col of columns) {
      const expr = typeof col.expression === 'string' ? col.expression : (col.expression?.expression || '')
      // Exclude list comprehensions: [x IN ... | expr]
      if ((expr as string).startsWith('[') && (expr as string).includes('IN') && (expr as string).includes('|')) continue
      const aggMatch = (expr as string).match(/^(\w+)\(\s*(.+?)\s*\)$/i)
      if (aggMatch && col.alias && AGG_FNS.has(aggMatch[1].toLowerCase())) {
        // Strip the DISTINCT modifier from the value expression and surface it
        // as a boolean so the graph engine applies unique-count semantics without
        // mis-parsing `DISTINCT n.name` as a property path.  Keep the full value
        // expression (including the percentile scalar argument) in `field` — the
        // graph engine splits `percentileCont(x, 0.5)` itself.
        const distinctMatch = (expr as string).match(/^\w+\(\s*(DISTINCT\s+)?(.+?)\s*\)$/i)
        const aggClause = {
          function: aggMatch[1].toLowerCase(),
          column: expr,
          type: aggMatch[1].toLowerCase(),
          alias: col.alias || '',
          field: distinctMatch ? distinctMatch[2] : aggMatch[2],
          distinct: distinctMatch ? !!distinctMatch[1] : undefined,
        }
        aggregated.push(aggClause)
      }
    }
    if (aggregated.length) {
      plan.aggregate = aggregated[0]
      plan.aggregates = aggregated
      // Implicit GROUP BY: in `RETURN a.name, count(*)` the non-aggregate
      // column `a.name` is an implicit grouping key.  ANTLR only sets
      // plan.groupBy for an explicit `GROUP BY` clause, so harvest the
      // remaining non-aggregate columns here (only when no explicit GROUP BY
      // was parsed — i.e. plan.groupBy is still unset).  Each key is stripped
      // of its `var.` prefix to match the explicit-GROUP-BY shape (`name`).
      if (!plan.groupBy) {
        const implicitKeys: string[] = []
        for (const c of columns) {
          const cExpr = typeof c.expression === 'string' ? c.expression : (c.expression?.expression || '')
          if (!cExpr) continue
          // Skip the aggregate column itself and any other aggregate call.
          if (_parseAggregate(cExpr)) continue
          // Skip list comprehensions (not a scalar grouping key).
          if (cExpr.startsWith('[') && cExpr.includes('IN') && cExpr.includes('|')) continue
          // Prefer the column alias (e.g. `a.num2 % 3 AS mod` → `mod`) so the
          // executor's group-by lookup can match the projected alias.  A bare
          // expression key (`num2 % 3`) otherwise fails to resolve against the
          // alias-only expressionColumns and collapses every row into one group.
          const key = (c.alias && typeof c.alias === 'string' && c.alias.length)
            ? c.alias
            : (cExpr.includes('.') ? cExpr.split('.').pop()! : cExpr)
          if (key && !implicitKeys.includes(key)) implicitKeys.push(key)
        }
        if (implicitKeys.length) plan.groupBy = implicitKeys
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

  // ── WHERE 子句解析（补充标签谓词——ANTLR 不处理 a:Employee 格式） ──
  // ANTLR 已经处理了属性过滤器（n.name = 'Bob'），但标签谓词 a:Employee 不是 FilterClause
  // 我们的 _parseWhereClause 只需处理 labelFilterItems
  if (plan.hasMatch && query?.includes('WHERE')) {
    const whereText = extractWhereBody(query)
    if (whereText) {
      plan.whereBody = whereText
      _parseLabelFilterOnly(whereText, plan)
    }
  }

  // ── UNWIND name 修复 ──
  // ANTLR 适配器可能将 UNWIND expr 中出现的变量名（如 size(types) 中的 types）
  // 误作为 UNWIND name，而非 AS 后的真正变量名。
  // 同时，双 UNWIND 场景下第二个 UNWIND 可能丢失。
  if (plan.unwind && plan.hasMatch && query) {
    try {
      const unwindMatches = [...query.matchAll(/UNWIND\s+(.+?)\s+AS\s+(\w+)/gis)]
      for (const [umIdx, m] of unwindMatches.entries()) {
        if (umIdx === 0) {
          if (m[2] && m[2] !== plan.unwind.name) {
            plan.unwind.name = m[2]
          }
        } else if (umIdx === 1) {
          plan.secondUnwind = {
            list: [],
            name: m[2],
            var: m[1].trim(),
          }
        }
      }
      // 同步修复 plan.unwinds 数组中的 name
      if (plan.unwinds?.length) {
        for (const [umIdx, m] of unwindMatches.entries()) {
          if (umIdx < plan.unwinds.length && m[2] && m[2] !== plan.unwinds[umIdx].name) {
            plan.unwinds[umIdx].name = m[2]
          }
        }
      }
    } catch (e) {
      // ignore parse errors
    }
  }

  return plan
}

/** 从 Cypher 查询中提取 WHERE 子句的文本体 */
function extractWhereBody(query: string): string | null {
  return _extractWhereBodyBraceAware(query)
}

/**
 * Locate the index just after the main (outermost) `RETURN` keyword, skipping
 * any `RETURN` that appears inside an `exists { ... }` subquery block.
 *
 *   MATCH (n) WHERE exists { MATCH (n)-->() RETURN true } RETURN n
 *   ──────────────────────────────────────────────────┴─────── main RETURN here
 */
function _findMainReturnIndex(query: string): number {
  let braceDepth = 0
  let parenDepth = 0
  let inStr = false
  let strChar = ''
  const n = query.length
  for (let i = 0; i < n; i++) {
    const c = query[i]
    if (inStr) { if (c === '\\') { i++; continue } if (c === strChar) inStr = false; continue }
    if (c === "'" || c === '"') { inStr = true; strChar = c; continue }
    if (c === '{') { braceDepth++; continue }
    if (c === '}') { if (braceDepth > 0) braceDepth--; continue }
    if (c === '(') { parenDepth++; continue }
    if (c === ')') { if (parenDepth > 0) parenDepth--; continue }
    if (braceDepth === 0 && parenDepth === 0) {
      const rest = query.slice(i)
      if (/^RETURN\b/i.test(rest)) {
        return i + 6 // index just past `RETURN`
      }
    }
  }
  return -1
}

/**
 * Extract the WHERE body while honoring `exists { ... }` subquery blocks.
 *
 * A naive `WHERE ... RETURN` regex terminates the WHERE body at the first
 * `RETURN`/`SET`/`WITH` keyword, but an existential subquery embeds those
 * keywords inside its own braces:
 *
 *   MATCH (n) WHERE exists { MATCH (n)-->() RETURN true } RETURN n
 *
 * The inner `RETURN true` must NOT terminate the outer WHERE body. This scanner
 * walks the query tracking brace depth (both `{}` for subqueries and `()` for
 * nested grouping/pattern predicates); a clause-terminating keyword only ends
 * the WHERE body when encountered at top-level (brace depth 0).
 */
function _extractWhereBodyBraceAware(query: string): string | null {
  const qi = query.search(/WHERE\b/i)
  if (qi < 0) return null
  let i = qi + 5 // skip "WHERE"
  let braceDepth = 0
  let parenDepth = 0
  let inStr = false
  let strChar = ''
  const n = query.length
  const start = i
  let end = n
  for (; i < n; i++) {
    const c = query[i]
    if (inStr) {
      if (c === '\\') { i++; continue }
      if (c === strChar) inStr = false
      continue
    }
    if (c === "'" || c === '"') { inStr = true; strChar = c; continue }
    if (c === '{') { braceDepth++; continue }
    if (c === '}') { if (braceDepth > 0) braceDepth--; continue }
    if (c === '(') { parenDepth++; continue }
    if (c === ')') { if (parenDepth > 0) parenDepth--; continue }
    // Only a clause terminator reached at top level (outside any brace or
    // parenthesis group) ends the WHERE body.
    if (braceDepth === 0 && parenDepth === 0) {
      const rest = query.slice(i)
      if (/^(?:RETURN|WITH|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|ORDER\s+BY|SKIP|LIMIT|CALL|YIELD|UNION|MATCH|OPTIONAL\s+MATCH)\b/i.test(rest.trimStart())) {
        end = i
        break
      }
    }
  }
  const body = query.slice(start, end).trim()
  return body || null
}

/**
 * 解析 WHERE 子句中变量名对应的节点在 allNodes 中的索引。
 * 变量可能是 scanLabel 节点或 steps 中的 source/targetAlias 节点。
 */
function resolveVariableNodeIdx(variable: string, plan: QueryPlan, allNodes: Record<string, unknown>[]): number {
  // 如果是 steps 中的 source 变量，索引 0（起始节点）
  if (plan.steps?.length && plan.steps[0].source === variable) return 0
  // 如果是 steps 中的 targetAlias，索引 1（第一跳目标）
  if (plan.steps?.length && plan.steps[0].targetAlias === variable) return 1
  // 如果是多跳（steps.length > 1），查找准确索引
  for (let i = 0; i < (plan.steps || []).length; i++) {
    if (plan.steps[i].targetAlias === variable) return i + 1
  }
  return -1
}

/**
 * 从 WHERE 子句文本提取标签谓词（ANTLR 不处理的 a:Employee 格式）
 */
function _parseLabelFilterOnly(whereText: string, plan: QueryPlan): void {
  const topLevel = splitByAndOr(whereText, 'AND')
  const labelItems: Array<{ variable: string; label: string; exclude: boolean }> = []

  for (const condition of topLevel) {
    const c = condition.trim()

    // a:Employee 或 a:!Employee 标签谓词
    const labelMatch = c.match(/^(\w+)\s*:\s*(!?\w+)$/)
    if (labelMatch) {
      const variable = labelMatch[1]
      const label = labelMatch[2].replace(/^!/, '')
      const exclude = labelMatch[2].startsWith('!')
      labelItems.push({ variable, label, exclude })
      continue
    }

    // NOT a:Excluded
    const notLabelMatch = c.match(/^NOT\s+(\w+)\s*:\s*(\w+)$/)
    if (notLabelMatch) {
      labelItems.push({ variable: notLabelMatch[1], label: notLabelMatch[2], exclude: true })
      continue
    }
  }

  if (labelItems.length) {
    (plan as any).labelFilterItems = labelItems.map(li => ({
      variable: li.variable,
      label: li.label,
      exclude: li.exclude,
    }))
  }
}

/** 按 AND 或 OR 分割顶层条件（不处理括号嵌套） */
function splitByAndOr(text: string, op: 'AND' | 'OR'): string[] {
  // 简单分割，不处理括号中的 AND/OR
  const parts: string[] = []
  let depth = 0
  let current = ''
  const ops = ['AND', 'OR']
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(' || ch === '[') { depth++; current += ch; continue }
    if (ch === ')' || ch === ']') { depth--; current += ch; continue }
    if (ch === "'" || ch === '"') {
      // 跳过字符串字面量
      const quote = ch
      current += quote
      i++
      while (i < text.length && text[i] !== quote) { current += text[i]; i++ }
      if (i < text.length) current += text[i]
      continue
    }
    if (depth === 0) {
      // 检查是否有操作符
      const rest = text.substring(i)
      let matched = false
      for (const o of ops) {
        if (rest.startsWith(o) && (rest.length === o.length || /\s/.test(rest[o.length]) || i + o.length >= text.length)) {
          if (current.trim()) parts.push(current.trim())
          current = ''
          i += o.length - 1
          matched = true
          break
        }
      }
      if (matched) continue
    }
    current += ch
  }
  if (current.trim()) parts.push(current.trim())
  return parts.length ? parts : [text]
}

/** 将字符串值解析为字面量（数字、字符串、布尔、null） */
function parseLiteralValue(val: string): unknown {
  const trimmed = val.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  if (/^[+-]?\d+\.?\d*$/.test(trimmed)) return Number(trimmed)
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
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


/** 多步遍历：从 startIdx 节点开始，沿 plan.steps 逐跳导航到最终节点。
 * 每一步使用 __edges 来查找邻居节点。匹配标签/方向/属性约束。
 * 返回所有可达的最终节点索引列表。
 */
function _walkMultiSteps(
  startIdx: number, steps: TraverseStep[], allNodes: Record<string, unknown>[],
  skipNodeIndices?: Set<number>,
  planFilters?: Array<{source?: string; property: string; value: any}>,
  stepSourceFilters?: Array<{source?: string; property: string; value: any}>
): number[][] {
  return _walkMultiStepsWithEdges(startIdx, steps, allNodes, skipNodeIndices, planFilters, stepSourceFilters).map(p => p.ns)
}

// Edge-aware variant of `_walkMultiSteps`.  Returns, for each matched path, the
// node-index sequence *and* the sequence of consumed relationship ids.  The
// edge sequence is required to render named paths that revisit a node via a
// *different* relationship (e.g. `MATCH p=(n)<-->(k)<-->(n)` on a→b / b→a),
// where two distinct paths share the same node sequence but differ in edges.
export function _walkMultiStepsWithEdges(
  startIdx: number, steps: TraverseStep[], allNodes: Record<string, unknown>[],
  skipNodeIndices?: Set<number>,
  planFilters?: Array<{source?: string; property: string; value: any}>,
  stepSourceFilters?: Array<{source?: string; property: string; value: any}>
): Array<{ ns: number[]; es: Array<{ srcIdx: number; dstIdx: number; label: string }> }> {
  // Build a global edge registry.  A relationship's identity is its *source
  // ownership* plus its occurrence number among the parallel relationships the
  // same source node emits toward the same (dstIdx, label).  This is what trail
  // semantics needs:
  //
  //   * The two physical copies of one relationship (a single-statement CREATE
  //     attaches it to BOTH endpoints) share the same (srcIdx, dstIdx, label,
  //     occurrence), so they collapse into one id — the relation is never
  //     re-traversed via its second copy.
  //   * Two genuinely parallel relationships between the same pair are distinct
  //     entries in the source node's `__edges` and get different occurrences,
  //     hence different ids — an undirected `-[:R*3..3]-` walk may traverse both
  //     in turn (e.g. `mid -> other -> mid`) without reusing a relationship.
  //
  // Pre-scan assigns ids deterministically (source-owned entries in array order
  // are occurrence 0,1,2,…).  A target-node copy (srcIdx !== its node index) is
  // resolved to the source node's occurrence-0 id, which is correct because the
  // two-endpoint path de-duplicates parallel edges (see `pushDedup` in the TCK
  // step definitions) whereas the source-only path never emits target copies.
  type _EdgeRef = { srcIdx: number; dstIdx: number; label: string }
  const edgeIdByObj = new WeakMap<object, number>()
  const edgeRefById = new Map<number, _EdgeRef>()
  let _eid = 0
  // "srcIdx|dstIdx|label|occurrence" → id
  const idByOwnedKey = new Map<string, number>()
  const _ownedKey = (srcIdx: number, dstIdx: number, label: string, occ: number) =>
    `${srcIdx}|${dstIdx}|${label}|${occ}`
  for (let ni = 0; ni < allNodes.length; ni++) {
    const es = (allNodes[ni] as any)?.__edges
    if (!Array.isArray(es)) continue
    const occByTarget = new Map<string, number>()
    for (const e of es) {
      if (e.srcIdx !== ni) continue // only number source-owned occurrences
      const t = `${e.dstIdx}|${e.label || ''}`
      const occ = occByTarget.get(t) ?? 0
      occByTarget.set(t, occ + 1)
      const key = _ownedKey(e.srcIdx, e.dstIdx, e.label || '', occ)
      if (!idByOwnedKey.has(key)) {
        const id = _eid++
        idByOwnedKey.set(key, id)
        edgeRefById.set(id, { srcIdx: e.srcIdx, dstIdx: e.dstIdx, label: e.label || '' })
      }
      edgeIdByObj.set(e, idByOwnedKey.get(key)!)
    }
  }
  // Resolve target-node copies (same triple, srcIdx !== node index) to the
  // source node's occurrence-0 id.
  for (let ni = 0; ni < allNodes.length; ni++) {
    const es = (allNodes[ni] as any)?.__edges
    if (!Array.isArray(es)) continue
    for (const e of es) {
      if (e.srcIdx === ni) continue // already owned
      const key0 = _ownedKey(e.srcIdx, e.dstIdx, e.label || '', 0)
      if (idByOwnedKey.has(key0) && !edgeIdByObj.has(e)) {
        edgeIdByObj.set(e, idByOwnedKey.get(key0)!)
      }
    }
  }
  const _edgeIdOf = (e: any): number => {
    let id = edgeIdByObj.get(e)
    if (id === undefined) {
      id = _eid++
      edgeIdByObj.set(e, id)
      edgeRefById.set(id, { srcIdx: e.srcIdx, dstIdx: e.dstIdx, label: e.label || '' })
    }
    return id
  }

  // Internal path shape carries the node sequence, the ids of the relationships
  // consumed so far (for the edge-reuse guard), and — for callers that bind
  // per-step edge variables over a mixed fixed/variable-length chain — the
  // number of hops each step consumed (`hopCounts[i]`).  A variable-length step
  // may consume 0..N hops, so its hop count is data-dependent and this array is
  // what lets a caller locate the exact hop(s) belonging to a later step.
  type _WalkPath = { ns: number[]; es: number[]; hopCounts: number[] }
  let paths: _WalkPath[] = [{ ns: [startIdx], es: [], hopCounts: [] }]

  // Chain closure.  A variable that re-appears later in the same pattern (the
  // `a` in `(a)-[:A]->()-[:B]->(a)`, or `n` in `(n)<-->(k)<-->(n)`) must bind
  // the SAME node it first bound.  `varFirstPos` maps a variable name to the
  // path position of its first occurrence; a step whose target alias has an
  // earlier occurrence is a closure step and must land on that earlier node.
  // This intentionally does NOT forbid distinct variables from binding the same
  // node — openCypher enforces relationship (not node) isomorphism, so a
  // self-loop `(l)-[:LOOP]->(l)` legitimately binds two variables to one node.
  // `varFirstPos` maps a variable name to the path position (node offset) of
  // its first occurrence.  Positions are only meaningful when every step is
  // fixed-length (one hop): a variable-length step (`*`) advances by a data-
  // dependent number of nodes, so a `si + 1` offset would mislabel later
  // variables as closures.  When any step carries a `range`, chain closure is
  // disabled — the rare `(a)-[*..]->(a)` closure is handled independently.
  const hasAnyRange = steps.some((s: any) => (s as any).range != null)
  const varFirstPos = new Map<string, number>()
  if (!hasAnyRange) {
    if (steps.length) {
      const src0 = (steps[0] as any).source as string | undefined
      if (src0) varFirstPos.set(src0, 0)
    }
    for (let si = 0; si < steps.length; si++) {
      const ta = (steps[si] as any).targetAlias as string | undefined
      if (ta && !varFirstPos.has(ta)) varFirstPos.set(ta, si + 1)
    }
  }

  // A node reference is reachable through an edge in the given direction.
  const _edgeNeighbor = (e: any, from: number, dir: string): number => {
    if (dir === 'any') {
      return e.dstIdx === from ? e.srcIdx : (e.srcIdx === from ? e.dstIdx : -1)
    }
    if (dir === 'out') return e.srcIdx === from ? e.dstIdx : -1
    if (dir === 'in') return e.dstIdx === from ? e.srcIdx : -1
    return -1
  }

  // An edge satisfies an inline property map (e.g. `-[r {name:'r1'}]->`) when
  // every declared property matches the edge's own props.  edges without the
  // property (or with a differing value) are rejected here so the walk never
  // over-enumerates neighbours — previously edgeProps was only applied AFTER the
  // full walk, which left spurious undirected rows.
  const _edgePropsMatch = (e: any, eps: Record<string, unknown> | undefined | null): boolean => {
    if (!eps || Object.keys(eps).length === 0) return true
    const ep = e?.props || {}
    for (const [k, v] of Object.entries(eps)) {
      if (String(ep[k]) !== String(v)) return false
    }
    return true
  }

  for (let si = 0; si < steps.length; si++) {
    const step = steps[si]
    // ── 变量长度路径：step.range 存在时做 BFS 多跳 ──
    if ((step as any).range) {
      const range = (step as any).range
      // `range.min` defaults to 1 (a bare `*`).  An unbounded upper bound is
      // `null`; since trails never revisit an edge, the longest simple trail has
      // at most `allNodes.length - 1` edges, so that is a sound finite bound
      // when no explicit maximum was given.
      const minHops = Number.isFinite(range.min) ? range.min : 1
      const maxHops = Number.isFinite(range.max) ? range.max : allNodes.length
      const hasEdgeLabel = !!(step as any).edgeLabel
      const newPaths: _WalkPath[] = []
      for (const p of paths) {
        const sidx = p.ns[p.ns.length - 1]
        // BFS over edges starting at sidx.  Each frontier entry carries the full
        // node/edge sequence so the variable-length hop preserves interior nodes
        // and the consumed relationship ids (for later relationship-isomorphism
        // rejection).  A zero-length hop keeps the prefix unchanged.
        type _Front = { ns: number[]; es: number[] }
        let fronts: _Front[] = [{ ns: [...p.ns], es: [...p.es] }]
        const reached: _Front[] = []
        if (minHops === 0) reached.push({ ns: [...p.ns], es: [...p.es] })
        for (let depth = 1; depth <= maxHops; depth++) {
          const next: _Front[] = []
          for (const f of fronts) {
            const cur = f.ns[f.ns.length - 1]
            const curNode = allNodes[cur] as any
            const isAny = step.direction === 'any'
            const candidates: Array<{ nIdx: number; eId: number }> = []
            const outgoingTriples = new Set<string>()
            for (const e of (curNode?.__edges || [])) {
              const neighborIdx = _edgeNeighbor(e, cur, step.direction)
              if (neighborIdx < 0 || neighborIdx >= allNodes.length) continue
              if (hasEdgeLabel && e.label !== step.edgeLabel) continue
              if (!_edgePropsMatch(e, (step as any).edgeProps)) continue
              outgoingTriples.add(`${e.srcIdx}|${e.dstIdx}|${e.label || ''}`)
              candidates.push({ nIdx: neighborIdx, eId: _edgeIdOf(e) })
            }
            if (isAny) {
              for (let j = 0; j < allNodes.length; j++) {
                if (j === cur) continue
                const other = allNodes[j] as any
                if (!other?.__edges) continue
                for (const e of other.__edges) {
                  const neighborIdx = _edgeNeighbor(e, cur, 'any')
                  if (neighborIdx < 0 || neighborIdx >= allNodes.length) continue
                  if (hasEdgeLabel && e.label !== step.edgeLabel) continue
                  if (!_edgePropsMatch(e, (step as any).edgeProps)) continue
                  if (outgoingTriples.has(`${e.srcIdx}|${e.dstIdx}|${e.label || ''}`)) continue
                  candidates.push({ nIdx: neighborIdx, eId: _edgeIdOf(e) })
                }
              }
            }
            for (const c of candidates) {
              if (f.es.includes(c.eId)) continue
              next.push({ ns: [...f.ns, c.nIdx], es: [...f.es, c.eId] })
            }
          }
          fronts = next
          if (fronts.length === 0) break
          if (depth >= minHops) {
            for (const f of fronts) {
              // The variable-length endpoint must satisfy the step's target
              // label/property constraints (e.g. `(a)-[:T*2]->(:End)`).
              if (_stepMatchConstraint(f.ns[f.ns.length - 1], step, allNodes)) {
                reached.push(f)
              }
            }
          }
        }
        // Preserve the accumulated prefix and append each reached path.  The
        // zero-hop entry (reached[0]) keeps the prefix node sequence untouched.
        // Record the hop count this variable-length step consumed (es grew by
        // `f.es.length - p.es.length`), so callers can locate later steps' hops.
        for (const f of reached) {
          newPaths.push({ ns: f.ns, es: f.es, hopCounts: [...p.hopCounts, f.es.length - p.es.length] })
        }
      }
      paths = newPaths.length > 0 ? newPaths : []
      continue
    }
    const nextSet = new Set<number>()
    // 构建 combinedSourceFilters：当前步的 source 节点属性约束
    // 排除 ANTLR 链式比较解析失败的值（包含比较运算符的字符串值）
    const _isBrokenFilterValue = (v: any): boolean =>
      typeof v === 'string' && /[<>=]/.test(v)
    // A cross-variable reference (`n.animal = x.animal`) has a `value` that names
    // another variable's property; it cannot be applied as a constant source
    // predicate during the walk (it must be resolved after both nodes bind).
    const _isVarRefValue = (v: any): boolean =>
      typeof v === 'string' && /^\w+\.\w+$/.test(v) && !/^['"]/.test(v) && !/^\d/.test(v)
    const combinedSourceFilters: Array<{source?: string; property: string; value: any}> = []
    if (planFilters?.length) {
      for (const f of planFilters) {
        if (_isBrokenFilterValue(f.value)) continue
        if (_isVarRefValue(f.value)) continue
        if (f.source === step.source) combinedSourceFilters.push(f)
      }
    }
    if (stepSourceFilters?.length) {
      for (const f of stepSourceFilters) {
        if (_isBrokenFilterValue(f.value)) continue
        if (_isVarRefValue(f.value)) continue
        if (f.source === step.source) combinedSourceFilters.push(f)
      }
    }
    if (stepSourceFilters?.length) {
      for (const f of stepSourceFilters) {
        if (_isBrokenFilterValue(f.value)) continue
        if (f.source === step.source) combinedSourceFilters.push(f)
      }
    }
    // 在边遍历前应用 source filter：从 currentSet 中移除不满足 source 约束的节点
    if (combinedSourceFilters.length > 0) {
      const curEnds = new Set<number>(paths.map(p => p.ns[p.ns.length - 1]))
      for (const idx of [...curEnds]) {
        const fn = allNodes[idx]
        if (!fn) continue
        let passes = true
        for (const rf of combinedSourceFilters) {
          if (fn[rf.property] === undefined) {
            passes = false
            break
          }
          const actualStr = String(fn[rf.property])
          const filterStr = String(rf.value)
          if (actualStr !== filterStr) {
            if (/^\d+$/.test(actualStr) && /^-?\d+$/.test(filterStr)) {
              try {
                const actualBig = BigInt(actualStr)
                const filterBig = BigInt(filterStr)
                if (actualBig !== filterBig) { passes = false; break }
              } catch {
                passes = false; break
              }
            } else {
              passes = false; break
            }
          }
        }
        if (!passes) {
          paths = paths.filter(p => p.ns[p.ns.length - 1] !== idx)
        }
      }
      if (paths.length === 0) break
    }

    // Edge enumeration: for each current path front, gather every legal outgoing
    // edge (respecting direction, label, and target constraint), then extend the
    // path with that edge's id + neighbor node, rejecting only a *reused
    // relationship* (not a revisited node).
    const newPaths: _WalkPath[] = []
    for (const p of paths) {
      const last = p.ns[p.ns.length - 1]
      const lastNode = allNodes[last] as any
      const isAny = step.direction === 'any'
      const candidates: Array<{ nIdx: number; eId: number }> = []
      // Outgoing relationships: `last` is the source (e.srcIdx === last).  A
      // triple may appear multiple times here — those are parallel relationships
      // and each is a distinct candidate.
      const outgoingTriples = new Set<string>()
      for (const e of (lastNode?.__edges || [])) {
        const neighborIdx = _edgeNeighbor(e, last, step.direction)
        if (neighborIdx < 0 || neighborIdx >= allNodes.length) continue
        if (step.edgeLabel && !step.edgeLabel.split('|').includes(e.label)) continue
        if (!_edgePropsMatch(e, (step as any).edgeProps)) continue
        if (!_stepMatchConstraint(neighborIdx, step, allNodes)) continue
        outgoingTriples.add(`${e.srcIdx}|${e.dstIdx}|${e.label || ''}`)
        candidates.push({ nIdx: neighborIdx, eId: _edgeIdOf(e) })
      }
      // Incoming relationships (`in` / `any`): stored on other nodes, pointing
      // at `last`.  A relationship whose target is `last` may also be stored on
      // its source node (both endpoints); when its triple was already collected
      // in the outgoing pass it is the SAME relationship, so skip it to avoid a
      // duplicate candidate.  Parallel edges only ever live on their source
      // node, so this never wrongly merges them.
      if (step.direction === 'in' || isAny) {
        for (let j = 0; j < allNodes.length; j++) {
          if (j === last) continue
          const other = allNodes[j] as any
          if (!other?.__edges) continue
          for (const e of other.__edges) {
            const neighborIdx = _edgeNeighbor(e, last, step.direction)
            if (neighborIdx < 0 || neighborIdx >= allNodes.length) continue
            if (step.edgeLabel && !step.edgeLabel.split('|').includes(e.label)) continue
            if (!_edgePropsMatch(e, (step as any).edgeProps)) continue
            if (!_stepMatchConstraint(neighborIdx, step, allNodes)) continue
            if (outgoingTriples.has(`${e.srcIdx}|${e.dstIdx}|${e.label || ''}`)) continue
            candidates.push({ nIdx: neighborIdx, eId: _edgeIdOf(e) })
          }
        }
      }
      // Deduplicate identical relationships that the outgoing and incoming
      // enumeration both produce (belt-and-suspenders; the triple check above
      // already handles the two-endpoint case).
      const deduped: Array<{ nIdx: number; eId: number }> = []
      const seenEid = new Set<number>()
      for (const c of candidates) {
        if (seenEid.has(c.eId)) continue
        seenEid.add(c.eId)
        deduped.push(c)
      }
      for (const c of deduped) {
        // Relationship isomorphism: a step must not reuse a relationship already
        // traversed by this walk.  Revisiting a node via a *distinct* edge is
        // allowed (e.g. `MATCH p=(n)<-->(k)<-->(n)` on a→b / b→a).
        if (p.es.includes(c.eId)) continue
        // Chain closure: if this step's target alias first appeared at an
        // earlier path position (a re-used variable name), the landing node must
        // equal the node bound at that earlier position.
        const ta = (step as any).targetAlias as string | undefined
        if (ta && varFirstPos.has(ta)) {
          const firstPos = varFirstPos.get(ta)!
          if (firstPos <= p.ns.length - 1 && p.ns[firstPos] !== c.nIdx) continue
        }
        newPaths.push({ ns: [...p.ns, c.nIdx], es: [...p.es, c.eId], hopCounts: [...p.hopCounts, 1] })
      }
    }
    paths = newPaths
    if (paths.length === 0) break
  }

  // Resolve consumed relationship ids back to their (srcIdx, dstIdx, label)
  // descriptors so callers can rebuild edge objects with the correct label and
  // direction.  `hopCounts` (per-step hop counts) is forwarded unchanged.
  return paths.map(p => ({ ns: p.ns, es: p.es.map(id => edgeRefById.get(id) ?? { srcIdx: 0, dstIdx: 0, label: '' }), hopCounts: p.hopCounts }))
}

function _pathEndIndices(paths: number[][]): Set<number> {
  const ends = new Set<number>()
  for (const p of paths) ends.add(p[p.length - 1])
  return ends
}

/** 从路径数组中提取第一条路径（用于 _allVars 等需要完整路径的场景） */
/** 检查 step 对目标节点的约束 */
function _stepMatchConstraint(nodeIdx: number, step: TraverseStep, allNodes: Record<string, unknown>[]): boolean {
  const node = allNodes[nodeIdx]
  if (!node) return false
  // 标签约束
  // 检查 targetLabel 匹配（如果节点有多标签 __fullLabel，检查是否包含 targetLabel）
  if (step.targetLabel) {
    const fullLabel = (node as any).__fullLabel
    const labelStr = (typeof fullLabel === 'string' && fullLabel)
      ? fullLabel
      : (typeof node._label === 'string' ? node._label : '')
    // A node may carry multiple labels (`A:B:C`) while the step names one of
    // them (`targetLabel: 'C'`); match when the label is present among the
    // colon-separated set rather than requiring exact whole-string equality.
    if (!labelStr.split(':').includes(step.targetLabel)) return false
  }
  // 内联属性约束
  if (step.targetProps) {
    for (const [k, v] of Object.entries(step.targetProps)) {
      if (node[k] === undefined || String(node[k]) !== String(v)) return false
    }
  }
  return true
}

/**
 * 变量长度路径执行器：从 nodes 出发做 BFS，返回格式化结果。
 * 转发到独立模块 var-length-path.ts
 */

function _findWhereOutsideBrackets(text: string): number {
  let depth = 0, parenDepth = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[' && parenDepth === 0) depth++
    else if (text[i] === ']' && parenDepth === 0) depth = Math.max(0, depth - 1)
    else if (text[i] === '(') parenDepth++
    else if (text[i] === ')') parenDepth = Math.max(0, parenDepth - 1)
    else if (text.substring(i, i + 6).toLowerCase() === ' where' && depth === 0 && parenDepth === 0) {
      const before = i > 0 ? text[i - 1] : ' '
      const after = i + 6 < text.length ? text[i + 6] : ' '
      if (!/\w/.test(before) && !/\w/.test(after)) return i
    }
    else if (text.substring(i, i + 6).toLowerCase() === 'where ' && depth === 0 && parenDepth === 0) {
      const before = i > 0 ? text[i - 1] : ' '
      if (!/\w/.test(before)) return i
    }
  }
  return -1
}


export function _splitWithColumns(clauseBody: string): string[] {
  const columns: string[] = []
  let current = ''
  let depth = 0
  let inStr = false
  let strChar = ''
  for (let i = 0; i < clauseBody.length; i++) {
    const ch = clauseBody[i]
    if (inStr) {
      if (ch === '\\') { current += ch; i++; if (i < clauseBody.length) current += clauseBody[i]; continue }
      if (ch === strChar) inStr = false
      current += ch; continue
    }
    if (ch === "'" || ch === '"') { inStr = true; strChar = ch; current += ch; continue }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; current += ch; continue }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; current += ch; continue }
    if (depth === 0 && ch === ',') {
      const trimmed = current.trim()
      if (trimmed) columns.push(trimmed)
      current = ''
      continue
    }
    current += ch
  }
  const trimmed = current.trim()
  if (trimmed) columns.push(trimmed)
  return columns
}

/**
 * 从 UNWIND clause 解析列表值：
 * 1. plan.unwind.list 已填充（字面量列表）
 * 2. plan.unwind.var 是变量引用 → 从 varCtx 查找
 */
function _resolveUnwindList(unwind: NonNullable<QueryPlan['unwind']>, varCtx: Record<string, unknown>): unknown[] {
  if (Array.isArray(unwind.list) && unwind.list.length > 0) {
    // The parser stores UNWIND list elements as raw text when they are not
    // plain JSON (temporal literals like `date({year: 1910, ...})`, list
    // literals like `['a', 1]`, octal integers, etc.). Evaluate each string
    // element eagerly so the list resolves to real values before sorting /
    // projection. Non-string elements (already-parsed numbers/booleans) pass
    // through unchanged.
    return unwind.list.map((item: unknown) => {
      if (typeof item !== 'string') return item
      const evaluated = _evaluateExpression(item, varCtx)
      return evaluated === undefined ? item : evaluated
    })
  }
  if (unwind.var) {
    // 尝试变量引用
    if (varCtx[unwind.var] !== undefined) {
      const val = varCtx[unwind.var]
      if (Array.isArray(val)) return val
      return [val]
    }
    // 尝试表达式求值（如 split('one1two', '1') 等函数调用）
    const exprVal = _evaluateExpression(unwind.var, varCtx)
    if (Array.isArray(exprVal)) return exprVal
    if (exprVal != null) return [exprVal]
  }
  return []
}

/**
 * 从 query 中提取最后一个 UNWIND 之后的所有 WITH 子句列表（括号感知，跳过列表谓词内的 WHERE）。
 * 忽略最后一个 WITH 和 RETURN（由 plan.with.columns 处理）。
 */
function _extractWithClausesAfterUnwind(query: string, plan: any): string[] {
  const lastUnwindIdx = query.toLowerCase().lastIndexOf('unwind')
  if (lastUnwindIdx < 0) return []
  const afterLast = query.slice(lastUnwindIdx)
  const keywords = ['WITH', 'MATCH', 'RETURN', 'CREATE', 'MERGE', 'DELETE', 'SET', 'REMOVE', 'UNWIND', 'CALL']
  const kwPattern = new RegExp('\\b(?:' + keywords.join('|') + ')\\b', 'i')
  const parts: string[] = []
  let current = ''
  let depth = 0
  let inStr = false
  let strChar = ''
  for (let i = 0; i < afterLast.length; i++) {
    const ch = afterLast[i]
    if (inStr) {
      if (ch === '\\') { current += ch; i++; if (i < afterLast.length) current += afterLast[i]; continue }
      if (ch === strChar) inStr = false
      current += ch; continue
    }
    if (ch === "'" || ch === '"') { inStr = true; strChar = ch; current += ch; continue }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; current += ch; continue }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; current += ch; continue }
    if (depth === 0) {
      kwPattern.lastIndex = 0
      const m = kwPattern.exec(afterLast.slice(i))
      if (m && m.index === 0) {
        if (current.trim()) parts.push(current.trim())
        current = ''
      }
    }
    current += ch
  }
  if (current.trim()) parts.push(current.trim())
  // 只返回 WITH 子句（排除 UNWIND 和 RETURN）
  return parts.filter(p => /^WITH\s+/i.test(p))
}

/**
 * 对 CALL YIELD 结果应用别名映射。
 * proc 返回 {a: 1, b: 2}，YIELD a AS c, b AS a 应映射为 {c: 1, a: 2}。
 */
function _applyYieldAliases(
  rows: Array<Record<string, unknown>>,
  yieldItems: Array<{ name: string; alias: string | null }> | undefined,
  query: string | undefined
): Array<Record<string, unknown>> {
  if (!yieldItems || yieldItems.length === 0) return rows
  // A YIELD clause both *projects* the listed columns and *renames* those with
  // an alias.  Column names that the procedure did not produce must be
  // rejected (e.g. `CALL db.labels() YIELD nonExistentColumn`).
  // The set of produced columns is inferred from the first row; when there are
  // no rows (empty result) there is nothing to validate against, so the YIELD
  // names are treated as the projection keys.
  const producedCols = rows.length > 0
    ? new Set(Object.keys(rows[0]))
    : null
  if (producedCols) {
    for (const yi of yieldItems) {
      if (!producedCols.has(yi.name)) {
        throw new Error(`Invalid YIELD field: ${yi.name}`)
      }
    }
  }
  const aliasMap = new Map<string, string>()
  for (const yi of yieldItems) {
    aliasMap.set(yi.name, yi.alias || yi.name)
  }
  return rows.map(r => {
    const mapped: Record<string, unknown> = {}
    for (const yi of yieldItems) {
      const key = yi.name
      if (r[key] !== undefined) mapped[yi.alias || yi.name] = r[key]
    }
    return mapped
  })
}


// ── parseQuery LRU 缓存 ──

// 同一个查询字符串的高频重复场景（benchmark / 批量请求）可跳过 ANTLR 解析 + Plan 适配
const _parseCache = new Map<string, QueryPlan>()  // CLEARED 2026-07-04
const _PARSE_CACHE_MAX = 100
const _parseCacheSalt = ''
function _cachedParseQuery(query: string): QueryPlan {
  const cacheKey = query + _parseCacheSalt
  const cached = _parseCache.get(cacheKey)
  if (cached) {
    // Deep copy to prevent cache poisoning from downstream mutations
    return JSON.parse(JSON.stringify(cached, _bigintReplacer), _bigintReviver) as QueryPlan
  }
  const plan = _parseQueryImpl(query)
  // Cache the parsed plan (before any param injection)
  if (query.length < 10000) {
    if (_parseCache.size >= _PARSE_CACHE_MAX) {
      const firstKey = _parseCache.keys().next().value
      if (firstKey !== undefined) _parseCache.delete(firstKey)
    }
    _parseCache.set(cacheKey, JSON.parse(JSON.stringify(plan, _bigintReplacer), _bigintReviver) as QueryPlan)
  }
  return plan
}

// ── 导出执行函数（被 query-engine.ts 的 _executeViaGraphEngine 使用） ──
export { _walkMultiSteps, _pathEndIndices, _stepMatchConstraint, _resolveUnwindList, _extractWithClausesAfterUnwind, _applyYieldAliases, resolveVariableNodeIdx, _findWhereOutsideBrackets }

// ── fastDedup — 多级签名快速去重（替代 JSON.stringify 设键哈希） ──
// 一级签名：typeof + 基本类型的直接拼接。二级：JSON.stringify（碰撞时 fallback）。

const FP_TRIES = 3  // 扩容次数

function _fastDedup(rows: QueryRow[]): QueryRow[] {
  const _sig = new Map<string, number[]>()
  const out: QueryRow[] = []
  const _fp = 256
  for (const row of rows) {
    const key = _makeUniqueKey(row)
    const id = _fp
    let hashId = 0
    // 用数组模拟 HashSet
    let existing = _sig.get(key)
    if (!existing) {
      existing = []
      _sig.set(key, existing)
    } else {
      // 碰撞检测：预计算对象 hash 避免全部 JSON.stringify
      hashId = _calcRowHash(row)
      let found = false
      for (let t = 0; t < existing.length; t++) {
        if (existing[t] === id) { found = true; break }
      }
      if (!found) {
        // 计算二级 hash（对 row 的所有值计算）
        // 如果现有项的关键属性都相同，视为重复
        for (let t = 0; t < existing.length; t++) {
          if (_rowsEqual(row, rows[existing[t]])) { found = true; break }
        }
      }
      if (found) continue
    }
    existing.push(id)
    _sig.set(key, existing)
    out.push(row)
  }
  return out
}

/** 计算行特征 ID */
function _calcRowHash(row: QueryRow): number {
  let h = 0
  for (const [, v] of Object.entries(row)) {
    h = ((h << 5) - h + _hashVal(v)) | 0
  }
  return h
}

/** 计算值的 hash */
function _hashVal(v: unknown): number {
  if (v === null) return 0
  if (typeof v === 'number') return v | 0
  if (typeof v === 'string') {
    let h = 0
    for (let i = 0; i < v.length; i++) h = ((h << 5) - h + v.charCodeAt(i)) | 0
    return h
  }
  if (typeof v === 'bigint') return Number(v & BigInt(0x7fffffff))
  if (Array.isArray(v)) {
    let h = 0
    for (const item of v) h = ((h << 5) - h + _hashVal(item)) | 0
    return h
  }
  return 1
}

function _rowsEqual(a: QueryRow, b: QueryRow): boolean {
  const ka = Object.keys(a); const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    // Value equality on a stable serialisation so two structurally-identical
    // nodes/relationships compare equal regardless of object identity (UNION
    // de-duplication is by Cypher value, not reference).
    if (_stableStringify(a[k]) !== _stableStringify(b[k])) return false
  }
  return true
}

/** Produce a stable, collision-free string identity for an arbitrary value. */
function _stableStringify(v: unknown): string {
  if (v === null) return 'null'
  if (typeof v === 'bigint') return 'i' + String(v)
  if (typeof v === 'number') return 'n' + String(v)
  if (typeof v === 'boolean') return 'b' + String(v)
  if (typeof v === 'string') return 's' + v
  if (Array.isArray(v)) return '[' + v.map(_stableStringify).join(',') + ']'
  if (typeof v === 'object') {
    // Sort keys for a canonical ordering and skip volatile engine-internal
    // fields (`_alias`, `__edges`, caches) that do not contribute to Cypher
    // value equality.  A node is identified by its label(s) and user properties;
    // a relationship by its type and (direction-insensitive) endpoints.
    const obj = v as Record<string, unknown>
    const parts: string[] = []
    if (typeof obj.__relId === 'string') return 'rel:' + obj.__relId
    if (typeof obj.__edgeId === 'string') return 'edge:' + obj.__edgeId
    for (const k of Object.keys(obj).sort()) {
      if (k === '_alias' || k === '__edges' || k.startsWith('_all') || k.startsWith('__')) continue
      parts.push(k + '=' + _stableStringify(obj[k]))
    }
    return '{' + parts.join(';') + '}'
  }
  return String(v)
}

function _makeUniqueKey(row: QueryRow): string {
  // 按 key 排序以保证一致性；只针对所有 key 和值的基本类型做 toString
  const keys = Object.keys(row).sort()
  let s = ''
  for (const k of keys) {
    const v = row[k]
    s += k + ':' + _stableStringify(v)
  }
  return s
}

function _fastIntersect(a: QueryRow[], b: QueryRow[]): QueryRow[] {
  const bKeys = new Set<string>()
  for (const r of b) bKeys.add(_makeUniqueKey(r))
  // Build two sets for equality check
  const bSet: QueryRow[] = b
  return a.filter(ra => bSet.some(rb => _rowsEqual(ra, rb)))
}

function _fastSubtract(a: QueryRow[], b: QueryRow[]): QueryRow[] {
  return a.filter(ra => !b.some(rb => _rowsEqual(ra, rb)))
}

// ── 重导全部公开符号 ──
export { _fastDedup, _fastIntersect, _fastSubtract, _makeUniqueKey }
