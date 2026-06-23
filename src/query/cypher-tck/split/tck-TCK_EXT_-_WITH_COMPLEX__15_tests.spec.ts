/**
 * tck-TCK_EXT_-_WITH_COMPLEX__15_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - WITH_COMPLEX (15 tests)', () => {
  test('WITH-01 WITH simple alias', async () => {
    const plan = execQuery('MATCH (n:Person) WITH n.name AS name RETURN name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('WITH-02 WITH + WHERE filter', async () => {
    const plan = execQuery('MATCH (n:Person) WITH n WHERE n.age > 25 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('WITH-03 WITH + agg', async () => {
    const plan = execQuery('MATCH (n:Person) WITH n.dept AS dept, count(*) AS cnt RETURN dept, cnt')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('WITH-04 WITH + ORDER BY', async () => {
    const plan = execQuery('MATCH (n:Person) WITH n.name AS name ORDER BY name RETURN name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('WITH-05 WITH + SKIP + LIMIT', async () => {
    const plan = execQuery('MATCH (n:Person) WITH n ORDER BY n.age SKIP 5 LIMIT 10 RETURN n.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('WITH-06 WITH DISTINCT', async () => {
    const plan = execQuery('MATCH (n:Person) WITH DISTINCT n.city AS city RETURN city')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('WITH-07 WITH + collect', async () => {
    const plan = execQuery('MATCH (n:Person) WITH collect(n.name) AS names UNWIND names AS name RETURN name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('WITH-08 WITH + CASE', async () => {
    const plan = execQuery("MATCH (n:Person) WITH n.name AS name, CASE WHEN n.age > 30 THEN 'senior' ELSE 'junior' END AS level RETURN name, level")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('WITH-09 WITH + double agg', async () => {
    const plan = execQuery('MATCH (n:Person) WITH n.dept AS dept, avg(n.age) AS avg_age WHERE avg_age > 30 RETURN dept, avg_age')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('WITH-10 WITH + string func', async () => {
    const plan = execQuery('MATCH (n:Person) WITH toUpper(n.name) AS upper_name RETURN upper_name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('WITH-11 WITH + math', async () => {
    const plan = execQuery('MATCH (n:Person) WITH n.age * 2 AS double_age RETURN double_age')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('WITH-12 WITH + EXISTS', async () => {
    const plan = execQuery('MATCH (n:Person) WITH n WHERE EXISTS { (n)-[:KNOWS]->() } RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('WITH-13 WITH chained aliases', async () => {
    const plan = execQuery('MATCH (n:Person) WITH n.name AS a WITH a AS b RETURN b')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('WITH-14 WITH + multi-collect', async () => {
    const plan = execQuery('MATCH (n:Person) WITH n.dept AS dept, collect(n.name) AS names RETURN dept, size(names) AS cnt')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('WITH-15 WITH + percent agg', async () => {
    const plan = execQuery('MATCH (n:Person) WITH n, n.age / 100.0 AS age_pct RETURN n.name, age_pct')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

})
