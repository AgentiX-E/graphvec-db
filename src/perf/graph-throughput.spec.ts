/**
 * Graph Throughput Benchmark Suite
 *
 * Measures write/read throughput under various load patterns.
 * Uses single upsertNode/upsertEdge to ensure queryable results
 * (batchUpsertNodes bypasses label index in current engine).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GraphEngine } from '../core/graph-engine'
import type { UpsertNodeOptions } from '../types'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'perf-throughput-'))
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

const TEST_DIR = createTempDir()
const DB_DIR = path.join(TEST_DIR, 'graph.db')
let engine: GraphEngine

describe('Graph Throughput Benchmarks', () => {
  beforeAll(() => {
    engine = new GraphEngine({ path: DB_DIR })
    engine.open()
  })

  afterAll(() => {
    engine.close()
    cleanup(TEST_DIR)
  })

  // ── 1. Single-node write throughput ──
  it('should measure single-node write throughput (1000 nodes)', { timeout: 60000 }, () => {
    const count = 1000
    const start = performance.now()

    for (let i = 0; i < count; i++) {
      engine.upsertNode(1, `single-node-${i}`, { props: { seq: i, payload: 'x'.repeat(64) } })
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / count
    const opsPerSec = (count / elapsed) * 1000

    console.log(`[PERF] Single-node write throughput (${count} nodes):`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
    console.log(`  Resulting node count: ${engine.scanAllNodes().length}`)

    // Sanity check: at least some nodes were created
    expect(engine.scanAllNodes().length).toBeGreaterThanOrEqual(count)
  })

  // ── 2. Batch write throughput (batchSize=100, via batchUpsertNodes) ──
  it('should measure batch write throughput (batchSize=100, 1000 nodes)', { timeout: 60000 }, () => {
    const total = 1000
    const batchSize = 100
    const batches = Math.ceil(total / batchSize)
    const start = performance.now()

    for (let b = 0; b < batches; b++) {
      const inputs: { typeId: number; name: string; opts?: UpsertNodeOptions }[] = []
      for (let i = 0; i < batchSize; i++) {
        const idx = b * batchSize + i
        if (idx >= total) break
        inputs.push({
          typeId: 2,
          name: `batch100-node-${idx}`,
          opts: { props: { seq: idx, payload: 'x'.repeat(64) } },
        })
      }
      engine.batchUpsertNodes(inputs)
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / total
    const opsPerSec = (total / elapsed) * 1000

    console.log(`[PERF] Batch write throughput (batchSize=100, ${total} nodes):`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  })

  // ── 3. Batch write throughput (batchSize=500, via batchUpsertNodes) ──
  it('should measure batch write throughput (batchSize=500, 1000 nodes)', { timeout: 60000 }, () => {
    const total = 1000
    const batchSize = 500
    const batches = Math.ceil(total / batchSize)
    const start = performance.now()

    for (let b = 0; b < batches; b++) {
      const inputs: { typeId: number; name: string; opts?: UpsertNodeOptions }[] = []
      for (let i = 0; i < batchSize; i++) {
        const idx = b * batchSize + i
        if (idx >= total) break
        inputs.push({
          typeId: 3,
          name: `batch500-node-${idx}`,
          opts: { props: { seq: idx, payload: 'x'.repeat(64) } },
        })
      }
      engine.batchUpsertNodes(inputs)
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / total
    const opsPerSec = (total / elapsed) * 1000

    console.log(`[PERF] Batch write throughput (batchSize=500, ${total} nodes):`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  })

  // ── 4. Edge write throughput (1000 edges) ──
  it('should measure edge write throughput (1000 edges)', { timeout: 60000 }, () => {
    // First ensure we have enough nodes via upsertNode for queryability
    for (let i = 0; i < 2001; i++) {
      engine.upsertNode(4, `edge-src-${i}`, { props: { seq: i } })
    }

    // Scan to get real IDs
    const allNodes = engine.scanAllNodes()
    const sourceNodes = allNodes.filter((n: any) => n.name && n.name.startsWith('edge-src-'))
    const count = 1000
    const start = performance.now()

    for (let i = 0; i < count && i < sourceNodes.length - 1000; i++) {
      engine.upsertEdge(sourceNodes[i].id, sourceNodes[i + 1000].id, 10, { props: { weight: Math.random() } })
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / count
    const opsPerSec = (count / elapsed) * 1000

    console.log(`[PERF] Edge write throughput (${count} edges):`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  })

  // ── 5. Concurrent write throughput (10 writers) ──
  it('should measure concurrent write throughput (10 concurrent writes)', { timeout: 60000 }, async () => {
    const writers = 10
    const opsPerWriter = 100
    const total = writers * opsPerWriter

    const start = performance.now()

    const promises = Array.from({ length: writers }, (_, w) => {
      return new Promise<void>((resolve) => {
        for (let i = 0; i < opsPerWriter; i++) {
          const idx = w * opsPerWriter + i
          engine.upsertNode(5, `concurrent-${idx}`, { props: { seq: idx, writer: w } })
        }
        resolve()
      })
    })

    await Promise.all(promises)

    const elapsed = performance.now() - start
    const msPerOp = elapsed / total
    const opsPerSec = (total / elapsed) * 1000

    console.log(`[PERF] Concurrent write throughput (${writers} writers x ${opsPerWriter} ops = ${total} total):`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  })

  // ── 6. Simple read query throughput (10k MATCH reads) ──
  it('should measure simple read query throughput (10k MATCH reads)', { timeout: 60000 }, () => {
    // Ensure we have queryable data
    for (let i = 0; i < 500; i++) {
      engine.upsertNode(6, `read-target-${i}`, { props: { value: i, tag: 'read-bench' } })
    }

    const iterations = 10000
    const start = performance.now()

    for (let i = 0; i < iterations; i++) {
      engine.query('MATCH (n) RETURN n.name LIMIT 10')
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / iterations
    const opsPerSec = (iterations / elapsed) * 1000

    console.log(`[PERF] Simple read query throughput (${iterations} MATCH reads):`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)

    // Verify query returns consistent results
    const result = engine.query('MATCH (n) RETURN n.name LIMIT 10')
    expect(result.length).toBeGreaterThan(0)
    expect(result.length).toBeLessThanOrEqual(10)
  })

  // ── 7. Filtered query throughput ──
  it('should measure filtered query throughput (10k WHERE queries)', { timeout: 60000 }, () => {
    const iterations = 10000
    const start = performance.now()

    for (let i = 0; i < iterations; i++) {
      engine.query('MATCH (n) WHERE n.tag = "read-bench" RETURN n.name LIMIT 5')
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / iterations
    const opsPerSec = (iterations / elapsed) * 1000

    console.log(`[PERF] Filtered query throughput (${iterations} WHERE queries):`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  })

  // ── 8. BatchNeighbors throughput ──
  it('should measure batchNeighbors throughput', { timeout: 60000 }, () => {
    const iterations = 100
    const start = performance.now()

    for (let i = 0; i < iterations; i++) {
      engine.batchNeighbors([i])
    }

    const elapsed = performance.now() - start
    const msPerOp = elapsed / iterations
    const opsPerSec = (iterations / elapsed) * 1000

    console.log(`[PERF] batchNeighbors throughput (${iterations} calls):`)
    console.log(`  Total: ${elapsed.toFixed(1)} ms`)
    console.log(`  Per op: ${msPerOp.toFixed(3)} ms/op`)
    console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`)
  })
})
