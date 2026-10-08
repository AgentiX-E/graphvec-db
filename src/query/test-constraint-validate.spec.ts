import { describe, it, expect, beforeEach } from 'vitest'
import { parseQuery, _executeQuery, _clearConstraints, _getAllConstraints } from './query-engine'

describe('CREATE CONSTRAINT — 唯一性约束验证', () => {
  beforeEach(() => {
    _clearConstraints()
  })

  it('CREATE CONSTRAINT 重复值报错 — 现有数据有重复', async () => {
    const plan = parseQuery('CREATE CONSTRAINT ON (n:Person) ASSERT n.age IS UNIQUE')
    const nodes = [
      { _label: 'Person', name: 'Alice', age: 25 },
      { _label: 'Person', name: 'Bob', age: 25 }
    ]
    await expect(_executeQuery(plan, nodes, 'CREATE CONSTRAINT ON (n:Person) ASSERT n.age IS UNIQUE')).rejects.toThrow('ConstraintValidationFailed')
    // 约束不应被注册（因为验证失败）
    expect(_getAllConstraints().length).toBe(0)
  })

  it('CREATE CONSTRAINT 无重复 — 注册成功', async () => {
    const plan = parseQuery('CREATE CONSTRAINT ON (n:Person) ASSERT n.age IS UNIQUE')
    const nodes = [
      { _label: 'Person', name: 'Alice', age: 25 },
      { _label: 'Person', name: 'Bob', age: 30 }
    ]
    await _executeQuery(plan, nodes, 'CREATE CONSTRAINT ON (n:Person) ASSERT n.age IS UNIQUE')
    expect(_getAllConstraints().length).toBe(1)
    expect(_getAllConstraints()[0].label).toBe('Person')
    expect(_getAllConstraints()[0].property).toBe('age')
  })

  it('null 值不违反唯一约束', async () => {
    const plan = parseQuery('CREATE CONSTRAINT ON (n:Person) ASSERT n.age IS UNIQUE')
    const nodes = [
      { _label: 'Person', name: 'Alice', age: null },
      { _label: 'Person', name: 'Bob', age: null }
    ]
    await _executeQuery(plan, nodes, 'CREATE CONSTRAINT ON (n:Person) ASSERT n.age IS UNIQUE')
    expect(_getAllConstraints().length).toBe(1)
  })

  it('不同 label 的重复值不影响', async () => {
    const plan = parseQuery('CREATE CONSTRAINT ON (n:Person) ASSERT n.email IS UNIQUE')
    const nodes = [
      { _label: 'Person', name: 'Alice', email: 'a@x.com' },
      { _label: 'User', name: 'Bob', email: 'a@x.com' }
    ]
    await _executeQuery(plan, nodes, 'CREATE CONSTRAINT ON (n:Person) ASSERT n.email IS UNIQUE')
    expect(_getAllConstraints().length).toBe(1)
  })

  it('重复执行同一约束是幂等的（不会报错）', async () => {
    const plan = parseQuery('CREATE CONSTRAINT ON (n:Person) ASSERT n.age IS UNIQUE')
    const nodes = [{ _label: 'Person', name: 'Alice', age: 25 }]
    await _executeQuery(plan, nodes, 'CREATE CONSTRAINT ON (n:Person) ASSERT n.age IS UNIQUE')
    await _executeQuery(plan, nodes, 'CREATE CONSTRAINT ON (n:Person) ASSERT n.age IS UNIQUE')
    expect(_getAllConstraints().length).toBe(1)
  })

  it('CREATE 节点违反已注册约束', async () => {
    const constraintPlan = parseQuery('CREATE CONSTRAINT ON (n:Person) ASSERT n.email IS UNIQUE')
    await _executeQuery(constraintPlan, [{ _label: 'Person', email: 'a@x.com' }], 'CREATE CONSTRAINT ON (n:Person) ASSERT n.email IS UNIQUE')
    expect(_getAllConstraints().length).toBe(1)

    const createPlan = parseQuery('CREATE (n:Person {email: "a@x.com"}) RETURN n')
    const existingNodes = [{ _label: 'Person', email: 'a@x.com', name: 'Existing1' }]
    await expect(_executeQuery(createPlan, existingNodes, 'CREATE (n:Person {email: "a@x.com"}) RETURN n')).rejects.toThrow('ConstraintValidationFailed')
  })

  it('CREATE 唯一值不违反约束', async () => {
    const constraintPlan = parseQuery('CREATE CONSTRAINT ON (n:Person) ASSERT n.email IS UNIQUE')
    await _executeQuery(constraintPlan, [{ _label: 'Person', email: 'a@x.com' }], 'CREATE CONSTRAINT ON (n:Person) ASSERT n.email IS UNIQUE')

    const createPlan = parseQuery('CREATE (n:Person {email: "different@x.com"}) RETURN n')
    const existingNodes = [{ _label: 'Person', email: 'existing@x.com', name: 'Old' }]
    await _executeQuery(createPlan, existingNodes, 'CREATE (n:Person {email: "different@x.com"}) RETURN n')
  })
})
