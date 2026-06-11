/**
 * tck-TCK_EXT_-_SET_EXTENDED__15_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - SET_EXTENDED (15 tests)', () => {
  test('SET-01 SET single property', () => {
    const plan = execQuery("MATCH (n:Person {name: 'Alice'}) SET n.age = 31")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SET-02 SET multiple properties', () => {
    const plan = execQuery("MATCH (n:Person {name: 'Alice'}) SET n.age = 31, n.city = 'LA'")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SET-03 SET with expression', () => {
    const plan = execQuery("MATCH (n:Person {name: 'Alice'}) SET n.age = n.age + 1")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SET-04 SET = replaces properties', () => {
    const plan = execQuery("MATCH (n:Person {name: 'Alice'}) SET n = {age: 30, city: 'NYC'}")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SET-05 SET += augments properties', () => {
    const plan = execQuery("MATCH (n:Person {name: 'Alice'}) SET n += {status: 'active'}")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SET-06 SET + RETURN', () => {
    const plan = execQuery("MATCH (n:Person {name: 'Alice'}) SET n.age = 30 RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SET-07 SET with WHERE', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age IS NULL SET n.age = 0')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SET-08 SET label', () => {
    const plan = execQuery("MATCH (n:Person {name: 'Alice'}) SET n:Employee")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SET-09 SET multiple labels', () => {
    const plan = execQuery("MATCH (n:Person {name: 'Alice'}) SET n:Employee:Manager")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SET-10 SET with CASE', () => {
    const plan = execQuery("MATCH (n:Person) SET n.category = CASE WHEN n.age > 30 THEN 'senior' ELSE 'junior' END")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SET-11 SET with coalesce', () => {
    const plan = execQuery("MATCH (n:Person) SET n.name = coalesce(n.name, 'Unknown')")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SET-12 SET = with map literal', () => {
    const plan = execQuery("MATCH (n:Person {name: 'Alice'}) SET n = {name: 'Alice', age: 31, city: 'NYC'}")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SET-13 SET += with dynamic props', () => {
    const plan = execQuery("MATCH (n:Person {name: 'Alice'}) SET n += {last_updated: timestamp()}")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SET-14 SET + ORDER BY', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age IS NULL SET n.age = 0 RETURN n.name ORDER BY n.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SET-15 SET with SKIP + LIMIT', () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.status = 'new' SET n.processed = true RETURN n SKIP 10 LIMIT 50")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

})
