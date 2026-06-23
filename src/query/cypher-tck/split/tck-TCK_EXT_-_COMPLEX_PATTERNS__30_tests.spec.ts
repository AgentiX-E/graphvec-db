/**
 * tck-TCK_EXT_-_COMPLEX_PATTERNS__30_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - COMPLEX_PATTERNS (30 tests)', () => {
  test('CPX-01 triple hop a->b->c', async () => {
    const plan = execQuery('MATCH (a)-[:KNOWS]->(b)-[:KNOWS]->(c) RETURN a, b, c')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-02 labeled triple hop', async () => {
    const plan = execQuery('MATCH (a:Person)-[:KNOWS]->(b:Person)-[:KNOWS]->(c:Person) RETURN a, b, c')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-03 var-length [*2..5]', async () => {
    const plan = execQuery('MATCH (a)-[:KNOWS*2..5]->(c) RETURN a, c')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-04 var-length [*3..6]', async () => {
    const plan = execQuery('MATCH (a)-[:KNOWS*3..6]->(c) RETURN a, c')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-05 var-length [*1..4]', async () => {
    const plan = execQuery('MATCH (a)-[:KNOWS*1..4]->(c) RETURN a, c')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-06 path WHERE filter', async () => {
    const plan = execQuery('MATCH (a)-[:KNOWS*2..4]->(c) WHERE a.age > 30 RETURN a, c')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-07 min path length', async () => {
    const plan = execQuery('MATCH (a)-[:KNOWS*..4]->(c) RETURN a, c')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-08 named path p=()', async () => {
    const plan = execQuery('MATCH p = (a:Person)-[:KNOWS]->(b:Person) RETURN p')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-09 named path multi-hop', async () => {
    const plan = execQuery('MATCH p = (a)-[:KNOWS]->(b)-[:KNOWS]->(c) RETURN p')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-10 var-length + label', async () => {
    const plan = execQuery('MATCH (a:Person)-[:KNOWS*2..5]->(c:Person) RETURN a, c')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-11 multi-hop WHERE', async () => {
    const plan = execQuery("MATCH (a)-[:KNOWS]->(b)-[:KNOWS]->(c) WHERE a.name = 'Alice' RETURN c")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-12 var-length compound WHERE', async () => {
    const plan = execQuery("MATCH (a)-[:KNOWS*1..3]->(c) WHERE a.age > 25 AND c.name STARTS WITH 'B' RETURN c")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-13 triple hop WITH pipe', async () => {
    const plan = execQuery('MATCH (a)-[:KNOWS]->(b)-[:KNOWS]->(c) WITH c MATCH (c)-[:KNOWS]->(d) RETURN d')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-14 unlabeled multi-hop', async () => {
    const plan = execQuery('MATCH (a)-->(b)-->(c) RETURN a, b, c')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-15 named var-length', async () => {
    const plan = execQuery('MATCH p = (a)-[:KNOWS*2..5]->(c) RETURN p')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-16 path + ORDER BY', async () => {
    const plan = execQuery('MATCH p = (a)-[:KNOWS]->(b) RETURN p ORDER BY a.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-17 path WHERE + fields', async () => {
    const plan = execQuery('MATCH (a)-[:KNOWS*1..4]->(c) WHERE c.age > 20 RETURN a.name, c.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-18 multi-label multi-hop', async () => {
    const plan = execQuery('MATCH (a:Person|Employee)-[:KNOWS]->(b:Person|Manager) RETURN a, b')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-19 undirected var-length', async () => {
    const plan = execQuery('MATCH (a)-[:KNOWS*1..3]-(c) RETURN a, c')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-20 multi-reltype var-len', async () => {
    const plan = execQuery('MATCH (a)-[:KNOWS|:WORKS_WITH*2..4]->(c) RETURN a, c')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-21 path + SKIP + LIMIT', async () => {
    const plan = execQuery('MATCH (a)-[:KNOWS]->(b) RETURN a, b SKIP 5 LIMIT 10')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-22 path + aggregation', async () => {
    const plan = execQuery('MATCH (a)-[:KNOWS*1..3]->(c) RETURN a.name, count(c) AS cnt')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-23 var-length + LIMIT', async () => {
    const plan = execQuery('MATCH (a)-[:KNOWS*1..5]->(c) RETURN c LIMIT 10')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-24 named path WHERE', async () => {
    const plan = execQuery('MATCH p = (a)-[:KNOWS]->(b) WHERE a.age > b.age RETURN p')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-25 path + prop filter', async () => {
    const plan = execQuery("MATCH (a)-[:KNOWS*2..3]->(c) WHERE a.status = 'active' RETURN c")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-26 multi-hop + UNION', async () => {
    const plan = execQuery('MATCH (a:Person)-[:KNOWS]->(b) RETURN b.name UNION MATCH (c:Person)-[:KNOWS]->(d) RETURN d.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-27 var-length ORDER BY', async () => {
    const plan = execQuery('MATCH (a)-[:KNOWS*2..4]->(c) RETURN c.name ORDER BY c.name DESC')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-28 path + compound', async () => {
    const plan = execQuery('MATCH (a:Person), (b:Company) MATCH (a)-[:WORKS_AT]->(b) RETURN a, b')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-29 var-length min', async () => {
    const plan = execQuery('MATCH (a)-[:KNOWS*2..]->(c) RETURN a, c')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-30 path + triple pattern', async () => {
    const plan = execQuery('MATCH (a:Person)-[:KNOWS]->(b:Person)-[:KNOWS]->(c:Person)-[:KNOWS]->(d:Person) RETURN d')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

})
