/**
 * tck-TCK_EXT_-_DATETIME__15_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - DATETIME (15 tests)', () => {
  test('DT-01 RETURN datetime()', () => {
    const plan = execQuery('RETURN datetime() AS now')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('DT-02 RETURN date()', () => {
    const plan = execQuery('RETURN date() AS today')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('DT-03 RETURN time()', () => {
    const plan = execQuery('RETURN time() AS now_time')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('DT-04 RETURN localdatetime()', () => {
    const plan = execQuery('RETURN localdatetime() AS now_local')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('DT-05 RETURN localtime()', () => {
    const plan = execQuery('RETURN localtime() AS local_now')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('DT-06 RETURN duration()', () => {
    const plan = execQuery('RETURN duration({days: 7}) AS week')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('DT-07 RETURN datetime from string', () => {
    const plan = execQuery("RETURN datetime('2024-01-01T12:00:00') AS new_year")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('DT-08 RETURN date from string', () => {
    const plan = execQuery("RETURN date('2024-12-25') AS xmas")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('DT-09 RETURN date parts', () => {
    const plan = execQuery('RETURN date({year: 2024, month: 12, day: 25}) AS xmas')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 30000)

  test('DT-10 RETURN time from string', () => {
    const plan = execQuery("RETURN time('14:30:00') AS meeting")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('DT-11 RETURN datetime + duration', () => {
    const plan = execQuery('RETURN datetime() + duration({hours: 1}) AS next_hour')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('DT-12 RETURN datetime - duration', () => {
    const plan = execQuery('RETURN datetime() - duration({days: 1}) AS yesterday')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('DT-13 RETURN duration between', () => {
    const plan = execQuery("RETURN duration.between(date('2024-01-01'), date('2024-12-31')) AS period")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('DT-14 RETURN date trunc', () => {
    const plan = execQuery("RETURN date.truncate('month', date('2024-03-15')) AS month_start")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('DT-15 RETURN datetime + MATCH', () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.created_at < datetime('2024-01-01') RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

})
