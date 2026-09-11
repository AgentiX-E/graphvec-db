/**
 * var-length-path.ts — 变长路径（VLE）匹配执行引擎
 *
 * 完全独立 BFS 遍历引擎。
 * 直接 import expression-engine 打破寄存器的循环依赖。
 */

import { _evaluateExpression, _postProcessResults } from './expression-engine'

type QueryRow = Record<string, unknown>
type QueryResult = QueryRow[]

// 直接引用表达式引擎函数
let _evaluateExpr: any = _evaluateExpression
let _postProcess: any = _postProcessResults

function _ensureDeps(): void {
  if (_evaluateExpr !== undefined && _postProcess !== undefined) return
  _evaluateExpr = _evaluateExpression
  _postProcess = _postProcessResults
}

interface BfsEntry { nIdx: number; path: number[] }

function _edgeToRelObj(e: { srcIdx: number; dstIdx: number; label: string; props?: Record<string, unknown> | null }): Record<string, unknown> {
  const edgeNode: Record<string, unknown> = { _type: e.label || '' }
  if (e.props) { for (const [k, v] of Object.entries(e.props)) { if (k !== '_type') edgeNode[k] = v } }
  return edgeNode
}

function _buildPathEdges(newPath: number[], srcNodes: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const pathEdges: Array<Record<string, unknown>> = []
  for (let pi = 0; pi < newPath.length - 1; pi++) {
    const fromNode = srcNodes[newPath[pi]] as any
    const toNode = srcNodes[newPath[pi + 1]] as any
    const edges = (fromNode?.__edges || []).concat(toNode?.__edges || [])
    let foundEdge: any = null
    for (const edge of edges) {
      if ((edge.srcIdx === newPath[pi] && edge.dstIdx === newPath[pi + 1]) ||
          (edge.dstIdx === newPath[pi] && edge.srcIdx === newPath[pi + 1])) {
        foundEdge = edge; break
      }
    }
    pathEdges.push(foundEdge ? _edgeToRelObj(foundEdge) : { _type: '' })
  }
  return pathEdges
}

function _buildRow(newPath: number[], srcNodes: Array<Record<string, unknown>>, step: any, plan: any, pathNodes: Array<Record<string, unknown>>): QueryRow {
  const evaluateExpr = _evaluateExpression
  const pathEdges = _buildPathEdges(newPath, srcNodes)
  const rowRes: QueryRow = {}
  // Only a pattern with an explicit path assignment (`MATCH p = (a)-[*]->(b)`)
  // carries a path variable bound to the full {__path, __pathEdges} object.  A
  // bare variable-length pattern (`MATCH (a)-[*]->(b)`) binds `a`/`b` to plain
  // nodes and has no path variable — inventing one (e.g. naming it after the
  // source var) would clobber the node binding and serialize it as a path.
  if (plan.pathVar) {
    rowRes[plan.pathVar] = { __path: pathNodes, __pathEdges: pathEdges }
    if (step.source) rowRes[step.source] = pathNodes[0]
  } else if (step.source) {
    rowRes[step.source] = pathNodes[0]
  }
  if (step.targetAlias) rowRes[step.targetAlias] = pathNodes[pathNodes.length - 1]
  // A variable-length relationship variable (`MATCH (a)-[r*1..2]->(b) RETURN r`)
  // must resolve to the list of relationship objects along this path
  // (e.g. `[[:T]]` or `[[:X], [:Y]]`).  Each entry is the `{_type:'T'}` edge
  // object so the serializer emits `[:T]`.
  if ((step as any).edgeVariable) {
    rowRes[(step as any).edgeVariable] = pathEdges
  }
  const pathVar = plan.pathVar || ''
  const varNames = new Set([pathVar, step.targetAlias, step.source || ''].filter(Boolean))
  for (const rc of plan.returnColumns || []) {
    if (!rc || varNames.has(rc) || rc in rowRes) continue
    if (rc.match(/^\w+\(/)) {
      const evalCtx: Record<string, unknown> = { ...rowRes }
      const val = evaluateExpr(rc, evalCtx)
      rowRes[rc] = val !== undefined ? val : null
    } else {
      // 处理 variable.property 语法：b.name → 从 target 节点的 name 属性取值
      const dotMatch = rc.match(/^(\w+)\.(.+)$/)
      if (dotMatch) {
        const varName = dotMatch[1]
        const propName = dotMatch[2]
        // 如果 varName 是 targetAlias → 从 path 终点取
        if (varName === step.targetAlias) {
          const targetNode = pathNodes[pathNodes.length - 1]
          rowRes[rc] = (targetNode as any)[propName] ?? null
        } else if (varName === step.source) {
          const srcNode = pathNodes[0]
          rowRes[rc] = (srcNode as any)[propName] ?? null
        } else {
          // 其他变量名→尝试从对应路径节点取
          rowRes[rc] = (srcNodes[newPath[newPath.length - 1]] as any)[propName] ?? null
        }
      } else {
        rowRes[rc] = (srcNodes[newPath[newPath.length - 1]] as any)[rc] ?? null
      }
    }
  }
  if (plan.returnAliasMap) {
    for (const [alias, expr] of Object.entries(plan.returnAliasMap)) {
      if (expr.includes('.')) rowRes[expr] = rowRes[alias] ?? null
    }
  }
  return rowRes
}

function _matchesLabel(node: Record<string, unknown>, label: string): boolean {
  const fullLabel = (node as any).__fullLabel
  if (fullLabel && typeof fullLabel === 'string') return String(fullLabel).split(':').includes(label)
  const rawLabel = (node as any)._label
  if (rawLabel && typeof rawLabel === 'string' && rawLabel.includes(':')) {
    return String(rawLabel).split(':').includes(label)
  }
  return rawLabel === label
}

export function executeVarLenPath(plan: any, nodes: Array<Record<string, unknown>>): QueryResult {
  const evaluateExpr = _evaluateExpression
  const postProcessResults = _postProcessResults
  // A chain of two or more variable-length steps (`MATCH (a)-[:T*0..1]->(b)-[:U*0..1]->(c)`)
  // is not expressible as a single-step BFS; delegate to the chain combinator.
  if (plan.steps && plan.steps.length > 1 && plan.steps.every((s: any) => s.range)) {
    return _executeVarLenChain(plan, nodes)
  }
  const step = plan.steps[0]
  const range = (step as any).range
  const minHops = range.min ?? 1
  const maxHops = Math.min(range.max ?? 10, 50)
  const result: QueryRow[] = []
  const srcNodes: Array<Record<string, unknown>> = [...(nodes || [])]

  // Incoming-edge index keyed by destination node index. Edges are stored once
  // on their srcIdx node's __edges, so an undirected (`any`) walk needs this
  // reverse adjacency to discover neighbours reachable through an edge that
  // points *into* the current node (otherwise `(a)-[*]-(b)` only finds the
  // forward half of the graph and returns 3 pairs instead of 6 for a 3-chain).
  const incomingEdges: Array<Array<{ dstIdx: number; srcIdx: number; label: string }>> =
    new Array(srcNodes.length).fill(null).map(() => [])
  for (let ni = 0; ni < srcNodes.length; ni++) {
    const edges = (srcNodes[ni] as any)?.__edges as Array<{ dstIdx: number; srcIdx: number; label: string }> | undefined
    if (!edges) continue
    for (const e of edges) {
      if (e.dstIdx >= 0 && e.dstIdx < srcNodes.length) incomingEdges[e.dstIdx].push(e)
    }
  }

  for (let si = 0; si < srcNodes.length; si++) {
    const sourceNode = srcNodes[si] as any
    if (plan.scanLabel && !_matchesLabel(sourceNode, plan.scanLabel)) continue
    // Start-node inline property predicate: `MATCH (a {name:'A'})-[*]->(x)`
    // constrains the BFS source to nodes matching every key/value pair.
    const srcProps = (step as any).sourceProps
    if (srcProps && typeof srcProps === 'object') {
      let srcMismatch = false
      for (const [pk, pv] of Object.entries(srcProps as Record<string, unknown>)) {
        if (sourceNode[pk] !== pv) { srcMismatch = true; break }
      }
      if (srcMismatch) continue
    }
    if (minHops === 0) {
      const sn: Record<string, unknown> = { _label: sourceNode._label || 'Default' }
      for (const k of Object.keys(sourceNode)) { if (k !== '_label' && k !== '__edges' && k !== '_alias') sn[k] = sourceNode[k] }
      const rowRes: QueryRow = {}
      if (plan.pathVar) rowRes[plan.pathVar] = { __path: [sn], __pathEdges: [] }
      if ((step as any).source) rowRes[(step as any).source] = sn
      if ((step as any).targetAlias) rowRes[(step as any).targetAlias] = sn
      if (Object.keys(rowRes).length) result.push(rowRes)
    }
    let frontier: BfsEntry[] = [{ nIdx: si, path: [si] }]
    for (let depth = 1; depth <= maxHops; depth++) {
      const nextFrontier: BfsEntry[] = []
      for (const entry of frontier) {
        const node = srcNodes[entry.nIdx] as any
        const dir = (step as any).direction || 'out'
        // For an undirected walk, union the node's own outgoing edges with the
        // incoming edges (reverse adjacency) so both directions are traversed.
        const edgeArr: Array<{ dstIdx: number; srcIdx: number; label: string }> =
          dir !== 'out' && dir !== 'in'
            ? ((node?.__edges || []) as Array<{ dstIdx: number; srcIdx: number; label: string }>).concat(incomingEdges[entry.nIdx] || [])
            : (node?.__edges || []) as Array<{ dstIdx: number; srcIdx: number; label: string }>
        for (const e of edgeArr) {
          let nIdx = -1
          if (dir === 'out' && e.srcIdx === entry.nIdx) nIdx = e.dstIdx
          else if (dir === 'in' && e.dstIdx === entry.nIdx) nIdx = e.srcIdx
          else if (dir !== 'out' && dir !== 'in') {
            if (e.srcIdx === entry.nIdx) nIdx = e.dstIdx
            else if (e.dstIdx === entry.nIdx) nIdx = e.srcIdx
          }
          if (nIdx < 0 || nIdx >= srcNodes.length) continue
          if (entry.path.includes(nIdx)) continue
          const newPath = [...entry.path, nIdx]
          if (depth < minHops) { nextFrontier.push({ nIdx, path: newPath }); continue }
          const targetNode = srcNodes[nIdx] as any
          if (step.edgeLabel && e.label !== step.edgeLabel) continue
          // Edge inline property predicate: `MATCH ()-[:T {year:1988}*]->()`
          // constrains traversal to relationships whose props match every pair.
          const edgePropsPred = (step as any).edgeProps
          if (edgePropsPred && typeof edgePropsPred === 'object') {
            let edgeMismatch = false
            for (const [pk, pv] of Object.entries(edgePropsPred as Record<string, unknown>)) {
              if (!(e as any).props || (e as any).props[pk] !== pv) { edgeMismatch = true; break }
            }
            if (edgeMismatch) continue
          }
          // Target inline property predicate: `MATCH ()-[:T*]->(m {var:'end'})`
          // constrains the BFS endpoint to nodes matching every key/value pair.
          const tgtProps = (step as any).targetProps
          if (tgtProps && typeof tgtProps === 'object') {
            let tgtMismatch = false
            for (const [pk, pv] of Object.entries(tgtProps as Record<string, unknown>)) {
              if (targetNode[pk] !== pv) { tgtMismatch = true; break }
            }
            if (tgtMismatch) { nextFrontier.push({ nIdx, path: newPath }); continue }
          }
          const pathNodes = newPath.map((idx) => {
            const n = srcNodes[idx] as any
            const out: Record<string, unknown> = { _label: n._label || 'Default' }
            for (const k of Object.keys(n)) { if (k !== '_label' && k !== '__edges' && k !== '_alias') out[k] = n[k] }
            return out
          })
          result.push(_buildRow(newPath, srcNodes, step, plan, pathNodes))
          nextFrontier.push({ nIdx, path: newPath })
        }
      }
      frontier = nextFrontier
      if (frontier.length === 0) break
    }
  }

  if (plan.with?.columns?.length && result.length > 0) {
    return _applyWithProjection(result, plan)
  }
  return postProcessResults(result, plan)
}

/** Result of expanding a single variable-length step from one start node:
 *  `path` holds the traversed node indices (length 1 when the step matches
 *  zero hops), `edges` holds the relationship objects along the walk. */
interface StepMatch { path: number[]; edges: Array<Record<string, unknown>> }

/**
 * Expand one variable-length step (or fixed-length relationship) starting from
 * a single node index.  Returns every endpoint reachable within [minHops,
 * maxHops], including the zero-hop self match when minHops === 0.  Shared by the
 * single-step `executeVarLenPath` and the multi-step chain combinator, so both
 * paths honour label/edge-property/target-property predicates identically.
 */
function _collectStepMatches(
  startIdx: number,
  step: any,
  srcNodes: Array<Record<string, unknown>>,
  incomingEdges: Array<Array<{ dstIdx: number; srcIdx: number; label: string; props?: Record<string, unknown> | null }>>,
  minHops: number,
  maxHops: number,
): StepMatch[] {
  const dir = step.direction || 'out'
  const edgeLabel = step.edgeLabel as string | null
  const edgePropsPred = step.edgeProps as Record<string, unknown> | null
  const tgtProps = step.targetProps as Record<string, unknown> | null
  const tgtLabel = step.targetLabel as string | null
  const matches: StepMatch[] = []

  const pushMatch = (path: number[]): void => {
    const targetNode = srcNodes[path[path.length - 1]] as any
    if (tgtLabel && !_matchesLabel(targetNode, tgtLabel)) return
    if (tgtProps && typeof tgtProps === 'object') {
      for (const [pk, pv] of Object.entries(tgtProps)) {
        if (targetNode[pk] !== pv) return
      }
    }
    const edges = _buildPathEdges(path, srcNodes)
    matches.push({ path, edges })
    // always continue extending from the matched node for longer hops.
  }

  if (minHops === 0) {
    pushMatch([startIdx])
  }

  let frontier: BfsEntry[] = [{ nIdx: startIdx, path: [startIdx] }]
  for (let depth = 1; depth <= maxHops; depth++) {
    const nextFrontier: BfsEntry[] = []
    for (const entry of frontier) {
      const node = srcNodes[entry.nIdx] as any
      const edgeArr =
        dir !== 'out' && dir !== 'in'
          ? ((node?.__edges || []) as any[]).concat(incomingEdges[entry.nIdx] || [])
          : (node?.__edges || []) as any[]
      for (const e of edgeArr) {
        let nIdx = -1
        if (dir === 'out' && e.srcIdx === entry.nIdx) nIdx = e.dstIdx
        else if (dir === 'in' && e.dstIdx === entry.nIdx) nIdx = e.srcIdx
        else if (dir !== 'out' && dir !== 'in') {
          if (e.srcIdx === entry.nIdx) nIdx = e.dstIdx
          else if (e.dstIdx === entry.nIdx) nIdx = e.srcIdx
        }
        if (nIdx < 0 || nIdx >= srcNodes.length) continue
        if (entry.path.includes(nIdx)) continue
        if (edgeLabel && e.label !== edgeLabel) continue
        if (edgePropsPred && typeof edgePropsPred === 'object') {
          let mismatch = false
          for (const [pk, pv] of Object.entries(edgePropsPred)) {
            if (!e.props || e.props[pk] !== pv) { mismatch = true; break }
          }
          if (mismatch) continue
        }
        const newPath = [...entry.path, nIdx]
        if (depth >= minHops) pushMatch(newPath)
        nextFrontier.push({ nIdx, path: newPath })
      }
    }
    frontier = nextFrontier
    if (frontier.length === 0) break
  }

  return matches
}

/**
 * Combinator for a chain of two or more variable-length steps.  Each step is
 * expanded independently with `_collectStepMatches`, then the adjacent steps are
 * joined on their shared node variable (step[i].targetAlias === step[i+1].source)
 * so independent zero/one-hop choices Cartesian-product into the full row set.
 * Handles the zero-length-in-the-middle case (`-[:T*0..1]->(b)-[:U*0..1]->(c)`).
 */
function _executeVarLenChain(plan: any, nodes: Array<Record<string, unknown>>): QueryResult {
  const postProcessResults = _postProcessResults
  const srcNodes: Array<Record<string, unknown>> = [...(nodes || [])]
  const steps: any[] = plan.steps

  // Reveerse adjacency for undirected (`any`) steps.
  const incomingEdges: Array<Array<{ dstIdx: number; srcIdx: number; label: string; props?: Record<string, unknown> | null }>> =
    new Array(srcNodes.length).fill(null).map(() => [])
  for (let ni = 0; ni < srcNodes.length; ni++) {
    const edges = (srcNodes[ni] as any)?.__edges as any[] | undefined
    if (!edges) continue
    for (const e of edges) {
      if (e.dstIdx >= 0 && e.dstIdx < srcNodes.length) incomingEdges[e.dstIdx].push(e)
    }
  }

  const firstStep = steps[0]
  const firstRange = firstStep.range
  const firstMin = firstRange.min ?? 1
  const firstMax = Math.min(firstRange.max ?? 10, 50)

  // Determine start node candidates (honouring scanLabel + sourceProps).
  const startIdxs: number[] = []
  for (let i = 0; i < srcNodes.length; i++) {
    const n = srcNodes[i] as any
    if (plan.scanLabel && !_matchesLabel(n, plan.scanLabel)) continue
    const sp = firstStep.sourceProps
    if (sp && typeof sp === 'object') {
      let mismatch = false
      for (const [pk, pv] of Object.entries(sp)) { if (n[pk] !== pv) { mismatch = true; break } }
      if (mismatch) continue
    }
    startIdxs.push(i)
  }

  const nodeSnap = (idx: number): Record<string, unknown> => {
    const n = srcNodes[idx] as any
    const out: Record<string, unknown> = { _label: n._label || 'Default' }
    for (const k of Object.keys(n)) { if (k !== '_label' && k !== '__edges' && k !== '_alias') out[k] = n[k] }
    return out
  }

  const result: QueryRow[] = []
  // rows is a list of partial binding maps keyed by variable name; each entry
  // also carries a hidden __stepEnd index (the node index reached by this step)
  // and, when a path variable is present, the accumulated __fullPath node-index
  // sequence and __fullEdges edge-object sequence spanning every step so far.
  let rows: Array<Record<string, unknown> & { __stepEnd: number; __fullPath: number[]; __fullEdges: Array<Record<string, unknown>> }> = []

  for (let si = 0; si < steps.length; si++) {
    const step = steps[si]
    const range = step.range
    const minHops = range.min ?? 1
    const maxHops = Math.min(range.max ?? 10, 50)
    const nextRows: Array<Record<string, unknown> & { __stepEnd: number; __fullPath: number[]; __fullEdges: Array<Record<string, unknown>> }> = []
    if (si === 0) {
      for (const startIdx of startIdxs) {
        const ms = _collectStepMatches(startIdx, step, srcNodes, incomingEdges, minHops, maxHops)
        for (const m of ms) {
          const row: Record<string, unknown> & { __stepEnd: number; __fullPath: number[]; __fullEdges: Array<Record<string, unknown>> } =
            { __stepEnd: m.path[m.path.length - 1], __fullPath: [...m.path], __fullEdges: [...m.edges] } as any
          if (step.source) row[step.source] = nodeSnap(m.path[0])
          if (step.targetAlias) row[step.targetAlias] = nodeSnap(m.path[m.path.length - 1])
          if (step.edgeVariable) row[step.edgeVariable] = m.edges
          nextRows.push(row)
        }
      }
    } else {
      for (const base of rows) {
        const startIdx = base.__stepEnd
        const ms = _collectStepMatches(startIdx, step, srcNodes, incomingEdges, minHops, maxHops)
        for (const m of ms) {
          // Concatenate the current step's path onto the accumulated path,
          // dropping this step's starting node (it equals base.__stepEnd,
          // already the last node of the accumulated path).
          const fullPath = [...base.__fullPath, ...m.path.slice(1)]
          const fullEdges = [...base.__fullEdges, ...m.edges]
          const row: Record<string, unknown> & { __stepEnd: number; __fullPath: number[]; __fullEdges: Array<Record<string, unknown>> } =
            { ...base, __stepEnd: m.path[m.path.length - 1], __fullPath: fullPath, __fullEdges: fullEdges } as any
          if (step.source) row[step.source] = nodeSnap(m.path[0])
          if (step.targetAlias) row[step.targetAlias] = nodeSnap(m.path[m.path.length - 1])
          if (step.edgeVariable) row[step.edgeVariable] = m.edges
          nextRows.push(row)
        }
      }
    }
    rows = nextRows
    if (rows.length === 0) break
  }

  for (const row of rows) {
    const out: QueryRow = {}
    for (const [k, v] of Object.entries(row)) {
      if (k === '__stepEnd' || k === '__fullPath' || k === '__fullEdges') continue
      out[k] = v
    }
    // Bind the named path variable to the full accumulated path across all
    // steps.  The chain combinator otherwise drops `p` (only the single-step
    // `_buildRow` handles `plan.pathVar`), which leaves `RETURN p` null.
    if (plan.pathVar) {
      const pathNodes = row.__fullPath.map((idx: number) => nodeSnap(idx))
      out[plan.pathVar] = { __path: pathNodes, __pathEdges: row.__fullEdges }
    }
    result.push(out)
  }

  if (plan.with?.columns?.length && result.length > 0) {
    return _applyWithProjection(result, plan)
  }
  return postProcessResults(result, plan)
}

function _applyWithProjection(rows: QueryRow[], plan: any): QueryResult {
  const evaluateExpr = _evaluateExpression
  const postProcessResults = _postProcessResults
  const aggFnPattern = /^\s*(collect|count|sum|avg|max|min)\s*\(/i
  const isAggCol: boolean[] = plan.with.columns.map((col: any) =>
    typeof col.expression === 'string' ? aggFnPattern.test(col.expression) : false)
  const hasAgg = isAggCol.some(Boolean)

  const withRows: QueryRow[] = rows.map((row) => {
    const evalCtx: Record<string, unknown> = { ...row }
    const newRow: Record<string, unknown> = {}
    for (let ci = 0; ci < plan.with.columns.length; ci++) {
      const col = plan.with.columns[ci]; const alias = col.alias || col.expression
      if (!isAggCol[ci]) {
        const val = evaluateExpr(col.expression as string, evalCtx)
        newRow[alias] = val !== undefined ? val : null
        evalCtx[alias] = newRow[alias]
      }
    }
    return newRow
  })

  // Resolve RETURN expression aliases (e.g. `all(x IN nodes WHERE ...) AS
  // result`) against each projected row.  This must run for BOTH the aggregate
  // and non-aggregate WITH paths — otherwise a query like
  //   MATCH p = (:L)-[*0..N]->(x) WITH tail(nodes(p)) AS nodes
  //   RETURN nodes, all(x IN nodes WHERE x.name = 'a') AS result
  // loses the `result` column (the non-aggregate branch returned early below).
  const applyReturnAliases = (projected: QueryRow[]): QueryRow[] => {
    if (!plan.returnAliasMap) return projected
    return projected.map((row) => {
      const resultRow: Record<string, unknown> = { ...row }
      for (const [alias, expr] of Object.entries(plan.returnAliasMap)) {
        if (!(alias in resultRow)) {
          const val = evaluateExpr(expr as string, resultRow as Record<string, unknown>)
          resultRow[alias] = val !== undefined ? val : null
        }
      }
      return resultRow
    })
  }

  if (!hasAgg) return postProcessResults(applyReturnAliases(withRows), plan)

  const nonAggCols: Array<{ col: any }> = []
  for (let ci = 0; ci < plan.with.columns.length; ci++) { if (!isAggCol[ci]) nonAggCols.push({ col: plan.with.columns[ci] }) }
  const finalRows: QueryRow[] = []; const seenGroups = new Set<string>()
  for (let ri = 0; ri < withRows.length; ri++) {
    const row = withRows[ri]
    const groupKey = nonAggCols.map((nc) => JSON.stringify(row[nc.col.alias || nc.col.expression])).join('|||')
    if (seenGroups.has(groupKey)) continue; seenGroups.add(groupKey)
    const aggRow: QueryRow = {}
    for (const nc of nonAggCols) { const alias = nc.col.alias || nc.col.expression; aggRow[alias] = row[alias] }
    let count = 0
    for (let rj = 0; rj < withRows.length; rj++) {
      const rk = nonAggCols.map((nc) => JSON.stringify(withRows[rj][nc.col.alias || nc.col.expression])).join('|||')
      if (rk === groupKey) count++
    }
    for (let ci = 0; ci < plan.with.columns.length; ci++) {
      if (isAggCol[ci]) { const alias = plan.with.columns[ci].alias || plan.with.columns[ci].expression; aggRow[alias] = count }
    }
    finalRows.push(aggRow)
  }
  if (plan.returnAliasMap) {
    return postProcessResults(applyReturnAliases(finalRows), plan)
  }
  return postProcessResults(finalRows, plan)
}
