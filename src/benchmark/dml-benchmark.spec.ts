/**
 * dml-benchmark.spec.ts — DML Execution Path Performance Benchmark
 *
 * Measures CREATE / SET / DELETE / MERGE throughput through the full engine.
 * Uses a SINGLE shared GraphEngine per test block.
 *
 * Run: npx vitest run src/benchmark/dml-benchmark.spec.ts --no-coverage
 */

import { describe, it, expect, beforeAll } from 'vitest'

function benchmark(label: string, fn: () => Promise<void>, iterations = 1000): Promise<string> {
  return (async () => {
    const start = performance.now()
    await fn()
    const elapsed = performance.now() - start
    const ops = Math.round(iterations / (elapsed / 1000)).toLocaleString()
    return `  ${label.padEnd(48)} ${ops} ops/s  (${iterations}x in ${elapsed.toFixed(1)}ms)`
  })()
}

let GraphEngine: any
beforeAll(async () => {
  const mod = await import('../core/graph-engine')
  GraphEngine = mod.GraphEngine
})

const TMP = `/tmp/dml-bench-${process.pid}`

function createEngine(): any {
  const ge = new GraphEngine({ path: TMP, persistIndexes: false })
  ge.open()
  return ge
}

describe('DML Benchmark', () => {
  const R = 200
  const R_META = 100
  const R_SCAN = 500

  it('warmup', async () => {
    const ge = createEngine()
    await ge.upsertNode(1, 'warm', { props: { name: 'warm' } })
    ge.close()
  })

  it('summary', async () => {
    const lines: string[] = []

    // CREATE 1 node
    {
      const ge = createEngine()
      const start = performance.now()
      for (let i = 0; i < R; i++) {
        await ge.upsertNode(1, `c1-${i}`, { props: { name: `Node${i}`, seq: i } })
      }
      const elapsed = performance.now() - start
      const ops = Math.round(R / (elapsed / 1000)).toLocaleString()
      lines.push(`  ${"CREATE 1 node".padEnd(48)} ${ops} ops/s  (${R}x in ${elapsed.toFixed(1)}ms)`)
      ge.close()
    }

    // CREATE with props
    {
      const ge = createEngine()
      const start = performance.now()
      for (let i = 0; i < R; i++) {
        await ge.upsertNode(1, `cp-${i}`, {
          props: { name: `Node${i}`, age: 30, city: 'NYC', email: 'a@b.com', score: 95.5, tags: ['a', 'b'], active: true }
        })
      }
      const elapsed = performance.now() - start
      const ops = Math.round(R / (elapsed / 1000)).toLocaleString()
      lines.push(`  ${"CREATE with props".padEnd(48)} ${ops} ops/s  (${R}x in ${elapsed.toFixed(1)}ms)`)
      ge.close()
    }

    // CREATE with vector
    {
      const ge = createEngine()
      const vec = new Float32Array(128)
      for (let i = 0; i < 128; i++) vec[i] = Math.random()
      const start = performance.now()
      for (let i = 0; i < R_META; i++) {
        await ge.upsertNode(1, `vec-${i}`, { props: { name: `Vec${i}` }, vector: vec })
      }
      const elapsed = performance.now() - start
      const ops = Math.round(R_META / (elapsed / 1000)).toLocaleString()
      lines.push(`  ${"CREATE with vector".padEnd(48)} ${ops} ops/s  (${R_META}x in ${elapsed.toFixed(1)}ms)`)
      ge.close()
    }

    // CREATE edge
    {
      const ge = createEngine()
      const src = await ge.upsertNode(1, 'edge-src', { props: { name: 'src' } })
      const dst = await ge.upsertNode(1, 'edge-dst', { props: { name: 'dst' } })
      const start = performance.now()
      for (let i = 0; i < R; i++) {
        await ge.upsertEdge(src, dst, 1, {})
      }
      const elapsed = performance.now() - start
      const ops = Math.round(R / (elapsed / 1000)).toLocaleString()
      lines.push(`  ${"CREATE edge".padEnd(48)} ${ops} ops/s  (${R}x in ${elapsed.toFixed(1)}ms)`)
      ge.close()
    }

    // CREATE edge with props
    {
      const ge = createEngine()
      const src = await ge.upsertNode(1, 'ep-src', { props: { name: 'src' } })
      const dst = await ge.upsertNode(1, 'ep-dst', { props: { name: 'dst' } })
      const start = performance.now()
      for (let i = 0; i < R; i++) {
        await ge.upsertEdge(src, dst, 1, { props: { weight: Math.random(), since: 2024, label: 'friend' } })
      }
      const elapsed = performance.now() - start
      const ops = Math.round(R / (elapsed / 1000)).toLocaleString()
      lines.push(`  ${"CREATE edge with props".padEnd(48)} ${ops} ops/s  (${R}x in ${elapsed.toFixed(1)}ms)`)
      ge.close()
    }

    // SET (upsert)
    {
      const ge = createEngine()
      await ge.upsertNode(1, 'set-node', { props: { name: 'original', count: 0 } })
      const start = performance.now()
      for (let i = 0; i < R; i++) {
        await ge.upsertNode(1, 'set-node', { props: { name: 'original', count: i } })
      }
      const elapsed = performance.now() - start
      const ops = Math.round(R / (elapsed / 1000)).toLocaleString()
      lines.push(`  ${"SET node property".padEnd(48)} ${ops} ops/s  (${R}x in ${elapsed.toFixed(1)}ms)`)
      ge.close()
    }

    // DELETE
    {
      const ge = createEngine()
      const ids: number[] = []
      for (let i = 0; i < R_META; i++) {
        const id = await ge.upsertNode(1, `del-${i}`, { props: { seq: i } })
        ids.push(id)
      }
      const start = performance.now()
      for (const id of ids) {
        await ge.deleteNode(id)
      }
      const elapsed = performance.now() - start
      const ops = Math.round(R_META / (elapsed / 1000)).toLocaleString()
      lines.push(`  ${"DELETE node".padEnd(48)} ${ops} ops/s  (${R_META}x in ${elapsed.toFixed(1)}ms)`)
      ge.close()
    }

    // scan 100
    {
      const ge = createEngine()
      for (let i = 0; i < 100; i++) {
        await ge.upsertNode(1, `scan-${i}`, { props: { seq: i } })
      }
      const start = performance.now()
      for (let i = 0; i < R_SCAN; i++) ge.scanAllNodes()
      const elapsed = performance.now() - start
      const ops = Math.round(R_SCAN / (elapsed / 1000)).toLocaleString()
      lines.push(`  ${"scanAllNodes (100 nodes)".padEnd(48)} ${ops} ops/s  (${R_SCAN}x in ${elapsed.toFixed(1)}ms)`)
      ge.close()
    }

    // scan 1000
    {
      const ge = createEngine()
      for (let i = 0; i < 1000; i++) {
        await ge.upsertNode(1, `scan1k-${i}`, { props: { seq: i } })
      }
      const start = performance.now()
      for (let i = 0; i < R_SCAN / 5; i++) ge.scanAllNodes()
      const elapsed = performance.now() - start
      const ops = Math.round(R_SCAN / 5 / (elapsed / 1000)).toLocaleString()
      lines.push(`  ${"scanAllNodes (1000 nodes)".padEnd(48)} ${ops} ops/s  (${R_SCAN / 5}x in ${elapsed.toFixed(1)}ms)`)
      ge.close()
    }

    console.log('\n' + lines.join('\n'))
    process.stdout.write('\n' + lines.join('\n') + '\n')
  })
})
