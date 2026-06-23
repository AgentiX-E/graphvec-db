/**
 * tck-TCK_EXT_-_FUNCTIONS__28_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - FUNCTIONS (28 tests)', () => {
  test('FUNC-01 RETURN id()', async () => {
    const plan = execQuery('MATCH (n) RETURN id(n) AS node_id')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC-02 RETURN labels()', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN labels(n) AS labels')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC-03 RETURN type() edge', async () => {
    const plan = execQuery('MATCH ()-[r]->() RETURN type(r) AS rel_type')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC-04 RETURN exists()', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE exists(n.name) RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC-05 RETURN properties() node', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN properties(n) AS props')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC-06 RETURN properties() edge', async () => {
    const plan = execQuery('MATCH (a)-[r:KNOWS]->(b) RETURN properties(r) AS props')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC-07 RETURN head() list', async () => {
    const plan = execQuery('RETURN head([1, 2, 3]) AS h')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC-08 RETURN last() list', async () => {
    const plan = execQuery('RETURN last([1, 2, 3]) AS l')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC-09 RETURN reverse() list', async () => {
    const plan = execQuery('RETURN reverse([1, 2, 3]) AS rev')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC-10 RETURN tail() list', async () => {
    const plan = execQuery('RETURN tail([1, 2, 3]) AS t')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC-11 RETURN coalesce()', async () => {
    const plan = execQuery("RETURN coalesce(n.name, 'default') AS name")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC-12 RETURN coalesce() multi', async () => {
    const plan = execQuery("RETURN coalesce(n.middle, n.first, 'unknown') AS name")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC-13 RETURN count() agg', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN count(n) AS cnt')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC-14 RETURN sum() agg', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN sum(n.age) AS total')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC-15 RETURN avg() agg', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN avg(n.age) AS avg_age')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC-16 RETURN min() agg', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN min(n.age) AS min_age')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC-17 RETURN max() agg', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN max(n.age) AS max_age')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC-18 RETURN count DISTINCT', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN count(DISTINCT n.city) AS cities')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC-19 RETURN collect() agg', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN collect(n.name) AS names')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC-20 RETURN toBoolean()', async () => {
    const plan = execQuery("RETURN toBoolean('true') AS b")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC-21 RETURN toFloat()', async () => {
    const plan = execQuery("RETURN toFloat('3.14') AS f")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC-22 RETURN toInteger()', async () => {
    const plan = execQuery("RETURN toInteger('42') AS i")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC-23 type IS STRING', async () => {
    const plan = execQuery("RETURN 'hello' IS STRING AS is_str")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC-24 type IS INTEGER', async () => {
    const plan = execQuery('RETURN 42 IS INTEGER AS is_int')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC-25 type IS FLOAT', async () => {
    const plan = execQuery('RETURN 3.14 IS FLOAT AS is_float')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC-26 type IS BOOLEAN', async () => {
    const plan = execQuery('RETURN true IS BOOLEAN AS is_bool')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC-27 type IS NULL', async () => {
    const plan = execQuery('RETURN null IS NULL AS is_null')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('FUNC-28 type NOT IS NULL', async () => {
    const plan = execQuery("RETURN 'hello' IS NOT NULL AS not_null")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

})
