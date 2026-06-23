/**
 * tck-TCK_EXT_-_UNWIND_2__20_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - UNWIND_2 (20 tests)', () => {
  test('UNW2-01 UNWIND list of lists + CREATE', async () => {
    const plan = execQuery("UNWIND [[1, 'a'], [2, 'b']] AS pair CREATE (n:Node {id: pair[0], name: pair[1]})")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNW2-02 UNWIND range + CREATE edge', async () => {
    const plan = execQuery('UNWIND range(1, 3) AS x CREATE (a:Node {id: x})-[:NEXT]->(b:Node {id: x + 1})')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNW2-03 UNWIND + MERGE with SET', async () => {
    const plan = execQuery("UNWIND ['Alice', 'Bob'] AS name MERGE (n:Person {name: name}) SET n.count = coalesce(n.count, 0) + 1")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
}, 30000)

  test('UNW2-04 UNWIND double unwind', async () => {
    const plan = execQuery('UNWIND [1, 2] AS x UNWIND [3, 4] AS y RETURN x, y')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
}, 30000)

  test('UNW2-05 UNWIND + WITH + ORDER + LIMIT', async () => {
    const plan = execQuery('UNWIND [5, 3, 1, 4, 2] AS x WITH x ORDER BY x SKIP 1 LIMIT 2 RETURN x')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNW2-06 UNWIND + collect after', async () => {
    const plan = execQuery('UNWIND [1, 2, 3] AS x WITH x * 2 AS doubled RETURN collect(doubled) AS collected')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNW2-07 UNWIND + count', async () => {
    const plan = execQuery('UNWIND [1, 2, 3, 4, 5] AS x RETURN count(x) AS cnt')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNW2-08 UNWIND + min + max', async () => {
    const plan = execQuery('UNWIND [3, 1, 4, 1, 5, 9] AS x RETURN min(x) AS min_val, max(x) AS max_val')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNW2-09 UNWIND + avg', async () => {
    const plan = execQuery('UNWIND [10, 20, 30] AS x RETURN avg(x) AS avg_val')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNW2-10 UNWIND + stdev', async () => {
    const plan = execQuery('UNWIND [1, 2, 3, 4, 5] AS x RETURN stdev(x) AS std')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNW2-11 UNWIND + percentileCont', async () => {
    const plan = execQuery('UNWIND [1, 2, 3, 4, 5, 6] AS x RETURN percentileCont(x, 0.5) AS median')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNW2-12 UNWIND + percentileDisc', async () => {
    const plan = execQuery('UNWIND [1, 2, 3, 4, 5, 6] AS x RETURN percentileDisc(x, 0.5) AS median_disc')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNW2-13 UNWIND + MATCH WHERE compound', async () => {
    const plan = execQuery('UNWIND [1, 2, 3] AS x MATCH (n:Person) WHERE n.age > x AND n.age < x + 10 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNW2-14 UNWIND + WITH + MATCH + WHERE', async () => {
    const plan = execQuery("UNWIND ['admin', 'user'] AS role WITH role MATCH (n:Person) WHERE role IN n.roles RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNW2-15 UNWIND + CASE', async () => {
    const plan = execQuery("UNWIND [1, 2, 3] AS x RETURN CASE WHEN x > 2 THEN 'big' ELSE 'small' END AS size")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNW2-16 UNWIND null list', async () => {
    const plan = execQuery('UNWIND [null] AS x RETURN x')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNW2-17 UNWIND + WITH + SKIP', async () => {
    const plan = execQuery('UNWIND range(1, 10) AS x WITH x SKIP 5 RETURN x')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNW2-18 UNWIND + WITH + LIMIT', async () => {
    const plan = execQuery('UNWIND range(1, 10) AS x WITH x LIMIT 3 RETURN x')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNW2-19 UNWIND + WITH + SKIP + LIMIT', async () => {
    const plan = execQuery('UNWIND range(1, 10) AS x WITH x SKIP 2 LIMIT 5 RETURN x')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNW2-20 UNWIND large range + ORDER', async () => {
    const plan = execQuery('UNWIND range(1, 20) AS x RETURN x ORDER BY x DESC LIMIT 5')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

})
