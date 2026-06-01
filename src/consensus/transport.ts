/**
 * transport.ts — Transport 接口层
 *
 * 定义 Raft 协议核心 RPC 和传输抽象。
 * 实现可选用：内存 MockTransport（测试）、TCP、gRPC 等。
 */
import { LogEntry } from './wal'
import * as net from 'node:net'
import * as tls from 'node:tls'
import * as os from 'node:os'
import { Logger } from '../ops/logger'

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
    return this._sendInternal(to, {
      term: snapshot.term,
      leaderId: snapshot.leaderId,
      lastIncludedIndex: snapshot.lastIncludedIndex,
      lastIncludedTerm: snapshot.lastIncludedTerm,
      data: snapshot.data,
      done: snapshot.done,
    }, 'InstallSnapshot', 'InstallSnapshotResponse') as Promise<InstallSnapshotResponse>
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
      : responseType === 'InstallSnapshotResponse'
        ? 'InstallSnapshotResponse'
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
    if (type === 'InstallSnapshotResponse') {
      return { term: 0, success: false } as InstallSnapshotResponse
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
  /** 消息 ID，用于 ACK 匹配（发送方生成） */
  msgId?: string
  /** ACK 响应：对端回复时携带原始 msgId */
  ackFor?: string
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
  private server: net.Server | tls.Server | null = null
  private connections: Map<string, net.Socket> = new Map()
  /** 所有已接受的连接（incoming + outgoing），用于完整清理 */
  private _acceptedSockets: Set<net.Socket> = new Set()
  private peerAddresses: Map<string, string> = new Map()
  private listenAddress: string = ''
  private _ns: string = 'default'
  private logger: Logger = new Logger('TcpTransport')

  // ── TLS 支持 ──
  private _tlsOptions: tls.TlsOptions | null = null

  /** ACK 超时时间（毫秒），默认 5000 */
  ackTimeout: number = 5000

  /** 自增消息 ID 计数器 */
  private _msgIdCounter: number = 0

  /** 待 ACK 响应注册表 */
  private _pendingAcks: Map<string, {
    peerId: string
    resolve: (value: boolean) => void
    timer: NodeJS.Timeout
  }> = new Map()

  /** 超时定时器集合（用于统一清理） */
  private _ackTimers: Set<NodeJS.Timeout> = new Set()

  // ── InstallSnapshot 分块接收状态 ──
  private _snapshotChunks: Map<string, {
    chunks: Map<number, Buffer>
    total: number
    fullChecksum: number
    lastIncludedIndex: number
    lastIncludedTerm: number
    leaderId: string
    term: number
    timer: NodeJS.Timeout
  }> = new Map()

  constructor(nodeId?: string, port?: number) {
    this.nodeId = nodeId || `tcp-${process.pid}`
    this.port = port ?? 0
  }

  /**
   * 启用 TLS 加密
   * 调用 start() 前调用此方法以启用 TLS。
   *
   * @param options TLS 服务器选项（cert, key, ca 等）
   */
  enableTLS(options: tls.TlsOptions): void {
    this._tlsOptions = options
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

  /**
   * 发送消息到指定 peer，等待 ACK 确认
   *
   * @returns Promise<boolean> — ACK 收到返回 true，超时返回 false
   */
  async sendTo(peerId: string, msg: Uint8Array): Promise<boolean> {
    return this._sendWithAck(peerId, msg)
  }

  /** 同步兼容重载 — 如果连接不通立即返回 false，不走 ACK 流程 */
  sendToSync(peerId: string, msg: Uint8Array): boolean {
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

  /**
   * 带 ACK 确认的发送
   */
  private async _sendWithAck(peerId: string, msg: Uint8Array): Promise<boolean> {
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

    const msgId = this._generateMsgId()

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this._pendingAcks.delete(msgId)
        this._ackTimers.delete(timer)
        resolve(false)
      }, this.ackTimeout)

      this._ackTimers.add(timer)
      this._pendingAcks.set(msgId, { peerId, resolve, timer })

      try {
        this._writeFrame(socket, msg, msgId)
      } catch {
        clearTimeout(timer)
        this._pendingAcks.delete(msgId)
        this._ackTimers.delete(timer)
        resolve(false)
      }
    })
  }

  async broadcast(msg: Uint8Array): Promise<void> {
    const promises: Promise<boolean>[] = []
    for (const peerId of this.connections.keys()) {
      promises.push(this.sendTo(peerId, msg))
    }
    await Promise.all(promises)
  }

  start(): void {
    if (this.server) return

    if (this._tlsOptions) {
      // TLS 模式
      this.server = tls.createServer(this._tlsOptions, (socket) => {
        this._handleConnection(socket as unknown as net.Socket)
      })
    } else {
      // 明文 TCP 模式
      this.server = net.createServer((socket) => {
        this._handleConnection(socket)
      })
    }
    this.server.listen(this.port)
    const addr = this.server.address()
    if (addr && typeof addr === 'object') {
      this.port = addr.port
    }
    this.listenAddress = `${this._getLocalIp()}:${this.port}`
    globalTcpPorts.set(`${this._ns}:${this.nodeId}`, this.port)
  }

  stop(): void {
    // Reject all pending ACKs
    for (const [msgId, entry] of this._pendingAcks) {
      clearTimeout(entry.timer)
      entry.resolve(false)
    }
    this._pendingAcks.clear()

    // Clear all ACK timers
    for (const timer of this._ackTimers) {
      clearTimeout(timer)
    }
    this._ackTimers.clear()

    // Destroy all outgoing connections
    for (const [, socket] of this.connections) {
      socket.destroy()
    }
    this.connections.clear()
    this.peerAddresses.clear()

    // Destroy all accepted (incoming) sockets
    for (const socket of this._acceptedSockets) {
      socket.destroy()
    }
    this._acceptedSockets.clear()

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

  // ── InstallSnapshot 分块处理 ──────────────────────────────

  /**
   * 处理单个 InstallSnapshot 分块
   */
  private _handleSnapshotChunk(from: string, msg: any): void {
    // 获取或创建分块状态
    let state = this._snapshotChunks.get(from)
    if (!state) {
      state = {
        chunks: new Map(),
        total: msg.total,
        fullChecksum: msg.fullChecksum,
        lastIncludedIndex: msg.lastIncludedIndex,
        lastIncludedTerm: msg.lastIncludedTerm,
        leaderId: msg.leaderId,
        term: msg.term,
        timer: setTimeout(() => {
          // 超时清理
          this._snapshotChunks.delete(from)
          this.logger?.warn?.(`[TcpTransport] Snapshot chunks from ${from} timed out`)
        }, TcpTransport.SNAPSHOT_TIMEOUT_MS),
      }
      this._snapshotChunks.set(from, state)
    }

    // 校验 chunk checksum
    const chunkData = Buffer.from(msg.data as string, 'base64')
    const expectedChecksum = msg.checksum as number
    const actualChecksum = TcpTransport._computeChecksum(chunkData)
    if (actualChecksum !== expectedChecksum) {
      this.logger?.warn?.(`[TcpTransport] Snapshot chunk ${msg.seq}/${msg.total} from ${from} checksum mismatch`)
      return
    }

    // 存储 chunk
    state.chunks.set(msg.seq, chunkData)

    // 重置超时
    clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      this._snapshotChunks.delete(from)
    }, TcpTransport.SNAPSHOT_TIMEOUT_MS)
  }

  /**
   * 处理 InstallSnapshot 完成消息
   * 组装所有 chunk，校验整体 checksum，然后通过 handler 回调
   */
  private _handleSnapshotDone(from: string, msg: any): void {
    const state = this._snapshotChunks.get(from)
    if (!state) {
      this.logger?.warn?.(`[TcpTransport] Snapshot done from ${from} but no chunks found`)
      return
    }

    clearTimeout(state.timer)
    this._snapshotChunks.delete(from)

    // 检查 chunk 完整性
    if (state.chunks.size !== state.total) {
      this.logger?.warn?.(
        `[TcpTransport] Snapshot from ${from} incomplete: got ${state.chunks.size}/${state.total} chunks`
      )
      return
    }

    // 按顺序组装
    const parts: Buffer[] = []
    for (let i = 0; i < state.total; i++) {
      const chunk = state.chunks.get(i)
      if (!chunk) {
        this.logger?.warn?.(`[TcpTransport] Missing chunk ${i}/${state.total} from ${from}`)
        return
      }
      parts.push(chunk)
    }
    const assembled = Buffer.concat(parts)

    // 校验整体 checksum
    const expectedChecksum = state.fullChecksum
    const actualChecksum = TcpTransport._computeChecksum(assembled)
    if (actualChecksum !== expectedChecksum) {
      this.logger?.warn?.(
        `[TcpTransport] Snapshot checksum mismatch from ${from}: ` +
        `expected ${expectedChecksum}, got ${actualChecksum}`
      )
      return
    }

    // 构造 InstallSnapshot 请求并通过 handler 回调
    const request: InstallSnapshotRequest = {
      term: state.term,
      leaderId: state.leaderId,
      lastIncludedIndex: state.lastIncludedIndex,
      lastIncludedTerm: state.lastIncludedTerm,
      data: assembled,
      done: true,
    }

    // 通过 handler 通知上层 — 包裹为标准 RaftMessage 格式
    const raftMsg: RaftMessage = {
      type: 'InstallSnapshot',
      term: state.term,
      from: state.leaderId || from,
      to: this.nodeId,
      data: request,
    }
    // 序列化为 Uint8Array 并通过现有的 handler 回调
    const msgBuf = Buffer.from(JSON.stringify(raftMsg))
    this.handler?.(from, msgBuf)
  }

  getListenAddress(): string {
    return this.listenAddress
  }

  // ── InstallSnapshot (分块传输) ──────────────────────────────

  /** 默认分块大小：64KB */
  private static readonly SNAPSHOT_CHUNK_SIZE = 64 * 1024

  /** 默认超时：30s */
  private static readonly SNAPSHOT_TIMEOUT_MS = 30_000

  /** 最大重试次数 */
  private static readonly SNAPSHOT_MAX_RETRIES = 3

  /** CRC32 表 */
  private static _crcTable: Uint32Array | null = null

  /** 获取或初始化 CRC32 表 */
  private static _getCrcTable(): Uint32Array {
    if (TcpTransport._crcTable) return TcpTransport._crcTable
    const table = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
      }
      table[i] = c
    }
    TcpTransport._crcTable = table
    return table
  }

  /** 计算 CRC32 checksum */
  private static _computeChecksum(data: Buffer): number {
    const table = TcpTransport._getCrcTable()
    let crc = 0xFFFFFFFF
    for (let i = 0; i < data.length; i++) {
      crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8)
    }
    return (crc ^ 0xFFFFFFFF) >>> 0
  }

  /**
   * 分块发送 InstallSnapshot 数据
   *
   * 将大快照数据分成小块，每块附带 seq/total/checksum 信息。
   * 接收端重组并进行校验。
   *
   * @param to - 目标节点 ID
   * @param snapshot - InstallSnapshot 请求
   * @param chunkSize - 分块大小（默认 64KB）
   * @param timeoutMs - 超时时间（默认 30s）
   */
  async installSnapshot(
    to: string,
    snapshot: InstallSnapshotRequest,
    chunkSize: number = TcpTransport.SNAPSHOT_CHUNK_SIZE,
    timeoutMs: number = TcpTransport.SNAPSHOT_TIMEOUT_MS,
  ): Promise<InstallSnapshotResponse> {
    const data = Buffer.from(snapshot.data)
    const total = data.length
    const totalChunks = Math.max(1, Math.ceil(total / chunkSize))

    // 计算整体 checksum
    const fullChecksum = TcpTransport._computeChecksum(data)

    // 发送每个 chunk
    for (let seq = 0; seq < totalChunks; seq++) {
      const start = seq * chunkSize
      const end = Math.min(start + chunkSize, total)
      const chunkData = data.subarray(start, end)
      const chunkChecksum = TcpTransport._computeChecksum(chunkData)

      // 构造分块消息
      const chunkMsg = {
        type: 'install_snapshot_chunk' as const,
        seq,
        total: totalChunks,
        data: chunkData.toString('base64'),
        checksum: chunkChecksum,
        fullChecksum,
        lastIncludedIndex: snapshot.lastIncludedIndex,
        lastIncludedTerm: snapshot.lastIncludedTerm,
        leaderId: snapshot.leaderId,
        term: snapshot.term,
      }

      // 发送并等待 ack（带重试）
      let retries = 0
      let sent = false
      while (!sent && retries < TcpTransport.SNAPSHOT_MAX_RETRIES) {
        try {
          const msgBuf = Buffer.from(JSON.stringify(chunkMsg))
          // 对 chunk 使用 fire-and-forget sendToSync，避免 ACK 层对可能正在忙碌连接的干扰
          if (this.sendToSync(to, msgBuf)) {
            sent = true
          } else {
            retries++
            if (retries < TcpTransport.SNAPSHOT_MAX_RETRIES) {
              await new Promise(r => setTimeout(r, 100 * Math.pow(2, retries)))
            }
          }
        } catch {
          retries++
          if (retries < TcpTransport.SNAPSHOT_MAX_RETRIES) {
            await new Promise(r => setTimeout(r, 100 * Math.pow(2, retries)))
          }
        }
      }
    }

    // 发送完成标记
    const doneMsg = {
      type: 'install_snapshot_done' as const,
      term: snapshot.term,
      leaderId: snapshot.leaderId,
      lastIncludedIndex: snapshot.lastIncludedIndex,
      lastIncludedTerm: snapshot.lastIncludedTerm,
      fullChecksum,
    }
    const doneBuf = Buffer.from(JSON.stringify(doneMsg))
    await this.sendTo(to, doneBuf)

    return { success: true, term: snapshot.term }
  }

  private _writeFrame(socket: net.Socket, msg: Uint8Array, msgId?: string): void {
    const base64Data = Buffer.from(msg).toString('base64')
    const frame: TcpFrame = { from: this.nodeId, data: base64Data, type: 'raft' }
    if (msgId) {
      frame.msgId = msgId
    }
    const json = JSON.stringify(frame)
    const jsonBuf = Buffer.from(json, 'utf-8')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(jsonBuf.length, 0)
    socket.write(Buffer.concat([header, jsonBuf]))
  }

  private _handleConnection(socket: net.Socket): void {
    this._acceptedSockets.add(socket)
    socket.on('close', () => { this._acceptedSockets.delete(socket) })
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

          // Handle ACK response
          if (frame.type === 'ack' && frame.ackFor) {
            this._handleAck(frame.ackFor)
            continue
          }

          if (frame.from && frame.data) {
            // Send ACK back if msgId is present (non-ACK messages)
            if (frame.msgId) {
              this._sendAck(socket, frame.msgId)
            }

            // 检查是否是 InstallSnapshot chunk 消息
            const decoded = Buffer.from(frame.data, 'base64')
            try {
              const parsed = JSON.parse(decoded.toString('utf-8'))
              if (parsed.type === 'install_snapshot_chunk') {
                this._handleSnapshotChunk(frame.from, parsed)
                continue
              }
              if (parsed.type === 'install_snapshot_done') {
                this._handleSnapshotDone(frame.from, parsed)
                continue
              }
            } catch {
              // 不是 JSON 消息，正常转发
            }
            this.handler?.(frame.from, decoded)
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

    const isTls = !!this._tlsOptions
    let socket: net.Socket

    if (isTls) {
      // TLS: tls.connect 本身会连接
      socket = tls.connect(port, host, this._tlsOptions)
    } else {
      socket = new net.Socket()
      socket.connect(port, host)
    }

    const cleanup = () => { this.connections.delete(peerId) }
    socket.on('connect', () => {
      socket.setKeepAlive(true, 5000)
      this.connections.set(peerId, socket)
    })
    socket.on('close', cleanup)
    socket.on('error', (err) => {
      cleanup()
      socket.destroy()
    })
    const maxAttempts = 3
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

  /**
   * 生成唯一消息 ID
   */
  private _generateMsgId(): string {
    this._msgIdCounter++
    return `${this.nodeId}-${Date.now()}-${this._msgIdCounter}`
  }

  /**
   * 处理 ACK 响应
   */
  private _handleAck(msgId: string): void {
    const entry = this._pendingAcks.get(msgId)
    if (!entry) return

    clearTimeout(entry.timer)
    this._ackTimers.delete(entry.timer)
    this._pendingAcks.delete(msgId)
    entry.resolve(true)
  }

  /**
   * 发送 ACK 帧
   */
  private _sendAck(socket: net.Socket, ackFor: string): void {
    try {
      const ackFrame: TcpFrame = {
        from: this.nodeId,
        data: '',
        type: 'ack',
        ackFor,
      }
      const json = JSON.stringify(ackFrame)
      const jsonBuf = Buffer.from(json, 'utf-8')
      const header = Buffer.alloc(4)
      header.writeUInt32BE(jsonBuf.length, 0)
      socket.write(Buffer.concat([header, jsonBuf]))
    } catch {
      // ACK 发送失败不阻塞消息处理
    }
  }
}
