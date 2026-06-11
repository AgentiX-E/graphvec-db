/**
 * tck-TCK_EXT_-_MATH_FUNCTIONS__27_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - MATH_FUNCTIONS (27 tests)', () => {
  test('MATH-01 RETURN addition', () => {
    const plan = execQuery('RETURN 1 + 2 AS sum')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH-02 RETURN subtraction', () => {
    const plan = execQuery('RETURN 5 - 3 AS diff')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH-03 RETURN multiplication', () => {
    const plan = execQuery('RETURN 3 * 4 AS prod')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH-04 RETURN division', () => {
    const plan = execQuery('RETURN 10 / 3 AS quot')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH-05 RETURN modulo', () => {
    const plan = execQuery('RETURN 10 % 3 AS mod')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH-06 MATCH WHERE >', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age > 30 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH-07 MATCH WHERE <', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age < 25 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH-08 MATCH WHERE >=', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age >= 18 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH-09 MATCH WHERE <=', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age <= 65 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH-10 RETURN abs(-5)', () => {
    const plan = execQuery('RETURN abs(-5) AS abs_val')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH-11 RETURN ceil(4.2)', () => {
    const plan = execQuery('RETURN ceil(4.2) AS ceil_val')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH-12 RETURN floor(4.8)', () => {
    const plan = execQuery('RETURN floor(4.8) AS floor_val')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH-13 RETURN round(3.14159)', () => {
    const plan = execQuery('RETURN round(3.14159) AS rnd_val')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH-14 RETURN exp(1)', () => {
    const plan = execQuery('RETURN exp(1) AS e')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH-15 RETURN sqrt(16)', () => {
    const plan = execQuery('RETURN sqrt(16) AS root')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH-16 RETURN log(10)', () => {
    const plan = execQuery('RETURN log(10) AS l')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH-17 RETURN power ^', () => {
    const plan = execQuery('RETURN 2 ^ 10 AS power')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH-18 RETURN sign(-3)', () => {
    const plan = execQuery('RETURN sign(-3) AS sgn')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH-19 RETURN rand()', () => {
    const plan = execQuery('RETURN rand() AS rnd')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH-20 RETURN degrees(pi)', () => {
    const plan = execQuery('RETURN degrees(3.14159) AS deg')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH-21 RETURN radians(180)', () => {
    const plan = execQuery('RETURN radians(180) AS rad')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH-22 RETURN pi()', () => {
    const plan = execQuery('RETURN pi() AS p')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH-23 MATCH RETURN age*2', () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.age * 2 AS double_age')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH-24 MATCH WHERE AND chain', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age > 18 AND n.age < 60 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH-25 MATCH WHERE OR chain', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age < 18 OR n.age > 60 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH-26 MATCH WHERE compound', () => {
    const plan = execQuery('MATCH (n:Person) WHERE (n.age * 2) + 1 > 50 RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('MATH-27 RETURN multi-op', () => {
    const plan = execQuery('RETURN (1 + 2) * 3 - 4 / 2 AS result')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

})
