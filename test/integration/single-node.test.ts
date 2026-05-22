import { GraphEngine } from '../../src/core/graph-engine'
import { OverGraphConfig } from '../../src/types'
import * as fs from 'fs'
import * as path from 'path'

describe('AC-IT-1: Single-Node GraphEngine 端到端 CRUD', () => {
  const dbPath = path.join('/tmp', `agentiX-integration-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  let engine: GraphEngine

  beforeAll(() => {
    // 确保目录存在
    fs.mkdirSync(dbPath, { recursive: true })

    const config: OverGraphConfig = {
      path: dbPath,
    }

    engine = new GraphEngine(config)
    engine.open()
  })

  afterAll(() => {
    if (engine.isOpen) {
      engine.close()
    }
    // 清理临时目录
    fs.rmSync(dbPath, { recursive: true, force: true })
  })

  it('1. 创建单个节点 A — upsertNode + getNode', () => {
    const nodeA = engine.upsertNode(1, 'NodeA')
    expect(nodeA).toBeGreaterThan(0)

    const retrieved = engine.getNode(nodeA)
    expect(retrieved).not.toBeNull()
    expect(retrieved!.name).toBe('NodeA')
    expect(retrieved!.type).toBe(1)
  })

  it('2. 创建节点 B 并创建边 A→B — upsertEdge + getEdge', () => {
    const nodeA = engine.upsertNode(1, 'EdgeNodeA')
    const nodeB = engine.upsertNode(2, 'EdgeNodeB')

    engine.upsertEdge(nodeA, nodeB, 10)

    const edge = engine.getEdge(nodeA, nodeB, 10)
    expect(edge).not.toBeNull()
    expect(edge!.src).toBe(nodeA)
    expect(edge!.dst).toBe(nodeB)
    expect(edge!.type).toBe(10)
  })

  it('3. 邻居遍历验证', () => {
    const nodeA = engine.upsertNode(1, 'NeighborA')
    const nodeB = engine.upsertNode(2, 'NeighborB')
    const nodeC = engine.upsertNode(3, 'NeighborC')

    engine.upsertEdge(nodeA, nodeB, 10)
    engine.upsertEdge(nodeA, nodeC, 10)

    const { edges, nodes } = engine.neighbors(nodeA)
    // A → B, A → C: 两条边
    expect(edges.length).toBe(2)
    // 两个邻居节点
    expect(nodes.length).toBe(2)
    const neighborNames = nodes.map(n => n.name).sort()
    expect(neighborNames).toEqual(['NeighborB', 'NeighborC'])
  })

  it('4. 批量写入 10 个节点 — batchUpsertNodes', () => {
    const inputs = Array.from({ length: 10 }, (_, i) => ({
      typeId: 1,
      name: `BatchNode${i}`,
    }))

    const ids = engine.batchUpsertNodes(inputs)
    expect(ids.length).toBe(10)

    // 验证所有节点都可读
    for (let i = 0; i < 10; i++) {
      const node = engine.getNode(ids[i])
      expect(node).not.toBeNull()
      expect(node!.name).toBe(`BatchNode${i}`)
    }
  })

  it('5. 删除节点 — deleteNode', () => {
    const nodeId = engine.upsertNode(1, 'ToDelete')
    expect(engine.getNode(nodeId)).not.toBeNull()

    const deleted = engine.deleteNode(nodeId)
    expect(deleted).toBe(true)

    // 删除后读取应为 null
    expect(engine.getNode(nodeId)).toBeNull()
  })

  it('6. 关闭引擎 — close + isOpen', () => {
    expect(engine.isOpen).toBe(true)
    engine.close()
    expect(engine.isOpen).toBe(false)

    // 关闭后操作应抛出错误
    expect(() => engine.upsertNode(1, 'AfterClose')).toThrow('GraphEngine is not open')
  })
})
