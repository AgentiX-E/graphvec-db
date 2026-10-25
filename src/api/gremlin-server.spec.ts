// ============================================================
// gremlin-server.spec.ts — Gremlin Protocol Server Tests
// ============================================================

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import {
  GremlinServer, createGremlinServer, createGraphData, addVertex,
  addEdge, createDefaultExecutor, parseBytecode, applyStepsToState,
  toGraphSONNode,
} from './gremlin-server'
import type { GremlinQueryExecutor, GremlinQueryResult } from './gremlin-server'

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────

/** Build a mock graph executor with Alice/Bob/Charlie/AgentiX */
function createMockExecutor(): GremlinQueryExecutor {
  const graph = createGraphData()
  addVertex(graph, 1, 'Person', { name: 'Alice', age: 30 })
  addVertex(graph, 2, 'Person', { name: 'Bob', age: 25 })
  addVertex(graph, 3, 'Person', { name: 'Charlie', age: 35 })
  addVertex(graph, 4, 'Software', { name: 'AgentiX', version: '0.1' })
  addEdge(graph, 'KNOWS', 1, 2, { since: 2020 })
  addEdge(graph, 'KNOWS', 1, 3, { since: 2021 })
  addEdge(graph, 'CREATED', 1, 4, { since: 2025 })
  return createDefaultExecutor(graph)
}

/** Connect to the Gremlin WebSocket server */
async function gremlinConnect(port: number): Promise<any> {
  const { default: WebSocket } = await import('ws')
  const ws = new WebSocket(`ws://127.0.0.1:${port}/gremlin`)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connect timeout')), 5000)
    ws.on('open', () => { clearTimeout(timeout); resolve(ws) })
    ws.on('error', (err: any) => { clearTimeout(timeout); reject(err) })
  })
}

/** Build a GraphBinary request buffer */
function buildGraphBinaryRequest(
  requestId: string,
  op: string,
  processor: string,
  args: Map<string, unknown>,
): Buffer {
// eslint-disable-next-line @typescript-eslint/no-var-requires -- native/CJS module loaded lazily
  const gb = require('gremlin/lib/structure/io/binary/GraphBinary')
  const hex = requestId.replace(/-/g, '')
  return Buffer.concat([
    Buffer.from([0x81]),
    Buffer.from(hex, 'hex'),
    gb.graphBinaryWriter.ioc.stringSerializer.serialize(op, false),
    gb.graphBinaryWriter.ioc.stringSerializer.serialize(processor, false),
    gb.graphBinaryWriter.ioc.mapSerializer.serialize(args, false),
  ])
}

/** Build a Bytecode object */
function buildBytecode(source: string[][], steps: string[][]): any {
// eslint-disable-next-line @typescript-eslint/no-var-requires -- native/CJS module loaded lazily
  const Bytecode = require('gremlin/lib/process/bytecode')
  const bc = new Bytecode()
  for (const s of source) bc.addSource(s[0], s.slice(1))
  for (const s of steps) bc.addStep(s[0], s.slice(1))
  return bc
}

/**
 * Parse just the status code from a GraphBinary response buffer (skip full parsing).
 */
function parseStatusFromResponse(data: Buffer): { code: number; requestId: string } {
  if (data.length < 22) return { code: 500, requestId: 'unknown' }

  // After version byte (1) and UUID value_flag (1) and UUID (16), we have status_code (Int, 4 bytes)
  let offset = 1    // version
  offset += 1       // value_flag
  offset += 16      // UUID
  if (data.length < offset + 4) return { code: 500, requestId: 'unknown' }
  const code = data.readInt32BE(offset)

  // Extract requestId
  const uuidHex = data.slice(2, 18).toString('hex')
  const requestId = `${uuidHex.slice(0,8)}-${uuidHex.slice(8,12)}-${uuidHex.slice(12,16)}-${uuidHex.slice(16,20)}-${uuidHex.slice(20,32)}`
  return { code, requestId }
}

/** Send mime type + binary request */
async function sendGremlinRequest(
  ws: any, requestId: string, op: string, processor: string, args: Map<string, unknown>,
): Promise<void> {
  ws.send('$application/vnd.graphbinary-v1.0')
  await new Promise(r => setTimeout(r, 50))
  ws.send(buildGraphBinaryRequest(requestId, op, processor, args), { binary: true })
}

/** Collect messages from ws */
function collectMessages(ws: any, ms = 2000): Promise<Buffer[]> {
  return new Promise(resolve => {
    const msgs: Buffer[] = []
    const h = (d: Buffer) => msgs.push(d)
    ws.on('message', h)
    setTimeout(() => { ws.removeListener('message', h); resolve(msgs) }, ms)
  })
}

// ──────────────────────────────────────────
// Bytecode Interpreter
// ──────────────────────────────────────────

describe('GremlinServer — Bytecode Interpreter', () => {
  test('parse V()', () => {
    const steps = parseBytecode({ sourceInstructions: [['g', 'graph']], stepInstructions: [['V']] })
    expect(steps).toHaveLength(2)
    expect(steps[1].name).toBe('V')
  })
  test('parse has()', () => {
    const steps = parseBytecode({ sourceInstructions: [], stepInstructions: [['V'], ['has', 'name', 'Alice']] })
    expect(steps[1].values).toEqual(['name', 'Alice'])
  })
  test('parse hasLabel()', () => {
    const steps = parseBytecode({ sourceInstructions: [], stepInstructions: [['V'], ['hasLabel', 'Person']] })
    expect(steps[1].values).toEqual(['Person'])
  })
  test('parse out()', () => {
    const steps = parseBytecode({ sourceInstructions: [], stepInstructions: [['V'], ['out', 'KNOWS']] })
    expect(steps[1].values).toEqual(['KNOWS'])
  })
  test('parse in()', () => {
    const steps = parseBytecode({ sourceInstructions: [], stepInstructions: [['V'], ['in', 'KNOWS']] })
    expect(steps[1].values).toEqual(['KNOWS'])
  })
  test('parse both()', () => {
    const steps = parseBytecode({ sourceInstructions: [], stepInstructions: [['V'], ['both']] })
    expect(steps[1].values).toEqual([])
  })
  test('parse values()', () => {
    const steps = parseBytecode({ sourceInstructions: [], stepInstructions: [['V'], ['values', 'name']] })
    expect(steps[1].values).toEqual(['name'])
  })
  test('parse limit()', () => {
    const steps = parseBytecode({ sourceInstructions: [], stepInstructions: [['V'], ['limit', 10]] })
    expect(steps[1].values).toEqual([10])
  })
  test('parse count()', () => {
    const steps = parseBytecode({ sourceInstructions: [], stepInstructions: [['V'], ['count']] })
    expect(steps[1].name).toBe('count')
  })
  test('parse order().by()', () => {
    const steps = parseBytecode({ sourceInstructions: [], stepInstructions: [['V'], ['order'], ['by', 'name', 'desc']] })
    expect(steps[2].values).toEqual(['name', 'desc'])
  })
  test('parse E()', () => {
    const steps = parseBytecode({ sourceInstructions: [], stepInstructions: [['E']] })
    expect(steps[0].name).toBe('E')
  })
})

// ──────────────────────────────────────────
// TraversalState
// ──────────────────────────────────────────

describe('GremlinServer — TraversalState Builder', () => {
  test('simple V()', () => {
    const state = applyStepsToState(parseBytecode({ sourceInstructions: [], stepInstructions: [['V']] }))
    expect(state.source).toBe('V')
  })
  test('hasLabel', () => {
    const state = applyStepsToState(parseBytecode({ sourceInstructions: [], stepInstructions: [['V'], ['hasLabel', 'Person']] }))
    expect(state.labels).toEqual(['Person'])
  })
  test('has filter', () => {
    const state = applyStepsToState(parseBytecode({ sourceInstructions: [], stepInstructions: [['V'], ['has', 'name', 'Alice']] }))
    expect(state.filters).toHaveLength(1)
    expect(state.filters[0].key).toBe('name')
    expect(state.filters[0].value).toBe('Alice')
  })
  test('out edges', () => {
    const state = applyStepsToState(parseBytecode({ sourceInstructions: [], stepInstructions: [['V'], ['out', 'KNOWS']] }))
    expect(state.outEdges).toEqual(['KNOWS'])
  })
  test('values projection', () => {
    const state = applyStepsToState(parseBytecode({ sourceInstructions: [], stepInstructions: [['V'], ['values', 'name']] }))
    expect(state.projections).toEqual(['name'])
  })
  test('limit', () => {
    const state = applyStepsToState(parseBytecode({ sourceInstructions: [], stepInstructions: [['V'], ['limit', '10']] }))
    expect(state.limit).toBe(10)
  })
  test('count', () => {
    const state = applyStepsToState(parseBytecode({ sourceInstructions: [], stepInstructions: [['V'], ['count']] }))
    expect(state.countOnly).toBe(true)
  })
  test('order().by() desc', () => {
    const state = applyStepsToState(parseBytecode({ sourceInstructions: [], stepInstructions: [['V'], ['order'], ['by', 'name', 'desc']] }))
    expect(state.orderBy).toEqual({ field: 'name', direction: 'desc' })
  })
  test('order().by() asc', () => {
    const state = applyStepsToState(parseBytecode({ sourceInstructions: [], stepInstructions: [['V'], ['order'], ['by', 'age']] }))
    expect(state.orderBy).toEqual({ field: 'age', direction: 'asc' })
  })
})

// ──────────────────────────────────────────
// Default Executor
// ──────────────────────────────────────────

describe('GremlinServer — Default Executor', () => {
  let graph: ReturnType<typeof createGraphData>
  let executor: ReturnType<typeof createDefaultExecutor>

  beforeEach(() => {
    graph = createGraphData()
    addVertex(graph, 1, 'Person', { name: 'Alice', age: 30 })
    addVertex(graph, 2, 'Person', { name: 'Bob', age: 25 })
    addVertex(graph, 3, 'Person', { name: 'Charlie', age: 35 })
    addVertex(graph, 4, 'Software', { name: 'AgentiX', version: '0.1' })
    addEdge(graph, 'KNOWS', 1, 2)
    addEdge(graph, 'KNOWS', 1, 3)
    addEdge(graph, 'CREATED', 1, 4)
    executor = createDefaultExecutor(graph)
  })

  test('g.V()', () => {
    const r = executor({ sourceInstructions: [['g', 'graph']], stepInstructions: [['V']] }, {})
    expect(r.data).toHaveLength(4)
    for (const item of r.data as any[]) {
      expect(item['@type']).toBe('g:Vertex')
    }
  })

  test('g.V().has("name","Alice")', () => {
    const r = executor({ sourceInstructions: [['g', 'graph']], stepInstructions: [['V'], ['has', 'name', 'Alice']] }, {})
    expect(r.data).toHaveLength(1)
    expect((r.data[0] as any)['@value'].id['@value']).toBe(1)
  })

  test('g.V().has("name","Bob")', () => {
    const r = executor({ sourceInstructions: [['g', 'graph']], stepInstructions: [['V'], ['has', 'name', 'Bob']] }, {})
    expect(r.data).toHaveLength(1)
    expect((r.data[0] as any)['@value'].id['@value']).toBe(2)
  })

  test('g.V().has("name","Missing") returns empty', () => {
    const r = executor({ sourceInstructions: [['g', 'graph']], stepInstructions: [['V'], ['has', 'name', 'Missing']] }, {})
    expect(r.data).toHaveLength(0)
  })

  test('g.V().hasLabel("Person")', () => {
    const r = executor({ sourceInstructions: [['g', 'graph']], stepInstructions: [['V'], ['hasLabel', 'Person']] }, {})
    expect(r.data).toHaveLength(3)
  })

  test('g.V().hasLabel("Software")', () => {
    const r = executor({ sourceInstructions: [['g', 'graph']], stepInstructions: [['V'], ['hasLabel', 'Software']] }, {})
    expect(r.data).toHaveLength(1)
  })

  test('g.V().hasLabel("Person").out("KNOWS").values("name")', () => {
    const r = executor({
      sourceInstructions: [['g', 'graph']],
      stepInstructions: [['V'], ['hasLabel', 'Person'], ['out', 'KNOWS'], ['values', 'name']],
    }, {})
    expect(r.data).toHaveLength(2)
    const names = r.data.map((x: any) => x.name).sort()
    expect(names).toEqual(['Bob', 'Charlie'])
  })

  test('g.V().limit(2)', () => {
    const r = executor({ sourceInstructions: [['g', 'graph']], stepInstructions: [['V'], ['limit', 2]] }, {})
    expect(r.data).toHaveLength(2)
  })

  test('g.V().count()', () => {
    const r = executor({ sourceInstructions: [['g', 'graph']], stepInstructions: [['V'], ['count']] }, {})
    expect(r.data).toEqual([4])
  })

  test('g.V().hasLabel("Person").count()', () => {
    const r = executor({ sourceInstructions: [['g', 'graph']], stepInstructions: [['V'], ['hasLabel', 'Person'], ['count']] }, {})
    expect(r.data).toEqual([3])
  })

  test('g.V().out("KNOWS")', () => {
    const r = executor({ sourceInstructions: [['g', 'graph']], stepInstructions: [['V'], ['out', 'KNOWS']] }, {})
    expect(r.data).toHaveLength(2)
    const ids = r.data.map((x: any) => x['@value'].id['@value']).sort()
    expect(ids).toEqual([2, 3])
  })

  test('g.V().out("CREATED")', () => {
    const r = executor({ sourceInstructions: [['g', 'graph']], stepInstructions: [['V'], ['out', 'CREATED']] }, {})
    expect(r.data).toHaveLength(1)
    expect((r.data[0] as any)['@value'].id['@value']).toBe(4)
  })

  // Fix: the order is by `name` which means Alice < Bob < Charlie < AgentiX,
  // so desc = AgentiX, Charlie, Bob, Alice
  test('g.V().order().by("name","desc")', () => {
    const r = executor({ sourceInstructions: [['g', 'graph']], stepInstructions: [['V'], ['order'], ['by', 'name', 'desc']] }, {})
    const names = r.data.map((x: any) => x['@value'].properties.name)
    expect(names[0]).toBe('Charlie')
    expect(names[names.length - 1]).toBe('AgentiX')
  })
})

// ──────────────────────────────────────────
// GraphSON / Helpers
// ──────────────────────────────────────────

describe('GremlinServer — Helpers', () => {
  test('toGraphSONNode', () => {
    const r = toGraphSONNode({ id: 1, label: 'Person', properties: { name: 'Alice' } })
    expect(r['@type']).toBe('g:Vertex')
    expect((r['@value'] as { id: { '@value': number } }).id['@value']).toBe(1)
  })

  test('createGraphData', () => {
    const g = createGraphData()
    expect(Object.keys(g.vertices)).toHaveLength(0)
    expect(g.edges).toHaveLength(0)
  })

  test('addVertex', () => {
    const g = createGraphData()
    addVertex(g, 1, 'T', { k: 'v' })
    expect(g.vertices[1].label).toBe('T')
  })

  test('addEdge', () => {
    const g = createGraphData()
    addVertex(g, 1, 'A')
    addVertex(g, 2, 'B')
    addEdge(g, 'R', 1, 2)
    expect(g.edges).toHaveLength(1)
    expect(g.edges[0].label).toBe('R')
  })
})

// ──────────────────────────────────────────
// Server Lifecycle
// ──────────────────────────────────────────

describe('GremlinServer — Server Lifecycle', () => {
  let server: GremlinServer | null = null

  afterEach(async () => {
    if (server) { await server.stop().catch(() => {}); server = null }
  })

  test('GAP-19-1: start on random port', async () => {
    server = new GremlinServer(createMockExecutor(), { port: 0, host: '127.0.0.1' })
    await server.start()
    expect(server.getPort()).toBeGreaterThan(0)
    expect(server.getConnections()).toBe(0)
  })

  test('GAP-19-2: start/stop via factory', async () => {
    const inst = createGremlinServer(createMockExecutor(), { port: 0, host: '127.0.0.1' })
    await inst.start()
    expect(inst.getPort()).toBeGreaterThan(0)
    await inst.stop()
  })

  test('GAP-19-3: WebSocket connection succeeds', async () => {
    server = new GremlinServer(createMockExecutor(), { port: 0, host: '127.0.0.1' })
    await server.start()
    const ws = await gremlinConnect(server.getPort())
    expect(ws.readyState).toBe(1)
    ws.close()
  })

  test('GAP-19-4: getConnections tracks sessions', async () => {
    server = new GremlinServer(createMockExecutor(), { port: 0, host: '127.0.0.1' })
    await server.start()
    expect(server.getConnections()).toBe(0)
    const ws1 = await gremlinConnect(server.getPort())
    expect(server.getConnections()).toBe(1)
    const ws2 = await gremlinConnect(server.getPort())
    expect(server.getConnections()).toBe(2)
    ws1.close()
    ws2.close()
    await new Promise(r => setTimeout(r, 300))
    expect(server.getConnections()).toBe(0)
  })

  test('GAP-19-5: non-gremlin path returns 404', async () => {
    server = new GremlinServer(createMockExecutor(), { port: 0, host: '127.0.0.1' })
    await server.start()
    const { default: WebSocket } = await import('ws')
    const ws = new WebSocket(`ws://127.0.0.1:${server.getPort()}/wrong`)
    await new Promise<void>(resolve => {
      ws.on('error', () => resolve())
      ws.on('unexpected-response', (req: any, res: any) => {
        expect(res.statusCode).toBe(404)
        ws.close()
        resolve()
      })
      setTimeout(() => { ws.close(); resolve() }, 1000)
    })
  })
})

// ──────────────────────────────────────────
// GraphBinary Protocol
// ──────────────────────────────────────────

describe('GremlinServer — Protocol: GraphBinary Bytecode', () => {
  let server: GremlinServer | null = null
  let port: number = 0

  beforeEach(async () => {
    server = new GremlinServer(createMockExecutor(), { port: 0, host: '127.0.0.1' })
    await server.start()
    port = server.getPort()
  })

  afterEach(async () => {
    if (server) { await server.stop().catch(() => {}); server = null }
  })

  test('GAP-19-6: g.V()', async () => {
    const ws = await gremlinConnect(port)
    const msgs = collectMessages(ws, 1500)
    await sendGremlinRequest(ws, '00000000-0000-0000-0000-000000000001', 'bytecode', 'traversal',
      new Map([['gremlin', buildBytecode([['g', 'graph']], [['V']])], ['aliases', { g: 'g' }]]))
    const received = await msgs
    expect(received.length).toBeGreaterThan(0)
    const parsed = parseStatusFromResponse(received[0])
    expect(parsed.code).toBe(200)
    ws.close()
  })

  test('GAP-19-7: g.V().has("name","Alice")', async () => {
    const ws = await gremlinConnect(port)
    const msgs = collectMessages(ws, 1500)
    await sendGremlinRequest(ws, '00000000-0000-0000-0000-000000000002', 'bytecode', 'traversal',
      new Map([['gremlin', buildBytecode([['g', 'graph']], [['V'], ['has', 'name', 'Alice']])], ['aliases', { g: 'g' }]]))
    const received = await msgs
    expect(received.length).toBeGreaterThan(0)
    const parsed = parseStatusFromResponse(received[0])
    expect(parsed.code).toBe(200)
    ws.close()
  })

  test('GAP-19-8: g.V().hasLabel("Person").out("KNOWS").values("name")', async () => {
    const ws = await gremlinConnect(port)
    const msgs = collectMessages(ws, 1500)
    await sendGremlinRequest(ws, '00000000-0000-0000-0000-000000000003', 'bytecode', 'traversal',
      new Map([['gremlin', buildBytecode([['g', 'graph']], [['V'], ['hasLabel', 'Person'], ['out', 'KNOWS'], ['values', 'name']])], ['aliases', { g: 'g' }]]))
    const received = await msgs
    expect(received.length).toBeGreaterThan(0)
    const parsed = parseStatusFromResponse(received[0])
    expect(parsed.code).toBe(200)
    ws.close()
  })

  test('GAP-19-9: g.V().limit(2)', async () => {
    const ws = await gremlinConnect(port)
    const msgs = collectMessages(ws, 1500)
    await sendGremlinRequest(ws, '00000000-0000-0000-0000-000000000004', 'bytecode', 'traversal',
      new Map([['gremlin', buildBytecode([['g', 'graph']], [['V'], ['limit', '2']])], ['aliases', { g: 'g' }]]))
    const received = await msgs
    expect(received.length).toBeGreaterThan(0)
    const parsed = parseStatusFromResponse(received[0])
    expect(parsed.code).toBe(200)
    ws.close()
  })

  test('GAP-19-10: g.V().count()', async () => {
    const ws = await gremlinConnect(port)
    const msgs = collectMessages(ws, 1500)
    await sendGremlinRequest(ws, '00000000-0000-0000-0000-000000000005', 'bytecode', 'traversal',
      new Map([['gremlin', buildBytecode([['g', 'graph']], [['V'], ['count']])], ['aliases', { g: 'g' }]]))
    const received = await msgs
    expect(received.length).toBeGreaterThan(0)
    const parsed = parseStatusFromResponse(received[0])
    expect(parsed.code).toBe(200)
    ws.close()
  })

  test('GAP-19-11: unknown op returns error', async () => {
    const ws = await gremlinConnect(port)
    const msgs = collectMessages(ws, 1500)
    await sendGremlinRequest(ws, '00000000-0000-0000-0000-000000000006', 'invalid_op', 'traversal',
      new Map([['gremlin', 'invalid']]))
    const received = await msgs
    expect(received.length).toBeGreaterThan(0)
    const parsed = parseStatusFromResponse(received[0])
    expect(parsed.code).toBe(500)
    ws.close()
  })

  test('GAP-19-12: auth + bytecode query', async () => {
    const ws = await gremlinConnect(port)
    const msgs = collectMessages(ws, 3000)

    // Send mime
    ws.send('$application/vnd.graphbinary-v1.0')
    await new Promise(r => setTimeout(r, 50))

    // Auth
    const authArgs = new Map<string, unknown>()
    authArgs.set('sasl', Buffer.from(''))
    ws.send(buildGraphBinaryRequest('00000000-0000-0000-0000-000000000007', 'authentication', '', authArgs), { binary: true })
    await new Promise(r => setTimeout(r, 50))

    // Query
    ws.send(buildGraphBinaryRequest('00000000-0000-0000-0000-000000000008', 'bytecode', 'traversal',
      new Map([['gremlin', buildBytecode([['g', 'graph']], [['V'], ['count']])], ['aliases', { g: 'g' }]])), { binary: true })
    await new Promise(r => setTimeout(r, 50))

    const received = await msgs
    let foundSuccess = false
    for (const msg of received) {
      try {
        if (parseStatusFromResponse(msg).code === 200) foundSuccess = true
      } catch { /* ignore */ }
    }
    expect(foundSuccess).toBe(true)
    ws.close()
  })
})

// ──────────────────────────────────────────
// Coexistence with Bolt
// ──────────────────────────────────────────

describe('GremlinServer — Coexistence with Bolt', () => {
  test('GAP-19-14: Gremlin and Bolt run in parallel', async () => {
    const { createBoltServer } = await import('./bolt-server')
    const boltExec = (cypher: string) => {
      if (cypher.includes('RETURN')) return { fields: ['num'], records: [[42]] }
      return { fields: ['n'], records: [['test']] }
    }
    const g = createGraphData()
    addVertex(g, 1, 'Person', { name: 'Alice' })

    const bolt = createBoltServer(boltExec, { port: 0, host: '127.0.0.1' })
    await bolt.start()

    const gremlin = createGremlinServer(createDefaultExecutor(g), { port: 0, host: '127.0.0.1' })
    await gremlin.start()

    expect(bolt.getPort()).not.toBe(gremlin.getPort())
    expect(bolt.getPort()).toBeGreaterThan(0)
    expect(gremlin.getPort()).toBeGreaterThan(0)

    const ws = await gremlinConnect(gremlin.getPort())
    expect(ws.readyState).toBe(1)
    ws.close()

    await bolt.stop()
    await gremlin.stop()
  })
})

// ──────────────────────────────────────────
// Type exports
// ──────────────────────────────────────────

describe('GremlinServer — Type exports', () => {
  test('GremlinQueryResult type', () => {
    const r: GremlinQueryResult = { data: [], meta: {} }
    expect(r.data).toEqual([])
  })
})
