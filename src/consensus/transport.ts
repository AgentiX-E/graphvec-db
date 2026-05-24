/**
 * transport.ts — Transport 接口层
 *
 * 定义 Raft 协议核心 RPC 和传输抽象。
 * 实现可选用：内存 MockTransport（测试）、TCP、gRPC 等。
 */
import { LogEntry } from './wal'
import * as net from 'node:net'
import * as os from 'node:os'

// ─── Raft Message Types ──────────────────────────────────────

export type RaftMessageType =
  | 'AppendEntries'
  | 'RequestVote'
  | 'AppendEntriesResponse'
  | 'RequestVoteResponse'
  | 'InstallSnapshot'
  | 'InstallSnapshotResponse'
  | 'PreVote'
  | 'PreVoteResponse'
  | 'MembershipChange'

export interface RaftMessage {
  type: RaftMessageType
  term: number
  from: string
  to: string
  data: unknown
}

// ─── RPC Request / Response Types ────────────────────────────

export interface AppendEntriesRequest {
  term: number
  leaderId: string
  prevLogIndex: number
  prevLogTerm: number
  entries: LogEntry[]
  leaderCommit: number
}

export interface AppendEntriesResponse {
  term: number
  success: boolean
  lastLogIndex: number
  /** 如果 success=false，返回引起冲突的 term（Raft 论文 §5.3 优化） */
  conflictingTerm?: number
  /** 如果 success=false，返回 conflictingTerm 的第一条 log index */
  conflictingIndex?: number
}

export interface RequestVoteRequest {
  term: number
  candidateId: string
  lastLogIndex: number
  lastLogTerm: number
}

export interface RequestVoteResponse {
  term: number
  voteGranted: boolean
}

export interface InstallSnapshotRequest {
  term: number
  leaderId: string
  lastIncludedIndex: number
  lastIncludedTerm: number
  data: Uint8Array
  done: boolean
}

export interface InstallSnapshotResponse {
  term: number
  success: boolean
}

// ─── Transport Interface ─────────────────────────────────────

export interface Transport {
  /** 发送 AppendEntries RPC */
  appendEntries?(to: string, entries: AppendEntriesRequest): Promise<AppendEntriesResponse>
  /** 发送 RequestVote RPC */
  requestVote?(to: string, req: RequestVoteRequest): Promise<RequestVoteResponse>
  /** 发送 PreVote RPC */
  preVote?(to: string, req: RequestVoteRequest): Promise<RequestVoteResponse>
  /** 发送 InstallSnapshot RPC */
  installSnapshot?(to: string, snapshot: InstallSnapshotRequest): Promise<InstallSnapshotResponse>
  /** 启动传输层 */
  start(): Promise<void>
  /** 停止传输层 */
  stop(): Promise<void>
  /** 设置消息处理器 */
  onMessage(handler: (from: string, msg: RaftMessage) => void): void
}

// ─── MockTransport (测试用) ─────────────────────────────────

/**
 * MockTransport — 内存同步消息传递的 Transport 实现
 *
 * 请求-响应模式：
 *   1. 发起方调用 appendEntries(to, req)
 *   2. MockTransport 将 AppendEntries 消息投递给目标节点的 onMessage
 *   3. 目标节点 RaftCore 的 _handleMessage 处理请求
 *   4. RaftCore 调用 MockTransport.sendResponse 发送响应
 *   5. sendResponse 查找发起方节点注册的 pending response 回调并 resolve
 */

interface PendingResponse {
  from: string
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timeout: NodeJS.Timeout
}

interface NodeHandlers {
  onMessage?: (from: string, msg: RaftMessage) => void
  pendingResponses: PendingResponse[]
}

const globalRegistry: Map<string, NodeHandlers> = new Map()

export class MockTransport implements Transport {
  private nodeId: string
  private handler: ((from: string, msg: RaftMessage) => void) | null = null
  private _started = false

  constructor(nodeId?: string) {
    this.nodeId = nodeId || 'mock-transport'
  }

  setNodeId(id: string): void {
    this.nodeId = id
  }

  onMessage(handler: (from: string, msg: RaftMessage) => void): void {
    this.handler = handler
  }

  async start(): Promise<void> {
    if (this._started) return
    this._started = true
    const entry: NodeHandlers = {
      onMessage: (from: string, msg: RaftMessage) => {
        if (this.handler) {
          this.handler(from, msg)
        }
      },
      pendingResponses: [],
    }
    globalRegistry.set(this.nodeId, entry)
  }

  async stop(): Promise<void> {
    this._started = false
    // Clean up any pending responses
    const entry = globalRegistry.get(this.nodeId)
    if (entry) {
      for (const p of entry.pendingResponses) {
        clearTimeout(p.timeout)
        p.reject(new Error('Transport stopped'))
      }
    }
    globalRegistry.delete(this.nodeId)
    this.handler = null
  }

  /**
   * 发送响应消息到指定节点
   * 将响应投递给发起方节点注册的 pending response 回调
   */
  static sendResponse(to: string, from: string, msg: RaftMessage): void {
    setImmediate(() => {
      const entry = globalRegistry.get(to)
      if (!entry) return

      // Check pending response handlers
      const pendingIdx = entry.pendingResponses.findIndex(
        p => p.from === from &&
          (p.from === msg.from || msg.from === from)
      )

      if (pendingIdx >= 0) {
        const pending = entry.pendingResponses[pendingIdx]
        clearTimeout(pending.timeout)
        entry.pendingResponses.splice(pendingIdx, 1)
        pending.resolve(msg.data)
      } else {
        // If no pending handler, deliver as a normal message
        if (entry.onMessage) {
          entry.onMessage(from, msg)
        }
      }
    })
  }

  /**
   * AppendEntries RPC
   */
  async appendEntries(to: string, req: AppendEntriesRequest): Promise<AppendEntriesResponse> {
    return this._sendInternal(to, req, 'AppendEntries', 'AppendEntriesResponse') as Promise<AppendEntriesResponse>
  }

  /**
   * RequestVote RPC
   */
  async requestVote(to: string, req: RequestVoteRequest): Promise<RequestVoteResponse> {
    return this._sendInternal(to, req, 'RequestVote', 'RequestVoteResponse') as Promise<RequestVoteResponse>
  }

  /**
   * PreVote RPC
   */
  async preVote(to: string, req: RequestVoteRequest): Promise<RequestVoteResponse> {
    return this._sendInternal(to, req, 'PreVote', 'PreVoteResponse') as Promise<RequestVoteResponse>
  }

  async installSnapshot(to: string, snapshot: InstallSnapshotRequest): Promise<InstallSnapshotResponse> {
    return { term: snapshot.term, success: true }
  }

  /**
   * 通用 RPC 发送
   */
  private _sendInternal(
    to: string,
    data: unknown,
    requestType: RaftMessageType,
    responseType: RaftMessageType,
  ): Promise<unknown> {
    const responseFullType = responseType === 'AppendEntriesResponse'
      ? 'AppendEntriesResponse'
      : 'RequestVoteResponse'

    return new Promise<unknown>((resolve, reject) => {
      // Register pending response
      const entry = globalRegistry.get(this.nodeId)
      if (!entry) {
        resolve(this._defaultResponse(responseFullType))
        return
      }

      const timeout = setTimeout(() => {
        const idx = entry.pendingResponses.findIndex(p => p.from === to)
        if (idx >= 0) {
          entry.pendingResponses.splice(idx, 1)
          resolve(this._defaultResponse(responseFullType))
        }
      }, 5000)

      entry.pendingResponses.push({
        from: to,
        resolve,
        reject,
        timeout,
      })

      // Deliver request message
      const targetEntry = globalRegistry.get(to)
      if (targetEntry && targetEntry.onMessage) {
        setImmediate(() => {
          targetEntry.onMessage!(this.nodeId, {
            type: requestType,
            term: (data as any).term,
            from: this.nodeId,
            to,
            data,
          })
        })
      } else {
        // Target not found, resolve with default
        const idx = entry.pendingResponses.findIndex(p => p.from === to)
        if (idx >= 0) {
          clearTimeout(entry.pendingResponses[idx].timeout)
          entry.pendingResponses.splice(idx, 1)
          resolve(this._defaultResponse(responseFullType))
        }
      }
    })
  }

  private _defaultResponse(type: string): unknown {
    if (type === 'AppendEntriesResponse') {
      return { term: 0, success: false, lastLogIndex: 0 } as AppendEntriesResponse
    }
    if (type === 'PreVoteResponse') {
      return { term: 0, voteGranted: false } as RequestVoteResponse
    }
    return { term: 0, voteGranted: false } as RequestVoteResponse
  }

  /** 获取已注册节点数量 */
  static get registeredCount(): number {
    return globalRegistry.size
  }

  /** 获取指定节点的注册条目（导出给测试用） */
  static getRegistryEntry(nodeId: string): NodeHandlers | undefined {
    return globalRegistry.get(nodeId)
  }

  /** 重置全局注册表 */
  static reset(): void {
    globalRegistry.clear()
  }
}

// ─── TcpTransport ──────────────────────────────────────────────

/** JSON 帧格式：{"from":"node-1","data":"...base64...","type":"raft"} */
interface TcpFrame {
  from: string
  data: string // base64-encoded Uint8Array
  type?: string
}

/** 全局 TCP 端口注册表（用于测试和集群管理等场景） */
/** 全局 TCP 端口 Map（按命名空间隔离，测试用随机 ns 避免并行冲突） */
const globalTcpPorts: Map<string, number> = new Map()
let _portNamespace = 'default'

/**
 * TcpTransport — 生产环境 TCP 传输层
 *
 * 使用 Node.js 内置 `net` 模块，零外部依赖。
 * 消息协议：4-byte big-endian length prefix + UTF-8 JSON。
 */
export class TcpTransport {
  private nodeId: string
  private port: number
  private handler: ((from: string, msg: Uint8Array) => void) | null = null
  private server: net.Server | null = null
  private connections: Map<string, net.Socket> = new Map()
  private peerAddresses: Map<string, string> = new Map()
  private listenAddress: string = ''
  private _ns: string = 'default'

  constructor(nodeId?: string, port?: number) {
    this.nodeId = nodeId || `tcp-${process.pid}`
    this.port = port ?? 0
  }

  /** 设置命名空间（测试隔离），构造后立即调用 */
  setNamespace(ns: string): void {
    this._ns = ns
  }

  setNodeId(id: string): void {
    this.nodeId = id
  }

  setMessageHandler(handler: (from: string, msg: Uint8Array) => void): void {
    this.handler = handler
  }

  connectTo(peerAddress: string): boolean {
    const parts = peerAddress.split(':')
    if (parts.length < 2) return false

    let peerId: string
    let host = ''
    let port = 0

    if (parts.length >= 3) {
      peerId = parts[0]
      host = parts[1]
      port = parseInt(parts[2], 10)
    } else {
      host = parts[0]
      port = parseInt(parts[1], 10)
      peerId = `${host}:${port}`
    }

    if (isNaN(port)) return false
    this.peerAddresses.set(peerId, `${host}:${port}`)
    this._connectToPeer(peerId, host, port, 1)
    return true
  }

  sendTo(peerId: string, msg: Uint8Array): boolean {
    const socket = this.connections.get(peerId)
    if (!socket || socket.destroyed || !socket.writable) {
      const addr = this.peerAddresses.get(peerId)
      if (addr) {
        const [host, portStr] = addr.split(':')
        const p = parseInt(portStr, 10)
        if (!isNaN(p)) {
          this._connectToPeer(peerId, host, p, 1)
        }
      }
      return false
    }
    try {
      this._writeFrame(socket, msg)
      return true
    } catch {
      return false
    }
  }

  broadcast(msg: Uint8Array): void {
    for (const peerId of this.connections.keys()) {
      this.sendTo(peerId, msg)
    }
  }

  start(): void {
    if (this.server) return
    this.server = net.createServer((socket) => {
      this._handleConnection(socket)
    })
    this.server.listen(this.port)
    const addr = this.server.address()
    if (addr && typeof addr === 'object') {
      this.port = addr.port
    }
    this.listenAddress = `${this._getLocalIp()}:${this.port}`
    globalTcpPorts.set(`${this._ns}:${this.nodeId}`, this.port)
  }

  stop(): void {
    for (const [, socket] of this.connections) {
      socket.destroy()
    }
    this.connections.clear()
    this.peerAddresses.clear()
    if (this.server) {
      this.server.close()
      this.server = null
    }
    globalTcpPorts.delete(`${this._ns}:${this.nodeId}`)
  }

  static register(port: number): void {
    process.env.TCP_TRANSPORT_PORT = String(port)
  }

  static reset(): void {
    globalTcpPorts.clear()
  }

  getPort(): number {
    return this.port
  }

  getListenAddress(): string {
    return this.listenAddress
  }

  private _writeFrame(socket: net.Socket, msg: Uint8Array): void {
    const base64Data = Buffer.from(msg).toString('base64')
    const frame: TcpFrame = { from: this.nodeId, data: base64Data, type: 'raft' }
    const json = JSON.stringify(frame)
    const jsonBuf = Buffer.from(json, 'utf-8')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(jsonBuf.length, 0)
    socket.write(Buffer.concat([header, jsonBuf]))
  }

  private _handleConnection(socket: net.Socket): void {
    socket.setKeepAlive(true, 5000)
    let buffer = Buffer.alloc(0)

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4) {
        const frameLen = buffer.readUInt32BE(0)
        const totalLen = 4 + frameLen
        if (buffer.length < totalLen) break
        const frameJson = buffer.subarray(4, totalLen).toString('utf-8')
        buffer = buffer.subarray(totalLen)
        try {
          const frame: TcpFrame = JSON.parse(frameJson)
          if (frame.from && frame.data) {
            this.handler?.(frame.from, Buffer.from(frame.data, 'base64'))
          }
        } catch { /* ignore */ }
      }
    })

    socket.on('close', () => {
      for (const [peerId, s] of this.connections) {
        if (s === socket) { this.connections.delete(peerId); break }
      }
    })
    socket.on('error', () => socket.destroy())
  }

  private _connectToPeer(peerId: string, host: string, port: number, attempt: number): void {
    if (this.connections.has(peerId)) return
    const socket = new net.Socket()
    const cleanup = () => { this.connections.delete(peerId) }
    socket.on('connect', () => {
      socket.setKeepAlive(true, 5000)
      this.connections.set(peerId, socket)
    })
    socket.on('close', cleanup)
    socket.on('error', () => { cleanup(); socket.destroy() })
    const maxAttempts = 3
    socket.connect(port, host, () => { this._handleConnection(socket) })
    socket.on('error', () => {
      if (attempt < maxAttempts) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 4000)
        setTimeout(() => this._connectToPeer(peerId, host, port, attempt + 1), delay)
      }
    })
  }

  private _getLocalIp(): string {
    const interfaces = os.networkInterfaces()
    for (const name of Object.keys(interfaces)) {
      const ifaces = interfaces[name]
      if (!ifaces) continue
      for (const iface of ifaces) {
        if (iface.family === 'IPv4' && !iface.internal) return iface.address
      }
    }
    return '127.0.0.1'
  }
}
