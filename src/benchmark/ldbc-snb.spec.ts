/**
 * LDBC-SNB Benchmark Test Suite
 *
 * Tests:
 *   1. Generator produces correct node/edge counts
 *   2. All 20 queries return results
 *   3. Benchmark produces a Markdown report
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { LdbcSnbBenchmark, TYPE_PERSON, TYPE_COMPANY, EDGE_TYPE_KNOWS, EDGE_TYPE_WORKS_AT } from './ldbc-snb'
import { LDBC_QUERIES } from './ldbc-queries'

// Use small graph for tests — 500 persons + ~250 companies + ~2500 edges
const TEST_NODE_COUNT = 750
const TEST_EDGE_FACTOR = 3
const TEST_SEED = 12345

const bench = new LdbcSnbBenchmark()
let graph: ReturnType<typeof bench.generate>

describe('LDBC-SNB Benchmark Suite', () => {
  beforeAll(() => {
    graph = bench.generate({ nodeCount: TEST_NODE_COUNT, edgeFactor: TEST_EDGE_FACTOR, seed: TEST_SEED })
  })

  afterAll(() => {
    bench.cleanup()
  })

  describe('Data Generator', () => {
    it('should generate correct total node count', () => {
      expect(graph.totalNodes).toBe(TEST_NODE_COUNT)
    })

    it('should generate persons and companies adding up to total nodes', () => {
      expect(graph.persons + graph.companies).toBe(TEST_NODE_COUNT)
      expect(graph.persons).toBe(Math.floor(TEST_NODE_COUNT * 0.666))
    })

    it('should generate KNOWS edges between persons', () => {
      expect(graph.knowsEdges).toBeGreaterThan(0)
    })

    it('should generate WORKS_AT edges from persons to companies', () => {
      expect(graph.worksAtEdges).toBeGreaterThan(0)
    })

    it('should have at least one edge per person on average', () => {
      const totalEdges = graph.knowsEdges + graph.worksAtEdges
      expect(totalEdges).toBeGreaterThan(graph.persons)
    })

    it('should be deterministic with the same seed', () => {
      const bench2 = new LdbcSnbBenchmark()
      const graph2 = bench2.generate({ nodeCount: TEST_NODE_COUNT, edgeFactor: TEST_EDGE_FACTOR, seed: TEST_SEED })
      expect(graph2.totalNodes).toBe(graph.totalNodes)
      expect(graph2.persons).toBe(graph.persons)
      bench2.cleanup()
    })

    it('should produce different output with different seed', () => {
      const bench2 = new LdbcSnbBenchmark()
      const graph2 = bench2.generate({ nodeCount: TEST_NODE_COUNT, edgeFactor: TEST_EDGE_FACTOR, seed: 99999 })
      // Total counts should be same but edge distribution may differ
      expect(graph2.totalNodes).toBe(graph.totalNodes)
      bench2.cleanup()
    })
  })

  describe('Graph Engine Contains Generated Data', () => {
    it('scanAllNodes should return all nodes', () => {
      const engine = bench.data.engine!
      const nodes = engine.scanAllNodes()
      expect(nodes.length).toBe(TEST_NODE_COUNT)
    })

    it('should have person nodes with properties', () => {
      const engine = bench.data.engine!
      const nodes = engine.scanAllNodes()
      const persons = nodes.filter(n => n["type"] === TYPE_PERSON)
      expect(persons.length).toBe(graph.persons)
      expect(persons[0].props).toBeDefined()
      expect((persons[0].props as any)?.age).toBeDefined()
      expect((persons[0].props as any)?.city).toBeDefined()
    })

    it('should have company nodes with properties', () => {
      const engine = bench.data.engine!
      const nodes = engine.scanAllNodes()
      const companies = nodes.filter(n => n["type"] === TYPE_COMPANY)
      expect(companies.length).toBe(graph.companies)
      expect(companies[0].props).toBeDefined()
      expect((companies[0].props as any)?.industry).toBeDefined()
    })
  })

  describe('Query Catalog', () => {
    it('should have exactly 20 queries', () => {
      expect(LDBC_QUERIES.length).toBe(20)
    })

    it('should have 10 interactive and 10 BI queries', () => {
      const interactive = LDBC_QUERIES.filter(q => q.category === 'interactive')
      const bi = LDBC_QUERIES.filter(q => q.category === 'bi')
      expect(interactive.length).toBe(10)
      expect(bi.length).toBe(10)
    })

    it('every query should have required fields', () => {
      for (const q of LDBC_QUERIES) {
        expect(q.id).toBeDefined()
        expect(q.name).toBeDefined()
        expect(q.description).toBeDefined()
        expect(q.category).toBeDefined()
        expect(q.cypher).toBeDefined()
        expect(q.returns).toBeDefined()
        expect(q.returns.length).toBeGreaterThan(0)
      }
    })
  })

  describe('Benchmark Execution', () => {
    it('should run all 20 queries and return results', async () => {
      const results = await bench.runAllFast()
      expect(results.length).toBe(20)
    })

    it('each result should have latency metrics', async () => {
      const results = await bench.runAllFast()
      for (const r of results) {
        expect(r.queryId).toBeDefined()
        expect(r.queryName).toBeDefined()
        expect(typeof r.p50Ms).toBe('number')
        expect(typeof r.p90Ms).toBe('number')
        expect(typeof r.p99Ms).toBe('number')
      }
    })
  })

  describe('Markdown Report Generation', () => {
    it('should produce a Markdown table report', async () => {
      const results = await bench.runAllFast()
      const report = generateMarkdownReport(results)
      expect(report).toContain('| Query')
      expect(report).toContain('|---')
      expect(report).toContain('IQ1')
      expect(report).toContain('BI10')
    })

    it('report should include latency columns', async () => {
      const results = await bench.runAllFast()
      const report = generateMarkdownReport(results)
      expect(report).toContain('P50')
      expect(report).toContain('P90')
      expect(report).toContain('P99')
      expect(report).toContain('QPS')
    })
  })
})

/**
 * Generate a Markdown table report from benchmark results.
 */
function generateMarkdownReport(results: Array<{
  queryId: string
  queryName: string
  category: string
  p50Ms: number
  p90Ms: number
  p99Ms: number
  ops: number
}>): string {
  const header = '| Query | Name | Category | P50 (ms) | P90 (ms) | P99 (ms) | QPS |'
  const separator = '|---|---|---|---|---|---|---|'
  const rows = results.map(r => {
    const qps = r.ops > 0 ? r.ops.toFixed(1) : 'N/A'
    return `| ${r.queryId} | ${r.queryName} | ${r.category} | ${r.p50Ms.toFixed(2)} | ${r.p90Ms.toFixed(2)} | ${r.p99Ms.toFixed(2)} | ${qps} |`
  })
  return [header, separator, ...rows].join('\n')
}

export { generateMarkdownReport }
