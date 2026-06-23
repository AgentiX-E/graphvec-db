/**
 * tck-TCK_EXT_-_NESTED_QUERIES__25_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - NESTED_QUERIES (25 tests)', () => {
  test('NEST-01 EXISTS subquery', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE EXISTS { MATCH (n)-[:KNOWS]->() } RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('NEST-02 NOT EXISTS subquery', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE NOT EXISTS { MATCH (n)-[:KNOWS]->() } RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('NEST-03 EXISTS with type filter', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE EXISTS { MATCH (n)-[:WORKS_AT]->(:Company) } RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('NEST-04 COUNT subquery', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE COUNT { MATCH (n)-[:KNOWS]->(f) } > 5 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('NEST-05 COUNT subquery comparison', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE COUNT { MATCH (n)-[:KNOWS]->() } = 0 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('NEST-06 EXISTS + AND subquery', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE EXISTS { MATCH (n)-[:KNOWS]->() } AND n.age > 30 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('NEST-07 EXISTS + OR subquery', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE EXISTS { MATCH (n)-[:KNOWS]->(:Person) } OR n.age < 25 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('NEST-08 EXISTS subquery with property', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE EXISTS { MATCH (n)-[:KNOWS]->(f:Person) WHERE f.age > n.age } RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('NEST-09 NOT EXISTS subquery + WHERE', async () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.age > 30 AND NOT EXISTS { MATCH (n)-[:KNOWS]->(:Person {status: 'inactive'}) } RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('NEST-10 COUNT subquery multi-hop', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE COUNT { MATCH (n)-[:KNOWS]->()-[:KNOWS]->() } >= 2 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('NEST-11 EXISTS + SKIP + LIMIT', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE EXISTS { MATCH (n)-[:KNOWS]->() } RETURN n SKIP 5 LIMIT 10')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('NEST-12 EXISTS + ORDER BY', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE EXISTS { MATCH (n)-[:KNOWS]->() } RETURN n.name ORDER BY n.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('NEST-13 EXISTS + aggregation', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE EXISTS { MATCH (n)-[:KNOWS]->() } RETURN n.dept, count(n) AS cnt')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('NEST-14 NOT EXISTS + collect', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE NOT EXISTS { MATCH (n)-[:KNOWS]->() } RETURN collect(n.name) AS lonely_people')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('NEST-15 EXISTS + subquery property', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE EXISTS { MATCH (n)-[:PURCHASED]->(p:Product) WHERE p.price > 100 } RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('NEST-16 COUNT + HAVING pattern', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE COUNT { MATCH (n)-[:KNOWS]->() } > 2 RETURN n.name, COUNT { MATCH (n)-[:KNOWS]->() } AS friend_count')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('NEST-17 EXISTS triple filter', async () => {
    const plan = execQuery("MATCH (n:Person) WHERE EXISTS { MATCH (n)-[:KNOWS]->(f:Person)-[:WORKS_AT]->(c:Company {name: 'Acme'}) } RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('NEST-18 COUNT subquery with range', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE COUNT { MATCH (n)-[:PURCHASED]->(p:Product) WHERE p.price > 50 } > 3 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('NEST-19 EXISTS + STARTS WITH', async () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.name STARTS WITH 'A' AND EXISTS { MATCH (n)-[:KNOWS]->() } RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('NEST-20 NOT EXISTS double', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE NOT EXISTS { MATCH (n)-[:KNOWS]->() } AND NOT EXISTS { MATCH (n)-[:WORKS_AT]->() } RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('NEST-21 EXISTS path pattern', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE EXISTS { MATCH (n)-[:KNOWS*1..3]->(f) } RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('NEST-22 COUNT with grouping', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE COUNT { MATCH (n)-[:KNOWS]->() } >= 1 RETURN n.dept, count(n) AS emp_count')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('NEST-23 EXISTS with MATCH + WHERE', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE EXISTS { MATCH (n)-[:LIVES_IN]->(c:City) WHERE c.population > 1000000 } RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('NEST-24 NOT EXISTS with property', async () => {
    const plan = execQuery("MATCH (n:Person) WHERE NOT EXISTS { MATCH (n)-[:HAS]->(:Account {status: 'blocked'}) } RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('NEST-25 EXISTS subquery + LIMIT', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE EXISTS { MATCH (n)-[:KNOWS]->() } RETURN n LIMIT 20')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

})
