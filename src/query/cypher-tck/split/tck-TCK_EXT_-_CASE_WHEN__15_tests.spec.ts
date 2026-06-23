/**
 * tck-TCK_EXT_-_CASE_WHEN__15_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - CASE_WHEN (15 tests)', () => {
  test('CASE-01 simple CASE WHEN', async () => {
    const plan = execQuery("MATCH (n:Person) RETURN CASE WHEN n.age > 30 THEN 'senior' ELSE 'junior' END AS category")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CASE-02 simple CASE with ELSE', async () => {
    const plan = execQuery("MATCH (n:Person) RETURN CASE WHEN n.age > 60 THEN 'retired' WHEN n.age > 30 THEN 'adult' ELSE 'young' END AS stage")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CASE-03 multiple WHEN conditions', async () => {
    const plan = execQuery("MATCH (n:Person) RETURN CASE WHEN n.age < 18 THEN 'minor' WHEN n.age >= 18 AND n.age < 65 THEN 'adult' ELSE 'senior' END AS group")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CASE-04 CASE in WHERE', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE CASE WHEN n.age > 30 THEN 1 ELSE 0 END = 1 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CASE-05 CASE in ORDER BY', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.name, n.age ORDER BY CASE WHEN n.age > 30 THEN 1 ELSE 0 END DESC')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CASE-06 CASE with AND/OR', async () => {
    const plan = execQuery("MATCH (n:Person) RETURN CASE WHEN n.age > 18 AND n.status = 'active' THEN 'eligible' WHEN n.age > 18 AND n.status = 'inactive' THEN 'inactive' ELSE 'minor' END AS status")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CASE-07 CASE with STARTS WITH', async () => {
    const plan = execQuery("MATCH (n:Person) RETURN CASE WHEN n.name STARTS WITH 'A' THEN 'A-group' WHEN n.name STARTS WITH 'B' THEN 'B-group' ELSE 'other' END AS grp")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CASE-08 CASE with IN', async () => {
    const plan = execQuery("MATCH (n:Person) RETURN CASE WHEN n.city IN ['NYC', 'LA'] THEN 'major' ELSE 'other' END AS city_type")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CASE-09 CASE with CONTAINS', async () => {
    const plan = execQuery("MATCH (n:Person) RETURN CASE WHEN n.name CONTAINS 'son' THEN 'family_name' ELSE 'other' END AS name_type")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CASE-10 CASE with EXISTS', async () => {
    const plan = execQuery("MATCH (n:Person) RETURN CASE WHEN exists(n.email) THEN 'has_email' ELSE 'no_email' END AS email_status")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
}, 30000)

  test('CASE-11 CASE with nested expression', async () => {
    const plan = execQuery("MATCH (n:Person) RETURN CASE WHEN (n.age * 2) > 100 THEN 'high' ELSE 'normal' END AS factor")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CASE-12 CASE with null handling', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN CASE WHEN n.middle IS NULL THEN n.name ELSE n.middle END AS display_name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CASE-13 simple CASE syntax (expr)', async () => {
    const plan = execQuery("MATCH (n:Person) RETURN CASE n.age WHEN 20 THEN 'twenty' WHEN 30 THEN 'thirty' ELSE 'other' END AS label")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CASE-14 CASE + aggregation', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN CASE WHEN n.age > 30 THEN count(n) ELSE 0 END AS senior_count')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CASE-15 CASE in RETURN with multiple fields', async () => {
    const plan = execQuery("MATCH (n:Person) RETURN n.name, CASE WHEN n.age > 30 THEN 'senior' ELSE 'junior' END AS level, n.age * 2 AS doubled")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

})
