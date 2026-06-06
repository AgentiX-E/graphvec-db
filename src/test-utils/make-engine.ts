/**
 * Shared engine factory for tests.
 * USE THIS in all new tests — it ensures engine lifecycle is correct
 * and tests can be batched for performance.
 */
import { GraphEngine } from '../core/graph-engine'
import * as fs from 'fs'

let counter = 0

export function makeEngine(name = 'test'): GraphEngine {
  const dir = `/tmp/agx-${name}-${process.pid}-${counter++}`
  fs.mkdirSync(dir, { recursive: true })
  const e = new GraphEngine({ path: dir, denseVector: { dimension: 384 } })
  e.open()
  return e
}

/** Quick helper: create N nodes of type 1 */
export async function seedNodes(e: GraphEngine, n: number, type = 1): Promise<number[]> {
  const ids: number[] = []
  for (let i = 0; i < n; i++) ids.push(await e.upsertNode(type))
  return ids
}

/** Quick helper: create chain edges between ids */
export async function seedChain(e: GraphEngine, ids: number[], edgeType = 10): Promise<void> {
  for (let i = 0; i < ids.length - 1; i++) {
    await e.upsertEdge(ids[i], ids[i + 1], edgeType)
  }
}

/** Quick helper: create complete graph edges */
export async function seedComplete(e: GraphEngine, ids: number[], edgeType = 10): Promise<void> {
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      await e.upsertEdge(ids[i], ids[j], edgeType)
    }
  }
}
