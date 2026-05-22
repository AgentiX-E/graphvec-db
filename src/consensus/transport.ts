/**
 * transport.ts — Transport 接口层
 *
 * 定义 Raft 协议核心 RPC 和传输抽象。
 * 实现可选用：内存 MockTransport（测试）、TCP、gRPC 等。
 */
import { LogEntry } from './wal'

// ─── Raft Message Types ──────────────────────────────────────

export type RaftMessageType =
  | 'AppendEntries'
  | 'RequestVote'
  | 'AppendEntriesResponse'
  | 'RequestVoteResponse'
  | 'InstallSnapshot'
  | 'PreVote'
  | 'PreVoteResponse'

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
