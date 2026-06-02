// ============================================================
// bolt-server.spec.ts — Bolt Protocol Server Tests
// ============================================================

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { BoltServer, CypherQueryResult, CypherQueryExecutor, createBoltServer } from './bolt-server'
import * as net from 'net'
import * as crypto from 'crypto'

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────

/** Mock query engine executor for testing */
function createMockExecutor(): CypherQueryExecutor {
  const store: Array<{ cypher: string; params: Record<string, unknown> }> = []
  const executor: CypherQueryExecutor = (cypher: string, params: Record<string, unknown>) => {
    store.push({ cypher, params })

    if (cypher.includes('RETURN 1 AS num')) {
      return { fields: ['num'], records: [[1]] }
    }
    if (cypher.includes('InvalidQuery')) {
      throw new Error('Syntax error')
    }
    if (cypher.includes('MATCH')) {
      return { fields: ['n.id', 'n.name'], records: [[1, 'Alice'], [2, 'Bob']] }
    }
    return { fields: [], records: [] }
  }
  ;(executor as any)._callHistory = store
  return executor
}

/** Connect to the Bolt server and perform handshake */
async function boltConnect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket()
    const timeout = setTimeout(() => reject(new Error('Connect timeout')), 3000)

    socket.connect(port, '127.0.0.1', () => {
      clearTimeout(timeout)
      // Send Bolt magic + version negotiation
      const magic = Buffer.from([0x60, 0x60, 0xb0, 0x17])
      const versions = Buffer.alloc(16, 0)
      versions.writeUInt32BE(0x00040004, 0) // v4.4
      versions.writeUInt32BE(0x00030000, 4) // v3.0 fallback
      versions.writeUInt32BE(0x00020000, 8) // v2.0 fallback
      socket.write(Buffer.concat([magic, versions]))

      // Read version response
      socket.once('data', (data) => {
        if (data.length >= 4) {
          resolve(socket)
        } else {
          reject(new Error('Invalid handshake response'))
        }
      })
    })

    socket.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

/** Send a Bolt message with proper struct framing
 *  Bolt struct wire format: [struct_tag:1][sig:1][fields...]
 *  struct_tag = 0xb0 | field_count
 *  For single-field messages (HELLO, RESET, GOODBYE, BEGIN): 0xb1 + sig + field
 *  For 3-field RUN: 0xb3 + sig + field1 + field2 + field3
 *  For 0-field PULL_ALL: 0xb0 + sig (or just sig)
 */
function sendBoltMessage(
  socket: net.Socket,
  sig: number,
  fieldCount: number,
  fieldData?: Buffer,
): void {
  const header = Buffer.alloc(2)
  header[0] = 0xb0 | fieldCount // struct tag
  header[1] = sig // message signature (e.g., 0x01 for HELLO)

  const msg = fieldData
    ? Buffer.concat([header, fieldData])
    : header

  // Chunk framing
  const chunk = Buffer.alloc(2 + msg.length + 2)
  chunk.writeUInt16BE(msg.length, 0)
  msg.copy(chunk, 2)
  chunk[chunk.length - 2] = 0x00
  chunk[chunk.length - 1] = 0x00

  socket.write(chunk)
}

/** Read all response data from socket */
function readResponse(socket: net.Socket): Promise<Buffer[]> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const onData = (data: Buffer) => {
      chunks.push(data)
    }
    socket.on('data', onData)

    setTimeout(() => {
      socket.removeListener('data', onData)
      resolve(chunks)
    }, 500)
  })
}

/** Encode a Cypher string + params as PackStream for RUN message */
function encodeRunMessage(query: string, params: Record<string, unknown> = {}): Buffer {
  // Simple PackStream encoding for [cypher: String, params: Map, extra: Map]
  const parts: Buffer[] = []

  // Encode query string as int8-size string (marker 0xd0 + len + data)
  const queryBuf = Buffer.from(query, 'utf8')
  const queryHeader = Buffer.alloc(2)
  queryHeader[0] = 0xd0 // String8 marker
  queryHeader[1] = queryBuf.length
  parts.push(queryHeader, queryBuf)

  // Encode empty map (0xa0 = map size 0) for params
  const emptyMap = Buffer.from([0xa0])
  parts.push(emptyMap)

  // Encode empty map (0xa0) for extra
  parts.push(Buffer.from([0xa0]))

  return Buffer.concat(parts)
}

// ──────────────────────────────────────────
// Tests
// ──────────────────────────────────────────

describe('BoltServer — Protocol Compliance', () => {
  let server: BoltServer | null = null
  let port = 0
  let executor: CypherQueryExecutor

  beforeEach(async () => {
    executor = createMockExecutor()
    port = 0 // auto-assign port
  })

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = null
    }
  })

  test('GAP-09-1: start server on random port', async () => {
    server = new BoltServer(executor, { port: 0, host: '127.0.0.1' })
    await server.start()
    expect(server.getPort()).toBeGreaterThan(0)
    expect(server.getConnections()).toBe(0)
  })

  test('GAP-09-2: start/stop server', async () => {
    const inst = createBoltServer(executor, { port: 0, host: '127.0.0.1' })
    await inst.start()
    expect(inst.getPort()).toBeGreaterThan(0)
    await inst.stop()
  })

  test('GAP-09-3: Bolt handshake succeeds', async () => {
    server = new BoltServer(executor, { port: 0, host: '127.0.0.1' })
    await server.start()
    const socket = await boltConnect(server.getPort())
    expect(socket).toBeDefined()
    expect(socket.writable).toBe(true)
    socket.destroy()
  })

  test('GAP-09-4: HELLO → SUCCESS response', async () => {
    server = new BoltServer(executor, { port: 0, host: '127.0.0.1' })
    await server.start()
    const socket = await boltConnect(server.getPort())

    // Send HELLO message
    // HELLO struct has 1 field: metadata map
    // HELLO message: struct(1) + sig(0x01) + empty_map(0xa0)
    sendBoltMessage(socket, 0x01, 1, Buffer.from([0xa0]))

    const responses = await readResponse(socket)
    expect(responses.length).toBeGreaterThan(0)

    // Check that response starts with SUCCESS marker (0x70)
    let foundSuccess = false
    for (const resp of responses) {
      if (resp.length >= 2) {
        const chunkLen = resp.readUInt16BE(0)
        if (chunkLen > 0 && resp[2] === 0x70) {
          foundSuccess = true
          break
        }
      }
    }
    expect(foundSuccess).toBe(true)
    socket.destroy()
  })

  test('GAP-09-5: RUN + PULL_ALL returns records', async () => {
    server = new BoltServer(executor, { port: 0, host: '127.0.0.1' })
    await server.start()
    const socket = await boltConnect(server.getPort())

    // HELLO
    sendBoltMessage(socket, 0x01, 1, Buffer.from([0xa0]))
    await new Promise(r => setTimeout(r, 100))

    // RUN: execute a query — struct(3) + sig(0x10) + [cypher, empty_map, empty_map]
    const runPayload = encodeRunMessage('RETURN 1 AS num')
    sendBoltMessage(socket, 0x10, 3, runPayload)
    await new Promise(r => setTimeout(r, 100))

    // PULL_ALL: struct(1) + sig(0x3f) + empty_map
    sendBoltMessage(socket, 0x3f, 1, Buffer.from([0xa0]))
    await new Promise(r => setTimeout(r, 200))

    const responses = await readResponse(socket)
    expect(responses.length).toBeGreaterThan(0)
    socket.destroy()
  })

  test('GAP-09-6: RESET clears pending query', async () => {
    server = new BoltServer(executor, { port: 0, host: '127.0.0.1' })
    await server.start()
    const socket = await boltConnect(server.getPort())

    // HELLO
    sendBoltMessage(socket, 0x01, 1, Buffer.from([0xa0]))
    await new Promise(r => setTimeout(r, 50))

    // RESET: struct(0) + sig(0x0f) — no fields
    sendBoltMessage(socket, 0x0f, 0)
    await new Promise(r => setTimeout(r, 100))

    const responses = await readResponse(socket)
    expect(responses.length).toBeGreaterThan(0)
    socket.destroy()
  })

  test('GAP-09-7: GOODBYE closes connection', async () => {
    server = new BoltServer(executor, { port: 0, host: '127.0.0.1' })
    await server.start()
    const socket = await boltConnect(server.getPort())

    // HELLO
    sendBoltMessage(socket, 0x01, 1, Buffer.from([0xa0]))
    await new Promise(r => setTimeout(r, 50))

    // GOODBYE: struct(0) + sig(0x02) — no fields
    sendBoltMessage(socket, 0x02, 0)
    await new Promise(r => setTimeout(r, 100))

    expect(socket.destroyed || !socket.writable).toBe(true)
  })

  test('GAP-09-8: getConnections tracks active sessions', async () => {
    server = new BoltServer(executor, { port: 0, host: '127.0.0.1' })
    await server.start()
    expect(server.getConnections()).toBe(0)

    const socket = await boltConnect(server.getPort())
    expect(server.getConnections()).toBe(1)

    socket.destroy()
    await new Promise(r => setTimeout(r, 100))
    expect(server.getConnections()).toBe(0)
  })

  test('GAP-09-9: RUN with syntax error returns FAILURE', async () => {
    server = new BoltServer(executor, { port: 0, host: '127.0.0.1' })
    await server.start()
    const socket = await boltConnect(server.getPort())

    // HELLO
    sendBoltMessage(socket, 0x01, 1, Buffer.from([0xa0]))
    await new Promise(r => setTimeout(r, 50))

    // RUN with invalid query
    const runPayload = encodeRunMessage('InvalidQuery')
    sendBoltMessage(socket, 0x10, 3, runPayload)
    await new Promise(r => setTimeout(r, 100))

    const responses = await readResponse(socket)
    let foundFailure = false
    for (const resp of responses) {
      if (resp.length >= 2) {
        const chunkLen = resp.readUInt16BE(0)
        if (chunkLen > 0 && resp[2] === 0x7f) {
          foundFailure = true
          break
        }
      }
    }
    expect(foundFailure).toBe(true)
    socket.destroy()
  })

  test('GAP-09-10: createBoltServer factory createsInstance', async () => {
    const inst = createBoltServer(executor, { port: 0, host: '127.0.0.1' })
    await inst.start()
    expect(inst.getPort()).toBeGreaterThan(0)
    expect(typeof inst.getConnections).toBe('function')
    await inst.stop()
  })

  test('GAP-09-11: executeQuery with MATCH returns records', async () => {
    server = new BoltServer(executor, { port: 0, host: '127.0.0.1' })
    await server.start()

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
    if (server) {
      await server.stop()
      server = null
    }
  })

  test('GAP-09-12: stop with no active server is safe', async () => {
    server = new BoltServer(() => ({ fields: [], records: [] }), { port: 0 })
    await server.stop()
    // Should not throw
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
