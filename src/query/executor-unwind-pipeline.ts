/**
 * executor-unwind-pipeline.ts — WITH/UNWIND/aggregate 管道执行
 *
 * 从 query-executor.ts 拆分。
 */

import type { QueryPlan } from './query-types'
import { _evaluateExpression, _compareOrderByValue } from './expression-engine'
import type { QueryRow } from './expression-engine'
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
      // Only pre-evaluate *aggregate* expressions here.  A non-aggregate
      // projection such as `n.num AS num` (a property access, or a bare
      // variable forward) must be evaluated per-row against a single node,
      // not against the whole match array that `varCtx[stepSrc]` holds at this
      // stage; doing so turns `n` into an array and throws "Property access on
      // non-map type".  Those per-row projections are handled downstream by the
      // unwind/aggregation steps.
      if (!/^\s*(collect|count|sum|avg|max|min|stdev|stdevp|percentilecont|percentiledisc|percentileCont|percentileDisc)\s*\(/i.test(expr)) continue
      let val: unknown
      // `collect(row)` over a MATCH variable that varCtx already holds as an
      // array must FLATTEN — the variable is the full match result, so collect
      // should return that array directly rather than wrapping it as a single
      // element (`[[...]]`).  `_evaluateExpression`'s scalar collect() would
      // wrap it, breaking `UNWIND rows AS node RETURN node.id`.
      const collectM = expr.match(/^\s*collect\s*\(\s*([a-zA-Z_]\w*)\s*\)\s*$/i)
      if (collectM) {
        // If the alias was already folded upstream (e.g. `_groupAggregateWithRows`
        // collapsed the MATCH rows and stored `rows = [node1, node2]`), do not
        // re-collect from a single-node `varCtx[inner]` — that would overwrite the
        // collapsed list with a one-element list (`[node1]`) and truncate the
        // downstream UNWIND.
        if (Array.isArray(varCtx[alias]) && varCtx[alias].length > 0) {
          val = varCtx[alias]
        } else {
          const inner = varCtx[collectM[1]]
          val = Array.isArray(inner) ? inner : (inner == null ? [] : [inner])
        }
      } else {
        val = _evaluateExpression(expr, varCtx)
      }
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

/**
 * Compare two Cypher values for max/min aggregation, returning a deterministic
 * total order (-1, 0, 1).  Follows the Cypher value hierarchy for cross-type
 * comparisons — list < string < boolean < number — and within-type rules
 * (numeric order, lexicographic strings/lists).
 */
function _aggCompare(a: unknown, b: unknown): number {
  if (a === b) return 0
  const ra = _aggTypeRank(a), rb = _aggTypeRank(b)
  if (ra !== rb) return ra < rb ? -1 : 1
  if (Array.isArray(a) && Array.isArray(b)) {
    const minLen = Math.min(a.length, b.length)
    for (let i = 0; i < minLen; i++) {
      const c = _aggCompare(a[i], b[i])
      if (c !== 0) return c
    }
    return a.length - b.length
  }
  if (ra === 3) return (a as number) < (b as number) ? -1 : 1 // numbers/bigint
  if (ra === 1) return (a as string) < (b as string) ? -1 : 1 // strings
  return String(a) < String(b) ? -1 : 1 // fallback (booleans)
}

/** Type rank for aggregation: list=0, string=1, boolean=2, number=3. */
function _aggTypeRank(v: unknown): number {
  if (Array.isArray(v)) return 0
  const t = typeof v
  if (t === 'string') return 1
  if (t === 'boolean') return 2
  if (t === 'number' || t === 'bigint') return 3
  return 0 // maps/other structures — treat as list rank (least)
}

/**
 * Compute the final value of an aggregate WITH projection column from the
 * per-row values collected by Step 3.  `collect` returns the raw list; the
 * scalar aggregates reduce the list (count counts non-null values, sum/avg
 * accumulate numbers, max/min pick the extreme via the Cypher value hierarchy).
 */
function _computeAggregate(fn: string, rows: unknown[]): unknown {
  switch (fn) {
    case 'collect':
      return rows
    case 'count': {
      // count(v) counts non-null values; count(*) pushes a literal 1 per row so
      // its length already equals the row count (nulls never appear).
      return rows.filter(v => v !== null && v !== undefined).length
    }
    case 'sum': {
      const nums = rows.filter((v): v is number | bigint => typeof v === 'number' || typeof v === 'bigint')
      if (!nums.length) return 0
      return nums.reduce((a, b) => (a as any) + (b as any), 0)
    }
    case 'avg': {
      const nums = rows.filter((v): v is number | bigint => typeof v === 'number' || typeof v === 'bigint')
      if (!nums.length) return 0
      return nums.reduce<number>((a, b) => Number(a) + Number(b), 0) / nums.length
    }
    case 'max':
    case 'min': {
      const comparable = rows.filter((v: unknown) => v !== null && v !== undefined)
      if (!comparable.length) return null
      let best = comparable[0]
      for (let i = 1; i < comparable.length; i++) {
        const cmp = _aggCompare(comparable[i], best)
        if (fn === 'max' ? cmp > 0 : cmp < 0) best = comparable[i]
      }
      return best
    }
    default:
      return rows
  }
}

/**
 * Materialize cross-row `collect(...)` aggregations nested inside RETURN
 * expressions, collapsing the result to a single aggregated row.
 *
 * The per-row expression engine `collect` kernel is single-row (it wraps one
 * value in a list).  When a RETURN expression nests `collect` inside a list
 * predicate — e.g. `ALL(ok IN collect((size(list)=0)=empty) WHERE ok)` — the
 * collect must gather over *all* rows before the predicate is evaluated.
 * Returns `null` when no cross-row collect is present (so Step 5 proceeds
 * normally), otherwise returns the single aggregated row set.
 */

/**
 * True when any RETURN expression is an aggregate wrapped in an outer function
 * (`size(collect(x))`, `toInteger(count(n))`, ...), rather than a *pure*
 * top-level aggregate call (`collect(x)` / `count(n)`).  Nested aggregates must
 * go through the cross-row materialisation so the outer wrapper operates on the
 * folded list, not on a single row.
 */
function _hasNestedAggregateExpr(plan: QueryPlan): boolean {
  const cols = plan.expressionColumns || []
  if (!cols.length) return false
  return cols.some(c => {
    const expr = (c.expression || '').trim()
    // Pure aggregate: the whole expression is one aggregate call (optionally
    // with a trailing AS alias). Nested otherwise.
    return /^[a-z_]+\(/i.test(expr) && !/^(count|sum|avg|max|min|collect|stdev|stdevp|percentilecont|percentiledisc)\s*\(/i.test(expr)
      && /\b(count|sum|avg|max|min|collect)\s*\(/i.test(expr)
  })
}

function _materializeReturnAggregates(
  plan: QueryPlan,
  rows: Array<Record<string, unknown>>,
  varCtx: Record<string, unknown>
): Array<Record<string, unknown>> | null {
  // Only materialize cross-row collect when the parser did NOT synthesize a
  // *pure* top-level plan.aggregate.  A top-level `collect(x) AS y` /
  // `count(x) AS y` already sets plan.aggregate (and is handled downstream by
  // Step 4); we must not collapse those rows here, or we would change their
  // (already-broken but distinct) top-level-aggregation semantics.
  //
  // A *nested* aggregate (`size(collect(x))`) also sets plan.aggregate (its
  // parser probe records the inner `collect`), but it must NOT be short-
  // circuited here: the outer `size(...)` wrapper needs the cross-row list
  // materialised first, then applied on top.  Detect the nesting by checking
  // whether any RETURN expression is a pure aggregate call vs. an aggregate
  // wrapped in an outer function.
  if (plan.aggregate && !_hasNestedAggregateExpr(plan)) return null
  const exprCols = (plan.expressionColumns || [])
  let hasCrossRowCollect = false
  const matExprs: Array<{ alias: string; expr: string }> = []
  for (const ec of exprCols) {
    const expr = typeof ec.expression === 'string' ? ec.expression : ''
    if (!expr) continue
    // `collect(` that is not a literal-list builder (`collect([...])`).
    if (/\bcollect\s*\(/i.test(expr) && !/\bcollect\s*\(\s*\[/i.test(expr)) {
      hasCrossRowCollect = true
    }
    matExprs.push({ alias: ec.alias || '', expr })
  }
  if (!hasCrossRowCollect || rows.length === 0) return null

  // Collapse to one aggregate row.  Aggregate semantics without an explicit
  // grouping key yield a single row; non-aggregate columns take the first
  // row's value.
  const base: Record<string, unknown> = { ...rows[0] }

  for (const { alias, expr } of matExprs) {
    if (!alias) continue
    base[alias] = _evalExprWithCrossRowCollect(expr, rows, varCtx)
  }
  return [base]
}

/**
 * Evaluate an expression whose `collect(...)` calls gather over `rows`
 * (rather than the current single row).  Each `collect(inner)` is expanded to
 * its collected list literal before the surrounding expression is evaluated.
 */
function _evalExprWithCrossRowCollect(
  expr: string,
  rows: Array<Record<string, unknown>>,
  varCtx: Record<string, unknown>
): unknown {
  // Replace every `collect(...)` (parenthesis-aware, skipping `collect([...])`
  // literal builders) with the list of inner values gathered across all rows.
  let expanded = expr
  let idx = 0
  while (true) {
    const m = /\bcollect\s*\(/i.exec(expanded.slice(idx))
    if (!m) break
    const collectStart = idx + m.index
    const openParen = collectStart + m[0].length - 1
    // Skip literal-list builders `collect([...])`.
    if (/^\s*\[/.test(expanded.slice(openParen + 1))) {
      idx = openParen + 1
      continue
    }
    // Find the matching close parenthesis (depth-aware).
    let depth = 0
    let closeParen = -1
    let inStr = false
    let strChar = ''
    for (let i = openParen; i < expanded.length; i++) {
      const ch = expanded[i]
      if (inStr) {
        if (ch === '\\') { i++; continue }
        if (ch === strChar) inStr = false
        continue
      }
      if (ch === "'" || ch === '"') { inStr = true; strChar = ch; continue }
      if (ch === '(') depth++
      else if (ch === ')') { depth--; if (depth === 0) { closeParen = i; break } }
    }
    if (closeParen < 0) break
    const inner = expanded.slice(openParen + 1, closeParen)
    const collected: unknown[] = []
    for (const row of rows) {
      const val = _evaluateExpression(inner, { ...varCtx, ...row })
      collected.push(val)
    }
    expanded = expanded.slice(0, collectStart) +
      _jsonLiteral(collected) +
      expanded.slice(closeParen + 1)
    idx = collectStart + 1
  }
  return _evaluateExpression(expanded, { ...varCtx, ...rows[0] })
}

/** Serialize a collected list of Cypher values to a re-evaluable literal. */
function _jsonLiteral(values: unknown[]): string {
  if (values.length === 0) return '[]'
  return '[' + values.map(v => {
    if (typeof v === 'string') return JSON.stringify(v)
    if (v === null || v === undefined) return 'null'
    if (typeof v === 'bigint') return v.toString()
    return String(v)
  }).join(', ') + ']'
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
    // Detect a multi-variable MATCH such as `MATCH (a:A), (b:B)`. In that case
    // every variable must be bound to its own label-filtered node (a single
    // node, not the whole array), otherwise a pattern comprehension like
    // `[p = (a)-[*]->(b) | p]` receives the full node array as `a` and fails to
    // resolve the source node.
    const multiVars = query
      ? [...query.matchAll(/\(\s*([A-Za-z_]\w*)\s*:\s*([A-Za-z_]\w*)\s*\)/g)].map(mm => ({ name: mm[1], label: mm[2] }))
      : []
    if (multiVars.length >= 2) {
      for (const { name, label } of multiVars) {
        if (name in varCtx) continue
        const target = _nodes.find((n: any) => {
          const fullLabel = n?.__fullLabel || n?._label || ''
          const labels = String(fullLabel).replace(/^:/, '').split(':').filter(Boolean)
          return labels.includes(label) || String(n?._label) === label
        })
        if (target !== undefined) varCtx[name] = target
      }
    } else {
      // Try to get the variable name from plan.steps, then fall back to query regex
      let stepSrc: string | undefined = plan.steps?.[0]?.source
      if (!stepSrc && query) {
        const matchMatch = query.match(/MATCH\s*\((\w+)\b/i)
        stepSrc = matchMatch?.[1]
      }
      if (stepSrc) {
        // Only inject the MATCH variable when the caller has not already bound
        // it.  In the MATCH+UNWIND pipeline the caller passes `initialVarCtx`
        // with the correct `n → node` binding (from `__crossVarRows` or the
        // fallback) and `_nodes` here is `[matchVarCtx]` — overwriting would nest
        // the node as `{ n: node }` and break `n.prop` projection.
        if (!(stepSrc in varCtx)) {
          // For aggregation like collect(a), inject all matching nodes
          // Use array for collect() compatibility
          varCtx[stepSrc] = _nodes.length === 1 ? _nodes[0] : _nodes
        }
      }
    }
  }

  // Pre-process aggregate WITH clauses (e.g., WITH collect(a) AS nodes) before
  // UNWIND expansion.  The UNWIND list variable often depends on the aggregate
  // result (e.g., UNWIND nodes AS n), so we must evaluate aggregate WITH first
  // and inject the result into varCtx before the UNWIND step resolves its list.
  const _preAggAliases = new Set<string>()
  // Aggregate projections already folded by the per-UNWIND middle-WITH pass.
  // Step 3 must not re-fold these (they were collapsed into a single `rows`
  // value before the next UNWIND expanded it), otherwise the downstream
  // UNWIND-produced columns are dropped.
  const _middleWithAggAliases = new Set<string>()
  const _hasWithAgg = !!((plan as any).with?.aggregate || (plan as any).with?.aggregates?.length)
  if (plan.hasMatch && plan.with && query &&
      (plan.aggregate || _hasWithAgg || plan.type === 'SET' || plan.type === 'DELETE')) {
    _preProcessAggregateWith(varCtx, _preAggAliases, plan, query, _nodes)
  }

  // Materialize WITH projections before the first UNWIND.  These are not
  // aggregate clauses and are otherwise dropped.  Two cases need this:
  //   * pure WITH/UNWIND (no MATCH): `WITH values, size(values) AS numOfValues`
  //     must expose numOfValues to a later RETURN range(0, numOfValues-1);
  //   * MATCH + WITH + UNWIND: `MATCH p=(n)-[r]->() WITH [n,r,p,...] AS types
  //     UNWIND range(0, size(types)-1) AS i` — `types` must be materialized
  //     before UNWIND resolves `size(types)`, otherwise it is undefined and
  //     `range` throws ArgumentError.
  // The prefix slice below already stops at the first UNWIND, so only the
  // pre-UNWIND projections are materialized in both cases.
  if (query && plan.unwind) {
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

    // 补充提取：`WITH <表达式> AS var`（如 WITH collect([0, 0.0]) AS numbers 或
    // WITH {name: {name2: 'baz'}} AS nestedMap）。上述列表字面量扫描只覆盖
    // `WITH [...] AS var` 裸列表，无法识别函数包裹的列表（collect(...)、range(...)
    // 等）或 map 字面量。此类表达式需物化到 varCtx，供后续 `UNWIND ... AS arr` 或
    // `RETURN nestedMap.name.name2` 解析。仅处理以 WITH 开头的查询——以 MATCH 开头
    // 的聚合投影由 GE 负责。
    {
      const withExprMatch = query.match(/^WITH\s+(\S.*?)\s+AS\s+(\w+)\b/is)
      if (withExprMatch) {
        const expr = withExprMatch[1].trim()
        const alias = withExprMatch[2]
        if (!(alias in varCtx)) {
          // 跳过已由上方列表字面量扫描处理的裸列表（`WITH [...] AS v`）。
          if (!/^\s*\[/.test(expr)) {
            const val = _evaluateExpression(expr, varCtx)
            if (val != null || Array.isArray(val)) varCtx[alias] = val
          }
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
    // `s` flag is essential: the first UNWIND's list literal often spans
    // multiple lines in TCK fixtures (e.g. `UNWIND [{list: [2], ...},\n
    // {list: [6], ...}] AS input`).  Without it, `.+?` stops at the first
    // newline, the first UNWIND is never matched, and `allMatches[i]` shifts
    // by one — silently rewriting `plan.unwinds[0].name` (the real alias) to
    // the *second* UNWIND's alias, corrupting the whole pipeline.
    const allMatches = [...query.matchAll(/\bUNWIND\s+(.+?)\s+AS\s+(\w+)/gis)]
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
      // 对当前 rows 中的每一行，展开当前 UNWIND
      if (rows.length === 0) {
        // 初始行：用 varCtx 解析列表，直接展开
        const items = _resolveUnwindList(u, varCtx)
        const unwrapped = (Array.isArray(items) ? items : [items]).map(item => {
          if (typeof item === 'string' && item.startsWith('{') && item.endsWith('}')) {
            const parsed = _evaluateExpression(item, varCtx)
            if (parsed != null && typeof parsed === 'object') return parsed
          }
          return item
        })
        rows = unwrapped.map(item => ({ [u.name]: item }))
      } else {
        // 已有多行：每行做笛卡尔积展开。第二层（及以后）UNWIND 的列表源可能是
        // 索引式表达式（`UNWIND qrows[p] AS q`），其值依赖于**当前行**绑定的一层
        // 变量 `p`，因此必须逐行用 `{...varCtx, ...row}` 解析列表，而非复用统一
        // 的 varCtx（后者只含 rows[0] 的绑定，会把 qrows[p] 恒解析为 qrows[0]）。
        const newRows: Array<Record<string, unknown>> = []
        for (const row of rows) {
          const rowCtx: Record<string, unknown> = { ...varCtx, ...row }
          const rowItems = _resolveUnwindList(u, rowCtx)
          const rowUnwrapped = (Array.isArray(rowItems) ? rowItems : [rowItems]).map(item => {
            if (typeof item === 'string' && item.startsWith('{') && item.endsWith('}')) {
              const parsed = _evaluateExpression(item, rowCtx)
              if (parsed != null && typeof parsed === 'object') return parsed
            }
            return item
          })
          for (const item of rowUnwrapped) {
            newRows.push({ ...row, [u.name]: item })
          }
        }
        rows = newRows
      }
      // 如果当前层 UNWIND 后还有中间 WITH 投影（非列表字面量的 WITH）
      // 从 query 文本提取对应于此层 UNWIND 之后的中间 WITH 并应用。
      // Only up to the *second-to-last* UNWIND: the WITH clauses after the final
      // UNWIND are `plan.with` (handled by Step 3), not per-UNWIND intermediate
      // projections.  Folding them here (e.g. `WITH any(...) AS result,
      // count(*) AS cnt`) would mark `cnt` as an already-folded middle-WITH
      // aggregate, making Step 3 skip it and leak one row per pre-fold group.
      if (query && ui < plan.unwinds.length - 1) {
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
        const nextUnwindPos = nextUnwindSearch.search(/\bUNWIND\s+/i)
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
            // Detect whether this WITH projection carries an aggregate
            // (`collect(row)`), which must fold across ALL current rows into a
            // single row — not be evaluated per row (which would produce
            // `collect` of a single element on each row and then only keep the
            // first row's result, truncating the list).
            const aggCols = columns.map(c => {
              const eqIdx = c.search(/\s+AS\s+/i)
              const expr = eqIdx >= 0 ? c.substring(0, eqIdx).trim() : c.trim()
              const alias = eqIdx >= 0 ? c.substring(eqIdx + 3).trim().replace(/\s+$/, '') : expr
              const am = /^\s*(collect|count|sum|avg|max|min)\s*\(([\s\S]*)\)\s*$/i.exec(expr)
              if (!am) return null
              return { fn: am[1].toLowerCase(), args: am[2].trim(), alias, expr }
            }).filter(Boolean) as Array<{ fn: string; args: string; alias: string; expr: string }>
            if (aggCols.length) {
              // Aggregate fold: each aggregate column is computed over the whole
              // current row set.  When the WITH also carries non-aggregate columns
              // (`WITH p, count(q) AS rng`), those columns are the implicit GROUP
              // BY keys — the aggregate must be folded *per group* (one output row
              // per distinct key tuple), not collapsed into a single global row
              // (which drops `p = 1` and truncates a later ORDER BY to `p = 0`).
              const aggAliases = new Set(aggCols.map(ac => ac.alias))
              const groupKeyCols = columns.filter(c => {
                const eqIdx = c.search(/\s+AS\s+/i)
                const key = (eqIdx >= 0 ? c.substring(eqIdx + 3).trim() : c.trim()).replace(/\s+$/, '')
                return !aggAliases.has(key) && key.length > 0
              })
              if (groupKeyCols.length) {
                const grouped = new Map<string, { keyVals: Record<string, unknown>; src: Record<string, unknown> }>()
                const groupedOrder: string[] = []
                for (const row of rows) {
                  const evalCtx: Record<string, unknown> = { ...varCtx, ...row }
                  const keyVals: Record<string, unknown> = {}
                  for (const kc of groupKeyCols) {
                    const eqIdx = kc.search(/\s+AS\s+/i)
                    const expr = (eqIdx >= 0 ? kc.substring(0, eqIdx).trim() : kc.trim())
                    const alias = (eqIdx >= 0 ? kc.substring(eqIdx + 3).trim() : kc).replace(/\s+$/, '')
                    keyVals[alias] = _evaluateExpression(expr, evalCtx)
                  }
                  const keyStr = JSON.stringify(keyVals)
                  if (!grouped.has(keyStr)) {
                    grouped.set(keyStr, { keyVals, src: row })
                    groupedOrder.push(keyStr)
                  }
                }
                const newRows: Array<Record<string, unknown>> = []
                for (const keyStr of groupedOrder) {
                  const { keyVals } = grouped.get(keyStr)!
                  const aggRow: Record<string, unknown> = { ...keyVals }
                  for (const ac of aggCols) {
                    const vals: unknown[] = []
                    for (const row of rows) {
                      const evalCtx: Record<string, unknown> = { ...varCtx, ...row }
                      const rowKey: Record<string, unknown> = {}
                      for (const kc of groupKeyCols) {
                        const eqIdx = kc.search(/\s+AS\s+/i)
                        const expr = (eqIdx >= 0 ? kc.substring(0, eqIdx).trim() : kc.trim())
                        const alias = (eqIdx >= 0 ? kc.substring(eqIdx + 3).trim() : kc).replace(/\s+$/, '')
                        rowKey[alias] = _evaluateExpression(expr, evalCtx)
                      }
                      if (JSON.stringify(rowKey) !== keyStr) continue
                      if (ac.fn === 'count' && ac.args === '*') { vals.push(row); continue }
                      vals.push(_evaluateExpression(ac.args, evalCtx))
                    }
                    aggRow[ac.alias] = _computeAggregate(ac.fn, vals)
                    _middleWithAggAliases.add(ac.alias)
                  }
                  newRows.push(aggRow)
                }
                rows = newRows
              } else {
                const aggRow: Record<string, unknown> = {}
                for (const ac of aggCols) {
                  const vals: unknown[] = []
                  for (const row of rows) {
                    const evalCtx: Record<string, unknown> = { ...varCtx, ...row }
                    if (ac.fn === 'count' && ac.args === '*') { vals.push(row); continue }
                    vals.push(_evaluateExpression(ac.args, evalCtx))
                  }
                  aggRow[ac.alias] = _computeAggregate(ac.fn, vals)
                  _middleWithAggAliases.add(ac.alias)
                }
                rows = [aggRow]
              }
            } else {
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
            }
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
      // The second UNWIND source may be indexed by the outer variable
      // (`UNWIND qrows[p] AS q`), so it must be resolved per-item with `p`
      // bound, not once against the bare `varCtx` (where `p` is undefined).
      for (const item1 of resolvedList1) {
        const innerCtx: Record<string, unknown> = { ...varCtx, [plan.unwind.name!]: item1 }
        const list2 = _resolveUnwindList(plan.secondUnwind, innerCtx).map(item => {
          if (typeof item === 'string' && item.startsWith('{') && item.endsWith('}')) {
            const parsed = _evaluateExpression(item, innerCtx)
            if (parsed != null && typeof parsed === 'object') return parsed
          }
          return item
        })
        const list2Arr = Array.isArray(list2) ? list2 : [list2]
        for (const item2 of list2Arr) {
          const row: Record<string, unknown> = { [plan.unwind.name]: item1 }
          row[plan.secondUnwind.name] = item2
          rows.push(row)
        }
      }
    } else {
      // 单 UNWIND
      rows = resolvedList1.map((item: unknown) => ({ [plan.unwind!.name!]: item }))
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
          (target as Record<string, unknown>)[sc.property] = parsedVal
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
    const withColumns = plan.with.columns
    const aggFnPattern = /^\s*(collect|count|sum|avg|max|min)\s*\(/i
    const isAggCol: boolean[] = withColumns.map(col => {
      const expr = typeof col.expression === 'string' ? col.expression : ''
      const alias = col.alias || expr
      // A middle-WITH aggregate already folded by the UNWIND loop must not be
      // re-folded here (its value is already the collapsed list on each row).
      if (_middleWithAggAliases.has(alias)) return false
      return aggFnPattern.test(expr)
    })
    const hasAgg = isAggCol.some(Boolean)
    const aggCols: Array<{ alias: string; fn: string; rows: unknown[] }> = []
    // Grouping keys = the non-aggregate projection columns.  Their aliases carve
    // the UNWIND rows into groups, so `WITH p, count(q) AS rng` folds per `p`
    // (p=0 → count 1, p=1 → count 2) instead of a single global count.
    // Only a *bare* variable / property reference is a genuine grouping key.  A
    // scalar function expression (`WITH any(x IN list WHERE false) AS result,
    // count(*) AS cnt`) is NOT a group key — it is evaluated once over the
    // folded row set (the aggregate collapses all rows to one), so folding by
    // `result` would wrongly split the single group into multiple rows.
    const groupKeyAliases: string[] = []
    const scalarExprCols: Array<{ alias: string; expr: string }> = []
    if (hasAgg) {
      for (let i = 0; i < withColumns.length; i++) {
        const col = withColumns[i]
        const colExpr = typeof col.expression === 'string' ? col.expression : ''
        const alias = col.alias || colExpr
        if (isAggCol[i]) {
          const fnMatch = colExpr.match(/^\s*(collect|count|sum|avg|max|min)\s*\(/i)
          aggCols.push({
            alias,
            fn: fnMatch ? fnMatch[1].toLowerCase() : 'collect',
            rows: [],
          })
        } else {
          // A bare identifier / property reference is a grouping key; anything
          // else (function call, arithmetic, CASE, etc.) is a scalar projection
          // evaluated after the fold.
          if (/^[a-zA-Z_]\w*(\.[a-zA-Z_]\w*)?$/.test(colExpr)) {
            groupKeyAliases.push(alias)
          } else {
            scalarExprCols.push({ alias, expr: colExpr })
          }
        }
      }
    }
    // Grouped aggregation: map from a stringified grouping-key tuple to the
    // per-column accumulated aggregate inputs plus a representative output row.
    const grouped = new Map<string, { aggRows: unknown[][]; groupVals: Record<string, unknown> }>()
    const groupedOrder: string[] = []
    rows = rows.map(row => {
      const newRow: Record<string, unknown> = { ...row }
      const evalCtx: Record<string, unknown> = { ...varCtx, ...row }
      // Compute this row's grouping key now (before projection) so the
      // non-aggregate columns here reflect the UNWIND-expanded bindings.
      const _gk = hasAgg ? groupKeyAliases.map(k => {
        const v = evalCtx[k]
        return v && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '__NULL__')
      }).join('\u0000') : ''
      let aggIdx = 0
      for (let i = 0; i < withColumns.length; i++) {
        const col = withColumns[i]
        const alias = col.alias || (typeof col.expression === 'string' ? col.expression : '')
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
            const v = val !== undefined ? val : null
            aggCols[aggIdx].rows.push(v)
            // Also accumulate per-group so the final fold can group by the
            // non-aggregate keys.
            if (hasAgg && groupKeyAliases.length) {
              if (!grouped.has(_gk)) {
                const gv: Record<string, unknown> = {}
                for (const ka of groupKeyAliases) gv[ka] = evalCtx[ka]
                grouped.set(_gk, { aggRows: aggCols.map(() => [] as unknown[]), groupVals: gv })
                groupedOrder.push(_gk)
              }
              grouped.get(_gk)!.aggRows[aggIdx].push(v)
            }
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
            const val = _evaluateExpression(col.expression, evalCtx)
            newRow[alias] = val !== undefined ? val : null
            continue
          }
          if (col.alias === null && typeof col.expression === 'string' && col.expression in evalCtx) {
            newRow[col.expression] = evalCtx[col.expression]
            continue
          }
          // 非字符串表达式的结构化字面量（如 {type:"LIST",...}）：直接求值
          const val = _evaluateExpression(col.expression, evalCtx)
          const key = col.alias || (typeof col.expression === 'string' ? col.expression : '')
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
      if (groupKeyAliases.length && groupedOrder.length) {
        // Grouped aggregation: one output row per non-aggregate key tuple.
        const grpRows: Array<Record<string, unknown>> = []
        for (const gk of groupedOrder) {
          const g = grouped.get(gk)!
          const out: Record<string, unknown> = { ...g.groupVals }
          for (let ci = 0; ci < aggCols.length; ci++) {
            out[aggCols[ci].alias] = _computeAggregate(aggCols[ci].fn, g.aggRows[ci])
          }
          grpRows.push(out)
        }
        rows = grpRows
      } else {
        const aggRow: Record<string, unknown> = {}
        for (const ac of aggCols) {
          aggRow[ac.alias] = _computeAggregate(ac.fn, ac.rows)
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
    const matchedRows: Array<Record<string, unknown>> = []
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
      for (const ec of plan.expressionColumns ?? []) {
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
        // Bracket-aware: exclude the WHERE inside a list predicate
        // (`[x IN ... WHERE ...]` or `ALL(... WHERE ...)`), which is not a
        // WITH-WHERE filter.  Otherwise `RETURN ALL(ok IN collect(...) WHERE ok)`
        // would treat `WHERE ok` as a top-level WITH-WHERE and wipe every row.
        const wherePos = _findWhereOutsideBrackets(lastWith)
        if (wherePos >= 0) {
          const whereBody = lastWith.substring(wherePos + 6).trim()
          const endMatch = whereBody.match(/\b(?:RETURN|WITH|CREATE|MERGE|SET|DELETE|ORDER\s+BY|SKIP|LIMIT|UNWIND)\b/i)
          whereText = endMatch ? whereBody.substring(0, endMatch.index).trim() : whereBody.trim()
        }
      }
    }
    // Fallback：全局第一个 WHERE（用于无多级 WITH 的场景）
    if (!whereText) {
      const globalWherePos = _findWhereOutsideBrackets(query)
      if (globalWherePos >= 0) {
        const whereBody = query.substring(globalWherePos + 6).trim()
        const endMatch = whereBody.match(/\b(?:RETURN|WITH|CREATE|MERGE|SET|DELETE|ORDER\s+BY|SKIP|LIMIT|UNWIND)\b/i)
        whereText = endMatch ? whereBody.substring(0, endMatch.index).trim() : whereBody.trim()
      }
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

  // Apply the FINAL WITH clause's ORDER BY here, before its SKIP/LIMIT.  The
  // middle-WITH sort loop above only sorts intermediate WITHs (it deliberately
  // excludes the last one as `slice(0, -1)`), so the terminal `WITH x ORDER BY
  // x LIMIT n` would otherwise truncate the un-sorted UNWIND expansion and pick
  // the wrong rows (e.g. `UNWIND [true,false] AS b WITH b ORDER BY b LIMIT 1`
  // returned `true` instead of `false`).  Sort by `plan.with.orderBy`, then let
  // the SKIP/LIMIT slice below operate on the ordered rows.
  if (plan.with?.orderBy?.length && rows.length > 1) {
    const orderBy = plan.with.orderBy
    const indices = Array.from({ length: rows.length }, (_, i) => i)
    indices.sort((a, b) => {
      const ra = rows[a]
      const rb = rows[b]
      for (const o of orderBy) {
        const expr = (o.expression as string) || o.property || ''
        const dir = (o.direction || '').trim().toUpperCase()
        const va = _evaluateExpression(expr, { ...varCtx, ...ra })
        const vb = _evaluateExpression(expr, { ...varCtx, ...rb })
        const cmp = _compareOrderByValue(va, vb)
        if (cmp !== 0) return dir === 'DESC' ? -cmp : cmp
      }
      return 0
    })
    rows = indices.map(i => rows[i])
  }

  // Apply a WITH-clause SKIP/LIMIT *before* Step 4 aggregation.  A WITH clause
  // carrying `LIMIT n` (e.g. `UNWIND range(...) AS i WITH i LIMIT 3000 RETURN
  // sum(i)`) must truncate the expanded rows *before* the aggregate reduces
  // them: `sum` over the first 3000 rows yields 3004498500, whereas summing
  // every expanded row then post-processing the (single) result row would be a
  // no-op (LIMIT 3000 on one row).  Only `plan.with.limit` / `plan.with.skip`
  // are trusted here — a top-level RETURN LIMIT is applied downstream by
  // `_postProcessResults` and must NOT double-truncate the aggregate input.
  if (plan.with?.skip !== undefined && plan.with.skip > 0) {
    rows = rows.slice(plan.with.skip)
  }
  if (plan.with?.limit !== undefined && plan.with.limit >= 0) {
    rows = rows.slice(0, plan.with.limit)
  }
  // Once the WITH-clause slice is applied here (before aggregation), clear the
  // *promoted* top-level `plan.skip` / `plan.limit`.  The parser promotes
  // `plan.with.skip/limit` onto `plan.skip/limit` so that the non-UNWIND (GE)
  // path — which only reads the top-level fields — can honor `WITH ... SKIP /
  // LIMIT` via `_postProcessResults`.  But for the UNWIND pipeline the slice is
  // already applied above, so leaving the promoted fields in place would make
  // `_postProcessResults` slice *again* (a `WITH i SKIP 2 RETURN collect(i)`
  // would collapse to `[]`).  Clear them only when the WITH clause actually
  // carried a slice; a *top-level* `RETURN ... SKIP/LIMIT` (parsed directly onto
  // `plan.skip/limit`, with no `plan.with.skip/limit`) is left untouched for
  // `_postProcessResults`.
  if (plan.with?.skip !== undefined || plan.with?.limit !== undefined) {
    (plan as { skip?: number; limit?: number }).skip = undefined
    ;(plan as { skip?: number; limit?: number }).limit = undefined
  }

  // Step 4: 聚合（count/sum/avg/max/min）
  // Step 3 only aggregates *with.columns* aggregate columns.  plan.aggregate may
  // instead come from a top-level RETURN aggregate (e.g. `WITH [1,2,3] AS xs
  // UNWIND xs AS x RETURN count(x) AS n`), in which case with.columns holds only
  // non-aggregate (e.g. literal-list) projections and the aggregate still needs
  // cross-row handling here.  Skip Step 4 only when a with.columns column is
  // itself an aggregate (Step 3 already collapsed to a single row).
  //
  // This cross-row handling applies ONLY to UNWIND pipelines.  Without UNWIND,
  // a plan.aggregate with non-empty with.columns (e.g. `WITH 1 AS a, 2 AS b
  // RETURN collect([a,b])`) is a literal-list builder resolved elsewhere and
  // must keep the original `!with.columns.length` behaviour.
  const _hasUnwind = !!(plan.unwind || plan.unwinds?.length)
  const _withHasAggCol = (() => {
    if (!plan.with?.columns?.length) return false
    const p = /^\s*(collect|count|sum|avg|max|min)\s*\(/i
    return plan.with.columns.some(col => typeof col.expression === 'string' && p.test(col.expression))
  })()
  const _step4Eligible = _hasUnwind ? !_withHasAggCol : !plan.with?.columns?.length
  if (plan.aggregate && _step4Eligible) {
    const agg = plan.aggregate as any
    const aggFn = (agg.function || agg.type || '').toLowerCase()
    // ── GROUP BY aggregation: group by plan.groupBy, emitting the group key
    //    column(s) plus the aggregate value per group ──
    // For `... WITH expr AS v RETURN v, count(*)` the parser sets groupBy=v.
    // Step 3 already projected the per-row `v`; here we must fold rows into
    // groups keyed by the groupBy column(s) and compute the aggregate per
    // group, emitting both the groupBy column and the aggregate column.
    if ((plan as any).groupBy?.length) {
      const groupByCols = (plan as any).groupBy as string[]
      const aggColMatch = (agg.column || '').match(/^\w+\(\s*(?:DISTINCT\s+)?(.+?)\s*\)(?:\s+AS\s+\w+)?$/i)
      const aggField = (agg.field !== undefined && agg.field !== '') ? agg.field : (aggColMatch ? aggColMatch[1] : (agg.field || '*'))
      const isDistinct = /\bDISTINCT\b/i.test(agg.column || '')
      // The aggregate's output key: prefer the full `count(x)` column text when
      // the RETURN column is an unaliased aggregate (TCK expects `count(*)`).
      const rcAgg = plan.returnColumns?.find((rc: string) => /\w+\s*\(/.test(String(rc)))
      const aggKey = rcAgg !== undefined
        ? String(rcAgg)
        : (agg.alias && agg.alias !== agg.function
          ? agg.alias
          : (agg.column?.replace(/^.+?\s+AS\s+/i, '').trim() || agg.field || agg.column || 'count(*)'))
      const groups = new Map<string, Record<string, unknown>[]>()
      for (const row of rows) {
        const keyObj: Record<string, unknown> = {}
        for (const gb of groupByCols) keyObj[gb] = row[gb]
        const keyStr = JSON.stringify(keyObj)
        if (!groups.has(keyStr)) groups.set(keyStr, [])
        groups.get(keyStr)!.push(row)
      }
      const out: QueryRow[] = []
      for (const [keyStr, groupRows] of groups) {
        const keyObj = JSON.parse(keyStr) as Record<string, unknown>
        const row: Record<string, unknown> = { ...keyObj }
        if (aggFn === 'count') {
          if (aggField === '*') row[aggKey] = groupRows.length
          else {
            const nonNull = groupRows.map(r => r[aggField]).filter((v: unknown) => v !== null && v !== undefined)
            row[aggKey] = isDistinct ? [...new Set(nonNull.map(v => JSON.stringify(v)))].length : nonNull.length
          }
        } else if (aggFn === 'sum') {
          row[aggKey] = groupRows.reduce((acc, r) => acc + (Number(r[aggField]) || 0), 0)
        } else if (aggFn === 'avg') {
          const nums = groupRows.map(r => Number(r[aggField])).filter(v => !isNaN(v))
          row[aggKey] = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0
        } else if (aggFn === 'min') {
          row[aggKey] = Math.min(...groupRows.map(r => Number(r[aggField]) || 0))
        } else if (aggFn === 'max') {
          row[aggKey] = Math.max(...groupRows.map(r => Number(r[aggField]) || 0))
        } else if (aggFn === 'collect') {
          // collect filters null elements (consistent with the non-grouped
          // collect branch and Cypher semantics).
          const vals = groupRows.map(r => r[aggField]).filter((v: unknown) => v !== null && v !== undefined)
          row[aggKey] = isDistinct ? [...new Set(vals.map(v => JSON.stringify(v)))].map(s => JSON.parse(s)) : vals
        } else {
          row[aggKey] = groupRows.length
        }
        out.push(row)
      }
      return out
    }
    // Output key must match plan.returnColumns.  For an *unaliased* aggregate
    // (e.g. `RETURN max(x)`) the parser strips `(x)` and sets agg.alias = `max`,
    // while returnColumns[0] keeps the full `max(x)` — the TCK expects the full
    // form.  Prefer returnColumns[0] when it is itself an aggregate call.
    const _rc0 = plan.returnColumns?.[0]
    const _rc0IsAgg = _rc0 !== undefined && /\w+\s*\(/.test(String(_rc0))
    const aggAlias = _rc0IsAgg
      ? String(_rc0)
      : (agg.alias || (agg.column && agg.column.replace(/^.+?\s+AS\s+/i, '').trim()) || agg.field || agg.column || 'count(*)')

    // Extract the aggregated field name: count(*)=*, count(v)=v, and skip an
    // optional DISTINCT keyword.  Prefer `agg.field` (the parser already strips
    // DISTINCT); fall back to re-parsing `agg.column` with a DISTINCT-aware
    // regex so `collect(DISTINCT x)` resolves to `x` rather than `DISTINCT x`.
    const colMatch = (agg.column || '').match(/^\w+\(\s*(?:DISTINCT\s+)?(.+?)\s*\)(?:\s+AS\s+\w+)?$/i)
    const field = (agg.field !== undefined && agg.field !== '') ? agg.field : (colMatch ? colMatch[1] : (agg.field || '*'))
    // Whether the aggregate call carries a DISTINCT modifier (`collect(DISTINCT
    // x)`, `count(DISTINCT x)`).  Determinatively derived from the column text.
    const isDistinct = /\bDISTINCT\b/i.test(agg.column || '')

    if (aggFn === 'count') {
      if (field === '*') {
        // count(*): 行数
        return [{ [aggAlias]: rows.length }]
      }
      // count(expr): 非 null 行数 (DISTINCT de-duplicates before counting)
      const nonNull = rows
        .map(r => r[field])
        .filter((v: unknown) => v !== null && v !== undefined)
      const distinctNonNull = isDistinct ? [...new Set(nonNull.map(v => JSON.stringify(v)))].length : nonNull.length
      return [{ [aggAlias]: distinctNonNull }]
    }

    // sum/avg/min/max: 从 field 收集数值 (DISTINCT de-duplicates first)
    const rawValues = rows
      .map(r => r[field])
      .filter((v: unknown) => v !== null && v !== undefined)
    const distinctRaw = isDistinct ? [...new Set(rawValues.map(v => JSON.stringify(v)))].map(s => JSON.parse(s)) : rawValues
    const values = distinctRaw
      .map(Number)
      .filter((v: number) => !isNaN(v))

    switch (aggFn) {
      case 'collect': {
        // collect(expr): gather all values into a list (DISTINCT de-duplicates).
        // Null elements are filtered out: `collect()` over an unbound variable
        // (e.g. OPTIONAL MATCH with no match) yields `[]`, and `collect(DISTINCT
        // x)` excludes nulls (Cypher semantics — see Aggregation5/8).
        const collected = isDistinct
          ? [...new Set(rows.map(r => r[field]).filter((v: unknown) => v !== null && v !== undefined).map(v => JSON.stringify(v)))].map(s => JSON.parse(s))
          : rows.map(r => r[field]).filter((v: unknown) => v !== null && v !== undefined)
        return [{ [aggAlias]: collected }]
      }
      case 'sum':
        return [{ [aggAlias]: values.reduce((a: number, b: number) => a + b, 0) }]
      case 'avg':
        return [{ [aggAlias]: values.length ? values.reduce((a: number, b: number) => a + b, 0) / values.length : 0 }]
      case 'max':
      case 'min': {
        // max/min operate over *any* comparable Cypher type (numbers, strings,
        // lists, temporal values, cross-type by type rank) — not just numbers.
        // Use a dedicated aggregate comparator instead of Math.max/min + Number
        // coercion (which collapsed strings/lists to NaN → 0).  Nulls are
        // already filtered above.
        const comparable = rows.map(r => r[field]).filter((v: unknown) => v !== null && v !== undefined)
        if (!comparable.length) return [{ [aggAlias]: null }]
        let best = comparable[0]
        for (let i = 1; i < comparable.length; i++) {
          const cmp = _aggCompare(comparable[i], best)
          if (aggFn === 'max' ? cmp > 0 : cmp < 0) best = comparable[i]
        }
        return [{ [aggAlias]: best }]
      }
      default:
        return [{ [aggAlias]: 0 }]
    }
  }

  // Step 4.5: RETURN-expression cross-row aggregation.
  // When a RETURN expression nests an aggregate function inside a list
  // predicate (e.g. `ALL(ok IN collect((size(list)=0)=empty) WHERE ok)`),
  // the parser does not synthesize plan.aggregate (its detector only matches
  // a *top-level* aggregate call).  The per-row expression engine `collect`
  // kernel is single-row (it wraps one value in a list), so Step 5 would
  // evaluate the predicate against a single-element list.  Materialize each
  // cross-row `collect(...)` over all rows first, then collapse to a single
  // row so the surrounding predicate sees the full collected list.
  if (plan.returnColumns?.length && rows.length > 0) {
    const collected = _materializeReturnAggregates(plan, rows, varCtx)
    // Cross-row collect aggregation has been materialized to a single row.
    // Map it directly onto the RETURN output and return, bypassing Step 5's
    // per-row re-evaluation (which would use the single-row collect kernel and
    // collapse e.g. size(collect(x)) back to 1).
    if (collected) {
      const out: QueryRow = {}
      for (const rc of plan.returnColumns) {
        const key = rc.replace(/^\w+\./, '')
        out[rc] = (collected[0][key] !== null && collected[0][key] !== undefined)
          ? collected[0][key] : (collected[0][rc] !== null && collected[0][rc] !== undefined ? collected[0][rc] : null)
      }
      return [out]
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
        // Evaluate against varCtx as well as the row: a MATCH variable (e.g.
        // `n` in `MATCH (n) UNWIND ... RETURN n.age`) lives in varCtx, not in
        // the unwound row, so `n.age` would otherwise resolve to null.
        const val = _evaluateExpression(expr, { ...varCtx, ...row })
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

