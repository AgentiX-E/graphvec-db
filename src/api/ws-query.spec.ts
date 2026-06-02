import { WsQueryServer, createBatchQueryExecutor } from './ws-query'
import { WebSocket } from 'ws'

// Helper: wait for WebSocket connection
function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.on('error', reject)
    ws.on('open', () => resolve(ws))
  })
}

// Helper: wait for messages
function collectMessages(ws: WebSocket, count: number, timeoutMs: number = 5000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const messages: any[] = []
    const timer = setTimeout(() => {
      ws.close()
      resolve(messages)
    }, timeoutMs)

    ws.on('message', (raw: Buffer) => {
      const msg = JSON.parse(raw.toString())
      messages.push(msg)
      if (messages.length >= count) {
        clearTimeout(timer)
        ws.close()
        resolve(messages)
      }
    })

    ws.on('error', reject)
  })
}

describe('WsQueryServer', () => {
  let server: WsQueryServer
  let port: number

  // Create a test query executor that yields mock data
  function createTestExecutor(totalRows: number = 10, delayMs: number = 0) {
    return async function* (cypher: string, params: Record<string, unknown>) {
      for (let i = 0; i < totalRows; i++) {
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs))
        yield { id: i, name: `row-${i}`, cypher, params }
      }
      return { totalRows }
    }
  }

  beforeEach(async () => {
    port = 8970 + Math.floor(Math.random() * 100)
    server = new WsQueryServer({
      port,
      host: '127.0.0.1',
      path: '/api/v1/ws/query',
      batchSize: 5,
      maxBufferSize: 100,
      maxConcurrentQueries: 10,
    })
    server.setExecutor(createTestExecutor(10))
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  test('should start and accept connections', async () => {
    expect(server.running).toBe(true)
    const ws = await connectWs(`ws://127.0.0.1:${port}/api/v1/ws/query`)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  test('should stream query results in batches', async () => {
    const ws = await connectWs(`ws://127.0.0.1:${port}/api/v1/ws/query`)

    ws.send(JSON.stringify({
      type: 'query',
      id: 'req1',
      cypher: 'MATCH (n) RETURN n',
      params: {},
    }))

    const messages = await collectMessages(ws, 3) // 2 batches + 1 complete

    expect(messages.length).toBeGreaterThanOrEqual(3)

    // First batch
    expect(messages[0].type).toBe('batch')
    expect(messages[0].id).toBe('req1')
    expect(messages[0].batchIndex).toBe(0)
    expect(messages[0].batch.length).toBe(5) // batchSize=5
    expect(messages[0].hasMore).toBe(true)

    // Second batch
    expect(messages[1].type).toBe('batch')
    expect(messages[1].id).toBe('req1')
    expect(messages[1].batchIndex).toBe(1)
    expect(messages[1].batch.length).toBe(5)
    expect(messages[1].hasMore).toBe(false)

    // Complete
    expect(messages[2].type).toBe('complete')
    expect(messages[2].id).toBe('req1')
    expect(messages[2].summary.totalRows).toBe(10)
    expect(messages[2].summary.batches).toBe(2)
    expect(messages[2].summary.timeMs).toBeGreaterThanOrEqual(0)
  })

  test('should reject invalid JSON', async () => {
    const ws = await connectWs(`ws://127.0.0.1:${port}/api/v1/ws/query`)

    ws.send('not-json')

    const messages = await collectMessages(ws, 1)
    expect(messages[0].type).toBe('error')
  })

  test('should reject empty cypher query', async () => {
    const ws = await connectWs(`ws://127.0.0.1:${port}/api/v1/ws/query`)

    ws.send(JSON.stringify({
      type: 'query',
      id: 'req1',
      cypher: '   ',
    }))

    const messages = await collectMessages(ws, 1)
    expect(messages[0].type).toBe('error')
    expect(messages[0].message).toContain('Empty')
  })

  test('should cancel ongoing query', async () => {
    // Use a slow executor
    const slowExecutor = async function* (_cypher: string, _params: Record<string, unknown>) {
      for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, 10))
        yield { id: i }
      }
      return { totalRows: 100 }
    }
    server.setExecutor(slowExecutor)

    const ws = await connectWs(`ws://127.0.0.1:${port}/api/v1/ws/query`)

    ws.send(JSON.stringify({
      type: 'query',
      id: 'req-cancel',
      cypher: 'MATCH (n) RETURN n',
    }))

    // Wait a bit for some rows to stream
    await new Promise(r => setTimeout(r, 50))

    // Send cancel
    ws.send(JSON.stringify({ type: 'cancel', id: 'req-cancel' }))

    // Wait and check no more messages come
    await new Promise(r => setTimeout(r, 100))

    expect(server.activeQueryCount).toBe(0)
    ws.close()
  })

  test('should reject unknown message type', async () => {
    const ws = await connectWs(`ws://127.0.0.1:${port}/api/v1/ws/query`)

    ws.send(JSON.stringify({ type: 'unknown', id: 'req1' }))

    const messages = await collectMessages(ws, 1)
    expect(messages[0].type).toBe('error')
  })

  test('should error when no executor set', async () => {
    const noExecServer = new WsQueryServer({
      port: port + 1,
      host: '127.0.0.1',
    })
    await noExecServer.start()

    const ws = await connectWs(`ws://127.0.0.1:${port + 1}/api/v1/ws/query`)

    ws.send(JSON.stringify({
      type: 'query',
      id: 'req1',
      cypher: 'MATCH (n) RETURN n',
    }))

    const messages = await collectMessages(ws, 1)
    expect(messages[0].type).toBe('error')
    expect(messages[0].message).toContain('No query executor')

    await noExecServer.stop()
  })

  test('should enforce max concurrent queries', async () => {
    const limitedServer = new WsQueryServer({
      port: port + 2,
      host: '127.0.0.1',
      maxConcurrentQueries: 1,
    })
    limitedServer.setExecutor(createTestExecutor(10, 50)) // slow executor
    await limitedServer.start()

    const ws1 = await connectWs(`ws://127.0.0.1:${port + 2}/api/v1/ws/query`)
    const ws2 = await connectWs(`ws://127.0.0.1:${port + 2}/api/v1/ws/query`)

    // Start first query
    ws1.send(JSON.stringify({
      type: 'query',
      id: 'req1',
      cypher: 'MATCH (n) RETURN n',
    }))

    // Wait a bit
    await new Promise(r => setTimeout(r, 20))

    // Start second query — should be rejected
    ws2.send(JSON.stringify({
      type: 'query',
      id: 'req2',
      cypher: 'MATCH (n) RETURN n',
    }))

    const messages = await collectMessages(ws2, 1)
    expect(messages[0].type).toBe('error')
    expect(messages[0].message).toContain('Max concurrent queries')

    ws1.close()
    ws2.close()
    await limitedServer.stop()
  })

  test('should handle next (cursor) message gracefully', async () => {
    const ws = await connectWs(`ws://127.0.0.1:${port}/api/v1/ws/query`)

    ws.send(JSON.stringify({
      type: 'next',
      id: 'req-cursor',
      cursor: 'abc123',
    }))

    const messages = await collectMessages(ws, 1)
    // "next" cursor completes immediately with empty result
    expect(messages[0].type).toBe('complete')
    ws.close()
  })

  test('should get server config', () => {
    const cfg = server.config
    expect(cfg.port).toBe(port)
    expect(cfg.host).toBe('127.0.0.1')
    expect(cfg.path).toBe('/api/v1/ws/query')
    expect(cfg.batchSize).toBe(5)
    expect(cfg.maxBufferSize).toBe(100)
    expect(cfg.maxConcurrentQueries).toBe(10)
  })

  test('should support createBatchQueryExecutor adapter', async () => {
    const mockQuery = (_cypher: string, _params: Record<string, unknown>) => {
      return [{ x: 1 }, { x: 2 }, { x: 3 }]
    }
    const executor = createBatchQueryExecutor(mockQuery)
    const gen = executor('MATCH', {})

    const results: Record<string, unknown>[] = []
    for await (const row of gen) {
      results.push(row)
    }

    expect(results).toHaveLength(3)
    expect(results[0]).toEqual({ x: 1 })
    expect(results[1]).toEqual({ x: 2 })
    expect(results[2]).toEqual({ x: 3 })
  })
})
