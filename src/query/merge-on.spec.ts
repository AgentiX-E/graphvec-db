/**
 * merge-on.spec.ts — MERGE ON CREATE / ON MATCH 条件写测试
 *
 * 覆盖场景：
 * 1. MERGE ON CREATE SET 属性
 * 2. MERGE ON MATCH SET 属性
 * 3. MERGE ON CREATE + ON MATCH 同时使用
 * 4. MERGE ON CREATE 多个 SET 项
 * 5. MERGE 无 ON CREATE/MATCH（向后兼容）
 */

import { parseQuery, _executeQuery } from './query-engine'

describe('MERGE ON CREATE / ON MATCH', () => {
  // TC-1: MERGE ON CREATE SET 属性
  // MERGE (n:Label {id: 1}) ON CREATE SET n.x = 10
  it('TC-1: MERGE ON CREATE SET 属性——节点不存在时应创建并设置', () => {
    const query = "MERGE (n:Label {id: 1}) ON CREATE SET n.x = 10"
    const plan = parseQuery(query)

    // 验证解析
    expect(plan.type).toBe('MERGE')
    expect(plan.mergeNodes).toBeDefined()
    expect(plan.mergeNodes!.length).toBe(1)
    expect(plan.mergeNodes![0].alias).toBe('n')
    expect(plan.mergeNodes![0].label).toBe('Label')
    // Props are stored as PEG AST (resolved at execution time)
    expect(plan.mergeOnCreate).toBeDefined()
    expect(plan.mergeOnCreate!.length).toBe(1)
    // property is plain property name (without variable prefix)
    expect(plan.mergeOnCreate![0].property).toBe('x')
    expect(plan.mergeOnCreate![0].value).toBe(10)

    // 执行：节点不存在 → 创建 + ON CREATE SET
    const nodes: Array<Record<string, unknown>> = []
    const result = _executeQuery(plan, nodes)
    expect(nodes.length).toBe(1) // 新创建了一个节点
    expect(result.length).toBe(1)

    // 验证 ON CREATE SET 生效：x 应该等于 10
    const createdNode = nodes[0]
    expect(createdNode['id']).toBe(1)
    expect(createdNode['x']).toBe(10)
  })

  // TC-2: MERGE ON MATCH SET 属性
  // MERGE (n:Label {id: 1}) ON MATCH SET n.x = 99
  it('TC-2: MERGE ON MATCH SET 属性——节点已存在时应更新', () => {
    const query = "MERGE (n:Label {id: 1}) ON MATCH SET n.x = 99"
    const plan = parseQuery(query)

    // 验证解析
    expect(plan.type).toBe('MERGE')
    expect(plan.mergeOnMatch).toBeDefined()
    expect(plan.mergeOnMatch!.length).toBe(1)
    expect(plan.mergeOnMatch![0].property).toBe('x')
    expect(plan.mergeOnMatch![0].value).toBe(99)

    // 执行：节点已存在 → ON MATCH SET
    const existingNode: Record<string, unknown> = { id: 1, x: 1, _label: 'Label' }
    const nodes = [existingNode]
    const result = _executeQuery(plan, nodes)

    // 验证节点数不变（只有 1 个节点）
    expect(nodes.length).toBe(1)

    // 验证 ON MATCH SET 生效
    expect(nodes[0]['x']).toBe(99)

    // 验证返回结果
    const returnedX = result.map(r => r['x'])
    expect(returnedX).toEqual([99])
  })

  // TC-3: MERGE ON CREATE + ON MATCH 同时使用
  // MERGE (n:Label {id: 2}) ON CREATE SET n.x = 1 ON MATCH SET n.x = 2
  it('TC-3: MERGE ON CREATE + ON MATCH 同时使用', () => {
    const query = "MERGE (n:Label {id: 2}) ON CREATE SET n.x = 1 ON MATCH SET n.x = 2"
    const plan = parseQuery(query)

    // 验证解析
    expect(plan.type).toBe('MERGE')
    expect(plan.mergeOnCreate).toBeDefined()
    expect(plan.mergeOnCreate!.length).toBe(1)
    expect(plan.mergeOnCreate![0].property).toBe('x')
    expect(plan.mergeOnCreate![0].value).toBe(1)
    expect(plan.mergeOnMatch).toBeDefined()
    expect(plan.mergeOnMatch!.length).toBe(1)
    expect(plan.mergeOnMatch![0].property).toBe('x')
    expect(plan.mergeOnMatch![0].value).toBe(2)

    // === 场景 A: 节点不存在 → 应触发 ON CREATE ===
    const nodesA: Array<Record<string, unknown>> = []
    const resultA = _executeQuery(plan, nodesA)
    expect(nodesA.length).toBe(1) // 新创建
    expect(nodesA[0]['id']).toBe(2)
    expect(nodesA[0]['x']).toBe(1) // ON CREATE: x = 1

    // === 场景 B: 节点已存在 → 应触发 ON MATCH ===
    const existingNode: Record<string, unknown> = { id: 2, x: 0, _label: 'Label' }
    const nodesB = [existingNode]
    const resultB = _executeQuery(plan, nodesB)
    expect(nodesB.length).toBe(1) // 未创建新节点
    expect(nodesB[0]['x']).toBe(2) // ON MATCH: x = 2
  })

  // TC-4: MERGE ON CREATE 多个 SET 项
  // MERGE (n:Label {id: 3}) ON CREATE SET n.x = 10, n.y = 20
  it('TC-4: MERGE ON CREATE 多个 SET 项', () => {
    const query = "MERGE (n:Label {id: 3}) ON CREATE SET n.x = 10, n.y = 20"
    const plan = parseQuery(query)

    // 验证解析
    expect(plan.type).toBe('MERGE')
    expect(plan.mergeOnCreate).toBeDefined()
    expect(plan.mergeOnCreate!.length).toBe(2)
    expect(plan.mergeOnCreate![0].property).toBe('x')
    expect(plan.mergeOnCreate![0].value).toBe(10)
    expect(plan.mergeOnCreate![1].property).toBe('y')
    expect(plan.mergeOnCreate![1].value).toBe(20)

    // 执行：节点不存在 → 创建 + 两个 SET
    const nodes: Array<Record<string, unknown>> = []
    const result = _executeQuery(plan, nodes)
    expect(nodes.length).toBe(1)
    expect(nodes[0]['id']).toBe(3)
    expect(nodes[0]['x']).toBe(10)
    expect(nodes[0]['y']).toBe(20)
  })

  // TC-5: MERGE 无 ON CREATE/MATCH（向后兼容）
  // MERGE (n:Label {id: 4})
  it('TC-5: MERGE 无 ON CREATE/MATCH（向后兼容）', () => {
    const query = "MERGE (n:Label {id: 4})"
    const plan = parseQuery(query)

    // 验证解析：没有 onCreate/Match
    expect(plan.type).toBe('MERGE')
    expect(plan.mergeOnCreate).toBeUndefined()
    expect(plan.mergeOnMatch).toBeUndefined()

    // === 场景 A: 节点不存在 → 创建，无额外 SET ===
    const nodesA: Array<Record<string, unknown>> = []
    const resultA = _executeQuery(plan, nodesA)
    expect(nodesA.length).toBe(1)
    expect(nodesA[0]['id']).toBe(4)
    expect(nodesA[0]['x']).toBeUndefined() // 无 ON CREATE，x 不应存在

    // === 场景 B: 节点已存在 → 匹配，无额外 SET ===
    const existingNode: Record<string, unknown> = { id: 4, x: 100, _label: 'Label' }
    const nodesB = [existingNode]
    const resultB = _executeQuery(plan, nodesB)
    expect(nodesB.length).toBe(1)
    expect(nodesB[0]['x']).toBe(100) // 未改变
  })

  // ── 新增 tests ──

  // TC-6: MERGE ON CREATE SET 多属性 + ON MATCH SET 多属性
  it('TC-6: MERGE ON CREATE 和 ON MATCH 各两个 SET 项', () => {
    const query = "MERGE (n:Label {id: 5}) ON CREATE SET n.x = 10, n.y = 20 ON MATCH SET n.x = 99, n.z = 88"
    const plan = parseQuery(query)

    expect(plan.type).toBe('MERGE')
    expect(plan.mergeOnCreate).toBeDefined()
    expect(plan.mergeOnCreate!.length).toBe(2)
    expect(plan.mergeOnMatch).toBeDefined()
    expect(plan.mergeOnMatch!.length).toBe(2)

    // 场景 A: 不存在 → ON CREATE
    const nodesA: Array<Record<string, unknown>> = []
    _executeQuery(plan, nodesA)
    expect(nodesA.length).toBe(1)
    expect(nodesA[0]['id']).toBe(5)
    expect(nodesA[0]['x']).toBe(10)
    expect(nodesA[0]['y']).toBe(20)

    // 场景 B: 已存在 → ON MATCH
    const existingNode: Record<string, unknown> = { id: 5, x: 0, y: 0, _label: 'Label' }
    const nodesB = [existingNode]
    _executeQuery(plan, nodesB)
    expect(nodesB.length).toBe(1)
    expect(nodesB[0]['x']).toBe(99)
    expect(nodesB[0]['z']).toBe(88)
  })

  // TC-7: MERGE ON CREATE 字符串属性
  it('TC-7: MERGE ON CREATE SET 字符串属性值', () => {
    const query = 'MERGE (n:Label {id: 6}) ON CREATE SET n.name = "created"'
    const plan = parseQuery(query)

    expect(plan.mergeOnCreate![0].property).toBe('name')
    expect(plan.mergeOnCreate![0].value).toBe('created')

    const nodes: Array<Record<string, unknown>> = []
    _executeQuery(plan, nodes)
    expect(nodes[0]['name']).toBe('created')
  })

  // TC-8: MERGE ON CREATE + ON MATCH 值不同
  it('TC-8: MERGE ON CREATE SET x=1 ON MATCH SET x=2 按条件正确应用', () => {
    const query = "MERGE (n:Label {id: 7}) ON CREATE SET n.status = 'new' ON MATCH SET n.status = 'existing'"
    const plan = parseQuery(query)

    // 不存在 → ON CREATE
    const nodesA: Array<Record<string, unknown>> = []
    _executeQuery(plan, nodesA)
    expect(nodesA[0]['status']).toBe('new')

    // 已存在 → ON MATCH
    const existingNode: Record<string, unknown> = { id: 7, status: 'unknown', _label: 'Label' }
    const nodesB = [existingNode]
    _executeQuery(plan, nodesB)
    expect(nodesB[0]['status']).toBe('existing')
  })

  // TC-9: MERGE 带多个 match key
  it('TC-9: MERGE 匹配多个属性 key', () => {
    const query = "MERGE (n:Label {id: 8, name: 'test'}) ON CREATE SET n.x = 1"
    const plan = parseQuery(query)

    expect(plan.type).toBe('MERGE')
    expect(plan.mergeNodes).toBeDefined()
    expect(plan.mergeNodes![0].props).toBeDefined()
    expect(plan.mergeNodes![0].props.id).toBeDefined()
    expect(plan.mergeNodes![0].props.name).toBeDefined()
    expect((plan.mergeNodes![0].props as Record<string, any>).id.value).toBe(8)
    expect((plan.mergeNodes![0].props as Record<string, any>).name.value).toBe('test')
  })
})
