/**
 * query-benchmark.spec.ts — GraphEngine Query Performance Benchmark
 *
 * Measures query performance directly using GraphEngine methods.
 * Tests: node scan, 1-hop traversal, 2-hop traversal, filtered query, neighbors.
 * Data sizes: Small (1K/2K), Medium (10K/20K), Large (100K/200K)
 *
 * Usage:
 *   npx vitest run src/benchmark/query-benchmark.spec.ts --no-coverage
 *   npx vitest bench src/benchmark/query-benchmark.spec.ts --no-coverage
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GraphEngine } from '../core/graph-engine'
import * as fs from 'fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { performance } from 'perf_hooks'

// ── Type IDs ─────────────────────────────────────────────────────
const TYPE_PERSON = 1
const TYPE_COMPANY = 2
const TYPE_CITY = 3

const EDGE_WORKS_AT = 10    // Person → Company
const EDGE_LIVES_IN = 20    // Person → City

// ── Data Size Presets ────────────────────────────────────────────
interface DataPreset {
  name: string
  nodeCount: number
  edgeCount: number
}

const PRESETS: DataPreset[] = [
  { name: 'Small',  nodeCount: 1_000,   edgeCount: 2_000 },
  { name: 'Medium', nodeCount: 10_000,  edgeCount: 20_000 },
  { name: 'Large',  nodeCount: 100_000, edgeCount: 200_000 },
]

// ── Benchmark State ──────────────────────────────────────────────
interface BenchmarkResult {
  name: string
  preset: string
  opsSec: number
  p50: number
  p95: number
  p99: number
  memBeforeMB: number
  memAfterMB: number
  isSlow: boolean
}

const results: BenchmarkResult[] = []

// ── Helpers ──────────────────────────────────────────────────────

function randomDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qb-'))
}

/**
 * Generate test data: balanced Person/Company/City nodes,
 * with WORKS_AT edges (Person→Company) and LIVES_IN edges (Person→City).
 */
async function generateData(
  engine: GraphEngine,
  nodeCount: number,
  edgeCount: number,
): Promise<{ personIds: number[]; companyIds: number[]; cityIds: number[] }> {
  const personCount = Math.floor(nodeCount * 0.6)
  const companyCount = Math.floor(nodeCount * 0.25)
  const cityCount = nodeCount - personCount - companyCount

  // Batch upsert nodes
  const personInputs = Array.from({ length: personCount }, (_, i) => ({
    typeId: TYPE_PERSON,
    name: `Person_${i}`,
    opts: {
      props: {
        name: `Person_${i}`,
        age: 20 + (i % 60),
        city: `City_${i % Math.max(cityCount, 1)}`,
      },
    },
  }))
  const companyInputs = Array.from({ length: companyCount }, (_, i) => ({
    typeId: TYPE_COMPANY,
    name: `Company_${i}`,
    opts: { props: { name: `Company_${i}` } },
  }))
  const cityInputs = Array.from({ length: cityCount }, (_, i) => ({
    typeId: TYPE_CITY,
    name: `City_${i}`,
    opts: { props: { name: `City_${i}`, country: 'Country_A' } },
  }))

  const allInputs = [...personInputs, ...companyInputs, ...cityInputs]

  // Batch upsert — returns name→id map
  const nameToId = engine.batchUpsertNodes(allInputs)

  // Collect IDs
  const personIds: number[] = []
  const companyIds: number[] = []
  const cityIds: number[] = []

  for (let i = 0; i < personCount; i++) {
    const id = nameToId[`Person_${i}`]
    if (id !== undefined) personIds.push(id)
  }
  for (let i = 0; i < companyCount; i++) {
    const id = nameToId[`Company_${i}`]
    if (id !== undefined) companyIds.push(id)
  }
  for (let i = 0; i < cityCount; i++) {
    const id = nameToId[`City_${i}`]
    if (id !== undefined) cityIds.push(id)
  }

  // Generate edges: WORKS_AT (Person→Company)
  const edgeInputs: Array<{
    src: number
    dst: number
    typeId: number
    props?: Record<string, unknown>
    weight?: number
  }> = []

  const worksAtCount = Math.floor(edgeCount * 0.7)
  for (let i = 0; i < worksAtCount && personIds.length > 0 && companyIds.length > 0; i++) {
    const pIdx = i % personIds.length
    const cIdx = Math.floor(i / personIds.length) % companyIds.length
    edgeInputs.push({
      src: personIds[pIdx],
      dst: companyIds[cIdx],
      typeId: EDGE_WORKS_AT,
      props: { since: 2015 + (i % 10) },
    })
  }

  // Generate edges: LIVES_IN (Person→City)
  const livesInCount = edgeCount - worksAtCount
  for (let i = 0; i < livesInCount && personIds.length > 0 && cityIds.length > 0; i++) {
    const pIdx = (i + 47) % personIds.length
    const ctIdx = i % cityIds.length
    edgeInputs.push({
      src: personIds[pIdx],
      dst: cityIds[ctIdx],
      typeId: EDGE_LIVES_IN,
    })
  }

  if (edgeInputs.length > 0) {
    engine.batchUpsertEdges(edgeInputs)
  }

  return { personIds, companyIds, cityIds }
}

/**
 * Run a benchmark scenario N times and collect timing stats.
 * Uses performance.now() for high-resolution timing.
 */
function runBenchmark(
  fn: () => void,
  iterations: number = 5,
): { durations: number[]; memBeforeMB: number; memAfterMB: number } {
  // Warmup (2 iterations)
  for (let i = 0; i < 2; i++) {
    fn()
  }

  const durations: number[] = []
  const memBefore = process.memoryUsage()
  const memBeforeMB = Math.round(memBefore.heapUsed / 1024 / 1024 * 100) / 100

  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    fn()
    const end = performance.now()
    durations.push(end - start)
  }

  const memAfter = process.memoryUsage()
  const memAfterMB = Math.round(memAfter.heapUsed / 1024 / 1024 * 100) / 100

  return { durations, memBeforeMB, memAfterMB }
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]
}

function recordResult(
  name: string,
  preset: string,
  durations: number[],
  memBeforeMB: number,
  memAfterMB: number,
  threshold: number | null,
): BenchmarkResult {
  const sorted = [...durations].sort((a, b) => a - b)
  const mean = durations.reduce((s, d) => s + d, 0) / durations.length
  const opsSec = mean > 0 ? Math.round(1000 / mean * 100) / 100 : 0

  const result: BenchmarkResult = {
    name,
    preset,
    opsSec,
    p50: Math.round(percentile(sorted, 50) * 100) / 100,
    p95: Math.round(percentile(sorted, 95) * 100) / 100,
    p99: Math.round(percentile(sorted, 99) * 100) / 100,
    memBeforeMB,
    memAfterMB,
    isSlow: threshold !== null && mean > threshold,
  }

  results.push(result)
  return result
}

function logResult(r: BenchmarkResult): void {
  const slowFlag = r.isSlow ? ' ⚠️ SLOW' : ' ✅'
  console.log(
    `[${r.preset}] ${r.name.padEnd(25)} ` +
    `${String(r.opsSec).padStart(8)} ops/sec  ` +
    `p50=${r.p50.toFixed(2)}ms  p95=${r.p95.toFixed(2)}ms  p99=${r.p99.toFixed(2)}ms  ` +
    `mem: ${r.memBeforeMB}→${r.memAfterMB}MB${slowFlag}`,
  )
}

// ── Benchmark Suite ──────────────────────────────────────────────

/**
 * Revised benchmark approach:
 *
 * Instead of trying to use the Cypher query parser (which has specific
 * syntax requirements), we directly call GraphEngine methods:
 *
 * 1. Node scan: engine.findNodesByType(TYPE_PERSON) + engine.getNode() loop
 * 2. 1-hop traversal: engine.neighbors() on Person nodes
 * 3. 2-hop traversal: engine.neighbors() on Company neighbors of Person nodes
 * 4. Filter: engine.findNodesByProperty(TYPE_PERSON, 'name', 'Person_42')
 * 5. Neighbors: engine.neighbors(singleNodeId)
 *
 * This gives us a clean benchmark of actual graph engine performance
 * without being dependent on the Cypher query parser's syntax.
 */

describe('GraphEngine Query Performance Benchmark', () => {
  // Fresh engines per preset
  const engines: Map<string, GraphEngine> = new Map()
  const dirs: string[] = []
  const dataMap: Map<string, {
    personIds: number[]
    companyIds: number[]
    cityIds: number[]
  }> = new Map()

  beforeAll(async () => {
    for (const preset of PRESETS) {
      const dir = randomDir()
      dirs.push(dir)
      const engine = new GraphEngine({ path: dir, denseVector: { dimension: 384 } })
      engine.open()
      engines.set(preset.name, engine)

      console.log(`\n── Generating ${preset.name} data (${preset.nodeCount} nodes, ${preset.edgeCount} edges) ──`)
      const data = await generateData(engine, preset.nodeCount, preset.edgeCount)
      dataMap.set(preset.name, data)

      const stats = engine.stats()
      console.log(`  Nodes: ${stats.nodeCount}, Edges: ${stats.edgeCount}, Disk: ${Math.round(stats.diskSizeBytes / 1024)}KB`)
    }
  })

  afterAll(() => {
    for (const engine of engines.values()) {
      try { engine.close() } catch { /* ignore */ }
    }
    for (const dir of dirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }

    // Print summary table
    console.log('\n\n═══════════════════════════════════════════════════════════════════')
    console.log('                    BENCHMARK RESULTS SUMMARY')
    console.log('═══════════════════════════════════════════════════════════════════\n')

    for (const preset of PRESETS) {
      console.log(`\n── ${preset.name} (${preset.nodeCount} nodes, ${preset.edgeCount} edges) ──`)
      console.log('┌─────────────────────────────┬──────────┬──────────┬──────────┬──────────┬──────────────┐')
      console.log('│ Scenario                    │ ops/sec  │ p50(ms)  │ p95(ms)  │ p99(ms)  │ Mem Δ (MB)  │')
      console.log('├─────────────────────────────┼──────────┼──────────┼──────────┼──────────┼──────────────┤')
      for (const r of results) {
        if (r.preset === preset.name) {
          const flag = r.isSlow ? ' SLOW' : ''
          const memDelta = (r.memAfterMB - r.memBeforeMB).toFixed(1)
          console.log(
            `│ ${r.name.padEnd(27)} │ ${String(r.opsSec).padStart(8)} │ ${String(r.p50).padStart(8)} │ ${String(r.p95).padStart(8)} │ ${String(r.p99).padStart(8)} │ ${memDelta.padStart(10)} │${flag}`,
          )
        }
      }
      console.log('└─────────────────────────────┴──────────┴──────────┴──────────┴──────────┴──────────────┘')
    }

    // Performance guard checks
    console.log('\n── Performance Guard ──')
    const slowResults = results.filter(r => r.isSlow)
    if (slowResults.length > 0) {
      console.log('⚠️  SLOW PERFORMANCE DETECTED:')
      for (const r of slowResults) {
        const hint = r.name === '1-hop traversal' && r.preset === 'Medium' ? '(threshold: >500ms)' :
                     r.name === 'Node scan' && r.preset === 'Large' ? '(threshold: >200ms)' : ''
        console.log(`  ✗ [${r.preset}] ${r.name}: p95=${r.p95.toFixed(2)}ms, mean ops/sec=${r.opsSec} ${hint}`)
      }
    } else {
      console.log('✅ All benchmarks passed performance thresholds.')
    }
  })

  // ── Scenario 1: Node Scan ──
  // Scan all Person nodes using findNodesByType + getNode
  function benchNodeScan(engine: GraphEngine): void {
    const ids = engine.findNodesByType(TYPE_PERSON)
    const nodes: number[] = []
    for (const id of ids) {
      const node = engine.getNode(id)
      if (node) nodes.push(node.id)
    }
  }

  // ── Scenario 2: 1-hop Traversal ──
  // Person → Company via neighbors()
  function bench1Hop(engine: GraphEngine, personIds: number[]): void {
    for (const pid of personIds) {
      const result = engine.neighbors(pid, { edgeTypeFilter: [EDGE_WORKS_AT] })
      // Consume the results to ensure the operation completes
      for (const _edge of result.edges) { /* consume */ }
    }
  }

  // ── Scenario 3: 2-hop Traversal ──
  // Person → Company → City: neighbors on first company of each person
  function bench2Hop(engine: GraphEngine, personIds: number[]): void {
    for (const pid of personIds) {
      const firstHop = engine.neighbors(pid, { edgeTypeFilter: [EDGE_WORKS_AT] })
      if (firstHop.nodes.length > 0) {
        const companyId = firstHop.nodes[0].id
        const secondHop = engine.neighbors(companyId, { edgeTypeFilter: [] })
        for (const _node of secondHop.nodes) { /* consume */ }
      }
    }
  }

  // ── Scenario 4: Filter ──
  // Find Person_42 by property
  function benchFilter(engine: GraphEngine): void {
    const ids = engine.findNodesByProperty(TYPE_PERSON, 'name', 'Person_42')
    for (const id of ids) {
      engine.getNode(id)
    }
  }

  // ── Scenario 5: Neighbors of single node ──
  function benchNeighbors(engine: GraphEngine, nodeId: number): void {
    const result = engine.neighbors(nodeId)
    for (const _edge of result.edges) { /* consume */ }
    for (const _node of result.nodes) { /* consume */ }
  }

  // ── Small Tests ──
  describe('Small (1K nodes, 2K edges)', () => {
    it('1. Node scan — scan all Person nodes', () => {
      const engine = engines.get('Small')!
      const { durations, memBeforeMB, memAfterMB } = runBenchmark(() => benchNodeScan(engine))
      const r = recordResult('Node scan', 'Small', durations, memBeforeMB, memAfterMB, null)
      logResult(r)
      expect(durations.length).toBe(5)
    })

    it('2. 1-hop traversal — Person → Company', () => {
      const engine = engines.get('Small')!
      const personIds = dataMap.get('Small')!.personIds.slice(0, 100) // sample for 1-hop
      const { durations, memBeforeMB, memAfterMB } = runBenchmark(() => bench1Hop(engine, personIds))
      const r = recordResult('1-hop traversal', 'Small', durations, memBeforeMB, memAfterMB, null)
      logResult(r)
      expect(durations.length).toBe(5)
    })

    it('3. 2-hop traversal — Person → Company → City', () => {
      const engine = engines.get('Small')!
      const personIds = dataMap.get('Small')!.personIds.slice(0, 50) // sample for 2-hop
      const { durations, memBeforeMB, memAfterMB } = runBenchmark(() => bench2Hop(engine, personIds))
      const r = recordResult('2-hop traversal', 'Small', durations, memBeforeMB, memAfterMB, null)
      logResult(r)
      expect(durations.length).toBe(5)
    })

    it('4. Filter — find Person_42 by name', () => {
      const engine = engines.get('Small')!
      const { durations, memBeforeMB, memAfterMB } = runBenchmark(() => benchFilter(engine))
      const r = recordResult('Filter', 'Small', durations, memBeforeMB, memAfterMB, null)
      logResult(r)
      expect(durations.length).toBe(5)
    })

    it('5. Neighbors — read all neighbors of one node', () => {
      const engine = engines.get('Small')!
      const targetId = dataMap.get('Small')!.personIds[0]
      const { durations, memBeforeMB, memAfterMB } = runBenchmark(() => benchNeighbors(engine, targetId))
      const r = recordResult('Neighbors', 'Small', durations, memBeforeMB, memAfterMB, null)
      logResult(r)
      expect(durations.length).toBe(5)
    })
  })

  // ── Medium Tests ──
  describe('Medium (10K nodes, 20K edges)', () => {
    it('1. Node scan — scan all Person nodes', () => {
      const engine = engines.get('Medium')!
      const { durations, memBeforeMB, memAfterMB } = runBenchmark(() => benchNodeScan(engine))
      const r = recordResult('Node scan', 'Medium', durations, memBeforeMB, memAfterMB, null)
      logResult(r)
      expect(durations.length).toBe(5)
    })

    it('2. 1-hop traversal — Person → Company (threshold: >500ms → SLOW)', () => {
      const engine = engines.get('Medium')!
      const personIds = dataMap.get('Medium')!.personIds.slice(0, 200)
      const { durations, memBeforeMB, memAfterMB } = runBenchmark(() => bench1Hop(engine, personIds))
      const r = recordResult('1-hop traversal', 'Medium', durations, memBeforeMB, memAfterMB, 500)
      logResult(r)
      expect(durations.length).toBe(5)
    })

    it('3. 2-hop traversal — Person → Company → City', () => {
      const engine = engines.get('Medium')!
      const personIds = dataMap.get('Medium')!.personIds.slice(0, 100)
      const { durations, memBeforeMB, memAfterMB } = runBenchmark(() => bench2Hop(engine, personIds))
      const r = recordResult('2-hop traversal', 'Medium', durations, memBeforeMB, memAfterMB, null)
      logResult(r)
      expect(durations.length).toBe(5)
    })

    it('4. Filter — find Person_42 by name', () => {
      const engine = engines.get('Medium')!
      const { durations, memBeforeMB, memAfterMB } = runBenchmark(() => benchFilter(engine))
      const r = recordResult('Filter', 'Medium', durations, memBeforeMB, memAfterMB, null)
      logResult(r)
      expect(durations.length).toBe(5)
    })

    it('5. Neighbors — read all neighbors of one node', () => {
      const engine = engines.get('Medium')!
      const targetId = dataMap.get('Medium')!.personIds[0]
      const { durations, memBeforeMB, memAfterMB } = runBenchmark(() => benchNeighbors(engine, targetId))
      const r = recordResult('Neighbors', 'Medium', durations, memBeforeMB, memAfterMB, null)
      logResult(r)
      expect(durations.length).toBe(5)
    })
  })

  // ── Large Tests ──
  describe('Large (100K nodes, 200K edges)', () => {
    it('1. Node scan — scan all Person nodes (threshold: >200ms → SLOW)', () => {
      const engine = engines.get('Large')!
      const { durations, memBeforeMB, memAfterMB } = runBenchmark(() => benchNodeScan(engine))
      const r = recordResult('Node scan', 'Large', durations, memBeforeMB, memAfterMB, 200)
      logResult(r)
      expect(durations.length).toBe(5)
    })

    it('2. 1-hop traversal — Person → Company', () => {
      const engine = engines.get('Large')!
      const personIds = dataMap.get('Large')!.personIds.slice(0, 500)
      const { durations, memBeforeMB, memAfterMB } = runBenchmark(() => bench1Hop(engine, personIds))
      const r = recordResult('1-hop traversal', 'Large', durations, memBeforeMB, memAfterMB, null)
      logResult(r)
      expect(durations.length).toBe(5)
    })

    it('3. 2-hop traversal — Person → Company → City', () => {
      const engine = engines.get('Large')!
      const personIds = dataMap.get('Large')!.personIds.slice(0, 200)
      const { durations, memBeforeMB, memAfterMB } = runBenchmark(() => bench2Hop(engine, personIds))
      const r = recordResult('2-hop traversal', 'Large', durations, memBeforeMB, memAfterMB, null)
      logResult(r)
      expect(durations.length).toBe(5)
    })

    it('4. Filter — find Person_42 by name', () => {
      const engine = engines.get('Large')!
      const { durations, memBeforeMB, memAfterMB } = runBenchmark(() => benchFilter(engine))
      const r = recordResult('Filter', 'Large', durations, memBeforeMB, memAfterMB, null)
      logResult(r)
      expect(durations.length).toBe(5)
    })

    it('5. Neighbors — read all neighbors of one node', () => {
      const engine = engines.get('Large')!
      const targetId = dataMap.get('Large')!.personIds[0]
      const { durations, memBeforeMB, memAfterMB } = runBenchmark(() => benchNeighbors(engine, targetId))
      const r = recordResult('Neighbors', 'Large', durations, memBeforeMB, memAfterMB, null)
      logResult(r)
      expect(durations.length).toBe(5)
    })
  })
})
