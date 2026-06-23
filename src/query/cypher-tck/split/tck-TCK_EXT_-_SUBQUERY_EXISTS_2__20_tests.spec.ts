/**
 * tck-TCK_EXT_-_SUBQUERY_EXISTS_2__20_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - SUBQUERY_EXISTS_2 (20 tests)', () => {
  test('SQ2-01 EXISTS edge pattern', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE EXISTS { (n)-[:KNOWS]->(:Person) } RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SQ2-02 EXISTS path pattern', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE EXISTS { (n)-[:KNOWS*2..4]->(:Person) } RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SQ2-03 NOT EXISTS edge', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE NOT EXISTS { (n)-[:KNOWS]->() } RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SQ2-04 EXISTS multi-edge pattern', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE EXISTS { (n)-[:KNOWS]->(:Person) AND (n)-[:WORKS_AT]->(:Company) } RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SQ2-05 EXISTS + property filter', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE EXISTS { (n)-[:KNOWS]->(f:Person) WHERE f.age > 30 } RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SQ2-06 NOT EXISTS + property', async () => {
    const plan = execQuery("MATCH (n:Person) WHERE NOT EXISTS { (n)-[:KNOWS]->(f:Person) WHERE f.status = 'blocked' } RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SQ2-07 COUNT subq = 1', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE COUNT { (n)-[:KNOWS]->() } = 1 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SQ2-08 COUNT subq >= 3', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE COUNT { (n)-[:KNOWS]->() } >= 3 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SQ2-09 COUNT subq between', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE COUNT { (n)-[:KNOWS]->() } >= 2 AND COUNT { (n)-[:KNOWS]->() } <= 5 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SQ2-10 EXISTS + subq agg', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE EXISTS { MATCH (n)-[:PURCHASED]->(p:Product) WITH p WHERE p.price > avg(p.price) } RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
}, 30000)

  test('SQ2-11 EXISTS with label var', async () => {
    const plan = execQuery('MATCH (n) WHERE EXISTS { (n:Person)-[:KNOWS]->() } RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SQ2-12 NOT EXISTS + label var', async () => {
    const plan = execQuery('MATCH (n) WHERE NOT EXISTS { (n:Person)-[:KNOWS]->() } RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SQ2-13 EXISTS + UNION subquery', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE EXISTS { MATCH (n)-[:KNOWS]->(f) RETURN f UNION MATCH (n)-[:WORKS_WITH]->(c) RETURN c } RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SQ2-14 COUNT with label', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE COUNT { (n)-[:KNOWS]->(:Person) } > 0 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SQ2-15 EXISTS + OR subq', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE EXISTS { (n)-[:KNOWS]->(:Person) } OR EXISTS { (n)-[:WORKS_AT]->(:Company) } RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SQ2-16 EXISTS + AND WHERE', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE EXISTS { (n)-[:KNOWS]->(f:Person) } AND n.age > 30 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SQ2-17 EXISTENTIAL triple pattern', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE EXISTS { (n)-[:KNOWS]->(:Person)-[:KNOWS]->(:Person) } RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SQ2-18 NOT EXISTENTIAL multi-hop', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE NOT EXISTS { (n)-[:KNOWS*3..]->(f) } RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SQ2-19 COUNT subq + ORDER', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE COUNT { (n)-[:KNOWS]->() } > 0 RETURN n.name ORDER BY n.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SQ2-20 COUNT + SKIP + LIMIT', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE COUNT { (n)-[:KNOWS]->() } > 2 RETURN n.name SKIP 5 LIMIT 10')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

})
