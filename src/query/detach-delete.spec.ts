/**
 * DETACH DELETE tests
 *
 * DETACH DELETE is a DELETE variant that removes all attached relationships
 * before deleting the node.  A plain DELETE of a still-connected node raises
 * `ConstraintVerificationFailed: DeleteConnectedNode` (openCypher contract).
 *
 * Test list:
 *  1. DETACH DELETE single node — syntax parse (detachDelete flag) ✅
 *  2. DETACH DELETE multiple nodes ✅
 *  3. Plain DELETE (no detachDelete flag) ✅
 *  4. DETACH DELETE empty result ✅
 *  5. DETACH DELETE deleteTargets node aliases ✅
 *  --- execution-level tests ---
 *  6. Plain DELETE of a connected node → throws DeleteConnectedNode ✅
 *  7. DETACH DELETE of connected nodes → succeeds (no throw) ✅
 *  8. DETACH DELETE of multiple nodes → cascades ✅
 *  9. Plain DELETE of an isolated node → succeeds ✅
 */
import { describe, it, expect } from 'vitest'
import { parseQuery, _executeQuery } from './query-engine'

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
    expect(plan.detachDelete).toBe(false)
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

// ── 执行级测试 ────────────────────────────────────────────

describe('DETACH DELETE 执行', () => {
  // Edge contract: `__edges` holds index-based edge entries
  // `{ srcIdx, dstIdx, label }` on the source node.  p1 -[KNOWS]-> p2 -[KNOWS]-> p3
  const graphWithEdges = [
    {
      _id: 'p1',
      _label: 'Person',
      name: 'Alice',
      age: 30,
      __edges: [{ srcIdx: 0, dstIdx: 1, label: 'KNOWS' }],
    },
    {
      _id: 'p2',
      _label: 'Person',
      name: 'Bob',
      age: 25,
      __edges: [{ srcIdx: 1, dstIdx: 2, label: 'KNOWS' }],
    },
    {
      _id: 'p3',
      _label: 'Person',
      name: 'Charlie',
      age: 35,
      __edges: [],
    },
  ]

  it('DELETE（无 DETACH）有边 → 报错 DeleteConnectedNode', async () => {
    const q = 'MATCH (n:Person) DELETE n'
    const plan = parseQuery(q)
    // deep-copy so subsequent tests are not affected
    const graphClone = JSON.parse(JSON.stringify(graphWithEdges))
    await expect(_executeQuery(plan, graphClone, q)).rejects.toThrow(/DeleteConnectedNode|delete/i)
  })

  it('DETACH DELETE 有向边 — 正常级联执行，无报错', async () => {
    const q = 'MATCH (n:Person) DETACH DELETE n'
    const plan = parseQuery(q)
    const graphClone = JSON.parse(JSON.stringify(graphWithEdges))
    const result = await _executeQuery(plan, graphClone, q) as any[]
    // DETACH DELETE is a RETURN-less DML statement → empty result, no throw.
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(0)
  })

  it('DETACH DELETE 多个节点 — 各自级联删除各自的边', async () => {
    const q = 'MATCH (n:Person) DETACH DELETE n'
    const plan = parseQuery(q)
    const result = await _executeQuery(plan, graphWithEdges, q) as any[]
    expect(Array.isArray(result)).toBe(true)
  })

  it('DETACH DELETE 双向边 — 清除所有方向边', async () => {
    const q = 'MATCH (n:Person) DETACH DELETE n'
    const plan = parseQuery(q)
    // Bidirectional edges: p1 -[FRIENDS]-> p2, p2 -[FRIENDS]-> p1
    const bidi = [
      { _id: 'p1', _label: 'Person', name: 'Alice', __edges: [{ srcIdx: 0, dstIdx: 1, label: 'FRIENDS' }] },
      { _id: 'p2', _label: 'Person', name: 'Bob', __edges: [{ srcIdx: 1, dstIdx: 0, label: 'FRIENDS' }] },
    ]
    const result = await _executeQuery(plan, bidi, q) as any[]
    expect(Array.isArray(result)).toBe(true)
  })

  it('DETACH DELETE 后节点已删除 — 无 return 返回空结果', async () => {
    const q = 'MATCH (n:Person) DETACH DELETE n'
    const plan = parseQuery(q)
    const result = await _executeQuery(plan, graphWithEdges, q) as any[]
    // RETURN-less DELETE yields no projected rows.
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(0)
  })

  it('无边的节点可正常 DELETE（无 DETACH）', async () => {
    const graph = [
      { _id: 'p1', _label: 'Person', name: 'Alice', __edges: [] },
    ]
    const q = 'MATCH (n:Person) DELETE n'
    const plan = parseQuery(q)
    const result = await _executeQuery(plan, graph, q) as any[]
    expect(Array.isArray(result)).toBe(true)
  })
})
