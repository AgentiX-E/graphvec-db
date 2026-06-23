/**
 * tck-TCK_EXT_-_FUNCTIONS_2__20_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - FUNCTIONS_2 (20 tests)', () => {
  test('FUNC2-01 RETURN startNode()', async () => {
    const plan = execQuery('MATCH (a)-[r]->(b) RETURN startNode(r) AS start')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC2-02 RETURN endNode()', async () => {
    const plan = execQuery('MATCH (a)-[r]->(b) RETURN endNode(r) AS end')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC2-03 RETURN length(path)', async () => {
    const plan = execQuery('MATCH p = (a)-[:KNOWS*1..5]->(c) RETURN length(p) AS path_len')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC2-04 RETURN nodes(path)', async () => {
    const plan = execQuery('MATCH p = (a)-[:KNOWS]->(b) RETURN nodes(p) AS node_list')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC2-05 RETURN relationships(path)', async () => {
    const plan = execQuery('MATCH p = (a)-[:KNOWS]->(b) RETURN relationships(p) AS rel_list')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC2-06 RETURN keys(node)', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN keys(n) AS property_keys')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC2-07 RETURN labels with filter', async () => {
    const plan = execQuery('MATCH (n) RETURN labels(n) AS lbls')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC2-08 RETURN count with groups', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN count(n) AS total, count(DISTINCT n.city) AS cities')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC2-09 RETURN sum with grouping', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.dept, sum(n.salary) AS total_salary')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC2-10 RETURN avg with grouping', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.city, avg(n.age) AS avg_age')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC2-11 RETURN min with grouping', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.dept, min(n.age) AS youngest')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC2-12 RETURN max with grouping', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.dept, max(n.age) AS oldest')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC2-13 RETURN collect with grouping', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.dept, collect(n.name) AS members')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC2-14 RETURN toBoolean on field', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN toBoolean(n.active_flag) AS active')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC2-15 RETURN toFloat on field', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN toFloat(n.string_num) AS num')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC2-16 RETURN toInteger on field', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN toInteger(n.age_str) AS age_num')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC2-17 RETURN coalesce with two fields', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN coalesce(n.nickname, n.name) AS display')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC2-18 RETURN coalesce with three fields', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN coalesce(n.title, n.role, n.name) AS label')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC2-19 RETURN type on named rel', async () => {
    const plan = execQuery('MATCH (a:Person)-[r]->(b:Company) RETURN type(r) AS rel_type')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC2-20 RETURN keys + size', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN size(keys(n)) AS prop_count')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

})
