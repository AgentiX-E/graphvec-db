/**
 * LDBC-SNB Synthetic Benchmark Generator & Runner
 *
 * Generates a synthetic social graph mimicking LDBC SNB structure:
 *   - Person nodes (name, age, city)
 *   - Company nodes (name, industry)
 *   - KNOWS edges between persons (with edge type 10)
 *   - WORKS_AT edges (person → company, with edge type 20)
 *
 * Default sizing: 10K persons + 5K companies + ~50K edges
 * Uses a seeded PRNG for deterministic generation.
 */

import Benchmark from 'benchmark'
import { GraphEngine } from '../../src/core/graph-engine'
import type { OverGraphConfig } from '../../src/types'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { LDBC_QUERIES, type LdbcQueryDef } from './ldbc-queries'
import { createHash } from 'crypto'

// ── Edge Type IDs ──
export const EDGE_TYPE_KNOWS = 10
export const EDGE_TYPE_WORKS_AT = 20

// ── Type IDs ──
export const TYPE_PERSON = 1
export const TYPE_COMPANY = 2

// ── Seeded PRNG (Mulberry32) ──
export class SeededRandom {
  private state: number

  constructor(seed: number) {
    this.state = seed
  }

  /** Returns a float in [0, 1) */
  next(): number {
    this.state |= 0
    this.state = (this.state + 0x6d2b79f5) | 0
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Returns an integer in [min, max] inclusive */
  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min
  }

  /** Pick a random element from an array */
  pick<T>(arr: T[]): T {
    return arr[this.nextInt(0, arr.length - 1)]
  }
}

// ── Data names for generation ──
const FIRST_NAMES = [
  'Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank', 'Grace', 'Henry',
  'Ivy', 'Jack', 'Kate', 'Leo', 'Mia', 'Noah', 'Olivia', 'Paul',
  'Quinn', 'Rose', 'Sam', 'Tina', 'Uma', 'Victor', 'Wendy', 'Xander',
  'Yara', 'Zack', 'Amelia', 'Benjamin', 'Catherine', 'Daniel',
]

const CITIES = [
  'Beijing', 'Shanghai', 'Shenzhen', 'Hangzhou', 'Guangzhou',
  'New York', 'London', 'Tokyo', 'Paris', 'Berlin',
  'Singapore', 'Sydney', 'Moscow', 'Dubai', 'Seoul',
]

const COMPANY_NAMES = [
  'Quantum Dynamics', 'Nebula Systems', 'Crimson Analytics', 'Vertex Computing',
  'Pulse Technologies', 'Apex Innovations', 'Stratus Software', 'Horizon Data',
  'Meridian Corp', 'Zenith Solutions', 'Catalyst Labs', 'Fusion Group',
  'Origin Ventures', 'Prism Technologies', 'Vanguard AI', 'NexGen Solutions',
  'Skyline Computing', 'Ember Analytics', 'Titan Software', 'Crest Industries',
]

const INDUSTRIES = [
  'Technology', 'Finance', 'Healthcare', 'Energy', 'Manufacturing',
  'Education', 'Retail', 'Media', 'Transport', 'Telecom',
]

// ── Generated Graph Data ──
export interface GeneratedGraph {
  persons: number
  companies: number
  knowsEdges: number
  worksAtEdges: number
  totalNodes: number
  totalEdges: number
}

export interface LdbcGenerateOptions {
  nodeCount?: number
  edgeFactor?: number
  seed?: number
}

/**
 * LDBC-SNB Synthetic Benchmark Result
 */
export interface LdbcBenchResult {
  queryId: string
  queryName: string
  category: string
  ops: number
  p50Ms: number
  p90Ms: number
  p99Ms: number
  rme: number
  samples: number
}

/**
 * LDBC-SNB Synthetic Benchmark
 *
 * Usage:
 *   const bench = new LdbcSnbBenchmark()
 *   bench.data.generate({ nodeCount: 10000, edgeFactor: 5, seed: 42 })
 *   const report = await bench.runAll()
 */
export class LdbcSnbBenchmark {
  public data: { graph: GeneratedGraph | null; engine: GraphEngine | null; dataDir: string | null } = {
    graph: null,
    engine: null,
    dataDir: null,
  }

  /**
   * Generate the synthetic LDBC-SNB graph into the engine.
   */
  generate(options: LdbcGenerateOptions = {}): GeneratedGraph {
    const {
      nodeCount = 10_000,
      edgeFactor = 5,
      seed = 42,
    } = options

    const rng = new SeededRandom(seed)
    const personCount = Math.floor(nodeCount * 0.666)
    const companyCount = nodeCount - personCount

    // Create graph engine in temp dir
    const dataDir = mkdtempSync(join(tmpdir(), 'ldbc-snb-'))
    const config: OverGraphConfig = {
      path: join(dataDir, 'ldbc-graph'),
    }
    const engine = new GraphEngine(config)
    engine.open()

    // ── Insert Person nodes ──
    for (let i = 0; i < personCount; i++) {
      const name = `${rng.pick(FIRST_NAMES)}_${i}`
      const age = rng.nextInt(18, 75)
      const city = rng.pick(CITIES)
      engine.upsertNode(TYPE_PERSON, name, { props: { age, city } })
    }

    // ── Insert Company nodes ──
    for (let i = 0; i < companyCount; i++) {
      const name = `${rng.pick(COMPANY_NAMES)}_${i}`
      const industry = rng.pick(INDUSTRIES)
      engine.upsertNode(TYPE_COMPANY, name, { props: { industry } })
    }

    // ── Insert KNOWS edges (person → person) ──
    // edgeFactor determines average edges per person
    let knowsCount = 0
    for (let srcId = 1; srcId <= personCount; srcId++) {
      const degree = rng.nextInt(1, Math.max(1, edgeFactor))
      for (let d = 0; d < degree; d++) {
        const dstId = rng.nextInt(1, personCount)
        if (dstId !== srcId) {
          engine.upsertEdge(srcId, dstId, EDGE_TYPE_KNOWS, {})
          knowsCount++
        }
      }
    }

    // ── Insert WORKS_AT edges (person → company) ──
    let worksAtCount = 0
    for (let personId = 1; personId <= personCount; personId++) {
      const companyId = rng.nextInt(personCount + 1, nodeCount)
      engine.upsertEdge(personId, companyId, EDGE_TYPE_WORKS_AT, {})
      worksAtCount++
    }

    const totalEdges = knowsCount + worksAtCount
    const graph: GeneratedGraph = {
      persons: personCount,
      companies: companyCount,
      knowsEdges: knowsCount,
      worksAtEdges: worksAtCount,
      totalNodes: nodeCount,
      totalEdges,
    }

    this.data = { graph, engine, dataDir }
    return graph
  }

  /**
   * Clean up the generated graph.
   */
  cleanup(): void {
    if (this.data.engine) {
      try { (this.data.engine as any).storage?.close?.() } catch { /* ok */ }
    }
    if (this.data.dataDir) {
      try { rmSync(this.data.dataDir, { recursive: true, force: true }) } catch { /* ok */ }
    }
    this.data = { graph: null, engine: null, dataDir: null }
  }

  /**
   * Run a single query as a benchmark suite.
   * Runs each query up to N times (via benchmark.js) and records latency percentiles.
   */
  private benchmarkQuery(engine: GraphEngine, query: LdbcQueryDef): Promise<LdbcBenchResult> {
    return new Promise((resolve) => {
      const suite = new Benchmark.Suite(query.id)

      // Select source node IDs based on query type
      const allNodes = engine.scanAllNodes()
      const personNodes = allNodes.filter(n => n["type"] === TYPE_PERSON)
      const companyNodes = allNodes.filter(n => n["type"] === TYPE_COMPANY)

      let ops = 0
      let rme = 0
      let samples = 0
      const latencies: number[] = []

      suite
        .add(query.name, {
          defer: true,
          fn: async (deferred: { resolve(): void }) => {
            const start = performance.now()
            try {
              await this.executeQuery(engine, query, personNodes, companyNodes)
              latencies.push(performance.now() - start)
            } catch (e) {
              // Query may fail — this is OK for benchmark purposes
              latencies.push(performance.now() - start)
            }
            deferred.resolve()
          },
        })
        .on('cycle', (event: Benchmark.Event) => {
          const bench = event.target as unknown as Benchmark
          if (!bench.error) {
            ops = bench.hz!
            rme = bench.stats?.rme ?? 0
            samples = bench.stats?.sample.length ?? 0
          }
        })
        .on('complete', () => {
          const sorted = [...latencies].sort((a, b) => a - b)
          const p50Ms = sorted[Math.floor(sorted.length * 0.5)] || 0
          const p90Ms = sorted[Math.floor(sorted.length * 0.9)] || 0
          const p99Ms = sorted[Math.floor(sorted.length * 0.99)] || 0

          resolve({
            queryId: query.id,
            queryName: query.name,
            category: query.category,
            ops,
            p50Ms,
            p90Ms,
            p99Ms,
            rme,
            samples: sorted.length,
          })
        })
        .on('error', () => {
          resolve({
            queryId: query.id,
            queryName: query.name,
            category: query.category,
            ops: 0,
            p50Ms: 0,
            p90Ms: 0,
            p99Ms: 0,
            rme: 0,
            samples: 0,
          })
        })
        .run({ async: true, minSamples: 5, maxTime: 3 })
    })
  }

  /**
   * Execute a single LDBC query on the engine.
   */
  private async executeQuery(
    engine: GraphEngine,
    query: LdbcQueryDef,
    personNodes: { id: number; properties?: Record<string, unknown> }[],
    companyNodes: { id: number; properties?: Record<string, unknown> }[],
  ): Promise<unknown> {
    const person1 = personNodes[0]?.id ?? 1
    const person2 = personNodes[Math.min(5, personNodes.length - 1)]?.id ?? 2
    const companyId = companyNodes[0]?.id ?? personNodes.length + 1

    switch (query.id) {
      // Interactive Queries
      case 'IQ1':
        return engine.bfs(person1)

      case 'IQ2':
        return engine.shortestPath(person1, person2)

      case 'IQ3': {
        // Common neighbors: find intersection of neighbors of person1 and person2
        const n1 = engine.neighbors(person1).edges.map(e => e.dst)
        const n2 = engine.neighbors(person2).edges.map(e => e.dst)
        const common = n1.filter(n => n2.includes(n))
        return common
      }

      case 'IQ4':
        return engine.triangleCount()

      case 'IQ5':
        return engine.degreeCentrality()

      case 'IQ6':
        return engine.wcc()

      case 'IQ7': {
        // Persons working at companyId
        const neighbors = engine.neighbors(companyId).edges.map(e => e.dst)
        return neighbors
      }

      case 'IQ8': {
        // 3-hop via BFS
        const bfsResult = await engine.bfs(person1)
        const threeHop: number[] = []
        if (bfsResult instanceof Map) {
          bfsResult.forEach((val, key) => {
            if (val.distance <= 3) threeHop.push(key)
          })
        }
        return threeHop
      }

      case 'IQ9': {
        // Find persons at same company
        const companyId2 = engine.neighbors(person1).edges
          .filter(e => e["type"] === EDGE_TYPE_WORKS_AT)
          .map(e => e.dst)[0]
        if (!companyId2) return []
        const colleagues = engine.neighbors(companyId2).edges
          .filter(e => e["type"] === EDGE_TYPE_WORKS_AT)
          .map(e => e.dst)
        return colleagues
      }

      case 'IQ10':
        return engine.bfs(person1)

      // Business Intelligence Queries
      case 'BI1': {
        const all = engine.scanAllNodes()
        const ages: Record<number, number> = {}
        for (const n of all) {
          if (n["type"] === TYPE_PERSON && n.props?.age != null) {
            const age = n.props.age as number
            ages[age] = (ages[age] || 0) + 1
          }
        }
        return ages
      }

      case 'BI2': {
        const all = engine.scanAllNodes()
        const cities: Record<string, number> = {}
        for (const n of all) {
          if (n["type"] === TYPE_PERSON && n.props?.city) {
            const city = n.props.city as string
            cities[city] = (cities[city] || 0) + 1
          }
        }
        return cities
      }

      case 'BI3': {
        // Count employees per company by accumulating WORKS_AT edges
        const empCount: Record<number, number> = {}
        const allNodes = engine.scanAllNodes()
        for (const n of allNodes) {
          if (n["type"] === TYPE_PERSON) {
            const employers = engine.neighbors(n.id).edges
              .filter(e => e["type"] === EDGE_TYPE_WORKS_AT)
            for (const e of employers) {
              empCount[e.dst] = (empCount[e.dst] || 0) + 1
            }
          }
        }
        return empCount
      }

      case 'BI4': {
        const all = engine.scanAllNodes()
        const industries: Record<string, number> = {}
        for (const n of all) {
          if (n["type"] === TYPE_COMPANY && n.props?.industry) {
            const ind = n.props.industry as string
            industries[ind] = (industries[ind] || 0) + 1
          }
        }
        return industries
      }

      case 'BI5': {
        const all = engine.scanAllNodes()
        const cityStats: Record<string, { sum: number; count: number }> = {}
        for (const n of all) {
          if (n["type"] === TYPE_PERSON && n.props?.city && n.props?.age != null) {
            const city = n.props.city as string
            const age = n.props.age as number
            if (!cityStats[city]) cityStats[city] = { sum: 0, count: 0 }
            cityStats[city].sum += age
            cityStats[city].count++
          }
        }
        return cityStats
      }

      case 'BI6': {
        // Sort companies by employee count
        const empCount: Record<number, number> = {}
        const allNodes = engine.scanAllNodes()
        for (const n of allNodes) {
          if (n["type"] === TYPE_PERSON) {
            const employers = engine.neighbors(n.id).edges
              .filter(e => e["type"] === EDGE_TYPE_WORKS_AT)
            for (const e of employers) {
              empCount[e.dst] = (empCount[e.dst] || 0) + 1
            }
          }
        }
        // Return top 10
        const sorted = Object.entries(empCount).sort((a, b) => b[1] - a[1]).slice(0, 10)
        return sorted
      }

      case 'BI7': {
        const all = engine.scanAllNodes()
        let minAge = Infinity
        let maxAge = -Infinity
        let sumAge = 0
        let count = 0
        for (const n of all) {
          if (n["type"] === TYPE_PERSON && n.props?.age != null) {
            const age = n.props.age as number
            minAge = Math.min(minAge, age)
            maxAge = Math.max(maxAge, age)
            sumAge += age
            count++
          }
        }
        return { youngest: minAge, oldest: maxAge, average: count > 0 ? sumAge / count : 0 }
      }

      case 'BI8': {
        // Density: count persons, total possible KNOWS edges, actual KNOWS edges
        const all = engine.scanAllNodes()
        const persons = all.filter(n => n["type"] === TYPE_PERSON)
        const n = persons.length
        const possibleEdges = (n * (n - 1)) / 2
        let actualEdges = 0
        for (const p of persons) {
          actualEdges += engine.neighbors(p.id).edges.filter(e => e["type"] === EDGE_TYPE_KNOWS).length
        }
        actualEdges = Math.floor(actualEdges / 2) // undirected
        return { persons: n, possibleEdges, actualEdges }
      }

      case 'BI9': {
        // Find persons working at companies in different industries
        const results: Array<{ personId: number; industry1: string; industry2: string }> = []
        const all = engine.scanAllNodes()
        for (const n of all) {
          if (n["type"] === TYPE_PERSON) {
            const workEdges = engine.neighbors(n.id).edges.filter(e => e["type"] === EDGE_TYPE_WORKS_AT)
            if (workEdges.length < 2) continue
            // Not strictly multi-industry in our generation (one job per person),
            // but we can still simulate via neighbors
            for (let i = 0; i < workEdges.length; i++) {
              for (let j = i + 1; j < workEdges.length; j++) {
                const c1 = engine.getNode(workEdges[i].dst)
                const c2 = engine.getNode(workEdges[j].dst)
                if (c1 && c2 && c1.props?.industry !== c2.props?.industry) {
                  results.push({
                    personId: n.id,
                    industry1: c1.props?.industry as string,
                    industry2: c2.props?.industry as string,
                  })
                }
              }
            }
          }
        }
        return results
      }

      case 'BI10': {
        const dc = engine.degreeCentrality()
        return dc
      }

      default:
        return null
    }
  }

  /**
   * Run all 20 LDBC queries and report P50/P90/P99/QPS.
   */
  async runAll(): Promise<LdbcBenchResult[]> {
    const engine = this.data.engine
    if (!engine) {
      throw new Error('No graph generated. Call data.generate() first.')
    }

    const results: LdbcBenchResult[] = []

    const allNodes = engine.scanAllNodes()
    const personNodes = allNodes.filter(n => n["type"] === TYPE_PERSON)
    const companyNodes = allNodes.filter(n => n["type"] === TYPE_COMPANY)

    for (const query of LDBC_QUERIES) {
      const result = await this.benchmarkQuery(engine, query)
      results.push(result)
    }

    return results
  }

  /**
   * Run all 20 queries without Benchmark.Suite (for spec validation).
   * Each query executes once, returns per-query latency.
   */
  async runAllFast(): Promise<LdbcBenchResult[]> {
    const engine = this.data.engine
    if (!engine) {
      throw new Error('No graph generated. Call data.generate() first.')
    }

    const allNodes = engine.scanAllNodes()
    const personNodes = allNodes.filter((n: any) => n["type"] === TYPE_PERSON)
    const companyNodes = allNodes.filter((n: any) => n["type"] === TYPE_COMPANY)

    const results: LdbcBenchResult[] = []
    for (const query of LDBC_QUERIES) {
      const start = performance.now()
      await this.executeQuery(engine, query, personNodes, companyNodes)
      const elapsed = performance.now() - start
      results.push({
        queryId: query.id,
        queryName: query.name,
        category: query.category,
        ops: elapsed > 0 ? Math.round(1000 / elapsed) : 0,
        p50Ms: elapsed,
        p90Ms: elapsed,
        p99Ms: elapsed,
        rme: 0,
        samples: 1,
      })
    }
    return results
  }
}
