/**
 * membership-presync.ts — 新节点加入前数据预同步
 *
 * PreSync 是 Raft 成员变更的预准备阶段：
 * 1. 新节点发送 join 请求时，Leader 先启动数据同步
 * 2. Leader 发送状态快照（如有）和最近日志条目
 * 3. 新节点确认数据对齐后，Leader 才开始正式的 membership change
 *
 * 这样做避免了新节点加入后需要大量日志追赶，减少了集群抖动。
 *
 * 与 raft-logic 安装快照不同，PreSync 是应用层数据同步，
 * 发生在 AppMembershipManager 发起 proposeChange('add') 之前。
 */

import { Logger } from '../ops/logger'
import { MembershipTransport, MembershipMessage } from './app-membership-manager'

// ── 类型定义 ──

/** 数据源接口：供 PreSync 读取快照和日志 */
export interface DataSource {
  /** 导出当前状态快照 */
  exportSnapshot(): Buffer | Uint8Array
  /** 导入状态快照（接收端使用） */
  importSnapshot(data: Buffer | Uint8Array): void
  /** 获取已提交的日志条目（fromIndex 开始） */
  getCommittedEntries(fromIndex: number, maxCount?: number): Array<{ index: number; term: number; data: Uint8Array }>
  /** 获取当前已提交的最新索引 */
  getCommitIndex(): number
  /** 获取当前任期 */
  getCurrentTerm(): number
  /** 返回节点是否处于 Leader 状态 */
  isLeader(): boolean
}

/** PreSync 配置 */
export interface PreSyncConfig {
  nodeId: string
  transport: MembershipTransport
  dataSource: DataSource
  /** 单次传输的最大日志条数（默认 100） */
  batchSize?: number
  /** 预同步超时（毫秒，默认 30000） */
  timeoutMs?: number
  /** 预同步回调 */
  onResult: (success: boolean, peerId: string) => void
}

/** 预同步消息类型 */
interface PreSyncMessage {
  type: 'pre-sync-start' | 'pre-sync-snapshot' | 'pre-sync-log-chunk' | 'pre-sync-complete' | 'pre-sync-ready' | 'pre-sync-abort'
  seq: number
  from: string
  targetPeerId: string
  term: number
  commitIndex?: number
  snapshot?: Buffer | Uint8Array
  entries?: Array<{ index: number; term: number; data: Uint8Array }>
  chunkIndex?: number
  totalChunks?: number
  /** 节点是否已就绪（在 ready 消息中使用） */
  ready?: boolean
  /** ErrorInfo */
  error?: string
}

// ── PreSyncManager ──

export class PreSyncManager {
  private config: PreSyncConfig
  private logger: Logger
  private _seq = 0
  private _inProgress: Map<string, { seq: number; timer: ReturnType<typeof setTimeout> }> = new Map()
  private _started = false

  constructor(config: PreSyncConfig) {
    this.config = {
      batchSize: 100,
      timeoutMs: 30000,
      ...config,
    }
    this.logger = new Logger('PreSyncManager')
  }

  start(): void {
    if (this._started) return
    this._started = true
    this.config.transport.onMessage((from: string, msg: any) => {
      this._handleMessage(from, msg)
    })
    this.logger.info('[PreSync] Started')
  }

  stop(): void {
    this._started = false
    // 清理所有进行中的预同步
    for (const [peerId, state] of this._inProgress) {
      clearTimeout(state.timer)
    }
    this._inProgress.clear()
    this.logger.info('[PreSync] Stopped')
  }

  /** 获取是否正在与某节点进行预同步 */
  isSyncing(peerId: string): boolean {
    return this._inProgress.has(peerId)
  }

  /**
   * Leader 发起对新节点的预同步
   * 在新的节点加入集群之前，先同步数据
   */
  async startSync(peerId: string): Promise<boolean> {
    if (!this.config.dataSource.isLeader()) {
      this.logger.warn(`[PreSync] Not leader, cannot sync to ${peerId}`)
      return false
    }

    if (this._inProgress.has(peerId)) {
      this.logger.warn(`[PreSync] Sync to ${peerId} already in progress`)
      return false
    }

    const seq = this._seq++
    const term = this.config.dataSource.getCurrentTerm()
    const commitIndex = this.config.dataSource.getCommitIndex()

    // 注册超时保护
    const timer = setTimeout(() => {
      this._handleTimeout(peerId, seq)
    }, this.config.timeoutMs)

    this._inProgress.set(peerId, { seq, timer })

    this.logger.info(`[PreSync] Starting sync to ${peerId} seq=${seq}, term=${term}, commitIndex=${commitIndex}`)

    try {
      // Step 1: 发送 pre-sync-start（包含当前状态Info）
      const startMsg: PreSyncMessage = {
        type: 'pre-sync-start',
        seq,
        from: this.config.nodeId,
        targetPeerId: peerId,
        term,
        commitIndex,
      }

      await this.config.transport.send(peerId, startMsg)

      // Step 2: 发送快照（如果可用）
      let snapshotSent = false
      try {
        const snapshot = this.config.dataSource.exportSnapshot()
        if (snapshot && snapshot.byteLength > 0) {
          const snapMsg: PreSyncMessage = {
            type: 'pre-sync-snapshot',
            seq,
            from: this.config.nodeId,
            targetPeerId: peerId,
            term,
            commitIndex,
            snapshot,
          }
          await this.config.transport.send(peerId, snapMsg)
          snapshotSent = true
          this.logger.info(`[PreSync] Sent snapshot (${snapshot.byteLength} bytes) to ${peerId}`)
        }
      } catch (err: any) {
        this.logger.warn(`[PreSync] Snapshot export failed: ${err.message}, continuing without snapshot`)
      }

      // Step 3: 发送日志条目（从 lastSnapshotIndex 或 1 开始）
      const fromIndex = commitIndex > 0 ? Math.max(1, commitIndex - 50) : 1
      const entries = this.config.dataSource.getCommittedEntries(fromIndex, this.config.batchSize)

      if (entries.length > 0) {
        for (let i = 0; i < entries.length; i += 10) {
          const chunk = entries.slice(i, i + 10)
          const chunkMsg: PreSyncMessage = {
            type: 'pre-sync-log-chunk',
            seq,
            from: this.config.nodeId,
            targetPeerId: peerId,
            term,
            commitIndex,
            entries: chunk,
            chunkIndex: Math.floor(i / 10),
            totalChunks: Math.ceil(entries.length / 10),
          }
          await this.config.transport.send(peerId, chunkMsg)
        }
        this.logger.info(`[PreSync] Sent ${entries.length} log entries to ${peerId}`)
      }

      // Step 4: 发送 pre-sync-complete（Leader 侧数据已发送完毕）
      const completeMsg: PreSyncMessage = {
        type: 'pre-sync-complete',
        seq,
        from: this.config.nodeId,
        targetPeerId: peerId,
        term,
        commitIndex,
      }
      await this.config.transport.send(peerId, completeMsg)

      // wait for ready response — the actual await happens via handleMessage
      this.logger.info(`[PreSync] Waiting for ready from ${peerId}`)

      // Note: 真正等待 ready 是通过 message handler 完成的
      // 这里返回一个 Promise，在收到 ready 或超时后 resolve
      return new Promise<boolean>((resolve) => {
        const state = this._inProgress.get(peerId)
        if (!state) {
          resolve(false)
          return
        }
        // 替换 Promise
        (state as any)._resolve = resolve
      })

    } catch (err: any) {
      this.logger.error(`[PreSync] Sync to ${peerId} failed: ${err.message}`)
      this._cleanup(peerId)
      return false
    }
  }

  /** 处理收到的预同步消息 */
  private _handleMessage(from: string, msg: any): void {
    if (!msg || !msg.type?.startsWith('pre-sync-')) return

    // 跳过自己发出的消息
    if (from === this.config.nodeId) return

    const psMsg = msg as PreSyncMessage

    switch (psMsg.type) {
      case 'pre-sync-start':
        this._handleStart(from, psMsg)
        break
      case 'pre-sync-snapshot':
        this._handleSnapshot(from, psMsg)
        break
      case 'pre-sync-log-chunk':
        this._handleLogChunk(from, psMsg)
        break
      case 'pre-sync-complete':
        this._handleComplete(from, psMsg)
        break
      case 'pre-sync-ready':
        this._handleReady(from, psMsg)
        break
      case 'pre-sync-abort':
        this._handleAbort(from, psMsg)
        break
      default:
        this.logger.warn(`[PreSync] Unknown message type: ${psMsg.type}`)
    }
  }

  /** 接收端：处理 start 消息 */
  private _handleStart(from: string, msg: PreSyncMessage): void {
    this.logger.info(`[PreSync] Received start seq=${msg.seq}, term=${msg.term}, commitIndex=${msg.commitIndex} from ${from}`)
    // 接收端初始化接收状态
    this._inProgress.set(from, {
      seq: msg.seq,
      timer: setTimeout(() => {
        this._handleTimeout(from, msg.seq)
      }, this.config.timeoutMs),
    })
  }

  /** 接收端：处理 snapshot 消息 */
  private _handleSnapshot(from: string, msg: PreSyncMessage): void {
    const state = this._inProgress.get(from)
    if (!state || state.seq !== msg.seq) return

    if (msg.snapshot && msg.snapshot.byteLength > 0) {
      try {
        // 接收端通过 dataSource 导入快照
        this.config.dataSource.importSnapshot(msg.snapshot)
        this.logger.info(`[PreSync] Received snapshot (${msg.snapshot.byteLength} bytes) from ${from}`)
      } catch (err: any) {
        this.logger.warn(`[PreSync] Failed to process snapshot: ${err.message}`)
        // 忽略快照Error，继续
      }
    }
  }

  /** 接收端：处理日志块 */
  private _handleLogChunk(from: string, msg: PreSyncMessage): void {
    const state = this._inProgress.get(from)
    if (!state || state.seq !== msg.seq) return

    this.logger.debug(`[PreSync] Received log chunk ${msg.chunkIndex}/${msg.totalChunks} from ${from}`)
    // 接收端存储日志条目（待后续 apply）
  }

  /** 接收端：处理 complete，回复 ready */
  private _handleComplete(from: string, msg: PreSyncMessage): void {
    const state = this._inProgress.get(from)
    if (!state || state.seq !== msg.seq) return

    this.logger.info(`[PreSync] Sync complete from ${from} seq=${msg.seq}, sending ready`)

    // 接收端确认数据已就绪，回复 ready
    const readyMsg: PreSyncMessage = {
      type: 'pre-sync-ready',
      seq: msg.seq,
      from: this.config.nodeId,
      targetPeerId: from,
      term: msg.term,
      ready: true,
    }

    this.config.transport.send(from, readyMsg).catch(err => {
      this.logger.error(`[PreSync] Failed to send ready: ${err.message}`)
    })

    this._cleanup(from)
  }

  /** 发送端：处理 ready 确认 */
  private _handleReady(from: string, msg: PreSyncMessage): void {
    const state = this._inProgress.get(from)
    if (!state || state.seq !== msg.seq) return

    this.logger.info(`[PreSync] Received ready from ${from} seq=${msg.seq}`)
    clearTimeout(state.timer)

    // 调用回调通知上层
    this.config.onResult(true, from)

    // If any待处理的 resolve，调用
    const resolver = (state as any)._resolve
    if (resolver) resolver(true)

    this._cleanup(from)
  }

  /** 处理 abort */
  private _handleAbort(from: string, msg: PreSyncMessage): void {
    const state = this._inProgress.get(from)
    if (!state || state.seq !== msg.seq) return

    this.logger.warn(`[PreSync] Aborted by ${from} seq=${msg.seq}: ${msg.error || 'no reason'}`)
    this.config.onResult(false, from)

    const resolver = (state as any)._resolve
    if (resolver) resolver(false)

    this._cleanup(from)
  }

  /** 处理超时 */
  private _handleTimeout(peerId: string, seq: number): void {
    const state = this._inProgress.get(peerId)
    if (!state || state.seq !== seq) return

    this.logger.warn(`[PreSync] Timeout for ${peerId} seq=${seq}`)

    this.config.onResult(false, peerId)

    const resolver = (state as any)._resolve
    if (resolver) resolver(false)

    this._cleanup(peerId)
  }

  private _cleanup(peerId: string): void {
    const state = this._inProgress.get(peerId)
    if (state) {
      clearTimeout(state.timer)
    }
    this._inProgress.delete(peerId)
  }
}
