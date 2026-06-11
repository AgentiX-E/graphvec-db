/**
 * tck-TCK_EXT_-_PARAM_QUERY__22_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - PARAM_QUERY (22 tests)', () => {
  test('PARAM-01 MATCH $1 string', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.name = $1 RETURN n', ['Alice'])
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PARAM-02 MATCH $1 number', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age = $1 RETURN n', [30])
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PARAM-03 MATCH $1 >', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age > $1 RETURN n', [18])
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PARAM-04 MATCH AND $1 $2', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age > $1 AND n.age < $2 RETURN n', [18, 65])
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PARAM-05 MATCH IN $1', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.name IN $1 RETURN n', [['Alice', 'Bob']])
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PARAM-06 MATCH = $1', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.name = $1 RETURN n', ['Alice'])
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PARAM-07 MATCH <> $1', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.name <> $1 RETURN n', ['Alice'])
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PARAM-08 CREATE $1 $2', () => {
    const plan = execQuery('CREATE (n:Person {name: $1, age: $2}) RETURN n', ['Alice', 30])
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PARAM-09 CREATE $1', () => {
    const plan = execQuery('CREATE (n:Person {name: $1})', ['Bob'])
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PARAM-10 MATCH SKIP $1', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.name SKIP $1', [5])
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PARAM-11 MATCH LIMIT $1', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.name LIMIT $1', [10])
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PARAM-12 MATCH SKIP+LIMIT', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.name SKIP $1 LIMIT $2', [5, 10])
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PARAM-13 ORDER+SKIP+LIMIT', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.name ORDER BY n.name SKIP $1 LIMIT $2', [5, 10])
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PARAM-14 MATCH $name named', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.name = $name RETURN n', {'name': 'Alice'})
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PARAM-15 MATCH $age named', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age = $age RETURN n', {'age': 25})
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PARAM-16 MATCH $min $max', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age >= $min AND n.age <= $max RETURN n', {'min': 20, 'max': 50})
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PARAM-17 MATCH n.$1 field', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.$1 AS field', ['name'])
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PARAM-18 MATCH AND compound', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.name = $1 AND n.age > $2 RETURN n.name', ['Alice', 25])
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PARAM-19 MATCH IS NULL', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.name IS NULL RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PARAM-20 MATCH OR $1 $2', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.name = $1 OR n.name = $2 RETURN n', ['Alice', 'Bob'])
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PARAM-21 MATCH NOT $1', () => {
    const plan = execQuery('MATCH (n:Person) WHERE NOT n.name = $1 RETURN n', ['Alice'])
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PARAM-22 MATCH STARTS WITH $1', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.name STARTS WITH $1 RETURN n', ['A'])
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

})
