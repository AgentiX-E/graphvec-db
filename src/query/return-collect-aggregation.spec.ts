/**
 * return-collect-aggregation.spec.ts — RETURN-expression cross-row collect aggregation
 *
 * Covers two executor-unwind-pipeline fixes:
 *
 * 1. Cross-row `collect(...)` nested inside a RETURN list predicate
 *    (`ALL(ok IN collect(...) WHERE ok)`) must gather over *all* UNWIND rows,
 *    not the per-row single-element list.  Materialized via
 *    `_materializeReturnAggregates` + `_evalExprWithCrossRowCollect`.
 *
 * 2. The WITH-WHERE filter must be bracket-aware, so a `WHERE` inside a list
 *    predicate (`ALL(... WHERE ok)`) is not mistaken for a top-level WITH-WHERE
 *    (which previously wiped all rows via an undefined variable).
 */
import { describe, it, expect } from 'vitest'
import { parseQuery, _executeQuery } from '../query/query-engine'

async function run(query: string): Promise<unknown> {
  const plan = parseQuery(query) as any
  return await _executeQuery(plan, [], query)
}

describe('RETURN-expression cross-row collect aggregation', () => {
  it('ALL(v IN collect(x) WHERE predicate) aggregates across UNWIND rows', async () => {
    const r = await run(
      'WITH [1, 2, 3] AS xs UNWIND xs AS x RETURN ALL(v IN collect(x) WHERE v > 0) AS ok',
    )
    expect(r).toEqual([{ ok: true }])
  })

  it('ALL(...) with an unsatisfied predicate yields false (not an empty row)', async () => {
    const r = await run(
      'WITH [1, -2, 3] AS xs UNWIND xs AS x RETURN ALL(v IN collect(x) WHERE v > 0) AS ok',
    )
    expect(r).toEqual([{ ok: false }])
  })

  it('size(collect(x)) counts all rows', async () => {
    const r = await run(
      'WITH [1, 2, 3] AS xs UNWIND xs AS x RETURN size(collect(x)) AS n',
    )
    expect(r).toEqual([{ n: 3 }])
  })

  it('multi-UNWIND cross-product collects the full cartesian product (List11 [3])', async () => {
    const q =
      'WITH 0 AS start, [1, 2, 500, 1000, 1500] AS stopList, [-1000, -3, -2, -1, 1, 2, 3, 1000] AS stepList ' +
      'UNWIND stopList AS stop UNWIND stepList AS step ' +
      'WITH start, stop, step, range(start, stop, step) AS list ' +
      'WITH start, stop, step, list, sign(stop-start) <> sign(step) AS empty ' +
      'RETURN ALL(ok IN collect((size(list) = 0) = empty) WHERE ok) AS okay'
    const r = await run(q)
    expect(r).toEqual([{ okay: true }])
  })

  it('collect([...]) literal-list builder is NOT cross-row aggregated', async () => {
    const r = await run(
      'WITH 1 AS a, 2 AS b RETURN collect([a, b]) AS lit',
    )
    expect(r).toEqual([{ lit: [[1, 2]] }])
  })

  it('top-level collect(x) AS y (plan.aggregate) is left to the aggregate path', async () => {
    // plan.aggregate is synthesized for a top-level collect; our cross-row
    // materializer must not collapse these rows (that is a separate concern).
    const r = await run(
      'WITH [1, 2, 3] AS xs UNWIND xs AS x RETURN collect(x) AS allx',
    )
    // Current behaviour: the top-level-aggregation-in-UNWIND path is still
    // per-row (3 rows).  Guard against accidental regression to a single row.
    expect(r).toHaveLength(3)
  })
})

describe('WITH-WHERE filter is bracket-aware', () => {
  it('a real WITH ... WHERE filter still filters rows', async () => {
    const r = await run(
      'WITH [1, 2, 3] AS xs UNWIND xs AS x WITH x WHERE x > 1 RETURN x AS xi',
    )
    expect(r).toEqual([{ xi: 2 }, { xi: 3 }])
  })

  it('a WHERE inside a list predicate is not treated as a WITH-WHERE', async () => {
    // `WHERE ok` lives inside ALL(...), not as a top-level WITH-WHERE.  Before
    // the fix this wiped all rows; now it must return a single `true` row.
    const r = await run(
      'WITH [1, 2, 3] AS xs UNWIND xs AS x RETURN ALL(v IN collect(x) WHERE v IN [1, 2, 3]) AS ok',
    )
    expect(r).toEqual([{ ok: true }])
  })
})
