/**
 * query-parser.ts — Cypher-lite 查询解析
 *
 * 从 query-engine.ts 拆分。
 * 包含所有解析、参数化、执行计划构建逻辑。
 */

import { parseCypherToPlan } from './ast-to-plan-v2'
import { _evaluateExpression, _postProcessResults, QueryRow, _parseAggregate, _extractAggColumns, _hasAggregates, _executeAggregation, _enrichWithAggregates, _validateLiterals, _bigintReplacer, _bigintReviver } from './expression-engine'
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
 * @param params - 可选参数数组或对象
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
 *     然后从 AST 中提取所需信息重构 WITH 子句。
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
  function _fixScanLabel(subPlan: QueryPlan): void {
    if (subPlan.scanLabel && !subPlan.labelExpr) {
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
          const labelPattern = new RegExp(':' + subPlan.scanLabel + '(?=[\)\s{]|$)')
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
          const labelPattern = new RegExp(':' + oms.scanLabel + '(?=[\)\s{]|$)')
          const isLabelInMatch = matchClauses.some((mc: string) => labelPattern.test(mc))
          if (!isLabelInMatch) {
            oms.scanLabel = null
          }
        }
      }
    }
  }
  _fixScanLabel(plan)
  _fixScanLabel(plan)

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
  if (plan.type === 'MERGE' && plan.mergeNodes?.length) {
    if (!plan.createNodes) plan.createNodes = []
    for (const mn of plan.mergeNodes) {
      plan.createNodes.push(mn)
    }
  }

  // ── returnColumns 拆解：b.name → name （去掉变量前缀） ──
  if (plan.returnColumns?.length) {
    plan.returnColumns = plan.returnColumns.map((rc: string) => {
      const dotIdx = rc.indexOf('.')
      if (dotIdx >= 0) return rc.substring(dotIdx + 1)
      return rc
    })
  }
  // expressionColumns 的 alias/expression 也应同步更新
  if (plan.expressionColumns?.length) {
    plan.expressionColumns = plan.expressionColumns.map((ec: any) => {
      const expr = typeof ec === 'string' ? ec : ec.expression || ec.alias || ec
      const alias = ec.alias || expr
      // 只在顶层拆分 b.name → name，跳过表达式内的 .（如 1.5, func().prop）
      // 注意：不修改 expression（用于求值），只修改 alias（用作结果列名）
      let dotIdx = -1
      if (/^[a-zA-Z_]\w*\.\w+$/.test(alias)) {
        dotIdx = alias.indexOf('.')
      }
      const cleanExpr = dotIdx >= 0 ? alias.substring(dotIdx + 1) : expr
      const cleanAlias = alias.indexOf('.') >= 0 ? alias.split('.').pop()! : alias
      return { expression: expr, alias: cleanAlias }
    })
    // 同步更新 returnAliasMap
    if (plan.returnAliasMap) {
      const newAliasMap: Record<string, string> = {}
      for (const [key, val] of Object.entries(plan.returnAliasMap)) {
        const cleanKey = key.indexOf('.') >= 0 ? key.split('.').pop()! : key
        const cleanVal = val.indexOf('.') >= 0 ? val.split('.').pop()! : val
        newAliasMap[cleanKey] = cleanVal
      }
      plan.returnAliasMap = newAliasMap
    }
  }

  // ── WHERE 子句提取（用于后过滤） ──
  // 即使 ANTLR 没有生成 filters，也需要提取 WHERE 子句供 _evaluateExpression 后处理
  // 注意：需要先屏蔽 list 谓词中的 WHERE（如 ALL(x IN list WHERE cond)），避免干扰正则
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
  const whereClause = safeQuery.match(/WHERE\s+(.+?)(?:\s+RETURN|\s+ORDER|\s+SKIP|\s+LIMIT|\s+WITH|\s+CREATE|\s+DELETE|\s+SET|\s+REMOVE|\s+UNWIND|$)/is)
  if (whereClause) {
    let whereBody = whereClause[1]
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
    const nodePatterns = qText.match(/\([^)]+\)/g) || []
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
          cn.props[pk] = { type: 'NUMBER', value: Number(pv) }
        }
      }
    }
  }

  // ── Fallback: 如果 parseQuery 后 returnColumns 为空但有 RETURN 子句 ──
  // ANTLR 可能无法解析某些函数调用（如 type(r) AS alias），用正则提取
  if (!plan.returnColumns?.length && !plan.aggregate) {
    const returnClause = query.match(/RETURN\s+(.+?)(?:\s+(ORDER|SKIP|LIMIT|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|FOREACH|CALL|SHOW)\s|$)/is)
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
        }
      }
    }
  }

  // 检测无效查询：parseCypherToPlan 成功返回但查询语法非法（ANTLR 错误被吞掉了）
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
      // 从 column 提取 field："sum(n.age) AS totalAge" → "n.age"；"count(*)" → "*"；"count(DISTINCT r)" → "r"
      const colMatch = agg.column.match(/^\w+\(\s*(?:DISTINCT\s+)?(.+?)\s*\)(?:\s+AS\s+\w+)?$/i)
      agg.field = colMatch ? colMatch[1] : (agg.column || '*')
    }
    // GE 兼容：把 column 中的函数名也设为 alias（GE 用 alias 做 props key）
    // count(*) → alias = 'count'，sum(n.age) → alias = 'sum'
    if (!agg.alias && agg.column) {
      const fnMatch = agg.column.match(/^(\w+)\(/i)
      if (fnMatch) agg.alias = fnMatch[1]
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
  if (plan.with && Array.isArray(plan.with.columns) && plan.with.columns.length === 0 && query) {
    const withMatch = query.match(/WITH\s+(.+?)(?:\s+(RETURN|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|FOREACH|CALL|SHOW|WITH|MATCH|ORDER|SKIP|LIMIT|WHERE)\s|$)/is)
    if (withMatch) {
      const withBody = withMatch[1].trim()
      // 按逗号分割 WITH 列（括号/引号感知）
      const colParts = withBody.split(',').map((c: string) => c.trim()).filter(Boolean)
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

  // WITH 列表达式：字符串字面量转为 AST 对象（GE 的 _executeWithClause 期望 AST）
  if (plan.with?.columns) {
    for (const col of plan.with.columns) {
      if (typeof col.expression === 'string') {
        const expr = col.expression.trim()
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
      const unwindMatches = [...query.matchAll(/UNWIND\s+(.+?)\s+AS\s+(\w+)/gi)]
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
  const match = query.match(/WHERE\s+(.+?)(?:\s+(?:WITH|RETURN|CREATE|MERGE|SET|DELETE|ORDER\s+BY|SKIP|LIMIT|UNWIND)\s|$)/is)
  return match ? match[1].trim() : null
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
  let paths: number[][] = [[startIdx]]
  for (let si = 0; si < steps.length; si++) {
    const step = steps[si]
    // ── 变量长度路径：step.range 存在时做 BFS 多跳 ──
    if ((step as any).range) {
      const range = (step as any).range
      const minHops = range.min ?? 1
      const maxHops = range.max ?? 10 // 默认最大 10 跳（防止无限）
      const varLenSet = new Set<number>()
      // 检查边标签是否配置（仅对匹配边做遍历）
      const hasEdgeLabel = !!(step as any).edgeLabel
      for (const sidx of _pathEndIndices(paths)) {
        // BFS 从 sidx 出发，记录每层目标节点
        let frontier = new Set<number>([sidx])
        const visited = new Set<number>([sidx])
        for (let depth = 1; depth <= maxHops; depth++) {
          const nextFrontier = new Set<number>()
          for (const fidx of frontier) {
            const node = allNodes[fidx] as any
            const edges: Array<{ dstIdx: number; srcIdx: number; label: string; props?: any }> = node?.__edges || []
            const isAny = step.direction === 'any'
            for (const e of edges) {
              let neighborIdx = -1
              if (isAny) {
                // isAny 分支：自环边也需匹配（neighborIdx === fidx 时自环）
                neighborIdx = e.dstIdx === fidx ? e.srcIdx : (e.srcIdx === fidx ? e.dstIdx : -1)
                if (neighborIdx === fidx && e.dstIdx === fidx && e.srcIdx === fidx) {
                  // 自环：src === dst === fidx，neighborIdx 被设为 fidx，但后面 neighborIdx !== fidx 会过滤掉
                  // 这里保持 fidx 作为 self-loop 标记
                }
              } else if (step.direction === 'out' && e.srcIdx === fidx) {
                neighborIdx = e.dstIdx
              } else if (step.direction === 'in' && e.dstIdx === fidx) {
                neighborIdx = e.srcIdx
              }
              if (neighborIdx >= 0 && neighborIdx < allNodes.length && !visited.has(neighborIdx) && (neighborIdx !== fidx || (step.direction === 'any' && e.dstIdx === fidx && e.srcIdx === fidx))) {
                if (hasEdgeLabel && (e.label !== step.edgeLabel)) continue
                visited.add(neighborIdx)
                if (depth >= minHops) {
                  if (_stepMatchConstraint(neighborIdx, step, allNodes)) {
                    // 检查 __edges 一致性（TCK 场景）
                    varLenSet.add(neighborIdx)
                  }
                }
                nextFrontier.add(neighborIdx)
              }
            }
            // 无向边兜底：所有其他节点的 __edges 中指向 fidx 的边
            if (isAny) {
              for (let j = 0; j < allNodes.length; j++) {
                if (j === fidx || visited.has(j)) continue
                const other = allNodes[j] as any
                if (other.__edges) {
                  for (const e of other.__edges) {
                    if ((e.dstIdx === fidx || e.srcIdx === fidx) && !visited.has(j)) {
                      const nIdx = e.dstIdx === fidx ? e.srcIdx : e.dstIdx
                      if (nIdx === j && !visited.has(j)) {
                        visited.add(j)
                        if (depth >= minHops && _stepMatchConstraint(j, step, allNodes)) {
                          varLenSet.add(j)
                        }
                        nextFrontier.add(j)
                      }
                    }
                  }
                }
              }
            }
          }
          frontier = nextFrontier
          if (frontier.size === 0) break
        }
      }
      paths = [...varLenSet].map(idx => [startIdx, idx])
      continue
    }
    const nextSet = new Set<number>()
    // 构建 combinedSourceFilters：当前步的 source 节点属性约束
    // 排除 ANTLR 链式比较解析失败的值（包含比较运算符的字符串值）
    const _isBrokenFilterValue = (v: any): boolean =>
      typeof v === 'string' && /[<>=]/.test(v)
    const combinedSourceFilters: Array<{source?: string; property: string; value: any}> = []
    if (planFilters?.length) {
      for (const f of planFilters) {
        if (_isBrokenFilterValue(f.value)) continue
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
    // WHERE a.id = 1 — 在 seed 节点（step 0）和路径回溯（step 3+）中检查
    if (combinedSourceFilters.length > 0) {
      const curEnds = _pathEndIndices(paths)
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
            // 大整数精度补偿：ANTLR 把超出 Number 安全范围的整数字面量截断，
            // 尝试用 BigInt 精确比较
            if (/^\d+$/.test(actualStr) && /^-?\d+$/.test(filterStr)) {
              try {
                const actualBig = BigInt(actualStr)
                const filterBig = BigInt(filterStr)
                if (actualBig !== filterBig) {
                  passes = false
                  break
                }
              } catch {
                passes = false
                break
              }
            } else {
              passes = false
              break
            }
          }
        }
        if (!passes) curEnds.delete(idx)
      }
    }
    // 边遍历
    const curEnds = _pathEndIndices(paths)
    for (const idx of curEnds) {
      const node = allNodes[idx]
      if (!node) continue
      const edges: Array<{ dstIdx: number; srcIdx: number; label: string; props?: any }> = (node as any).__edges || []
      const isAny = step.direction === 'any'
      // 当前节点的出边
      for (const e of edges) {
        let neighborIdx = -1
        if (isAny) {
          neighborIdx = e.dstIdx === idx ? e.srcIdx : (e.srcIdx === idx ? e.dstIdx : -1)
        } else if (step.direction === 'out' && e.srcIdx === idx) {
          neighborIdx = e.dstIdx
        } else if (step.direction === 'in' && e.dstIdx === idx) {
          neighborIdx = e.srcIdx
        }
        if (neighborIdx >= 0 && neighborIdx < allNodes.length) {
          // 自环检查：如果是自环边（neighborIdx === idx），走 isAny 或无方向约束时允许
          const isSelfLoop = (neighborIdx === idx) && (e.dstIdx === idx && e.srcIdx === idx)
          // 边标签检查：如果 step 指定了 edgeLabel，边必须匹配（方向已经匹配）
          // 支持多类型 | 分隔（如 :KNOWS|HATES）
          if (step.edgeLabel) {
            const targetLabels = step.edgeLabel.split('|')
            if (!targetLabels.includes(e.label)) continue
          }
          if (_stepMatchConstraint(neighborIdx, step, allNodes)) {
            nextSet.add(neighborIdx)
          }
        }
      }
      // 无向边：其他节点到当前节点的反向边
      if (isAny) {
        for (let j = 0; j < allNodes.length; j++) {
          if (j === idx) continue
          const other = allNodes[j] as any
          if (other.__edges) {
            for (const e of other.__edges) {
              if ((e.dstIdx === idx || e.srcIdx === idx)) {
                const neighborIdx = e.dstIdx === idx ? e.srcIdx : e.dstIdx
                if (!nextSet.has(neighborIdx) && _stepMatchConstraint(neighborIdx, step, allNodes)) {
                  nextSet.add(neighborIdx)
                }
              }
            }
          }
        }
      }
    }
    // 当前 step 的 target filter（约束 step.targetAlias 变量）
    // 只预过滤 EQ/NEQ/IS_NULL/IS_NOT_NULL（GT/GTE/LT/LTE 等由 GE filter 补偿或后处理）
    const simpleOps = new Set(['EQ', 'NEQ', 'IS_NULL', 'IS_NOT_NULL'])
    const targetFilters = planFilters?.length ? planFilters.filter(f => f.source === step.targetAlias && simpleOps.has(f.operator)) : []
    if (targetFilters.length > 0) {
        for (const fidx of [...nextSet]) {
          const fn = allNodes[fidx]
          if (!fn) { nextSet.delete(fidx); continue }
          let passes = true
          for (const rf of targetFilters) {
            if (rf.operator === 'IS_NULL') {
              if (fn[rf.property] != null) { passes = false; break }
            } else if (rf.operator === 'IS_NOT_NULL') {
              if (fn[rf.property] == null) { passes = false; break }
            } else {
              if (fn[rf.property] === undefined || String(fn[rf.property]) !== String(rf.value)) {
                passes = false
                break
              }
            }
          }
          if (!passes) nextSet.delete(fidx)
        }
      }
    // 应用被 WHERE 过滤跳过的节点抑制（仅在单步时使用，多步会错误地过滤路径中间节点）
    if (skipNodeIndices && skipNodeIndices.size > 0 && steps.length <= 1) {
      for (const sidx of skipNodeIndices) {
        nextSet.delete(sidx)
      }
    }
    // 扩展路径：每个 nextSet 索引追加到每条路径末尾
    const newPaths: number[][] = []
    for (const idx of nextSet) {
      for (const p of paths) {
        // 检查路径末端节点是否通过边连接到 idx
        const last = p[p.length - 1]
        const lastNode = allNodes[last] as any
        const connected = lastNode?.__edges?.some((e: any) => {
          const neighborIdx = e.dstIdx === last ? e.srcIdx : (e.srcIdx === last ? e.dstIdx : -1)
          return neighborIdx === idx
        })
        if (connected) {
          newPaths.push([...p, idx])
        }
      }
    }
    paths = newPaths.length > 0 ? newPaths : [...nextSet].map(idx => [startIdx, idx])
    // 无向边中排除自环回路：路径最后两位相等（通过自环回到自身）时跳过
    // `MATCH ()--()` 单步自环匹配合法（paths[0].length===1 不触发）
    // `(:A)-->()--()` 第二步无向边通过自环回到中间节点产生重复
    if (step.direction === 'any' && paths.length > 0 && paths[0].length >= 2) {
      const filtered: number[][] = []
      for (const p of paths) {
        const idx = p[p.length - 1]
        const prev = p[p.length - 2]
        if (idx === prev) continue
        filtered.push(p)
      }
      if (filtered.length > 0) paths = filtered
    }
    if (paths.length === 0) break
  }
  return paths
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
    if (fullLabel && typeof fullLabel === 'string') {
      if (!fullLabel.split(':').includes(step.targetLabel)) return false
    } else if (node._label && node._label !== step.targetLabel) {
      return false
    }
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


function _splitWithColumns(clauseBody: string): string[] {
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
    return unwind.list
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
  const needsRemap = yieldItems.some(yi => yi.alias && yi.alias !== yi.name)
  if (!needsRemap) return rows
  const aliasMap = new Map<string, string>()
  for (const yi of yieldItems) {
    aliasMap.set(yi.name, yi.alias || yi.name)
  }
  return rows.map(r => {
    const mapped: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(r)) {
      const newKey = aliasMap.get(k) ?? k
      mapped[newKey] = v
    }
    return mapped
  })
}


// ── parseQuery LRU 缓存 ──

// 同一个查询字符串的高频重复场景（benchmark / 批量请求）可跳过 ANTLR 解析 + Plan 适配
const _parseCache = new Map<string, QueryPlan>()
const _PARSE_CACHE_MAX = 100
function _cachedParseQuery(query: string): QueryPlan {
  const cached = _parseCache.get(query)
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
    _parseCache.set(query, JSON.parse(JSON.stringify(plan, _bigintReplacer), _bigintReviver) as QueryPlan)
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
  let _fp = 256
  for (const row of rows) {
    const key = _makeUniqueKey(row)
    let id = _fp
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
    if (a[k] !== b[k]) return false
  }
  return true
}

function _makeUniqueKey(row: QueryRow): string {
  // 按 key 排序以保证一致性；只针对所有 key 和值的基本类型做 toString
  const keys = Object.keys(row).sort()
  let s = ''
  for (const k of keys) {
    const v = row[k]
    s += k + ':' + (typeof v) + (v === null ? 'null' : typeof v === 'bigint' ? String(v) : v === undefined ? 'undef' : String(v))
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
