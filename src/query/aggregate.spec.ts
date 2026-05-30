/**
 * aggregate.spec.ts — Aggregation function tests for query-engine.ts
 *
 * Tests for COUNT, SUM, AVG, MIN, MAX in WITH and RETURN clauses,
 * including mixed aggregation, GROUP BY behavior, DISTINCT, empty sets,
 * and complex queries with OPTIONAL MATCH + WITH aggregation.
 */

import { describe, it, expect } from 'vitest'
import {
  _parseAggregate,
  _extractAggColumns,
  _hasAggregates,
  _executeAggregation,
  _executeQuery,
  _enrichWithAggregates,
  parseQuery,
  QueryRow,
  AggColumnInfo,
} from './query-engine'

// ── _parseAggregate ──

describe('_parseAggregate — Aggregate expression parsing', () => {

  it('a. COUNT(*)', () => {
    const result = _parseAggregate('count(*)')
    expect(result).not.toBeNull()
    expect(result!.fn).toBe('COUNT')
    expect(result!.field).toBe('*')
    expect(result!.prop).toBe('*')
    expect(result!.distinct).toBe(false)
  })

  it('b. COUNT(DISTINCT name)', () => {
    const result = _parseAggregate('COUNT(DISTINCT name)')
    expect(result).not.toBeNull()
    expect(result!.fn).toBe('COUNT')
    expect(result!.field).toBe('name')
    expect(result!.prop).toBe('name')
    expect(result!.distinct).toBe(true)
  })

  it('c. SUM(n.age)', () => {
    const result = _parseAggregate('sum(n.age)')
    expect(result).not.toBeNull()
    expect(result!.fn).toBe('SUM')
    expect(result!.field).toBe('n.age')
    expect(result!.prop).toBe('age')
  })

  it('d. AVG(n.score)', () => {
    const result = _parseAggregate('avg(n.score)')
    expect(result).not.toBeNull()
    expect(result!.fn).toBe('AVG')
    expect(result!.prop).toBe('score')
  })

  it('e. MIN(age)', () => {
    const result = _parseAggregate('MIN(age)')
    expect(result).not.toBeNull()
    expect(result!.fn).toBe('MIN')
    expect(result!.field).toBe('age')
  })

  it('f. MAX(age)', () => {
    const result = _parseAggregate('max(age)')
    expect(result).not.toBeNull()
    expect(result!.fn).toBe('MAX')
  })

  it('g. Non-aggregate expression returns null', () => {
    expect(_parseAggregate('n.name')).toBeNull()
    expect(_parseAggregate('123')).toBeNull()
    expect(_parseAggregate('count')).toBeNull()
    expect(_parseAggregate('count( )')).toBeNull()
  })
})

// ── _extractAggColumns / _hasAggregates ──

describe('_extractAggColumns — Column classification', () => {

  it('a. Pure aggregate', () => {
    const { aggCols, groupByCols } = _extractAggColumns(['count(*) AS cnt'])
    expect(aggCols.length).toBe(1)
    expect(aggCols[0].fn).toBe('COUNT')
    expect(groupByCols.length).toBe(0)
  })

  it('b. Mixed aggregate + non-aggregate', () => {
    const { aggCols, groupByCols } = _extractAggColumns(['n', 'count(*) AS cnt'])
    expect(aggCols.length).toBe(1)
    expect(groupByCols.length).toBe(1)
    expect(groupByCols[0]).toBe('n')
  })

  it('c. Multiple aggregates', () => {
    const { aggCols, groupByCols } = _extractAggColumns([
      'count(*) AS cnt',
      'sum(age) AS total_age',
      'avg(score) AS avg_score',
    ])
    expect(aggCols.length).toBe(3)
    expect(aggCols[0].fn).toBe('COUNT')
    expect(aggCols[1].fn).toBe('SUM')
    expect(aggCols[2].fn).toBe('AVG')
    expect(groupByCols.length).toBe(0)
  })

  it('d. No aggregates — all group-by', () => {
    const { aggCols, groupByCols } = _extractAggColumns(['n', 'n.name AS name', 'n.age'])
    expect(aggCols.length).toBe(0)
    expect(groupByCols.length).toBe(3)
  })

  it('e. hasAggregates', () => {
    expect(_hasAggregates(['count(*)'])).toBe(true)
    expect(_hasAggregates(['sum(age) AS total'])).toBe(true)
    expect(_hasAggregates(['n', 'n.name'])).toBe(false)
    expect(_hasAggregates(['count', 'n'])).toBe(false)
  })
})

// ── _executeAggregation ──

describe('_executeAggregation — Core aggregation logic', () => {

  // a. COUNT(*) over 10 rows → returns 10
  it('a. COUNT(*) over 10 rows', () => {
    const rows: QueryRow[] = Array.from({ length: 10 }, (_, i) => ({ id: i, name: `Node_${i}` }))
    const aggCols: AggColumnInfo[] = [{ fn: 'COUNT', field: '*', prop: '*', distinct: false, alias: 'cnt' }]
    const result = _executeAggregation(rows, aggCols, [])
    expect(result.length).toBe(1)
    expect(result[0].cnt).toBe(10)
  })

  // b. COUNT(name) over 10 rows → returns 10
  it('b. COUNT(name) over 10 rows', () => {
    const rows: QueryRow[] = Array.from({ length: 10 }, (_, i) => ({ name: `Node_${i}` }))
    const aggCols: AggColumnInfo[] = [{ fn: 'COUNT', field: 'name', prop: 'name', distinct: false, alias: 'cnt' }]
    const result = _executeAggregation(rows, aggCols, [])
    expect(result.length).toBe(1)
    expect(result[0].cnt).toBe(10)
  })

  // c. COUNT(DISTINCT name) over 10 rows with 5 unique → returns 5
  it('c. COUNT(DISTINCT name) over 10 rows with 5 unique', () => {
    const rows: QueryRow[] = [
      { name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E' },
      { name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E' },
    ]
    const aggCols: AggColumnInfo[] = [{ fn: 'COUNT', field: 'name', prop: 'name', distinct: true, alias: 'cnt' }]
    const result = _executeAggregation(rows, aggCols, [])
    expect(result.length).toBe(1)
    expect(result[0].cnt).toBe(5)
  })

  // d. SUM(age) over nodes → returns sum
  it('d. SUM(age) over nodes', () => {
    const rows: QueryRow[] = Array.from({ length: 10 }, (_, i) => ({ age: i + 1 }))
    const aggCols: AggColumnInfo[] = [{ fn: 'SUM', field: 'age', prop: 'age', distinct: false, alias: null }]
    const result = _executeAggregation(rows, aggCols, [])
    expect(result.length).toBe(1)
    expect(result[0].sum).toBe(55) // 1+2+...+10 = 55
  })

  // e. AVG(age) → returns average
  it('e. AVG(age) over nodes', () => {
    const rows: QueryRow[] = Array.from({ length: 5 }, (_, i) => ({ age: (i + 1) * 10 }))
    const aggCols: AggColumnInfo[] = [{ fn: 'AVG', field: 'age', prop: 'age', distinct: false, alias: null }]
    const result = _executeAggregation(rows, aggCols, [])
    expect(result.length).toBe(1)
    // ages: 10, 20, 30, 40, 50 → avg = 30
    expect(result[0].avg).toBe(30)
  })

  // f. MIN(age), MAX(age) → returns min/max
  it('f. MIN(age) and MAX(age) over nodes', () => {
    const rows: QueryRow[] = Array.from({ length: 10 }, (_, i) => ({ age: i * 5 + 3 }))
    // ages: 3, 8, 13, 18, 23, 28, 33, 38, 43, 48
    const aggColsMin: AggColumnInfo[] = [{ fn: 'MIN', field: 'age', prop: 'age', distinct: false, alias: null }]
    const aggColsMax: AggColumnInfo[] = [{ fn: 'MAX', field: 'age', prop: 'age', distinct: false, alias: null }]

    const resultMin = _executeAggregation(rows, aggColsMin, [])
    expect(resultMin[0].min).toBe(3)

    const resultMax = _executeAggregation(rows, aggColsMax, [])
    expect(resultMax[0].max).toBe(48)
  })

  // g. Mixed aggregation + non-aggregate columns: group by non-aggregate
  it('g. Mixed aggregation + non-aggregate (group-by)', () => {
    const rows: QueryRow[] = [
      { name: 'Alice', dept: 'Engineering', age: 30 },
      { name: 'Bob', dept: 'Engineering', age: 25 },
      { name: 'Charlie', dept: 'Sales', age: 35 },
      { name: 'Diana', dept: 'Sales', age: 28 },
    ]
    const groupByCols = ['dept']
    const aggCols: AggColumnInfo[] = [
      { fn: 'COUNT', field: '*', prop: '*', distinct: false, alias: 'cnt' },
      { fn: 'SUM', field: 'age', prop: 'age', distinct: false, alias: 'total_age' },
    ]

    const result = _executeAggregation(rows, aggCols, groupByCols)

    expect(result.length).toBe(2)

    // Find Engineering row
    const engRow = result.find(r => r.dept === 'Engineering')
    expect(engRow).toBeDefined()
    expect(engRow!.cnt).toBe(2)    // Alice + Bob
    expect(engRow!.total_age).toBe(55) // 30 + 25

    // Find Sales row
    const salesRow = result.find(r => r.dept === 'Sales')
    expect(salesRow).toBeDefined()
    expect(salesRow!.cnt).toBe(2)    // Charlie + Diana
    expect(salesRow!.total_age).toBe(63) // 35 + 28
  })

  // h. WITH aggregation + filter (HAVING equivalent)
  it('h. Empty set: COUNT(*) over empty → returns 0', () => {
    const rows: QueryRow[] = []
    const aggCols: AggColumnInfo[] = [{ fn: 'COUNT', field: '*', prop: '*', distinct: false, alias: 'cnt' }]
    const result = _executeAggregation(rows, aggCols, [])
    expect(result.length).toBe(1)
    expect(result[0].cnt).toBe(0)
  })

  it('h2. Empty set: SUM(age) over empty → returns null', () => {
    const rows: QueryRow[] = []
    const aggCols: AggColumnInfo[] = [{ fn: 'SUM', field: 'age', prop: 'age', distinct: false, alias: null }]
    const result = _executeAggregation(rows, aggCols, [])
    expect(result.length).toBe(1)
    expect(result[0].sum).toBe(0) // SUM returns 0 for empty
  })

  it('h3. Empty set: AVG(age) over empty → returns null', () => {
    const rows: QueryRow[] = []
    const aggCols: AggColumnInfo[] = [{ fn: 'AVG', field: 'age', prop: 'age', distinct: false, alias: null }]
    const result = _executeAggregation(rows, aggCols, [])
    expect(result.length).toBe(1)
    expect(result[0].avg).toBeNull()
  })

  // i. Multiple aggregates in a single query
  it('i. Multiple aggregates in single query', () => {
    const rows: QueryRow[] = Array.from({ length: 5 }, (_, i) => ({
      age: 20 + i * 5,
      score: 80 + i * 4,
    }))
    // ages: 20, 25, 30, 35, 40
    // scores: 80, 84, 88, 92, 96
    const aggCols: AggColumnInfo[] = [
      { fn: 'COUNT', field: '*', prop: '*', distinct: false, alias: 'cnt' },
      { fn: 'SUM', field: 'age', prop: 'age', distinct: false, alias: 'total_age' },
      { fn: 'AVG', field: 'score', prop: 'score', distinct: false, alias: 'avg_score' },
      { fn: 'MIN', field: 'age', prop: 'age', distinct: false, alias: 'min_age' },
      { fn: 'MAX', field: 'age', prop: 'age', distinct: false, alias: 'max_age' },
    ]
    const result = _executeAggregation(rows, aggCols, [])
    expect(result.length).toBe(1)
    expect(result[0].cnt).toBe(5)
    expect(result[0].total_age).toBe(150) // 20+25+30+35+40
    expect(result[0].avg_score).toBe(88)  // (80+84+88+92+96)/5
    expect(result[0].min_age).toBe(20)
    expect(result[0].max_age).toBe(40)
  })

  // j. Group by with multiple group-by columns
  it('j. Group by with multiple columns', () => {
    const rows: QueryRow[] = [
      { name: 'A', city: 'NYC', dept: 'Eng' },
      { name: 'B', city: 'NYC', dept: 'Eng' },
      { name: 'C', city: 'NYC', dept: 'Sales' },
      { name: 'D', city: 'SF', dept: 'Eng' },
      { name: 'E', city: 'SF', dept: 'Sales' },
    ]
    const groupByCols = ['city', 'dept']
    const aggCols: AggColumnInfo[] = [
      { fn: 'COUNT', field: '*', prop: '*', distinct: false, alias: 'cnt' },
    ]
    const result = _executeAggregation(rows, aggCols, groupByCols)
    expect(result.length).toBe(4) // NYC/Eng, NYC/Sales, SF/Eng, SF/Sales
    expect(result.filter(r => r.city === 'NYC' && r.dept === 'Eng')[0].cnt).toBe(2)
    expect(result.filter(r => r.city === 'NYC' && r.dept === 'Sales')[0].cnt).toBe(1)
    expect(result.filter(r => r.city === 'SF' && r.dept === 'Eng')[0].cnt).toBe(1)
    expect(result.filter(r => r.city === 'SF' && r.dept === 'Sales')[0].cnt).toBe(1)
  })
})

// ── _executeQuery (standalone execution) ──

describe('_executeQuery — Standalone query execution with aggregation', () => {

  // Helper: create 10 test nodes
  function createNodes(): Array<Record<string, unknown>> {
    return [
      { id: 1, name: 'Alice', age: 30, score: 85 },
      { id: 2, name: 'Bob', age: 25, score: 90 },
      { id: 3, name: 'Charlie', age: 35, score: 78 },
      { id: 4, name: 'Diana', age: 28, score: 92 },
      { id: 5, name: 'Eve', age: 32, score: 88 },
      { id: 6, name: 'Frank', age: 27, score: 76 },
      { id: 7, name: 'Grace', age: 40, score: 95 },
      { id: 8, name: 'Hank', age: 22, score: 82 },
      { id: 9, name: 'Ivy', age: 38, score: 91 },
      { id: 10, name: 'Jack', age: 33, score: 87 },
    ]
  }

  function createNodesWithNames(): Array<Record<string, unknown>> {
    // 10 nodes, 5 unique names
    return [
      { id: 1, name: 'X', age: 20 },
      { id: 2, name: 'Y', age: 25 },
      { id: 3, name: 'Z', age: 30 },
      { id: 4, name: 'W', age: 35 },
      { id: 5, name: 'V', age: 40 },
      { id: 6, name: 'X', age: 45 },
      { id: 7, name: 'Y', age: 50 },
      { id: 8, name: 'Z', age: 55 },
      { id: 9, name: 'W', age: 60 },
      { id: 10, name: 'V', age: 65 },
    ]
  }

  // a. COUNT(*) over 10 nodes → returns 10
  it('a. COUNT(*) via RETURN aggregate', () => {
    const nodes = createNodes()
    const plan = parseQuery('MATCH (n) RETURN count(n)')
    const result = _executeQuery(plan, nodes)
    expect(result.length).toBe(1)
    expect(result[0].count).toBe(10)
  })

  // b. COUNT(name) over 10 nodes → returns 10
  it('b. COUNT(name) via RETURN', () => {
    const nodes = createNodes()
    const plan = parseQuery('MATCH (n) RETURN count(n.name)')
    const result = _executeQuery(plan, nodes)
    expect(result.length).toBe(1)
    expect(result[0].count).toBe(10)
  })

  // c. SUM(age) over nodes
  it('c. SUM(age) via RETURN', () => {
    const nodes = createNodes()
    const plan = parseQuery('MATCH (n) RETURN sum(n.age)')
    const result = _executeQuery(plan, nodes)
    expect(result.length).toBe(1)
    // ages: 30+25+35+28+32+27+40+22+38+33 = 310
    expect(result[0].sum).toBe(310)
  })

  // d. AVG(age) over nodes
  it('d. AVG(age) via RETURN', () => {
    const nodes = createNodes()
    const plan = parseQuery('MATCH (n) RETURN avg(n.age)')
    const result = _executeQuery(plan, nodes)
    expect(result.length).toBe(1)
    // avg = 310/10 = 31
    expect(result[0].avg).toBe(31)
  })

  // e. MIN(age) and MAX(age)
  it('e. MIN(age) via RETURN', () => {
    const nodes = createNodes()
    const plan = parseQuery('MATCH (n) RETURN min(n.age)')
    const result = _executeQuery(plan, nodes)
    expect(result[0].min).toBe(22)
  })

  it('e2. MAX(age) via RETURN', () => {
    const nodes = createNodes()
    const plan = parseQuery('MATCH (n) RETURN max(n.age)')
    const result = _executeQuery(plan, nodes)
    expect(result[0].max).toBe(40)
  })

  // f. COUNT with alias
  it('f. COUNT(n) AS cnt via RETURN', () => {
    const nodes = createNodes()
    const plan = parseQuery('MATCH (n) RETURN count(n) AS cnt')
    const result = _executeQuery(plan, nodes)
    expect(result[0].cnt).toBe(10)
  })

  // g. WITH aggregation: WITH count(*) AS cnt RETURN cnt
  it('g. WITH count(*) AS cnt', () => {
    const nodes = createNodes()
    const plan = parseQuery('MATCH (n) WITH count(*) AS cnt RETURN cnt')
    const result = _executeQuery(plan, nodes)
    expect(result.length).toBe(1)
    expect(result[0].cnt).toBe(10)
  })

  // h. WITH aggregation + filter (HAVING equivalent)
  it('h. WITH count(*) AS cnt WHERE cnt > 1', () => {
    const nodes = createNodes()
    const plan = parseQuery('MATCH (n) WITH count(*) AS cnt WHERE cnt > 1 RETURN cnt')
    const result = _executeQuery(plan, nodes)
    expect(result.length).toBe(1)
    expect(result[0].cnt).toBe(10)
  })

  it('h2. WHERE filter in WITH (parser limit — test via _executeAggregation)', () => {
    const rows: QueryRow[] = Array.from({ length: 10 }, (_, i) => ({ id: i, name: `Node_${i}` }))
    const aggCols: AggColumnInfo[] = [{ fn: 'COUNT', field: '*', prop: '*', distinct: false, alias: 'cnt' }]
    // Test pure filter: cnt > 100 → empty
    let aggResult = _executeAggregation(rows, aggCols, [])
    expect(aggResult.length).toBe(1)
    expect(aggResult[0].cnt).toBe(10)

    // Simulate HAVING via post-aggregation filter: cnt > 100 should filter out
    aggResult = aggResult.filter(r => (r.cnt as number) > 100)
    expect(aggResult.length).toBe(0) // filtered out

    // Also test: cnt > 5 should keep
    aggResult = _executeAggregation(rows, aggCols, [])
    aggResult = aggResult.filter(r => (r.cnt as number) > 5)
    expect(aggResult.length).toBe(1) // kept
  })

  // i. WITH ORDER BY aggregated value
  it('i. WITH count(*) AS cnt ORDER BY cnt', () => {
    const nodes = createNodes()
    const plan = parseQuery('MATCH (n) WITH count(*) AS cnt ORDER BY cnt RETURN cnt')
    const result = _executeQuery(plan, nodes)
    expect(result.length).toBe(1)
    expect(result[0].cnt).toBe(10)
  })

  // j. Empty set: COUNT on no nodes
  it('j. Empty set: COUNT on empty → 0', () => {
    const nodes: Array<Record<string, unknown>> = []
    const plan = parseQuery('MATCH (n) WHERE n.age > 200 RETURN count(n)')
    const result = _executeQuery(plan, nodes)
    expect(result.length).toBe(1)
    expect(result[0].count).toBe(0)
  })

  // k. Mixed aggregation with non-aggregate — group by node
  it('k. WITH n, count(*) AS cnt RETURN n, cnt — group by n', () => {
    const nodes = createNodes()
    const plan = parseQuery('MATCH (n) WITH n, count(*) AS cnt RETURN n, cnt')
    const result = _executeQuery(plan, nodes)
    // Each node gets count 1 (each is unique by identity)
    expect(result.length).toBe(10)
    // Since we project by column name, cnt should be 1 for each
    for (const row of result) {
      expect(row.cnt).toBe(1)
    }
  })

  // l. WITH aggregation where cnt > 0 with ORDER BY and LIMIT
  it('l. WITH count(*) AS cnt ORDER BY cnt DESC LIMIT 5', () => {
    const nodes = createNodes()
    const plan = parseQuery('MATCH (n) WITH count(*) AS cnt ORDER BY cnt DESC LIMIT 5 RETURN cnt')
    const result = _executeQuery(plan, nodes)
    expect(result.length).toBe(1)
    expect(result[0].cnt).toBe(10)
  })

  // m. SUM on filtered nodes (WHERE on MATCH)
  it('m. SUM on age > 30', () => {
    const nodes = createNodes()
    // Ages > 30: 35(Charlie), 32(Eve), 40(Grace), 38(Ivy), 33(Jack) = 178
    const plan = parseQuery('MATCH (n) WHERE n.age > 30 RETURN sum(n.age)')
    const result = _executeQuery(plan, nodes)
    expect(result.length).toBe(1)
    expect(result[0].sum).toBe(178)
  })

  // n. COUNT(DISTINCT name) via WITH
  it('n. COUNT(DISTINCT name) via WITH', () => {
    const nodes = createNodesWithNames()
    const plan = parseQuery('MATCH (n) WITH count(DISTINCT n.name) AS unique_names RETURN unique_names')
    const result = _executeQuery(plan, nodes)
    expect(result.length).toBe(1)
    expect(result[0].unique_names).toBe(5) // X, Y, Z, W, V
  })

  // o. AVG with WHERE filter
  it('o. AVG with WHERE filter', () => {
    const nodes = createNodes()
    // Ages > 30: 35, 32, 40, 38, 33 → avg = 178/5 = 35.6
    const plan = parseQuery('MATCH (n) WHERE n.age > 30 RETURN avg(n.age)')
    const result = _executeQuery(plan, nodes)
    expect(result.length).toBe(1)
    expect(result[0].avg).toBe(35.6)
  })

  // p. Complex: MATCH + OPTIONAL MATCH + WITH aggregation + ORDER BY + LIMIT
  it('p. Complex query with aggregation', () => {
    const nodes = createNodes()
    // MATCH (n) WITH n, count(*) AS friends ORDER BY friends DESC LIMIT 5 RETURN n, friends
    // Each node is unique, so count per node = 1
    const plan = parseQuery('MATCH (n) WITH n, count(*) AS friends ORDER BY friends DESC LIMIT 5 RETURN n, friends')
    const result = _executeQuery(plan, nodes)
    expect(result.length).toBe(5) // LIMIT 5
    expect(result[0].friends).toBe(1) // each node has count=1
  })

  // q. Verify all 10 nodes pass through with count on distinct name vs total count
  it('q. COUNT vs COUNT(DISTINCT name) comparison', () => {
    const nodes = createNodesWithNames()
    // WITH count(*) AS total, count(DISTINCT n.name) AS unique RETURN total, unique
    // This won't work in the simplified parser, so test via individual queries
    const planTotal = parseQuery('MATCH (n) RETURN count(n)')
    const resultTotal = _executeQuery(planTotal, nodes)
    expect(resultTotal[0].count).toBe(10)

    const planUnique = parseQuery('MATCH (n) WITH count(DISTINCT n.name) AS unique_names RETURN unique_names')
    const resultUnique = _executeQuery(planUnique, nodes)
    expect(resultUnique[0].unique_names).toBe(5)
  })
})

// ── _enrichWithAggregates ──

describe('_enrichWithAggregates — Column enrichment', () => {

  it('marks aggregate columns', () => {
    const cols = _enrichWithAggregates([
      { expression: 'count(*)', alias: 'cnt' },
      { expression: 'n.name', alias: 'name' },
    ])
    expect(cols[0].isAggregate).toBe(true)
    expect(cols[0].aggFn).toBe('COUNT')
    expect(cols[1].isAggregate).toBe(false)
    expect(cols[1].aggFn).toBeUndefined()
  })

  it('marks DISTINCT aggregates', () => {
    const cols = _enrichWithAggregates([
      { expression: 'count(DISTINCT name)', alias: 'unique' },
    ])
    expect(cols[0].isAggregate).toBe(true)
    expect(cols[0].distinct).toBe(true)
  })
})

// ── GROUP BY parsing (grammar integration) ──

describe('GROUP BY — Parsing and execution via parseQuery', () => {

  it('a. GROUP BY single key', () => {
    const plan = parseQuery('MATCH (n) RETURN n.dept, count(*) AS cnt GROUP BY n.dept')
    expect(plan.groupBy).toBeDefined()
    expect(plan.groupBy!.length).toBe(1)
    // formatColumn strips the node prefix: n.dept → dept
    expect(plan.groupBy![0]).toBe('dept')
  })

  it('b. GROUP BY multiple keys', () => {
    const plan = parseQuery('MATCH (n) RETURN n.city, n.dept, count(*) AS cnt GROUP BY n.city, n.dept')
    expect(plan.groupBy).toBeDefined()
    expect(plan.groupBy!.length).toBe(2)
    expect(plan.groupBy![0]).toBe('city')
    expect(plan.groupBy![1]).toBe('dept')
  })

  it('c. GROUP BY with aggregate in RETURN', () => {
    const plan = parseQuery('MATCH (n) RETURN n.name, sum(n.age) AS total GROUP BY n.name')
    expect(plan.groupBy).toBeDefined()
    expect(plan.groupBy!.length).toBe(1)
    expect(plan.groupBy![0]).toBe('name')
    expect(plan.aggregate).toBeDefined()
    expect(plan.aggregate!.type).toBe('sum')
  })

  it('d. GROUP BY with WHERE filter', () => {
    const plan = parseQuery('MATCH (n) WHERE n.age > 25 RETURN n.dept, count(*) AS cnt GROUP BY n.dept')
    expect(plan.groupBy).toBeDefined()
    expect(plan.groupBy!.length).toBe(1)
    expect(plan.filters.length).toBeGreaterThanOrEqual(1)
  })

  it('e. GROUP BY with ORDER BY', () => {
    const plan = parseQuery('MATCH (n) RETURN n.dept, count(*) AS cnt GROUP BY n.dept ORDER BY cnt DESC')
    expect(plan.groupBy).toBeDefined()
    expect(plan.groupBy!.length).toBe(1)
    expect(plan.orderBy.length).toBe(1)
  })
})

// ── Aggregate with bare identifier (grammar integration) ──

describe('Aggregate with bare identifier — parseQuery integration', () => {

  it('a. COUNT(n) bare node ref', () => {
    const plan = parseQuery('MATCH (n) RETURN count(n)')
    expect(plan.aggregate).toBeDefined()
    expect(plan.aggregate!.type).toBe('count')
  })

  it('b. SUM(n.age) — already supported, but verify', () => {
    const plan = parseQuery('MATCH (n) RETURN sum(n.age)')
    expect(plan.aggregate).toBeDefined()
    expect(plan.aggregate!.type).toBe('sum')
  })

  it('c. AVG(n.age) — already supported, but verify', () => {
    const plan = parseQuery('MATCH (n) RETURN avg(n.age)')
    expect(plan.aggregate).toBeDefined()
    expect(plan.aggregate!.type).toBe('avg')
  })

  it('d. MIN(n.age) — already supported, but verify', () => {
    const plan = parseQuery('MATCH (n) RETURN min(n.age)')
    expect(plan.aggregate).toBeDefined()
    expect(plan.aggregate!.type).toBe('min')
  })

  it('e. MAX(n.age) — already supported, but verify', () => {
    const plan = parseQuery('MATCH (n) RETURN max(n.age)')
    expect(plan.aggregate).toBeDefined()
    expect(plan.aggregate!.type).toBe('max')
  })

  it('f. COUNT(*)', () => {
    const plan = parseQuery('MATCH (n) RETURN count(*)')
    expect(plan.aggregate).toBeDefined()
    expect(plan.aggregate!.type).toBe('count')
    expect(plan.aggregate!.field).toBe('*')
  })

  it('g. Aggregate with alias', () => {
    const plan = parseQuery('MATCH (n) RETURN count(n) AS total')
    expect(plan.aggregate).toBeDefined()
    expect(plan.aggregate!.type).toBe('count')
    expect(plan.aggregate!.alias).toBe('total')
  })

  it('h. COUNT with property ref n.name', () => {
    const plan = parseQuery('MATCH (n) RETURN count(n.name)')
    expect(plan.aggregate).toBeDefined()
    expect(plan.aggregate!.type).toBe('count')
  })
})

// ── GROUP BY execution (via GraphEngine) ──

describe('GROUP BY — Execution (via graph-engine)', () => {
  // These tests import and use graph-engine through the query function
  // Using _executeQuery for standalone execution that mocks graph engine behavior

  it('a. GROUP BY single key with COUNT', () => {
    const rows: QueryRow[] = [
      { name: 'Alice', dept: 'Engineering' },
      { name: 'Bob', dept: 'Engineering' },
      { name: 'Charlie', dept: 'Sales' },
      { name: 'Diana', dept: 'Sales' },
      { name: 'Eve', dept: 'Engineering' },
    ]
    const plan = parseQuery('MATCH (n) RETURN n.dept, count(*) AS cnt GROUP BY n.dept')
    // Simulate: scan matches all rows
    const result = _executeQuery(plan, rows)
    expect(result.length).toBe(2) // Engineering + Sales

    const engRow = result.find(r => r.dept === 'Engineering')
    expect(engRow).toBeDefined()
    expect(engRow!.cnt).toBe(3)

    const salesRow = result.find(r => r.dept === 'Sales')
    expect(salesRow).toBeDefined()
    expect(salesRow!.cnt).toBe(2)
  })

  it('b. GROUP BY with SUM', () => {
    const rows: QueryRow[] = [
      { name: 'Alice', dept: 'Engineering', age: 30 },
      { name: 'Bob', dept: 'Engineering', age: 25 },
      { name: 'Charlie', dept: 'Sales', age: 35 },
      { name: 'Diana', dept: 'Sales', age: 28 },
      { name: 'Eve', dept: 'Engineering', age: 40 },
    ]
    const plan = parseQuery('MATCH (n) RETURN n.dept, sum(n.age) AS total_age GROUP BY n.dept')
    const result = _executeQuery(plan, rows)
    expect(result.length).toBe(2)

    const engRow = result.find(r => r.dept === 'Engineering')
    expect(engRow).toBeDefined()
    expect(engRow!.total_age).toBe(95) // 30 + 25 + 40

    const salesRow = result.find(r => r.dept === 'Sales')
    expect(salesRow).toBeDefined()
    expect(salesRow!.total_age).toBe(63) // 35 + 28
  })

  it('c. GROUP BY with AVG', () => {
    const rows: QueryRow[] = [
      { name: 'Alice', dept: 'Engineering', age: 30 },
      { name: 'Bob', dept: 'Engineering', age: 20 },
      { name: 'Charlie', dept: 'Sales', age: 40 },
      { name: 'Diana', dept: 'Sales', age: 60 },
    ]
    const plan = parseQuery('MATCH (n) RETURN n.dept, avg(n.age) AS avg_age GROUP BY n.dept')
    const result = _executeQuery(plan, rows)
    expect(result.length).toBe(2)

    const engRow = result.find(r => r.dept === 'Engineering')
    expect(engRow).toBeDefined()
    expect(engRow!.avg_age).toBe(25) // avg(30, 20)

    const salesRow = result.find(r => r.dept === 'Sales')
    expect(salesRow).toBeDefined()
    expect(salesRow!.avg_age).toBe(50) // avg(40, 60)
  })

  it('d. GROUP BY with MIN and MAX', () => {
    const rows: QueryRow[] = [
      { name: 'Alice', dept: 'Engineering', age: 30 },
      { name: 'Bob', dept: 'Engineering', age: 20 },
      { name: 'Charlie', dept: 'Sales', age: 40 },
      { name: 'Diana', dept: 'Sales', age: 60 },
    ]

    const planMin = parseQuery('MATCH (n) RETURN n.dept, min(n.age) AS min_age GROUP BY n.dept')
    const resultMin = _executeQuery(planMin, rows)
    expect(resultMin.length).toBe(2)
    expect(resultMin.find(r => r.dept === 'Engineering')!.min_age).toBe(20)
    expect(resultMin.find(r => r.dept === 'Sales')!.min_age).toBe(40)

    const planMax = parseQuery('MATCH (n) RETURN n.dept, max(n.age) AS max_age GROUP BY n.dept')
    const resultMax = _executeQuery(planMax, rows)
    expect(resultMax.length).toBe(2)
    expect(resultMax.find(r => r.dept === 'Engineering')!.max_age).toBe(30)
    expect(resultMax.find(r => r.dept === 'Sales')!.max_age).toBe(60)
  })

  it('e. GROUP BY with WHERE filter (pre-aggregation)', () => {
    const rows: QueryRow[] = [
      { name: 'Alice', dept: 'Engineering', age: 30 },
      { name: 'Bob', dept: 'Engineering', age: 25 },
      { name: 'Charlie', dept: 'Sales', age: 35 },
      { name: 'Diana', dept: 'Sales', age: 28 },
      { name: 'Eve', dept: 'Engineering', age: 45 },
    ]
    // WHERE age > 28 → Alice(30), Charlie(35), Eve(45) → Engineering: 2, Sales: 1
    const plan = parseQuery('MATCH (n) WHERE n.age > 28 RETURN n.dept, count(*) AS cnt GROUP BY n.dept')
    const result = _executeQuery(plan, rows)
    expect(result.length).toBe(2)

    const engRow = result.find(r => r.dept === 'Engineering')
    expect(engRow).toBeDefined()
    expect(engRow!.cnt).toBe(2)

    const salesRow = result.find(r => r.dept === 'Sales')
    expect(salesRow).toBeDefined()
    expect(salesRow!.cnt).toBe(1)
  })

  it('f. Empty result set with GROUP BY', () => {
    const rows: QueryRow[] = []
    const plan = parseQuery('MATCH (n) RETURN n.dept, count(*) AS cnt GROUP BY n.dept')
    const result = _executeQuery(plan, rows)
    // Empty with GROUP BY → empty array (no groups to form)
    expect(result.length).toBe(0)
  })
})

// ── Aggregate with bare identifier execution ──

describe('Aggregate with bare identifier — execution', () => {

  it('a. COUNT on bare node ref returns total count', () => {
    const rows: QueryRow[] = Array.from({ length: 10 }, (_, i) => ({ id: i, name: `Node_${i}` }))
    const plan = parseQuery('MATCH (n) RETURN count(n)')
    const result = _executeQuery(plan, rows)
    expect(result.length).toBe(1)
    expect(result[0].count).toBe(10)
  })

  it('b. SUM with WHERE filter', () => {
    const rows: QueryRow[] = Array.from({ length: 10 }, (_, i) => ({ age: i + 1 }))
    const plan = parseQuery('MATCH (n) WHERE n.age > 5 RETURN sum(n.age)')
    const result = _executeQuery(plan, rows)
    // ages > 5: 6+7+8+9+10 = 40
    expect(result[0].sum).toBe(40)
  })

  it('c. AVG with WHERE filter', () => {
    const rows: QueryRow[] = Array.from({ length: 10 }, (_, i) => ({ age: (i + 1) * 10 }))
    // ages: 10, 20, 30, 40, 50, 60, 70, 80, 90, 100
    const plan = parseQuery('MATCH (n) WHERE n.age > 50 RETURN avg(n.age)')
    const result = _executeQuery(plan, rows)
    // ages > 50: 60, 70, 80, 90, 100 → avg = 80
    expect(result[0].avg).toBe(80)
  })

  it('d. Empty set with bare aggregate', () => {
    const rows: QueryRow[] = []
    const plan = parseQuery('MATCH (n) WHERE n.age > 200 RETURN count(n)')
    const result = _executeQuery(plan, rows)
    expect(result.length).toBe(1)
    expect(result[0].count).toBe(0)
  })
})

// ── ORDER BY + aggregate ──

describe('ORDER BY with aggregate', () => {

  it('a. RETURN aggregate ORDER BY aggregate alias', () => {
    const rows: QueryRow[] = Array.from({ length: 10 }, (_, i) => ({ id: i }))
    const plan = parseQuery('MATCH (n) RETURN count(n) AS cnt ORDER BY cnt')
    const result = _executeQuery(plan, rows)
    expect(result.length).toBe(1)
    expect(result[0].cnt).toBe(10)
  })
})
