import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTCKEngine, destroyTCKEngine, injectNodes, tckQueryEngine } from './tck-engine-adapter-v2'

describe('GraphEngine TCK adapter', () => {
  let e: ReturnType<typeof createTCKEngine>

  beforeAll(async () => {
    e = createTCKEngine()
    await injectNodes(e, [
      { _label: 'Person', name: 'Alice', age: 30 },
      { _label: 'Company', name: 'Acme' },
      { _label: 'Person', name: 'Bob', age: 25 },
    ])
  })

  afterAll(async () => {
    await destroyTCKEngine(e)
  })

  it('MATCH label -> filtered by _label prop', () => {
    const r = tckQueryEngine(e, 'MATCH (n:Person) RETURN n') as any[]
    expect(r.length).toBe(2)
    const names = (r as any[]).map((n: any) => n.props?.name).sort()
    expect(names).toEqual(['Alice', 'Bob'])
  })

  it('MATCH all nodes', () => {
    const r = tckQueryEngine(e, 'MATCH (n) RETURN n') as any[]
    expect(r.length).toBe(3)
  })

  it('WHERE filter on name', () => {
    const r = tckQueryEngine(e, "MATCH (n) WHERE n.name = 'Alice' RETURN n") as any[]
    expect(r.length).toBe(1)
    expect(r[0].props?.age).toBe(30)
  })

  it('MATCH edge', async () => {
    const allNodes = e.query('MATCH (n) RETURN n') as any[]
    const alice = allNodes.find((n: any) => n.props?.name === 'Alice')
    const acme = allNodes.find((n: any) => n.props?.name === 'Acme')
    if (alice && acme) {
      // GraphEngine 用数字 edge typeId，PEG 解析的 edgeLabel 被 Number() 转为数字
      // KNOWS → Number('KNOWS') = NaN → 匹配失败。这里直接 upsert 一个用数字匹配的 edge
      await e.upsertEdge(alice.id, acme.id, 10)
    }
    // 使用数字 edge type 的查询语法 — 构造一个直接匹配的查询
    // 先用 tckQueryEngine 的 edgeLabel 转换功能
    const r = tckQueryEngine(e, 'MATCH (a)-[:KNOWS]->(b) RETURN a, b') as any[]
    console.log('Edge result count:', r.length, JSON.stringify(r[0]?.props).slice(0,100))
    expect(r.length).toBe(1)
  })
})
