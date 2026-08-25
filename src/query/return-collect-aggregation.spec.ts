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

})

describe('UNWIND + top-level RETURN aggregation', () => {
  it('count(x) aggregates across UNWIND rows', async () => {
    const r = await run('WITH [1, 2, 3] AS xs UNWIND xs AS x RETURN count(x) AS n')
    expect(r).toEqual([{ n: 3 }])
  })

  it('count(*) aggregates across UNWIND rows', async () => {
    const r = await run('WITH [1, 2, 3] AS xs UNWIND xs AS x RETURN count(*) AS c')
    expect(r).toEqual([{ c: 3 }])
  })

  it('sum(x) aggregates across UNWIND rows', async () => {
    const r = await run('WITH [1, 2, 3] AS xs UNWIND xs AS x RETURN sum(x) AS s')
    expect(r).toEqual([{ s: 6 }])
  })

  it('avg(x) aggregates across UNWIND rows', async () => {
    const r = await run('WITH [1, 2, 3] AS xs UNWIND xs AS x RETURN avg(x) AS a')
    expect(r).toEqual([{ a: 2 }])
  })

  it('max(x) / min(x) aggregate across UNWIND rows', async () => {
    const mx = await run('WITH [1, 2, 3] AS xs UNWIND xs AS x RETURN max(x) AS m')
    const mn = await run('WITH [1, 2, 3] AS xs UNWIND xs AS x RETURN min(x) AS m')
    expect(mx).toEqual([{ m: 3 }])
    expect(mn).toEqual([{ m: 1 }])
  })

  it('max(x) / min(x) work over strings (lexicographic)', async () => {
    const mx = await run("UNWIND ['b', 'a', 'c'] AS x RETURN max(x) AS m")
    const mn = await run("UNWIND ['b', 'a', 'c'] AS x RETURN min(x) AS m")
    expect(mx).toEqual([{ m: 'c' }])
    expect(mn).toEqual([{ m: 'a' }])
  })

  it('max(x) / min(x) work over lists (lexicographic)', async () => {
    const mx = await run('UNWIND [[3], [1, 2], [1]] AS x RETURN max(x) AS m')
    const mn = await run('UNWIND [[3], [1, 2], [1]] AS x RETURN min(x) AS m')
    expect(mx).toEqual([{ m: [3] }])
    expect(mn).toEqual([{ m: [1] }])
  })

  it('max(x) / min(x) over mixed types follow Cypher value hierarchy', async () => {
    // hierarchy (least → greatest): list < string < boolean < number
    const mx = await run("UNWIND [1, 'a', null, [1, 2], 0.2, 'b'] AS x RETURN max(x) AS m")
    const mn = await run("UNWIND [1, 'a', null, [1, 2], 0.2, 'b'] AS x RETURN min(x) AS m")
    expect(mx).toEqual([{ m: 1 }])
    expect(mn).toEqual([{ m: [1, 2] }])
  })

  it('collect(x) aggregates across UNWIND rows into a single list', async () => {
    const r = await run('WITH [1, 2, 3] AS xs UNWIND xs AS x RETURN collect(x) AS allx')
    expect(r).toEqual([{ allx: [1, 2, 3] }])
  })

  it('multi-UNWIND cross-product is counted over all rows', async () => {
    // 5 stops × 8 steps = 40 rows
    const r = await run(
      'WITH [1, 2] AS a, [10, 20, 30] AS b UNWIND a AS x UNWIND b AS y RETURN count(*) AS c',
    )
    expect(r).toEqual([{ c: 6 }])
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
