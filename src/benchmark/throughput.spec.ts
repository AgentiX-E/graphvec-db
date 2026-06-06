/**
 * Throughput Benchmark Suite (60+ tests total across 4 files)
 *
 * Measures write/read throughput under various load patterns:
 *   - bulk node insertion (1000, 10000, 50000)
 *   - bulk edge insertion (5000)
 *   - concurrent reads (100x)
 *   - mixed read/write (5 write + 5 read) × 100 cycles
 *   - large-scale scanAllNodes
 *   - batch operations
 *   - high-rate sequential writes
 *   - concurrent mixed loads
 *
 * Each test outputs console.log benchmark data (ms/op, ops/sec).
 * All tests use timeout=120000 for slow benchmark runs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GraphEngine } from '../core/graph-engine'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

function randomDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bm-throughput-'))
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

const TEST_DIR = randomDir()
const DB_DIR = path.join(TEST_DIR, 'graph.db')
let engine: GraphEngine

describe('Throughput Benchmarks', () => {

  // ── Setup: fresh engine per describe block ──
  beforeAll(() => {
    engine = new GraphEngine({ path: DB_DIR, denseVector: { dimension: 384 } })
    engine.open()
  })

  afterAll(() => {
    engine.close()
    cleanup(TEST_DIR)
  })

  // ════════════════════════════════════════════════════════════════
  // 1.  Bulk node insertion (upsertNode, single-threaded)
  // ════════════════════════════════════════════════════════════════

  it('should measure bulk node throughput (1000 nodes via upsertNode)', async () => {
    const count = 1000
    const start = performance.now()

    for (let i = 0; i < count; i++) {
      await engine.upsertNode(1, `tp-node-1k-${i}`, { props: { seq: i, payload: 'x'.repeat(64) } })
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / count
    const opsPerSec = (count / elapsed) * 1000

    console.log(`[BENCH][throughput] bulk upsertNode 1000`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
    console.log(`  Nodes in engine: ${engine.scanAllNodes().length}`)

    expect(engine.scanAllNodes().length).toBeGreaterThanOrEqual(count - 10)
  }, 120000)

  it('should measure bulk node throughput (10000 nodes via upsertNode)', async () => {
    const count = 10000
    const start = performance.now()

    for (let i = 0; i < count; i++) {
      await engine.upsertNode(2, `tp-node-10k-${i}`, { props: { seq: i, payload: 'x'.repeat(64) } })
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / count
    const opsPerSec = (count / elapsed) * 1000

    console.log(`[BENCH][throughput] bulk upsertNode 10000`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  it('should measure bulk node throughput (50000 nodes via upsertNode)', async () => {
    const count = 50000
    const start = performance.now()

    for (let i = 0; i < count; i++) {
      await engine.upsertNode(3, `tp-node-50k-${i}`, { props: { seq: i, payload: 'x'.repeat(32) } })
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / count
    const opsPerSec = (count / elapsed) * 1000

    console.log(`[BENCH][throughput] bulk upsertNode 50000`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  // ════════════════════════════════════════════════════════════════
  // 2.  Bulk edge insertion
  // ════════════════════════════════════════════════════════════════

  it('should measure bulk edge throughput (5000 edges)', async () => {
    // Ensure enough source nodes exist
    const srcNodes = engine.scanAllNodes().filter((n: any) => n.name && !n.name.startsWith('tp-edge-'))
    const count = 5000
    let edgeCount = 0

    const start = performance.now()

    for (let i = 0; i < count && i + 1 < srcNodes.length; i++) {
      await engine.upsertEdge(srcNodes[i].id, srcNodes[(i + 1) % srcNodes.length].id, 100, {
        props: { weight: Math.random(), seq: i },
      })
      edgeCount++
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / edgeCount
    const opsPerSec = (edgeCount / elapsed) * 1000

    console.log(`[BENCH][throughput] bulk upsertEdge 5000`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  it('should measure bulk edge throughput (10000 edges)', async () => {
    const srcNodes = engine.scanAllNodes()
    const count = 10000
    let edgeCount = 0

    const start = performance.now()

    for (let i = 0; i < count && i + 2 < srcNodes.length; i++) {
      await engine.upsertEdge(srcNodes[i].id, srcNodes[(i + 2) % srcNodes.length].id, 101, {
        props: { weight: Math.random(), seq: i },
      })
      edgeCount++
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / edgeCount
    const opsPerSec = (edgeCount / elapsed) * 1000

    console.log(`[BENCH][throughput] bulk upsertEdge 10000`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  // ════════════════════════════════════════════════════════════════
  // 3.  Concurrent reads
  // ════════════════════════════════════════════════════════════════

  it('should measure concurrent read throughput (100 concurrent reads)', async () => {
    const concurrency = 100
    const queries = [
      'MATCH (n) RETURN n.name LIMIT 10',
      'MATCH (n) WHERE n.seq > 100 RETURN n.name LIMIT 5',
    ]

    // Warmup
    for (let i = 0; i < 20; i++) {
      engine.query(queries[i % queries.length])
    }

    const start = performance.now()

    const promises = Array.from({ length: concurrency }, (_, r) => {
      return new Promise<void>((resolve) => {
        engine.query(queries[r % queries.length])
        resolve()
      })
    })

    await Promise.all(promises)

    const elapsed = performance.now() - start
    const msPerOp = elapsed / concurrency
    const opsPerSec = (concurrency / elapsed) * 1000

    console.log(`[BENCH][throughput] concurrent reads ${concurrency}`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  it('should measure concurrent read throughput (500 concurrent reads)', async () => {
    const concurrency = 500

    const start = performance.now()

    const promises = Array.from({ length: concurrency }, () => {
      return new Promise<void>((resolve) => {
        engine.query('MATCH (n) RETURN n.name, n.seq LIMIT 5')
        resolve()
      })
    })

    await Promise.all(promises)

    const elapsed = performance.now() - start
    const msPerOp = elapsed / concurrency
    const opsPerSec = (concurrency / elapsed) * 1000

    console.log(`[BENCH][throughput] concurrent reads ${concurrency}`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  it('should measure concurrent read throughput (1000 concurrent reads)', async () => {
    const concurrency = 1000

    const start = performance.now()

    const promises = Array.from({ length: concurrency }, () => {
      return new Promise<void>((resolve) => {
        engine.query('MATCH (n) RETURN n.name LIMIT 3')
        resolve()
      })
    })

    await Promise.all(promises)

    const elapsed = performance.now() - start
    const msPerOp = elapsed / concurrency
    const opsPerSec = (concurrency / elapsed) * 1000

    console.log(`[BENCH][throughput] concurrent reads ${concurrency}`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  it('should measure concurrent read throughput (2000 concurrent reads)', async () => {
    const concurrency = 2000

    const start = performance.now()

    const promises = Array.from({ length: concurrency }, () => {
      return new Promise<void>((resolve) => {
        engine.query('MATCH (n) RETURN n.name, n.seq LIMIT 5')
        resolve()
      })
    })

    await Promise.all(promises)

    const elapsed = performance.now() - start
    const msPerOp = elapsed / concurrency
    const opsPerSec = (concurrency / elapsed) * 1000

    console.log(`[BENCH][throughput] concurrent reads ${concurrency}`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  // ════════════════════════════════════════════════════════════════
  // 4.  Mixed read/write throughput
  // ════════════════════════════════════════════════════════════════

  it('should measure mixed read/write throughput (5 write + 5 read) x 100', async () => {
    const cycles = 100
    const writers = 5
    const readers = 5
    let nodeIdx = 1000000
    let totalOps = 0

    const start = performance.now()

    for (let c = 0; c < cycles; c++) {
      // Writers: 5 writes per cycle
      const writePromises = Array.from({ length: writers }, (_, w) => {
        return engine.upsertNode(10, `mixed-rw-${c}-${w}`, { props: { cycle: c, seq: nodeIdx++ } })
      })

      // Readers: 5 reads per cycle
      const readPromises = Array.from({ length: readers }, () => {
        return new Promise<void>((resolve) => {
          engine.query('MATCH (n) RETURN n.name LIMIT 5')
          resolve()
        })
      })

      await Promise.all([...writePromises, ...readPromises])
      totalOps += writers + readers
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / totalOps
    const opsPerSec = (totalOps / elapsed) * 1000

    console.log(`[BENCH][throughput] mixed r/w (${writers}w+${readers}r) x ${cycles} = ${totalOps} ops`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  it('should measure mixed read/write throughput (10 write + 10 read) x 50', async () => {
    const cycles = 50
    const writers = 10
    const readers = 10
    let nodeIdx = 2000000
    let totalOps = 0

    const start = performance.now()

    for (let c = 0; c < cycles; c++) {
      const writePromises = Array.from({ length: writers }, (_, w) => {
        return engine.upsertNode(11, `mixed-rw2-${c}-${w}`, { props: { cycle: c, seq: nodeIdx++ } })
      })

      const readPromises = Array.from({ length: readers }, () => {
        return new Promise<void>((resolve) => {
          engine.query('MATCH (n) WHERE n.seq > 0 RETURN n.name LIMIT 5')
          resolve()
        })
      })

      await Promise.all([...writePromises, ...readPromises])
      totalOps += writers + readers
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / totalOps
    const opsPerSec = (totalOps / elapsed) * 1000

    console.log(`[BENCH][throughput] mixed r/w (${writers}w+${readers}r) x ${cycles} = ${totalOps} ops`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  it('should measure mixed read/write with edges (3 write + 3 read) x 100', async () => {
    const cycles = 100
    const writers = 3
    const readers = 3
    let nodeIdx = 3000000
    let totalOps = 0
    let prevNodeId: number | null = null

    const start = performance.now()

    for (let c = 0; c < cycles; c++) {
      const writePromises = Array.from({ length: writers }, async (_, w) => {
        const id = await engine.upsertNode(12, `mixed-rw3-${c}-${w}`, { props: { cycle: c, seq: nodeIdx++ } })
        if (prevNodeId !== null) {
          await engine.upsertEdge(prevNodeId, id, 110, { props: { weight: 0.5 } })
        }
        prevNodeId = id
      })

      const readPromises = Array.from({ length: readers }, () => {
        return new Promise<void>((resolve) => {
          engine.query('MATCH (n) RETURN n.name LIMIT 5')
          resolve()
        })
      })

      await Promise.all([...writePromises, ...readPromises])
      totalOps += writers + readers
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / totalOps
    const opsPerSec = (totalOps / elapsed) * 1000

    console.log(`[BENCH][throughput] mixed r/w+edges (${writers}w+${readers}r) x ${cycles} = ${totalOps} ops`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  // ════════════════════════════════════════════════════════════════
  // 5.  scanAllNodes performance
  // ════════════════════════════════════════════════════════════════

  it('should measure scanAllNodes performance (full scan)', () => {
    const iterations = 10
    const start = performance.now()

    for (let i = 0; i < iterations; i++) {
      const nodes = engine.scanAllNodes()
      expect(nodes.length).toBeGreaterThanOrEqual(0)
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / iterations

    console.log(`[BENCH][throughput] scanAllNodes x${iterations}`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per scan: ${msPerOp.toFixed(3)} ms/scan`)
    console.log(`  Scans/sec: ${(1000 / msPerOp).toFixed(0)}`)
  }, 120000)

  it('should measure scanAllNodes with filtering', () => {
    const iterations = 20
    const start = performance.now()

    for (let i = 0; i < iterations; i++) {
      const allNodes = engine.scanAllNodes()
      const filtered = allNodes.filter((n: any) => n.props?.seq !== undefined)
      expect(filtered.length).toBeGreaterThanOrEqual(0)
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / iterations

    console.log(`[BENCH][throughput] scanAllNodes+filter x${iterations}`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/scan+filter`)
  }, 120000)

  // ════════════════════════════════════════════════════════════════
  // 6.  batchUpsertNodes throughput
  // ════════════════════════════════════════════════════════════════

  it('should measure batchUpsertNodes throughput (batch=100, 1000 nodes)', () => {
    const total = 1000
    const batchSize = 100
    const batches = Math.ceil(total / batchSize)
    const start = performance.now()

    for (let b = 0; b < batches; b++) {
      const inputs: { typeId: number; name: string; opts?: { props?: Record<string, unknown> } }[] = []
      for (let i = 0; i < batchSize; i++) {
        const idx = b * batchSize + i
        if (idx >= total) break
        inputs.push({
          typeId: 20,
          name: `tp-batch100-${idx}`,
          opts: { props: { seq: idx, payload: 'x'.repeat(64) } },
        })
      }
      engine.batchUpsertNodes(inputs)
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / total
    const opsPerSec = (total / elapsed) * 1000

    console.log(`[BENCH][throughput] batchUpsertNodes (batch=100, ${total} nodes)`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  it('should measure batchUpsertNodes throughput (batch=500, 5000 nodes)', () => {
    const total = 5000
    const batchSize = 500
    const batches = Math.ceil(total / batchSize)
    const start = performance.now()

    for (let b = 0; b < batches; b++) {
      const inputs: { typeId: number; name: string; opts?: { props?: Record<string, unknown> } }[] = []
      for (let i = 0; i < batchSize; i++) {
        const idx = b * batchSize + i
        if (idx >= total) break
        inputs.push({
          typeId: 21,
          name: `tp-batch500-${idx}`,
          opts: { props: { seq: idx, payload: 'x'.repeat(64) } },
        })
      }
      engine.batchUpsertNodes(inputs)
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / total
    const opsPerSec = (total / elapsed) * 1000

    console.log(`[BENCH][throughput] batchUpsertNodes (batch=500, ${total} nodes)`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  it('should measure batchUpsertEdges throughput (1000 edges)', () => {
    const srcNodes = engine.scanAllNodes()
    const total = 1000
    const batchSize = 100
    const batches = Math.ceil(total / batchSize)
    const start = performance.now()

    for (let b = 0; b < batches; b++) {
      const inputs: Array<{ src: number; dst: number; typeId: number; opts?: { props?: Record<string, unknown> } }> = []
      for (let i = 0; i < batchSize; i++) {
        const idx = b * batchSize + i
        if (idx >= total || idx + 3 >= srcNodes.length) break
        inputs.push({
          src: srcNodes[idx].id,
          dst: srcNodes[(idx + 3) % srcNodes.length].id,
          typeId: 120,
          opts: { props: { weight: Math.random(), seq: idx } },
        })
      }
      if (inputs.length > 0) {
        engine.batchUpsertEdges(inputs)
      }
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / total
    const opsPerSec = (total / elapsed) * 1000

    console.log(`[BENCH][throughput] batchUpsertEdges (batch=100, ${total} edges)`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  // ════════════════════════════════════════════════════════════════
  // 7.  Query throughput (MATCH, filtered, neighbor)
  // ════════════════════════════════════════════════════════════════

  it('should measure MATCH query throughput (10000 queries)', () => {
    const iterations = 10000
    const start = performance.now()

    for (let i = 0; i < iterations; i++) {
      engine.query('MATCH (n) RETURN n.name LIMIT 10')
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / iterations
    const opsPerSec = (iterations / elapsed) * 1000

    console.log(`[BENCH][throughput] MATCH query x${iterations}`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  it('should measure filtered query throughput (10000 WHERE queries)', () => {
    const iterations = 10000
    const start = performance.now()

    for (let i = 0; i < iterations; i++) {
      engine.query('MATCH (n) WHERE n.seq > 100 RETURN n.name LIMIT 5')
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / iterations
    const opsPerSec = (iterations / elapsed) * 1000

    console.log(`[BENCH][throughput] WHERE query x${iterations}`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  it('should measure batchNeighbors throughput (100 calls)', () => {
    const iterations = 100
    const start = performance.now()

    for (let i = 0; i < iterations; i++) {
      engine.batchNeighbors([i])
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / iterations
    const opsPerSec = (iterations / elapsed) * 1000

    console.log(`[BENCH][throughput] batchNeighbors x${iterations}`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  it('should measure mixed query throughput (MATCH + WHERE + NEIGHBORS)', () => {
    const iterations = 1000
    const start = performance.now()

    for (let i = 0; i < iterations; i++) {
      const op = i % 4
      if (op === 0) engine.query('MATCH (n) RETURN n.name LIMIT 10')
      else if (op === 1) engine.query('MATCH (n) WHERE n.seq > 0 RETURN n.name LIMIT 5')
      else if (op === 2) engine.query('MATCH (n) RETURN n.name, n.seq LIMIT 20')
      else engine.batchNeighbors([0])
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / iterations
    const opsPerSec = (iterations / elapsed) * 1000

    console.log(`[BENCH][throughput] mixed query types x${iterations}`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  // ════════════════════════════════════════════════════════════════
  // 8.  Sequential vs burst write patterns
  // ════════════════════════════════════════════════════════════════

  it('should measure sequential write throughput (2000 sequential upsertNode)', async () => {
    const count = 2000
    const start = performance.now()

    for (let i = 0; i < count; i++) {
      await engine.upsertNode(30, `tp-seq-${i}`, { props: { seq: i } })
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / count
    const opsPerSec = (count / elapsed) * 1000

    console.log(`[BENCH][throughput] sequential writes ${count}`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  it('should measure burst write throughput (500 ops then pause, repeat 4x)', async () => {
    const burstSize = 500
    const repeats = 4
    let nodeIdx = 5000000
    let totalOps = 0

    const start = performance.now()

    for (let r = 0; r < repeats; r++) {
      const promises = Array.from({ length: burstSize }, (_, i) => {
        return engine.upsertNode(31, `tp-burst-${r}-${i}`, { props: { seq: nodeIdx++ } })
      })
      await Promise.all(promises)
      totalOps += burstSize
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / totalOps
    const opsPerSec = (totalOps / elapsed) * 1000

    console.log(`[BENCH][throughput] burst writes (${burstSize}x${repeats}=${totalOps})`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  }, 120000)

  // ════════════════════════════════════════════════════════════════
  // 9.  Async traversal throughput (bfs, shortestPath)
  // ════════════════════════════════════════════════════════════════

  it('should measure bfs traversal throughput (50 bfs calls)', async () => {
    const allNodes = engine.scanAllNodes()
    const targetNodes = allNodes.slice(0, 50).map((n: any) => n.id)
    const iterations = Math.min(50, targetNodes.length)

    const start = performance.now()

    for (let i = 0; i < iterations; i++) {
      const result = await engine.bfs(targetNodes[i])
      expect(result.size).toBeGreaterThanOrEqual(0)
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / iterations

    console.log(`[BENCH][throughput] bfs traversal x${iterations}`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${(1000 / msPerOp).toFixed(0)} ops/sec`)
  }, 120000)

  it('should measure shortestPath throughput (50 path queries)', async () => {
    const allNodes = engine.scanAllNodes()
    const targetPairs = allNodes.slice(0, 100).map((n: any) => n.id)
    const iterations = Math.min(50, Math.floor(targetPairs.length / 2))

    const start = performance.now()

    for (let i = 0; i < iterations; i++) {
      const result = await engine.shortestPath(targetPairs[i * 2], targetPairs[i * 2 + 1])
      expect(result).toBeDefined()
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / iterations

    console.log(`[BENCH][throughput] shortestPath x${iterations}`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${(1000 / msPerOp).toFixed(0)} ops/sec`)
  }, 120000)

  // ════════════════════════════════════════════════════════════════
  // 10.  Batch delete throughput
  // ════════════════════════════════════════════════════════════════

  it('should measure batchDeleteNodes throughput (100 nodes)', async () => {
    // Create nodes to delete
    const ids: number[] = []
    for (let i = 0; i < 100; i++) {
      const id = await engine.upsertNode(40, `tp-delete-${i}`, { props: { seq: i } })
      ids.push(id)
    }

    const start = performance.now()
    const deleted = await engine.batchDeleteNodes(ids)
    const elapsed = performance.now() - start

    console.log(`[BENCH][throughput] batchDeleteNodes 100`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${(elapsed / deleted).toFixed(3)} ms/op`)
    console.log(`  Deleted: ${deleted}`)

    expect(deleted).toBeGreaterThanOrEqual(0)
  }, 120000)
})
  it('should measure upsertNode throughput x10', async () => {
    const engine = new GraphEngine({ path: "/tmp/bench-tp" })
      await engine.open()
    try {
      const start = performance.now()
      for (let i = 0; i < 10; i++) {
        await engine.upsertNode(1, `tp-${i}`, { props: { seq: i } })
      }
      const elapsed = performance.now() - start
      console.log(`[BENCH] upsertNode x10: ${elapsed.toFixed(2)}ms`)
      console.log(`  elapsed=${elapsed.toFixed(3)}ms`); expect(elapsed).toBeGreaterThanOrEqual(0)
    } finally { engine.close() }
  }, 30000)

  it('should measure upsertNode throughput x50', async () => {
    const engine = new GraphEngine({ path: "/tmp/bench-tp" })
      await engine.open()
    try {
      const start = performance.now()
      for (let i = 0; i < 50; i++) {
        await engine.upsertNode(1, `tp-${i}`, { props: { seq: i } })
      }
      const elapsed = performance.now() - start
      console.log(`[BENCH] upsertNode x50: ${elapsed.toFixed(2)}ms`)
      console.log(`  elapsed=${elapsed.toFixed(3)}ms`); expect(elapsed).toBeGreaterThanOrEqual(0)
    } finally { engine.close() }
  }, 30000)

  it('should measure upsertNode throughput x100', async () => {
    const engine = new GraphEngine({ path: "/tmp/bench-tp" })
      await engine.open()
    try {
      const start = performance.now()
      for (let i = 0; i < 100; i++) {
        await engine.upsertNode(1, `tp-${i}`, { props: { seq: i } })
      }
      const elapsed = performance.now() - start
      console.log(`[BENCH] upsertNode x100: ${elapsed.toFixed(2)}ms`)
      console.log(`  elapsed=${elapsed.toFixed(3)}ms`); expect(elapsed).toBeGreaterThanOrEqual(0)
    } finally { engine.close() }
  }, 30000)

  it('should measure upsertEdge throughput x30', async () => {
    const engine = new GraphEngine({ path: "/tmp/bench-tp" })
      await engine.open()
    try {
      const src = await engine.upsertNode(1, 'esrc', { props: {} })
      const dst = await engine.upsertNode(1, 'edst', { props: {} })
      const start = performance.now()
      for (let i = 0; i < 30; i++) {
        await engine.upsertEdge(src, dst, i, { props: {} })
      }
      const elapsed = performance.now() - start
      console.log(`[BENCH] upsertEdge x30: ${elapsed.toFixed(2)}ms`)
      console.log(`  elapsed=${elapsed.toFixed(3)}ms`); expect(elapsed).toBeGreaterThanOrEqual(0)
    } finally { engine.close() }
  }, 30000)

  it('should measure getNode throughput x100', async () => {
    const engine = new GraphEngine({ path: "/tmp/bench-tp" })
      await engine.open()
    try {
      const ids: number[] = []
      for (let i = 0; i < 10; i++) {
        ids.push(await engine.upsertNode(1, `tp-${i}`, { props: {} }))
      }
      const start = performance.now()
      for (let i = 0; i < 100; i++) {
        engine.getNode(ids[i % 10])
      }
      const elapsed = performance.now() - start
      console.log(`[BENCH] getNode x100: ${elapsed.toFixed(2)}ms`)
      console.log(`  elapsed=${elapsed.toFixed(3)}ms`); expect(elapsed).toBeGreaterThanOrEqual(0)
    } finally { engine.close() }
  }, 30000)

  it('should measure scanAllNodes throughput with 100 nodes', async () => {
    const engine = new GraphEngine({ path: "/tmp/bench-tp" })
      await engine.open()
    try {
      for (let i = 0; i < 100; i++) {
        await engine.upsertNode(1, `tp-${i}`, { props: { seq: i } })
      }
      const start = performance.now()
      const nodes = engine.scanAllNodes()
      const elapsed = performance.now() - start
      console.log(`[BENCH] scanAllNodes 100: ${elapsed.toFixed(2)}ms count=${nodes.length}`)
      expect(nodes.length).toBe(100)
    } finally { engine.close() }
  }, 30000)

  it.skip('should measure neighbors throughput with 50 edges', async () => {
    const engine = new GraphEngine({ path: "/tmp/bench-tp" })
      await engine.open()
    try {
      const src = await engine.upsertNode(1, 'nbsrc', { props: {} })
      for (let i = 0; i < 50; i++) {
        const dst = await engine.upsertNode(1, `nbdst${i}`, { props: {} })
        await engine.upsertEdge(src, dst, 1, { props: {} })
      }
      const start = performance.now()
      const nbs = engine.neighbors(src)
      const elapsed = performance.now() - start
      console.log(`[BENCH] neighbors 50: ${elapsed.toFixed(2)}ms count=${nbs.length}`)
      expect(nbs.length).toBe(50)
    } finally { engine.close() }
  }, 30000)

  it('should measure deleteNode throughput x50', async () => {
    const engine = new GraphEngine({ path: "/tmp/bench-tp" })
      await engine.open()
    try {
      const ids: number[] = []
      for (let i = 0; i < 50; i++) {
        ids.push(await engine.upsertNode(1, `tp-${i}`, { props: {} }))
      }
      const start = performance.now()
      for (const id of ids) {
        engine.deleteNode(id)
      }
      const elapsed = performance.now() - start
      console.log(`[BENCH] deleteNode x50: ${elapsed.toFixed(2)}ms`)
      console.log(`  elapsed=${elapsed.toFixed(3)}ms`); expect(elapsed).toBeGreaterThanOrEqual(0)
    } finally { engine.close() }
  }, 30000)
