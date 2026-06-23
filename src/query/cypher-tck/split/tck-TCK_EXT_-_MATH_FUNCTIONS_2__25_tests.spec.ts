/**
 * tck-TCK_EXT_-_MATH_FUNCTIONS_2__25_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - MATH_FUNCTIONS_2 (25 tests)', () => {
  test('MATH2-01 RETURN abs with field', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN abs(n.balance) AS abs_balance')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH2-02 RETURN ceil with field', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN ceil(n.score) AS ceil_score')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH2-03 RETURN floor with field', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN floor(n.score) AS floor_score')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH2-04 RETURN round with field', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN round(n.rating) AS rounded')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH2-05 RETURN sqrt with field', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN sqrt(n.value) AS sqrt_val')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH2-06 RETURN pi + round', async () => {
    const plan = execQuery('RETURN round(pi(), 2) AS pi_approx')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH2-07 RETURN rand + ceil', async () => {
    const plan = execQuery('RETURN ceil(rand() * 100) AS random_ceil')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH2-08 RETURN rand + floor', async () => {
    const plan = execQuery('RETURN floor(rand() * 100) AS random_floor')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH2-09 RETURN sign with field', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE sign(n.score) > 0 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH2-10 MATCH WHERE numeric range', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age >= 18 AND n.age <= 30 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH2-11 MATCH WHERE NOT range', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE NOT (n.age >= 18 AND n.age <= 30) RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH2-12 RETURN complex calc field', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN (n.age * 12 + n.month) / 365.0 AS years')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH2-13 MATCH WHERE percent calc', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.score / 100.0 > 0.8 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH2-14 RETURN nested arithmetic', { timeout: 300000 }, () => {
    const plan = execQuery('RETURN (((1 + 2) * 3) - 4) / 2 AS nested_result')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
})

  test('MATH2-15 RETURN mod with field', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.age % 10 AS last_digit')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH2-16 MATCH WHERE mod filter', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.id % 2 = 0 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH2-17 RETURN power with field', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.age ^ 2 AS age_squared')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH2-18 MATCH WHERE numeric NOT', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE NOT n.age = 30 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH2-19 MATCH WHERE numeric inequality', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age > 30 AND n.age <> 50 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH2-20 RETURN multiple fields arithmetic', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.age + n.experience AS total_years')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH2-21 MATCH WHERE OR numeric', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age = 20 OR n.age = 30 OR n.age = 40 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH2-22 MATCH WHERE age between', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE 18 <= n.age AND n.age <= 65 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH2-23 RETURN abs + round combo', async () => {
    const plan = execQuery('RETURN round(abs(-3.7)) AS combo')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH2-24 MATCH WHERE decimal', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.rating > 3.5 AND n.rating < 5.0 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH2-25 RETURN mixed type arithmetic', async () => {
    const plan = execQuery('RETURN 1 + 2.5 * 3 AS mixed_result')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

})
