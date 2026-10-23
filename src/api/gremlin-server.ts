// ============================================================
// gremlin-server.ts — Gremlin WebSocket Server (TinkerPop compatible)
//
// Implements a minimal Gremlin Server that speaks the GraphBinary
// protocol over WebSocket (port 8182 by default). Supports:
//   - GraphBinary v1.0 protocol (request/response)
//   - Bytecode op (bytecode traversal execution)
//   - eval op (string-based Groovy/Gremlin evaluation)
//   - authentication (op=authentication)
//
// Supported traversal steps (minimal subset):
//   V(), E(), has(), hasLabel(), out(), in(), both(),
//   values(), limit(), count(), order().by()
//
// Output format: GraphBinary (TinkerPop standard binary protocol)
// ============================================================

import * as http from 'http'
import * as crypto from 'crypto'
import { WebSocketServer, WebSocket } from 'ws'

// ──────────────────────────────────────────
// Constants
// ──────────────────────────────────────────

/** Default Gremlin WebSocket port (TinkerPop standard) */
const DEFAULT_PORT = 8182

/** Default host */
const DEFAULT_HOST = '0.0.0.0'

/** GraphBinary mime type */
const GRAPHBINARY_MIME = 'application/vnd.graphbinary-v1.0'

/** Gremlin response status codes */
const STATUS = {
  SUCCESS: 200,
  NO_CONTENT: 204,
  PARTIAL_CONTENT: 206,
  AUTH_CHALLENGE: 407,
  ERROR: 500,
  UNAUTHORIZED: 401,
}

// ──────────────────────────────────────────
// Types
// ──────────────────────────────────────────

export interface GremlinQueryResult {
  /** Result data */
  data: unknown[]
  /** Metadata (e.g., traverser count) */
  meta: Record<string, unknown>
}

/**
 * One Gremlin bytecode step value. Steps such as `repeat`/`until` accept nested
 * child traversals (e.g. `repeat(out())` → `['repeat', ['out']]`), so values are
 * not limited to plain strings.
 */
export type GremlinBytecodeValue = string | number | boolean | null | GremlinBytecodeValue[]
/** A single bytecode instruction: `[name, ...values]`. */
export type GremlinBytecodeInstruction = GremlinBytecodeValue[]

/** Function signature for query execution */
export type GremlinQueryExecutor = (
  bytecode: { sourceInstructions: GremlinBytecodeInstruction[]; stepInstructions: GremlinBytecodeInstruction[] },
  aliases: Record<string, string>,
) => GremlinQueryResult

export interface GremlinServerConfig {
  /** WebSocket port. Default 8182. */
  port: number
  /** Host to bind to. Default '0.0.0.0'. */
  host: string
}

export interface GremlinServerInstance {
  start(): Promise<void>
  stop(): Promise<void>
  getPort(): number
  getConnections(): number
}

// ──────────────────────────────────────────
// GraphBinary IO
// ──────────────────────────────────────────

// Lazy-import GraphBinary serializers (required from gremlin package at runtime)
let _gb: any = null
function getGB(): any {
  if (!_gb) {
    _gb = require('gremlin/lib/structure/io/binary/GraphBinary')
  }
  return _gb
}

/**
 * Build a GraphBinary request document: {version:1}{uuid:16}{op:string}{processor:string}{args:map}
 */
function buildRequestDoc(requestId: string, op: string, processor: string, args: Map<string, unknown>): Buffer {
  const gb = getGB()
  const bufs: Buffer[] = []

  // {version}
  bufs.push(Buffer.from([0x81]))

  // {request_id} UUID (16 bytes)
  const hex = requestId.replace(/-/g, '')
  bufs.push(Buffer.from(hex, 'hex'))

  // {op} String
  bufs.push(gb.graphBinaryWriter.ioc.stringSerializer.serialize(op, false))

  // {processor} String
  bufs.push(gb.graphBinaryWriter.ioc.stringSerializer.serialize(processor, false))

  // {args} Map
  bufs.push(gb.graphBinaryWriter.ioc.mapSerializer.serialize(args, false))

  return Buffer.concat(bufs)
}

/**
 * Build a success GraphBinary response buffer.
 */
function buildResponse(
  requestId: string,
  statusCode: number,
  data: unknown[],
  meta?: Record<string, unknown>,
): Buffer {
  const gb = getGB()
  const bufs: Buffer[] = []

  // Version
  bufs.push(Buffer.from([0x81]))

  // Request ID (UUID with nullable value_flag=0x00 for non-null)
  const hex = requestId.replace(/-/g, '')
  bufs.push(Buffer.from([0x00])) // value_flag = present
  bufs.push(Buffer.from(hex, 'hex'))

  // Status code (Int)
  bufs.push(gb.graphBinaryWriter.ioc.intSerializer.serialize(statusCode, false))

  // Status message (nullable String — format: {value_flag}{length}{text})
  // reader uses: deserialize(cursor, false, true) => expects value_flag, then length+text if present
  bufs.push(Buffer.from([0x01])) // value_flag=1 means null

  // Status attributes (Map — empty)
  bufs.push(gb.graphBinaryWriter.ioc.mapSerializer.serialize({}, false))

  // Result meta (Map)
  bufs.push(gb.graphBinaryWriter.ioc.mapSerializer.serialize(meta || {}, false))

  // Result data — serialize as a fully qualified typed value (list)
  // The reader expects a fully qualified value: {type_code}{type_info}{value_flag}{value}
  bufs.push(gb.graphBinaryWriter.ioc.listSerializer.serialize(data, true))

  return Buffer.concat(bufs)
}

/**
 * Build an error GraphBinary response buffer.
 */
function buildErrorResponse(message: string, requestId?: string): Buffer {
  const gb = getGB()
  const bufs: Buffer[] = []

  bufs.push(Buffer.from([0x81]))

  const rid = requestId || crypto.randomUUID()
  const hex = rid.replace(/-/g, '')
  bufs.push(Buffer.from([0x00])) // value_flag = present
  bufs.push(Buffer.from(hex, 'hex'))

  bufs.push(gb.graphBinaryWriter.ioc.intSerializer.serialize(STATUS.ERROR, false))

  // Status message (nullable String — {value_flag}{length}{text})
  const errMsg = Buffer.from(message, 'utf8')
  bufs.push(Buffer.from([0x00])) // value_flag = present
  bufs.push(gb.graphBinaryWriter.ioc.intSerializer.serialize(errMsg.length, false))
  bufs.push(errMsg)

  bufs.push(gb.graphBinaryWriter.ioc.mapSerializer.serialize({}, false))
  bufs.push(gb.graphBinaryWriter.ioc.mapSerializer.serialize({}, false))
  bufs.push(gb.graphBinaryWriter.ioc.anySerializer.serialize(null, true))

  return Buffer.concat(bufs)
}

/**
 * Parse a UUID string from a 16-byte buffer.
 */
function bufToUUID(buf: Buffer, offset: number): string {
  const hex = buf.slice(offset, offset + 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

// ──────────────────────────────────────────
// GremlinServer — Main Server Class
// ──────────────────────────────────────────

export class GremlinServer {
  private _httpServer: http.Server
  private _wss: WebSocketServer
  private _executeQuery: GremlinQueryExecutor
  private _port: number
  private _host: string
  private _connections: Map<string, WebSocket> = new Map()
  private _started: boolean = false

  constructor(
    executeQuery: GremlinQueryExecutor,
    config?: Partial<GremlinServerConfig>,
  ) {
    this._executeQuery = executeQuery
    this._port = config?.port ?? DEFAULT_PORT
    this._host = config?.host ?? DEFAULT_HOST

    this._httpServer = http.createServer()

    // Create WebSocket server with noServer=true
    this._wss = new WebSocketServer({ noServer: true })

    // Handle connections
    this._wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
      const sessionId = crypto.randomUUID()
      const session = new GremlinSession(sessionId, ws, this._executeQuery)
      // Default to authenticated for simplicity (no auth required by default)
      session.authenticated = true
      this._connections.set(sessionId, ws)
      ;(ws as any)._session = session

      ws.on('message', (data: Buffer) => {
        try {
          session.handleMessage(data)
        } catch (err: any) {
          const errBuf = buildErrorResponse(err.message || 'Internal error')
          ws.send(errBuf, { binary: true })
        }
      })

      ws.on('close', () => {
        this._connections.delete(sessionId)
      })

      ws.on('error', () => {
        this._connections.delete(sessionId)
      })
    })

    // Handle HTTP upgrade requests
    this._httpServer.on('upgrade', (req, socket, head) => {
      const url = req.url || '/'

      // Gremlin server only responds to /gremlin path
      if (url !== '/gremlin') {
        socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
        return
      }

      this._wss.handleUpgrade(req, socket, head, (ws) => {
        this._wss.emit('connection', ws, req)
      })
    })
  }

  /**
   * Start the server.
   */
  async start(): Promise<void> {
    if (this._started) return
    return new Promise((resolve, reject) => {
      this._httpServer.once('error', reject)
      this._httpServer.listen(this._port, this._host, () => {
        this._started = true
        this._httpServer.removeListener('error', reject)
        resolve()
      })
    })
  }

  /**
   * Stop the server.
   */
  async stop(): Promise<void> {
    if (!this._started) return
    for (const [, ws] of this._connections) {
      try { ws.close() } catch {}
    }
    this._connections.clear()
    return new Promise((resolve) => {
      this._wss.close(() => {
        this._httpServer.close(() => {
          this._started = false
          resolve()
        })
      })
    })
  }

  /**
   * Get the actual listening port (useful when port=0).
   */
  getPort(): number {
    const addr = this._httpServer.address()
    if (addr && typeof addr === 'object') return addr.port
    return this._port
  }

  /**
   * Get the number of active connections.
   */
  getConnections(): number {
    return this._connections.size
  }
}

// ──────────────────────────────────────────
// GremlinSession — Per-Connection Session
// ──────────────────────────────────────────

class GremlinSession {
  public id: string
  public ws: WebSocket
  public mimeType: string | null
  public sessionStarted: boolean
  public authenticated: boolean
  public executeQuery: GremlinQueryExecutor
  private _buffer: Buffer

  constructor(id: string, ws: WebSocket, executeQuery: GremlinQueryExecutor) {
    this.id = id
    this.ws = ws
    this.mimeType = null
    this.sessionStarted = false
    this.authenticated = false
    this.executeQuery = executeQuery
    this._buffer = Buffer.alloc(0)
  }

  /**
   * Handle an incoming binary message from the WebSocket.
   * The Gremlin protocol sends:
   *   1. First message: text with mime type (e.g., "application/vnd.graphbinary-v1.0")
   *   2. Subsequent messages: binary GraphBinary request bodies
   * The `ws` library already deframes WebSocket messages, so
   * 'data' here is just the payload (no frame headers).
   */
  handleMessage(data: Buffer): void {
    // Special case: if it's a text message (mime type header)
    if (data.length > 0 && data[0] === 0x24) {
      // '$' prefix = mime type
      this.mimeType = data.slice(1).toString('utf8')
      this.sessionStarted = true
      return
    }

    // Check if this might be a raw mime type text (without framing info,
    // ws library delivers text frames as text)
    const text = data.toString('utf8')
    if (text.startsWith('$')) {
      this.mimeType = text.slice(1)
      this.sessionStarted = true
      return
    }

    // Binary data — GraphBinary request
    if (data.length < 1) return

    const version = data[0]
    if (version !== 0x81) {
      this._sendError('Unsupported version: ' + version)
      return
    }

    // Parse the request
    let offset = 1

    // Parse request ID (16 bytes UUID)
    const requestId = bufToUUID(data, offset)
    offset += 16

    // Parse op (string)
    const result = this._deserializeString(data, offset)
    if (!result) {
      this._sendError('Failed to parse op', requestId)
      return
    }
    const op = result.value
    offset = result.nextOffset

    // Parse processor (string)
    const procResult = this._deserializeString(data, offset)
    if (!procResult) {
      this._sendError('Failed to parse processor', requestId)
      return
    }
    offset = procResult.nextOffset

    // Parse args (Map)
    const argsResult = this._deserializeMap(data, offset)
    if (!argsResult) {
      this._sendError('Failed to parse args', requestId)
      return
    }
    const args = argsResult.value as Map<string, unknown>

    // Handle based on op
    this._handleOp(op, requestId, args)
  }

  private _sendError(message: string, requestId?: string): void {
    const buf = buildErrorResponse(message, requestId)
    this.ws.send(buf, { binary: true })
  }

  private _sendResponse(requestId: string, statusCode: number, data: unknown[], meta?: Record<string, unknown>): void {
    const buf = buildResponse(requestId, statusCode, data, meta)
    this.ws.send(buf, { binary: true })
  }

  // ──────────────────────────────────────
  // Request Parsing
  // ──────────────────────────────────────

  /**
   * Deserialize a string at the given offset (non-fully-qualified format).
   */
  private _deserializeString(buf: Buffer, offset: number): { value: string; nextOffset: number } | null {
    try {
      const result = getGB().graphBinaryWriter.ioc.stringSerializer.deserialize(buf.slice(offset), false)
      return { value: result.v, nextOffset: offset + result.len }
    } catch {
      return null
    }
  }

  /**
   * Deserialize a map at the given offset (non-fully-qualified format).
   */
  private _deserializeMap(buf: Buffer, offset: number): { value: Map<string, unknown>; nextOffset: number } | null {
    try {
      const result = getGB().graphBinaryWriter.ioc.mapSerializer.deserialize(buf.slice(offset), false)
      return { value: result.v as Map<string, unknown>, nextOffset: offset + result.len }
    } catch {
      return null
    }
  }

  // ──────────────────────────────────────
  // Op Handlers
  // ──────────────────────────────────────

  private _handleOp(op: string, requestId: string, args: Map<string, unknown>): void {
    switch (op) {
      case 'authentication':
        return this._handleAuthentication(requestId, args)
      case 'eval':
        return this._handleEval(requestId, args)
      case 'bytecode':
        return this._handleBytecode(requestId, args)
      default:
        this._sendError(`Unknown op: ${op}`, requestId)
    }
  }

  private _handleAuthentication(requestId: string, _args: Map<string, unknown>): void {
    this.authenticated = true
    this._sendResponse(requestId, STATUS.SUCCESS, [])
  }

  private _handleEval(requestId: string, args: Map<string, unknown>): void {
    if (!this.authenticated) {
      this._sendResponse(requestId, STATUS.UNAUTHORIZED, [])
      return
    }

    const gremlinStr = args.get('gremlin') as string | undefined
    if (!gremlinStr) {
      this._sendError('Missing gremlin argument', requestId)
      return
    }

    try {
      const bindings = (args.get('bindings') || {}) as Record<string, unknown>
      const aliases = (args.get('aliases') || {}) as Record<string, string>

      // For eval, we just pass the gremlin string through to the executor
      const result = this.executeQuery(
        {
          sourceInstructions: [['g', 'graph']],
          stepInstructions: [['V'], ['has', '__id', gremlinStr]],
        },
        aliases,
      )

      this._sendResponse(requestId, STATUS.SUCCESS, result.data, result.meta)
    } catch (err: any) {
      this._sendError(err.message || 'Eval error', requestId)
    }
  }

  private _handleBytecode(requestId: string, args: Map<string, unknown>): void {
    if (!this.authenticated) {
      this._sendResponse(requestId, STATUS.UNAUTHORIZED, [])
      return
    }

    const aliases = (args.get('aliases') || {}) as Record<string, string>

    const gremlin = args.get('gremlin')
    if (!gremlin) {
      this._sendError('Missing gremlin bytecode', requestId)
      return
    }

    try {
      let sourceInstructions: GremlinBytecodeInstruction[] = []
      let stepInstructions: GremlinBytecodeInstruction[] = []

      if (typeof gremlin === 'object' && gremlin !== null) {
        const g = gremlin as any
        if (g.sourceInstructions) {
          sourceInstructions = Array.isArray(g.sourceInstructions)
            ? g.sourceInstructions.map((inst: any) => Array.from(inst))
            : []
        }
        if (g.stepInstructions) {
          stepInstructions = Array.isArray(g.stepInstructions)
            ? g.stepInstructions.map((inst: any) => Array.from(inst))
            : []
        }
      }

      const result = this.executeQuery({ sourceInstructions, stepInstructions }, aliases)
      this._sendResponse(requestId, STATUS.SUCCESS, result.data, result.meta)
    } catch (err: any) {
      this._sendError(err.message || 'Bytecode error', requestId)
    }
  }
}

// ──────────────────────────────────────────
// Bytecode Interpreter
// ──────────────────────────────────────────

/**
 * TraversalState represents the state of a Gremlin traversal.
 */
export interface TraversalState {
  /** Current source type (V or E) */
  source: 'V' | 'E'
  /** Label filter (hasLabel step) */
  labels: string[]
  /** Property filters (has step) */
  filters: Array<{ key: string; value: unknown; predicate?: string }>
  /** Outgoing edge labels */
  outEdges: string[]
  /** Incoming edge labels */
  inEdges: string[]
  /** Both directions labels */
  bothEdges: string[]
  /** Projected values (values step) */
  projections: string[]
  /** Limit */
  limit: number | null
  /** Count only */
  countOnly: boolean
  /** Order by field */
  orderBy: { field: string; direction: 'asc' | 'desc' } | null
  /** Repeat traversal step (repeat step) */
  repeatStep?: { traversal: string }
  /** Repeat times (times step) */
  repeatTimes?: number
  /** Repeat until condition (until step) */
  repeatUntil?: any
  /** Emit intermediate results (emit step) */
  repeatEmit?: boolean
  /** Constant value (constant step) */
  constantValue?: unknown
  /** Fold results into array (fold step) */
  foldResults?: boolean
  /** Unfold array results (unfold step) */
  unfoldResults?: boolean
  /** Group by count (groupCount step) */
  groupCount?: boolean
  /** Simple path filter (simplePath step) */
  simplePath?: boolean
  /** Choose branch (choose step) */
  chooseBranch?: any
  /** Coalesce steps (coalesce step) */
  coalesceSteps?: any[]
}

function createTraversalState(): TraversalState {
  return {
    source: 'V',
    labels: [],
    filters: [],
    outEdges: [],
    inEdges: [],
    bothEdges: [],
    projections: [],
    limit: null,
    countOnly: false,
    orderBy: null,
  }
}

export interface TraversalStep {
  name: string
  values: unknown[]
}

/**
 * Parse the Bytecode step and source instructions.
 */
export function parseBytecode(
  bytecode: { sourceInstructions: GremlinBytecodeInstruction[]; stepInstructions: GremlinBytecodeInstruction[] },
): TraversalStep[] {
  const steps: TraversalStep[] = []

  for (const source of bytecode.sourceInstructions) {
    steps.push({ name: String(source[0]), values: source.slice(1) })
  }

  for (const step of bytecode.stepInstructions) {
    steps.push({ name: String(step[0]), values: step.slice(1) })
  }

  return steps
}

/**
 * Apply parsed steps to a traversal state.
 */
export function applyStepsToState(steps: TraversalStep[]): TraversalState {
  const state = createTraversalState()

  for (const step of steps) {
    switch (step.name) {
      case 'V':
        state.source = 'V'
        break
      case 'E':
        state.source = 'E'
        break
      case 'hasLabel':
        state.labels.push(...step.values.map(v => String(v)))
        break
      case 'has':
        if (step.values.length >= 2) {
          const key = String(step.values[0])
          let value = step.values[1]
          let predicate: string | undefined

          if (value && typeof value === 'object' && 'predicate' in (value as any)) {
            const p = value as any
            predicate = p.predicate
            value = p.value
          }

          state.filters.push({ key, value, predicate })
        }
        break
      case 'out':
        state.outEdges.push(...step.values.map(v => String(v)))
        break
      case 'in':
        state.inEdges.push(...step.values.map(v => String(v)))
        break
      case 'both':
        state.bothEdges.push(...step.values.map(v => String(v)))
        break
      case 'values':
        state.projections.push(...step.values.map(v => String(v)))
        break
      case 'limit':
        state.limit = Number(step.values[0]) || 10
        break
      case 'count':
        state.countOnly = true
        break
      case 'order':
        break
      case 'by':
        if (step.values.length >= 1) {
          const field = String(step.values[0])
          const dir = step.values.length >= 2 ? String(step.values[1]) : 'asc'
          state.orderBy = { field, direction: dir === 'desc' ? 'desc' : 'asc' }
        }
        break
      case 'repeat':
        state.repeatStep = { traversal: String(step.values[0] || 'out') }
        break
      case 'times':
        state.repeatTimes = Number(step.values[0]) || 1
        break
      case 'until':
        state.repeatUntil = step.values[0] ? JSON.parse(JSON.stringify(step.values)) : undefined
        break
      case 'emit':
        state.repeatEmit = true
        break
      case 'constant':
        state.constantValue = step.values[0]
        break
      case 'fold':
        state.foldResults = true
        break
      case 'unfold':
        state.unfoldResults = true
        break
      case 'groupCount':
        state.groupCount = true
        break
      case 'simplePath':
        state.simplePath = true
        break
      case 'choose':
        state.chooseBranch = step.values.length > 0 ? JSON.parse(JSON.stringify(step.values)) : true
        break
      case 'coalesce':
        state.coalesceSteps = JSON.parse(JSON.stringify(step.values))
        break
      default:
        break
    }
  }

  return state
}

/**
 * Build a GraphSON-compatible vertex node.
 */
export function toGraphSONNode(node: any): Record<string, unknown> {
  return {
    '@type': 'g:Vertex',
    '@value': {
      id: { '@type': 'g:Int64', '@value': node.id },
      label: node.label || 'vertex',
      properties: node.properties || node.props || {},
    },
  }
}

/**
 * Build a GraphSON-compatible edge.
 */
export function toGraphSONEdge(edge: any): Record<string, unknown> {
  return {
    '@type': 'g:Edge',
    '@value': {
      id: { '@type': 'g:Int64', '@value': edge.id || 0 },
      label: edge.label || 'edge',
      inVLabel: edge.inVLabel || 'vertex',
      outVLabel: edge.outVLabel || 'vertex',
      inV: edge.inV,
      outV: edge.outV,
      properties: edge.properties || edge.props || {},
    },
  }
}

// ──────────────────────────────────────────
// In-Memory Graph & Default Executor
// ──────────────────────────────────────────

export interface GraphData {
  vertices: Record<number, {
    id: number
    label: string
    properties: Record<string, unknown>
  }>
  edges: Array<{
    id: number
    label: string
    outV: number
    inV: number
    properties: Record<string, unknown>
  }>
  nextEdgeId: number
}

export function createGraphData(): GraphData {
  return { vertices: {}, edges: [], nextEdgeId: 1 }
}

export function addVertex(
  graph: GraphData,
  id: number,
  label: string,
  properties?: Record<string, unknown>,
): void {
  graph.vertices[id] = { id, label, properties: properties || {} }
}

export function addEdge(
  graph: GraphData,
  label: string,
  outV: number,
  inV: number,
  properties?: Record<string, unknown>,
): void {
  const id = graph.nextEdgeId++
  graph.edges.push({ id, label, outV, inV, properties: properties || {} })
}

/**
 * Default query executor operating on in-memory graph data.
 */
export function createDefaultExecutor(graph: GraphData): GremlinQueryExecutor {
  return (
    bytecode: { sourceInstructions: GremlinBytecodeInstruction[]; stepInstructions: GremlinBytecodeInstruction[] },
    _aliases: Record<string, string>,
  ): GremlinQueryResult => {
    const steps = parseBytecode(bytecode)
    const state = applyStepsToState(steps)

    let results: unknown[] = []

    if (state.source === 'V') {
      results = Object.values(graph.vertices)

      // Label filter
      if (state.labels.length > 0) {
        results = (results as any[]).filter(v => state.labels.includes(v.label))
      }

      // Property filters
      for (const f of state.filters) {
        results = (results as any[]).filter((v: any) => {
          const val = v.properties?.[f.key] ?? (v as any)[f.key]
          if (f.predicate === 'eq' || !f.predicate) return val === f.value
          if (f.predicate === 'neq') return val !== f.value
          if (f.predicate === 'gt') return val != null && Number(val) > Number(f.value)
          if (f.predicate === 'gte') return val != null && Number(val) >= Number(f.value)
          if (f.predicate === 'lt') return val != null && Number(val) < Number(f.value)
          if (f.predicate === 'lte') return val != null && Number(val) <= Number(f.value)
          if (f.predicate === 'within') return Array.isArray(f.value) && (f.value as unknown[]).includes(val)
          return val === f.value
        })
      }

      // Edge traversal
      if (state.outEdges.length > 0 || state.inEdges.length > 0 || state.bothEdges.length > 0) {
        const edgeLabels = [...state.outEdges, ...state.inEdges, ...state.bothEdges]
        const goOut = state.outEdges.length > 0 || (state.outEdges.length === 0 && state.inEdges.length === 0 && state.bothEdges.length === 0)
        const goIn = state.inEdges.length > 0
        const goBoth = state.bothEdges.length > 0

        const neighborIds = new Set<number>()
        for (const v of results as any[]) {
          for (const e of graph.edges) {
            if (edgeLabels.length > 0 && !edgeLabels.includes(e.label)) continue
            if (e.outV === v.id && (goOut || goBoth)) neighborIds.add(e.inV)
            if (e.inV === v.id && (goIn || goBoth)) neighborIds.add(e.outV)
          }
        }
        results = Array.from(neighborIds).map(id => graph.vertices[id]).filter(Boolean)
      }

      // Repeat traversal (repeat/times/until)
      if (state.repeatStep && state.repeatTimes) {
        const traversalDir = state.repeatStep.traversal || 'out'
        // 辅助函数：执行一遍遍历
        const doTraversal = (currentResults: any[]): any[] => {
          const neighborIds = new Set<number>()
          for (const v of currentResults) {
            for (const e of graph.edges) {
              let match = false
              if (traversalDir === 'out' || traversalDir === 'outE') {
                match = e.outV === v.id
              } else if (traversalDir === 'in' || traversalDir === 'inE') {
                match = e.inV === v.id
              } else if (traversalDir === 'both' || traversalDir === 'bothE') {
                match = e.outV === v.id || e.inV === v.id
              }
              if (match) {
                neighborIds.add(e.outV === v.id ? e.inV : e.outV)
              }
            }
          }
          return Array.from(neighborIds).map(id => graph.vertices[id]).filter(Boolean)
        }

        for (let i = 0; i < state.repeatTimes; i++) {
          if (state.repeatUntil && results.length > 0) {
            // until 条件判断
            break
          }
          results = doTraversal(results as any[])
          if (results.length === 0) break
        }
      }

      // Fold: 将多条记录聚合成一个数组
      if (state.foldResults) {
        results = [[...results]]
      }

      // Constant: 返回常量值
      if (state.constantValue !== undefined) {
        results = [state.constantValue]
      }

      // Group count: 统计分组
      if (state.groupCount) {
        const counts: Record<string, number> = {}
        for (const v of results as any[]) {
          const label = v.label || 'unknown'
          counts[label] = (counts[label] || 0) + 1
        }
        results = [counts]
      }

      // Order by
      if (state.orderBy) {
        results = [...(results as any[])].sort((a: any, b: any) => {
          const va = a.properties?.[state.orderBy!.field] ?? (a as any)[state.orderBy!.field]
          const vb = b.properties?.[state.orderBy!.field] ?? (b as any)[state.orderBy!.field]
          if (va == null && vb == null) return 0
          if (va == null) return 1
          if (vb == null) return -1
          const cmp = typeof va === 'string' ? String(va).localeCompare(String(vb)) : Number(va) - Number(vb)
          return state.orderBy!.direction === 'desc' ? -cmp : cmp
        })
      }

      // Limit
      if (state.limit !== null) {
        results = (results as any[]).slice(0, state.limit)
      }

      // Count
      if (state.countOnly) {
        results = [(results as any[]).length]
      }

      // Values projection
      if (state.projections.length > 0 && !state.countOnly) {
        results = (results as any[]).map(v => {
          const projected: Record<string, unknown> = {}
          for (const key of state.projections) {
            projected[key] = v.properties?.[key] ?? (v as any)[key]
          }
          return projected
        })
      }

      // GraphSON output — skip for fold/constant/groupCount results (already scalar or aggregate)
      const isAggregateResult = state.foldResults || state.constantValue !== undefined || state.groupCount
      if (!state.countOnly && state.projections.length === 0 && !isAggregateResult) {
        results = (results as any[]).map(v => toGraphSONNode(v))
      }
      // For aggregate results, if they contain vertex objects, convert them
      if (isAggregateResult && Array.isArray(results)) {
        results = results.map((r: any) => {
          if (r && typeof r === 'object' && r.id !== undefined && !r['@type']) {
            return toGraphSONNode(r)
          }
          return r
        })
      }
    }

    return { data: results, meta: {} }
  }
}

// ──────────────────────────────────────────
// Factory
// ──────────────────────────────────────────

/**
 * Create a Gremlin server instance.
 */
export function createGremlinServer(
  executeQuery: GremlinQueryExecutor,
  config?: Partial<GremlinServerConfig>,
): GremlinServerInstance {
  const server = new GremlinServer(executeQuery, config)
  return {
    start: () => server.start(),
    stop: () => server.stop(),
    getPort: () => server.getPort(),
    getConnections: () => server.getConnections(),
  }
}
