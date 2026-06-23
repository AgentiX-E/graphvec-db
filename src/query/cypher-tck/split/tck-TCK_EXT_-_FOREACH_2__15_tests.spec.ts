/**
 * tck-TCK_EXT_-_FOREACH_2__15_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - FOREACH_2 (15 tests)', () => {
  test('FOREACH2-01 FOREACH CREATE with relation', async () => {
    const plan = execQuery('FOREACH (x IN [1, 2] | CREATE (n:Node {id: x}) WITH n MATCH (m:Node {id: x + 1}) CREATE (n)-[:LINK]->(m))')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
}, 30000)

  test('FOREACH2-02 FOREACH + SET property', async () => {
    const plan = execQuery('MATCH (n:Person) FOREACH (flag IN [true] | SET n.flagged = flag)')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH2-03 FOREACH + REMOVE property', async () => {
    const plan = execQuery('MATCH (n:Person) FOREACH (x IN [1] | REMOVE n.temp)')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH2-04 FOREACH MERGE + ON CREATE', async () => {
    const plan = execQuery('FOREACH (x IN [1, 2] | MERGE (n:Node {id: x}) ON CREATE SET n.created = timestamp())')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH2-05 FOREACH MERGE + ON MATCH', async () => {
    const plan = execQuery('FOREACH (x IN [1, 2] | MERGE (n:Node {id: x}) ON MATCH SET n.updated = timestamp())')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH2-06 FOREACH + CREATE multiple labels', async () => {
    const plan = execQuery("FOREACH (x IN ['a', 'b'] | CREATE (n:Node:Test {id: x}))")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH2-07 FOREACH with WHERE + SET', async () => {
    const plan = execQuery('FOREACH (x IN [1, 2, 3] WHERE x > 1 | CREATE (n:Node {id: x}) SET n.active = true)')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
}, 30000)

  test('FOREACH2-08 FOREACH with string template', async () => {
    const plan = execQuery("FOREACH (name IN ['Alice', 'Bob'] | CREATE (n:Person {name: name, label: 'user_' + name}))")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH2-09 MATCH + FOREACH + MATCH', async () => {
    const plan = execQuery('MATCH (p:Person) FOREACH (f IN p.friend_ids | MATCH (n:Person {id: f}) CREATE (p)-[:KNOWS]->(n))')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH2-10 FOREACH with range step', async () => {
    const plan = execQuery('FOREACH (x IN range(0, 10, 2) | CREATE (n:Node {id: x}))')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH2-11 FOREACH + collect', async () => {
    const plan = execQuery('MATCH (p:Person) FOREACH (t IN collect(p.tag) | CREATE (n:Tag {name: t}))')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH2-12 FOREACH double list', async () => {
    const plan = execQuery("FOREACH (x IN [1, 2] | CREATE (n:Node {id: x}) FOREACH (y IN ['a', 'b'] | SET n. + y = y))")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
}, 30000)

  test('FOREACH2-13 FOREACH + DELETE with WHERE', async () => {
    const plan = execQuery('MATCH (n:Node) WHERE n.expired = true FOREACH (x IN [1] | DELETE n)')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH2-14 FOREACH + SET FROM attr', async () => {
    const plan = execQuery('MATCH (p:Person) FOREACH (prop IN keys(p) | SET p.processed = true)')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH2-15 FOREACH with conditional', async () => {
    const plan = execQuery('FOREACH (x IN [1, 2, 3] | FOREACH (y IN CASE WHEN x > 1 THEN [x] ELSE [] END | CREATE (n:Node {id: y})))')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

})
