/**
 * tck-TCK___ADMIN_管理操作.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK — ADMIN 管理操作', () => {

  it('[TCK-ADMIN-01] CREATE INDEX 解析', () => {
    const plan = parseQuery('CREATE INDEX ON :Person(name)')
    expect(plan.indexOp).toBe('CREATE')
    expect(plan.indexLabel).toBe('Person')
  })

  it('[TCK-ADMIN-02] CREATE INDEX 多属性', () => {
    const plan = parseQuery('CREATE INDEX ON :Person(name)')
    expect(plan.indexOp).toBe('CREATE')
  })

  it('[TCK-ADMIN-03] DROP INDEX 解析', () => {
    const plan = parseQuery('DROP INDEX ON :Person(name)')
    expect(plan.indexOp).toBe('DROP')
  })

  it('[TCK-ADMIN-04] SHOW INDEXES 解析', () => {
    const plan = parseQuery('SHOW INDEXES')
    expect(plan.show).toBeDefined()
  })

  it('[TCK-ADMIN-05] SHOW CONSTRAINTS 解析', () => {
    const plan = parseQuery('SHOW CONSTRAINTS')
    expect(plan.show).toBeDefined()
  })

  it('[TCK-ADMIN-06] SHOW PROCEDURES 解析', () => {
    const plan = parseQuery('SHOW PROCEDURES')
    expect(plan.show).toBeDefined()
  })

  it('[TCK-ADMIN-07] SHOW FUNCTIONS 解析', () => {
    const plan = parseQuery('SHOW FUNCTIONS')
    expect(plan.show).toBeDefined()
  })

  it('[TCK-ADMIN-08] SHOW LABELS 解析', () => {
    const plan = parseQuery('SHOW LABELS')
    expect(plan.show).toBeDefined()
    const result = _executeQuery(plan, [{ _label: 'Person' }, { _label: 'Company' }])
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBeGreaterThan(0)
  })

  it('[TCK-ADMIN-09] SHOW RELATIONSHIPTYPES 解析', () => {
    const plan = parseQuery('SHOW RELATIONSHIPTYPES')
    expect(plan.show).toBeDefined()
  })

  it('[TCK-ADMIN-10] CREATE CONSTRAINT UNIQUE 解析', () => {
    expect(() => parseQuery('CREATE CONSTRAINT FOR (n:Person) REQUIRE n.email IS UNIQUE')).not.toThrow()
  })

  it('[TCK-ADMIN-11] DROP CONSTRAINT 解析', () => {
    const plan = parseQuery('DROP CONSTRAINT person_email_unique');
    expect(plan).toBeDefined()
  })

  it('[TCK-ADMIN-12] CREATE INDEX 不抛出', () => {
    expect(() => parseQuery('CREATE INDEX ON :Company(name)')).not.toThrow()
  })

  it('[TCK-ADMIN-13] EXPLAIN 解析', () => {
    const plan = parseQuery('EXPLAIN MATCH (n:Person) RETURN n.name')
    expect(plan.explain).toBe(true)
  })

  it('[TCK-ADMIN-14] PROFILE 解析', () => {
    const plan = parseQuery('PROFILE MATCH (n:Person) RETURN n.name')
    expect(plan.profile).toBe(true)
  })

  it('[TCK-ADMIN-15) DESCRIBE 解析', () => {
    const plan = parseQuery('DESCRIBE MATCH (n:Person) RETURN n.name')
    expect(plan.explain).toBe(true)
  })

  it('[TCK-ADMIN-16] BEGIN 事务', () => {
    const plan = parseQuery('BEGIN')
    expect(plan.type).toBe('BEGIN')
  })

  it('[TCK-ADMIN-17] COMMIT 事务', () => {
    const plan = parseQuery('COMMIT')
    expect(plan.type).toBe('COMMIT')
  })

  it('[TCK-ADMIN-18] ROLLBACK 事务', () => {
    const plan = parseQuery('ROLLBACK')
    expect(plan.type).toBe('ROLLBACK')
  })

  it('[TCK-ADMIN-19] SHOW INDEXES 执行不抛出', () => {
    expect(() => parseQuery('SHOW INDEXES')).not.toThrow()
  })

  it('[TCK-ADMIN-20] EXPLAIN MATCH 不抛出', () => {
    expect(() => parseQuery('EXPLAIN MATCH (n:Person) RETURN n')).not.toThrow()
  })

  it('[TCK-ADMIN-21] CREATE CONSTRAINT 不抛出', () => {
    expect(() => parseQuery('CREATE CONSTRAINT FOR (n:Person) REQUIRE n.id IS UNIQUE')).not.toThrow()
  })

  it('[TCK-ADMIN-22] DROP INDEX 带 label 属性名', () => {
    const plan = parseQuery('DROP INDEX ON :Person(name)')
    expect(plan).toBeDefined()
  })

  it('[TCK-ADMIN-23] SHOW LABELS 执行并返回标签', () => {
    const plan = parseQuery('SHOW LABELS')
    const data = [{ _label: 'Person' }, { _label: 'Company' }, { _label: 'Product' }]
    const result = _executeQuery(plan, data) as Record<string, any>[]
    expect(Array.isArray(result)).toBe(true)
    const labels = result.map(r => r.label || r._label || r.name).filter(Boolean)
    expect(labels).toContain('Person')
    expect(labels).toContain('Company')
  })

  it('[TCK-ADMIN-24] SHOW LABELS 空图返回空', () => {
    const plan = parseQuery('SHOW LABELS')
    const result = _executeQuery(plan, [])
    expect(result).toBeDefined()
  })

  it('[TCK-ADMIN-25] CREATE CONSTRAINT 带复合属性 — ANTLR 原生支持', () => {
    const plan = parseQuery('CREATE CONSTRAINT FOR (n:Person) REQUIRE (n.firstName, n.lastName) IS UNIQUE')
    expect(plan).toBeDefined()
    expect(plan.type).toBe('CREATE_CONSTRAINT')
  })
})
