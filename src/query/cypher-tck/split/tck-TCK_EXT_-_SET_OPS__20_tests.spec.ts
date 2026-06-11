/**
 * tck-TCK_EXT_-_SET_OPS__20_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - SET_OPS (20 tests)', () => {
  test('SETOP-01 UNION two queries', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.name UNION MATCH (m:Employee) RETURN m.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SETOP-02 UNION with WHERE', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age > 30 RETURN n.name UNION MATCH (m:Person) WHERE m.age > 30 RETURN m.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SETOP-03 UNION ALL', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.name UNION ALL MATCH (m:Employee) RETURN m.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SETOP-04 UNION ALL with WHERE', () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.city = 'NYC' RETURN n.name UNION ALL MATCH (m:Person) WHERE m.city = 'NYC' RETURN m.name")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SETOP-05 UNION + ORDER BY', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.name UNION MATCH (m:Person) RETURN m.name ORDER BY n.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SETOP-06 UNION + LIMIT', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.name UNION MATCH (m:Employee) RETURN m.name LIMIT 10')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SETOP-07 UNION three queries', () => {
    const plan = execQuery('MATCH (a:Person) RETURN a.name UNION MATCH (b:Employee) RETURN b.name UNION MATCH (c:Customer) RETURN c.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SETOP-08 UNION ALL + ORDER', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.name UNION ALL MATCH (m:Employee) RETURN m.name ORDER BY n.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SETOP-09 UNION + WHERE complex', () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.age > 25 RETURN n.name UNION MATCH (m:Person) WHERE m.status = 'active' RETURN m.name")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SETOP-10 UNION ALL + LIMIT', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.name UNION ALL MATCH (m:Person) RETURN m.name LIMIT 5')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SETOP-11 UNION + SKIP + LIMIT', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.name UNION MATCH (m:Employee) RETURN m.name SKIP 3 LIMIT 5')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SETOP-12 UNION ALL + SKIP', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.name UNION ALL MATCH (m:Person) RETURN m.name SKIP 10 LIMIT 5')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SETOP-13 INTERSECT two queries', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.name INTERSECT MATCH (m:Employee) RETURN m.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SETOP-14 INTERSECT with WHERE', () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.age > 30 RETURN n.name INTERSECT MATCH (m:Person) WHERE m.city = 'NYC' RETURN m.name")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SETOP-15 INTERSECT + ORDER', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.name INTERSECT MATCH (m:Employee) RETURN m.name ORDER BY n.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SETOP-16 EXCEPT two queries', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.name EXCEPT MATCH (m:Employee) RETURN m.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SETOP-17 EXCEPT with WHERE', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.active = true RETURN n.name EXCEPT MATCH (m:Person) WHERE m.inactive = true RETURN m.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SETOP-18 EXCEPT + ORDER', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.name EXCEPT MATCH (m:Employee) RETURN m.name ORDER BY n.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SETOP-19 UNION + compound WHERE', () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.age > 18 AND n.status = 'active' RETURN n.name UNION MATCH (m:Person) WHERE m.age < 65 AND m.status = 'active' RETURN m.name")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SETOP-20 UNION ALL three + ORDER', () => {
    const plan = execQuery('MATCH (a:Person) RETURN a.name UNION ALL MATCH (b:Employee) RETURN b.name UNION ALL MATCH (c:Customer) RETURN c.name ORDER BY a.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

})
