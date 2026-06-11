/**
 * tck-engine-adapter-v2.ts — TCK → GraphEngine Bridge
 *
 * 策略：注入节点时 label 作为 typeName（唯一化），
 * 执行查询时重写 parseQuery 输出，把 scanLabel 转为 _label WHERE 过滤。
 */

import { GraphEngine } from '../../core/graph-engine'
import { parseQuery, _executeQuery, _applyGroupByHaving } from '../query-engine'
import type { QueryPlan } from '../ast-to-plan-v2'
import * as fs from 'fs'

let engineCounter = 0

export function createTCKEngine(): GraphEngine {
  const dir = `/tmp/agx-tck-${process.pid}-${engineCounter++}`
  fs.mkdirSync(dir, { recursive: true })
  const e = new GraphEngine({ path: dir, denseVector: { dimension: 384 } })
  e.open()
  return e
}

export async function destroyTCKEngine(engine: GraphEngine): Promise<void> {
  engine.close()
  try {
    const dir = (engine as any).config?.path
    if (dir && dir.startsWith('/tmp/agx-tck-')) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  } catch { /* ignore */ }
}

function hashLabel(label: string): number {
  let hash = 0
  for (let i = 0; i < label.length; i++)
    hash = ((hash << 5) - hash + label.charCodeAt(i)) | 0
  return Math.abs(hash) % 1000 + 1
}

/**
 * 注入 TCK 节点数据到 GraphEngine。
 * 每个节点 upsert 时 typeName = label (唯一后缀)，props 中存 _label。
 */
export async function injectNodes(
  engine: GraphEngine,
  data: Record<string, unknown>[],
): Promise<number[]> {
  const ids: number[] = []
  const labelCounters: Record<string, number> = {}
  for (const item of data) {
    const label = (item._label as string) ?? 'Default'
    labelCounters[label] = (labelCounters[label] ?? 0) + 1
    const typeId = hashLabel(label)
    const uniqueName = `${label}_${labelCounters[label]}`
    const props: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(item))
      if (k !== '_label') props[k] = v
    props._label = label
    const id = await engine.upsertNode(typeId, uniqueName, { props })
    ids.push(id)
  }
  return ids
}

export async function injectEdge(engine: GraphEngine, sourceId: number, targetId: number, edgeType: number): Promise<void> {
  await engine.upsertEdge(sourceId, targetId, edgeType)
}

/**
 * 重写计划：移除 scanLabel（走 _scanAll），添加 _label 过滤条件。
 */
function rewritePlan(plan: QueryPlan): { query: string; plan: QueryPlan } {
  if (!plan.scanLabel) return { query: '', plan }
  
  const label = plan.scanLabel
  // 构造注入 _label 过滤
  const labelFilter = { source: 'n', property: '_label', operator: 'EQ' as const, value: label, negated: false }
  const filters = [...(plan.filters || []), labelFilter]
  
  const rewritten: QueryPlan = {
    ...plan,
    scanLabel: undefined as any,
    filters,
  }
  return { query: '', plan: rewritten }
}

/**
 * 执行查询（用 engine + 重写 plan）。
 * 返回与 TCK _executeQuery 兼容的格式（id, name, props 等）。
 */
export function tckQueryEngine(engine: GraphEngine, queryStr: string): unknown[] {
  const plan = parseQuery(queryStr)

  let results: any[]
  if (plan.scanLabel) {
    // GraphEngine 的 _scanNodesByLabel 用 typeName 精确匹配 label 字符串。
    // TCK 中 label 是概念标签，存在 props._label 中，typeName 有唯一后缀。
    // 先做无 label 扫描，再按 _label 属性过滤。
    const noLabelQuery = queryStr.replace(/:(\w+)/g, '').replace(/\s+/g, ' ').trim()
    results = engine.query(noLabelQuery) as any[]
    results = results.filter((n: any) => n.props?._label === plan.scanLabel)
  } else if (queryStr.includes('-[:')) {
    // Edge query with string label (e.g. KNOWS) — replace with numeric edge type
    // GraphEngine expects numeric edgeTypeId, but TCK uses string labels.
    // Replace -[:KNOWS]-> with -[-> and filter by edge label in query string.
    const edgeLabel = queryStr.match(/-\[:(\w+)\]/)?.[1]
    if (edgeLabel) {
      const edgeTypeId = edgeLabelToTypeId(edgeLabel)
      const numericQuery = queryStr.replace(/-\[:\w+\]/, `-[${edgeTypeId}]-`)
      results = engine.query(numericQuery) as any[]
    } else {
      results = engine.query(queryStr) as any[]
    }
  } else {
    results = engine.query(queryStr) as any[]
  }

  return results
}

/** Edge label string → numeric typeId */
const edgeTypeRegistry: Record<string, number> = {}
let edgeTypeCounter = 10

export function edgeLabelToTypeId(label: string): number {
  if (!edgeTypeRegistry[label]) {
    edgeTypeRegistry[label] = edgeTypeCounter
    edgeTypeCounter++
  }
  return edgeTypeRegistry[label]
}
