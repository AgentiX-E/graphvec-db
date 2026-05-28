import Benchmark from 'benchmark'
import { GraphEngine } from '../../../src/core/graph-engine'
import type { OverGraphConfig } from '../../../src/types'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * Shortest-path query benchmark — measures P50 and P99 latency.
 * Builds a small graph of NODES_COUNT nodes in a chain topology, then queries the
 * shortest path from node 1 to the last node.
 * Threshold: P99 < 50 ms
 */
const NODES_COUNT = 1000

export function createQueryBenchmark(): Benchmark.Suite {
  const suite = new Benchmark.Suite('Query')

  let engine: GraphEngine
  let dataDir: string

  function setup() {
    dataDir = mkdtempSync(join(tmpdir(), 'bench-query-'))
    const config: OverGraphConfig = {
      path: join(dataDir, 'graph'),
      denseVector: { dimension: 128 },
    }
    engine = new GraphEngine(config)
    engine.open()

    // Build a chain: 1→2→3→...→NODES_COUNT
    for (let i = 1; i <= NODES_COUNT; i++) {
      engine.upsertNode(1, `n${i}`, { props: { idx: i } })
    }
    for (let i = 1; i < NODES_COUNT; i++) {
      engine.upsertEdge(i, i + 1, 10, { props: { weight: 1 } })
    }
  }

  function teardown() {
    if (engine) {
      try { (engine as any).storage?.close?.() } catch { /* ok */ }
    }
    try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* ok */ }
  }

  suite.add('shortestPath (chain 1→1000)', {
    defer: true,
    onStart: () => setup(),
    onComplete: () => teardown(),
    fn: (deferred: { resolve(): void }) => {
      engine.shortestPath(1, NODES_COUNT).then(() => deferred.resolve())
    },
  })

  return suite
}
