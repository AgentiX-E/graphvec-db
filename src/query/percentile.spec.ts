/**
 * percentile.spec.ts — Percentile aggregate (percentileDisc/percentileCont) tests
 *
 * Verifies the complete percentile surface across three layers:
 *
 *   1. Parsing     — `_parseAggregate` / `_lastTopLevelComma` split the two
 *                    call arguments (`value`, `percentile`) correctly, even
 *                    when the value expression nests commas.
 *   2. Computation — `_computeAggregate` / `_computePercentile` return the
 *                    correct nearest-rank (disc) and linear-interpolated (cont)
 *                    result, and raise `NumberOutOfRange` for a percentile
 *                    outside [0, 1].
 *   3. Evaluation  — `_evaluateExpression` implements `percentileDisc` /
 *                    `percentileCont` as first-class functions, and `size` on a
 *                    pattern comprehension computes node degree correctly.
 *
 * The runtime range error matches the openCypher TCK Aggregation6 scenarios
 * ([1]..[5]): a percentile argument < 0 or > 1 (including one derived from
 * data, not just a literal) must surface as an `ArgumentError` carrying
 * `tckError: 'NumberOutOfRange'`.
 */

import { describe, it, expect } from 'vitest'
import {
  _parseAggregate,
  _lastTopLevelComma,
  _computeAggregate,
  _evaluateExpression,
} from './expression-engine'

/**
 * Assert that `fn` raises an ArgumentError carrying the `NumberOutOfRange`
 * marker (matching openCypher's runtime ArgumentError for percentile args
 * outside [0, 1]).  Implemented with try/catch instead of `.toThrowError`
 * because the thrown Error carries a custom `tckError` property that vitest's
 * predicate matcher does not reliably surface.
 */
function expectNumberOutOfRange(fn: () => unknown): void {
  let caught: any = null
  try {
    fn()
  } catch (e) {
    caught = e
  }
  expect(caught, 'expected an ArgumentError to be thrown').not.toBeNull()
  expect(caught?.tckError).toBe('NumberOutOfRange')
  expect(caught?.message).toContain('NumberOutOfRange')
}

// ── 1. _lastTopLevelComma (paren-depth-aware comma split) ──

describe('_lastTopLevelComma', () => {
  it('returns -1 for a string with no top-level comma', () => {
    expect(_lastTopLevelComma('n.price')).toBe(-1)
    expect(_lastTopLevelComma('singlearg')).toBe(-1)
  })

  it('finds the single top-level comma', () => {
    expect(_lastTopLevelComma('n.price, 0.5')).toBe('n.price'.length)
    expect(_lastTopLevelComma('a,b')).toBe(1)
  })

  it('ignores commas nested inside parentheses (picks the LAST top-level comma)', () => {
    // `collect(n.x, n.y)` has a comma at depth 1; the percentile comma follows it.
    expect(_lastTopLevelComma('size([(n)-->(m) | 1, 2]), 0.9')).toBeGreaterThan(0)
    const split = _lastTopLevelComma('size([(n)-->(m) | 1, 2]), 0.9')
    expect('size([(n)-->(m) | 1, 2]), 0.9'.slice(0, split).trim()).toBe('size([(n)-->(m) | 1, 2])')
  })

  it('handles unbalanced parens gracefully (never throws)', () => {
    expect(_lastTopLevelComma('a, (b, c')).toBe(1)
  })
})

// ── 2. _parseAggregate — two-argument percentile parsing ──

describe('_parseAggregate — percentile argument splitting', () => {
  it('splits percentileDisc(value, p) into field + pctArg', () => {
    const r = _parseAggregate('percentileDisc(n.price, 0.5)')
    expect(r).not.toBeNull()
    expect(r!.fn).toBe('PERCENTILEDISC')
    expect(r!.field).toBe('n.price')
    expect(r!.prop).toBe('price')
    expect(r!.pctArg).toBe('0.5')
  })

  it('splits percentileCont(value, p)', () => {
    const r = _parseAggregate('percentileCont(n.price, 0.90)')
    expect(r!.fn).toBe('PERCENTILECONT')
    expect(r!.field).toBe('n.price')
    expect(r!.pctArg).toBe('0.90')
  })

  it('keeps a nested comma inside the value expression intact', () => {
    const r = _parseAggregate('percentileDisc(size([(n)-->(m) | 1, 0]), 0.5)')
    expect(r!.field).toBe('size([(n)-->(m) | 1, 0])')
    expect(r!.pctArg).toBe('0.5')
  })

  it('returns null pctArg when no comma is present', () => {
    const r = _parseAggregate('percentileDisc(n.price)')
    expect(r!.pctArg).toBeNull()
    expect(r!.field).toBe('n.price')
  })
})

// ── 3. _computeAggregate — nearest-rank / interpolation / range errors ──

describe('_computeAggregate — percentile computation', () => {
  const vals = [10, 20, 30]

  it('percentileDisc p=0.0 returns the minimum', () => {
    expect(_computeAggregate('PERCENTILEDISC', vals, '0.0')).toBe(10)
  })

  it('percentileDisc p=0.5 returns the median', () => {
    expect(_computeAggregate('PERCENTILEDISC', vals, '0.5')).toBe(20)
  })

  it('percentileDisc p=1.0 returns the maximum', () => {
    expect(_computeAggregate('PERCENTILEDISC', vals, '1.0')).toBe(30)
  })

  it('percentileCont p=0.0 / 1.0 return the endpoints', () => {
    expect(_computeAggregate('PERCENTILECONT', vals, '0.0')).toBe(10)
    expect(_computeAggregate('PERCENTILECONT', vals, '1.0')).toBe(30)
  })

  it('percentileCont p=0.5 interpolates the median', () => {
    expect(_computeAggregate('PERCENTILECONT', vals, '0.5')).toBe(20)
  })

  it('percentileCont interpolates between surrounding ranks', () => {
    // 4 values → pos = p*(n-1); p=0.5 → pos=1.5 between 20 and 30 → 25
    expect(_computeAggregate('PERCENTILECONT', [10, 20, 30, 40], '0.5')).toBe(25)
  })

  it('sorts the input before computing the percentile', () => {
    expect(_computeAggregate('PERCENTILEDISC', [30, 10, 20], '0.5')).toBe(20)
  })

  it('returns null for an empty value set', () => {
    expect(_computeAggregate('PERCENTILEDISC', [], '0.5')).toBeNull()
    expect(_computeAggregate('PERCENTILECONT', [], '0.5')).toBeNull()
  })

  it('ignores non-numeric values (null entries filtered out)', () => {
    // [10, null, 30] → numeric list [10, 30]; p=0.5 → ceil(0.5*2)-1 = 0 → 10
    expect(_computeAggregate('PERCENTILEDISC', [10, null, 30], '0.5')).toBe(10)
  })

  it('percentile < 0 raises NumberOutOfRange', () => {
    expectNumberOutOfRange(() => _computeAggregate('PERCENTILEDISC', vals, '-1'))
  })

  it('percentile > 1 raises NumberOutOfRange', () => {
    expectNumberOutOfRange(() => _computeAggregate('PERCENTILEDISC', vals, '1.1'))
    expectNumberOutOfRange(() => _computeAggregate('PERCENTILECONT', vals, '1000'))
  })

  it('non-numeric percentile raises NumberOutOfRange via NaN', () => {
    expectNumberOutOfRange(() => _computeAggregate('PERCENTILEDISC', vals, 'abc'))
  })

  it('numeric pctArg (pre-resolved) is honoured over the string form', () => {
    expect(_computeAggregate('PERCENTILEDISC', [10, 20, 30], 0.5 as any)).toBe(20)
  })
})

// ── 4. _evaluateExpression — first-class percentile functions ──

describe('_evaluateExpression — percentileDisc/percentileCont functions', () => {
  it('percentileDisc([10,20,30], 0.5) = 20', () => {
    expect(_evaluateExpression('percentileDisc([10,20,30], 0.5)', {})).toBe(20)
  })

  it('percentileCont([10,20,30,40], 0.5) = 25', () => {
    expect(_evaluateExpression('percentileCont([10,20,30,40], 0.5)', {})).toBe(25)
  })

  it('percentileDisc with data-driven percentile > 1 raises NumberOutOfRange', () => {
    expectNumberOutOfRange(() => _evaluateExpression('percentileDisc(0.90, deg)', { deg: 3 }))
  })

  it('percentileDisc(-1) raises NumberOutOfRange', () => {
    expectNumberOutOfRange(() => _evaluateExpression('percentileDisc([10,20,30], -1)', {}))
  })

  it('returns null for a non-list value', () => {
    expect(_evaluateExpression('percentileDisc(nothing, 0.5)', { nothing: 42 })).toBeNull()
  })

  it('returns null for an empty list', () => {
    expect(_evaluateExpression('percentileDisc([], 0.5)', {})).toBeNull()
    expect(_evaluateExpression('percentileCont([], 0.5)', {})).toBeNull()
  })
})

// ── 5. size on a pattern comprehension (node degree) ──

describe('_evaluateExpression — size of pattern comprehension', () => {
  it('size([(n)-->() | 1]) returns the out-degree', () => {
    const n = {
      _label: 'S',
      __edges: [
        { srcIdx: 0, dstIdx: 100, label: 'REL' },
        { srcIdx: 0, dstIdx: 101, label: 'REL' },
        { srcIdx: 0, dstIdx: 102, label: 'REL' },
      ],
    }
    expect(_evaluateExpression('size([(n)-->() | 1])', { n })).toBe(3)
  })

  it('size([(n)-->() | 1]) returns 0 when the node has no edges', () => {
    const n = { _label: 'S', __edges: [] }
    expect(_evaluateExpression('size([(n)-->() | 1])', { n })).toBe(0)
  })

  it('size of a labelled pattern comprehension filters by edge label', () => {
    const a = {
      _label: 'X',
      __edges: [
        { srcIdx: 0, dstIdx: 1, label: 'T' },
        { srcIdx: 0, dstIdx: 2, label: 'T' },
        { srcIdx: 0, dstIdx: 3, label: 'OTHER' },
      ],
    }
    expect(_evaluateExpression('size([(a)-[:T]->() | 1])', { a })).toBe(2)
  })
})
