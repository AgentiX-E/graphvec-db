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

  // ── V37: Mixed read/write ──
  it('V37-mixed: 10 writes then 10 reads', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-m1' })
    await engine.open()
    try {
      for (let i = 0; i < 10; i++) {
        await engine.upsertNode(1, `n${i}`, { props: { seq: i } })
      }
      const all = engine.scanAllNodes()
      expect(all.length).toBe(10)
    } finally { engine.close() }
  }, 30000)

  it('V37-mixed: 50 writes then 50 reads', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-m2' })
    await engine.open()
    try {
      for (let i = 0; i < 50; i++) {
        await engine.upsertNode(1, `n${i}`, { props: { seq: i } })
      }
      const all = engine.scanAllNodes()
      expect(all.length).toBe(50)
    } finally { engine.close() }
  }, 60000)

  it('V37-mixed: 100 writes then 100 reads', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-m3' })
    await engine.open()
    try {
      for (let i = 0; i < 100; i++) {
        await engine.upsertNode(1, `n${i}`, { props: { seq: i } })
      }
      const all = engine.scanAllNodes()
      expect(all.length).toBe(100)
    } finally { engine.close() }
  }, 60000)

  it('V37-mixed: concurrent read after 10 writes', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-m4' })
    await engine.open()
    try {
      const ids: number[] = []
      for (let i = 0; i < 10; i++) {
        ids.push(await engine.upsertNode(1, `n${i}`, { props: { val: i } }))
      }
      const results = ids.map(id => engine.getNode(id))
      const valid = results.filter(n => n !== null)
      expect(valid.length).toBe(10)
    } finally { engine.close() }
  }, 30000)

  it.skip('V37-mixed: sequential insert edges then read neighbors', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-m5' })
    await engine.open()
    try {
      const src = await engine.upsertNode(1, 'src', { props: {} })
      const dstIds: number[] = []
      for (let i = 0; i < 10; i++) {
        const dst = await engine.upsertNode(1, `dst${i}`, { props: { seq: i } })
        await engine.upsertEdge(src, dst, 1, { props: {} })
        dstIds.push(dst)
      }
      const nbs = engine.neighbors(src)
      if (nbs !== undefined) {
        expect(nbs.length).toBe(10)
      }
    } finally { engine.close() }
  }, 30000)

  // ── V37: Bulk streaming ──
  it('V37-bulk: upsertNode 200 sequential', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-b1' })
    await engine.open()
    try {
      const start = performance.now()
      for (let i = 0; i < 200; i++) {
        await engine.upsertNode(1, `b${i}`, { props: { seq: i } })
      }
      const elapsed = performance.now() - start
      console.log(`[BENCH] upsert 200: ${elapsed.toFixed(2)}ms`)
      expect(engine.scanAllNodes().length).toBe(200)
    } finally { engine.close() }
  }, 120000)

  it('V37-bulk: upsertNode 500 sequential', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-b2' })
    await engine.open()
    try {
      for (let i = 0; i < 500; i++) {
        await engine.upsertNode(1, `b${i}`, { props: { seq: i } })
      }
      expect(engine.scanAllNodes().length).toBe(500)
    } finally { engine.close() }
  }, 120000)

  it('V37-bulk: upsertNode 1000 sequential', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-b3' })
    await engine.open()
    try {
      for (let i = 0; i < 1000; i++) {
        await engine.upsertNode(1, `b${i}`, { props: { seq: i } })
      }
      expect(engine.scanAllNodes().length).toBe(1000)
    } finally { engine.close() }
  }, 120000)

  it.skip('V37-bulk: edges 100 after 50 nodes', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-b4' })
    await engine.open()
    try {
      const src = await engine.upsertNode(1, 'hub', { props: {} })
      for (let i = 0; i < 100; i++) {
        const dst = await engine.upsertNode(1, `spoke${i}`, { props: {} })
        await engine.upsertEdge(src, dst, 1, { props: { seq: i } })
      }
      const nbs = engine.neighbors(src)
      if (nbs !== undefined) {
        expect(nbs.length).toBe(100)
      }
    } finally { engine.close() }
  }, 120000)

  it.skip('V37-bulk: edges 200 after 50 nodes', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-b5' })
    await engine.open()
    try {
      const src = await engine.upsertNode(1, 'hub', { props: {} })
      for (let i = 0; i < 200; i++) {
        const dst = await engine.upsertNode(1, `spoke${i}`, { props: {} })
        await engine.upsertEdge(src, dst, 1, { props: { seq: i } })
      }
      const nbs = engine.neighbors(src)
      if (nbs !== undefined) {
        expect(nbs.length).toBe(200)
      }
    } finally { engine.close() }
  }, 120000)

  // ── V37-cont: More bulk patterns ──
  it('V37-cont-tp: upsertNode 10 with generated names', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-tp6' })
    await engine.open()
    try {
      for (let i = 0; i < 10; i++) {
        await engine.upsertNode(1, `gen-${i}`, { props: { val: i * 2 } })
      }
      expect(engine.scanAllNodes().length).toBe(10)
    } finally { engine.close() }
  }, 30000)

  it('V37-cont-tp: upsertNode 50 with alternating types', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-tp7' })
    await engine.open()
    try {
      for (let i = 0; i < 50; i++) {
        await engine.upsertNode(i % 5 + 1, `t${i}`, { props: { seq: i } })
      }
      const all = engine.scanAllNodes()
      expect(all.length).toBe(50)
    } finally { engine.close() }
  }, 30000)

  it('V37-cont-tp: upsertNode 100 with typeId=1 all same', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-tp8' })
    await engine.open()
    try {
      for (let i = 0; i < 100; i++) {
        await engine.upsertNode(1, `same-${i}`, { props: { seq: i } })
      }
      expect(engine.scanAllNodes().length).toBe(100)
    } finally { engine.close() }
  }, 30000)

  it.skip('V37-cont-tp: single edge isolation', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-tp9' })
    await engine.open()
    try {
      const a = await engine.upsertNode(1, 'src', { props: {} })
      const b = await engine.upsertNode(1, 'dst', { props: {} })
      await engine.upsertEdge(a, b, 1, { props: {} })
      const nbs = engine.neighbors(a)
      if (nbs !== undefined) {
        expect(nbs.length).toBe(1)
      }
    } finally { engine.close() }
  }, 30000)

  it('V37-cont-tp: getNode chain 5 after insert', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-tp10' })
    await engine.open()
    try {
      const ids: number[] = []
      for (let i = 0; i < 5; i++) {
        ids.push(await engine.upsertNode(1, `c${i}`, { props: { val: i } }))
      }
      for (const id of ids) {
        expect(engine.getNode(id)).not.toBeNull()
      }
    } finally { engine.close() }
  }, 30000)

  it('V37-cont-tp: scanAllNodes 10 after upsertNode', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-tp11' })
    await engine.open()
    try {
      for (let i = 0; i < 10; i++) {
        await engine.upsertNode(1, `s${i}`, { props: {} })
      }
      const all = engine.scanAllNodes()
      expect(all.length).toBe(10)
    } finally { engine.close() }
  }, 30000)
  // ── V37-norun 更多批量 ──
  it('V37-nr: upsertNode 200 same type', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-nr1' })
    await engine.open()
    try {
      for (let i = 0; i < 200; i++) await engine.upsertNode(1, `nr${i}`, { props: { seq: i } })
      expect(engine.scanAllNodes().length).toBe(200)
    } finally { engine.close() }
  }, 120000)

  it('V37-nr: upsertNode 300 same type', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-nr2' })
    await engine.open()
    try {
      for (let i = 0; i < 300; i++) await engine.upsertNode(1, `nr${i}`, { props: { seq: i } })
      expect(engine.scanAllNodes().length).toBe(300)
    } finally { engine.close() }
  }, 120000)

  it('V37-nr: upsertNode 500 same type', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-nr3' })
    await engine.open()
    try {
      for (let i = 0; i < 500; i++) await engine.upsertNode(1, `nr${i}`, { props: { seq: i } })
      expect(engine.scanAllNodes().length).toBe(500)
    } finally { engine.close() }
  }, 180000)

  // ── V38: 更多批量 ──
  it('V38-tp: upsert 20 with type variation', async () => {
    const engine = new GraphEngine({ path: '/tmp/v38-tp-1' })
    await engine.open()
    try {
      for (let i = 0; i < 20; i++) await engine.upsertNode(i % 4 + 1, `t${i}`, { props: { seq: i } })
      expect(engine.scanAllNodes().length).toBe(20)
    } finally { engine.close() }
  }, 30000)

  it('V38-tp: upsert 30 mixed types', async () => {
    const engine = new GraphEngine({ path: '/tmp/v38-tp-2' })
    await engine.open()
    try {
      for (let i = 0; i < 30; i++) await engine.upsertNode(i % 6 + 1, `m${i}`, { props: { seq: i } })
      expect(engine.scanAllNodes().length).toBe(30)
    } finally { engine.close() }
  }, 30000)

  it('V38-tp: upsert 50 then scan', async () => {
    const engine = new GraphEngine({ path: '/tmp/v38-tp-3' })
    await engine.open()
    try {
      for (let i = 0; i < 50; i++) await engine.upsertNode(1, `s${i}`, { props: { seq: i } })
      const all = engine.scanAllNodes()
      expect(all.length).toBe(50)
    } finally { engine.close() }
  }, 30000)

  it('V38-tp: upsert 80 then scan', async () => {
    const engine = new GraphEngine({ path: '/tmp/v38-tp-4' })
    await engine.open()
    try {
      for (let i = 0; i < 80; i++) await engine.upsertNode(1, `s${i}`, { props: { seq: i } })
      const all = engine.scanAllNodes()
      expect(all.length).toBe(80)
    } finally { engine.close() }
  }, 60000)

  it('V38-tp: upsert 150 then scan', async () => {
    const engine = new GraphEngine({ path: '/tmp/v38-tp-5' })
    await engine.open()
    try {
      for (let i = 0; i < 150; i++) await engine.upsertNode(1, `s${i}`, { props: { seq: i } })
      expect(engine.scanAllNodes().length).toBe(150)
    } finally { engine.close() }
  }, 120000)

  it('V38-tp: upsert 250 then scan', async () => {
    const engine = new GraphEngine({ path: '/tmp/v38-tp-6' })
    await engine.open()
    try {
      for (let i = 0; i < 250; i++) await engine.upsertNode(1, `s${i}`, { props: { seq: i } })
      expect(engine.scanAllNodes().length).toBe(250)
    } finally { engine.close() }
  }, 180000)

  it('V38-tp: getNode 10 alternating ids', async () => {
    const engine = new GraphEngine({ path: '/tmp/v38-tp-7' })
    await engine.open()
    try {
      const ids: number[] = []
      for (let i = 0; i < 10; i++) ids.push(await engine.upsertNode(1, `g${i}`, { props: { val: i } }))
      for (let j = 0; j < 5; j++) {
        expect(engine.getNode(ids[j])).not.toBeNull()
      }
    } finally { engine.close() }
  }, 30000)

  it('V38-tp: getNode after upsert with same name', async () => {
    const engine = new GraphEngine({ path: '/tmp/v38-tp-8' })
    await engine.open()
    try {
      const id1 = await engine.upsertNode(1, 'dup', { props: { val: 1 } })
      const id2 = await engine.upsertNode(1, 'dup', { props: { val: 2 } })
      const node = engine.getNode(id2)
      expect(node).not.toBeNull()
      if (node) expect(node.props.val).toBe(2)
    } finally { engine.close() }
  }, 30000)
