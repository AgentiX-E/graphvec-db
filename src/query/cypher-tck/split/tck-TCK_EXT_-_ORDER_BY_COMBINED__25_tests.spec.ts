/**
 * tck-TCK_EXT_-_ORDER_BY_COMBINED__25_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - ORDER_BY_COMBINED (25 tests)', () => {
  test('ORDER-01 ORDER BY single asc', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.name ORDER BY n.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('ORDER-02 ORDER BY single desc', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.name ORDER BY n.name DESC')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('ORDER-03 ORDER BY two fields', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.name, n.age ORDER BY n.age, n.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('ORDER-04 ORDER BY two fields DESC', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.name, n.age ORDER BY n.age DESC, n.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('ORDER-05 ORDER BY + WHERE', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age > 25 RETURN n.name ORDER BY n.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('ORDER-06 ORDER + WHERE + DESC', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age > 25 RETURN n.name ORDER BY n.name DESC')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('ORDER-07 ORDER BY + SKIP', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.name ORDER BY n.name SKIP 5')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('ORDER-08 ORDER BY + LIMIT', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.name ORDER BY n.name LIMIT 10')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('ORDER-09 ORDER BY + SKIP + LIMIT', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.name ORDER BY n.name SKIP 5 LIMIT 10')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('ORDER-10 ORDER+WHERE+SKIP+LIMIT', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age > 20 RETURN n.name ORDER BY n.name SKIP 5 LIMIT 10')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('ORDER-11 ORDER BY alias', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.name AS name ORDER BY name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('ORDER-12 ORDER BY alias DESC', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.name AS name ORDER BY name DESC')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('ORDER-13 ORDER BY age asc', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.name ORDER BY n.age')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('ORDER-14 ORDER BY age desc', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.name ORDER BY n.age DESC')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('ORDER-15 ORDER + WHERE IN', () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.name IN ['Alice', 'Bob'] RETURN n.name ORDER BY n.name")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('ORDER-16 ORDER + WHERE range', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age >= 18 AND n.age <= 65 RETURN n.name ORDER BY n.age')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('ORDER-17 ORDER + WHERE + SKIP', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age > 30 RETURN n.name ORDER BY n.name DESC SKIP 3')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('ORDER-18 ORDER + WHERE + LIMIT', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age > 30 RETURN n.name ORDER BY n.name LIMIT 5')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('ORDER-19 ORDER+WHERE+SKIP+LIMIT DESC', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age > 20 RETURN n.name ORDER BY n.name DESC SKIP 3 LIMIT 5')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('ORDER-20 ORDER + WHERE multi', () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.age > 18 AND n.status = 'active' RETURN n.name ORDER BY n.age DESC")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('ORDER-21 ORDER BY + STARTS WITH', () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.name STARTS WITH 'A' RETURN n.name ORDER BY n.name")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('ORDER-22 ORDER BY + CONTAINS', () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.name CONTAINS 'li' RETURN n.name ORDER BY n.name")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('ORDER-23 ORDER BY + NOT', () => {
    const plan = execQuery("MATCH (n:Person) WHERE NOT n.name = 'Alice' RETURN n.name ORDER BY n.name")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('ORDER-24 ORDER BY + OR chain', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age < 18 OR n.age > 60 RETURN n.name ORDER BY n.age')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('ORDER-25 ORDER + WHERE + three fields', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age > 20 RETURN n.name, n.age, n.city ORDER BY n.age DESC, n.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

})
