import { describe, it, expect, beforeEach } from 'vitest'
import { parseQuery, _executeQuery, _clearConstraints, _getAllConstraints } from './src/query/query-engine'

describe('CREATE CONSTRAINT — 唯一性约束验证', () => {
  beforeEach(() => {
    _clearConstraints()
  })

  it('CREATE CONSTRAINT 重复值报错 — 现有数据有重复', () => {
    const plan = parseQuery('CREATE CONSTRAINT ON (n:Person) ASSERT n.age IS UNIQUE')
    const nodes = [
      { _label: 'Person', name: 'Alice', age: 25 },
      { _label: 'Person', name: 'Bob', age: 25 }
    ]
    expect(() => _executeQuery(plan, nodes)).toThrow('ConstraintValidationFailed')
    // 约束不应被注册（因为验证失败）
    expect(_getAllConstraints().length).toBe(0)
  })

  it('CREATE CONSTRAINT 无重复 — 注册成功', () => {
    const plan = parseQuery('CREATE CONSTRAINT ON (n:Person) ASSERT n.age IS UNIQUE')
    const nodes = [
      { _label: 'Person', name: 'Alice', age: 25 },
      { _label: 'Person', name: 'Bob', age: 30 }
    ]
    expect(() => _executeQuery(plan, nodes)).not.toThrow()
    expect(_getAllConstraints().length).toBe(1)
    expect(_getAllConstraints()[0].label).toBe('Person')
    expect(_getAllConstraints()[0].property).toBe('age')
  })

  it('null 值不违反唯一约束', () => {
    const plan = parseQuery('CREATE CONSTRAINT ON (n:Person) ASSERT n.age IS UNIQUE')
    const nodes = [
      { _label: 'Person', name: 'Alice', age: null },
      { _label: 'Person', name: 'Bob', age: null }
    ]
    expect(() => _executeQuery(plan, nodes)).not.toThrow()
    expect(_getAllConstraints().length).toBe(1)
  })

  it('不同 label 的重复值不影响', () => {
    const plan = parseQuery('CREATE CONSTRAINT ON (n:Person) ASSERT n.email IS UNIQUE')
    const nodes = [
      { _label: 'Person', name: 'Alice', email: 'a@x.com' },
      { _label: 'User', name: 'Bob', email: 'a@x.com' }
    ]
    expect(() => _executeQuery(plan, nodes)).not.toThrow()
  })

  it('重复执行同一约束是幂等的（不会报错）', () => {
    const plan = parseQuery('CREATE CONSTRAINT ON (n:Person) ASSERT n.age IS UNIQUE')
    const nodes = [{ _label: 'Person', name: 'Alice', age: 25 }]
    expect(() => {
      _executeQuery(plan, nodes)
      _executeQuery(plan, nodes)
    }).not.toThrow()
    expect(_getAllConstraints().length).toBe(1)
  })

  it('CREATE 节点违反已注册约束', () => {
    // 先注册约束
    const constraintPlan = parseQuery('CREATE CONSTRAINT ON (n:Person) ASSERT n.email IS UNIQUE')
    _executeQuery(constraintPlan, [{ _label: 'Person', email: 'a@x.com' }])
    expect(_getAllConstraints().length).toBe(1)

    // 然后创建新节点，email 重复
    const createPlan = parseQuery('CREATE (n:Person {email: "a@x.com"}) RETURN n')
    const existingNodes = [{ _label: 'Person', email: 'a@x.com', name: 'Existing1' }]
    expect(() => {
      _executeQuery(createPlan, existingNodes)
    }).toThrow('ConstraintValidationFailed')
  })

  it('CREATE 唯一值不违反约束', () => {
    const constraintPlan = parseQuery('CREATE CONSTRAINT ON (n:Person) ASSERT n.email IS UNIQUE')
    _executeQuery(constraintPlan, [{ _label: 'Person', email: 'a@x.com' }])

    const createPlan = parseQuery('CREATE (n:Person {email: "different@x.com"}) RETURN n')
    const existingNodes = [{ _label: 'Person', email: 'existing@x.com', name: 'Old' }]
    expect(() => {
      _executeQuery(createPlan, existingNodes)
    }).not.toThrow()
  })
})
