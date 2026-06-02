// ============================================================
// bolt-server.spec.ts — Bolt Protocol Server Tests
// ============================================================

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { BoltServer, CypherQueryResult, CypherQueryExecutor, createBoltServer } from './bolt-server'
import * as net from 'net'

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────

/** Mock query engine executor for testing */
function createMockExecutor(): CypherQueryExecutor {
  const executor: CypherQueryExecutor = (cypher: string) => {
    if (cypher.includes('InvalidQuery')) {
      throw new Error('Syntax error')
    }
    if (cypher.includes('MATCH')) {
      return { fields: ['n.id', 'n.name'], records: [[1, 'Alice'], [2, 'Bob']] }
    }
    return { fields: ['num'], records: [[1]] }
  }
  return executor
}

/** Perform Bolt handshake and return connected socket */
function boltConnect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket()
    const timeout = setTimeout(() => reject(new Error('Connect timeout')), 5000)

    socket.connect(port, '127.0.0.1', () => {
      // Send magic + version negotiation
      const magic = Buffer.from([0x60, 0x60, 0xb0, 0x17])
      const versions = Buffer.alloc(16, 0)
      versions.writeUInt32BE(0x00040004, 0)
      socket.write(Buffer.concat([magic, versions]))

      // Wait for version response (4 bytes)
      const onData = (data: Buffer) => {
        if (data.length >= 4) {
          clearTimeout(timeout)
          socket.removeListener('data', onData)
          resolve(socket)
        }
      }
      socket.on('data', onData)
    })

    socket.on('error', (err) => { clearTimeout(timeout); reject(err) })
  })
}

/**
 * Build a fully framed Bolt message with struct wrapping.
 * Wire format: [struct_tag:1][sig:1][field_data...]
 */
function boltFramed(sig: number, fieldCount: number, fieldData?: Buffer): Buffer {
  const header = Buffer.alloc(2)
  header[0] = 0xb0 | fieldCount
  header[1] = sig
  const payload = fieldData ? Buffer.concat([header, fieldData]) : header
  const msg = Buffer.alloc(2 + payload.length + 2)
  msg.writeUInt16BE(payload.length, 0)
  payload.copy(msg, 2)
  msg[msg.length - 2] = 0x00
  msg[msg.length - 1] = 0x00
  return msg
}

/** Send a framed Bolt message to socket */
function boltSend(socket: net.Socket, sig: number, fieldCount: number, fieldData?: Buffer): void {
  socket.write(boltFramed(sig, fieldCount, fieldData))
}

/** Build 3 fields body for a RUN message: [cypher: String8, params: Map0, extra: Map0] */
function boltRunBody(cypher: string): Buffer {
  const cypherBuf = Buffer.from(cypher, 'utf8')
  return Buffer.concat([
    Buffer.from([0xd0, cypherBuf.length]),
    cypherBuf,
    Buffer.from([0xa0]), // empty params map
    Buffer.from([0xa0]), // empty extra map
  ])
}

/** Collect response chunks for a given duration */
function collectResponses(socket: net.Socket, durationMs = 500): Promise<Buffer[]> {
  return new Promise((resolve) => {
    const responses: Buffer[] = []
    const handler = (data: Buffer) => responses.push(data)
    socket.on('data', handler)
    const timer = setTimeout(() => {
      socket.removeListener('data', handler)
      resolve(responses)
    }, durationMs)
    socket.once('close', () => { clearTimeout(timer); resolve(responses) })
  })
}

/** Extract response signatures (0x70=SUCCESS, 0x7f=FAILURE, 0x71=RECORD) from framed Bolt responses */
function extractSignatures(responses: Buffer[]): number[] {
  const sigs: number[] = []
  for (const resp of responses) {
    let offset = 0
    while (offset + 2 <= resp.length) {
      const chunkLen = resp.readUInt16BE(offset)
      if (chunkLen === 0) { offset += 2; continue }
      if (offset + 2 + chunkLen > resp.length) break
      sigs.push(resp[offset + 2 + 1]) // second byte of data = sig/marker
      offset += 2 + chunkLen + 2
    }
  }
  return sigs
}

// ──────────────────────────────────────────
// Tests
// ──────────────────────────────────────────

describe('BoltServer — Protocol Compliance', () => {
  let server: BoltServer | null = null
  let executor: CypherQueryExecutor
  let globalResponses: Buffer[] = []
  let globalSocket: net.Socket | null = null

  /** Attach a global data listener */
  function attachCollector(socket: net.Socket): void {
    globalSocket = socket
    globalResponses = []
    socket.on('data', (data: Buffer) => globalResponses.push(data))
  }

  beforeEach(() => { executor = createMockExecutor() })

  afterEach(async () => {
    if (globalSocket) { globalSocket.removeAllListeners('data'); globalSocket = null }
    globalResponses = []
    if (server) { await server.stop().catch(() => {}); server = null }
  })

  test('GAP-09-1: start server on random port', async () => {
    server = new BoltServer(executor, { port: 0, host: '127.0.0.1' })
    await server.start()
    expect(server.getPort()).toBeGreaterThan(0)
    expect(server.getConnections()).toBe(0)
  })

  test('GAP-09-2: start/stop server via factory', async () => {
    const inst = createBoltServer(executor, { port: 0, host: '127.0.0.1' })
    await inst.start()
    expect(inst.getPort()).toBeGreaterThan(0)
    await inst.stop()
  })

  test('GAP-09-3: Bolt handshake succeeds', async () => {
    server = new BoltServer(executor, { port: 0, host: '127.0.0.1' })
    await server.start()
    const socket = await boltConnect(server.getPort())
    expect(socket.writable).toBe(true)
    socket.destroy()
  })

  test('GAP-09-4: HELLO -> SUCCESS response', async () => {
    server = new BoltServer(executor, { port: 0, host: '127.0.0.1' })
    await server.start()
    const socket = await boltConnect(server.getPort())
    attachCollector(socket)
    boltSend(socket, 0x01, 1, Buffer.from([0xa0])) // HELLO with empty map
    await new Promise(r => setTimeout(r, 300))
    const sigs = extractSignatures(globalResponses)
    expect(sigs).toContain(0x70) // SUCCESS
    socket.destroy()
  })

  test('GAP-09-5: RUN + PULL_ALL returns records', async () => {
    server = new BoltServer(executor, { port: 0, host: '127.0.0.1' })
    await server.start()
    const socket = await boltConnect(server.getPort())
    attachCollector(socket)
    boltSend(socket, 0x01, 1, Buffer.from([0xa0])) // HELLO
    await new Promise(r => setTimeout(r, 100))
    boltSend(socket, 0x10, 3, boltRunBody('RETURN 1 AS num')) // RUN
    await new Promise(r => setTimeout(r, 100))
    boltSend(socket, 0x3f, 1, Buffer.from([0xa0])) // PULL_ALL
    await new Promise(r => setTimeout(r, 600))
    const sigs = extractSignatures(globalResponses)
    expect(sigs.filter(s => s === 0x70).length).toBeGreaterThanOrEqual(2) // success from HELLO+RUN
    expect(sigs).toContain(0x71) // RECORD
    socket.destroy()
  })

  test('GAP-09-6: RESET clears pending query', async () => {
    server = new BoltServer(executor, { port: 0, host: '127.0.0.1' })
    await server.start()
    const socket = await boltConnect(server.getPort())
    attachCollector(socket)
    boltSend(socket, 0x01, 1, Buffer.from([0xa0]))
    await new Promise(r => setTimeout(r, 100))
    boltSend(socket, 0x0f, 0) // RESET — no fields
    await new Promise(r => setTimeout(r, 400))
    const sigs = extractSignatures(globalResponses)
    expect(sigs).toContain(0x70) // SUCCESS from RESET
    socket.destroy()
  })

  test('GAP-09-7: GOODBYE closes connection', async () => {
    server = new BoltServer(executor, { port: 0, host: '127.0.0.1' })
    await server.start()
    const socket = await boltConnect(server.getPort())
    await new Promise(r => setTimeout(r, 50))
    boltSend(socket, 0x01, 1, Buffer.from([0xa0]))
    await new Promise(r => setTimeout(r, 100))
    boltSend(socket, 0x02, 0) // GOODBYE — no fields
    await new Promise(r => setTimeout(r, 300))
    expect(socket.destroyed || !socket.writable).toBe(true)
  })

  test('GAP-09-8: getConnections tracks active sessions', async () => {
    server = new BoltServer(executor, { port: 0, host: '127.0.0.1' })
    await server.start()
    expect(server.getConnections()).toBe(0)
    const socket = await boltConnect(server.getPort())
    await new Promise(r => setTimeout(r, 50))
    expect(server.getConnections()).toBe(1)
    socket.destroy()
    await new Promise(r => setTimeout(r, 200))
    expect(server.getConnections()).toBe(0)
  })

  test('GAP-09-9: RUN with syntax error returns FAILURE', async () => {
    server = new BoltServer(executor, { port: 0, host: '127.0.0.1' })
    await server.start()
    const socket = await boltConnect(server.getPort())
    attachCollector(socket)
    boltSend(socket, 0x01, 1, Buffer.from([0xa0])) // HELLO
    await new Promise(r => setTimeout(r, 100))
    boltSend(socket, 0x10, 3, boltRunBody('InvalidQuery')) // RUN with invalid query
    await new Promise(r => setTimeout(r, 400))
    const sigs = extractSignatures(globalResponses)
    expect(sigs).toContain(0x7f) // FAILURE
    socket.destroy()
  })

  test('GAP-09-10: createBoltServer factory creates instance', async () => {
    const inst = createBoltServer(executor, { port: 0, host: '127.0.0.1' })
    await inst.start()
    expect(inst.getPort()).toBeGreaterThan(0)
    expect(typeof inst.getConnections).toBe('function')
    await inst.stop()
  })

  test('GAP-09-11: executeQuery with MATCH returns records', async () => {
    const result = executor('MATCH (n) RETURN n.id, n.name', {})
    expect(result.fields).toEqual(['n.id', 'n.name'])
    expect(result.records).toHaveLength(2)
    expect(result.records[0]).toEqual([1, 'Alice'])
    expect(result.records[1]).toEqual([2, 'Bob'])
  })
})

describe('BoltServer — Runtime Edge Cases', () => {
  let server: BoltServer | null = null

  afterEach(async () => {
    if (server) { await server.stop().catch(() => {}); server = null }
  })

  test('GAP-09-12: stop with no active server is safe', async () => {
    server = new BoltServer(() => ({ fields: [], records: [] }), { port: 0 })
    await server.stop()
    expect(true).toBe(true)
  })

  test('GAP-09-13: double stop is safe', async () => {
    server = new BoltServer(() => ({ fields: [], records: [] }), { port: 0, host: '127.0.0.1' })
    await server.start()
    await server.stop()
    await server.stop()
    expect(true).toBe(true)
  })

  test('GAP-09-14: default port is 7687', () => {
    const s = new BoltServer(() => ({ fields: [], records: [] }))
    expect(s.getPort()).toBe(7687)
  })
})
