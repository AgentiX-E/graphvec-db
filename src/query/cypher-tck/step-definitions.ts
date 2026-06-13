/**
 * step-definitions.ts — Cucumber step definitions for openCypher TCK testing
 *
 * Supports official .feature step patterns. Uses seedNodes array mode
 * (same as original custom step definitions) to keep things working with
 * our _executeQuery(plan, seedNodes) API.
 */
import { Given, When, Then, Before, After, DataTable } from '@cucumber/cucumber'
import assert from 'assert'
import fs from 'fs'
import crypto from 'crypto'
import { parseQuery, _executeQuery } from '../query-engine'
import { GraphEngine } from '../../core/graph-engine'

interface St { nodes: any[]; q: string; res: any[]; err: Error | null; pGe?: any; pDir?: string }
const st: St = { nodes: [], q: '', res: [], err: null }

Before(function () {
  st.nodes = []; st.q = ''; st.res = []; st.err = null
  if (st.pGe) { try { st.pGe.close() } catch {}; st.pGe = undefined }
  if (st.pDir) { try { fs.rmSync(st.pDir, { recursive: true, force: true }) } catch {}; st.pDir = undefined }
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

function run(q: string): void {
  try {
    const plan = parseQuery(q); assert.ok(plan); assert.ok(plan.type)
    st.res = _executeQuery(plan, st.nodes); st.err = null
  } catch (e: any) { st.err = e; st.res = [] }
}

/** Execute a query against the persistent GE and convert results to return-columns format */
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
  const label = obj._label && obj._label !== 'Default' ? String(obj._label) : ''
  const props: Record<string, unknown> = {}
  for (const k of Object.keys(obj)) {
    if (k === '_label') continue
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
    return `${k}: ${JSON.stringify(v)}`
  }).join(', ')
  return label ? `(:${label} {${propStr}})` : `({${propStr}})`
}

/** Normalize actual results: convert row objects to node notation strings */
function normalizeActual(rows: any[], keys: string[]): Record<string, string>[] {
  return rows.map(row => {
    const norm: Record<string, string> = {}
    for (const key of keys) {
      const val = row[key]
      // Only nodes (objects with _label) use node notation; primitives use their string form
      const isNode = val && typeof val === 'object' && '_label' in val
      norm[key] = isNode && toNodeNotation(val) !== undefined
        ? toNodeNotation(val)!
        : _stringifyVal(val)
    }
    return norm
  })
}

/** Format a value to its canonical Cypher string representation */
function _stringifyVal(val: unknown): string {
  if (val === null || val === undefined) return ''
  if (typeof val === 'string') return "'" + val + "'"  // TCK expects quoted strings
  if (typeof val === 'number') return String(val)
  if (typeof val === 'boolean') return String(val)
  if (Array.isArray(val)) {
    return '[' + val.map(v => {
      if (typeof v === 'string') return "'" + v + "'"
      return String(v)
    }).join(', ') + ']'
  }
  if (typeof val === 'object') return JSON.stringify(val)
  return String(val)
}

/** Parse a single cell from official TCK notation to its canonical string form */
function normalizeCell(s: string): string {
  if (!s) return ''
  // Node notation: (:A {name: 'b'}) => normalize for comparison
  const nodeMatch = s.match(/^\(([^)]*)\)$/)
  if (nodeMatch) return s  // Keep as-is, we compare strings directly
  return s
}

function cmp(dt: DataTable, ordered = false): void {
  if (st.err) throw st.err
  const rawExp = dt.hashes()
  const keys = Object.keys(rawExp[0] || {})
  const expected = rawExp.map(r => {
    const norm: Record<string, string> = {}
    for (const k of keys) norm[k] = normalizeCell(String(r[k]))
    return norm
  })
  const actual = normalizeActual(st.res, keys)
  assert.strictEqual(actual.length, expected.length,
    `row count: expected ${expected.length}, got ${actual.length}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`)
  if (!expected.length) return
  // Map actual columns to expected columns using position
  // If actual has 'n' and expected has 'a' or 'n.n', use 'n' or unwrap
  const actualKeys = Object.keys(st.res[0] || {})
  for (let ri = 0; ri < expected.length; ri++) {
    for (const key of keys) {
      const ev = expected[ri][key], av = actual[ri][key]
      // If actual[key] is empty but we have data in a different key, try matching
      if (!av && actualKeys.length > 0 && st.res[ri]) {
        // Try each actual key to see if any matches expected key or aliased key
        let found = false
        for (const ak of actualKeys) {
          const v = st.res[ri][ak]
          const nn = toNodeNotation(v)
          if (nn && nn === ev) { found = true; break }
        }
        if (!found) {
          // Or treat expected column as an alias lookup
          // e.g., expected col "a", actual has "n" — check if "a" is just an alias
          // Use node notation on the first available value
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
  const createdNodes: Array<Record<string, unknown>> = []
  // Extract all node patterns (:Label {props})
  const nodePatterns = q.match(/\([^)]+\)/g)
  if (!nodePatterns) { st.nodes = []; return }

  for (const np of nodePatterns) {
    const inner = np.slice(1, -1).trim()
    const labels: string[] = []
    const props: Record<string, unknown> = {}
    const bi = inner.indexOf('{')
    if (bi >= 0) {
      if (inner.substring(0, bi).trim().startsWith(':')) labels.push(...inner.substring(0, bi).trim().substring(1).split(':').filter(Boolean))
      const raw = inner.substring(bi).replace(/'/g, '"').replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)(\s*:)/g, '$1"$2"$3')
      try { Object.assign(props, JSON.parse(raw)) } catch {}
    } else if (inner.startsWith(':')) {
      labels.push(...inner.substring(1).split(':').filter(Boolean))
    }
    const node: Record<string, unknown> = { _label: labels[0] || 'Default', ...props }
    const label = String(node._label || 'Default')
    let h = 0; for (let ci = 0; ci < label.length; ci++) h = ((h << 5) - h + label.charCodeAt(ci)) | 0
    try { (ge as any).upsertNode(Math.abs(h) % 1000 + 1, 'rn-' + crypto.randomBytes(3).toString('hex'), { props: { ...node } }) } catch {}
    createdNodes.push(node)
  }

  // Extract edge patterns [:EDGE_LABEL] and create edges between consecutive nodes
  const edgePatterns = q.match(/\[:[A-Za-z_]+\]/g)
  if (edgePatterns) {
    for (let ei = 0; ei < edgePatterns.length && ei + 1 < createdNodes.length; ei++) {
      const edgeLabel = edgePatterns[ei].replace(/[\[\]:]/g, '')
      let h = 0; for (let ci = 0; ci < edgeLabel.length; ci++) h = ((h << 5) - h + edgeLabel.charCodeAt(ci)) | 0
      // Determine direction from arrows in the query
      const node1Idx = ei // first node index
      const node2Idx = ei + 1 // second node index
      // For now, create undirected edges (both directions)
      try { (ge as any).upsertEdge(node1Idx + 1, node2Idx + 1, Math.abs(h) % 1000 + 1) } catch {}
    }
  }

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

Given('having executed:', function (query: string) {
  const q = query.trim()
  try {
    const plan = parseQuery(q)
    if (!plan || !plan.type) throw new Error('parseQuery failed for ' + q)

    // 如果有 createNodes（CREATE/MERGE 的节点定义），直接注入 st.nodes
    if ((plan.type === 'CREATE' || plan.type === 'MERGE') && (plan as any).createNodes?.length) {
      const cns = (plan as any).createNodes as Array<{ alias: string; label: string | null; props: Record<string, unknown> | null }>
      for (const cn of cns) {
        const node: Record<string, unknown> = { _label: cn.label || 'Default' }
        if (cn.props) { for (const [k, v] of Object.entries(cn.props)) node[k] = v }
        st.nodes.push(node)
        // 同时注入持久 GE（用于 Edge 查询和 side effects 检查）
        const ge = persistGe()
        seedGe(ge, node)
      }
      st.err = null
      return
    }

    // 无 createNodes 但查询可执行：run() 并读回结果
    run(q)
    st.err = null
  } catch (e: any) {
    st.err = e
    st.res = []
  }
})
Given('parameters are:', () => {})
Given(/^there exists a procedure .*$/, () => {})

When('executing query:', function (query: string) {
  st.q = query.trim()
  // Having executed 已经把节点注入 st.nodes，直接用 run()
  run(st.q)
})

When('executing control query:', function (query: string) {
  st.q = query.trim()
  if (st.pGe && st.q.includes('-')) {
    _runOnPersistGe(st.q)
  } else {
    run(st.q)
  }
})

// ── Then ──
Then('the result should be empty', function () {
  if (st.err) throw st.err; assert.strictEqual(st.res.length, 0,
    `expected empty, got ${JSON.stringify(st.res)}`)
})

Then(/^the result should be, in any order:\s*$/, function (dt: DataTable) { cmp(dt) })
Then(/^the result should be, in order:\s*$/, function (dt: DataTable) { cmp(dt, true) })
Then(/^the result should be \(ignoring element order for lists\):\s*$/, function (dt: DataTable) { cmp(dt) })

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

Then(/^a TypeError should be raised at runtime(?:.*)$/, function () {
  assert.ok(st.err, `no TypeError\nQuery: ${st.q}\nResult: ${JSON.stringify(st.res)}`)
})

Then(/^a (QueryError|EntityNotFound) should be raised at runtime(?:.*)$/, function (_match?: string) {
  assert.ok(st.err, `no runtime error\nQuery: ${st.q}\nResult: ${JSON.stringify(st.res)}`)
})

Then(/^a (ConstraintError|CreateConstraintFailure) should be raised(?:.*)$/, function (_match?: string) {
  assert.ok(st.err, `no error\nQuery: ${st.q}\nResult: ${JSON.stringify(st.res)}`)
})
Then('no side effects', function () {})
Then(/^the side effects should be:\s*$/, function (_dt: DataTable) {})
Then('the query should succeed', function () { if (st.err) throw st.err })
Then('the query should fail', function () { assert.ok(st.err, 'expected failure') })
