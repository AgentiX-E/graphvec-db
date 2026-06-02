// ============================================================
// bolt-server.ts — Bolt Protocol Server (Neo4j Wire Compatible)
//
// Implements a minimal Bolt v4.x server that speaks the Bolt
// binary protocol. Supports:
//   - HELLO          — client handshake / auth
//   - RUN            — execute a Cypher query
//   - PULL_ALL       — fetch all remaining results
//   - RESET          — reset session state
//   - GOODBYE        — close connection
//
// Queries are dispatched to the local QueryEngine for execution.
// ============================================================

import * as net from 'net'
import * as crypto from 'crypto'

// ──────────────────────────────────────────
// Constants
// ──────────────────────────────────────────

/** Bolt protocol version we support */
const BOLT_VERSION = 0x00040004 // v4.4
const BOLT_VERSION_COMPACT = 0x00040004

/** Magic handshake bytes for Bolt protocol */
const BOLT_MAGIC = Buffer.from([0x60, 0x60, 0xb0, 0x17])

/** Chunk header size: 2 bytes length */
const CHUNK_HEADER_SIZE = 2

/** Noop / NO-OP signature */
const NOOP = 0x0e

// ──────────────────────────────────────────
// Bolt Message Signatures
// ──────────────────────────────────────────

const SIG = {
  // Request
  HELLO:     0x01,
  RUN:       0x10,
  PULL_ALL:  0x3f,
  RESET:     0x0f,
  GOODBYE:   0x02,
  BEGIN:     0x11,
  COMMIT:    0x12,
  ROLLBACK:  0x13,
  // Response
  SUCCESS:   0x70,
  FAILURE:   0x7f,
  IGNORED:   0x7e,
  RECORD:    0x71,
} as const

// ──────────────────────────────────────────
// Types
// ──────────────────────────────────────────

/** Result of a Cypher query execution */
export interface CypherQueryResult {
  /** Column/field names */
  fields: string[]
  /** Row records (each record is either an array of values or a map) */
  records: unknown[][]
}

/** Function signature for query execution */
export type CypherQueryExecutor = (cypher: string, params: Record<string, unknown>) => CypherQueryResult

export interface BoltServerConfig {
  /** TCP port to listen on. Default 7687 (standard Bolt port). */
  port: number
  /** Host to bind to. Default '0.0.0.0'. */
  host: string
}

export interface BoltServerInstance {
  start(): Promise<void>
  stop(): Promise<void>
  getPort(): number
  getConnections(): number
}

/** Internal — a single Bolt client session */
interface BoltSession {
  id: string
  socket: net.Socket
  authenticated: boolean
  userAgent: string
  /** Current transaction state — simple pending query context */
  pendingQuery: string | null
  pendingParams: Record<string, unknown> | null
}

// ──────────────────────────────────────────
// PackStream — Bolt's serialization format
// ──────────────────────────────────────────

/**
 * Minimal PackStream writer (Bolt v4 subset).
 * Supports: Null, Boolean, Integer (up to 32-bit), Float, String, List, Dictionary/Map, Struct.
 */
class PackStreamWriter {
  private _buf: Buffer
  private _offset: number

  constructor(capacity = 4096) {
    this._buf = Buffer.alloc(capacity)
    this._offset = 0
  }

  buffer(): Buffer {
    return this._buf.slice(0, this._offset)
  }

  /** Ensure enough capacity for n bytes */
  private reserve(n: number): void {
    if (this._offset + n > this._buf.length) {
      const newSize = Math.max(this._buf.length * 2, this._offset + n + 1024)
      const newBuf = Buffer.alloc(newSize)
      this._buf.copy(newBuf)
      this._buf = newBuf
    }
  }

  writeNull(): void {
    this.reserve(1)
    this._buf[this._offset++] = 0xc0
  }

  writeBool(v: boolean): void {
    this.reserve(1)
    this._buf[this._offset++] = v ? 0xc3 : 0xc2
  }

  writeInt(v: number): void {
    // Tiny int range -16..+127 uses a single marker byte
    if (v >= -16 && v <= 127) {
      if (v >= 0 && v <= 127) {
        this.reserve(1)
        this._buf[this._offset++] = v
      } else {
        // negative tiny int: marker = 0xf0 + (v + 16), but we use int8 overflow
        this.reserve(2)
        this._buf[this._offset++] = 0xc8
        this._buf.writeInt8(v, this._offset)
        this._offset += 1
      }
      return
    }
    if (v >= -128 && v <= 127) {
      this.reserve(2)
      this._buf[this._offset++] = 0xc8
      this._buf.writeInt8(v, this._offset)
      this._offset += 1
      return
    }
    if (v >= -32768 && v <= 32767) {
      this.reserve(3)
      this._buf[this._offset++] = 0xc9
      this._buf.writeInt16BE(v, this._offset)
      this._offset += 2
      return
    }
    // int 32
    this.reserve(5)
    this._buf[this._offset++] = 0xca
    this._buf.writeInt32BE(v, this._offset)
    this._offset += 4
  }

  writeFloat(v: number): void {
    this.reserve(9)
    this._buf[this._offset++] = 0xc1
    this._buf.writeDoubleBE(v, this._offset)
    this._offset += 8
  }

  writeString(v: string): void {
    const encoded = Buffer.from(v, 'utf8')
    const len = encoded.length
    if (len < 16) {
      this.reserve(1 + len)
      this._buf[this._offset++] = 0x80 | len
    } else if (len < 256) {
      this.reserve(2 + len)
      this._buf[this._offset++] = 0xd0
      this._buf[this._offset++] = len
    } else if (len < 65536) {
      this.reserve(3 + len)
      this._buf[this._offset++] = 0xd1
      this._buf.writeUInt16BE(len, this._offset)
      this._offset += 2
    } else {
      this.reserve(5 + len)
      this._buf[this._offset++] = 0xd2
      this._buf.writeUInt32BE(len, this._offset)
      this._offset += 4
    }
    encoded.copy(this._buf, this._offset)
    this._offset += len
  }

  writeListHeader(n: number): void {
    if (n < 16) {
      this.reserve(1)
      this._buf[this._offset++] = 0x90 | n
    } else if (n < 256) {
      this.reserve(2)
      this._buf[this._offset++] = 0xd4
      this._buf[this._offset++] = n
    } else if (n < 65536) {
      this.reserve(3)
      this._buf[this._offset++] = 0xd5
      this._buf.writeUInt16BE(n, this._offset)
      this._offset += 2
    } else {
      this.reserve(5)
      this._buf[this._offset++] = 0xd6
      this._buf.writeUInt32BE(n, this._offset)
      this._offset += 4
    }
  }

  writeMapHeader(n: number): void {
    if (n < 16) {
      this.reserve(1)
      this._buf[this._offset++] = 0xa0 | n
    } else if (n < 256) {
      this.reserve(2)
      this._buf[this._offset++] = 0xd8
      this._buf[this._offset++] = n
    } else if (n < 65536) {
      this.reserve(3)
      this._buf[this._offset++] = 0xd9
      this._buf.writeUInt16BE(n, this._offset)
      this._offset += 2
    } else {
      this.reserve(5)
      this._buf[this._offset++] = 0xda
      this._buf.writeUInt32BE(n, this._offset)
      this._offset += 4
    }
  }

  writeStructHeader(n: number): void {
    if (n < 16) {
      this.reserve(1)
      this._buf[this._offset++] = 0xb0 | n
    } else {
      this.reserve(2)
      this._buf[this._offset++] = 0xdc
      this._buf[this._offset++] = n
    }
  }

  /** Write a single value using PackStream encoding */
  writeValue(val: unknown): void {
    if (val === null || val === undefined) {
      this.writeNull()
    } else if (typeof val === 'boolean') {
      this.writeBool(val)
    } else if (typeof val === 'number') {
      if (Number.isInteger(val)) {
        this.writeInt(val as number)
      } else {
        this.writeFloat(val)
      }
    } else if (typeof val === 'string') {
      this.writeString(val)
    } else if (Buffer.isBuffer(val)) {
      // ByteArray — write as list of ints for simplicity
      this.writeListHeader(val.length)
      for (let i = 0; i < val.length; i++) {
        this.writeInt(val[i])
      }
    } else if (Array.isArray(val)) {
      this.writeListHeader(val.length)
      for (const item of val) {
        this.writeValue(item)
      }
    } else if (typeof val === 'object') {
      const entries = Object.entries(val as Record<string, unknown>)
      this.writeMapHeader(entries.length)
      for (const [k, v] of entries) {
        this.writeString(k)
        this.writeValue(v)
      }
    } else {
      this.writeNull()
    }
  }

  /** Write a Bolt SUCCESS message */
  writeSuccess(meta: Record<string, unknown>): Buffer {
    this.reserve(2)
    this._buf[this._offset++] = 0xb1 // struct(1)
    this._buf[this._offset++] = SIG.SUCCESS
    this.writeValue(meta)
    return this.finalize()
  }

  /** Write a Bolt FAILURE message */
  writeFailure(code: string, message: string): Buffer {
    this.reserve(2)
    this._buf[this._offset++] = 0xb1 // struct(1)
    this._buf[this._offset++] = SIG.FAILURE
    this.writeValue({ code, message })
    return this.finalize()
  }

  /** Write a Bolt RECORD message */
  writeRecord(fields: unknown[]): Buffer {
    this.reserve(2)
    this._buf[this._offset++] = 0xb1 // struct(1)
    this._buf[this._offset++] = SIG.RECORD
    this.writeValue(fields)
    return this.finalize()
  }

  /** Write a Bolt IGNORED message */
  writeIgnored(): Buffer {
    this.reserve(2)
    this._buf[this._offset++] = 0xb0 // struct(0)
    this._buf[this._offset++] = SIG.IGNORED
    return this.finalize()
  }

  /** Finalize a message into chunked format: [len:2][data...][00 00] */
  private finalize(): Buffer {
    const payload = this._buf.slice(0, this._offset)
    this._offset = 0

    if (payload.length === 0) {
      // NOOP
      return Buffer.from([0x00, 0x00])
    }

    // Chunk header
    const chunked = Buffer.alloc(2 + payload.length + 2)
    chunked.writeUInt16BE(payload.length, 0)
    payload.copy(chunked, 2)
    // End marker
    chunked[chunked.length - 2] = 0x00
    chunked[chunked.length - 1] = 0x00
    return chunked
  }
}

// ──────────────────────────────────────────
// Bolt Protocol Server
// ──────────────────────────────────────────

/**
 * BoltServer — TCP server that speaks the Bolt v4 protocol.
 *
 * Provides a Neo4j-compatible wire protocol endpoint for the
 * GraphVec query engine.
 */
export class BoltServer {
  private server: net.Server | null = null
  private sessions = new Map<string, BoltSession>()
  private closed = false
  private port: number
  private host: string

  constructor(
    private executeQuery: CypherQueryExecutor,
    config?: Partial<BoltServerConfig>,
  ) {
    this.port = config?.port ?? 7687
    this.host = config?.host ?? '0.0.0.0'
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = net.createServer((socket) => this.handleConnection(socket))
      this.server!.listen(this.port, this.host, () => {
        // If port 0 was specified, get the actual port
        if (this.port === 0) {
          this.port = (this.server!.address() as net.AddressInfo).port
        }
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    this.closed = true
    for (const session of this.sessions.values()) {
      session.socket.destroy()
    }
    this.sessions.clear()
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve())
        this.server = null
      } else {
        resolve()
      }
    })
  }

  getPort(): number {
    return this.port
  }

  getConnections(): number {
    return this.sessions.size
  }

  // ──────────────────────────────────────
  // Connection Handler
  // ──────────────────────────────────────

  private handleConnection(socket: net.Socket): void {
    const session: BoltSession = {
      id: crypto.randomUUID(),
      socket,
      authenticated: false,
      userAgent: '',
      pendingQuery: null,
      pendingParams: null,
    }
    this.sessions.set(session.id, session)

    let buffer = Buffer.alloc(0)
    let handshakeDone = false
    let leftover = Buffer.alloc(0)

    socket.on('data', (chunk: Buffer) => {
      if (this.closed) return
      if (!handshakeDone) {
        // First 4 bytes must be magic
        if (buffer.length < 4) {
          buffer = Buffer.concat([buffer, chunk])
          if (buffer.length < 4) return
        }
        if (!handshakeDone && buffer.length >= 4) {
          // Check magic
          const magic = buffer.slice(0, 4)
          if (magic.equals(BOLT_MAGIC)) {
            // Read version negotiation (next 16 bytes: 4 x 4-byte versions)
            const needed = 4 + 16
            if (buffer.length < needed) {
              // Need more data
              if (buffer.length + chunk.length >= needed) {
                buffer = Buffer.concat([buffer, chunk])
              } else {
                buffer = Buffer.concat([buffer, chunk])
                return
              }
            } else if (buffer.length < needed && chunk.length > 0) {
              buffer = Buffer.concat([buffer, chunk])
            }

            if (buffer.length >= needed) {
              handshakeDone = true
              // Send supported version
              const versionBuf = Buffer.alloc(4)
              versionBuf.writeUInt32BE(BOLT_VERSION, 0)
              socket.write(versionBuf)
              leftover = buffer.slice(needed)
              buffer = Buffer.alloc(0)
              // Process any messages after handshake
              if (leftover.length > 0) {
                this.processMessages(socket, session, leftover)
              }
            }
          } else {
            // Invalid magic — disconnect
            socket.destroy()
            this.sessions.delete(session.id)
          }
        }
      } else {
        this.processMessages(socket, session, chunk)
      }
    })

    socket.on('close', () => {
      this.sessions.delete(session.id)
    })

    socket.on('error', () => {
      this.sessions.delete(session.id)
    })
  }

  // ──────────────────────────────────────
  // Message Processing
  // ──────────────────────────────────────

  private processMessages(socket: net.Socket, session: BoltSession, data: Buffer): void {
    // Append incoming data to a session-level buffer for message assembly
    if (!(session as any)._buffer) {
      (session as any)._buffer = Buffer.alloc(0)
    }
    (session as any)._buffer = Buffer.concat([(session as any)._buffer, data])

    const buf = (session as any)._buffer as Buffer
    let offset = 0

    while (offset + 2 <= buf.length) {
      const chunkLen = buf.readUInt16BE(offset)

      // End-of-message marker (00 00)
      if (chunkLen === 0) {
        offset += 2
        continue
      }

      // Need full chunk
      if (offset + 2 + chunkLen > buf.length) break

      const chunkData = buf.slice(offset + 2, offset + 2 + chunkLen)
      offset += 2 + chunkLen

      // Check for end-of-message marker (00 00 after chunk data)
      if (offset + 2 <= buf.length) {
        const nextBytes = buf.readUInt16BE(offset)
        if (nextBytes === 0) {
          offset += 2
          // Complete message received — handle it
          this.handleMessage(socket, session, chunkData)
        } else {
          // Not an end marker — there might be more chunks
          // For simple cases, treat this as a complete message
          this.handleMessage(socket, session, chunkData)
        }
      } else {
        break
      }
    }

    // Remove processed bytes
    if (offset > 0) {
      (session as any)._buffer = buf.slice(offset)
    }
  }

  private handleMessage(socket: net.Socket, session: BoltSession, msg: Buffer): void {
    if (msg.length === 0) return

    // Bolt struct format: [struct_tag:1][sig:1][fields...]
    // struct_tag = 0xb0 | field_count (e.g., 0xb1 for 1 field, 0xb3 for 3 fields)
    // sig = message signature (e.g., 0x01 for HELLO)
    const structTag = msg[0]
    if (msg.length < 2) return
    const sig = msg[1]
    const payload = msg.slice(2)

    switch (sig) {
      case SIG.HELLO:
        this.handleHello(socket, session, payload)
        break
      case SIG.RUN:
        this.handleRun(socket, session, payload)
        break
      case SIG.PULL_ALL:
        this.handlePullAll(socket, session, payload)
        break
      case SIG.RESET:
        this.handleReset(socket, session, payload)
        break
      case SIG.GOODBYE:
        this.handleGoodbye(socket, session, payload)
        break
      case SIG.BEGIN:
        this.handleBegin(socket, session, payload)
        break
      case SIG.COMMIT:
      case SIG.ROLLBACK:
        this.handleCommitRollback(socket, session, payload)
        break
      default:
        // Unknown message → IGNORED
        socket.write(new PackStreamWriter().writeIgnored())
        break
    }
  }

  // ──────────────────────────────────────
  // Message Handlers
  // ──────────────────────────────────────

  private handleHello(socket: net.Socket, session: BoltSession, payload: Buffer): void {
    try {
      // payload contains the HELLO metadata map (struct tag and sig already stripped)
      const decoded = this.decodeValue(payload, 0)
      const meta = decoded?.value as Record<string, unknown> ?? {}

      session.userAgent = String(meta.user_agent ?? '')
      session.authenticated = true

      const writer = new PackStreamWriter()
      socket.write(writer.writeSuccess({
        server: 'GraphVec/BoltServer/0.1.0',
        connection_id: session.id,
        hints: { connection_recv_timeout_seconds: 300 },
      }))
    } catch {
      const writer = new PackStreamWriter()
      socket.write(writer.writeFailure('Neo.ClientError.Request.Invalid', 'Invalid HELLO message'))
    }
  }

  private handleRun(socket: net.Socket, session: BoltSession, payload: Buffer): void {
    if (!session.authenticated) {
      socket.write(new PackStreamWriter().writeFailure(
        'Neo.ClientError.Security.Unauthorized',
        'Not authenticated',
      ))
      return
    }

    try {
      // Decode RUN message: payload contains 3 fields [cypher: String, params: Map, extra: Map]
      // struct tag and sig already stripped by handleMessage, so payload starts with field1
      const runFields: unknown[] = []
      let offset = 0
      for (let i = 0; i < 3 && offset < payload.length; i++) {
        const decoded = this.decodeValue(payload, offset)
        if (!decoded) break
        runFields.push(decoded.value)
        offset += decoded.bytesRead
      }

      if (runFields.length < 2) {
        socket.write(new PackStreamWriter().writeFailure(
          'Neo.ClientError.Request.Invalid',
          'Invalid RUN message',
        ))
        return
      }

      const cypher = String(runFields[0])
      const params = (runFields[1] as Record<string, unknown>) ?? {}

      // Store pending query context
      session.pendingQuery = cypher
      session.pendingParams = params

      // Parse and prepare query — return field metadata
      const result = this.executeQuery(cypher, params)
      const queryFields = result.fields ?? []

      // Build success metadata
      const writer = new PackStreamWriter()
      const qid = -1
      socket.write(writer.writeSuccess({
        queryFields,
        t_first: 1,
        qid,
      }))
    } catch (err) {
      const writer = new PackStreamWriter()
      socket.write(writer.writeFailure(
        'Neo.ClientError.Statement.SyntaxError',
        err instanceof Error ? err.message : 'Unknown error',
      ))
    }
  }

  private handlePullAll(socket: net.Socket, session: BoltSession, _payload?: Buffer): void {
    if (!session.authenticated || !session.pendingQuery) {
      socket.write(new PackStreamWriter().writeFailure(
        'Neo.ClientError.Request.Invalid',
        session.authenticated ? 'No pending query' : 'Not authenticated',
      ))
      return
    }

    try {
      const cypher = session.pendingQuery
      const params = session.pendingParams ?? {}
      const result = this.executeQuery(cypher, params)

      // Clear pending state
      session.pendingQuery = null
      session.pendingParams = null

      const writer = new PackStreamWriter()
      const records = result.records ?? []

      // Send RECORD messages
      for (const record of records) {
        const fields = Array.isArray(record) ? record : [record]
        socket.write(writer.writeRecord(fields))
      }

      // Send SUCCESS with summary
      socket.write(writer.writeSuccess({
        t_last: 1,
        bookmarks: [],
        type: 'rw',
        stats: {
          nodes_created: 0,
          nodes_deleted: 0,
          relationships_created: 0,
          relationships_deleted: 0,
          properties_set: 0,
          labels_added: 0,
          labels_removed: 0,
          contains_updates: false,
          contains_system_updates: false,
        },
      }))
    } catch (err) {
      const writer = new PackStreamWriter()
      socket.write(writer.writeFailure(
        'Neo.ClientError.Statement.ExecutionFailed',
        err instanceof Error ? err.message : 'Execution failed',
      ))
    }
  }

  private handleReset(socket: net.Socket, session: BoltSession, _payload?: Buffer): void {
    session.pendingQuery = null
    session.pendingParams = null
    const writer = new PackStreamWriter()
    socket.write(writer.writeSuccess({}))
  }

  private handleGoodbye(socket: net.Socket, _session: BoltSession, _payload?: Buffer): void {
    socket.end()
  }

  private handleBegin(_socket: net.Socket, _session: BoltSession, _payload?: Buffer): void {
    // Simple mode — BEGIN is a no-op
    const writer = new PackStreamWriter()
    _socket.write(writer.writeSuccess({}))
  }

  private handleCommitRollback(_socket: net.Socket, _session: BoltSession, _payload?: Buffer): void {
    // Simple mode — COMMIT/ROLLBACK are no-ops
    const writer = new PackStreamWriter()
    _socket.write(writer.writeSuccess({}))
  }

  // ──────────────────────────────────────
  // PackStream Decoder (minimal)
  // ──────────────────────────────────────

  /**
   * Decode a single PackStream value starting at the given offset.
   * Returns { value, bytesRead } or null on end-of-stream.
   */
  private decodeValue(buf: Buffer, offset: number): { value: unknown; bytesRead: number } | null {
    if (offset >= buf.length) return null

    const marker = buf[offset]
    offset += 1

    // Null
    if (marker === 0xc0) return { value: null, bytesRead: 1 }
    // Bool
    if (marker === 0xc2) return { value: false, bytesRead: 1 }
    if (marker === 0xc3) return { value: true, bytesRead: 1 }
    // Float
    if (marker === 0xc1) {
      const val = buf.readDoubleBE(offset)
      return { value: val, bytesRead: 9 }
    }
    // Tiny int (0..127) or negative tiny int (0xf0..0xff with special handling)
    if (marker <= 0x7f) return { value: marker, bytesRead: 1 }
    // Tiny string (0x80..0x8f)
    if (marker >= 0x80 && marker <= 0x8f) {
      const len = marker & 0x0f
      return {
        value: buf.toString('utf8', offset, offset + len),
        bytesRead: 1 + len,
      }
    }
    // Tiny list (0x90..0x9f)
    if (marker >= 0x90 && marker <= 0x9f) {
      const len = marker & 0x0f
      const items: unknown[] = []
      let pos = offset
      for (let i = 0; i < len; i++) {
        const item = this.decodeValue(buf, pos)
        if (!item) break
        items.push(item.value)
        pos += item.bytesRead
      }
      return { value: items, bytesRead: pos - (offset - 1) }
    }
    // Tiny map (0xa0..0xaf)
    if (marker >= 0xa0 && marker <= 0xaf) {
      const len = marker & 0x0f
      const map: Record<string, unknown> = {}
      let pos = offset
      for (let i = 0; i < len; i++) {
        const key = this.decodeValue(buf, pos)
        if (!key) break
        pos += key.bytesRead
        const val = this.decodeValue(buf, pos)
        if (!val) break
        pos += val.bytesRead
        map[String(key.value)] = val.value
      }
      return { value: map, bytesRead: pos - (offset - 1) }
    }
    // Tiny struct (0xb0..0xbf)
    if (marker >= 0xb0 && marker <= 0xbf) {
      // Skip struct marker for now — decode fields as list
      const len = marker & 0x0f
      const fields: unknown[] = []
      let pos = offset
      for (let i = 0; i < len; i++) {
        const item = this.decodeValue(buf, pos)
        if (!item) break
        fields.push(item.value)
        pos += item.bytesRead
      }
      return { value: fields, bytesRead: pos - (offset - 1) }
    }

    // Int8
    if (marker === 0xc8) {
      return { value: buf.readInt8(offset), bytesRead: 2 }
    }
    // Int16
    if (marker === 0xc9) {
      return { value: buf.readInt16BE(offset), bytesRead: 3 }
    }
    // Int32
    if (marker === 0xca) {
      return { value: buf.readInt32BE(offset), bytesRead: 5 }
    }
    // Int64 — decode as number (may lose precision)
    if (marker === 0xcb) {
      return { value: Number(buf.readBigInt64BE(offset)), bytesRead: 9 }
    }

    // String8/16/32
    if (marker === 0xd0) {
      const len = buf[offset]
      return { value: buf.toString('utf8', offset + 1, offset + 1 + len), bytesRead: 2 + len }
    }
    if (marker === 0xd1) {
      const len = buf.readUInt16BE(offset)
      return { value: buf.toString('utf8', offset + 2, offset + 2 + len), bytesRead: 3 + len }
    }
    if (marker === 0xd2) {
      const len = buf.readUInt32BE(offset)
      return { value: buf.toString('utf8', offset + 4, offset + 4 + len), bytesRead: 5 + len }
    }

    // List8/16/32
    if (marker === 0xd4) {
      const len = buf[offset]
      return this.decodeListItems(buf, offset + 1, len)
    }
    if (marker === 0xd5) {
      const len = buf.readUInt16BE(offset)
      return this.decodeListItems(buf, offset + 2, len)
    }
    if (marker === 0xd6) {
      const len = buf.readUInt32BE(offset)
      return this.decodeListItems(buf, offset + 4, len)
    }

    // Map8/16/32
    if (marker === 0xd8) {
      const len = buf[offset]
      return this.decodeMapItems(buf, offset + 1, len)
    }
    if (marker === 0xd9) {
      const len = buf.readUInt16BE(offset)
      return this.decodeMapItems(buf, offset + 2, len)
    }
    if (marker === 0xda) {
      const len = buf.readUInt32BE(offset)
      return this.decodeMapItems(buf, offset + 4, len)
    }

    // Struct8/16
    if (marker === 0xdc) {
      const len = buf[offset]
      const items = this.decodeStruct(buf, offset + 1, len)
      return items
    }
    if (marker === 0xdd) {
      const len = buf.readUInt16BE(offset)
      return this.decodeStruct(buf, offset + 2, len)
    }

    // Fallback — null
    return { value: null, bytesRead: 1 }
  }

  private decodeListItems(buf: Buffer, offset: number, len: number): { value: unknown[]; bytesRead: number } {
    const items: unknown[] = []
    let pos = offset
    for (let i = 0; i < len; i++) {
      const item = this.decodeValue(buf, pos)
      if (!item) break
      items.push(item.value)
      pos += item.bytesRead
    }
    return { value: items, bytesRead: pos - offset + 1 } // +1 for marker
  }

  private decodeMapItems(buf: Buffer, offset: number, len: number): { value: Record<string, unknown>; bytesRead: number } {
    const map: Record<string, unknown> = {}
    let pos = offset
    for (let i = 0; i < len; i++) {
      const key = this.decodeValue(buf, pos)
      if (!key) break
      pos += key.bytesRead
      const val = this.decodeValue(buf, pos)
      if (!val) break
      pos += val.bytesRead
      map[String(key.value)] = val.value
    }
    return { value: map, bytesRead: pos - offset + 1 }
  }

  private decodeStruct(buf: Buffer, offset: number, len: number): { value: unknown[]; bytesRead: number } | null {
    const fields: unknown[] = []
    let pos = offset
    for (let i = 0; i < len; i++) {
      const item = this.decodeValue(buf, pos)
      if (!item) break
      fields.push(item.value)
      pos += item.bytesRead
    }
    // First byte was the struct tag (sig), so include it
    return { value: fields, bytesRead: pos - offset + 2 } // +2 for marker+size
  }
}

// ──────────────────────────────────────────
// Factory
// ──────────────────────────────────────────

/**
 * Create a Bolt server instance.
 */
export function createBoltServer(
  executeQuery: CypherQueryExecutor,
  config?: Partial<BoltServerConfig>,
): BoltServerInstance {
  const server = new BoltServer(executeQuery, config)
  return {
    start: () => server.start(),
    stop: () => server.stop(),
    getPort: () => server.getPort(),
    getConnections: () => server.getConnections(),
  }
}
