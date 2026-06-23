/**
 * tck-TCK_EXT_-_MERGE_EXTENDED__20_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - MERGE_EXTENDED (20 tests)', () => {
  test('MERGE-01 MERGE basic', async () => {
    const plan = execQuery("MERGE (n:Person {name: 'Alice'})")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MERGE-02 MERGE + RETURN', async () => {
    const plan = execQuery("MERGE (n:Person {name: 'Alice'}) RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MERGE-03 MERGE + ON CREATE SET', async () => {
    const plan = execQuery("MERGE (n:Person {name: 'Alice'}) ON CREATE SET n.created = timestamp()")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MERGE-04 MERGE + ON MATCH SET', async () => {
    const plan = execQuery("MERGE (n:Person {name: 'Alice'}) ON MATCH SET n.last_seen = timestamp()")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MERGE-05 MERGE + ON CREATE + ON MATCH', async () => {
    const plan = execQuery("MERGE (n:Person {name: 'Alice'}) ON CREATE SET n.count = 1 ON MATCH SET n.count = n.count + 1")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MERGE-06 MERGE with multiple props', async () => {
    const plan = execQuery("MERGE (n:Person {name: 'Alice', city: 'NYC'})")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MERGE-07 MERGE + CREATE edge', async () => {
    const plan = execQuery("MERGE (a:Person {name: 'Alice'}) MERGE (b:Person {name: 'Bob'}) MERGE (a)-[:KNOWS]->(b)")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MERGE-08 MERGE edge with props', async () => {
    const plan = execQuery("MERGE (a:Person {name: 'Alice'})-[r:KNOWS {since: 2020}]->(b:Person {name: 'Bob'}) RETURN r")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MERGE-09 MERGE + SET multiple', async () => {
    const plan = execQuery("MERGE (n:Person {name: 'Alice'}) SET n.age = 30, n.city = 'NYC'")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MERGE-10 MERGE + REMOVE', async () => {
    const plan = execQuery("MERGE (n:Person {name: 'Alice'}) REMOVE n.temp_prop")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MERGE-11 MERGE + WHERE', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.name IS NOT NULL MERGE (m:Person {name: n.name})')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MERGE-12 MERGE with collect', async () => {
    const plan = execQuery('MATCH (n:Person) WITH collect(n.name) AS names MERGE (m:Summary {names: names})')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MERGE-13 MERGE + ON CREATE SET + RETURN', async () => {
    const plan = execQuery("MERGE (n:Person {name: 'Alice'}) ON CREATE SET n.count = 1 RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MERGE-14 MERGE multiple labels', async () => {
    const plan = execQuery("MERGE (n:Person:Employee {name: 'Alice'})")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MERGE-15 MERGE + ON MATCH SET + RETURN', async () => {
    const plan = execQuery("MERGE (n:Person {name: 'Alice'}) ON MATCH SET n.updated = true RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MERGE-17 MERGE + FOREACH', async () => {
    const plan = execQuery("FOREACH (name IN ['Alice', 'Bob'] | MERGE (n:Person {name: name}))")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MERGE-18 MERGE with conditional SET', async () => {
    const plan = execQuery("MERGE (n:Person {name: 'Alice'}) ON CREATE SET n.new = true ON MATCH SET n.existing = true")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MERGE-19 MERGE + UNWIND', async () => {
    const plan = execQuery("UNWIND ['Alice', 'Bob'] AS name MERGE (n:Person {name: name}) RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
}, 30000)

  test('MERGE-20 MERGE + ORDER BY', async () => {
    const plan = execQuery("MERGE (n:Person {name: 'Alice'}) RETURN n.name ORDER BY n.name")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
}, 30000)

})
