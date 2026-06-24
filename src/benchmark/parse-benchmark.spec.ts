/**
 * parse-benchmark.spec.ts — AST Parsing Performance Benchmark
 *
 * Measures parseCypherToPlan / parseQuery throughput for various query shapes.
 * Uses custom benchmark helper that prints standard ops/s lines parseable by runner.ts.
 *
 * Run: npx vitest run src/benchmark/parse-benchmark.spec.ts --no-coverage
 */

import { describe, it, expect } from 'vitest'
import { parseQuery } from '../query/query-engine'

// ── Custom benchmark helper ──
// Produces stdout lines matching vitest bench output format so runner.ts can parse them:
//   "  some label                         XXX,XXX ops/s  (XXXXx in XXX.Xms)"

function benchmark(label: string, fn: () => unknown, iterations = 10000): string {
  for (let i = 0; i < 1000; i++) fn()
  const start = performance.now()
  for (let i = 0; i < iterations; i++) fn()
  const elapsed = performance.now() - start
  const ops = Math.round(iterations / (elapsed / 1000)).toLocaleString()
  const line = `  ${label.padEnd(48)} ${ops} ops/s  (${iterations}x in ${elapsed.toFixed(1)}ms)`
  process.stdout.write(line + '\n')
  return line
}

// ── Query Templates ──

const Q_SIMPLE = 'MATCH (n:Person) RETURN n.name'
const Q_FILTER = "MATCH (n:Person) WHERE n.age > 30 AND n.name STARTS WITH 'A' RETURN n.name, n.age"
const Q_ORDERED = 'MATCH (n:Person) RETURN n.name, n.age ORDER BY n.age DESC SKIP 10 LIMIT 20'
const Q_2HOP = 'MATCH (a:Person)-[:KNOWS]->(b:Person)-[:KNOWS]->(c:Person) RETURN a.name, c.name'
const Q_CREATE = "CREATE (n:Person {name: 'Alice', age: 30}) RETURN n"
const Q_MERGE = "MATCH (n:Person) MERGE (n)-[:KNOWS]->(:Person {name: 'Bob'}) RETURN n.name"
const Q_SET = "MATCH (n:Person {name: 'Alice'}) SET n.age = 31, n.updated = true RETURN n"
const Q_COMPLEX = 'MATCH (n:Person)-[:WORKS_AT]->(c:Company) WITH c, count(n) AS empCount WHERE empCount > 5 RETURN c.name, empCount ORDER BY empCount DESC SKIP 3 LIMIT 10'
const Q_PARAM = 'MATCH (n:Person {name: $name}) RETURN n.age, n.email'
const Q_WITH = 'MATCH (n:Person) WITH n, n.age AS a WHERE a > 25 RETURN n.name, a'
const Q_CALL = 'CALL db.labels() YIELD label RETURN label'
const Q_INDEX = 'CREATE INDEX ON :Person(name)'
const Q_FOREACH = "MATCH (n) FOREACH (x IN [1, 2, 3] | SET n.prop = x)"
const Q_OPTIONAL = 'MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b:Person) RETURN a.name, b.name'
const Q_UNWIND = 'UNWIND [1, 2, 3, 4, 5] AS x RETURN x'
const Q_DELETE = 'MATCH (n:Person {name: "Alice"}) DETACH DELETE n'
const Q_UNION = 'MATCH (a:Person) RETURN a.name UNION MATCH (b:Person) RETURN b.name'

// ── Validation ──

describe('parse-benchmark validation', () => {
  it('should parse all query shapes without error', () => {
    for (const q of [Q_SIMPLE, Q_FILTER, Q_ORDERED, Q_2HOP, Q_CREATE, Q_MERGE, Q_SET, Q_COMPLEX, Q_PARAM]) {
      expect(() => parseQuery(q)).not.toThrow()
    }
  })
})

// ── Benchmark ──

describe('AST Parse Benchmark', () => {
  // Warmup
  it('warmup', () => {
    for (let i = 0; i < 100; i++) parseQuery(Q_SIMPLE)
  })

  it('summary', () => {
    const R = 5000, R2 = 2000
    const lines: string[] = []
    lines.push(benchmark("simple MATCH-RETURN",     () => parseQuery(Q_SIMPLE), R))
    lines.push(benchmark("filter WHERE",            () => parseQuery(Q_FILTER), R))
    lines.push(benchmark("ORDER BY + SKIP + LIMIT", () => parseQuery(Q_ORDERED), R))
    lines.push(benchmark("2-hop pattern",           () => parseQuery(Q_2HOP), R2))
    lines.push(benchmark("CREATE node",             () => parseQuery(Q_CREATE), R))
    lines.push(benchmark("MERGE",                   () => parseQuery(Q_MERGE), R))
    lines.push(benchmark("SET properties",          () => parseQuery(Q_SET), R))
    lines.push(benchmark("complex WITH + aggregation", () => parseQuery(Q_COMPLEX), R2))
    lines.push(benchmark("parametrized query",      () => parseQuery(Q_PARAM), R))
    lines.push(benchmark("DELETE",                  () => parseQuery(Q_DELETE), R))
    lines.push(benchmark("UNWIND",                  () => parseQuery(Q_UNWIND), R))
    lines.push(benchmark("UNION",                   () => parseQuery(Q_UNION), R))
    lines.push(benchmark("WITH pipeline",           () => parseQuery(Q_WITH), R))
    lines.push(benchmark("CALL procedure",          () => parseQuery(Q_CALL), R))
    lines.push(benchmark("CREATE INDEX",            () => parseQuery(Q_INDEX), R))
    lines.push(benchmark("FOREACH",                 () => parseQuery(Q_FOREACH), R))
    lines.push(benchmark("OPTIONAL MATCH",          () => parseQuery(Q_OPTIONAL), R))
    lines.push(benchmark("nested MATCH with WHERE", () => parseQuery('MATCH (a:Person) WHERE a.age > 25 AND a.name CONTAINS "Smith" RETURN a'), R))
    // Batch: 10 unique queries 500 times
    const queries = [Q_SIMPLE, Q_FILTER, Q_ORDERED, Q_2HOP, Q_CREATE, Q_MERGE, Q_SET, Q_COMPLEX, Q_PARAM]
    const start = performance.now()
    for (let i = 0; i < 500; i++) { for (const q of queries) parseQuery(q) }
    const elapsed = performance.now() - start
    const ops = Math.round((500 * queries.length) / (elapsed / 1000)).toLocaleString()
    lines.push(`  ${"batch parse: 10 unique queries (500x batch)".padEnd(48)} ${ops} ops/s  (${500 * queries.length}x in ${elapsed.toFixed(1)}ms)`)

    process.stdout.write('\n' + lines.join('\n') + '\n')
    console.log('\n' + lines.join('\n'))
  })
})
