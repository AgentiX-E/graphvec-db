import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTCKEngine, destroyTCKEngine, injectNodes, tckQuery, tckPlan } from './tck-engine-adapter'

describe('TCK Engine Adapter — basic query', () => {
  let e: ReturnType<typeof createTCKEngine>

  beforeAll(async () => {
    e = createTCKEngine()
    const data = [{ _label: 'Person', name: 'Alice', age: 30 }, { _label: 'Company', name: 'Acme' }]
    await injectNodes(e, data)
  })

  afterAll(async () => {
    await destroyTCKEngine(e)
  })

  it('MATCH label -> nodes', () => {
    const r = tckQuery(e, 'MATCH (n:Person) RETURN n') as any[]
    expect(r.length).toBe(1)
    expect(r[0].props?.name).toBe('Alice')
  })

  it('MATCH all nodes', () => {
    const r = tckQuery(e, 'MATCH (n) RETURN n') as any[]
    expect(r.length).toBe(2)
  })

  it('WHERE filter', () => {
    const r = tckQuery(e, "MATCH (n:Person) WHERE n.name = 'Alice' RETURN n") as any[]
    expect(r.length).toBe(1)
    expect(r[0].props?.age).toBe(30)
  })

  it('MATCH edge', async () => {
    // Add edge for edge test
    const nodes = tckQuery(e, 'MATCH (n:Person) RETURN n') as any[]
    const companies = tckQuery(e, 'MATCH (n:Company) RETURN n') as any[]
    if (nodes.length > 0 && companies.length > 0) {
      await e.upsertEdge(nodes[0].id, companies[0].id, 10)
    }
    const r = tckQuery(e, 'MATCH (a)-[:KNOWS]->(b) RETURN a, b') as any[]
    expect(r.length).toBe(1)
  })
})
