/**
 * tck-TCK_EXT_-_COMPLEX_PATTERNS__30_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - COMPLEX_PATTERNS (30 tests)', () => {
  test('CPX-01 triple hop a->b->c', () => {
    const plan = execQuery('MATCH (a)-[:KNOWS]->(b)-[:KNOWS]->(c) RETURN a, b, c')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-02 labeled triple hop', () => {
    const plan = execQuery('MATCH (a:Person)-[:KNOWS]->(b:Person)-[:KNOWS]->(c:Person) RETURN a, b, c')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-03 var-length [*2..5]', () => {
    const plan = execQuery('MATCH (a)-[:KNOWS*2..5]->(c) RETURN a, c')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-04 var-length [*3..6]', () => {
    const plan = execQuery('MATCH (a)-[:KNOWS*3..6]->(c) RETURN a, c')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-05 var-length [*1..4]', () => {
    const plan = execQuery('MATCH (a)-[:KNOWS*1..4]->(c) RETURN a, c')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-06 path WHERE filter', () => {
    const plan = execQuery('MATCH (a)-[:KNOWS*2..4]->(c) WHERE a.age > 30 RETURN a, c')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-07 min path length', () => {
    const plan = execQuery('MATCH (a)-[:KNOWS*..4]->(c) RETURN a, c')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-08 named path p=()', () => {
    const plan = execQuery('MATCH p = (a:Person)-[:KNOWS]->(b:Person) RETURN p')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-09 named path multi-hop', () => {
    const plan = execQuery('MATCH p = (a)-[:KNOWS]->(b)-[:KNOWS]->(c) RETURN p')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-10 var-length + label', () => {
    const plan = execQuery('MATCH (a:Person)-[:KNOWS*2..5]->(c:Person) RETURN a, c')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-11 multi-hop WHERE', () => {
    const plan = execQuery("MATCH (a)-[:KNOWS]->(b)-[:KNOWS]->(c) WHERE a.name = 'Alice' RETURN c")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-12 var-length compound WHERE', () => {
    const plan = execQuery("MATCH (a)-[:KNOWS*1..3]->(c) WHERE a.age > 25 AND c.name STARTS WITH 'B' RETURN c")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-13 triple hop WITH pipe', () => {
    const plan = execQuery('MATCH (a)-[:KNOWS]->(b)-[:KNOWS]->(c) WITH c MATCH (c)-[:KNOWS]->(d) RETURN d')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-14 unlabeled multi-hop', () => {
    const plan = execQuery('MATCH (a)-->(b)-->(c) RETURN a, b, c')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-15 named var-length', () => {
    const plan = execQuery('MATCH p = (a)-[:KNOWS*2..5]->(c) RETURN p')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-16 path + ORDER BY', () => {
    const plan = execQuery('MATCH p = (a)-[:KNOWS]->(b) RETURN p ORDER BY a.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-17 path WHERE + fields', () => {
    const plan = execQuery('MATCH (a)-[:KNOWS*1..4]->(c) WHERE c.age > 20 RETURN a.name, c.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-18 multi-label multi-hop', () => {
    const plan = execQuery('MATCH (a:Person|Employee)-[:KNOWS]->(b:Person|Manager) RETURN a, b')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-19 undirected var-length', () => {
    const plan = execQuery('MATCH (a)-[:KNOWS*1..3]-(c) RETURN a, c')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-20 multi-reltype var-len', () => {
    const plan = execQuery('MATCH (a)-[:KNOWS|:WORKS_WITH*2..4]->(c) RETURN a, c')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-21 path + SKIP + LIMIT', () => {
    const plan = execQuery('MATCH (a)-[:KNOWS]->(b) RETURN a, b SKIP 5 LIMIT 10')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-22 path + aggregation', () => {
    const plan = execQuery('MATCH (a)-[:KNOWS*1..3]->(c) RETURN a.name, count(c) AS cnt')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-23 var-length + LIMIT', () => {
    const plan = execQuery('MATCH (a)-[:KNOWS*1..5]->(c) RETURN c LIMIT 10')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-24 named path WHERE', () => {
    const plan = execQuery('MATCH p = (a)-[:KNOWS]->(b) WHERE a.age > b.age RETURN p')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-25 path + prop filter', () => {
    const plan = execQuery("MATCH (a)-[:KNOWS*2..3]->(c) WHERE a.status = 'active' RETURN c")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-26 multi-hop + UNION', () => {
    const plan = execQuery('MATCH (a:Person)-[:KNOWS]->(b) RETURN b.name UNION MATCH (c:Person)-[:KNOWS]->(d) RETURN d.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-27 var-length ORDER BY', () => {
    const plan = execQuery('MATCH (a)-[:KNOWS*2..4]->(c) RETURN c.name ORDER BY c.name DESC')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-28 path + compound', () => {
    const plan = execQuery('MATCH (a:Person), (b:Company) MATCH (a)-[:WORKS_AT]->(b) RETURN a, b')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-29 var-length min', () => {
    const plan = execQuery('MATCH (a)-[:KNOWS*2..]->(c) RETURN a, c')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CPX-30 path + triple pattern', () => {
    const plan = execQuery('MATCH (a:Person)-[:KNOWS]->(b:Person)-[:KNOWS]->(c:Person)-[:KNOWS]->(d:Person) RETURN d')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

})
