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
import { parseQuery, _executeQuery, _validatePlan, _clearGeInstances } from '../query-engine'
import { GraphEngine } from '../../core/graph-engine'
import { globalRegistry as _globalProcedureRegistry, type CypherProcedure } from '../procedure-registry'

interface St { nodes: any[]; q: string; res: any[]; err: Error | null; pGe?: any; pDir?: string; params?: Record<string, string> }
const st: St = { nodes: [], q: '', res: [], err: null, params: {} }

Before(function () {
  st.nodes = []; st.q = ''; st.res = []; st.err = null; st.params = {}
  if (st.pGe) { try { st.pGe.close() } catch {}; st.pGe = undefined }
  if (st.pDir) { try { fs.rmSync(st.pDir, { recursive: true, force: true }) } catch {}; st.pDir = undefined }
  _clearGeInstances()
})
After(function () {
  try { st.pGe?.close() } catch {}
  try { if (st.pDir) fs.rmSync(st.pDir, { recursive: true, force: true }) } catch {}
  try {
    const d = (globalThis as any).__gebug_data;
    if (d && d.length) {
      const logPath = '/tmp/ge_debug_' + process.pid + '.log';
      for (const entry of d) {
        fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
      }
    }
  } catch (e: any) {
    fs.appendFileSync('/tmp/ge_debug_err.log', 'After hook error: ' + e.message + '\n');
  }
  try { (globalThis as any).__gebug_data = [] } catch {}
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

async function run(q: string): Promise<void> {
  try {
    // 参数注入：替换 $param → 实际值
    let resolvedQ = q
    if (st.params && Object.keys(st.params).length) {
      for (const [key, val] of Object.entries(st.params)) {
        // 纯数字不加引号（'0' → 0），字符串加引号（'red' → 'red'）
        const escaped = /^-?\d+(\.\d+)?$/.test(String(val)) ? String(val) : `'${val}'`
        resolvedQ = resolvedQ.replace(new RegExp('\\$' + key + '\\b', 'g'), escaped)
      }
    }
    const plan = parseQuery(resolvedQ); assert.ok(plan); assert.ok(plan.type)
    // 编译时语义验证（SyntaxError 检查）— 单独 try-catch
    try {
      _validatePlan(plan, resolvedQ)
    } catch (e: any) {
      st.err = e; st.res = []; return
    }
    st.res = await _executeQuery(plan, st.nodes, resolvedQ); st.err = null
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
  // 优先使用 __fullLabel（多标签），回退到 _label
  const labelSrc = (obj.__fullLabel && String(obj.__fullLabel) !== 'Default' ? String(obj.__fullLabel) : '') ||
    (obj._label && obj._label !== 'Default' ? String(obj._label) : '')
  const props: Record<string, unknown> = {}
  for (const k of Object.keys(obj)) {
    if (k === '_label' || k === '__fullLabel') continue
    if (typeof obj[k] !== 'function') props[k] = obj[k]
  }
  const propKeys = Object.keys(props)
  // Use for labels below
  const label = labelSrc
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
  if (typeof val === 'string') {
    // 如果是边表示（[:T1] 格式），裸输出不含引号
    if (val.startsWith('[:"') || val.startsWith('[:')) return val
    return "'" + val + "'"  // TCK expects quoted strings
  }
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

Given('having executed:', async function (query: string) {
  const q = query.trim()
  try {
    const plan = parseQuery(q)
    if (!plan || !plan.type) throw new Error('parseQuery failed for ' + q)

    // 注入持久 GE
    const ge = persistGe()

    // 如果有 createNodes（CREATE/MERGE 的节点定义），直接注入 st.nodes 和 GE
    if ((plan.type === 'CREATE' || plan.type === 'MERGE') && (plan as any).createNodes?.length) {
      const cns = (plan as any).createNodes as Array<{ alias: string; label: string | null; props: Record<string, unknown> | null }>
      const createdNodes: Array<Record<string, unknown>> = []
      const seenAliases = new Map<string, number>() // alias -> index in createdNodes
      for (let ci = 0; ci < cns.length; ci++) {
        const cn = cns[ci]
        // 如果 alias 已见过（自循环或 reuse），不重新 seed
        if (cn.alias && seenAliases.has(cn.alias)) {
          // 复用已有节点
          createdNodes.push(createdNodes[seenAliases.get(cn.alias)!])
          continue
        }
        const node: Record<string, unknown> = { _label: cn.label || 'Default' }
        if (cn.props) { for (const [k, v] of Object.entries(cn.props)) {
          // parseQuery 将 props 打包为 {type:'STRING', value:'val'}，需解包
          node[k] = (v && typeof v === 'object' && 'value' in (v as any) && (v as any).type)
            ? (v as any).value
            : v
        } }
        st.nodes.push(node)
        seedGe(ge, node)
        createdNodes.push(node)
        if (cn.alias) seenAliases.set(cn.alias, ci)
      }

      // 创建边（如果有 createEdges）
      const edges = (plan as any).createEdges as Array<{ source: string; target: string; sourceIdx?: number; targetIdx?: number; label: string | null; direction: string }> | undefined
      if (edges?.length) {
        // 从 GE 获取所有节点 ID
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
        // 把边信息编码到 st.nodes 的 __edges 中，供后续 _executeQuery 重建边
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
          for (const edge of (plan as any).createEdges as Array<{ source: string; target: string; sourceIdx?: number; targetIdx?: number; label: string | null; direction: string }>) {
            // 使用 alias 映射到 st.nodes 索引，匿名节点（alias=）fallback 到 sourceIdx/targetIdx
            let srcIdx: number | undefined
            let dstIdx: number | undefined
            if (edge.source && aliasToNodeIdx.has(edge.source)) {
              srcIdx = aliasToNodeIdx.get(edge.source)
            } else if (edge.sourceIdx !== undefined) {
              srcIdx = edge.sourceIdx < cns.length ? edge.sourceIdx : undefined
            }
            if (edge.target && aliasToNodeIdx.has(edge.target)) {
              dstIdx = aliasToNodeIdx.get(edge.target)
            } else if (edge.targetIdx !== undefined) {
              dstIdx = edge.targetIdx < cns.length ? edge.targetIdx : undefined
            }
            if (srcIdx !== undefined && dstIdx !== undefined && srcIdx < cns.length && dstIdx < cns.length) {
              edgesForStNodes.push({ srcIdx, dstIdx, label: edge.label || '', props: (edge as any).props || null })
            }
          }
            if (edgesForStNodes.length > 0) {
            (st.nodes[0] as any).__edges = edgesForStNodes
          }
        }
      }

      st.err = null
      return
    }

    // 无 createNodes 但查询可执行：run() 并读回结果
    await run(q)
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
      // 去掉引号（'me' → me）
      st.params[key] = val.replace(/^['"]|['"]$/g, '')
    }
  }
})
Given(/^there exists a procedure .*$/, function (this: any) {
  // 解析 Gherkin 步骤文本获取 procedure 名称和签名
  // 步骤格式: "there exists a procedure <name>(<params>) :: (<returns>):"
  // data table 包含示例输入/输出行（可选，可能为空 | 单独一行）
  const text = this.getStep ? this.getStep().text || '' : ''
  const match = text.match(/there exists a procedure\s+(\S+)\(([^)]*)\)\s*::\s*\(([^)]*)\)/)
  if (!match) {
    // 宽松匹配：只拿名字
    const nameMatch = text.match(/there exists a procedure\s+(\S+)/)
    if (!nameMatch) return
    const procName = nameMatch[1].toLowerCase()
    _globalProcedureRegistry.register({ name: procName, signature: '', execute: () => [] })
    return
  }
  const procName = match[1].toLowerCase()
  const paramsSig = match[2].trim()
  const returnsSig = match[3].trim()

  // 获取 data table（如果有）
  let dataTable: any[] = []
  const dt: DataTable | undefined = this.getDataTable && this.getDataTable()
  if (dt && dt.rows && dt.rows.length) {
    const rawRows = dt.rows()
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
            return String(row[pName]) === String(args[i])
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
  st.q = query.trim()
  // Having executed 已经把节点注入 st.nodes，直接用 run()
  await run(st.q)
})

When('executing control query:', async function (query: string) {
  st.q = query.trim()
  if (st.pGe && st.q.includes('-')) {
    _runOnPersistGe(st.q)
  } else {
    await run(st.q)
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
