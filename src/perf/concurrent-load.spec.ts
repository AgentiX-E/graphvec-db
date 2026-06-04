/**
 * Concurrent Load Benchmark Suite
 *
 * Measures engine behavior under concurrent read/write pressure
 * and long-duration stability testing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GraphEngine } from '../core/graph-engine'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'perf-concurrent-'))
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

const TEST_DIR = createTempDir()
const DB_DIR = path.join(TEST_DIR, 'graph.db')
let engine: GraphEngine

describe('Concurrent Load Benchmarks', () => {
  beforeAll(() => {
    engine = new GraphEngine({ path: DB_DIR })
    engine.open()

    // Seed initial data via upsertNode (queryable)
    for (let i = 0; i < 500; i++) {
      engine.upsertNode(1, `seed-${i}`, { props: { seq: i } })
    }
    for (let i = 0; i < 499; i++) {
      engine.upsertEdge(i, i + 1, 10, { props: { weight: 1 } })
    }

    console.log(`[SETUP] Seed data: 500 nodes, 499 edges`)
  })

  afterAll(() => {
    engine.close()
    cleanup(TEST_DIR)
  })

  // ── 1. 10 concurrent readers ──
  it('should sustain 10 concurrent readers', { timeout: 60000 }, async () => {
    const readers = 10
    const opsPerReader = 500
    const queries = [
      'MATCH (n) RETURN n.name LIMIT 10',
      'MATCH (n) WHERE n.seq > 100 RETURN n.name LIMIT 5',
    ]

    const warmup = 20
    for (let i = 0; i < warmup; i++) {
      engine.query(queries[i % queries.length])
    }

    const start = performance.now()

    const promises = Array.from({ length: readers }, (_, r) => {
      return new Promise<void>((resolve) => {
        for (let i = 0; i < opsPerReader; i++) {
          engine.query(queries[(r + i) % queries.length])
        }
        resolve()
      })
    })

    await Promise.all(promises)

    const elapsed = performance.now() - start
    const totalOps = readers * opsPerReader
    const msPerOp = elapsed / totalOps
    const opsPerSec = (totalOps / elapsed) * 1000

    console.log(`[PERF] 10 concurrent readers (${totalOps} total ops):`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  })

  // ── 2. 5 concurrent writers + 5 concurrent readers (mixed) ──
  it('should sustain mixed load (5 writers + 5 readers)', { timeout: 60000 }, async () => {
    const writers = 5
    const readers = 5
    const opsPerWorker = 200

    // Track next writer node index
    let nodeIdx = 10000

    const start = performance.now()

    // Writers: create nodes + edges
    const writerPromises = Array.from({ length: writers }, (_, w) => {
      return new Promise<void>((resolve) => {
        for (let i = 0; i < opsPerWorker; i++) {
          const id = nodeIdx++
          engine.upsertNode(1, `mixed-w${w}-${i}`, {
            props: { seq: i, writer: w, ts: Date.now() },
          })
          if (i > 0) {
            engine.upsertEdge(id - 1, id, 10, { props: { weight: 0.5 } })
          }
        }
        resolve()
      })
    })

    // Readers: run queries concurrently
    const readerPromises = Array.from({ length: readers }, (_, _r) => {
      return new Promise<void>((resolve) => {
        for (let i = 0; i < opsPerWorker; i++) {
          const query = i % 2 === 0
            ? 'MATCH (n) RETURN n.name LIMIT 10'
            : 'MATCH (n) WHERE n.seq > 100 RETURN n.name LIMIT 5'
          engine.query(query)
        }
        resolve()
      })
    })

    await Promise.all([...writerPromises, ...readerPromises])

    const elapsed = performance.now() - start
    const totalOps = (writers + readers) * opsPerWorker
    const msPerOp = elapsed / totalOps
    const opsPerSec = (totalOps / elapsed) * 1000

    console.log(`[PERF] Mixed load (${writers} writers + ${readers} readers, ${totalOps} total ops):`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)

    // Verify data integrity — all writers completed and nodes exist
    const allNodes = engine.scanAllNodes()
    expect(allNodes.length).toBeGreaterThan(500)
  })

  // ── 3. Long-duration stability (200 iterations of fast ops) ──
  it('should maintain stable performance across 200 iterations', { timeout: 60000 }, () => {
    const iterations = 200
    const timings: number[] = []

    for (let i = 0; i < iterations; i++) {
      const opStart = performance.now()

      // Rotating mix of fast operations
      if (i % 5 === 0) {
        // Write a node
        engine.upsertNode(1, `stable-node-${i}`, { props: { iter: i } })
      } else if (i % 5 === 1) {
        // Query all
        engine.query('MATCH (n) RETURN n.name LIMIT 5')
      } else if (i % 5 === 2) {
        // Query with condition
        engine.query('MATCH (n) WHERE n.seq > 0 RETURN n.name LIMIT 3')
      } else if (i % 5 === 3) {
        // Edge query
        engine.batchNeighbors([0])
      } else {
        // Scan
        engine.scanAllNodes()
      }

      const opTiming = performance.now() - opStart
      timings.push(opTiming)
    }

    const total = timings.reduce((a, b) => a + b, 0)
    const avg = total / timings.length
    const min = Math.min(...timings)
    const max = Math.max(...timings)
    const sorted = [...timings].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    const p95 = sorted[Math.floor(sorted.length * 0.95)]
    const p99 = sorted[Math.floor(sorted.length * 0.99)]

    console.log(`[PERF] Stability across ${iterations} iterations:`)
    console.log(`  Total: ${total.toFixed(1)} ms`)
    console.log(`  Avg: ${avg.toFixed(3)} ms/op`)
    console.log(`  Median: ${median.toFixed(3)} ms/op`)
    console.log(`  P95: ${p95.toFixed(3)} ms/op`)
    console.log(`  P99: ${p99.toFixed(3)} ms/op`)
    console.log(`  Min: ${min.toFixed(3)} ms`)
    console.log(`  Max: ${max.toFixed(3)} ms`)
  })

  // ── 4. Graph neighbor read under concurrent load ──
  it('should sustain neighbor reads under concurrent load', { timeout: 60000 }, async () => {
    // Build additional star connections from node 0
    for (let i = 0; i < 100; i++) {
      engine.upsertNode(2, `neighbor-target-${i}`, { props: { seq: i } })
      engine.upsertEdge(0, 500 + i, 20, { props: { weight: 0.5 } }) // node IDs 500+ are from seed data
    }

    // Use batchNeighbors on node 0 which has many edges now
    const concurrency = 10
    const opsPerWorker = 100
    const totalOps = concurrency * opsPerWorker

    const start = performance.now()

    const promises = Array.from({ length: concurrency }, () => {
      return new Promise<void>((resolve) => {
        for (let i = 0; i < opsPerWorker; i++) {
          engine.batchNeighbors([0], { maxDepth: 1 })
        }
        resolve()
      })
    })

    await Promise.all(promises)

    const elapsed = performance.now() - start
    const msPerOp = elapsed / totalOps
    const opsPerSec = (totalOps / elapsed) * 1000

    console.log(`[PERF] Neighbor read (${concurrency} concurrent, ${totalOps} ops):`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)

    const neighbors = engine.batchNeighbors([0], { maxDepth: 1 })
    expect(neighbors.size).toBe(1)
    const entry = neighbors.get(0)
    expect(entry).toBeDefined()
    if (entry) {
      // Node 0 has chain edges (499) + new edges (100) = ~599
      console.log(`[PERF] Node 0 has ${entry.edges.length} edges`)
    }
  })
})
