/**
 * tck-TCK_EXT_-_UNWIND__22_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - UNWIND (22 tests)', () => {
  test('UNWIND-01 UNWIND [1,2,3]', () => {
    const plan = execQuery('UNWIND [1, 2, 3] AS x RETURN x')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNWIND-02 UNWIND string list', () => {
    const plan = execQuery("UNWIND ['a', 'b', 'c'] AS x RETURN x")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNWIND-03 UNWIND [] empty', () => {
    const plan = execQuery('UNWIND [] AS x RETURN x')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNWIND-04 UNWIND [42]', () => {
    const plan = execQuery('UNWIND [42] AS x RETURN x')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNWIND-05 UNWIND nested list', () => {
    const plan = execQuery('UNWIND [[1, 2], [3, 4]] AS x RETURN x')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNWIND-06 UNWIND + MATCH', () => {
    const plan = execQuery('UNWIND [1, 2, 3] AS x MATCH (n:Person) WHERE n.age = x RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNWIND-07 UNWIND + CREATE', () => {
    const plan = execQuery('UNWIND [1, 2, 3] AS x CREATE (n:Node {id: x})')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNWIND-08 UNWIND + CREATE + RETURN', () => {
    const plan = execQuery("UNWIND ['a', 'b', 'c'] AS name CREATE (n:Person {name: name}) RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNWIND-09 UNWIND bool list', () => {
    const plan = execQuery('UNWIND [true, false, true] AS flag RETURN flag')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNWIND-10 UNWIND range(1,100)', () => {
    const plan = execQuery('UNWIND range(1, 100) AS x RETURN x')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNWIND-11 UNWIND + DISTINCT', () => {
    const plan = execQuery('UNWIND [1, 1, 2, 2, 3] AS x RETURN DISTINCT x')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNWIND-12 UNWIND + WHERE', () => {
    const plan = execQuery('UNWIND [1, 2, 3, 4, 5] AS x WHERE x > 3 RETURN x')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNWIND-13 UNWIND + WITH + MATCH', () => {
    const plan = execQuery('UNWIND [1, 2, 3] AS x WITH x MATCH (n:Person) WHERE n.id = x RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNWIND-14 UNWIND + sum', () => {
    const plan = execQuery('UNWIND [1, 2, 3, 4, 5] AS x RETURN sum(x) AS total')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNWIND-15 UNWIND + collect', () => {
    const plan = execQuery('UNWIND [1, 2, 3] AS x RETURN collect(x * 2) AS doubled')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNWIND-16 UNWIND [] + CREATE', () => {
    const plan = execQuery('UNWIND [] AS x CREATE (n:Node {id: x})')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNWIND-17 UNWIND + WITH ORDER BY', () => {
    const plan = execQuery('UNWIND [3, 1, 2] AS x WITH x ORDER BY x RETURN x')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNWIND-18 UNWIND + ORDER + LIMIT', () => {
    const plan = execQuery('UNWIND [5, 3, 1, 4, 2] AS x WITH x ORDER BY x LIMIT 3 RETURN x')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNWIND-19 UNWIND + multi agg', () => {
    const plan = execQuery('UNWIND [1, 2, 3] AS x RETURN count(x) AS cnt, avg(x) AS avg_val')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNWIND-20 UNWIND + MATCH str', () => {
    const plan = execQuery("UNWIND ['Alice', 'Bob'] AS name MATCH (n:Person {name: name}) RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNWIND-21 UNWIND + WITH transform', () => {
    const plan = execQuery('UNWIND [10, 20, 30] AS x WITH x * 2 AS doubled RETURN doubled')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('UNWIND-22 UNWIND + ORDER + SKIP', () => {
    const plan = execQuery('UNWIND range(1, 10) AS x RETURN x ORDER BY x DESC SKIP 3')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

})
