/**
 * tck-engine-adapter.ts — GraphEngine TCK 适配器
 *
 * 将 TCK 的 `data` 数组注入到 GraphEngine 并执行查询。
 * 替换 `_executeQuery(plan, data)` → `tckExecute(engine, queryStr, data)`
 */

import { GraphEngine } from '../../core/graph-engine'
import { parseQuery } from '../query-engine'
import * as fs from 'fs'
import path from 'path'

let engineCounter = 0

/**
 * 创建一个干净的 GraphEngine 测试实例（独立 /tmp 目录）。
 */
export function createTCKEngine(): GraphEngine {
  const dir = `/tmp/agx-tck-${process.pid}-${engineCounter++}`
  fs.mkdirSync(dir, { recursive: true })
  const e = new GraphEngine({ path: dir, denseVector: { dimension: 384 } })
  e.open()
  return e
}

/**
 * 关闭并清理引擎数据。
 */
export async function destroyTCKEngine(engine: GraphEngine): Promise<void> {
  engine.close()
  // 尝试清除 tmp 目录（纯文件开销）
  try {
    const dir = (engine as any).config?.path
    if (dir && dir.startsWith('/tmp/agx-tck-')) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  } catch { /* ignore */ }
}

interface NodeData {
  _label: string
  [key: string]: unknown
}

/**
 * 将 TCK data 数组注入到 GraphEngine。
 * 每个 data 元素成为 label/props 节点。
 * 返回 node id 列表，供 upsertEdge 引用。
 */
export async function injectNodes(
  engine: GraphEngine,
  data: Record<string, unknown>[],
): Promise<number[]> {
  const ids: number[] = []
  for (const item of data) {
    const label = (item._label as string) ?? 'Default'
    const props: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(item)) {
      if (k !== '_label') props[k] = v
    }
    // 用 upsertNode（typeId = hash of label, 保证同一 label 同一 typeId）
    // 用 label 字符串作为 typeName（GraphEngine._scanNodesByLabel 用 typeName 匹配 scanLabel）
    const typeId = hashLabel(label)
    const name = label
    const id = await engine.upsertNode(typeId, name, { props })
    ids.push(id)
  }
  return ids
}

/**
 * 简易 label → typeId 哈希（保持一致性）
 */
function hashLabel(label: string): number {
  let hash = 0
  for (let i = 0; i < label.length; i++) {
    hash = ((hash << 5) - hash + label.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % 1000 + 1
}

/**
 * 执行查询并返回与 _executeQuery 兼容的结果格式。
 * _executeQuery 返回 Array<Record<string,any>>，其 key 是节点变量名（如 'n', 'a', 'b'）。
 * GraphEngine.query() 返回 NodeRecord[]（直接是节点数组）。
 *
 * 这里我们保持 engine.query 的原始输出，让测试断言适配。
 */
export function tckQuery(engine: GraphEngine, queryStr: string): unknown[] {
  return engine.query(queryStr)
}

/**
 * TCK 兼容的断言包装：将 plan fields 的检查转换为 engine.query + 检查。
 * 返回 `parseQuery` 的结果用于 plan-level 断言（scanLabel, steps, 等）。
 */
export function tckPlan(queryStr: string) {
  return parseQuery(queryStr)
}
