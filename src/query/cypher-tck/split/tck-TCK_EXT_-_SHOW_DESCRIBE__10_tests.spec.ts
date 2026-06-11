/**
 * tck-TCK_EXT_-_SHOW_DESCRIBE__10_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - SHOW_DESCRIBE (10 tests)', () => {
  test('META-01 SHOW CONSTRAINTS', () => {
    const plan = execQuery('SHOW CONSTRAINTS')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('META-02 SHOW INDEXES', () => {
    const plan = execQuery('SHOW INDEXES')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('META-03 SHOW PROCEDURES', () => {
    const plan = execQuery('SHOW PROCEDURES')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('META-04 SHOW FUNCTIONS', () => {
    const plan = execQuery('SHOW FUNCTIONS')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('META-05 SHOW LABELS', () => {
    const plan = execQuery('SHOW LABELS')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('META-06 SHOW RELATIONSHIPTYPES', () => {
    const plan = execQuery('SHOW RELATIONSHIPTYPES')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('META-07 SHOW SCHEMA', () => {
    const plan = execQuery('SHOW SCHEMA')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('META-08 DESCRIBE alias', () => {
    const plan = execQuery('DESCRIBE MATCH (n:Person) RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('META-09 EXPLAIN query', () => {
    const plan = execQuery('EXPLAIN MATCH (n:Person) RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('META-10 PROFILE query', () => {
    const plan = execQuery('PROFILE MATCH (n:Person) RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

})
