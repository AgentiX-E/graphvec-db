/**
 * executor-unwind-pipeline.ts — WITH/UNWIND/aggregate 管道执行
 *
 * 从 query-executor.ts 拆分。
 */

import type { QueryPlan, QueryRow } from './query-types'
import { _evaluateExpression, _compareOrderByValue } from './expression-engine'
import { _resolveUnwindList, _splitWithColumns, _findWhereOutsideBrackets } from './query-parser'

/**
 * 处理 WITH/UNWIND/aggregate 管道（不含 MATCH 图遍历）。
 * 
 * 处理链：
 *   WITH [...] AS listVar
 *     → UNWIND listVar AS x
 *       → UNWIND listVar AS y（Optional secondUnwind）
 *         → WITH expr AS v (投影)
 *           → RETURN agg(v)
 * 
 * DSL 语义：WITH 先计算列表字面量（直接在 plan 中），然后 UNWIND 行展开，
 * WITH 列投影 + aggregate 聚合。
 */

/**
 * Pre-process aggregate WITH clauses for mixed MATCH+WITH queries.
 * Evaluates the first WITH's aggregate expression (e.g., collect(a))
 * and injects the result into varCtx so subsequent UNWIND can resolve
 * the list variable (e.g., UNWIND nodes AS n).
 */
function _preProcessAggregateWith(
  varCtx: Record<string, unknown>,
  preAggAliases: Set<string>,
  plan: QueryPlan,
  query: string,
  nodes: Array<Record<string, unknown>>
): void {
  // Process all WITH clauses that precede UNWIND, in order.
  const withRegex = /\bWITH\s+(.+?)(?=\s+(?:WITH|UNWIND|RETURN)\b)/gis
  let m: RegExpExecArray | null
  while ((m = withRegex.exec(query)) !== null) {
    const clauseBody = m[1].trim()
    const columns = _splitWithColumns(clauseBody)
    for (const col of columns) {
      const eqIdx = col.search(/\s+AS\s+/i)
      if (eqIdx < 0) continue
      const expr = col.substring(0, eqIdx).trim()
      const alias = col.substring(eqIdx + 3).trim()
      const val = _evaluateExpression(expr, varCtx)
      varCtx[alias] = val !== undefined ? _deepCopyForCapture(val) : null
      preAggAliases.add(alias)
    }
  }
}

/**
 * Materialize WITH projections that occur *before* the first UNWIND in a pure
 * WITH/UNWIND pipeline (no MATCH).  In a pipeline like
 *
 *   WITH [true,false] AS values
 *   WITH values, size(values) AS numOfValues
 *   UNWIND values AS value
 *   ...
 *
 * the initial branch only materializes the first list literal (`values`); the
 * intermediate projection `numOfValues` is silently dropped, so a later
 * `range(0, numOfValues-1)` evaluates `numOfValues` as null and throws.  Walk
 * every WITH clause up to (but excluding) the first UNWIND and evaluate each
 * aliased column in order, feeding earlier aliases into later ones.
 */
function _materializePreUnwindProjections(query: string, varCtx: Record<string, unknown>): void {
  // Up to the first UNWIND only — projections after UNWIND depend on the
  // row-wise expansion and must NOT be materialized here.
  const unwindIdx = query.search(/\bUNWIND\b/i)
  const prefix = unwindIdx >= 0 ? query.slice(0, unwindIdx) : query
  const withRegex = /\bWITH\s+(.+?)(?=\s+(?:WITH|UNWIND|RETURN)\b|$)/gis
  let m: RegExpExecArray | null
  while ((m = withRegex.exec(prefix)) !== null) {
    const clauseBody = m[1].trim()
    const columns = _splitWithColumns(clauseBody)
    for (const col of columns) {
      const eqIdx = col.search(/\s+AS\s+/i)
      if (eqIdx < 0) continue
      const expr = col.substring(0, eqIdx).trim()
      const alias = col.substring(eqIdx + 3).trim()
      // Do not overwrite an already-materialized alias (e.g. the first list
      // literal `values` handled by the main branch above).
      if (alias in varCtx) continue
      const val = _evaluateExpression(expr, varCtx)
      varCtx[alias] = val !== undefined ? _deepCopyForCapture(val) : null
    }
  }
}

/** Shallow-deep copy: clone arrays and plain objects for value capture. */
function _deepCopyForCapture(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(v => _deepCopyForCapture(v))
  if (val !== null && typeof val === 'object') {
    const copy: Record<string, unknown> = {}
    for (const k of Object.keys(val as Record<string, unknown>)) {
      copy[k] = _deepCopyForCapture((val as Record<string, unknown>)[k])
    }
    return copy
  }
  return val
}

export function _executeWithUnwindPipeline(plan: QueryPlan, _nodes: Array<Record<string, unknown>>, query?: string, initialVarCtx?: Record<string, unknown>): QueryRow[] {
  // Step 1: 解析 WITH 列表字面量
  // plan.with.columns[0] 是 {expression: "[1, 3.14, ...]", alias: "operands"}
  const varCtx: Record<string, unknown> = { ...initialVarCtx }

  // When plan.hasMatch (mixed MATCH+WITH+aggregate), inject MATCH variables
  // from allNodes into varCtx so aggregate expressions like collect(a) can
  // resolve the MATCH variable 'a'.
  if (plan.hasMatch && _nodes.length > 0) {
    // Try to get the variable name from plan.steps, then fall back to query regex
    let stepSrc = plan.steps?.[0]?.source
    if (!stepSrc && query) {
      const matchMatch = query.match(/MATCH\s*\((\w+)\b/i)
      stepSrc = matchMatch?.[1]
    }
    if (stepSrc) {
      // For aggregation like collect(a), inject all matching nodes
      // Use array for collect() compatibility
      varCtx[stepSrc] = _nodes.length === 1 ? _nodes[0] : _nodes
    }
  }

  // Pre-process aggregate WITH clauses (e.g., WITH collect(a) AS nodes) before
  // UNWIND expansion.  The UNWIND list variable often depends on the aggregate
  // result (e.g., UNWIND nodes AS n), so we must evaluate aggregate WITH first
  // and inject the result into varCtx before the UNWIND step resolves its list.
  const _preAggAliases = new Set<string>()
  if (plan.hasMatch && plan.with && query &&
      (plan.aggregate || plan.type === 'SET' || plan.type === 'DELETE')) {
    _preProcessAggregateWith(varCtx, _preAggAliases, plan, query, _nodes)
  }

  // Materialize intermediate WITH projections before the first UNWIND in a
  // pure WITH/UNWIND pipeline (no MATCH).  These are not aggregate clauses and
  // are otherwise dropped, e.g. `WITH values, size(values) AS numOfValues`
  // must expose numOfValues to a later RETURN range(0, numOfValues-1).
  if (query && !plan.hasMatch && plan.unwind) {
    _materializePreUnwindProjections(query, varCtx)
  }

  // 从原始 query 文本提取所有 WITH [...] AS var 的列表字面量（即使没有 UNWIND）
  if (query) {
    // 匹配所有 WITH [...] AS var 模式，取第一个
    // 用括号深度Trace正确识别嵌套的 [] 和 {}（列表内嵌空列表/空 map）
    let withListMatch: RegExpMatchArray | null = null
    {
      let start = -1
      let depth = 0
      for (let i = 0; i < query.length; i++) {
        const ch = query[i]
        if (ch === '[' && depth === 0) {
          const before = query.substring(0, i).trimEnd()
          if (/\bWITH\s*$/i.test(before)) start = i
          depth++
        } else if (ch === '[' || ch === '{') {
          depth++
        } else if (ch === ']' || ch === '}') {
          depth--
          if (depth === 0 && start >= 0) {
            const listExpr = query.substring(start, i + 1)
            const after = query.substring(i + 1).trim()
            const aliasMatch = after.match(/^AS\s+(\w+)/i)
            if (aliasMatch) {
              withListMatch = [listExpr, listExpr, aliasMatch[1]]
            }
            break
          }
        }
      }
    }
    if (withListMatch) {
      const listExpr = withListMatch[1]
      const alias = withListMatch[2]
      // 排除列表推导模式 [var IN ... WHERE ... | ...] — 不是纯列表字面量
      if (!/^\s*\[\s*\w+\s+IN\s+/i.test(listExpr)) {
        const val = _evaluateExpression(listExpr, varCtx)
        if (Array.isArray(val)) varCtx[alias] = val
      }
    }

    // 补充提取：`WITH <函数调用> AS var`（如 WITH collect([0, 0.0]) AS numbers）。
    // 上述列表字面量扫描只覆盖 `WITH [...] AS var` 裸列表，无法识别函数包裹的列表
    // （collect(...)、range(...) 等）。此类表达式需物化到 varCtx，供 `UNWIND numbers AS arr`
    // 解析。仅处理以 WITH 开头的查询——以 MATCH 开头的聚合投影由 GE 负责。
    {
      const withExprMatch = query.match(/^WITH\s+(\S.*?)\s+AS\s+(\w+)\b/is)
      if (withExprMatch) {
        const expr = withExprMatch[1].trim()
        const alias = withExprMatch[2]
        if (!(alias in varCtx) && /[a-zA-Z_]\w*\s*\(/.test(expr)) {
          const val = _evaluateExpression(expr, varCtx)
          if (val != null || Array.isArray(val)) varCtx[alias] = val
        }
      }
    }
  }

  // Step 2: 执行 UNWIND 链（支持 N 级 UNWIND 笛卡尔积）
  // 修复 UNWIND 变量名：parseQuery 有时将 name 设为源变量而非 AS 别名
  if (query && plan.unwind?.var) {
    const uv = plan.unwind.var.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const uaMatch = query.match(new RegExp('UNWIND\\s+' + uv + '\\s+AS\\s+(\\w+)', 'i'))
    if (uaMatch && uaMatch[1] !== plan.unwind.name) {
      plan.unwind.name = uaMatch[1]
    }
  }
  if (query && plan.unwinds?.length) {
    // Use matchAll to enumerate all UNWIND clauses by position, rather
    // than matching by expression text. When multiple UNWIND clauses
    // share the same source expression (e.g. two UNWIND range(...) AS
    // different aliases), `query.match(UV + expr)` returned the first
    // match every time, overwriting later aliases with the first one.
    const allMatches = [...query.matchAll(/\bUNWIND\s+(.+?)\s+AS\s+(\w+)/gi)]
    for (let ui = 0; ui < plan.unwinds.length; ui++) {
      const m = allMatches[ui]
      if (m?.[2] && m[2] !== plan.unwinds[ui].name) {
        plan.unwinds[ui].name = m[2]
      }
    }
  }
  let rows: Array<Record<string, unknown>> = []

  if (plan.unwinds?.length) {
    // 逐层 UNWIND：先展开第一层，对每一行应用中间 WITH 投影（如果存在），再展开下一层
    // 这是因为第二层 UNWIND 的列表可能依赖于第一层中间 WITH 的计算结果
    for (let ui = 0; ui < plan.unwinds.length; ui++) {
      const u = plan.unwinds[ui]
      // 从已有 rows 中提取变量注入 varCtx（用于跨层 UNWIND 的列表解析）
      if (rows.length > 0) {
        for (const key of Object.keys(rows[0])) {
          if (!(key in varCtx)) varCtx[key] = rows[0][key]
        }
      }
      const items = _resolveUnwindList(u, varCtx)
      const unwrapped = (Array.isArray(items) ? items : [items]).map(item => {
        if (typeof item === 'string' && item.startsWith('{') && item.endsWith('}')) {
          const parsed = _evaluateExpression(item, varCtx)
          if (parsed != null && typeof parsed === 'object') return parsed
        }
        return item
      })
      // 对当前 rows 中的每一行，展开当前 UNWIND
      if (rows.length === 0) {
        // 初始行：直接展开
        rows = unwrapped.map(item => ({ [u.name]: item }))
      } else {
        // 已有多行：每行做笛卡尔积展开
        const newRows: Array<Record<string, unknown>> = []
        for (const row of rows) {
          for (const item of unwrapped) {
            newRows.push({ ...row, [u.name]: item })
          }
        }
        rows = newRows
      }
      // 如果当前层 UNWIND 后还有中间 WITH 投影（非列表字面量的 WITH）
      // 从 query 文本提取对应于此层 UNWIND 之后的中间 WITH 并应用
      if (query && ui < plan.unwinds.length) {
        // 找到 query 中第 (ui+1) 个 UNWIND 的位置（索引从 0 开始）
        let targetUnwindIdx = -1
        let found = 0
        const unwindRegexGlobal = /\bUNWIND\s+/gi
        let um: RegExpExecArray | null
        while ((um = unwindRegexGlobal.exec(query)) !== null) {
          if (found === ui) { targetUnwindIdx = um.index; break }
          found++
        }
        if (targetUnwindIdx < 0) continue
        const unwindPos = targetUnwindIdx
        const nextUnwindSearch = query.slice(unwindPos + 1)
        let nextUnwindPos = nextUnwindSearch.search(/\bUNWIND\s+/i)
        let section: string
        if (nextUnwindPos >= 0) {
          section = query.slice(unwindPos, nextUnwindPos + 1)  // 从当前 UNWIND 到下一个 UNWIND
        } else {
          section = query.slice(unwindPos)
        }
          // 在 section 中查找非列表字面量的 WITH
          const withRegex = /WITH\s+(?!\s*\[)((?:[^\\]|\\.)*?)(?=\b(?:UNWIND|WITH|RETURN|CREATE|MERGE|DELETE|SET|REMOVE)\b|$)/gis
          let m
          while ((m = withRegex.exec(section)) !== null) {
            const clauseBody = m[1].trim()
            if (!clauseBody) continue
            const columns = _splitWithColumns(clauseBody)
            rows = rows.map(row => {
              const newRow: Record<string, unknown> = { ...row }
              const evalCtx: Record<string, unknown> = { ...varCtx, ...row }
              for (const col of columns) {
                const eqIdx = col.search(/\s+AS\s+/i)
                if (eqIdx >= 0) {
                  const expr = col.substring(0, eqIdx).trim()
                  const alias = col.substring(eqIdx + 3).trim().replace(/\s+$/, '')
                  // 函数调用如 CASE/coalesce 等
                  const val = _evaluateExpression(expr, evalCtx)
                  newRow[alias] = val !== undefined ? val : null
                } else {
                  // 无 AS，直接引用变量
                  const val = _evaluateExpression(col, evalCtx)
                  if (val !== undefined) newRow[col] = val
                }
              }
              return newRow
            })
            // 将中间 WITH 结果写回 varCtx（用于后续 UNWIND 层的列表解析）
            if (rows.length > 0) {
              Object.assign(varCtx, rows[0])
            }
        }
      }
    }
  } else if (plan.unwind) {
    const list1 = (_resolveUnwindList(plan.unwind, varCtx) as any[])
    const resolvedList1 = list1.map(item => {
      if (typeof item === 'string' && item.startsWith('{') && item.endsWith('}')) {
        const parsed = _evaluateExpression(item, varCtx)
        if (parsed != null && typeof parsed === 'object') return parsed
      }
      return item
    })
    if (!Array.isArray(resolvedList1)) {
      // 非列表值 → 单行
      rows = [{ [plan.unwind.name]: resolvedList1 }]
    } else if (plan.secondUnwind) {
      // 双 UNWIND：笛卡尔积（向后兼容 plan.secondUnwind / plan.unwind 字段）
      const list2 = _resolveUnwindList(plan.secondUnwind, varCtx).map(item => {
        if (typeof item === 'string' && item.startsWith('{') && item.endsWith('}')) {
          const parsed = _evaluateExpression(item, varCtx)
          if (parsed != null && typeof parsed === 'object') return parsed
        }
        return item
      })
      for (const item1 of resolvedList1) {
        const list2Arr = Array.isArray(list2) ? list2 : [list2]
        for (const item2 of list2Arr) {
          const row: Record<string, unknown> = { [plan.unwind.name]: item1 }
          row[plan.secondUnwind.name] = item2
          rows.push(row)
        }
      }
    } else {
      // 单 UNWIND
      rows = resolvedList1.map((item: unknown) => ({ [plan.unwind.name!]: item }))
    }
  } else {
    rows = [{}]
    // Inject MATCH variables into rows for aggregate processing (e.g., collect(a))
    if (plan.hasMatch && plan.aggregate) {
      const stepSrc = plan.steps?.[0]?.source || (query?.match(/MATCH\s*\((\w+)\b/i)?.[1])
      if (stepSrc && stepSrc in varCtx) {
        rows[0][stepSrc] = varCtx[stepSrc]
      }
    }
  }

  // ── DML 执行（SET / DELETE）在 UNWIND 展开后、WITH 投影前 ──
  // 必须在 WITH 投影之前执行，因为 projection 会改变行结构
  if (rows.length > 0 && plan.setClauses?.length) {
    for (const sc of plan.setClauses) {
      if (!sc.property) continue
      const parsedVal = typeof sc.value === 'object' && sc.value !== null && 'value' in (sc.value as Record<string, unknown>)
        ? (sc.value as any).value
        : sc.value
      for (const row of rows) {
        // SET x.prop = val: find the target variable in the row
        // The target is the UNWIND alias (e.g., SET n.name = 'newName' → target = n)
        const targetVar = plan.unwind?.name || ''
        const target = row[targetVar]
        if (target && typeof target === 'object') {
          ;(target as Record<string, unknown>)[sc.property] = parsedVal
        }
      }
    }
  }

  // ── 中间 WITH 投影 ──
  if (query && rows.length && plan.unwind) {
    const nonListWithClauses: Array<{ cols: string; where: string | null; orderBy: string | null }> = []
    {
      let i = 0
      while (i < query.length) {
        const idx = query.substring(i).search(/\bWITH\s+(?!\s*\[)/i)
        if (idx < 0) break
        const absPos = i + idx
        const afterWith = query.substring(absPos + 4).trimStart()
        let endIdx = afterWith.search(/\b(?:UNWIND|WITH|RETURN|ORDER\s+BY|SKIP|LIMIT|CREATE|MERGE|DELETE|SET|REMOVE)\b/i)
        if (endIdx < 0) endIdx = afterWith.length
        const clauseBody = afterWith.substring(0, endIdx).trim()
        // Capture a trailing `ORDER BY <expr> [ASC|DESC]` for this WITH clause.
        // A projection inside a middle WITH (e.g. `WITH size(...) AS x, value,
        // numOfValues ORDER BY value`) must sort its rows before a later collect
        // aggregation, otherwise collect() sees the pre-sort row order.
        const orderByMatch = afterWith.substring(endIdx).match(/^\s*ORDER\s+BY\s+(.+?)(?=\s+(?:SKIP|LIMIT|WITH|UNWIND|RETURN|CREATE|MERGE|DELETE|SET|REMOVE)\b|$)/is)
        const orderByExpr = orderByMatch ? orderByMatch[1].trim() : null
        const whereMatch = clauseBody.match(/^(.+?)\s+WHERE\s+(.+)$/is)
        // 括号深度感知的 WHERE 检测：屏蔽列表推导 [y IN ... WHERE ...] 和函数调用内 WHERE
        const wherePos = _findWhereOutsideBrackets(clauseBody)
        if (wherePos >= 0) {
          nonListWithClauses.push({ cols: clauseBody.substring(0, wherePos).trim(), where: clauseBody.substring(wherePos + 5).trim(), orderBy: orderByExpr })
        } else {
          nonListWithClauses.push({ cols: clauseBody, where: null, orderBy: orderByExpr })
        }
        i = absPos + 4 + 1
      }
    }
    const middleWith = nonListWithClauses.length > 1 ? nonListWithClauses.slice(0, -1) : []
    for (const mwc of middleWith) {
      const columns = _splitWithColumns(mwc.cols)
      rows = rows.map(row => {
        const newRow: Record<string, unknown> = { ...row }
        const evalCtx: Record<string, unknown> = { ...varCtx, ...row }
        for (const col of columns) {
          const asMatch = col.match(/^(.+?)\s+AS\s+(\w+)$/i)
          if (asMatch) {
            const expr = asMatch[1].trim()
            const alias = asMatch[2]
            const val = _evaluateExpression(expr, evalCtx)
            newRow[alias] = val !== undefined ? val : null
          } else {
            const trimmed = col.trim()
            if (trimmed in evalCtx) {
              newRow[trimmed] = evalCtx[trimmed]
            } else {
              const val = _evaluateExpression(trimmed, evalCtx)
              newRow[trimmed] = val !== undefined ? val : null
            }
          }
        }
        return newRow
      })
      if (mwc.where) {
        // 用完整 evalCtx（含原始 row 中的 i, j 等 UNWIND 变量）来过滤
        rows = rows.filter(row => {
          const fullCtx: Record<string, unknown> = { ...varCtx, ...row }
          const val = _evaluateExpression(mwc.where!, fullCtx)
          return val === true
        })
      }
      // Sort rows by this middle WITH's ORDER BY expression, before any later
      // collect aggregation.  Uses Cypher value ordering so booleans/temporal
      // values order consistently with the comparison semantics.
      if (mwc.orderBy) {
        const obExpr = mwc.orderBy.replace(/\s+(?:ASC|DESC)\s*$/i, '').trim()
        const obDesc = /\s+DESC\s*$/i.test(mwc.orderBy)
        const obCtxs = rows.map(row => _evaluateExpression(obExpr, { ...varCtx, ...row }))
        const idxOrder = rows.map((_, i) => i).sort((a, b) => {
          const va = obCtxs[a]
          const vb = obCtxs[b]
          const cmp = _compareOrderByValue(va, vb)
          return obDesc ? -cmp : cmp
        })
        rows = idxOrder.map(i => rows[i])
      }
    }
  }

  // Step 3: 应用 WITH 投影——逐行计算非聚合列，收集聚合列的值
  if (plan.with?.columns?.length) {
    // 判断哪些列是聚合函数
    const aggFnPattern = /^\s*(collect|count|sum|avg|max|min)\s*\(/i
    const isAggCol: boolean[] = plan.with.columns.map(col => typeof col.expression === 'string' ? aggFnPattern.test(col.expression) : false)
    const hasAgg = isAggCol.some(Boolean)
    const aggCols: Array<{ alias: string; rows: unknown[] }> = []
    if (hasAgg) {
      for (let i = 0; i < plan.with.columns.length; i++) {
        if (isAggCol[i]) {
          aggCols.push({ alias: plan.with.columns[i].alias || plan.with.columns[i].expression, rows: [] })
        }
      }
    }
    rows = rows.map(row => {
      const newRow: Record<string, unknown> = { ...row }
      const evalCtx: Record<string, unknown> = { ...varCtx, ...row }
      let aggIdx = 0
      for (let i = 0; i < plan.with.columns.length; i++) {
        const col = plan.with.columns[i]
        const alias = col.alias || col.expression
        // Skip re-evaluation of columns that were pre-processed by
        // _preProcessAggregateWith (e.g., list comprehensions in WITH chains).
        // These have already been snapshotted before UNWIND/SET mutations.
        if (col.alias && _preAggAliases.has(col.alias)) {
          newRow[alias] = varCtx[alias]
          if (isAggCol[i]) aggIdx++ // advance but don't collect (value already snapshotted)
          continue
        }
        if (isAggCol[i]) {
          const colExpr = typeof col.expression === 'string' ? col.expression : ''
          const innerMatch = colExpr.match(/^\s*\w+\s*\((.+?)\)\s*$/is)
          if (innerMatch) {
            // count(*) → 每个值都是 1
            const innerExpr = innerMatch[1].trim()
            const val = innerExpr === '*' ? 1 : _evaluateExpression(innerExpr, evalCtx)
            aggCols[aggIdx].rows.push(val !== undefined ? val : null)
          }
          aggIdx++
        } else {
          // 保持 UNWIND 展开后的行变量值不被初始 WITH 列表字面量覆盖
          // 保持 UNWIND 展开后的行变量值不被初始 WITH 列表字面量覆盖
          if (alias in row && (col.expression == null || typeof col.expression !== 'string')) {
            newRow[alias] = row[alias]
            continue
          }
          // 当列别名在 evalCtx 中已存在时（如多次 UNWIND 后的中间变量），
          // 保留 row 中已有的非 WITH 列变量（如 x、fixedList），但 WITH 列仍需 eval
          if (evalCtx[alias] !== undefined && col.alias) {
            for (const rk of Object.keys(row)) {
              if (!(rk in newRow) && rk !== col.alias) {
                newRow[rk] = row[rk]
              }
            }
            // WITH 列总是需要求值（coalesce、函数、字面量等），不能跳过
            const val = typeof col.expression === 'string'
              ? _evaluateExpression(col.expression, evalCtx)
              : _evaluateExpression(col.expression, evalCtx)
            newRow[alias] = val !== undefined ? val : null
            continue
          }
          if (col.alias === null && col.expression in evalCtx) {
            newRow[col.expression] = evalCtx[col.expression]
            continue
          }
          // 非字符串表达式的结构化字面量（如 {type:"LIST",...}）：直接求值
          const val = typeof col.expression === 'string'
            ? _evaluateExpression(col.expression, evalCtx)
            : _evaluateExpression(col.expression, evalCtx)
          const key = col.alias || col.expression
          newRow[key] = val !== undefined ? val : null
          // 同一 WITH 中后面的列可能依赖前面列的结果，更新 evalCtx
          if (key in newRow) {
            evalCtx[key] = newRow[key]
          }
        }
      }
      return newRow
    })
    // 聚合后：将所有 UNWIND 行压缩为单行，聚合列的值替换为收集的数组
    // Skip aggregation row construction when all agg columns were pre-computed
    // (their values are already snapshotted in newRow via _preAggAliases skip).
    if (hasAgg && aggCols.some(ac => ac.rows.length > 0)) {
      const aggRow: Record<string, unknown> = {}
      for (const ac of aggCols) {
        aggRow[ac.alias] = ac.rows  // collect → 整个数组
      }
      // 保留非聚合列（取第一行的值即可）
      if (rows.length > 0) {
        for (const key of Object.keys(rows[0])) {
          if (!(key in aggRow)) {
            aggRow[key] = rows[0][key]
          }
        }
      }
      rows = [aggRow]
    }
  }


  // If no rows but an aggregate WITH was defined, inject a default row.
  // Cypher semantics: aggregation without grouping always returns 1 row.
  if (!rows.length && plan.with?.columns?.length && plan.aggregate) {
    rows = [{}]
  }

  // 如果 WITH 中没有投影列但 rows 不为空，保持现有 row
  if (!plan.with?.columns?.length && !rows.length && !plan.unwind) {
    rows = [{}]
  }

  // ── MATCH 扫描 + WHERE 过滤（管道变量注入模式）──
  // `WITH collect(...) UNWIND ... WITH expected AS x MATCH (n) WHERE ... RETURN n`
  // 在物化中间变量（如 expected）后，还需执行 MATCH 扫描并用 whereBody 过滤。
  // 仅当：(a) 查询以 WITH/UNWIND 开头（管道变量注入，而非 GE 负责的 MATCH 聚合投影）；
  // (b) 无遍历步骤（MATCH (n) 单节点扫描）；(c) 存在 whereBody。此精确条件避免
  // 误伤 Comparison2/List12 等以 MATCH 开头的多步查询（它们由 GE 处理）。
  const _pipelineStartsVarInjection = !!query && /^\s*(?:WITH|UNWIND)\b/is.test(query)
  if (_pipelineStartsVarInjection && plan.hasMatch && !plan.aggregate && plan.steps?.length === 0 && plan.whereBody) {
    // 提取 MATCH 变量名：从 RETURN/表达式列中的节点变量，回退到 query 正则
    let matchVar = ''
    if (query) {
      const mm = query.match(/MATCH\s*\((\w+)/i)
      if (mm) matchVar = mm[1]
    }
    if (!matchVar && plan.expressionColumns?.length) {
      for (const ec of plan.expressionColumns) {
        const e = typeof ec.expression === 'string' ? ec.expression : ''
        if (/^[a-zA-Z_]\w*$/.test(e)) { matchVar = e; break }
      }
    }
    if (!matchVar && plan.returnColumns?.length) {
      const rc = plan.returnColumns.find(c => /^[a-zA-Z_]\w*$/.test(c) && c !== 'true' && c !== 'false' && c !== 'null')
      if (rc) matchVar = rc
    }
    const candidateNodes: any[] = (_nodes?.length ? _nodes : [])
    let matchedRows: Array<Record<string, unknown>> = []
    for (const row of rows) {
      const evalCtxBase: Record<string, unknown> = { ...varCtx, ...row }
      if (candidateNodes.length === 0) continue
      for (const node of candidateNodes) {
        const evalCtx: Record<string, unknown> = { ...evalCtxBase }
        if (matchVar) evalCtx[matchVar] = node
        const val = _evaluateExpression(plan.whereBody!, evalCtx)
        if (val === true) {
          const outRow: Record<string, unknown> = { ...row }
          if (matchVar) outRow[matchVar] = node
          matchedRows.push(outRow)
        }
      }
    }
    rows = matchedRows
  }

  // ── RETURN 列映射 ──
  if (plan.expressionColumns?.length && rows.length) {
    rows = rows.map(row => {
      const newRow: Record<string, unknown> = { ...row }
      const evalCtx: Record<string, unknown> = { ...varCtx, ...row }
      for (const ec of plan.expressionColumns) {
        if (typeof ec.expression === 'string' && ec.expression in evalCtx) {
          newRow[ec.alias] = evalCtx[ec.expression]
        } else {
          const val = typeof ec.expression === 'string' ? _evaluateExpression(ec.expression, evalCtx) : null
          newRow[ec.alias] = val !== undefined ? val : null
        }
      }
      return newRow
    })
  }

  // ── WITH WHERE 过滤 ──
  // WITH ... WHERE 的过滤在 parseQuery 中没有被提取到 filters。
  // 从原始 query 文本提取最后一个 WITH 的 WHERE 子句，用表达式引擎逐行过滤。
  if (query && !plan.aggregate && rows.length > 1) {
    let whereText = ''
    // 对于多级 WITH，提取最后一个 WITH 的 WHERE（如 WHERE result）
    if (plan.unwind || plan.hasMatch) {
      const withParts = query.split(/\bWITH\s+/i).filter(Boolean)
      if (withParts.length > 1) {
        const lastWith = withParts[withParts.length - 1]
        const whereMatch = lastWith.match(/\bWHERE\s+(.+?)(?:\s+(?:RETURN|WITH|CREATE|MERGE|SET|DELETE|ORDER\s+BY|SKIP|LIMIT)\s|$)/is)
        if (whereMatch && !whereMatch[1].includes('[')) whereText = whereMatch[1].trim()
      }
    }
    // Fallback：全局第一个 WHERE（用于无多级 WITH 的场景）
    if (!whereText) {
      const globalWhereMatch = query.match(/\bWHERE\s+(.+?)(?:\s+(?:RETURN|WITH|CREATE|MERGE|SET|DELETE|ORDER\s+BY|SKIP|LIMIT)\s|$)/is)
      if (globalWhereMatch && !globalWhereMatch[1].includes('[')) whereText = globalWhereMatch[1].trim()
    }
    if (whereText) {
      // 有 MATCH 的 WHERE 由 MATCH 路径处理（hasMatch=true），只有无 MATCH 的 WITH WHERE 才在此处理
      // 但 pipeline 中的 WITH WHERE（如 WHERE result）需在此处理，不受 hasMatch 影响
      if (!plan.hasMatch || (plan.hasMatch && plan.unwind)) {
        rows = rows.filter(row => {
          const val = _evaluateExpression(whereText, row)
          return val === true
        })
      }
    }
  }

  // Step 4: 聚合（count/sum/avg/max/min）
  // Only run if plan.with.columns aggregate projection (Step 3) didn't already handle it.
  if (plan.aggregate && !plan.with?.columns?.length) {
    const agg = plan.aggregate as any
    const aggFn = (agg.function || agg.type || '').toLowerCase()
    const aggAlias = agg.alias || (agg.column && agg.column.replace(/^.+?\s+AS\s+/i, '').trim()) || agg.field || agg.column || 'count(*)'

    // 从聚合列提取字段名：count(*)=*, count(v)=v
    const colMatch = (agg.column || '').match(/^\w+\((.+?)\)(?:\s+AS\s+\w+)?$/i)
    const field = colMatch ? colMatch[1] : (agg.field || '*')

    if (aggFn === 'count') {
      if (field === '*') {
        // count(*): 行数
        return [{ [aggAlias]: rows.length }]
      }
      // count(expr): 非 null 行数
      const nonNull = rows.filter(r => {
        const v = r[field]
        return v !== null && v !== undefined
      })
      return [{ [aggAlias]: nonNull.length }]
    }

    // sum/avg/min/max: 从 field 收集数值
    const values = rows
      .map(r => r[field])
      .filter((v: unknown) => v !== null && v !== undefined)
      .map(Number)
      .filter((v: number) => !isNaN(v))

    switch (aggFn) {
      case 'collect':
        // collect(expr): gather all values into a list
        const collected = rows.map(r => r[field]).filter((v: unknown) => v !== null && v !== undefined)
        return [{ [aggAlias]: collected }]
      case 'sum':
        return [{ [aggAlias]: values.reduce((a: number, b: number) => a + b, 0) }]
      case 'avg':
        return [{ [aggAlias]: values.length ? values.reduce((a: number, b: number) => a + b, 0) / values.length : 0 }]
      case 'max':
        return [{ [aggAlias]: values.length ? Math.max(...values) : 0 }]
      case 'min':
        return [{ [aggAlias]: values.length ? Math.min(...values) : 0 }]
      default:
        return [{ [aggAlias]: 0 }]
    }
  }

  // Step 5: RETURN 列映射
  if (plan.returnColumns?.length) {
    return rows.map(row => {
      const out: QueryRow = {}
      for (let i = 0; i < plan.returnColumns.length; i++) {
        const rc = plan.returnColumns[i]
        if (!rc) continue
        // 查找 returnAliasMap 原始表达式
        let expr = plan.returnAliasMap?.[rc.replace(/^\w+\./, '')] || rc
        // 括号表达式属性访问：(list[1]).existing 或 (expr).prop
        // ANTLR 把 (list[1]).existing 拆成 returnColumn = "existing"（仅属性名）
        // 而 expressionColumns[i].expression 是完整表达式
        if (expr === rc && plan.expressionColumns?.[i]?.expression && plan.expressionColumns[i].expression !== rc) {
          expr = plan.expressionColumns[i].expression
        }
        const val = _evaluateExpression(expr, row)
        out[rc] = val !== null && val !== undefined ? val : null
      }
      return out
    })
  }

  return rows
}

/**
 * 括号感知的逗号分割：将 WITH/RETURN column 列表分割为独立列。
 * 避免 split(',') 把函数调用内的逗号误分割：coalesce(fixedList, list) AS list
 */

