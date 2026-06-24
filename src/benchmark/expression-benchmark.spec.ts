/**
 * expression-benchmark.spec.ts — Expression Engine Performance Benchmark
 *
 * Measures evaluation throughput of the standalone expression engine.
 * All benchmarks call the exported public API of expression-engine.ts.
 *
 * Usage:
 *   npx vitest run src/benchmark/expression-benchmark.spec.ts --no-coverage
 */

import { describe, it, expect } from 'vitest'
import { performance } from 'perf_hooks'

import {
  _evaluateExpression,
  _evalCase,
  _postProcessResults,
  _deepEqWithNull,
} from '../query/expression-engine'

// ── Helpers ──────────────────────────────────────────────────────
function benchmark(label: string, fn: () => unknown, iterations = 10000): string {
  // Warmup
  for (let i = 0; i < 1000; i++) fn()
  // Timed run
  const start = performance.now()
  for (let i = 0; i < iterations; i++) fn()
  const elapsed = performance.now() - start
  const ops = Math.round(iterations / (elapsed / 1000)).toLocaleString()
  return `  ${label.padEnd(48)} ${ops} ops/s  (${iterations}x in ${elapsed.toFixed(1)}ms)`
}

const _ctx = {} as any
const _row: Record<string, unknown> = {}

const LARGE_MAP: Record<string, unknown> = Object.fromEntries(
  Array.from({ length: 100 }, (_, i) => [`key${i}`, i])
)
const NESTED = {
  users: Array.from({ length: 50 }, (_, i) => ({
    id: i, name: `user${i}`, tags: [`tag${i % 10}`],
  })),
}

// ── All benchmarks in one test to get a single summary block ─────
describe('Expression Engine Benchmark', () => {

  it('summary', () => {
    const results: string[] = ['\n━━━ Expression Engine Benchmark ━━━']
    const R = 20000
    const S = 5000

    // ── Literals ──
    results.push('\n── Literals ──')
    results.push(benchmark("literal string 'hello'",     () => _evaluateExpression("'hello world'", _row, _ctx), R))
    results.push(benchmark("literal number 42",            () => _evaluateExpression('42', _row, _ctx), R))
    results.push(benchmark("literal float 3.14",           () => _evaluateExpression('3.14', _row, _ctx), R))
    results.push(benchmark("literal boolean true",         () => _evaluateExpression('true', _row, _ctx), R))
    results.push(benchmark("literal null",                 () => _evaluateExpression('null', _row, _ctx), R))

    // ── Arithmetic ──
    results.push('\n── Arithmetic ──')
    results.push(benchmark("1 + 2",                        () => _evaluateExpression('1 + 2', _row, _ctx), R))
    results.push(benchmark("x + 1 (row)",                  () => _evaluateExpression('x + 1', { x: 5 }, _ctx), R))
    results.push(benchmark("(a + b) * c",                  () => _evaluateExpression('(1 + 2) * 3', _row, _ctx), R))

    // ── Comparison ──
    results.push('\n── Comparison ──')
    results.push(benchmark("1 = 1",                        () => _evaluateExpression('1 = 1', _row, _ctx), R))
    results.push(benchmark("1 < 2",                        () => _evaluateExpression('1 < 2', _row, _ctx), R))
    results.push(benchmark("deepEqWithNull (primitive)",   () => _deepEqWithNull(42, 42), R))
    results.push(benchmark("deepEqWithNull (nested map)",  () => _deepEqWithNull(NESTED, NESTED), S))

    // ── Boolean ──
    results.push('\n── Boolean ──')
    results.push(benchmark("true AND true",                () => _evaluateExpression('true AND true', _row, _ctx), R))
    results.push(benchmark("true OR false",                () => _evaluateExpression('true OR false', _row, _ctx), R))
    results.push(benchmark("NOT true",                     () => _evaluateExpression('NOT true', _row, _ctx), R))

    // ── String ──
    results.push('\n── String ──')
    results.push(benchmark("'hello' + ' world'",           () => _evaluateExpression("'hello ' + 'world'", _row, _ctx), R))
    results.push(benchmark("string STARTS WITH",           () => _evaluateExpression("'hello' STARTS WITH 'he'", _row, _ctx), R))
    results.push(benchmark("string CONTAINS",              () => _evaluateExpression("'hello' CONTAINS 'ell'", _row, _ctx), R))

    // ── List & Map ──
    results.push('\n── List / Map ──')
    results.push(benchmark("[1, 2, 3, 4, 5]",             () => _evaluateExpression('[1, 2, 3, 4, 5]', _row, _ctx), R))
    results.push(benchmark("{a: 1, b: 2}",                () => _evaluateExpression('{a: 1, b: 2}', _row, _ctx), R))
    results.push(benchmark("list[0] on [1,2,3]",           () => _evaluateExpression('[1,2,3][0]', _row, _ctx), R))

    // ── CASE ──
    results.push('\n── CASE ──')
    results.push(benchmark("CASE simple 3-branch",         () =>
      _evalCase("CASE 'b' WHEN 'a' THEN 1 WHEN 'b' THEN 2 ELSE 3 END", _row), R))
    results.push(benchmark("CASE searched true",           () =>
      _evalCase('CASE WHEN 1=1 THEN 42 ELSE 0 END', _row), R))

    // ── postProcess ──
    results.push('\n── postProcessResults ──')
    const data100 = Array.from({ length: 100 }, (_, i) => ({ name: `u${99 - i}`, score: i }))
    const orderPlan = { orderBy: [{ column: 'score', direction: 'ASC' }] } as any
    results.push(benchmark("ORDER BY 100 items",           () => _postProcessResults(data100, orderPlan), S))

    results.push('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
    console.log(results.join('\n'))
    // No assertions needed — this is a pure benchmark
    expect(true).toBe(true)
  })
})
