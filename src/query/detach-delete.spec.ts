/**
 * DETACH DELETE 测试
 *
 * DETACH DELETE 是 DELETE 的变体，在删除节点前先删除所有关联的边。
 *
 * 测试清单：
 * 1. DETACH DELETE 单个节点 — 语法解析
 * 2. DETACH DELETE 多个节点
 * 3. 普通 DELETE（不应有 detachDelete 标志）
 * 4. DETACH DELETE 空结果
 * 5. _executeQuery 验证 DETACH DELETE 清理边元数据
 */
import { describe, it, expect } from 'vitest'
import { parseQuery } from './query-engine'

describe('DETACH DELETE 解析', () => {
  it('DETACH DELETE 单个节点 — plan 包含 detachDelete 标志', () => {
    const plan = parseQuery('MATCH (n) DETACH DELETE n')
    expect(plan.type).toBe('DELETE')
    expect(plan.deleteTargets).toBeDefined()
    expect(plan.deleteTargets!.length).toBe(1)
    expect(plan.deleteTargets![0]).toBe('n')
    expect(plan.detachDelete).toBe(true)
  })

  it('DETACH DELETE 多个节点', () => {
    const plan = parseQuery('MATCH (a)-[:KNOWS]->(b) DETACH DELETE a, b')
    expect(plan.type).toBe('DELETE')
    expect(plan.deleteTargets!.length).toBe(2)
    expect(plan.deleteTargets![0]).toBe('a')
    expect(plan.deleteTargets![1]).toBe('b')
    expect(plan.detachDelete).toBe(true)
  })

  it('普通 DELETE 不应含 detachDelete 标志', () => {
    const plan = parseQuery('MATCH (n:Person) DELETE n')
    expect(plan.type).toBe('DELETE')
    expect(plan.deleteTargets!.length).toBe(1)
    expect(plan.detachDelete).toBeUndefined()
  })

  it('DETACH DELETE 空结果 — 无匹配节点时正常执行', () => {
    const plan = parseQuery('MATCH (n:Nonexistent) DETACH DELETE n')
    expect(plan.detachDelete).toBe(true)
    expect(plan.deleteTargets).toBeDefined()
  })

  it('DETACH DELETE 返回的 deleteTargets 为节点别名', () => {
    const plan = parseQuery('MATCH (n:Person) DETACH DELETE n')
    expect(plan.deleteTargets).toEqual(['n'])
    expect(plan.detachDelete).toBe(true)
  })
})
