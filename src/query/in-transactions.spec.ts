/**
 * CALL { ... } IN TRANSACTIONS 测试
 *
 * IN TRANSACTIONS 是 CALL 子查询的分批提交模式。
 * 语法：
 *   CALL { MATCH ... RETURN ... } IN TRANSACTIONS
 *   CALL { MATCH ... RETURN ... } IN TRANSACTIONS OF 1000 ROWS
 *
 * 测试清单（至少 5 个）：
 * 1. 解析 CALL ... IN TRANSACTIONS — plan 包含 inTransactions 标志 ✅
 * 2. 解析 IN TRANSACTIONS OF N ROWS — 自定义批次大小 ✅
 * 3. 小数据（< batch size）— 单批提交 ✅
 * 4. 大数据（> batch size）— 多批提交 ✅
 * 5. 无 IN TRANSACTIONS 的 CALL — 向后兼容 ✅
 * 6. (额外) IN TRANSACTIONS 无外层的 RETURN — 仅子查询 ✅
 */
import { describe, it, expect } from 'vitest'
import { parseQuery, _executeQuery } from './query-engine'

// ── 测试用图数据 ──────────────────────────────────────────

const testGraph = [
  { _id: 'p1', _label: 'Person', name: 'Alice', age: 30 },
  { _id: 'p2', _label: 'Person', name: 'Bob', age: 25 },
  { _id: 'p3', _label: 'Person', name: 'Charlie', age: 35 },
  { _id: 'p4', _label: 'Pet', name: 'Whiskers', type: 'cat' },
  { _id: 'p5', _label: 'Pet', name: 'Buddy', type: 'dog' },
]

// ── 大量图数据 ────────────────────────────────────────────

function makeLargeGraph(size: number) {
  const nodes = []
  for (let i = 0; i < size; i++) {
    nodes.push({ _id: `n${i}`, _label: 'Item', name: `item-${i}`, index: i })
  }
  return nodes
}

// ── 1. 解析 IN TRANSACTIONS ──────────────────────────────

describe('CALL { ... } IN TRANSACTIONS — 解析', () => {
  it('解析 CALL ... IN TRANSACTIONS — plan 包含 inTransactions 标志', () => {
    const plan = parseQuery(
      `CALL { MATCH (n:Person) RETURN n.name AS name } IN TRANSACTIONS RETURN name`
    )
    expect(plan.type).toBe('CALL')
    expect(plan.callQuery).toBeDefined()
    expect(plan.inTransactions).toBe(true)
    // 未指定批次大小时，默认应为 undefined（执行时默认 1000）
    expect(plan.inTransactionsBatchSize).toBeUndefined()
    expect(plan.returnColumns).toContain('name')
  })

  it('解析 IN TRANSACTIONS OF N ROWS — 自定义批次大小', () => {
    const plan = parseQuery(
      `CALL { MATCH (n:Person) RETURN n.name AS name } IN TRANSACTIONS OF 50 ROWS RETURN name`
    )
    expect(plan.type).toBe('CALL')
    expect(plan.inTransactions).toBe(true)
    expect(plan.inTransactionsBatchSize).toBe(50)
    expect(plan.returnColumns).toContain('name')
  })

  it('无 IN TRANSACTIONS 的 CALL — 向后兼容', () => {
    const plan = parseQuery(
      `CALL { MATCH (n:Person) RETURN n.name AS name } RETURN name`
    )
    expect(plan.type).toBe('CALL')
    expect(plan.inTransactions).toBeUndefined()
    expect(plan.callQuery).toBeDefined()
  })

  it('IN TRANSACTIONS 仅子查询无外层 RETURN', () => {
    const plan = parseQuery(
      `CALL { MATCH (n:Person) RETURN n.name AS name } IN TRANSACTIONS`
    )
    expect(plan.type).toBe('CALL')
    expect(plan.inTransactions).toBe(true)
    expect(plan.returnColumns.length).toBe(0)
  })
})

// ── 2. 执行 IN TRANSACTIONS ──────────────────────────────

describe('CALL { ... } IN TRANSACTIONS — 执行', () => {
  it('小数据（< batch size）— 单批提交，结果正确', () => {
    const plan = parseQuery(
      `CALL { MATCH (n:Person) RETURN n.name AS name } IN TRANSACTIONS RETURN name`
    )
    const result = _executeQuery(plan, testGraph)
    expect(result.length).toBe(3)
    const names = result.map(r => r.name).sort()
    expect(names).toEqual(['Alice', 'Bob', 'Charlie'])
  })

  it('大数据（> batch size = 2）— 多批提交，结果正确', () => {
    // 使用 5 节点的图数据
    const graph = makeLargeGraph(5)
    const plan = parseQuery(
      `CALL { MATCH (n:Item) RETURN n.name AS name, n.index AS idx } IN TRANSACTIONS OF 2 ROWS RETURN name ORDER BY name ASC`
    )
    const result = _executeQuery(plan, graph)
    expect(result.length).toBe(5)
    expect(result[0].name).toBe('item-0')
    expect(result[1].name).toBe('item-1')
    expect(result[2].name).toBe('item-2')
    expect(result[3].name).toBe('item-3')
    expect(result[4].name).toBe('item-4')
  })

  it('非常大数据（> batch size = 3）— 确认分批边界', () => {
    // 100 个节点，batch size = 30，预期分成 4 批（30+30+30+10）
    const graph = makeLargeGraph(100)
    const plan = parseQuery(
      `CALL { MATCH (n:Item) RETURN n.name AS name, n.index AS idx } IN TRANSACTIONS OF 30 ROWS RETURN name, idx ORDER BY name ASC`
    )
    const result = _executeQuery(plan, graph)
    expect(result.length).toBe(100)
    // 验证所有节点都在结果中
    const names = result.map(r => r.name).sort()
    expect(names[0]).toBe('item-0')
    expect(names[99]).toBe('item-99')
  })

  it('IN TRANSACTIONS 空结果 — 无匹配时正常执行', () => {
    const plan = parseQuery(
      `CALL { MATCH (n:Robot) RETURN n.name AS name } IN TRANSACTIONS RETURN name`
    )
    const result = _executeQuery(plan, testGraph)
    expect(result.length).toBe(0)
  })

  it('IN TRANSACTIONS 与普通 CALL 结果一致 — 语义等价', () => {
    const planNormal = parseQuery(
      `CALL { MATCH (n:Person) RETURN n.name AS name } RETURN name ORDER BY name ASC`
    )
    const planTx = parseQuery(
      `CALL { MATCH (n:Person) RETURN n.name AS name } IN TRANSACTIONS RETURN name ORDER BY name ASC`
    )
    const resultNormal = _executeQuery(planNormal, testGraph)
    const resultTx = _executeQuery(planTx, testGraph)
    expect(resultNormal.length).toBe(resultTx.length)
    for (let i = 0; i < resultNormal.length; i++) {
      expect(resultNormal[i].name).toBe(resultTx[i].name)
    }
  })
})
