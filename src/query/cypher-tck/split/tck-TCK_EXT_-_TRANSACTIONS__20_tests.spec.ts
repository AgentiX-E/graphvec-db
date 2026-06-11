/**
 * tck-TCK_EXT_-_TRANSACTIONS__20_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - TRANSACTIONS (20 tests)', () => {
  test('TXN-01 BEGIN query parse', () => {
    const plan = execQuery('BEGIN')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('TXN-02 COMMIT query parse', () => {
    const plan = execQuery('COMMIT')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('TXN-03 ROLLBACK query parse', () => {
    const plan = execQuery('ROLLBACK')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('TXN-04 BEGIN + CREATE + COMMIT', () => {
    const plan = execQuery("BEGIN CREATE (n:Person {name: 'Alice'}) COMMIT")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('TXN-05 BEGIN + CREATE + ROLLBACK', () => {
    const plan = execQuery("BEGIN CREATE (n:Person {name: 'Bob'}) ROLLBACK")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('TXN-06 BEGIN + MATCH + COMMIT', () => {
    const plan = execQuery('BEGIN MATCH (n:Person) RETURN n COMMIT')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('TXN-07 BEGIN + MATCH + ROLLBACK', () => {
    const plan = execQuery('BEGIN MATCH (n:Person) RETURN n ROLLBACK')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('TXN-08 BEGIN + multiple CREATE + COMMIT', () => {
    const plan = execQuery("BEGIN CREATE (a:Person {name: 'Alice'}) CREATE (b:Person {name: 'Bob'}) COMMIT")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('TXN-09 BEGIN + CREATE edge + COMMIT', () => {
    const plan = execQuery("BEGIN CREATE (a:Person {name: 'Alice'})-[:KNOWS]->(b:Person {name: 'Bob'}) COMMIT")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('TXN-10 BEGIN + CREATE + MATCH + COMMIT', () => {
    const plan = execQuery("BEGIN CREATE (n:Person {name: 'Test'}) MATCH (m:Person) RETURN m COMMIT")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('TXN-11 BEGIN + MERGE + COMMIT', () => {
    const plan = execQuery("BEGIN MERGE (n:Person {name: 'Alice'}) SET n.age = 30 COMMIT")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('TXN-12 BEGIN + SET + ROLLBACK', () => {
    const plan = execQuery("BEGIN MATCH (n:Person {name: 'Alice'}) SET n.age = 40 ROLLBACK")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('TXN-13 BEGIN + DELETE + COMMIT', () => {
    const plan = execQuery("BEGIN MATCH (n:Person {name: 'Alice'}) DELETE n COMMIT")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('TXN-14 nested BEGIN + COMMIT', () => {
    const plan = execQuery("BEGIN BEGIN CREATE (n:Person {name: 'Inner'}) COMMIT COMMIT")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('TXN-15 BEGIN + FOREACH + COMMIT', () => {
    const plan = execQuery('BEGIN FOREACH (x IN [1, 2, 3] | CREATE (n:Node {id: x})) COMMIT')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('TXN-16 BEGIN + UNWIND + COMMIT', () => {
    const plan = execQuery('BEGIN UNWIND [1, 2, 3] AS x CREATE (n:Node {id: x}) COMMIT')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('TXN-17 BEGIN + WITH + COMMIT', () => {
    const plan = execQuery('BEGIN MATCH (n:Person) WITH n WHERE n.age > 30 RETURN n COMMIT')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('TXN-18 BEGIN + multi-statement', () => {
    const plan = execQuery('BEGIN MATCH (n:Person) RETURN n SKIP 5 LIMIT 10 COMMIT')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('TXN-19 BEGIN + REMOVE + COMMIT', () => {
    const plan = execQuery("BEGIN MATCH (n:Person {name: 'Alice'}) REMOVE n.age COMMIT")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('TXN-20 BEGIN + compound + ROLLBACK', () => {
    const plan = execQuery("BEGIN MATCH (n:Person) WHERE n.name = 'Alice' SET n.status = 'inactive' CREATE (log:Event {action: 'deactivate'}) ROLLBACK")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

})
