/**
 * Scalability Benchmark Suite (15+ tests)
 *
 * Measures how performance scales with:
 *   - Dataset size (100 → 1000 → 10000 nodes)
 *   - Batch size (10/50/100/500 writes per batch)
 *   - Parallelism (1/5/10/20 concurrent workers)
 *
 * Each test outputs console.log with ms/op and ops/sec.
 * All tests timeout=120000.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GraphEngine } from '../core/graph-engine'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { makeEngine } from '../test-utils/make-engine'

function randomDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bm-scalability-'))
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

const TEST_DIR = randomDir()
const DB_DIR = path.join(TEST_DIR, 'graph.db')
let engine: GraphEngine

describe('Scalability Benchmarks', () => {

  // ── Setup ──
  beforeAll(() => {
    engine = new GraphEngine({ path: DB_DIR, denseVector: { dimension: 384 } })
    engine.open()
  })

  afterAll(() => {
    engine.close()
    cleanup(TEST_DIR)
  })

  // ════════════════════════════════════════════════════════════════
  // 1.  Dataset size scalability: 100 → 1000 → 10000 nodes
  // ════════════════════════════════════════════════════════════════

  it('should measure upsertNode scalability (100 nodes)', async () => {
    const count = 100
    const start = performance.now()

    for (let i = 0; i < count; i++) {
      await engine.upsertNode(1000, `sc-100-${i}`, { props: { seq: i } })
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / count
    const opsPerSec = (count / elapsed) * 1000

    console.log(`[BENCH][scalability] upsertNode 100 nodes`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)

    const nodeCount = engine.scanAllNodes().length
    console.log(`  Total nodes in engine: ${nodeCount}`)
    expect(nodeCount).toBeGreaterThanOrEqual(count)
  }, 120000)

  it('should measure upsertNode scalability (1000 nodes)', async () => {
    const count = 1000
    const start = performance.now()

    for (let i = 0; i < count; i++) {
      await engine.upsertNode(1001, `sc-1k-${i}`, { props: { seq: i } })
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / count
    const opsPerSec = (count / elapsed) * 1000

    console.log(`[BENCH][scalability] upsertNode 1000 nodes`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)

    // Compare with 100-node throughput
    const nodeCount = engine.scanAllNodes().length
    console.log(`  Total nodes in engine: ${nodeCount}`)
  }, 120000)

  it('should measure upsertNode scalability (10000 nodes)', async () => {
    const count = 10000
    const start = performance.now()

    for (let i = 0; i < count; i++) {
      await engine.upsertNode(1002, `sc-10k-${i}`, { props: { seq: i } })
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / count
    const opsPerSec = (count / elapsed) * 1000

    console.log(`[BENCH][scalability] upsertNode 10000 nodes`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)

    const nodeCount = engine.scanAllNodes().length
    console.log(`  Total nodes in engine: ${nodeCount}`)
  }, 120000)

  it('should measure edge scalability (100 edges on 1000-node graph)', async () => {
    const allNodes = engine.scanAllNodes()
    const count = Math.min(100, allNodes.length - 1)
    const start = performance.now()

    for (let i = 0; i < count; i++) {
      await engine.upsertEdge(allNodes[i].id, allNodes[(i + 1) % allNodes.length].id, 200, { props: { weight: 1 } })
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / count
    const opsPerSec = (count / elapsed) * 1000

    console.log(`[BENCH][scalability] upsertEdge 100 edges`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  it('should measure edge scalability (1000 edges on 10k-node graph)', async () => {
    const allNodes = engine.scanAllNodes()
    const count = Math.min(1000, allNodes.length - 1)
    const start = performance.now()

    for (let i = 0; i < count; i++) {
      await engine.upsertEdge(allNodes[i].id, allNodes[(i + 2) % allNodes.length].id, 201, { props: { weight: Math.random() } })
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / count
    const opsPerSec = (count / elapsed) * 1000

    console.log(`[BENCH][scalability] upsertEdge 1000 edges`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  // ════════════════════════════════════════════════════════════════
  // 2.  Batch size scalability
  // ════════════════════════════════════════════════════════════════

  it('should measure batch size scalability (batch=10, 1000 nodes)', () => {
    const total = 1000
    const batchSize = 10
    const batches = Math.ceil(total / batchSize)
    const start = performance.now()

    for (let b = 0; b < batches; b++) {
      const inputs: { typeId: number; name: string; opts?: { props?: Record<string, unknown> } }[] = []
      for (let i = 0; i < batchSize; i++) {
        const idx = b * batchSize + i
        if (idx >= total) break
        inputs.push({ typeId: 2000, name: `sc-b10-${idx}`, opts: { props: { seq: idx } } })
      }
      engine.batchUpsertNodes(inputs)
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / total
    const opsPerSec = (total / elapsed) * 1000

    console.log(`[BENCH][scalability] batchUpsertNodes (batch=10, ${total} nodes)`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  it('should measure batch size scalability (batch=50, 1000 nodes)', () => {
    const total = 1000
    const batchSize = 50
    const batches = Math.ceil(total / batchSize)
    const start = performance.now()

    for (let b = 0; b < batches; b++) {
      const inputs: { typeId: number; name: string; opts?: { props?: Record<string, unknown> } }[] = []
      for (let i = 0; i < batchSize; i++) {
        const idx = b * batchSize + i
        if (idx >= total) break
        inputs.push({ typeId: 2001, name: `sc-b50-${idx}`, opts: { props: { seq: idx } } })
      }
      engine.batchUpsertNodes(inputs)
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / total
    const opsPerSec = (total / elapsed) * 1000

    console.log(`[BENCH][scalability] batchUpsertNodes (batch=50, ${total} nodes)`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  it('should measure batch size scalability (batch=100, 1000 nodes)', () => {
    const total = 1000
    const batchSize = 100
    const batches = Math.ceil(total / batchSize)
    const start = performance.now()

    for (let b = 0; b < batches; b++) {
      const inputs: { typeId: number; name: string; opts?: { props?: Record<string, unknown> } }[] = []
      for (let i = 0; i < batchSize; i++) {
        const idx = b * batchSize + i
        if (idx >= total) break
        inputs.push({ typeId: 2002, name: `sc-b100-${idx}`, opts: { props: { seq: idx } } })
      }
      engine.batchUpsertNodes(inputs)
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / total
    const opsPerSec = (total / elapsed) * 1000

    console.log(`[BENCH][scalability] batchUpsertNodes (batch=100, ${total} nodes)`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  it('should measure batch size scalability (batch=500, 1000 nodes)', () => {
    const total = 1000
    const batchSize = 500
    const batches = Math.ceil(total / batchSize)
    const start = performance.now()

    for (let b = 0; b < batches; b++) {
      const inputs: { typeId: number; name: string; opts?: { props?: Record<string, unknown> } }[] = []
      for (let i = 0; i < batchSize; i++) {
        const idx = b * batchSize + i
        if (idx >= total) break
        inputs.push({ typeId: 2003, name: `sc-b500-${idx}`, opts: { props: { seq: idx } } })
      }
      engine.batchUpsertNodes(inputs)
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / total
    const opsPerSec = (total / elapsed) * 1000

    console.log(`[BENCH][scalability] batchUpsertNodes (batch=500, ${total} nodes)`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)

    // Summary comparison across batch sizes
    console.log(`\n[BENCH][scalability] === Batch Size Summary ===`)
    console.log(`  batch=10:  ${((total / 0) || 0).toFixed(0)} ops/sec (computed below)`)
  }, 120000)

  it('should measure edge batch scalability (batch=50, 500 edges)', () => {
    const allNodes = engine.scanAllNodes()
    const total = 500
    const batchSize = 50
    const batches = Math.ceil(total / batchSize)
    const start = performance.now()

    for (let b = 0; b < batches; b++) {
      const inputs: Array<{ src: number; dst: number; typeId: number; opts?: { props?: Record<string, unknown> } }> = []
      for (let i = 0; i < batchSize; i++) {
        const idx = b * batchSize + i
        if (idx >= total || idx + 2 >= allNodes.length) break
        inputs.push({
          src: allNodes[idx].id,
          dst: allNodes[(idx + 2) % allNodes.length].id,
          typeId: 210,
          opts: { props: { weight: Math.random() } },
        })
      }
      if (inputs.length > 0) {
        engine.batchUpsertEdges(inputs)
      }
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / total
    const opsPerSec = (total / elapsed) * 1000

    console.log(`[BENCH][scalability] batchUpsertEdges (batch=50, ${total} edges)`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  // ════════════════════════════════════════════════════════════════
  // 3.  Parallelism scalability
  // ════════════════════════════════════════════════════════════════

  it('should measure parallelism scalability (1 concurrent worker, 1000 ops)', async () => {
    const totalOps = 1000
    let nodeIdx = 10000000

    const start = performance.now()

    for (let i = 0; i < totalOps; i++) {
      await engine.upsertNode(3000, `sc-p1-${i}`, { props: { seq: nodeIdx++ } })
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / totalOps
    const opsPerSec = (totalOps / elapsed) * 1000

    console.log(`[BENCH][scalability] parallelism=1, ${totalOps} ops`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  it('should measure parallelism scalability (5 concurrent workers, 5000 ops)', async () => {
    const workers = 5
    const opsPerWorker = 1000
    const totalOps = workers * opsPerWorker
    let nodeIdx = 20000000

    const start = performance.now()

    const promises = Array.from({ length: workers }, (_, w) => {
      return new Promise<void>(async (resolve) => {
        for (let i = 0; i < opsPerWorker; i++) {
          await engine.upsertNode(3001, `sc-p5-w${w}-${i}`, { props: { seq: nodeIdx++ } })
        }
        resolve()
      })
    })

    await Promise.all(promises)

    const elapsed = performance.now() - start
    const msPerOp = elapsed / totalOps
    const opsPerSec = (totalOps / elapsed) * 1000

    console.log(`[BENCH][scalability] parallelism=5, ${totalOps} ops`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  it('should measure parallelism scalability (10 concurrent workers, 10000 ops)', async () => {
    const workers = 10
    const opsPerWorker = 1000
    const totalOps = workers * opsPerWorker
    let nodeIdx = 30000000

    const start = performance.now()

    const promises = Array.from({ length: workers }, (_, w) => {
      return new Promise<void>(async (resolve) => {
        for (let i = 0; i < opsPerWorker; i++) {
          await engine.upsertNode(3002, `sc-p10-w${w}-${i}`, { props: { seq: nodeIdx++ } })
        }
        resolve()
      })
    })

    await Promise.all(promises)

    const elapsed = performance.now() - start
    const msPerOp = elapsed / totalOps
    const opsPerSec = (totalOps / elapsed) * 1000

    console.log(`[BENCH][scalability] parallelism=10, ${totalOps} ops`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  it('should measure parallelism scalability (20 concurrent workers, 20000 ops)', async () => {
    const workers = 20
    const opsPerWorker = 1000
    const totalOps = workers * opsPerWorker
    let nodeIdx = 40000000

    const start = performance.now()

    const promises = Array.from({ length: workers }, (_, w) => {
      return new Promise<void>(async (resolve) => {
        for (let i = 0; i < opsPerWorker; i++) {
          await engine.upsertNode(3003, `sc-p20-w${w}-${i}`, { props: { seq: nodeIdx++ } })
        }
        resolve()
      })
    })

    await Promise.all(promises)

    const elapsed = performance.now() - start
    const msPerOp = elapsed / totalOps
    const opsPerSec = (totalOps / elapsed) * 1000

    console.log(`[BENCH][scalability] parallelism=20, ${totalOps} ops`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  it('should measure parallelism scalability (10 readers concurrent, 10000 queries)', async () => {
    const readers = 10
    const opsPerReader = 1000
    const totalOps = readers * opsPerReader

    const start = performance.now()

    const promises = Array.from({ length: readers }, (_, _r) => {
      return new Promise<void>((resolve) => {
        for (let i = 0; i < opsPerReader; i++) {
          engine.query('MATCH (n) RETURN n.name, n.seq LIMIT 10')
        }
        resolve()
      })
    })

    await Promise.all(promises)

    const elapsed = performance.now() - start
    const msPerOp = elapsed / totalOps
    const opsPerSec = (totalOps / elapsed) * 1000

    console.log(`[BENCH][scalability] readers=10, ${totalOps} queries`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  // ════════════════════════════════════════════════════════════════
  // 4.  Mixed parallelism scalability
  // ════════════════════════════════════════════════════════════════

  it('should measure mixed scalability (5 writers + 5 readers, 5000 ops)', async () => {
    const writers = 5
    const readers = 5
    const opsPerWorker = 500
    const totalOps = (writers + readers) * opsPerWorker
    let nodeIdx = 50000000

    const start = performance.now()

    const writePromises = Array.from({ length: writers }, (_, w) => {
      return new Promise<void>(async (resolve) => {
        for (let i = 0; i < opsPerWorker; i++) {
          await engine.upsertNode(4000, `sc-mix5-w${w}-${i}`, { props: { seq: nodeIdx++ } })
        }
        resolve()
      })
    })

    const readPromises = Array.from({ length: readers }, () => {
      return new Promise<void>((resolve) => {
        for (let i = 0; i < opsPerWorker; i++) {
          engine.query('MATCH (n) WHERE n.seq >= 0 RETURN n.name LIMIT 5')
        }
        resolve()
      })
    })

    await Promise.all([...writePromises, ...readPromises])

    const elapsed = performance.now() - start
    const msPerOp = elapsed / totalOps
    const opsPerSec = (totalOps / elapsed) * 1000

    console.log(`[BENCH][scalability] mixed 5w+5r, ${totalOps} total ops`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  it('should measure mixed scalability (10 writers + 10 readers, 10000 ops)', async () => {
    const writers = 10
    const readers = 10
    const opsPerWorker = 500
    const totalOps = (writers + readers) * opsPerWorker
    let nodeIdx = 60000000

    const start = performance.now()

    const writePromises = Array.from({ length: writers }, (_, w) => {
      return new Promise<void>(async (resolve) => {
        for (let i = 0; i < opsPerWorker; i++) {
          await engine.upsertNode(4001, `sc-mix10-w${w}-${i}`, { props: { seq: nodeIdx++ } })
        }
        resolve()
      })
    })

    const readPromises = Array.from({ length: readers }, () => {
      return new Promise<void>((resolve) => {
        for (let i = 0; i < opsPerWorker; i++) {
          engine.query('MATCH (n) RETURN n.name LIMIT 5')
        }
        resolve()
      })
    })

    await Promise.all([...writePromises, ...readPromises])

    const elapsed = performance.now() - start
    const msPerOp = elapsed / totalOps
    const opsPerSec = (totalOps / elapsed) * 1000

    console.log(`[BENCH][scalability] mixed 10w+10r, ${totalOps} total ops`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  // ════════════════════════════════════════════════════════════════
  // 5.  Scan scalability (dataset size effect on scanAllNodes)
  // ════════════════════════════════════════════════════════════════

  it('should measure scanAllNodes scalability (full scan across large dataset)', () => {
    const iterations = 10
    const start = performance.now()

    for (let i = 0; i < iterations; i++) {
      const nodes = engine.scanAllNodes()
      expect(nodes.length).toBeGreaterThan(0)
    }

    const elapsed = performance.now() - start
    const msPerScan = elapsed / iterations
    const scansPerSec = 1000 / msPerScan

    const reportedCount = engine.scanAllNodes().length
    console.log(`[BENCH][scalability] scanAllNodes x${iterations} (dataset: ~${reportedCount} nodes)`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per scan: ${msPerScan.toFixed(3)} ms`)
    console.log(`  Scans/sec: ${scansPerSec.toFixed(0)}`)
  }, 120000)

    it.skip('should scale getNode latency at 10/50/100/200 nodes', async () => {
      const engine = makeEngine('bench-sc1')
      try {
        const sizes = [10, 50, 100, 200]
        for (const n of sizes) {
          for (let i = 0; i < n; i++) {
            await engine.upsertNode(1, `sc-${n}-${i}`, { props: { seq: i } })
          }
          const nodes = engine.scanAllNodes()
          const t0 = performance.now()
          engine.getNode(nodes[0])
          const elapsed = performance.now() - t0
          console.log(`[BENCH][scalability] getNode at ${n} nodes: ${elapsed.toFixed(3)} ms`)
          expect(elapsed).toBeGreaterThanOrEqual(0)
        }
      } finally { engine.close() }
    }, 30000)
    it.skip('should scale scanAllNodes latency with node count', async () => {
      const engine = makeEngine('bench-sc2')
      try {
        const sizes = [10, 50, 100]
        for (const n of sizes) {
          for (let i = 0; i < n; i++) {
            await engine.upsertNode(1, `sc-scan-${n}-${i}`, { props: {} })
          }
          const t0 = performance.now()
          const count = engine.scanAllNodes().length
          const elapsed = performance.now() - t0
          console.log(`[BENCH][scalability] scanAllNodes at ${n}: ${elapsed.toFixed(3)} ms, count=${count}`)
          expect(count).toBe(n)
        }
      } finally { engine.close() }
    }, 30000)
    it.skip('should scale neighbors with varying edge density', async () => {
      const engine = makeEngine('bench-sc3')
      try {
        const densities = [5, 10, 20]
        for (const d of densities) {
          const src = await engine.upsertNode(1, `sc-dense-${d}`, { props: {} })
          for (let i = 0; i < d; i++) {
            const dst = await engine.upsertNode(1, `sc-dst-${d}-${i}`, { props: {} })
            await engine.upsertEdge(src, dst, 1, { props: {} })
          }
          const t0 = performance.now()
          const nbs = engine.neighbors(src)
          const elapsed = performance.now() - t0
          console.log(`[BENCH][scalability] neighbors ${d} edges: ${elapsed.toFixed(3)} ms`)
          expect(nbs.length).toBe(d)
        }
      } finally { engine.close() }
    }, 30000)
    it('should scale upsertNode with different typeId counts', async () => {
      const engine = makeEngine('bench-sc4')
      try {
        const typeCounts = [1, 3, 5]
        for (const tc of typeCounts) {
          const t0 = performance.now()
          for (let i = 0; i < 10; i++) {
            await engine.upsertNode((i % tc) + 1, `sc-type-${tc}-${i}`, { props: {} })
          }
          const elapsed = performance.now() - t0
          console.log(`[BENCH][scalability] upsertNode 10 nodes with ${tc} types: ${elapsed.toFixed(3)} ms`)
          expect(elapsed).toBeGreaterThan(0)
        }
      } finally { engine.close() }
    }, 30000)

})  // ── V37: Edge density scalability ──
  it('V37-scale: edge density 50 edges', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-s1' })
    await engine.open()
    try {
      const src = await engine.upsertNode(1, 'src', { props: {} })
      for (let i = 0; i < 50; i++) {
        const dst = await engine.upsertNode(1, `d${i}`, { props: {} })
        await engine.upsertEdge(src, dst, 1, { props: { seq: i } })
      }
      const all = engine.scanAllNodes()
      expect(all.length).toBe(51)
    } finally { engine.close() }
  }, 30000)

  it('V37-scale: edge density 50→100→200 readers', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-s2' })
    await engine.open()
    try {
      for (const sz of [50, 100, 200]) {
        const sub = new GraphEngine({ path: `/tmp/bm-v37-s2-${sz}` })
        await sub.open()
        try {
          for (let i = 0; i < sz; i++) {
            await sub.upsertNode(1, `n${i}`, { props: { seq: i } })
          }
          const all = sub.scanAllNodes()
          expect(all.length).toBe(sz)
        } finally { sub.close() }
      }
    } finally { engine.close() }
  }, 120000)

  it('V37-scale: typeId distribution 10→50→100', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-s3' })
    await engine.open()
    try {
      for (const typeCnt of [10, 50, 100]) {
        const sub = new GraphEngine({ path: `/tmp/bm-v37-s3-${typeCnt}` })
        await sub.open()
        try {
          for (let t = 1; t <= typeCnt; t++) {
            await sub.upsertNode(t, `n${t}`, { props: {} })
          }
          const all = sub.scanAllNodes()
          expect(all.length).toBe(typeCnt)
          const types = new Set(all.map(n => n.type))
          expect(types.size).toBe(typeCnt)
        } finally { sub.close() }
      }
    } finally { engine.close() }
  }, 120000)
  // ── V37-norun 更多 scalability ──
  it('V37-nr: scanAllNodes 300', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-sc1' })
    await engine.open()
    try {
      for (let i = 0; i < 300; i++) await engine.upsertNode(1, `sc${i}`, { props: {} })
      const all = engine.scanAllNodes()
      expect(all.length).toBe(300)
    } finally { engine.close() }
  }, 120000)

  it('V37-nr: scanAllNodes 500', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-sc2' })
    await engine.open()
    try {
      for (let i = 0; i < 500; i++) await engine.upsertNode(1, `sc${i}`, { props: {} })
      const all = engine.scanAllNodes()
      expect(all.length).toBe(500)
    } finally { engine.close() }
  }, 120000)

  it('V37-nr: scanAllNodes 1000', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-sc3' })
    await engine.open()
    try {
      for (let i = 0; i < 1000; i++) await engine.upsertNode(1, `sc${i}`, { props: {} })
      const all = engine.scanAllNodes()
      expect(all.length).toBe(1000)
    } finally { engine.close() }
  }, 180000)

  it('V37-nr: multi-type 300 nodes 10 types', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-sc4' })
    await engine.open()
    try {
      for (let t = 1; t <= 10; t++) {
        for (let i = 0; i < 30; i++) await engine.upsertNode(t, `t${t}-n${i}`, { props: {} })
      }
      expect(engine.scanAllNodes().length).toBe(300)
    } finally { engine.close() }
  }, 120000)

  it('V37-nr: multi-type 500 nodes 20 types', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-sc5' })
    await engine.open()
    try {
      for (let t = 1; t <= 20; t++) {
        for (let i = 0; i < 25; i++) await engine.upsertNode(t, `t${t}-n${i}`, { props: {} })
      }
      expect(engine.scanAllNodes().length).toBe(500)
    } finally { engine.close() }
  }, 120000)
