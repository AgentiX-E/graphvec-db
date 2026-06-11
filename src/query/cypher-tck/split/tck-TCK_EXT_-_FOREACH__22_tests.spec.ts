/**
 * tck-TCK_EXT_-_FOREACH__22_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - FOREACH (22 tests)', () => {
  test('FOREACH-01 basic CREATE', () => {
    const plan = execQuery('FOREACH (x IN [1, 2, 3] | CREATE (n:Node {id: x}))')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH-02 empty list', () => {
    const plan = execQuery('FOREACH (x IN [] | CREATE (n:Node {id: x}))')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH-03 single element', () => {
    const plan = execQuery('FOREACH (x IN [42] | CREATE (n:Node {id: x}))')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH-04 MATCH + FOREACH', () => {
    const plan = execQuery('MATCH (p:Person) FOREACH (x IN p.tags | CREATE (t:Tag {name: x}))')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH-05 nested FOREACH', () => {
    const plan = execQuery('FOREACH (x IN [1, 2] | FOREACH (y IN [3, 4] | CREATE (n:Node {a: x, b: y})))')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH-06 MATCH WHERE + FOREACH', () => {
    const plan = execQuery('MATCH (p:Person) WHERE p.active = true FOREACH (x IN p.tags | CREATE (t:Tag {name: x}))')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH-07 string list', () => {
    const plan = execQuery("FOREACH (x IN ['a', 'b', 'c'] | CREATE (n:Node {name: x}))")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH-08 MATCH + FOREACH iter', () => {
    const plan = execQuery('MATCH (p:Person) FOREACH (n IN p.friends | CREATE (f:Friend {name: n}))')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH-09 WITH + FOREACH', () => {
    const plan = execQuery('MATCH (p:Person) WITH p FOREACH (x IN p.items | CREATE (i:Item {id: x}))')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH-10 range(1,50)', () => {
    const plan = execQuery('FOREACH (x IN range(1, 50) | CREATE (n:Node {id: x}))')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH-11 empty SET', () => {
    const plan = execQuery("FOREACH (x IN [] | SET n.name = 'updated')")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH-12 multi condition', () => {
    const plan = execQuery("FOREACH (x IN [1, 2, 3, 4, 5] | CREATE (n:Node {id: x, label: 'test'}))")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH-13 MATCH + FOREACH SET', () => {
    const plan = execQuery('MATCH (p:Person) FOREACH (x IN p.updates | SET p.last_update = x)')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH-14 CREATE edge', () => {
    const plan = execQuery('FOREACH (x IN [1, 2] | CREATE (a:Node {id: x})-[:LINK]->(b:Node {id: x + 10}))')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH-15 multi CREATE', () => {
    const plan = execQuery('FOREACH (x IN [1, 2, 3] | CREATE (a:Node {id: x}) CREATE (b:Node {id: x * 100}))')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH-16 WHERE filter', () => {
    const plan = execQuery('FOREACH (x IN [1, 2, 3, 4, 5] WHERE x > 2 | CREATE (n:Node {id: x}))')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH-17 range compute', () => {
    const plan = execQuery('FOREACH (x IN range(0, 5) | CREATE (n:Node {id: x * 2}))')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH-18 MATCH edge ctx', () => {
    const plan = execQuery("MATCH (p:Person {name: 'Alice'}) FOREACH (item IN p.cart | CREATE (o:Order {product: item}))")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH-19 bool list', () => {
    const plan = execQuery('FOREACH (flag IN [true, false] | CREATE (n:Flag {value: flag}))')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH-20 FOREACH + MERGE', () => {
    const plan = execQuery('FOREACH (x IN [1, 2] | MERGE (n:Node {id: x}) SET n.v = x * 10)')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH-21 empty + MATCH', () => {
    const plan = execQuery('MATCH (n:Person) FOREACH (x IN [] | CREATE (t:Tmp {v: x}))')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FOREACH-22 FOREACH + DELETE', () => {
    const plan = execQuery('MATCH (n:Node) FOREACH (x IN [1] | DELETE n)')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

})
