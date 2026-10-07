/**
 * merge-on.spec.ts — MERGE ON CREATE / ON MATCH conditional-write tests.
 *
 * These drive the full executor and assert the side effects actually land on the
 * caller's node array (the TCK splits only smoke-check plan/result existence).
 */

import { parseQuery, _executeQuery } from './query-engine'

describe('MERGE ON CREATE / ON MATCH', () => {
  it('TC-1: ON CREATE SET 属性——节点不存在时创建并设置', async () => {
    const query = "MERGE (n:Label {id: 1}) ON CREATE SET n.x = 10"
    const plan = parseQuery(query)

    expect(plan.type).toBe('MERGE')
    expect(plan.mergeNodes!.length).toBe(1)
    expect(plan.mergeNodes![0].alias).toBe('n')
    expect(plan.mergeNodes![0].label).toBe('Label')
    expect(plan.mergeOnCreate!.length).toBe(1)
    expect(plan.mergeOnCreate![0].property).toBe('x')
    expect(plan.mergeOnCreate![0].value).toBe(10)

    const nodes: Array<Record<string, unknown>> = []
    const result = await _executeQuery(plan, nodes, query) as any[]
    // A bare MERGE (no RETURN) is a data-only statement: no result rows.
    expect(result).toEqual([])
    expect(nodes.length).toBe(1)
    expect(nodes[0]['id']).toBe(1)
    expect(nodes[0]['x']).toBe(10)
  })

  it('TC-2: ON MATCH SET 属性——节点已存在时更新', async () => {
    const query = "MERGE (n:Label {id: 1}) ON MATCH SET n.x = 99"
    const plan = parseQuery(query)

    expect(plan.type).toBe('MERGE')
    expect(plan.mergeOnMatch!.length).toBe(1)
    expect(plan.mergeOnMatch![0].property).toBe('x')
    expect(plan.mergeOnMatch![0].value).toBe(99)

    const nodes: Array<Record<string, unknown>> = [{ id: 1, x: 1, _label: 'Label' }]
    await _executeQuery(plan, nodes, query)
    expect(nodes.length).toBe(1)
    expect(nodes[0]['x']).toBe(99)
  })

  it('TC-3: ON CREATE + ON MATCH 同时使用', async () => {
    const query = "MERGE (n:Label {id: 2}) ON CREATE SET n.x = 1 ON MATCH SET n.x = 2"
    const plan = parseQuery(query)

    expect(plan.mergeOnCreate!.length).toBe(1)
    expect(plan.mergeOnCreate![0].value).toBe(1)
    expect(plan.mergeOnMatch!.length).toBe(1)
    expect(plan.mergeOnMatch![0].value).toBe(2)

    // Scenario A: node absent -> ON CREATE
    const nodesA: Array<Record<string, unknown>> = []
    await _executeQuery(plan, nodesA, query)
    expect(nodesA.length).toBe(1)
    expect(nodesA[0]['x']).toBe(1)

    // Scenario B: node present -> ON MATCH
    const nodesB: Array<Record<string, unknown>> = [{ id: 2, x: 0, _label: 'Label' }]
    await _executeQuery(plan, nodesB, query)
    expect(nodesB.length).toBe(1)
    expect(nodesB[0]['x']).toBe(2)
  })

  it('TC-4: ON CREATE 多个 SET 项', async () => {
    const query = "MERGE (n:Label {id: 3}) ON CREATE SET n.x = 10, n.y = 20"
    const plan = parseQuery(query)

    expect(plan.mergeOnCreate!.length).toBe(2)
    expect(plan.mergeOnCreate![0].value).toBe(10)
    expect(plan.mergeOnCreate![1].value).toBe(20)

    const nodes: Array<Record<string, unknown>> = []
    await _executeQuery(plan, nodes, query)
    expect(nodes.length).toBe(1)
    expect(nodes[0]['x']).toBe(10)
    expect(nodes[0]['y']).toBe(20)
  })

  it('TC-5: 无 ON CREATE/MATCH（向后兼容）', async () => {
    const query = "MERGE (n:Label {id: 4})"
    const plan = parseQuery(query)

    expect(plan.type).toBe('MERGE')
    expect(plan.mergeOnCreate).toBeUndefined()
    expect(plan.mergeOnMatch).toBeUndefined()

    // Scenario A: absent -> create without SET
    const nodesA: Array<Record<string, unknown>> = []
    await _executeQuery(plan, nodesA, query)
    expect(nodesA.length).toBe(1)
    expect(nodesA[0]['id']).toBe(4)
    expect(nodesA[0]['x']).toBeUndefined()

    // Scenario B: present -> match without SET
    const nodesB: Array<Record<string, unknown>> = [{ id: 4, x: 100, _label: 'Label' }]
    await _executeQuery(plan, nodesB, query)
    expect(nodesB.length).toBe(1)
    expect(nodesB[0]['x']).toBe(100)
  })

  it('TC-6: ON CREATE 和 ON MATCH 各两个 SET 项', async () => {
    const query = "MERGE (n:Label {id: 5}) ON CREATE SET n.x = 10, n.y = 20 ON MATCH SET n.x = 99, n.z = 88"
    const plan = parseQuery(query)

    expect(plan.mergeOnCreate!.length).toBe(2)
    expect(plan.mergeOnMatch!.length).toBe(2)

    const nodesA: Array<Record<string, unknown>> = []
    await _executeQuery(plan, nodesA, query)
    expect(nodesA[0]['x']).toBe(10)
    expect(nodesA[0]['y']).toBe(20)

    const nodesB: Array<Record<string, unknown>> = [{ id: 5, x: 0, y: 0, _label: 'Label' }]
    await _executeQuery(plan, nodesB, query)
    expect(nodesB[0]['x']).toBe(99)
    expect(nodesB[0]['z']).toBe(88)
  })

  it('TC-7: ON CREATE SET 字符串属性值', async () => {
    const query = 'MERGE (n:Label {id: 6}) ON CREATE SET n.name = "created"'
    const plan = parseQuery(query)

    expect(plan.mergeOnCreate![0].property).toBe('name')
    expect(plan.mergeOnCreate![0].value).toBe('created')

    const nodes: Array<Record<string, unknown>> = []
    await _executeQuery(plan, nodes, query)
    expect(nodes[0]['name']).toBe('created')
  })

  it('TC-8: ON CREATE SET x=1 ON MATCH SET x=2 按条件正确应用', async () => {
    const query = "MERGE (n:Label {id: 7}) ON CREATE SET n.status = 'new' ON MATCH SET n.status = 'existing'"
    const plan = parseQuery(query)

    const nodesA: Array<Record<string, unknown>> = []
    await _executeQuery(plan, nodesA, query)
    expect(nodesA[0]['status']).toBe('new')

    const nodesB: Array<Record<string, unknown>> = [{ id: 7, status: 'unknown', _label: 'Label' }]
    await _executeQuery(plan, nodesB, query)
    expect(nodesB[0]['status']).toBe('existing')
  })

  it('TC-9: MERGE 匹配多个属性 key', async () => {
    const query = "MERGE (n:Label {id: 8, name: 'test'}) ON CREATE SET n.x = 1"
    const plan = parseQuery(query)

    expect(plan.type).toBe('MERGE')
    expect(plan.mergeNodes![0].props).toBeDefined()
    expect((plan.mergeNodes![0].props as Record<string, any>).id.value).toBe(8)
    expect((plan.mergeNodes![0].props as Record<string, any>).name.value).toBe('test')
  })
})
