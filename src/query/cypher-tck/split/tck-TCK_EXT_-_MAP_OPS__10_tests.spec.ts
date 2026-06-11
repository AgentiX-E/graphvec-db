/**
 * tck-TCK_EXT_-_MAP_OPS__10_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - MAP_OPS (10 tests)', () => {
  test('MAP-01 RETURN map literal', () => {
    const plan = execQuery("RETURN {name: 'Alice', age: 30} AS person")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MAP-02 RETURN map with field', () => {
    const plan = execQuery('MATCH (n:Person) RETURN {name: n.name, age: n.age} AS person')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MAP-03 RETURN map access', () => {
    const plan = execQuery("RETURN {name: 'Alice', age: 30}.name AS name")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MAP-04 RETURN nested map', () => {
    const plan = execQuery("RETURN {person: {name: 'Alice', age: 30}, city: 'NYC'} AS data")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 30000)

  test('MAP-05 RETURN map keys', () => {
    const plan = execQuery("RETURN keys({name: 'Alice', age: 30}) AS props")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MAP-06 RETURN map values', () => {
    const plan = execQuery("RETURN [x IN {name: 'Alice', age: 30} | x] AS values")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MAP-07 RETURN map + list', () => {
    const plan = execQuery("RETURN [{name: 'Alice'}, {name: 'Bob'}] AS people")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MAP-08 MATCH RETURN map from node', () => {
    const plan = execQuery('MATCH (n:Person) RETURN {name: n.name, data: n} AS result')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MAP-09 RETURN map merge', () => {
    const plan = execQuery("RETURN {name: 'Alice'} + {age: 30} AS merged")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MAP-10 RETURN map with CASE', () => {
    const plan = execQuery("RETURN {key: CASE WHEN 1 > 0 THEN 'yes' ELSE 'no' END} AS result")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

})
