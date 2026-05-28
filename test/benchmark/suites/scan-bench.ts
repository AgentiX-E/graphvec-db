import Benchmark from 'benchmark'
import { GraphEngine } from '../../../src/core/graph-engine'
import type { OverGraphConfig } from '../../../src/types'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * Scan benchmark — measures full-graph scan throughput for all-node enumeration.
 * Builds a graph of NODES_COUNT nodes, then calls scanAllNodes() in a loop.
 */
const NODES_COUNT = 500

export function createScanBenchmark(): Benchmark.Suite {
  const suite = new Benchmark.Suite('Scan')

  let engine: GraphEngine
  let dataDir: string

  function setup() {
    dataDir = mkdtempSync(join(tmpdir(), 'bench-scan-'))
    const config: OverGraphConfig = {
      path: join(dataDir, 'graph'),
      denseVector: { dimension: 128 },
    }
    engine = new GraphEngine(config)
    engine.open()

    for (let i = 1; i <= NODES_COUNT; i++) {
      engine.upsertNode(1, `n${i}`, { props: { idx: i } })
    }
  }

  function teardown() {
    if (engine) {
      try { (engine as any).storage?.close?.() } catch { /* ok */ }
    }
    try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* ok */ }
  }

  suite.add('scanAllNodes (500 nodes)', {
    defer: false,
    onStart: () => setup(),
    onComplete: () => teardown(),
    fn: () => {
      engine.scanAllNodes()
    },
  })

  return suite
}
