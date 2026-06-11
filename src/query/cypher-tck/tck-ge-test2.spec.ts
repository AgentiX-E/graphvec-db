import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTCKEngine, destroyTCKEngine, injectNodes } from './tck-engine-adapter-v2'

describe('GraphEngine TCK debug', () => {
  let e: ReturnType<typeof createTCKEngine>

  beforeAll(async () => {
    e = createTCKEngine()
    const ids = await injectNodes(e, [
      { _label: 'Person', name: 'Alice', age: 30 },
      { _label: 'Company', name: 'Acme' },
      { _label: 'Person', name: 'Bob', age: 25 },
    ])
    console.log('Injected IDs:', ids)
  })

  afterAll(async () => {
    await destroyTCKEngine(e)
  })

  it('debug all nodes', () => {
    const r = e.query('MATCH (n) RETURN n') as any[]
    console.log('Total nodes:', r.length)
    for (const n of r) {
      console.log(`  id=${n.id}, typeName=${n.name}, props=${JSON.stringify(n.props)}`)
    }
    expect(r.length).toBe(3)
  })
})
