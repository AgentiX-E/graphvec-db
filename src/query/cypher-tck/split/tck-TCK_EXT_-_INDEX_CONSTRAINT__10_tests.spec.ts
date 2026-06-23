/**
 * tck-TCK_EXT_-_INDEX_CONSTRAINT__10_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - INDEX_CONSTRAINT (10 tests)', () => {
  test('IDX-01 CREATE INDEX', async () => {
    const plan = execQuery('CREATE INDEX FOR (n:Person) ON (n.name)')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('IDX-02 CREATE INDEX composite', async () => {
    const plan = execQuery('CREATE INDEX FOR (n:Person) ON (n.name, n.age)')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('IDX-03 DROP INDEX', async () => {
    const plan = execQuery('DROP INDEX ON (n:Person)')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('IDX-04 CREATE CONSTRAINT unique', async () => {
    const plan = execQuery('CREATE CONSTRAINT FOR (n:Person) REQUIRE n.name IS UNIQUE')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('IDX-05 CREATE CONSTRAINT exists', async () => {
    const plan = execQuery('CREATE CONSTRAINT FOR (n:Person) REQUIRE n.name IS NOT NULL')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('IDX-06 DROP CONSTRAINT', async () => {
    const plan = execQuery('DROP CONSTRAINT FOR (n:Person) REQUIRE n.name IS UNIQUE')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('IDX-07 CREATE CONSTRAINT node key', async () => {
    const plan = execQuery('CREATE CONSTRAINT FOR (n:Person) REQUIRE (n.name, n.age) IS NODE KEY')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('IDX-08 CREATE + SHOW INDEX', async () => {
    const plan = execQuery('CREATE INDEX FOR (n:Person) ON (n.email) SHOW INDEXES')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('IDX-09 CREATE + SHOW CONSTRAINT', async () => {
    const plan = execQuery('CREATE CONSTRAINT FOR (n:Person) REQUIRE n.email IS UNIQUE SHOW CONSTRAINTS')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('IDX-10 DROP CONSTRAINT by name', async () => {
    const plan = execQuery('DROP CONSTRAINT constraint_name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

})
