import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTCKEngine, destroyTCKEngine, injectNodes, tckQueryEngine } from './tck-engine-adapter-v2'

describe('GraphEngine TCK debug2', () => {
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

  it('engine.query with label', () => {
    // engine.query internally parses 'Person' as scanLabel and calls _scanNodesByLabel
    // but _scanNodesByLabel matches typeName === 'Person', and our nodes have typeName Person_1
    // so engine.query with label returns 0
    const r1 = e.query('MATCH (n:Person) RETURN n') as any[]
    console.log('engine.query Person:', r1.length)
    
    // tckQueryEngine post-filters by props._label
    const r2 = tckQueryEngine(e, 'MATCH (n:Person) RETURN n') as any[]
    console.log('tckQueryEngine Person:', r2.length, r2.map((n: any) => n.props?.name))
    
    // Without label - should work
    const r3 = e.query('MATCH (n) RETURN n') as any[]
    console.log('engine.query all:', r3.length)
  })
})
