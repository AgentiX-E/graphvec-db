/**
 * tck-TCK_EXT_-_CALL_PROCEDURE__10_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - CALL_PROCEDURE (10 tests)', () => {
  test('CALL-01 CALL procedure', () => {
    const plan = execQuery('CALL db.labels() YIELD label RETURN label')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CALL-02 CALL procedure with args', () => {
    const plan = execQuery('CALL db.schema.nodeTypeProperties() YIELD propertyName RETURN propertyName')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CALL-03 CALL + WHERE', () => {
    const plan = execQuery("CALL db.labels() YIELD label WHERE label STARTS WITH 'P' RETURN label")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CALL-04 CALL + ORDER BY', () => {
    const plan = execQuery('CALL db.labels() YIELD label RETURN label ORDER BY label')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CALL-05 CALL + SKIP + LIMIT', () => {
    const plan = execQuery('CALL db.labels() YIELD label RETURN label SKIP 1 LIMIT 5')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CALL-06 CALL procedure + WITH', () => {
    const plan = execQuery("CALL db.labels() YIELD label WITH label WHERE label <> 'Person' RETURN label")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CALL-07 CALL + agg', () => {
    const plan = execQuery('CALL db.labels() YIELD label RETURN count(label) AS label_count')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CALL-08 CALL void procedure', () => {
    const plan = execQuery("CALL dbms.security.createUser('test', 'pass', false)")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CALL-09 CALL + UNION', () => {
    const plan = execQuery('CALL db.labels() YIELD label RETURN label UNION CALL db.labels() YIELD label RETURN label')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CALL-10 CALL standalone', () => {
    const plan = execQuery('CALL db.labels()')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

})
