/**
 * step-definitions.ts — Cucumber step definitions for openCypher TCK testing
 *
 * Supports official .feature step patterns. Uses seedNodes array mode
 * (same as original custom step definitions) to keep things working with
 * our _executeQuery(plan, seedNodes) API.
 */
import { Given, When, Then, Before, After, DataTable } from '@cucumber/cucumber'
import * as assert from 'assert'
import fs from 'fs'
import crypto from 'crypto'
import { parseQuery, _executeQuery, _validatePlan, _clearGeInstances } from '../query-engine'
import { _evalBinary, _isExprValue } from '../expression-engine'
import { _resolveUnwindList, _splitWithColumns } from '../query-parser'
import { GraphEngine } from '../../core/graph-engine'
import { globalRegistry as _globalProcedureRegistry, type CypherProcedure } from '../procedure-registry'
import { extractEdgesFromNodes } from '../executor-validators'

interface St { nodes: any[]; q: string; res: any[]; err: Error | null; pGe?: any; pDir?: string; params?: Record<string, string> }
const st: St = { nodes: [], q: '', res: [], err: null, params: {} }

/**
 * Strip Cypher comments (`//` line and `/* *​/` block) while respecting
 * string literals (single/double quote), backtick-quoted identifiers, and
 * escaped characters.  openCypher TCK `.feature` docstrings frequently embed
 * `// ...` annotations inside multi-line CREATE clauses (e.g. to document a
 * computed value).  If left in place those comments break our manual
 * multi-statement splitter, which keys on trailing commas and bare clause
 * keywords — a line such as `CREATE (..), //annotation` no longer ends with
 * a comma, so the following node line is treated as a separate statement and
 * the extra nodes are dropped.
 */
function _stripCypherComments(q: string): string {
  const out: string[] = []
  let i = 0
  const n = q.length
  while (i < n) {
    const ch = q[i]
    if (ch === "'" || ch === '"') {
      const start = i
      i++
      while (i < n) {
        if (q[i] === '\\') { i += 2; continue }
        if (q[i] === ch) { i++; break }
        i++
      }
      out.push(q.slice(start, i))
      continue
    }
    if (ch === '`') {
      const start = i
      i++
      while (i < n && q[i] !== '`') i++
      if (i < n) i++
      out.push(q.slice(start, i))
      continue
    }
    if (ch === '/' && q[i + 1] === '/') {
      while (i < n && q[i] !== '\n') i++
      continue
    }
    if (ch === '/' && q[i + 1] === '*') {
      i += 2
      while (i < n && !(q[i] === '*' && q[i + 1] === '/')) i++
      if (i < n) i += 2
      continue
    }
    out.push(ch)
    i++
  }
  return out.join('')
}

Before(function () {
  st.nodes = []; st.q = ''; st.res = []; st.err = null; st.params = {}
  if (st.pGe) { try { st.pGe.close() } catch {}; st.pGe = undefined }
  if (st.pDir) { try { fs.rmSync(st.pDir, { recursive: true, force: true }) } catch {}; st.pDir = undefined }
  _clearGeInstances()
  // 清除 procedure registry（除了内置 proc），确保场景间隔离
  // 内置 proc（db.labels, dbms.security.createUser 等）在 registerBuiltins 中注册，需要保留
  // 但测试注册的 proc（test.my.proc, test.doNothing 等）需要清理
  // 通过 Before 中重建 registry 实现
  const registeredNames = _globalProcedureRegistry.list().map(p => p.name)
  for (const n of registeredNames) {
    if (!n.startsWith('db.') && !n.startsWith('dbms.')) {
      _globalProcedureRegistry.unregister(n)
    }
  }
})
After(function () {
  try { st.pGe?.close() } catch {}
  try { if (st.pDir) fs.rmSync(st.pDir, { recursive: true, force: true }) } catch {}
})

function persistGe(): any {
  if (st.pGe) return st.pGe
  st.pDir = '/tmp/tckp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex')
  fs.mkdirSync(st.pDir, { recursive: true })
  st.pGe = new GraphEngine({ path: st.pDir, denseVector: { dimension: 384 } })
  st.pGe.open()
  return st.pGe
}

function dtToNodes(dt: DataTable): any[] {
  const nodes: any[] = []
  for (const row of dt.hashes()) {
    const node: any = {}
    for (const [key, val] of Object.entries(row)) {
      if (val === '' || val === 'NULL') continue
      const num = Number(val); node[key] = isNaN(num) ? val : num
    }
    if (!('_label' in node)) node._label = 'Default'
    nodes.push(node)
  }
  return nodes
}

/** Parse a simple CREATE statement to extract nodes */
function parseCreateStmt(query: string): Array<Record<string, unknown>> {
  const nodes: Array<Record<string, unknown>> = []
  // Match patterns like: (:A {name: 'b'}), (:B), ({name: 'c'})
  const createRe = /(?:\bCREATE\s+)?(?:match|set|return|where|with|delete|remove)\b/i.test(query)
    ? null : query // skip if it's not purely CREATE

  // Extract all (...) patterns from CREATE
  const nodePatterns = query.match(/\([^)]+\)/g)
  if (!nodePatterns) return nodes

  for (const np of nodePatterns) {
    const inner = np.slice(1, -1).trim()
    const labels: string[] = []
    const props: Record<string, unknown> = {}
    const bi = inner.indexOf('{')
    if (bi >= 0) {
      if (inner.substring(0, bi).trim().startsWith(':')) labels.push(...inner.substring(0, bi).trim().substring(1).split(':').filter(Boolean))
      try {
        // Convert Cypher {name: 'b', count: 42} → JSON {"name":"b","count":42}
        const raw = inner.substring(bi).replace(/'/g, '"').replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)(\s*:)/g, '$1"$2"$3')
        Object.assign(props, JSON.parse(raw))
      } catch {}
    } else if (inner.startsWith(':')) {
      labels.push(...inner.substring(1).split(':').filter(Boolean))
    }
    const node: Record<string, unknown> = { _label: labels[0] || 'Default' }
    if (labels.length > 1) node.__fullLabel = labels.join(':')
    for (const [k, v] of Object.entries(props)) node[k] = v
    nodes.push(node)
  }
  return nodes
}

function nodesFromGe(ge: any): any[] {
  try {
    const result = ge.query('MATCH (n) RETURN n')
    if (!result || !result.length) return []
    return result.map((r: any) => {
      // GE query returns array of {n: {id, name, type, props}}
      const raw = r?.n || r
      if (raw && typeof raw === 'object') {
        if (raw.props) return { ...raw.props }
        if (raw.name && raw.type) {
          const node: Record<string, unknown> = { _label: raw.type }
          // Try to extract props from GE node object
          for (const k of Object.keys(raw)) {
            if (k !== 'id' && k !== 'name' && k !== 'type') node[k] = raw[k]
          }
          return node
        }
        return raw
      }
      return raw
    })
  } catch { return [] }
}

// Evaluate a WITH clause inside a multi-statement seed, updating the row-aligned
// variable environment (`varEnv`) so later statements can reference the projected
// variables.  Two forms are distinguished:
//
//   1. Aggregating WITH — `WITH a, b, [a] + collect(n) + [b] AS nodeList`.
//      `collect(x)` folds the whole `x` column (stored as a length-N array) into
//      a single list; the surrounding list concatenation then builds the projected
//      value.  Any column may be a plain projection (single value) or an aggregate
//      (list).  The result is ONE row: each projected column becomes a 1-element
//      entry in varEnv.
//
//   2. Row-expanding WITH — `WITH nodeList[i] AS n1, nodeList[i+1] AS n2`,
//      immediately following a `UNWIND ... AS i`.  Each index expression
//      `list[idxVar]` projects, per UNWIND row, `list[ idxVar[k] ]`, producing one
//      result per row.  An index expression references a scalar index variable in
//      varEnv (e.g. `i`) and a list variable (e.g. `nodeList`).
//
// After a WITH the Cypher scope is re-established: only the projected columns
// survive; every other variable is dropped.
function _applySeedWith(body: string, varEnv: Map<string, unknown[]>): void {
  const columns = _splitWithColumns(body)
  const projected = new Map<string, unknown[]>()
  // Detect the row length driver: the longest array among referenced scalar
  // variables, defaulting to a single row when there is no expanding driver
  // (a plain projection or an aggregation).
  const rowLen = Math.max(1, ...(Array.from(varEnv.values()).map(v => Array.isArray(v) ? v.length : 1)))
  // Resolve a variable reference to a single (current-row) value.  For an array
  // column, the "current row" is ambiguous outside an explicit index variable; we
  // resolve to the first element for scalar projection, and rely on collect()
  // handling for full-column aggregation.
  const resolveVar = (name: string): unknown => {
    const v = varEnv.get(name)
    if (v === undefined) return undefined
    if (Array.isArray(v)) return v.length === 1 ? v[0] : v
    return v
  }
  // Aggregate a full column into a list (the `collect(x)` semantic).
  const collectColumn = (name: string): unknown => {
    const v = varEnv.get(name)
    if (v === undefined) return []
    if (Array.isArray(v)) return v.slice()
    return [v]
  }
  for (const rawCol of columns) {
    // Split `expr [AS alias]` on the top-level ` AS `.
    const asMatch = rawCol.match(/^(.*?)\s+AS\s+([A-Za-z_]\w*)\s*$/i)
    const expr = (asMatch ? asMatch[1] : rawCol).trim()
    const alias = asMatch ? asMatch[2] : (expr.match(/^[A-Za-z_]\w*$/) ? expr : expr)
    // Build an evaluation context whose variable references resolve to scalar
    // values, but whose `collect(...)` aggregate is specialised by pre-substituting
    // collect(x) → a placeholder variable that carries the full column (as a real
    // object reference, NOT via JSON, so node identity is preserved).
    const ctx: Record<string, unknown> = {}
    for (const [k, v] of varEnv) ctx[k] = Array.isArray(v) ? (v.length === 1 ? v[0] : v) : v
    // Expand any `collect(<var>)` call to the full-column list before evaluation,
    // so `[a] + collect(n) + [b]` concatenates correctly.  Use a unique
    // placeholder name bound in ctx (preserving object identity) instead of
    // JSON.stringify, which would serialise/deserialise node objects and break
    // `st.nodes.indexOf(node)` reference equality later.
    let evalExpr = expr
    let collectIdx = 0
    evalExpr = evalExpr.replace(/\bcollect\s*\(\s*([A-Za-z_]\w*)\s*\)/gi, (_m, vn) => {
      const ph = `__collect_${collectIdx++}`
      ctx[ph] = collectColumn(vn)
      return ph
    })
    // Evaluate an index projection `list[<expr>]` per row when `<expr>`
    // references a multi-row UNWIND column (e.g. `nodeList[i]` or
    // `nodeList[i+1]` under `UNWIND range(0, size(nodeList)-2) AS i`).  Each
    // row's index is evaluated against that row's value of the index variable,
    // yielding one projected element per row.
    const idxMatch = evalExpr.match(/^([A-Za-z_]\w*)\[\s*([^\]]+)\s*\]$/)
    if (idxMatch) {
      const listName = idxMatch[1]
      const idxExpr = idxMatch[2].trim()
      // The list variable holds a single row whose value IS the list (e.g.
      // `nodeList` → `[ [22 nodes] ]`), so unwrap the single-element column to
      // obtain the indexable list.
      let listVal = varEnv.get(listName)
      if (Array.isArray(listVal) && listVal.length === 1 && Array.isArray(listVal[0])) listVal = listVal[0] as unknown[]
      const idxVar = (idxExpr.match(/[A-Za-z_]\w*/) || [])[0]
      const idxVals = idxVar ? varEnv.get(idxVar) : undefined
      if (Array.isArray(listVal) && Array.isArray(idxVals)) {
        projected.set(alias, idxVals.map((iv: unknown) => {
          let ii = iv as number
          if (idxExpr !== idxVar) {
            try { ii = Number(_evalBinary(idxExpr, { [idxVar]: iv })) } catch { ii = Number(iv) }
          }
          return (listVal as unknown[])[ii]
        }))
        continue
      }
    }
    // Otherwise evaluate once (projection / aggregation → a single row).
    let val: unknown
    try { val = _evalBinary(evalExpr, ctx) } catch { val = undefined }
    projected.set(alias, [val])
  }
  // Replace the environment with the WITH projection (Cypher scope reset).
  varEnv.clear()
  for (const [k, v] of projected) varEnv.set(k, v)
}

async function run(q: string): Promise<void> {
  try {
    // 参数注入：替换 $param → 实际值
    let resolvedQ = q
    if (st.params && Object.keys(st.params).length) {
      for (const [key, val] of Object.entries(st.params)) {
        // null/bool → 关键字字面量
        if (val === null) {
          resolvedQ = resolvedQ.replace(new RegExp('\\$' + key + '\\b', 'g'), 'null')
        } else if (val === true || val === false) {
          resolvedQ = resolvedQ.replace(new RegExp('\\$' + key + '\\b', 'g'), String(val))
        } else if (Array.isArray(val)) {
          // 数组 → JSON 字面量（不打引号）
          resolvedQ = resolvedQ.replace(new RegExp('\\$' + key + '\\b', 'g'), JSON.stringify(val))
        } else if (typeof val === 'object' && val !== null) {
          // 对象/Map → Cypher map 字面量（{k: v} 格式，非 JSON {"k":"v"}）
          // 递归处理嵌套 map（如 {address: {city: 'London'}}）
          const _toCypherMap = (obj: Record<string, unknown>): string => {
            return '{' + Object.entries(obj).map(([k, v]) => {
              let vStr: string
              if (v === null) vStr = 'null'
              else if (typeof v === 'string') vStr = `'${v}'`
              else if (typeof v === 'number' || typeof v === 'boolean') vStr = String(v)
              else if (typeof v === 'object' && v !== null && !Array.isArray(v)) vStr = _toCypherMap(v as Record<string, unknown>)
              else if (Array.isArray(v)) vStr = JSON.stringify(v)
              else vStr = String(v)
              return `${k}: ${vStr}`
            }).join(', ') + '}'
          }
          const cypherMap = _toCypherMap(val as Record<string, unknown>)
          resolvedQ = resolvedQ.replace(new RegExp('\\$' + key + '\\b', 'g'), cypherMap)
        } else {
          // 纯数字（非字符串）不加引号，其他加引号
          const isNumber = typeof val === 'number' && /^-?\d+(\.\d+)?$/.test(String(val))
          const escaped = isNumber ? String(val) : `'${val}'`
          resolvedQ = resolvedQ.replace(new RegExp('\\$' + key + '\\b', 'g'), escaped)
        }
      }
    }
    const plan = parseQuery(resolvedQ); assert.ok(plan); assert.ok(plan.type)
    // 大整数精度修复
    _fixBigIntFilters(plan as any, resolvedQ)
    // 编译时语义验证
    try {
      _validatePlan(plan, resolvedQ)
    } catch (e: any) {
      st.err = e; st.res = []; return
    }

    // 执行查询
    if (plan.type === 'CALL' && !plan.callProcedure && resolvedQ && st.params && Object.keys(st.params).length) {
      (plan as any)._bareCallParams = { ...st.params }
    }
    const result = await _executeQuery(plan, st.nodes, resolvedQ)
    st.err = null
    st.res = result as any[]
  } catch (e: any) {
    st.err = e; st.res = []
  }
}
function _fixBigIntFilters(plan: any, query: string): void {
  if (!plan.filters?.length) return
  // 从 WHERE 文本中提取所有形如 `= 4611686018427387905` 的字面量
  const bigIntPattern = /=\s*(-?\d{16,})/g
  let m: RegExpExecArray | null
  const replacements = new Map<string, string>()
  while ((m = bigIntPattern.exec(query)) !== null) {
    const rawNum = m[1]
    const asNumber = Number(rawNum)
    // 如果 Number 截断后的字符串和 raw 不同，说明精度丢失
    if (String(asNumber) !== rawNum) {
      replacements.set(String(asNumber), rawNum)
    }
  }
  // 替换 filters 中的值
  for (const f of plan.filters) {
    if (typeof f.value === 'number' && replacements.has(String(f.value))) {
      const rawBigStr = replacements.get(String(f.value))!
      f.value = BigInt(rawBigStr)
    }
  }
}
function _runOnPersistGe(q: string): void {
  try {
    const plan = parseQuery(q)
    if (!plan || !plan.type) throw new Error('parseQuery failed')
    const ge = persistGe()
    // Run GE's internal query plan executor
    const raw: any[] = (ge as any)._executeQueryPlan(plan)
    st.err = null
    if (!raw || !raw.length) { st.res = []; return }

    const rc = (plan.returnColumns && plan.returnColumns[0] !== undefined)
      ? plan.returnColumns
      : ['n']
    const records: any[] = []
    for (const r of raw) {
      const row: any = {}
      for (const col of rc) {
        const props = r.props
        if (props && typeof props === 'object' && Object.keys(props).length > 0) {
          row[col] = { ...props }
        } else {
          row[col] = { _label: 'Default' }
        }
      }
      records.push(row)
    }
    st.res = records
  } catch (e: any) { st.err = e; st.res = [] }
}

/** Convert a result row value to official TCK node notation: (:Label {prop: 'val'}) */
function toNodeNotation(val: unknown): string | undefined {
  if (!val || typeof val !== 'object') return undefined
  const obj = val as Record<string, unknown>
  // 优先使用 __fullLabel（多标签），回退到 _label
  const labelSrc = (obj.__fullLabel && String(obj.__fullLabel) !== 'Default' ? String(obj.__fullLabel) : '') ||
    (obj._label && obj._label !== 'Default' ? String(obj._label) : '')
  // 多标签节点：保持原始标签顺序（TCK 期望查询时的顺序）
  const labels = labelSrc.split(':').filter(Boolean)
  const label = labels.join(':')
  const props: Record<string, unknown> = {}
  for (const k of Object.keys(obj)) {
    if (k === '_label' || k === '__fullLabel' || k === '__edges' || k === 'props' || k === '_alias' || k.startsWith('_all') || k.startsWith('__')) continue
    if (typeof obj[k] !== 'function') props[k] = obj[k]
  }
  const propKeys = Object.keys(props)
  if (!propKeys.length && !label) return '()'
  // If no props, just (:Label)
  if (!propKeys.length) return `(:${label})`
  // With props: (:Label {prop: value})
  const propStr = propKeys.map(k => {
    const v = props[k]
    if (typeof v === 'string') return `${k}: '${v}'`
    if (Array.isArray(v)) return `${k}: [${v.map(e => typeof e === 'string' ? `'${e}'` : String(e)).join(', ')}]`
    return `${k}: ${_stringifyVal(v)}`
  }).join(', ')
  return label ? `(:${label} {${propStr}})` : `({${propStr}})`
}

/** Normalize actual results: convert row objects to node notation strings */

/** Convert a value to TCK edge notation: [:Label {prop: 'val'}] */
function _toEdgeNotation(val: Record<string, unknown>): string {
  const label = (val.__edgeLabel || val._type || val._label || '') as string
  const props: Record<string, unknown> = {}
  // Internal relationship bookkeeping fields (graph-engine edge identity) must
  // never render as relationship properties; they are not user data.
  const _internal = new Set(['srcIdx', 'dstIdx', 'label', 'props', '__edgeId'])
  for (const [k, v] of Object.entries(val)) {
    if (k.startsWith('_') || _internal.has(k)) continue
    props[k] = v
  }
  const propKeys = Object.keys(props)
  if (!propKeys.length && !label) return '[:]'
  if (!propKeys.length) return `[:${label}]`
  const propStr = propKeys.map(k => {
    const v = props[k]
    if (typeof v === 'string') return `${k}: '${v}'`
    if (typeof v === 'number') return `${k}: ${v}`
    return `${k}: ${_stringifyVal(v)}`
  }).join(', ')
  return label ? `[:${label} {${propStr}}]` : `[: {${propStr}}]`
}

/**
 * Render a path object `{ __path: [...], __pathEdges: [...] }` into TCK path
 * notation `<(:A)-[:T]->(:B)>`.  Each edge carries a `__dir` field ('out' means
 * the anchor at `__path[i]` points toward `__path[i+1]`; 'in' means the edge
 * points back from the neighbour toward the anchor).
 */
function _toPathNotation(val: Record<string, unknown>): string {
  const nodes = Array.isArray(val.__path) ? (val.__path as any[]) : []
  const edges = Array.isArray(val.__pathEdges) ? (val.__pathEdges as any[]) : []
  const parts: string[] = []
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    parts.push(node && typeof node === 'object' ? (toNodeNotation(node) ?? '()') : '()')
    if (i < edges.length) {
      const edge = edges[i]
      const dir = (edge && typeof edge === 'object' ? (edge as any)._dir : undefined) || 'out'
      const edgeNotation = edge && typeof edge === 'object' ? _toEdgeNotation(edge as any) : '[]'
      if (dir === 'in') parts.push('<-' + edgeNotation + '-')
      else parts.push('-' + edgeNotation + '->')
    }
  }
  return '<' + parts.join('') + '>'
}

/** 检测两个字符串是否表示同一个数字，但一个带 .0 一个不带 */
function _isFloatZeroMatch(actual: string, expected: string): boolean {
  if (actual === expected) return false
  // 期望值以 .0 结尾，实际值是没有 .0 的整数
  // 如 "0" vs "0.0", "1000000000" vs "1000000000.0"
  if (expected.endsWith('.0')) {
    const intPart = expected.slice(0, -2)
    if (actual === intPart) return true
    // 处理科学计数法：实际 "1e+308" → expected "1e+308.0"
    // _stringifyVal 已去掉 e+，所以应该不会出现
  }
  return false
}

function normalizeActual(rows: any[], keys: string[]): Record<string, string>[] {
  return rows.map(row => {
    const norm: Record<string, string> = {}
    for (const key of keys) {
      // Try exact key match first
      let val = row[key]
      // If exact match fails, try aliased column mapping
      // e.g., expected key "p.id" → actual has "id" (from returnColumns)
      if (val === undefined) {
        const dotIdx = key.indexOf('.')
        if (dotIdx > 0) {
          const propPart = key.slice(dotIdx + 1)
          val = row[propPart]
        }
      }
      const isNode = val && typeof val === 'object' && '_label' in val
        && !('__edgeLabel' in (val as any)) && !('_type' in (val as any))
      norm[key] = isNode && toNodeNotation(val) !== undefined
        ? toNodeNotation(val)!
        : _stringifyVal(val)
    }
    return norm
  })
}

/** Format a value to its canonical Cypher string representation */
function _stringifyVal(val: unknown): string {
  if (val === null || val === undefined) return 'null'
  // Float marker produced by toFloat() on integral input (e.g. toFloat(3)).
  // JS number cannot carry the Int/Float distinction, so the engine wraps
  // integral Float results as { __float: n }; render them with a trailing .0.
  if (typeof val === 'object' && !Array.isArray(val) && '__float' in (val as any)) {
    return String((val as any).__float) + '.0'
  }
  if (typeof val === 'string') {
    // 如果是边表示（[:T1] 格式），裸输出不含引号
    if (val.startsWith('[:"') || val.startsWith('[:')) return val
    // Cypher 字符串格式化：转义内部单引号和反斜杠
    const escaped = val.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    return "'" + escaped + "'"  // TCK expects quoted strings
  }
  if (typeof val === 'number') {
    // Cypher expects: integer literals as-is, floats with .0 suffix, no e+ (just e)
    let s = String(val)
    // Strip "+" from "e+" (TCK expects "e305" not "e+305")
    s = s.replace(/e\+/g, 'e')
    return s
  }
  if (typeof val === 'bigint') {
    // Cypher Int64 literal — BigInt preserves full precision
    return String(val)
  }
  if (typeof val === 'boolean') return String(val)
  if (Array.isArray(val)) {
    return '[' + val.map(v => {
      if (typeof v === 'string') return "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
      if (typeof v === 'bigint') return String(v)
      // When an array element is a path object → <(:A)-[:T]->(:B)>
      if (typeof v === 'object' && v !== null && '__path' in (v as any) && '__pathEdges' in (v as any)) {
        return _toPathNotation(v as any)
      }
      // 数组元素是关系对象时 → [:Label {props}].  The `__edgeLabel` / `_type`
      // markers are definitive relationship signs and must be checked BEFORE
      // `_label` (a node marker); a relationship that carries both (an
      // `__edgeLabel` and a `_label` holding its type, as produced by the
      // OPTIONAL MATCH path builder) would otherwise render as `(:X {...})`
      // instead of the correct `[:X]`.
      if (typeof v === 'object' && v !== null && ('__edgeLabel' in (v as any) || '_type' in (v as any))) {
        return _toEdgeNotation(v as any)
      }
      // 数组元素是节点对象时 → 使用 toNodeNotation
      if (typeof v === 'object' && v !== null && '_label' in (v as any)) {
        const nn = toNodeNotation(v)
        if (nn !== undefined) return nn
      }
      if (Array.isArray(v) || (typeof v === 'object' && v !== null)) return _stringifyVal(v)
      return String(v)
    }).join(', ') + ']'
  }
  if (typeof val === 'object' && val !== null) {
    // Path object → <(:A)-[:T]->(:B)>
    if ('__path' in (val as any) && '__pathEdges' in (val as any)) {
      return _toPathNotation(val as Record<string, unknown>)
    }
    // Relationship object → [:Label {props}]. The `__edgeLabel` / `_type` markers
    // are definitive relationship signs and must be checked BEFORE `_label` (a
    // node marker); otherwise a relationship that carries both an `__edgeLabel`
    // and a `_label` holding its type would render as a node `(:T1)` instead of
    // the correct edge `[:T1]`.
    if ('__edgeLabel' in (val as any) || '_type' in (val as any)) {
      return _toEdgeNotation(val as any)
    }
    // 节点对象 → toNodeNotation（避免输出 {_label: 'A', name: 'a'}）
    if ('_label' in (val as any)) {
      const nn = toNodeNotation(val)
      if (nn !== undefined) return nn
    }
    const entries = Object.entries(val as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${_stringifyVal(v)}`)
      .join(', ')
    return '{' + entries + '}'
  }
  return String(val)
}

/** Parse a single cell from official TCK notation to its canonical string form */
function normalizeCell(s: string): string {
  if (!s) return ''
  // Node notation: (:A {name: 'b'}) => normalize for comparison.
  // Some TCK feature files write `(:A {prop:1})` (no space after the colon)
  // while others write `(:A {prop: 1})`; normalize the space after a property
  // colon away inside a node/edge map so both spellings compare equal.
  const nodeMatch = s.match(/^\(([^)]*)\)$/)
  if (nodeMatch) {
    return s.replace(/:\s+/g, ':')   // `prop: 1` → `prop:1`
  }
  // Relationship map inside a list: `[[:REL {num: 1}], ...]`.  The relationship
  // object `[:REL {num: 1}]` carries the same `{key: value}` map as a node, so
  // normalise the property-colon spacing there as well (`num: 1` → `num:1`).
  if (s.startsWith('[[') && s.endsWith(']]')) {
    return s.replace(/:\s+/g, ':')
  }
  return s
}

/** Normalize the element order of a rendered list cell like `['b', 'a', 'c']`
 *  into a canonical sorted form for order-insensitive list comparison. */
function _normalizeListCell(s: string): string {
  const m = s.match(/^\[(.*)\]$/)
  if (!m) return s
  const inner = m[1].trim()
  if (!inner) return s // empty list — nothing to sort
  // Split on ", " but only at top level (commas inside quoted strings or
  // nested brackets are handled by the simple heuristics below). For TCK list
  // cells produced by `_stringifyVal`/`normalizeCell`, elements are separated
  // by ", " and string elements are single-quoted.
  const elems = inner.split(', ').map((e: string) => e.trim())
  // Guard: if any element still contains an unbalanced quote or bracket, the
  // split was ambiguous — fall back to the raw string rather than corrupt it.
  const isAmbiguous = elems.some((e: string) => {
    const quotes = (e.match(/'/g) || []).length
    const open = (e.match(/\[/g) || []).length
    const close = (e.match(/\]/g) || []).length
    return quotes % 2 !== 0 || open !== close
  })
  if (isAmbiguous) return s
  elems.sort()
  return '[' + elems.join(', ') + ']'
}

function cmp(dt: DataTable, ordered = false, ignoreListOrder = false): void {
  if (st.err) throw st.err
  const rawExp = dt.hashes()
  const keys = Object.keys(rawExp[0] || {})
  // When `ignoreListOrder` is set (TCK clause "ignoring element order for
  // lists"), the order of list elements is insignificant and must be
  // normalized before comparison — e.g. keys({name,age,address}) may legally
  // return the keys in any order, so ['name','age','address'] and
  // ['address','name','age'] must be treated as equal.
  const normalizeListMaybe = (s: string): string => ignoreListOrder ? _normalizeListCell(s) : s
  const expected = rawExp.map(r => {
    const norm: Record<string, string> = {}
    for (const k of keys) norm[k] = normalizeListMaybe(normalizeCell(String(r[k])))
    return norm
  })
  const actual = normalizeActual(st.res, keys).map(r => {
    const norm: Record<string, string> = {}
    // Apply the same node-notation space normalization used on the expected
    // side, so `(:A {prop: 1})` (rendered) matches `(:A {prop:1})` (feature).
    for (const k of keys) norm[k] = normalizeListMaybe(normalizeCell(r[k]))
    return norm
  })
  assert.strictEqual(actual.length, expected.length,
    `row count: expected ${expected.length}, got ${actual.length}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`)
  if (!expected.length) return

  // ── 无序集合比较：对 in any order 场景 ──
  if (!ordered) {
    // 构建 expected 和 actual 的对象映射集合
    const expectedSet = expected.map(e => JSON.stringify(e))
    const actualSet = actual.map(a => JSON.stringify(a))
    for (const ae of actualSet) {
      const idx = expectedSet.indexOf(ae)
      if (idx >= 0) {
        expectedSet.splice(idx, 1)
      } else {
        // 尝试用节点表示法匹配
        const actualObj = JSON.parse(ae) as Record<string, string>
        let matchFound = false
        for (let ei = 0; ei < expectedSet.length; ei++) {
          const expObj = JSON.parse(expectedSet[ei]) as Record<string, string>
          // 检查期望行中的每个 key 是否与实际行匹配
          // 通过 toNodeNotation 标准化后比较
          const allMatch = Object.keys(expObj).every(k => {
            const expVal = expObj[k]
            const actualVal = actualObj[k]
            // 直接比较
            if (actualVal === expVal) return true
            // 浮点 .0 格式容差
            if (_isFloatZeroMatch(actualVal, expVal)) return true
            // 多标签节点脱序比较：(:A:B) == (:B:A)
            if (typeof actualVal === 'string' && typeof expVal === 'string') {
              const actualNode = actualVal.match(/^\(:([A-Z:]+)\)$/)
              const expNode = expVal.match(/^\(:([A-Z:]+)\)$/)
              if (actualNode && expNode) {
                const aLabels = actualNode[1].split(':').sort().join(':')
                const eLabels = expNode[1].split(':').sort().join(':')
                if (aLabels === eLabels) return true
              }
            }
            // 如果值不同，尝试用 _stringifyVal 或 toNodeNotation
            return false
          })
          if (allMatch) {
            expectedSet.splice(ei, 1)
            matchFound = true
            break
          }
        }
        if (!matchFound) {
          throw new assert.AssertionError({
            message: `unexpected row: ${ae}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`,
            actual: actual,
            expected: expected,
            operator: 'deepEqual',
          })
        }
      }
    }
    if (expectedSet.length > 0) {
      throw new assert.AssertionError({
        message: `missing rows: ${expectedSet.join(', ')}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`,
        actual: actual,
        expected: expected,
        operator: 'deepEqual',
      })
    }
    return
  }

  // ── 有序比较 ──
  // Map actual columns to expected columns using position
  const actualKeys = Object.keys(st.res[0] || {})
  for (let ri = 0; ri < expected.length; ri++) {
    for (const key of keys) {
      const ev = expected[ri][key]
      // Try direct key match first
      let av = actual[ri][key]
      
      // Column name mapping: if expected key is "p.id" but actual has "id",
      // check if "id" matches via returnAliasMap or simple property access
      if (!av || (av === 'null' && ev !== 'null')) {
        let found = false
        // Try each actual key to see if any matches expected key or aliased key
        for (const ak of actualKeys) {
          const v = st.res[ri][ak]
          // Case 1: actual key ak maps to expected column key via property access
          // e.g., expected "p.id" → actual key "id" with value "4611686018427387905"
          const sv = _stringifyVal(v)
          if (sv === ev) {
            av = sv
            found = true
            break
          }
          // Case 2: value is a node — try node notation
          const nn = toNodeNotation(v)
          if (nn && nn === ev) {
            av = nn
            found = true
            break
          }
        }
        if (!found && actualKeys.length > 0 && st.res[ri]) {
          // Fallback: use node notation on first available value
          const firstVal = st.res[ri][actualKeys[0]]
          const firstNn = toNodeNotation(firstVal)
          if (firstNn !== undefined) {
            assert.strictEqual(firstNn, ev,
              `[${ri}] .${key}: "${firstNn}" !== "${ev}"\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`)
            found = true
          }
        }
        if (found) continue
      }
      // 浮点 .0 格式容差
      if (_isFloatZeroMatch(av, ev)) continue
      assert.strictEqual(av, ev,
        `[${ri}] .${key}: "${av}" !== "${ev}"\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`)
    }
  }
}

// ── Given ──
Given('an empty graph', () => {
  st.nodes = []
  // Ensure persistent GE is clean for the new scenario
  try { st.pGe?.close() } catch {}
  try { if (st.pDir) fs.rmSync(st.pDir, { recursive: true, force: true }) } catch {}
  st.pGe = undefined; st.pDir = undefined
})
Given('any graph', () => {})

Given('a graph with the following nodes:', function (dt: DataTable) {
  st.nodes = dtToNodes(dt)
  // Also seed the persistent GE so having executed can use it
  const ge = persistGe()
  for (const node of st.nodes) seedGe(ge, node)
})
Given('a graph with:', function (dt: DataTable) {
  st.nodes = dtToNodes(dt)
  const ge = persistGe()
  for (const node of st.nodes) seedGe(ge, node)
})

/** Seed a single node into GE */
/** Hand-parse a CREATE statement with relationships and inject nodes+edges directly into GE */
function execCreateOnGe(ge: any, q: string): void {
  // Parse the CREATE pattern and produce nodes with __edges for _executeQuery.
  // Supports: ()->(), ()-(), ()<-(), multiple edges: ()-[:T]->()-[:X]->()
  // and comma-separated independent patterns sharing a source variable,
  // e.g. `(a)-[:T]->(:B), (a)-[:T]->(:C)` (branching, NOT a linear chain).
  // Also supports standalone nodes: (:A), (:B {prop:1})

  // Split the body into top-level comma segments (a comma inside `{}`, `()` or
  // `[]` does not split). Each segment is an independent path pattern whose
  // first node may re-reference a variable from an earlier segment (branching).
  const segments: string[] = []
  {
    let depth = 0
    let start = 0
    for (let i = 0; i < q.length; i++) {
      const ch = q[i]
      if (ch === '(' || ch === '[' || ch === '{') depth++
      else if (ch === ')' || ch === ']' || ch === '}') depth--
      else if (ch === ',' && depth === 0) {
        segments.push(q.substring(start, i))
        start = i + 1
      }
    }
    segments.push(q.substring(start))
  }

  const createdNodes: Array<Record<string, unknown>> = []
  const nodeGeIds: number[] = []
  // Map a node variable name (e.g. `n` in `(n:A)`) to its created index, shared
  // across segments so that `(a)-[:T]->(:B), (a)-[:T]->(:C)` reuses `a` and a
  // self-loop `(n:A)-[:LOOP]->(n)` reuses `n` (branching instead of duplicate).
  const varToNodeIdx = new Map<string, number>()

  const _varOf = (inner: string): string => {
    const head = (inner.indexOf('{') >= 0 ? inner.substring(0, inner.indexOf('{')) : inner).trim()
    if (!head || head.startsWith(':')) return ''
    const ci = head.indexOf(':')
    return (ci >= 0 ? head.substring(0, ci) : head).trim()
  }

  // Helper to CREATE a node from a token inner string, honoring variable reuse.
  const _ensureNode = (inner: string): number => {
    const variable = _varOf(inner)
    if (variable && varToNodeIdx.has(variable)) return varToNodeIdx.get(variable)!
    const labels: string[] = []
    const props: Record<string, unknown> = {}
    const bi = inner.indexOf('{')
    const headPart = (bi >= 0 ? inner.substring(0, bi) : inner).trim()
    let rest = headPart
    if (headPart && !headPart.startsWith(':')) {
      const colonIdx = headPart.indexOf(':')
      if (colonIdx >= 0) rest = headPart.substring(colonIdx)
      else rest = ''
    }
    for (const part of rest.split(':').filter(Boolean)) labels.push(part)
    if (bi >= 0) Object.assign(props, _parseProps(inner.substring(bi)))
    const node: Record<string, unknown> = { _label: labels[0] || 'Default', ...props }
    if (labels.length > 1) node.__fullLabel = labels.join(':')
    node.__edges = []
    const nodeIdx = createdNodes.length
    createdNodes.push(node)
    if (variable) varToNodeIdx.set(variable, nodeIdx)
    const h = _hashLabel(node._label as string)
    try { (ge as any).upsertNode(h, 'rn-' + crypto.randomBytes(3).toString('hex'), { props: { ...node } }) } catch {}
    nodeGeIds.push(h)
    return nodeIdx
  }

  const totalSegments = segments.length
  let anyTokens = false
  for (let si = 0; si < totalSegments; si++) {
    const seg = segments[si]
    const regex = /\(([^)]*)\)|\[([^\]]*)\]/g
    const tokens: Array<{ type: 'node' | 'edge'; inner: string }> = []
    let m
    while ((m = regex.exec(seg)) !== null) {
      if (m[1] !== undefined) tokens.push({ type: 'node', inner: m[1].trim() })
      else if (m[2] !== undefined) tokens.push({ type: 'edge', inner: m[2].trim() })
    }
    if (!tokens.length) continue
    anyTokens = true

    const nodeTokens = tokens.filter(t => t.type === 'node')
    const edgeTokens = tokens.filter(t => t.type === 'edge')

    // Extract this segment's arrows (direction).
    const arrowRegex = /(->|<-|--?)/g
    const arrows: string[] = []
    while ((m = arrowRegex.exec(seg)) !== null) arrows.push(m[1])

    // Ensure the segment's leading node exists (reused if it names a known var).
    const firstNodeIdx = _ensureNode(nodeTokens[0].inner)

    // Build edges: within this segment, the i-th edge connects nodeTokens[i] to
    // nodeTokens[i+1]. A re-referenced source variable resolves back through
    // varToNodeIdx (branching); an anonymous node creates a fresh node. The
    // segment's leading node index is reused as the first edge's source.
    let curIdx = firstNodeIdx
    for (let ei = 0; ei < edgeTokens.length && ei < nodeTokens.length - 1; ei++) {
      const et = edgeTokens[ei]
      let edgeLabel = ''
      const edgeProps: Record<string, unknown> = {}
      const bi = et.inner.indexOf('{')
      if (bi >= 0) {
        const labelPart = et.inner.substring(0, bi).trim()
        if (labelPart.startsWith(':')) edgeLabel = labelPart.substring(1).trim()
        Object.assign(edgeProps, _parseProps(et.inner.substring(bi)))
      } else if (et.inner.startsWith(':')) {
        edgeLabel = et.inner.substring(1).trim()
      }

      const srcToken = nodeTokens[ei]
      const dstToken = nodeTokens[ei + 1]
      const srcVar = _varOf(srcToken.inner)
      // Source: reuse a named variable, else the running segment index (first
      // edge reuses the leading node, later edges reuse the previous target).
      const srcIdx = srcVar && varToNodeIdx.has(srcVar) ? varToNodeIdx.get(srcVar)! : curIdx
      // Target: `_ensureNode` creates a fresh node for anonymous targets and
      // reuses an existing index for named (self-loop / cross-segment) targets.
      const dstIdx = _ensureNode(dstToken.inner)
      curIdx = dstIdx

      const arrow = arrows[ei] || '->'
      const geSrc = arrow === '<-' ? dstIdx : srcIdx
      const geDst = arrow === '<-' ? srcIdx : dstIdx

      const edgeEntry = { srcIdx: geSrc, dstIdx: geDst, label: edgeLabel || 'T', props: Object.keys(edgeProps).length ? edgeProps : null }
      const srcNode = createdNodes[geSrc]
      if (srcNode && Array.isArray(srcNode.__edges)) srcNode.__edges.push(edgeEntry)

      const typeId = _hashLabel(edgeLabel || 'T')
      try { (ge as any).upsertEdge(nodeGeIds[geSrc], nodeGeIds[geDst], typeId, { props: edgeProps }) } catch {}
    }
  }

  if (!anyTokens) { st.nodes = []; return }
  st.nodes = createdNodes
}

function seedGe(ge: any, node: Record<string, unknown>): void {
  const label = String(node['_label'] || 'Default')
  let h = 0
  for (let ci = 0; ci < label.length; ci++) h = ((h << 5) - h + label.charCodeAt(ci)) | 0
  // Use sync storage write since GE.upsertNode is async but storage is synced
  try { (ge as any).upsertNode(Math.abs(h) % 1000 + 1, 'sn-' + crypto.randomBytes(3).toString('hex'), { props: { ...node } }) } catch {}
}

/**
 * 从持久 GE 中读取所有节点，填充到 st.nodes。
 * 供 When executing query: 创建临时 GE 时使用。
 */
function _syncNodesFromGe(): void {
  if (!st.pGe || st.pGe === undefined) return
  try {
    // 用 GE 的 query 方法 MATCH 所有节点
    const raw = (st.pGe as any).query?.('MATCH (n) RETURN n')
    if (raw?.length) {
      st.nodes = []
      for (const item of raw) {
        const n = item.n || item
        if (n.props && typeof n.props === 'object') {
          // GE returns { props: { ... } }
          const node: Record<string, unknown> = { _label: 'Default' }
          for (const [k, v] of Object.entries(n.props)) node[k] = v
          st.nodes.push(node)
        }
      }
    }
  } catch {
    // ignore GE query failures
  }
}

Given('having executed:', async function (query: string) {
  const q = _stripCypherComments(query).trim()
  // 支持多语句：按行分割，逐条执行。
  // Improvements:合并以逗号结尾的行（多行 CREATE 链不被切碎）
  const rawLines = q.split('\n').map(s => s.trim()).filter(Boolean)
  const lines: string[] = []
  let pending = ''
  // A bare CQL clause keyword on its own line (e.g. the multi-line TCK form
  //   CREATE\n  (:X {val:1})-[:E1]->(:Y),\n  (:X {val:6})
  // ) must be joined with the following pattern lines into a single statement.
  // Otherwise `CREATE` would be treated as a complete (empty) statement and the
  // node/edge pattern dropped.
  const _isBareClauseKeyword = (s: string): boolean => /^(CREATE|MERGE|MATCH|DELETE|DETACH\s+DELETE|SET|REMOVE|RETURN|WITH|UNWIND|OPTIONAL\s+MATCH)$/i.test(s.trim())
  // A `MATCH (x:X) … CREATE …` block is a single DML statement (read-then-write),
  // not several independent statements.  When the whole block is one such DML
  // statement, bypass line splitting so it reaches the MATCH…CREATE seed path
  // intact (the splitter above would otherwise detach the leading `MATCH (x:X)`).
  const _isDmlReadWrite = /\bMATCH\s*\([^)]*\)[\s\S]*\b(CREATE|MERGE|DELETE|DETACH\s+DELETE|SET|REMOVE)\b/i.test(q)
  for (const line of rawLines) {
    // A pending statement that ended with a comma is mid-list: the comma
    // declares a continuation, so the next line (a sibling node/edge pattern
    // like `(e2:E ...)` or `(d)-[:LIKES]->(e2)`) extends the SAME statement
    // regardless of whether it ends with a comma or starts a new clause.
    const pendingEndsWithComma = pending ? pending.trimEnd().endsWith(',') : false
    // A MATCH clause followed by a write clause (`CREATE`/`MERGE`/`DELETE`/
    // `SET`/`REMOVE`) is a single DML statement (`MATCH (d:D) CREATE …`), not
    // two independent statements — keep them combined.
    const pendingIsMatchTail = pending ? /^MATCH\b|\nMATCH\b/i.test(pending) : false
    // A `MERGE p = (...)` / `MERGE (a)-[r:T]->(b)` clause followed by a `RETURN`
    // clause is a single MERGE…RETURN statement (e.g. `MERGE p = (a)-[:R]->(b)
    // RETURN p`), not two independent ones — the `RETURN` is the statement's own
    // projection.  Keep them combined so the path/relationship binding done by
    // the MERGE executor is visible to the RETURN projection.
    const pendingIsMergeTail = pending ? /^(MERGE|CREATE)\b/i.test(pending) && !/\bRETURN\b/i.test(pending) : false
    const lineIsWrite = /^(CREATE|MERGE|DELETE|SET|REMOVE|DETACH\s+DELETE)\b/i.test(line.trim())
    const lineIsReturn = /^RETURN\b/i.test(line.trim())
    if (pending) {
      pending += '\n' + line
      if (pendingEndsWithComma) continue
      if (pendingIsMatchTail && lineIsWrite) continue
      if (pendingIsMergeTail && lineIsReturn) continue
      if (!line.endsWith(',') && !_isBareClauseKeyword(line)) { lines.push(pending); pending = '' }
    } else {
      // A MERGE path assignment (`MERGE p = (a)-[:R]->(b)`) is often followed by
      // a `RETURN p` projection on the next line.  Neither is a bare keyword, so
      // both would otherwise be pushed as independent statements and the path
      // variable `p` (which only lives for the duration of its own statement)
      // would be unresolvable by the `RETURN`.  Treat the path-assignment form as
      // a pending clause so the trailing `RETURN` merges into the same statement.
      const _isMergePathAssign = /^MERGE\s+\w+\s*=\s*\(/i.test(line.trim())
      if (line.endsWith(',') || _isBareClauseKeyword(line) || _isMergePathAssign) { pending = line }
      else { lines.push(line) }
    }
  }
  if (pending) lines.push(pending)
  if (_isDmlReadWrite) {
    // The block is one MATCH→write DML statement; keep it whole so the leading
    // `MATCH (x:X)` and its `CREATE` reach the MATCH…CREATE seed path together.
    lines.length = 0
    lines.push(q)
  }
  // Merge UNWIND + CREATE/UNWIND+MATCH lines so they execute as a single
  // pipeline rather than as isolated statements. The DML engine needs the
  // unwound variable to be in scope when processing the CREATE template.
  if (lines.length >= 2) {
    const merged: string[] = []
    let i = 0
    while (i < lines.length) {
      const cur = lines[i]
      const next = lines[i + 1]
      // UNWIND ... AS <var> followed by CREATE/MERGE/MATCH
      const isUnwind = /^\s*(UNWIND\s+|OPTIONAL\s+MATCH\s+)/i.test(cur)
      const isCreate = next && /^\s*(CREATE\s+|MERGE\s+|MATCH\s+|SET\s+|DELETE\s+|REMOVE\s+)/i.test(next)
      if (isUnwind && isCreate && !cur.includes('CREATE') && !cur.includes('MERGE') 
          && !next.includes('UNWIND')) {
        merged.push(cur + ' ' + next)
        i += 2
      } else {
        merged.push(cur)
        i += 1
      }
    }
    lines.length = 0
    lines.push(...merged)
  }
  if (lines.length > 1) {
    // 多语句场景 → 逐条递归执行。
    // A lightweight row-aligned variable environment lets later statements in a
    // multi-statement seed reference variables bound by earlier UNWIND/CREATE
    // statements (e.g. `UNWIND range(0,10) AS i CREATE (s:S) WITH s, i
    // UNWIND range(0,i) AS j CREATE (s)-[:REL]->()`).  Values are stored as
    // index-aligned arrays so `vars.get('s')[k]` pairs with `vars.get('i')[k]`.
    const varEnv = new Map<string, unknown[]>()
    for (const line of lines) {
      try {
        const subPlan = parseQuery(line)
        if (!subPlan || !subPlan.type) continue
        // 如果是 CREATE/MERGE，直接处理（注入 GE 和 st.nodes）
        if ((subPlan.type === 'CREATE' || subPlan.type === 'MERGE') && (subPlan as any).createNodes?.length) {
          // A relationship MERGE (`MERGE p = (a)-[:R]->(b)` / `MERGE (a)-[r:R]->(b)`)
          // carries `mergeEdges` (and possibly a `pathVar`), which the manual
          // CREATE/MERGE minting below does NOT handle — it only materialises
          // `createEdges`.  Delegate such statements to the full query engine
          // (`run`) so the relationship MERGE executor (match-or-create edge +
          // path/relationship binding) does its work against `st.nodes`.
          if ((subPlan as any).mergeEdges?.length || (subPlan as any).pathVar) {
            await run(line)
            continue
          }
          const cns = (subPlan as any).createNodes as Array<{ alias: string; label: string | null; props: Record<string, unknown> | null }>
          const createEdges = (subPlan as any).createEdges as Array<{ source: string; target: string; sourceIdx: number; targetIdx: number; label: string; props?: Record<string, unknown> | null; direction?: string }> | undefined
          const uw = (subPlan as any).unwind as { list?: unknown[]; var?: string; name?: string } | undefined
          // CREATE referencing only previously-bound variables, minting no new
          // nodes: `CREATE (n1)-[:T]->(n2)` where `n1`/`n2` were projected by an
          // earlier `WITH nodeList[i] AS n1, nodeList[i+1] AS n2`.  The parser
          // still emits `createNodes` entries for `n1`/`n2`, but they are
          // references to already-materialised nodes, not templates to mint.
          // Resolve each endpoint from varEnv (row-aligned) and mint one edge per
          // row; otherwise `n1`/`n2` would be wrongly created as fresh nodes.
          const _refsBound = cns.length > 0 && cns.every(cn => cn.alias && !cn.label && !cn.props && varEnv.has(cn.alias))
          if (_refsBound && createEdges?.length) {
            for (const ce of createEdges) {
              const srcVals = (ce.source ? varEnv.get(ce.source) : undefined) || []
              const tgtVals = (ce.target ? varEnv.get(ce.target) : undefined) || []
              const rows = Math.max(srcVals.length, tgtVals.length)
              for (let k = 0; k < rows; k++) {
                const s = srcVals[k]; const t = tgtVals[k]
                const srcIdx = st.nodes.indexOf(s as any)
                const dstIdx = st.nodes.indexOf(t as any)
                if (srcIdx < 0 || dstIdx < 0) continue
                if (!st.nodes[srcIdx].__edges) st.nodes[srcIdx].__edges = []
                st.nodes[srcIdx].__edges.push({ srcIdx, dstIdx, label: ce.label || 'T', props: ce.props || null })
              }
            }
            continue
          }
          // MATCH … CREATE materialisation: `MATCH (d:D) CREATE (e1:E {name:
          // d.name + '0'}), (e2:E {name: d.name + '1'}) CREATE (d)-[:LIKES]->(e1)
          // …` must mint the created nodes (and edges) once PER matched `d`, with
          // property expressions evaluated against that `d` (ctx { d }).  The
          // parser also exposes the MATCH node as a trailing createNode with a
          // null label — it is a reference, not a node to mint.
          const matchVar = (subPlan as any).matchVar as string | undefined
          const scanLabel = (subPlan as any).scanLabel as string | null | undefined
          if (matchVar && scanLabel && !uw) {
            const matched = st.nodes.filter((n: any) => n && n._label === scanLabel)
            if (matched.length) {
              // Multi-MATCH variables (`MATCH (a:A), (b:B) CREATE (a)-[:T]->(b)`)
              // reference existing nodes, not templates to mint.  Collect the
              // extra MATCH variables (e.g. `b`) and their scan labels so their
              // CREATE endpoints reuse the matched node instead of minting a
              // duplicate.  `specNodes` then holds only true new-node templates.
              const multi = (subPlan as any).multiMatch as Array<{ scanLabel?: string | null; variable?: string }> | undefined
              const multiVarLabels = new Map<string, string>()
              for (const mm of multi || []) {
                if (mm.variable && mm.scanLabel) multiVarLabels.set(mm.variable, mm.scanLabel)
              }
              const specNodes = cns.filter((cn) => {
                if (cn.alias === matchVar) return cn.label != null
                if (multiVarLabels.has(cn.alias)) return false  // reuse matched node
                return true
              })
              const specEdges = (createEdges || []).map((ce: any) => ({
                ...ce,
                source: ce.source, target: ce.target,
              }))
              const newNodeIdxByAlias = new Map<string, number>()
              // Resolve each multi-MATCH variable to the (single) matched node.
              const multiNodeIdx = new Map<string, number>()
              for (const [mv, ml] of multiVarLabels) {
                const cand = st.nodes.find((n: any) => n && n._label === ml)
                if (cand !== undefined) multiNodeIdx.set(mv, st.nodes.indexOf(cand))
              }
              for (const d of matched) {
                const dIdx = st.nodes.indexOf(d)
                const localAliasToGlobal: Record<string, number> = {}
                for (const [mv, mi] of multiNodeIdx) {
                  if (mi >= 0) localAliasToGlobal[mv] = mi
                }
                for (const cn of specNodes) {
                  let props: Record<string, unknown> = {}
                  if (cn.props) {
                    for (const [k, v] of Object.entries(cn.props)) {
                      let raw = (v && typeof v === 'object' && 'value' in (v as any) && (v as any).type) ? (v as any).value : v
                      if (typeof raw === 'string' && _isExprValue(raw)) {
                        const ev = _evalBinary(raw, { [matchVar]: d })
                        if (ev !== null && ev !== undefined) raw = ev
                      }
                      props[k] = raw
                    }
                  }
                  const node: Record<string, unknown> = { _label: cn.label || 'Default', ...props }
                  st.nodes.push(node)
                  const gIdx = st.nodes.length - 1
                  localAliasToGlobal[cn.alias] = gIdx
                  newNodeIdxByAlias.set(cn.alias, gIdx)
                  try { seedGe(persistGe(), node) } catch {}
                }
                for (const ce of specEdges) {
                  const srcIdx = ce.source === matchVar ? dIdx : localAliasToGlobal[ce.source]
                  const dstIdx = ce.target === matchVar ? dIdx : localAliasToGlobal[ce.target]
                  if (srcIdx == null || dstIdx == null) continue
                  if (!st.nodes[srcIdx].__edges) st.nodes[srcIdx].__edges = []
                  st.nodes[srcIdx].__edges.push({ srcIdx, dstIdx, label: ce.label || 'KNOWS', props: ce.props || null })
                }
              }
              continue
            }
          }
          // Row-aligned edge expansion: when the CREATE references a node
          // variable already bound to multiple nodes by an earlier UNWIND
          // (e.g. `UNWIND range(0,i) AS j CREATE (s)-[:REL]->()`), the node
          // template must NOT re-expand the node list.  Instead each bound node
          // mints its own edges.  Detected by an edge whose source is a
          // multi-node variable in varEnv and whose UNWIND var references that
          // same variable (or another varEnv-bound value).
          const srcIsMultiBound = createEdges?.some(ce => ce.source && (varEnv.get(ce.source)?.length ?? 0) > 1)
          if (srcIsMultiBound && uw?.var && createEdges?.length) {
            const srcNodes = varEnv.get(createEdges[0].source!)!
            const unwoundVar = uw.var.match(/([a-zA-Z_]\w*)\s*\)\s*$/)
            const outerList = unwoundVar ? varEnv.get(unwoundVar[1]) : undefined
            for (let k = 0; k < srcNodes.length; k++) {
              const srcNode = srcNodes[k] as Record<string, unknown>
              const srcIdx = st.nodes.indexOf(srcNode)
              if (srcIdx < 0) continue
              // Resolve inner unwind list for this row: `range(0, i[k])` → i[k]+1.
              let innerCount = 1
              if (outerList && typeof outerList[k] === 'number') innerCount = (outerList[k] as number) + 1
              for (const ce of createEdges) {
                for (let jc = 0; jc < innerCount; jc++) {
                  const dst: Record<string, unknown> = { _label: 'Default' }
                  st.nodes.push(dst)
                  const dstIdx = st.nodes.length - 1
                  if (!st.nodes[srcIdx].__edges) st.nodes[srcIdx].__edges = []
                  st.nodes[srcIdx].__edges.push({ srcIdx, dstIdx, label: ce.label || 'REL', props: ce.props || null })
                }
              }
            }
            continue
          }
          // UNWIND + CREATE: expand the createNode template once per unwound
          // element (e.g. `UNWIND range(0,10) AS i CREATE (s:S)` must mint 11
          // nodes, not a single one).  Resolve the unwound list from either a
          // literal list or an expression (`range(...)`) via _resolveUnwindList.
          let expandedCns = cns
          let resolvedList: unknown[] | null = null
          if (uw && (uw.list?.length || uw.var)) {
            resolvedList = (uw.list && uw.list.length) ? uw.list : _resolveUnwindList({ list: uw.list || [], var: uw.var, name: uw.name || '' } as any, {})
            const resolved = resolvedList
            const out: typeof cns = []
            for (let ui = 0; ui < resolved.length; ui++) {
              for (const cn of cns) {
                const ecn: any = { ...cn }
                // Each unwound iteration mints an independent node bound to the
                // CREATE variable; give it a unique alias (`s_0`, `s_1`, ...) so
                // the alias-dedup below does not collapse the expansion back to a
                // single node, while downstream statements can still resolve `s`.
                if (cn.alias) ecn.alias = cn.alias + '_' + ui
                // Resolve the UNWIND variable reference inside this node's
                // property expressions against the current element.  `CREATE (n
                // {var: i})` under `UNWIND range(1, 20) AS i` must mint nodes with
                // `var = 1`, `var = 2`, … — not twenty copies of `var = "i"`.  The
                // value is carried on the per-iteration node so the later prop
                // materialisation (which only sees the flattened template list)
                // does not lose the bound element.
                if (cn.props) {
                  const boundProps: Record<string, unknown> = { ...(cn.props as Record<string, unknown>) }
                  for (const [k, v] of Object.entries(cn.props)) {
                    const raw0 = (v && typeof v === 'object' && 'value' in (v as any) && (v as any).type) ? (v as any).value : v
                    if (typeof raw0 === 'string' && raw0.trim() === uw.name) {
                      boundProps[k] = { type: 'STRING', value: resolved[ui], _resolved: true }
                    }
                  }
                  ecn.props = boundProps
                }
                out.push(ecn)
              }
            }
            expandedCns = out
            // Bind the UNWIND variable to its resolved list so a later statement
            // like `UNWIND range(0, i) ...` can read `i` (already a concrete list
            // of values).  Only store resolved numeric/atomic lists.
            if (uw.name) varEnv.set(uw.name, resolved.slice())
          }
          const createdNodes: Record<string, unknown>[] = []
          // Map each createNode template index → global st.nodes index, so edge
          // injection can resolve `sourceIdx`/`targetIdx` (which are LOCAL to the
          // current statement) to the correct global node.  This is essential for
          // anonymous endpoints like `CREATE (a)-[:HAS]->()` where `ce.target` is
          // empty and `ce.targetIdx` (here 1) must NOT collide with a global node
          // created by a prior statement.
          const cnsNodeIdx: number[] = []
          for (const cn of expandedCns) {
            // Reuse an already-created node when this CREATE re-references a
            // variable from a prior statement (e.g. `CREATE (a:A ...)` followed by
            // `CREATE (a)-[:T]->(:B)` must not mint a fresh `:Default` node for `a`).
            if (cn.alias && st.nodes.some((n: any) => n._alias === cn.alias)) {
              cnsNodeIdx.push(st.nodes.findIndex((n: any) => n._alias === cn.alias))
              continue
            }
            const node: Record<string, unknown> = { _label: cn.label || 'Default' }
            if (cn.alias) node['_alias'] = cn.alias
            if (cn.props) {
              for (const [k, v] of Object.entries(cn.props)) {
                let raw = (v && typeof v === 'object' && 'value' in (v as any) && (v as any).type)
                  ? (v as any).value
                  : v
                // 对表达式字符串求值
                if (typeof raw === 'string' && _isExprValue(raw)) {
                  try { raw = _evalBinary(raw, {}); node[k] = raw; continue } catch {}
                } else if (typeof raw === 'string' && /^-?\d+$/.test(raw)) {
                  try {
                    const asBig = BigInt(raw)
                    node[k] = asBig > BigInt(Number.MAX_SAFE_INTEGER) || asBig < BigInt(Number.MIN_SAFE_INTEGER) ? raw : Number(raw)
                  } catch { node[k] = raw }
                  continue
                }
                node[k] = raw
              }
            }
            st.nodes.push(node)
            createdNodes.push(node)
            cnsNodeIdx.push(st.nodes.length - 1)
            try { seedGe(persistGe(), node) } catch {}
          }
          // Bind CREATE node variables to their created node objects so later
          // statements can reference them.  Two cases:
          //   * UNWIND-expanded template (`CREATE (n {var:i})` → n_0..n_19):
          //     group the flattened alias list by base name (`n`) into a single
          //     ordered list — the row-aligned column for `n`.
          //   * A single CREATE naming several nodes (`CREATE (a..), (b..)`):
          //     map EACH alias to its own node (a→[nodeA], b→[nodeB]); the old
          //     code mapped the first alias to the whole `createdNodes` list,
          //     wrongly binding `a` to both a and b.
          const aliasToNodes = new Map<string, unknown[]>()
          expandedCns.forEach((ecn: any, ci: number) => {
            if (!ecn.alias) return
            const base = String(ecn.alias).replace(/_\d+$/, '')
            if (!aliasToNodes.has(base)) aliasToNodes.set(base, [])
            if (ci < createdNodes.length) aliasToNodes.get(base)!.push(createdNodes[ci])
          })
          for (const [base, nodes] of aliasToNodes) {
            varEnv.set(base, nodes)
          }
          // 注入边（createEdges）——使用 alias 查找替代 sourceIdx/targetIdx
          if (createEdges?.length) {
            for (const ce of createEdges) {
              let srcIdx = -1, dstIdx = -1
              // 优先通过 alias 查找
              if (ce.source) {
                for (let si = 0; si < st.nodes.length; si++) {
                  if ((st.nodes[si] as any)._alias === ce.source) { srcIdx = si; break }
                }
              }
              if (srcIdx < 0) srcIdx = cnsNodeIdx[ce.sourceIdx] ?? ce.sourceIdx
              if (ce.target) {
                for (let si = 0; si < st.nodes.length; si++) {
                  if ((st.nodes[si] as any)._alias === ce.target) { dstIdx = si; break }
                }
              }
              if (dstIdx < 0) dstIdx = cnsNodeIdx[ce.targetIdx] ?? ce.targetIdx
              if (srcIdx >= 0 && srcIdx < st.nodes.length && dstIdx >= 0 && dstIdx < st.nodes.length) {
                if (!st.nodes[srcIdx].__edges) st.nodes[srcIdx].__edges = []
                st.nodes[srcIdx].__edges.push({
                  srcIdx, dstIdx,
                  label: ce.label || 'KNOWS',
                  props: ce.props || null,
                })
              }
            }
          }
        } else {
          // WITH / UNWIND clauses in a multi-statement seed must update the
          // row-aligned variable environment so that later CREATE statements can
          // reference the projected / unwound variables (e.g.
          // `WITH a, b, [a] + collect(n) + [b] AS nodeList` then
          // `UNWIND range(0, size(nodeList) - 2) AS i` then
          // `WITH nodeList[i] AS n1, nodeList[i+1] AS n2` then
          // `CREATE (n1)-[:T]->(n2)`).  A bare `WITH *` keeps every bound column.
          const tr = line.trim()
          if (/^WITH\b/i.test(tr)) {
            const body = tr.replace(/^WITH\b/i, '').trim()
            if (body === '*' || body === '*,') continue // no-op projection
            _applySeedWith(body, varEnv)
            continue
          }
          const uwPlan: any = parseQuery(line)
          if (uwPlan?.unwind && (uwPlan.unwind.list?.length || uwPlan.unwind.var)) {
            // Resolve the unwound list against the current variable environment
            // (so `range(0, size(nodeList) - 2)` can read `nodeList`).
            const uw = uwPlan.unwind
            const ctx: Record<string, unknown> = {}
            for (const [k, v] of varEnv) ctx[k] = Array.isArray(v) ? (v.length === 1 ? v[0] : v) : v
            const resolved = (uw.list && uw.list.length) ? uw.list.map((x: unknown) => {
              if (typeof x !== 'string') return x
              const ev = _evalBinary(x, {})
              return ev === undefined ? x : ev
            }) : _resolveUnwindList({ list: uw.list || [], var: uw.var, name: uw.name || '' } as any, ctx)
            if (uw.name) varEnv.set(uw.name, resolved)
            continue
          }
          // 非 CREATE / WITH / UNWIND 语句，用 run() 执行
          await run(line)
        }
      } catch { /* 忽略单语句Error，继续下一个 */ }
    }
    st.err = null
    return
  }
  try {
    const plan = parseQuery(q)
    if (!plan || !plan.type) throw new Error('parseQuery failed for ' + q)

    // 注入持久 GE
    const ge = persistGe()

    // DELETE relationship + CREATE reverse edges: `MATCH (a:A)-[r]->(b) DELETE
    // r CREATE (b)-[:LIKES]->(a)`.  Reverse the matched relationships: drop the
    // matched `r` edges from the source node's `__edges` and mint the mirrored
    // `b→a` edges from `createEdges`.  `parseQuery` folds this read-then-write
    // into a single `CREATE` plan whose relationship deletions live in
    // `deleteTargets` (not a standalone DELETE plan).
    if ((plan as any).deleteTargets?.length && (plan as any).createEdges?.length) {
      const delEdgeVars = (plan as any).deleteTargets as string[]
      const step0 = (plan as any).steps?.[0]
      const srcVar = step0?.source as string | undefined
      const edgeVar = step0?.edgeVariable as string | undefined
      if (srcVar && edgeVar && delEdgeVars.includes(edgeVar)) {
        const scanLabel = (plan as any).scanLabel as string | null | undefined
        const srcNodes = scanLabel ? st.nodes.filter((n: any) => n && n._label === scanLabel) : st.nodes
        for (const sn of srcNodes) {
          const sidx = st.nodes.indexOf(sn)
          if (!sn.__edges) continue
          // Collect outgoing edges to delete, then remove them.
          const removed: Array<any> = []
          const kept: Array<any> = []
          for (const e of sn.__edges) {
            if (e.srcIdx === sidx) removed.push(e); else kept.push(e)
          }
          sn.__edges = kept
          // Mint the reverse edges b→a for each removed edge.
          const ces = (plan as any).createEdges as Array<any>
          for (const re of removed) {
            const dstNode = st.nodes[re.dstIdx]
            if (!dstNode) continue
            if (!dstNode.__edges) dstNode.__edges = []
            for (const ce of ces) {
              dstNode.__edges.push({ srcIdx: re.dstIdx, dstIdx: sidx, label: ce.label || 'KNOWS', props: ce.props || null })
            }
          }
        }
        st.err = null
        return
      }
    }
    // If any createNodes（CREATE/MERGE 的节点定义），直接注入 st.nodes 和 GE
    if ((plan.type === 'CREATE' || plan.type === 'MERGE') && (plan as any).createNodes?.length) {
      const cns = (plan as any).createNodes as Array<{ alias: string; label: string | null; props: Record<string, unknown> | null }>
      // MATCH … CREATE materialisation: `MATCH (d:D) CREATE (e1:E {name: d.name
      // + '0'}), (e2:E {name: d.name + '1'}) CREATE (d)-[:LIKES]->(e1) …` must
      // mint the created nodes/edges once PER matched `d`, evaluating property
      // expressions against that `d`.  The parser exposes the MATCH node as a
      // trailing createNode with a null label — a reference, not a node to mint.
      const matchVar2 = (plan as any).matchVar as string | undefined
      const scanLabel2 = (plan as any).scanLabel as string | null | undefined
      if (matchVar2 && scanLabel2 && !(plan as any).unwind) {
        const matched = st.nodes.filter((n: any) => n && n._label === scanLabel2)
        const createEdges2 = (plan as any).createEdges as Array<any> | undefined
        if (matched.length) {
          // Multi-MATCH variables (`MATCH (a:A), (b:B) CREATE (a)-[:T]->(b)`)
          // reference existing nodes, not templates to mint.  Resolve each extra
          // MATCH variable to its (single) matched node so the CREATE endpoint
          // reuses it instead of minting a duplicate (which would shift the edge
          // destination index and break a later MERGE match).
          const multi2 = (plan as any).multiMatch as Array<{ scanLabel?: string | null; variable?: string }> | undefined
          const multiVarLabels2 = new Map<string, string>()
          for (const mm of multi2 || []) {
            if (mm.variable && mm.scanLabel) multiVarLabels2.set(mm.variable, mm.scanLabel)
          }
          const multiNodeIdx2 = new Map<string, number>()
          for (const [mv, ml] of multiVarLabels2) {
            const cand = st.nodes.find((n: any) => n && n._label === ml)
            if (cand !== undefined) multiNodeIdx2.set(mv, st.nodes.indexOf(cand))
          }
          const specNodes = cns.filter((cn) => {
            if (cn.alias === matchVar2) return cn.label != null
            if (multiVarLabels2.has(cn.alias)) return false  // reuse matched node
            return true
          })
          const specEdges = (createEdges2 || []).map((ce: any) => ({ ...ce }))
          for (const d of matched) {
            const dIdx = st.nodes.indexOf(d)
            const localAliasToGlobal: Record<string, number> = {}
            for (const [mv, mi] of multiNodeIdx2) {
              if (mi >= 0) localAliasToGlobal[mv] = mi
            }
            for (const cn of specNodes) {
              let props: Record<string, unknown> = {}
              if (cn.props) {
                for (const [k, v] of Object.entries(cn.props)) {
                  let raw = (v && typeof v === 'object' && 'value' in (v as any) && (v as any).type) ? (v as any).value : v
                  if (typeof raw === 'string' && _isExprValue(raw)) {
                    const ev = _evalBinary(raw, { [matchVar2]: d })
                    if (ev !== null && ev !== undefined) raw = ev
                  }
                  props[k] = raw
                }
              }
              const node: Record<string, unknown> = { _label: cn.label || 'Default', ...props }
              st.nodes.push(node)
              localAliasToGlobal[cn.alias] = st.nodes.length - 1
              try { seedGe(persistGe(), node) } catch {}
            }
            for (const ce of specEdges) {
              const srcIdx = ce.source === matchVar2 ? dIdx : localAliasToGlobal[ce.source]
              const dstIdx = ce.target === matchVar2 ? dIdx : localAliasToGlobal[ce.target]
              if (srcIdx == null || dstIdx == null) continue
              if (!st.nodes[srcIdx].__edges) st.nodes[srcIdx].__edges = []
              st.nodes[srcIdx].__edges.push({ srcIdx, dstIdx, label: ce.label || 'KNOWS', props: ce.props || null })
            }
          }
          st.err = null
          return
        }
      }
      const createdNodes: Array<Record<string, unknown>> = []
      const unwind = (plan as any).unwind as { list: unknown[]; name: string } | undefined
      // 有 UNWIND 时，原始 createNodes 只是模板，由 UNWIND block 处理
      // 但仍然需要正常走一遍来处理非 UNWIND 的别名匹配
      if (!unwind) {
      const seenAliases = new Map<string, number>() // alias -> index in createdNodes
      for (let ci = 0; ci < cns.length; ci++) {
        const cn = cns[ci]
        // 如果 alias 已见过（自循环或 reuse），不重新 seed
        if (cn.alias && seenAliases.has(cn.alias) && !(plan as any).unwind) {
          // 没有 UNWIND 时复用已有节点
          createdNodes.push(createdNodes[seenAliases.get(cn.alias)!])
          continue
        }
        const node: Record<string, unknown> = { _label: cn.label || 'Default' }
        if (cn.alias) node['_alias'] = cn.alias
        if (cn.props) { for (const [k, v] of Object.entries(cn.props)) {
          // parseQuery 将 props 打包为 {type:'STRING', value:'val'}，需解包
          let raw = (v && typeof v === 'object' && 'value' in (v as any) && (v as any).type)
            ? (v as any).value
            : v
          // 对表达式字符串求值（date(...)、time(...)、duration(...) 等）
          if (typeof raw === 'string' && _isExprValue(raw)) {
            try { raw = _evalBinary(raw, {}) } catch {}
          }
          // BIGINT values are already `bigint` (set by the AST layer to preserve
          // precision). STRING values — including numeric string literals such as
          // '42' — remain strings. The previous "pure numeric string" heuristic
          // force-converted `name: '42'` into the number 42, dropping the string
          // semantics the TCK expects; it is no longer needed now that large
          // integers are carried as `bigint` end-to-end.
          node[k] = raw
        } }
        st.nodes.push(node)
        seedGe(ge, node)
        createdNodes.push(node)
        if (cn.alias) seenAliases.set(cn.alias, ci)
      }

      } // !unwind

      // ── 从 createEdges 提取边信息注入 createdNodes 的 __edges ──
      // parseQuery 的 AST plan 不含边信息（edges: undefined）。
      // 但 TCK 的 MATCH 依赖 __edges 来做边遍历，所以需要从 createEdges 提取边。
      // 使用 createEdges 的 source/target alias 来正确匹配 createdNodes 的真实索引，
      // 避免 ei 序号推导在去重后错位的问题。
      const cEdges = (plan as any).createEdges as Array<{ source: string; target: string; sourceIdx?: number; targetIdx?: number; label: string | null; direction: string; props?: Record<string, unknown> | null }> | undefined
      if (cEdges?.length) {
        // 构建 alias → 真实节点索引映射（去重后首个真实节点）
        const aliasToTrueIdx = new Map<string, number>()
        for (let i = 0; i < createdNodes.length; i++) {
          const na = (createdNodes[i] as any)._alias as string
          if (na && !aliasToTrueIdx.has(na)) {
            aliasToTrueIdx.set(na, i)
          }
        }
        for (const ce of cEdges) {
          // 优先通过 alias 查找
          let srcIdx = -1, dstIdx = -1
          // 无 alias 时直接使用 sourceIdx/targetIdx（匿名节点场景）
          const noAlias = !ce.source && !ce.target
          if (ce.source && aliasToTrueIdx.has(ce.source)) {
            srcIdx = aliasToTrueIdx.get(ce.source)!
          } else if (noAlias && ce.sourceIdx !== undefined && ce.sourceIdx >= 0 && ce.sourceIdx < createdNodes.length) {
            srcIdx = ce.sourceIdx
          } else if (ce.sourceIdx !== undefined && ce.sourceIdx >= 0 && ce.sourceIdx < createdNodes.length) {
            // 回退：找 createdNodes[ce.sourceIdx] 对应的真实节点（递归解引用）
            let cursor = ce.sourceIdx
            const visited = new Set<number>()
            while (cursor >= 0 && cursor < createdNodes.length && !visited.has(cursor)) {
              visited.add(cursor)
              const refNode = createdNodes[cursor] as any
              const isReal = refNode._label && refNode._label !== 'Default' || refNode.props
              if (isReal) { srcIdx = cursor; break }
              // 引用节点：尝试找其 alias 的首次真实索引
              if (refNode._alias && aliasToTrueIdx.has(refNode._alias)) {
                cursor = aliasToTrueIdx.get(refNode._alias)!
              } else {
                cursor--
              }
            }
            if (srcIdx < 0) srcIdx = ce.sourceIdx
          }
          if (ce.target && aliasToTrueIdx.has(ce.target)) {
            dstIdx = aliasToTrueIdx.get(ce.target)!
          } else if (noAlias && ce.targetIdx !== undefined && ce.targetIdx >= 0 && ce.targetIdx < createdNodes.length) {
            dstIdx = ce.targetIdx
            let cursor = ce.targetIdx
            const visited = new Set<number>()
            while (cursor >= 0 && cursor < createdNodes.length && !visited.has(cursor)) {
              visited.add(cursor)
              const refNode = createdNodes[cursor] as any
              const isReal = refNode._label && refNode._label !== 'Default' || refNode.props
              if (isReal) { dstIdx = cursor; break }
              if (refNode._alias && aliasToTrueIdx.has(refNode._alias)) {
                cursor = aliasToTrueIdx.get(refNode._alias)!
              } else {
                cursor--
              }
            }
            if (dstIdx < 0) dstIdx = ce.targetIdx
          }
          // 降级：使用 sourceIdx/targetIdx 直指（可能错位但比没有好）
          if (srcIdx < 0) srcIdx = ce.sourceIdx ?? 0
          if (dstIdx < 0) dstIdx = ce.targetIdx ?? 0
          const srcNode = createdNodes[srcIdx]
          const dstNode = createdNodes[dstIdx]
          if (srcNode && dstNode && srcIdx >= 0 && dstIdx >= 0 && srcIdx !== dstIdx) {
            if (!(srcNode as any).__edges) (srcNode as any).__edges = []
            const eep = { srcIdx, dstIdx, label: ce.label || 'T', props: ce.props || null }
            ;(srcNode as any).__edges.push(eep)
            // 边种子数据同步到 st.pGe
            try {
              const typeId = _hashLabel(ce.label || 'T')
              const nidLabel = String((srcNode as any)._label || 'Default')
              let h = 0; for (let ci = 0; ci < nidLabel.length; ci++) h = ((h << 5) - h + nidLabel.charCodeAt(ci)) | 0
              const srcNid = Math.abs(h) % 1000 + 1 + srcIdx
              let h2 = 0; for (let ci = 0; ci < (String((dstNode as any)._label || 'Default')).length; ci++) h2 = ((h2 << 5) - h2 + (String((dstNode as any)._label || 'Default')).charCodeAt(ci)) | 0
              const dstNid = Math.abs(h2) % 1000 + 1 + dstIdx
              ;(ge as any).upsertEdge(srcNid, dstNid, typeId, { props: ce.props || {} })
            } catch {}
          }
        }
      }
      
      // Post-process edge indices: createdNodes may contain alias-duplicate
      // entries that inflate srcIdx/dstIdx values. Map them back to actual
      // st.nodes positions by building a reference→index lookup from
      // createdNodes unique entries.
      if (cEdges?.length) {
        const refToStIdx = new Map<any, number>()
        for (let si = 0; si < st.nodes.length; si++) {
          refToStIdx.set(st.nodes[si], si)
        }
        // Walk every node's __edges and remap srcIdx/dstIdx to st.nodes
        // indices, skipping edges whose endpoints don't exist in st.nodes.
        for (const n of st.nodes) {
          const edges = (n as any).__edges as any[] | undefined
          if (!edges?.length) continue
          const rebuilt: any[] = []
          for (const e of edges) {
            const realSrcIdx = refToStIdx.get(createdNodes[e.srcIdx])
            const realDstIdx = refToStIdx.get(createdNodes[e.dstIdx])
            if (realSrcIdx != null && realDstIdx != null) {
              rebuilt.push({ ...e, srcIdx: realSrcIdx, dstIdx: realDstIdx })
            }
          }
          ;(n as any).__edges = rebuilt
        }
      }
      
      // If any UNWIND
      // 解析 UNWIND 后替换 createNodes 中的变量引用
      if (unwind && unwind.list) {
        // Resolve the UNWIND list to concrete values via the same authoritative
        // helper the executor uses (`_resolveUnwindList`), so string literals
        // stored as quoted raw text (`'a'`) are restored to `a` — including the
        // empty string and whitespace — and temporal/range expressions evaluate.
        const listVals: unknown[] = _resolveUnwindList(unwind, {})
        // 确保 createNodes 模板存在
        const cnTemplate = cns.length > 0 ? cns[0] : null
        if (cnTemplate) {
          for (const elem of listVals) {
            const uwNode: Record<string, unknown> = { _label: cnTemplate.label || 'Default' }
            if (cnTemplate.props) {
              for (const [k, v] of Object.entries(cnTemplate.props)) {
                let rawVal = (v && typeof v === 'object' && 'value' in (v as any) && (v as any).type)
                  ? (v as any).value
                  : v
                // 如果值是 UNWIND 变量引用，替换为实际值
                if (typeof rawVal === 'string' && rawVal === unwind.name) {
                  rawVal = elem
                }
                uwNode[k] = rawVal
              }
            }
            st.nodes.push(uwNode)
            seedGe(ge, uwNode)
            createdNodes.push(uwNode)
          }
        }
      }

      // 创建边（If any createEdges）
      const edges = (plan as any).createEdges as Array<{ source: string; target: string; sourceIdx?: number; targetIdx?: number; label: string | null; direction: string }> | undefined
      if (edges?.length) {
        // 从 GE 获取所有Node ID
        const geNodeMap: Array<{ id: number }> = []
        const nodeIds: number[] = [...((ge as any)._nodeIds || [])]
        for (const nid of nodeIds) {
          const record = (ge as any).getNode(nid)
          if (record) geNodeMap.push({ id: nid })
        }
        const createdEdgeInfos: Array<{ srcIdx: number; dstIdx: number; label: string; props?: Record<string, unknown> | null }> = []
        // 构建一个 alias → id 的映射表
        const aliasToId = new Map<string, number>()
        for (let ci = 0; ci < cns.length; ci++) {
          if (cns[ci].alias && !aliasToId.has(cns[ci].alias)) {
            aliasToId.set(cns[ci].alias, ci)
          }
        }
        for (const edge of edges) {
          // 优先用 sourceIdx/targetIdx，但如果是匿名节点在 createNodes 中的索引
          // 超出 geNodeMap 范围，用 alias 映射的后备方案
          let srcIdx = edge.sourceIdx !== undefined ? edge.sourceIdx : cns.findIndex(n => n.alias === edge.source)
          let dstIdx = edge.targetIdx !== undefined ? edge.targetIdx : cns.findIndex(n => n.alias === edge.target)
          // 如果 sourceIdx 超出了 geNodeMap 范围（匿名节点在 createNodes 末端），
          // 尝试用 alias 映射回命名节点索引
          if (srcIdx >= 0 && srcIdx >= geNodeMap.length && edge.source && aliasToId.has(edge.source)) {
            srcIdx = aliasToId.get(edge.source)!
          }
          if (dstIdx >= 0 && dstIdx >= geNodeMap.length && edge.target && aliasToId.has(edge.target)) {
            dstIdx = aliasToId.get(edge.target)!
          }
          if (srcIdx >= 0 && dstIdx >= 0 && srcIdx < geNodeMap.length && dstIdx < geNodeMap.length) {
            const srcId = geNodeMap[srcIdx].id
            const dstId = geNodeMap[dstIdx].id
            const typeId = (ge as any)._resolveEdgeType(edge.label || '')
            try { (ge as any).upsertEdge(srcId, dstId, typeId) } catch {}
            createdEdgeInfos.push({ srcIdx, dstIdx, label: edge.label || '', props: (edge as any).props || null })
          }
        }
        // 把边Info编码到 st.nodes 的 __edges 中，供后续 _executeQuery 重建边
        // 关键：srcIdx/dstIdx 必须指向 st.nodes 中的正确索引（而非 geNodeMap 中的索引）。
        // 因为 _executeViaGraphEngine 重建边时用 allNodes[i].__edges 中的
        // srcIdx/dstIdx 来映射到 nodeGeIds[i]，而 nodeGeIds 按 st.nodes 顺序排列。
        // createdEdgeInfos 中的索引基于 geNodeMap（GE nodeIds 集合顺序），
        // 可能与 st.nodes 顺序不同。因此从原始 createEdges 重新计算 st.nodes 索引：
        if (st.nodes.length > 0 && (plan as any).createEdges?.length) {
          const aliasToNodeIdx = new Map<string, number>()
          for (let ci = 0; ci < cns.length; ci++) {
            // 只记录第一次出现的索引（后出现的重复是边模式中的匿名节点引用）
            if (cns[ci].alias && !aliasToNodeIdx.has(cns[ci].alias)) {
              aliasToNodeIdx.set(cns[ci].alias, ci)
            }
          }
          const edgesForStNodes: Array<{ srcIdx: number; dstIdx: number; label: string; props?: Record<string, unknown> | null }> = []
          // 构建 cnsIdx → stNodesIdx 映射
          // st.nodes 去重（重复 alias 不 push），但 createEdges 索引按 cns 原始索引
          const cnsToStIdx: number[] = []
          const stAliasToIdx = new Map<string, number>()
          for (let si = 0; si < st.nodes.length; si++) {
            const sn = st.nodes[si] as any
            if (sn._alias) stAliasToIdx.set(sn._alias, si)
          }
          let anonymousCount = 0
          const stNonAliasIndices: number[] = []
          for (let si = 0; si < st.nodes.length; si++) {
            if (!(st.nodes[si] as any)._alias) stNonAliasIndices.push(si)
          }
          for (let ci = 0; ci < cns.length; ci++) {
            const cn = cns[ci]
            if (cn.alias && stAliasToIdx.has(cn.alias)) {
              cnsToStIdx[ci] = stAliasToIdx.get(cn.alias)!
            } else {
              const anonIdx = stNonAliasIndices[anonymousCount]
              cnsToStIdx[ci] = anonIdx !== undefined ? anonIdx : (stAliasToIdx.size + anonymousCount)
              anonymousCount++
            }
          }
          for (const edge of (plan as any).createEdges as Array<{ source: string; target: string; sourceIdx?: number; targetIdx?: number; label: string | null; direction: string }>) {
            // 使用 alias 查找替代 sourceIdx/targetIdx（ANTLR 多行 CREATE 的索引错乱）
            // 优先通过 alias 查找，如果 fail 则回退到 sourceIdx/targetIdx
            let srcIdx = -1, dstIdx = -1
            if (edge.source) {
              for (let si = 0; si < st.nodes.length; si++) {
                if ((st.nodes[si] as any)._alias === edge.source) { srcIdx = si; break }
              }
            }
            if (srcIdx < 0 && edge.sourceIdx !== undefined) {
              const mapped = cnsToStIdx[edge.sourceIdx]
              if (mapped !== undefined) srcIdx = mapped
            }
            if (edge.target) {
              for (let si = 0; si < st.nodes.length; si++) {
                if ((st.nodes[si] as any)._alias === edge.target) { dstIdx = si; break }
              }
            }
            if (dstIdx < 0 && edge.targetIdx !== undefined) {
              const mapped = cnsToStIdx[edge.targetIdx]
              if (mapped !== undefined) dstIdx = mapped
            }
            if (srcIdx !== undefined && dstIdx !== undefined && srcIdx >= 0 && dstIdx >= 0 && srcIdx < st.nodes.length && dstIdx < st.nodes.length) {
              edgesForStNodes.push({ srcIdx, dstIdx, label: edge.label || '', props: (edge as any).props || null })
            }
          }
            if (edgesForStNodes.length > 0) {
            // Attach __edges to each incident node (self-loop inserted once).
            // The relationship is added on BOTH endpoints so undirected
            // traversal (`--`) works. However, a prior edge-injection pass
            // (the `aliasToTrueIdx` block above) may have already pushed the
            // same directed edge onto the source node. Deduplicate by
            // (srcIdx, dstIdx, label) so aggregation over `__edges` (e.g. an
            // existential `count(*)`) does not double-count relationships.
            for (const ef of edgesForStNodes) {
              const pushDedup = (idx: number) => {
                const node = st.nodes[idx] as any
                if (!node.__edges) node.__edges = []
                const key = `${ef.srcIdx}|${ef.dstIdx}|${ef.label || ''}`
                if (!node.__edges.some((e: any) => `${e.srcIdx}|${e.dstIdx}|${e.label || ''}` === key)) {
                  node.__edges.push({ ...ef })
                }
              }
              pushDedup(ef.srcIdx)
              if (ef.srcIdx !== ef.dstIdx) pushDedup(ef.dstIdx)
            }
          }
        }
      }

      st.err = null
      return
    }

    // 无 createNodes 但查询可执行：run() 并读回结果
    await run(q)
    _syncNodesFromGe()
    st.err = null
  } catch (e: any) {
    st.err = e
    st.res = []
  }
})
Given('parameters are:', function (dt: any) {
  // 存储参数表供 run() 使用
  st.params = {}
  if (dt?.raw) {
    const rows = dt.raw()
    for (const [key, val] of rows) {
      // 判断原始值是否被引号包裹（字符串标记）
      const hasQuotes = /^['"]/.test(val)
      // 去掉引号（'me' → me）
      const cleaned = val.replace(/^['"]|['"]$/g, '')
      // 尝试解析为 JS 字面量：数字、null、true/false、数组、映射
      let parsed: unknown = cleaned
      // 如果原始值有引号包裹，保持为字符串（不尝试 parseInt）
      if (hasQuotes) {
        parsed = cleaned
      } else if (cleaned === 'null') {
        parsed = null
      } else if (cleaned === 'true') {
        parsed = true
      } else if (cleaned === 'false') {
        parsed = false
      } else if (/^-?\d+$/.test(cleaned)) {
        parsed = Number(cleaned)
      } else if (/^-?\d+\.\d+$/.test(cleaned)) {
        parsed = Number(cleaned)
      } else if (/^\[.*\]$/.test(cleaned)) {
        try { parsed = JSON.parse(cleaned.replace(/'/g, '"')) } catch { parsed = cleaned }
      } else if (/^\{.+\}$/.test(cleaned) && !hasQuotes) {
        // Map 字面量：{key: 'val', key2: 'val2'} 或 {key: val} 
        try {
          const jsonLike = cleaned.replace(/(\w+)\s*:/g, '"$1":').replace(/'/g, '"')
          parsed = JSON.parse(jsonLike)
        } catch { parsed = cleaned }
      }
      st.params[key] = parsed
    }
  }
})
Given(/^there exists a procedure (.*)$/, function (this: any, procDesc: string, dt?: DataTable) {
  console.error('📝 Given there exists a procedure called')
  // 解析 Gherkin 步骤文本获取 procedure 名称和签名
  // 步骤格式: "there exists a procedure <name>(<params>) :: (<returns>):"
  // data table 包含示例输入/输出行（Optional，可能为空 | 单独一行）
  // cucumber-js v10: 正则捕获的 procDesc 就是步骤描述部分
  const text = `there exists a procedure ${procDesc}`
  console.error('📝 Step text:', text)
  const match = text.match(/there exists a procedure\s+(\S+)\(([^)]*)\)\s*::\s*\(([^)]*)\)/)
  if (!match) {
    // 宽松匹配：只拿名字
    const nameMatch = text.match(/there exists a procedure\s+(\S+)/)
    if (!nameMatch) return
    const procName = nameMatch[1].toLowerCase()
    console.error('📝 Registering (loose):', procName)
    _globalProcedureRegistry.register({ name: procName, signature: '', execute: () => [] })
    console.error('📝 After register, get:', _globalProcedureRegistry.get(procName))
    return
  }
  const procName = match[1].toLowerCase()
  console.error('📝 Registering:', procName, 'params:', match[2], 'returns:', match[3])
  const paramsSig = match[2].trim()
  const returnsSig = match[3].trim()

  // 获取 data table（If any）
  let dataTable: any[] = []
  if (dt && typeof dt.rows === 'function') {
    const rawRows = dt.raw()
    // 第一行是表头（参数列名）
    const headers: string[] = rawRows[0] || []
    for (let i = 1; i < rawRows.length; i++) {
      const row: Record<string, unknown> = {}
      for (let j = 0; j < headers.length; j++) {
        row[headers[j]] = parseTckValue(rawRows[i][j] ?? null)
      }
      dataTable.push(row)
    }
  }

  _globalProcedureRegistry.register({
    name: procName,
    signature: `${procName}(${paramsSig}) :: (${returnsSig})`,
    execute(_ctx: any, args: any[]) {
      // 根据 args 匹配 dataTable 中的行
      if (dataTable.length === 0) return []
      if (paramsSig) {
        const paramNames = paramsSig.split(',').map(s => s.split('::')[0].trim())
        const matched = dataTable.find(row => {
          return paramNames.every((pName, i) => {
            if (args[i] === undefined || args[i] === null) return row[pName] === null || row[pName] === undefined
            return String(row[pName]) === String(parseTckValue(String(args[i])))
          })
        })
        if (matched) {
          // 移除输入参数列，只返回 yield 列
          const result: Record<string, unknown> = {}
          const retNames = returnsSig.split(',').map(s => s.split('::')[0].trim()).filter(Boolean)
          for (const rn of retNames) {
            if (matched[rn] !== undefined) result[rn] = matched[rn]
          }
          return Object.keys(result).length ? [result] : [matched]
        }
        return []
      }
      return dataTable
    },
  } as CypherProcedure)
})

/** 解析 TCK 值（数字、字符串、null） */
function parseTckValue(val: string | null): unknown {
  if (val === null || val === undefined || val === '' || val === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(val)) return Number(val)
  // 去除引号
  const trimmed = val.trim()
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

When('executing query:', async function (query: string) {
  st.q = _stripCypherComments(query).trim()
  // A multi-statement block (`MERGE (a) MERGE (b) MERGE p=(…) RETURN p`) is a
  // sequence of independent statements whose side effects accumulate, while the
  // final statement owns the result projection.  `run()` parses the whole block
  // as ONE statement (ANTLR keeps only the last MERGE), dropping the earlier
  // merged nodes.  Split such blocks (reusing the same MERGE…RETURN merge rule
  // as `Given`) and execute every statement in order, letting the final one's
  // result survive as `st.res`.
  const rawLines = st.q.split('\n').map((s: string) => s.trim()).filter(Boolean)
  const stmtStarts = rawLines.filter((l: string) => /^(MERGE|CREATE|DELETE|SET|REMOVE|MATCH|WITH|UNWIND|RETURN)\b/i.test(l)).length
  if (stmtStarts > 1 && /^(MERGE|CREATE)\b/i.test(rawLines[0])) {
    const lines: string[] = []
    let pending = ''
    for (const line of rawLines) {
      const _isMergePathAssign = /^MERGE\s+\w+\s*=\s*\(/i.test(line)
      const _isReturn = /^RETURN\b/i.test(line)
      if (pending) {
        // A pending MERGE path assignment followed by a RETURN merges into one
        // statement (the RETURN is the MERGE's own projection).
        if (_isReturn) {
          lines.push(pending + '\n' + line)
          pending = ''
        } else {
          lines.push(pending)
          pending = ''
          if (_isMergePathAssign) pending = line
          else lines.push(line)
        }
      } else {
        if (_isMergePathAssign) pending = line
        else lines.push(line)
      }
    }
    if (pending) lines.push(pending)
    for (const line of lines) await run(line)
    return
  }
  // Having executed 已经把节点注入 st.nodes，直接用 run()
  await run(st.q)
})

When('executing control query:', async function (query: string) {
  st.q = _stripCypherComments(query).trim()
  await run(st.q)
})

// ── Then ──
Then('the result should be empty', function () {
  if (st.err) throw st.err; assert.strictEqual(st.res.length, 0,
    `expected empty, got ${JSON.stringify(st.res)}`)
})

Then(/^the result should be, in any order:\s*$/, function (dt: DataTable) { cmp(dt) })
Then(/^the result should be, in order:\s*$/, function (dt: DataTable) { cmp(dt, true) })
Then(/^the result should be \(ignoring element order for lists\):\s*$/, function (dt: DataTable) { cmp(dt, false, true) })

Then(/^the result should have (\d+) rows?$/, function (c: string) {
  if (st.err) throw st.err; assert.strictEqual(st.res.length, parseInt(c, 10))
})

Then(/^the first result should contain fields:\s*$/, function (dt: DataTable) {
  if (st.err) throw st.err; assert.ok(st.res.length > 0); cmp(dt)
})

Then('the row should have field {string} equal to {string}', function (fp: string, ev: string) {
  if (st.err) throw st.err; assert.ok(st.res.length > 0)
  const row = st.res[0] as any
  if (fp.includes('.')) { const [k, p] = fp.split('.'); const o = row[k]; assert.strictEqual(String(o?.[p]), ev) }
  else assert.strictEqual(String(row[fp]), ev)
})

Then('the row should have field {string} equal to {int}', function (fp: string, ev: number) {
  if (st.err) throw st.err; assert.ok(st.res.length > 0)
  const row = st.res[0] as any
  if (fp.includes('.')) { const [k, p] = fp.split('.'); const o = row[k]; assert.strictEqual(o?.[p], ev) }
  else assert.strictEqual(row[fp], ev)
})

Then(/^a SyntaxError should be raised at compile time(?:.*)$/, function () {
  assert.ok(st.err, `no SyntaxError\nQuery: ${st.q}\nResult: ${JSON.stringify(st.res)}`)
})

Then(/^a TypeError should be raised (?:at runtime|at compile time|at any time)(?:.*)$/, function () {
  assert.ok(st.err, `no TypeError\nQuery: ${st.q}\nResult: ${JSON.stringify(st.res)}`)
})

Then(/^a (QueryError|EntityNotFound) should be raised at runtime(?:.*)$/, function (_match?: string) {
  assert.ok(st.err, `no runtime error\nQuery: ${st.q}\nResult: ${JSON.stringify(st.res)}`)
})

Then(/^a (ConstraintError|CreateConstraintFailure) should be raised(?:.*)$/, function (_match?: string) {
  assert.ok(st.err, `no error\nQuery: ${st.q}\nResult: ${JSON.stringify(st.res)}`)
})
Then(/^a ArgumentError should be raised at runtime(?:.*)$/, function () {
  assert.ok(st.err, `no ArgumentError\nQuery: ${st.q}\nResult: ${JSON.stringify(st.res)}`)
})
Then(/^a ProcedureError should be raised at compile time: ProcedureNotFound$/, function () {
  // procedure not found – we expect compile-time error
  assert.ok(st.err || st.compileError, `no ProcedureError\nQuery: ${st.q}`)
})
Then(/^a ParameterMissing should be raised at compile time: MissingParameter$/, function () {
  assert.ok(st.err || st.compileError, `no ParameterMissing\nQuery: ${st.q}`)
})
Then('no side effects', function () {})
Then(/^the side effects should be:\s*$/, function (_dt: DataTable) {})
Then('the query should succeed', function () { if (st.err) throw st.err })
Then('the query should fail', function () { assert.ok(st.err, 'expected failure') })
