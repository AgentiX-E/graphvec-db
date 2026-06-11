import { describe, it, expect, vi, beforeAll } from 'vitest'

// Minimal mock — 只替换 parseQuery 顶层函数，不碰 parseCypherToPlan
vi.mock('../query-engine', async () => {
  const actual: any = await vi.importActual('../query-engine')
  const { parseCypherToPlan } = await import('../ast-to-plan-v2')
  return {
    ...actual,
    // 纯函数替换，不依赖任何 query-engine 内部状态
    parseQuery: (q: string) => parseCypherToPlan(q)
  }
})

// 只导入少量测试
import { parseQuery, _executeQuery } from '../query-engine'
import { parseCypherToPlan } from '../ast-to-plan-v2'

describe('Hang test', () => {
  it('should not hang', () => {
    const q = 'MATCH (n:Person) RETURN n'
    const p1 = parseQuery(q)
    const p2 = parseCypherToPlan(q)
    expect(p1.scanLabel).toBe(p2.scanLabel)
    expect(p1.returnColumns).toEqual(p2.returnColumns)
  })
  
  it('can execute', () => {
    const data = [{ id: '1', labels: ['Person'], props: { name: 'Alice' } }]
    const q = 'MATCH (n:Person) RETURN n.name'
    const plan = parseQuery(q)
    expect(plan.scanLabel).toBe('Person')
    // _executeQuery 用 plan
    const result = _executeQuery(plan, data)
    expect(result).toBeDefined()
  })
})
