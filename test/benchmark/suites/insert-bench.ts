import Benchmark from 'benchmark'
import { GraphEngine } from '../../../src/core/graph-engine'
import type { OverGraphConfig } from '../../../src/types'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * Insert benchmark — measures single-node insert throughput (ops/sec).
 * Threshold: > 1000 ops/sec
 */
export function createInsertBenchmark(): Benchmark.Suite {
  const suite = new Benchmark.Suite('Insert')

  let engine: GraphEngine
  let dataDir: string
  let nodeCounter = 0

  function setup() {
    dataDir = mkdtempSync(join(tmpdir(), 'bench-insert-'))
    const config: OverGraphConfig = {
      path: join(dataDir, 'graph'),
      denseVector: { dimension: 128 },
    }
    engine = new GraphEngine(config)
    engine.open()
    nodeCounter = 0
  }

  function teardown() {
    if (engine) {
      try { (engine as any).storage?.close?.() } catch { /* ok */ }
    }
    try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* ok */ }
  }

  suite.add('upsertNode (single)', {
    defer: false,
    onStart: () => setup(),
    onComplete: () => teardown(),
    fn: () => {
      const id = ++nodeCounter
      engine.upsertNode(1, `node-${id}`, { props: { val: id } })
    },
  })

  return suite
}
