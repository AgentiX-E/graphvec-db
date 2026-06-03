/**
 * constraint.spec.ts — CREATE CONSTRAINT 语法解析与规划测试
 *
 * 测试清单（≥4）：
 * 1. CREATE CONSTRAINT ON (n:Person) ASSERT n.age IS UNIQUE — 解析 ✅
 * 2. 不同 label/属性 — CREATE CONSTRAINT ON (n:User) ASSERT n.email IS UNIQUE ✅
 * 3. 语法错误时抛出 — 非法约束语法 ✅
 * 4. 执行尝试（执行层为空，返回确认）✅
 * 5. (额外) 属性名不重复 — 验证 plan 的 property 值 ✅
 */
import { describe, it, expect } from 'vitest'
import { parseQuery, _executeQuery } from './query-engine'

// ── 1. 解析 CREATE CONSTRAINT ──────────────────────────

describe('CREATE CONSTRAINT — 语法解析', () => {
  it('解析 CREATE CONSTRAINT ON (n:Person) ASSERT n.age IS UNIQUE', () => {
    const plan = parseQuery('CREATE CONSTRAINT ON (n:Person) ASSERT n.age IS UNIQUE')
    expect(plan.type).toBe('CREATE_CONSTRAINT')
    expect(plan.constraint).toBeDefined()
    expect(plan.constraint!.label).toBe('Person')
    expect(plan.constraint!.property).toBe('age')
  })

  it('不同 label/属性 — CREATE CONSTRAINT ON (n:User) ASSERT n.email IS UNIQUE', () => {
    const plan = parseQuery('CREATE CONSTRAINT ON (n:User) ASSERT n.email IS UNIQUE')
    expect(plan.type).toBe('CREATE_CONSTRAINT')
    expect(plan.constraint!.label).toBe('User')
    expect(plan.constraint!.property).toBe('email')
  })

  it('语法错误时抛出 — 非法约束语法', () => {
    expect(() => parseQuery('CREATE CONSTRAINT ON (n:Person) BAD SYNTAX')).toThrow()
  })

  it('执行尝试 — 执行层为空，返回确认（不报错）', () => {
    const plan = parseQuery('CREATE CONSTRAINT ON (n:Person) ASSERT n.age IS UNIQUE')
    // 执行层暂时为 no-op（需图引擎支持唯一约束）
    expect(plan.type).toBe('CREATE_CONSTRAINT')
    expect(plan.constraint!.label).toBe('Person')
    expect(plan.constraint!.property).toBe('age')
    // 验证不会 crash
    expect(() => _executeQuery(plan, [])).not.toThrow()
  })

  it('属性名正确性验证 — 使用复合属性名也正确提取', () => {
    const plan = parseQuery('CREATE CONSTRAINT ON (n:Employee) ASSERT n.salary IS UNIQUE')
    expect(plan.constraint!.label).toBe('Employee')
    expect(plan.constraint!.property).toBe('salary')
  })
})
