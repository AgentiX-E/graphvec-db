/**
 * format-benchmark.spec.ts — Result Formatting & PostProcess Performance Benchmark
 *
 * Measures _postProcessResults and _evaluateExpression throughput.
 *
 * Run: npx vitest run src/benchmark/format-benchmark.spec.ts --no-coverage
 */

import { describe, it, expect } from 'vitest'
import { _postProcessResults, _evaluateExpression } from '../query/expression-engine'

// ── Custom benchmark helper ──

function benchmark(label: string, fn: () => unknown, iterations = 10000): string {
  for (let i = 0; i < 500; i++) fn()
  const start = performance.now()
  for (let i = 0; i < iterations; i++) fn()
  const elapsed = performance.now() - start
  const ops = Math.round(iterations / (elapsed / 1000)).toLocaleString()
  const line = `  ${label.padEnd(48)} ${ops} ops/s  (${iterations}x in ${elapsed.toFixed(1)}ms)`
  process.stdout.write(line + '\n')
  return line
}

function makePlan(overrides: Record<string, unknown> = {}): any {
  return { type: 'MATCH', returnColumns: ['name', 'age', 'city', 'email', 'score'], steps: [{ source: 'n' }], ...overrides }
}

function makeRecords(count: number): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []
  for (let i = 0; i < count; i++) {
    records.push({ name: `Person_${i}`, age: 20 + (i % 50), city: `City_${i % 20}`, email: `user${i}@example.com`, score: Math.round(Math.random() * 1000) })
  }
  return records
}

// ── Validation ──

describe('format-benchmark validation', () => {
  it('postProcessResults handles empty records', () => {
    expect(_postProcessResults([], makePlan())).toEqual([])
  })
})

// ── Benchmark ──

describe('Format & PostProcess Benchmark', () => {
  const R = 5000
  const R_SORT = 1000
  const R_EXPR = 5000

  it('warmup', () => {
    for (let i = 0; i < 100; i++) _postProcessResults([{ n: 1 }], makePlan())
  })

  it('summary', () => {
    const lines: string[] = []
    const records100 = makeRecords(100)
    const records200 = makeRecords(200)
    const records1000 = makeRecords(1000)

    // postProcessResults variants
    lines.push(benchmark("empty plan, 100 rows",      () => _postProcessResults(records100, makePlan()), R))
    lines.push(benchmark("ORDER BY DESC 100",         () => _postProcessResults(records100, makePlan({ orderBy: [{ expr: 'n.age', direction: 'DESC' as const }] })), R_SORT))
    lines.push(benchmark("ORDER BY + SKIP + LIMIT",   () => _postProcessResults(records200, makePlan({ orderBy: [{ expr: 'n.score', direction: 'ASC' as const }], skip: 10, limit: 50 })), R_SORT))
    lines.push(benchmark("ORDER BY 1000 rows",        () => _postProcessResults(records1000, makePlan({ orderBy: [{ expr: 'n.score', direction: 'DESC' as const }], skip: 100, limit: 100 })), R_SORT / 10))
    lines.push(benchmark("ORDER BY 2 columns",        () => _postProcessResults(records100, makePlan({ orderBy: [{ expr: 'n.city', direction: 'ASC' as const }, { expr: 'n.age', direction: 'DESC' as const }] })), R_SORT))
    lines.push(benchmark("SKIP only",                 () => _postProcessResults(records200, makePlan({ skip: 50 })), R))
    lines.push(benchmark("LIMIT only",                () => _postProcessResults(records200, makePlan({ limit: 30 })), R))
    lines.push(benchmark("ORDER BY + HAVING + LIMIT", () => _postProcessResults(records200, makePlan({
      orderBy: [{ expr: 'n.score', direction: 'ASC' as const }],
      having: { type: 'GT', left: { type: 'prop', name: 'score' }, right: { type: 'literal', value: 100 } },
      limit: 50,
    })), R_SORT))
    lines.push(benchmark("empty input",               () => _postProcessResults([], makePlan()), R))

    // _evaluateExpression variants
    lines.push(benchmark("simple prop access",        () => _evaluateExpression({ type: 'prop', name: 'name' }, { name: 'Alice', age: 30 } as any), R_EXPR))
    lines.push(benchmark("arithmetic in row",         () => _evaluateExpression({ type: 'arithmetic', op: '+', left: { type: 'prop', name: 'a' }, right: { type: 'prop', name: 'b' } } as any, { a: 10, b: 20 }), R_EXPR))
    lines.push(benchmark("nested object prop",        () => _evaluateExpression({ type: 'prop', name: 'name' }, { person: { name: 'Alice' } } as any), R_EXPR))
    lines.push(benchmark("null propagation",          () => _evaluateExpression({ type: 'arithmetic', op: '+', left: { type: 'prop', name: 'a' }, right: { type: 'prop', name: 'b' } } as any, { a: null, b: 5 }), R_EXPR))
    lines.push(benchmark("type conversion",           () => _evaluateExpression({ type: 'arithmetic', op: '+', left: { type: 'literal', value: 1 }, right: { type: 'prop', name: 'val' } } as any, { val: '42' }), R_EXPR))
    lines.push(benchmark("list literal",              () => _evaluateExpression({ type: 'list', items: [{ type: 'literal', value: 1 }, { type: 'literal', value: 'hello' }, { type: 'prop', name: 'val' }] } as any, { val: true }), R_EXPR))

    process.stdout.write('\n' + lines.join('\n') + '\n')
    console.log('\n' + lines.join('\n'))
  })
})
