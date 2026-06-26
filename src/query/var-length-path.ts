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
  const pathVar = plan.pathVar || step.source || 'p'
  const pathEdges = _buildPathEdges(newPath, srcNodes)
  const rowRes: QueryRow = { [pathVar]: { __path: pathNodes, __pathEdges: pathEdges } }
  if (step.targetAlias) rowRes[step.targetAlias] = pathNodes[pathNodes.length - 1]
  if (plan.pathVar && step.source) rowRes[step.source] = pathNodes[0]
  const varNames = new Set([pathVar, step.targetAlias || ''].filter(Boolean))
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
  return (node as any)._label === label
}

export function executeVarLenPath(plan: any, nodes: Array<Record<string, unknown>>): QueryResult {
  const evaluateExpr = _evaluateExpression
  const postProcessResults = _postProcessResults
  const step = plan.steps[0]
  const range = (step as any).range
  const minHops = range.min ?? 1
  const maxHops = Math.min(range.max ?? 10, 50)
  const result: QueryRow[] = []
  const srcNodes: Array<Record<string, unknown>> = [...(nodes || [])]

  for (let si = 0; si < srcNodes.length; si++) {
    const sourceNode = srcNodes[si] as any
    if (plan.scanLabel && !_matchesLabel(sourceNode, plan.scanLabel)) continue
    if (minHops === 0) {
      const pathVar = plan.pathVar || (step as any).source || 'p'
      const sn: Record<string, unknown> = { _label: sourceNode._label || 'Default' }
      for (const k of Object.keys(sourceNode)) { if (k !== '_label' && k !== '__edges' && k !== '_alias') sn[k] = sourceNode[k] }
      const rowRes: QueryRow = { [pathVar]: { __path: [sn], __pathEdges: [] } }
      if ((step as any).targetAlias) rowRes[(step as any).targetAlias] = sn
      if (plan.pathVar && (step as any).source) rowRes[(step as any).source] = sn
      if (Object.keys(rowRes).length) result.push(rowRes)
    }
    let frontier: BfsEntry[] = [{ nIdx: si, path: [si] }]
    for (let depth = 1; depth <= maxHops; depth++) {
      const nextFrontier: BfsEntry[] = []
      for (const entry of frontier) {
        const node = srcNodes[entry.nIdx] as any
        const edgeArr: Array<{ dstIdx: number; srcIdx: number; label: string }> = node?.__edges || []
        for (const e of edgeArr) {
          let nIdx = -1
          const dir = (step as any).direction || 'out'
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
  if (!hasAgg) return postProcessResults(withRows, plan)

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
    const mappedRows = finalRows.map((row) => {
      const resultRow = { ...row }
      for (const [alias, expr] of Object.entries(plan.returnAliasMap)) {
        if (!(alias in resultRow)) { const val = evaluateExpr(expr as string, resultRow as any); resultRow[alias] = val !== undefined ? val : null }
      }
      return resultRow
    })
    return postProcessResults(mappedRows, plan)
  }
  return postProcessResults(finalRows, plan)
}
