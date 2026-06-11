/**
 * tck-engine-adapter.ts — TCK → GraphEngine 适配器（方案 C）
 *
 * GraphEngine 已原生支持字符串标签和 edge label（通过 _labelRegistry / _edgeTypeRegistry）。
 * 此适配器只负责：
 * 1. 注入 TCK data → GraphEngine 节点
 * 2. 执行查询
 * 3. 格式转换：NodeRecord[] → TCK 兼容格式（{ varName: nodeProps }）
 */

import { GraphEngine } from '../../core/graph-engine'
import { parseQuery } from '../query-engine'
import { randomBytes } from 'crypto'
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
    const cfg = (engine as any).config
    if (cfg?.path && typeof cfg.path === 'string' && cfg.path.startsWith('/tmp/agx-tck-')) {
      fs.rmSync(cfg.path, { recursive: true, force: true })
    }
  } catch { /* ignore */ }
}

/**
 * 注入 TCK data 数组到 GraphEngine。
 * 每个元素的 _label 被存储为 props._label 和 typeName（由 _scanNodesByLabel 新逻辑匹配）。
 * 每个节点名保持唯一（uuid 后缀）。
 */
export async function injectNodes(
  engine: GraphEngine,
  data: Record<string, unknown>[],
): Promise<number[]> {
  const ids: number[] = []
  for (const item of data) {
    const label = (item._label as string) ?? 'Default'
    const typeId = hashLabel(label)
    const uniq = randomBytes(4).toString('hex')
    const name = `tck-${uniq}`   // 唯一 name，GraphEngine 外部不依赖 typeName 做 label 匹配

    const props: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(item))
      if (k !== '_label') props[k] = v
    props._label = label

    const id = await engine.upsertNode(typeId, name, { props })
    ids.push(id)
  }
  return ids
}

export async function injectEdge(engine: GraphEngine, srcId: number, dstId: number, typeLabel: string): Promise<void> {
  // 注册 edge label，确保 _edgeTypeRegistry 中有映射
  // GraphEngine 的 upsertEdge 接受数字 typeId
  // 但这里我们通过 engine.query 的 parser 路径走，Parser 会输出 edgeLabel 字符串
  // engine.query 内部 _resolveEdgeType 会注册并返回数字
  // 所以 upsertEdge 时需要用相同的 typeId
  const edgeTypeIds = (engine as any)._edgeTypeRegistry as Map<string, number>
  if (!edgeTypeIds.has(typeLabel)) {
    edgeTypeIds.set(typeLabel, edgeTypeIds.size + 1000)
  }
  const typeId = edgeTypeIds.get(typeLabel)!
  await engine.upsertEdge(srcId, dstId, typeId)
}

function hashLabel(label: string): number {
  let hash = 0
  for (let i = 0; i < label.length; i++)
    hash = ((hash << 5) - hash + label.charCodeAt(i)) | 0
  return Math.abs(hash) % 1000 + 1
}

/**
 * TCK 查询执行。用 engine.query() 原生执行（已支持字符串 label/edge label）。
 * 返回格式：Array<{ varName: { ...props } }>
 */
export function tckQuery(engine: GraphEngine, queryStr: string): Record<string, any>[] {
  const raw = engine.query(queryStr) as any[]

  if (!raw || raw.length === 0) return []

  // engine.query returns NodeRecord[] — each record represents one result row.
  // For single-node queries (MATCH (n) RETURN n): one NodeRecord per matched node
  // For edge queries (MATCH (a)-[:X]->(b) RETURN a,b): still one NodeRecord per result
  //   but the engine enumerates all matching (a,b) pairs as result nodes.
  // We need to transform: [NodeRecord, ...] → [{ a: {...props}, b: {...props} }, ...]

  // For edge queries, return the raw result with variable names from query string
  const varNames = extractVarNames(queryStr)

  if (varNames.length <= 1) {
    // Single variable — directly map
    return raw.map((rec: any) => {
      const key = varNames[0] || 'n'
      return { [key]: rec.props ? { ...rec.props, _label: rec.props._label } : rec }
    })
  }

  // Multi-variable (edge query): engine returns one NodeRecord per matched path.
  // For MATCH (a)-[:X]->(b) RETURN a,b, engine may return just the target node (b)
  // or both (a,b) depending on execution path.
  // If raw.length < varNames.length × expected_rows, fall back to single-var format.
  if (varNames.length >= 2 && raw.length >= 2) {
    const result: Record<string, any>[] = []
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const row: Record<string, any> = {}
      row[varNames[0]] = raw[i]?.props ? { ...raw[i].props, _label: raw[i].props._label } : raw[i]
      row[varNames[1]] = raw[i + 1]?.props ? { ...raw[i + 1].props, _label: raw[i + 1].props._label } : raw[i + 1]
      result.push(row)
    }
    return result
  }

  return raw
}

function extractVarNames(queryStr: string): string[] {
  const names = new Set<string>()
  // Extract RETURN variables
  const retMatch = queryStr.match(/RETURN\s+(.+)/i)
  if (retMatch) {
    const items = retMatch[1].split(',').map(s => s.trim())
    for (const item of items) {
      // Handle AS alias
      const asMatch = item.match(/(\w+)\s+AS\s+(\w+)/i)
      if (asMatch) names.add(asMatch[2])
      else if (item.match(/^\w+$/)) names.add(item)
      // Skip expressions like count(*), sum(n.age)
    }
  }
  // Extract MATCH variables
  const matchVars = queryStr.matchAll(/MATCH\s*\((\w+)/gi)
  for (const m of matchVars) names.add(m[1])

  return Array.from(names)
}
