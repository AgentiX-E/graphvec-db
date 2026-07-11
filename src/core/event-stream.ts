/**
 * event-stream.ts — 基于 ROUTER/DEALER EventBus 的可靠事件流
 *
 * 架构：
 *   emit() → wal.append → bus.broadcast（点对点 ACK）
 *
 *   收到远程消息（ROUTER receive loop → EventBus.setReceiveHandler）:
 *       busReceive(msg, fromNodeId)
 *           ├── type === 'ack'       → pendingTracker.delete
 *           ├── type === 'data'      → dedup → applyHandler → bus.send(ack)
 *           ├── type === 'sync-query' → 回复 self seq
 *           └── type === 'sync-request' → 回复 WAL batch
 */

import { EventBus, TransportMessage } from './event-bus'
import { SegmentStreamWal, StreamMessage } from './segment-stream-wal'
import { Logger } from '../ops/logger'

export interface StallInfo {
  msgId: string
  seq: number
  type: string
  retries: number
  durationMs: number
}

export function webhookOnStall(): ((info: StallInfo) => void) | undefined {
  const url = process.env.EVENTSTREAM_STALL_WEBHOOK_URL
  if (!url) return undefined
  let extraHeaders: Record<string, string> = {}
  const rawHeaders = process.env.EVENTSTREAM_STALL_WEBHOOK_HEADERS
  if (rawHeaders) {
    try { extraHeaders = JSON.parse(rawHeaders) } catch { /* ignore */ }
  }
  const method = (process.env.EVENTSTREAM_STALL_WEBHOOK_METHOD || 'POST').toUpperCase()
  return (info: StallInfo) => {
    fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify({ level: 'WARN', source: 'EventStream', message: `Event ${info.msgId} stalled after ${info.retries} retries (${info.durationMs}ms)`, data: info }),
    }).catch(() => { /* best-effort */ })
  }
}

export interface EventStreamConfig {
  nodeId: string
  eventBus: EventBus
  walDir: string
  ackTimeoutMs?: number
  retryIntervalMs?: number
  maxRetries?: number
  dedupCapacity?: number
  catchupBatchSize?: number
  stallThreshold?: number
  onStall?: (info: StallInfo) => void
}

export type EventHandler = (msg: StreamMessage) => void
export type ApplyHandler = (msg: StreamMessage) => Promise<void>

class DedupRing {
  private set = new Set<string>()
  private buf: (string | undefined)[]
  private head = 0
  private _size = 0
  private capacity: number
  constructor(capacity: number) {
    this.capacity = capacity
    this.buf = new Array(capacity)
  }
  has(msgId: string): boolean { return this.set.has(msgId) }
  add(msgId: string): void {
    if (this.set.has(msgId)) return
    if (this._size >= this.capacity) {
      const oldest = this.buf[this.head]!
      this.set.delete(oldest)
      this.buf[this.head] = msgId
      this.head = (this.head + 1) % this.capacity
    } else {
      const idx = (this.head + this._size) % this.capacity
      this.buf[idx] = msgId
      this._size++
    }
    this.set.add(msgId)
  }
  get size(): number { return this._size }
}

export class EventStream {
  private config: EventStreamConfig
  private wal: SegmentStreamWal
  private bus: EventBus
  private logger: Logger
  private seq = 0
  private dedup: DedupRing
  /** 发送 pending Trace：msgId → { sentAt, retries } */
  private pendingTracker = new Map<string, { sentAt: number; retries: number }>()
  /** 本地事件回调 */
  private handlers = new Map<string, EventHandler[]>()
  /** 远程事件应用回调（持久化后才发 ACK） */
  private applyHandler: ApplyHandler | null = null
  /** ACK 通知回调（OutboxReplicationManager 注册，收到 ACK 后通知 outbox 的 ackTracker） */
  private onAckCallback: ((peerId: string, msgId: string) => void) | null = null
  /**
   * LMDB mmap ACK 回调（多进程场景：主进程收到 ACK 后直接写入 LMDB，Worker 子进程通过 mmap 读到）。
   * 参数：ackMsgId（如 'node-2-42' 或 uuid）。Outbox 需要从 persistent store 定位对应的 seq。
   * 单进程场景可留空——ACK 直接通过 onAckCallback 传到 PerPeerWorker 的 ackTracker。
   */
  private onAckMmapCallback: ((msgId: string) => void) | null = null
  /** 后台扫描 timer */
  private scanTimer: ReturnType<typeof setInterval> | null = null
  /** 是否正在运行 */
  private running = false

  constructor(config: EventStreamConfig) {
    this.config = {
      ackTimeoutMs: 3000,
      retryIntervalMs: 3000,
      maxRetries: 10,
      dedupCapacity: 10000,
      catchupBatchSize: 100,
      stallThreshold: 100,
      ...config,
    }
    this.bus = config.eventBus
    this.wal = new SegmentStreamWal(config.walDir)
    this.logger = new Logger('EventStream')
    this.dedup = new DedupRing(this.config.dedupCapacity!)
  }

  get isOpen(): boolean { return this.wal.isOpen }

  /**
   * 打开 StreamWal 并注册 EventBus 接收回调
   */
  open(): void {
    if (this.wal.isOpen) return
    this.wal.open()
    this.running = true
    this._restoreSeq()
    this._registerBusReceive()
    this._startScan()
  }

  async close(): Promise<void> {
    this.running = false
    if (this.scanTimer) {
      clearInterval(this.scanTimer)
      this.scanTimer = null
    }
    this.wal.close()
    this.handlers.clear()
    this.pendingTracker.clear()
    this.bus.setReceiveHandler(() => {}) // 清空 handler
  }

  on(type: string, handler: EventHandler): void {
    const list = this.handlers.get(type) || []
    list.push(handler)
    this.handlers.set(type, list)
  }

  off(type: string, handler: EventHandler): void {
    const list = this.handlers.get(type) || []
    this.handlers.set(type, list.filter(h => h !== handler))
  }

  registerApplyHandler(handler: ApplyHandler): void {
    this.applyHandler = handler
  }

  /**
   * 注册 ACK 通知回调。
   * 收到远程 ACK 时，除了清理 pendingTracker，还通知此回调。
   * 由 MultiLeaderReplication 注册，驱动 OutboxReplicationManager 的 ackTracker。
   */
  registerOnAck(callback: (peerId: string, msgId: string) => void): void {
    this.onAckCallback = callback
  }

  /**
   * 注册 LMDB mmap ACK 回调。
   * 多进程场景：主进程收到 ACK 后直接写入 LMDB（markAcked），
   * Worker 子进程通过 mmap 读到 ACK 状态。
   */
  registerOnAckMmap(callback: (msgId: string) => void): void {
    this.onAckMmapCallback = callback
  }

  /**
   * 发送可靠事件（fire-and-forget 本地 + 广播）
   */
  emit(event: { type: string; data: Record<string, unknown>; timestamp?: number }): void {
    if (!this.running) throw new Error('EventStream is not open')
    const msg = this._buildMessage(event)
    this.wal.append(msg)
    this.pendingTracker.set(msg.msgId, { sentAt: Date.now(), retries: 0 })
    this._emitLocal(msg)

    // 广播给所有 peer
    const transport: TransportMessage = {
      msgId: msg.msgId,
      type: 'data',
      srcNodeId: this.config.nodeId,
      data: { __es_msg: msg },
    }
    this.bus.broadcast(transport)
  }

  /**
   * 只触发本地回调，不写入 WAL 也不广播。
   * 用于远程应用场景：事件已从网络到达并通过 `registerApplyHandler` 持久化，
   * 但本地回调（缓存失效、索引更新等）仍需要触发。
   */
  emitLocal(event: { type: string; data: Record<string, unknown>; timestamp?: number }): void {
    const msg = this._buildMessage(event)
    this._emitLocal(msg)
  }

  private _buildMessage(event: { type: string; data: Record<string, unknown>; timestamp?: number }): StreamMessage {
    this.seq++
    return {
      msgId: `${this.config.nodeId}-${this.seq}`,
      seq: this.seq,
      nodeId: this.config.nodeId,
      timestamp: event.timestamp ?? Date.now(),
      type: event.type,
      data: { ...event.data },
    }
  }

  /** 本地触发回调（不走网络） */
  private _emitLocal(msg: StreamMessage): void {
    const list = this.handlers.get(msg.type) || []
    for (const handler of list) {
      try { handler(msg) } catch (err) { this.logger.error(`EventStream handler error: ${(err as Error).message}`) }
    }
  }

  // ── 两轮 sync 追赶 ────────────────

  /**
   * 请求完整回放（新节点加入 / 断连恢复）
   * 两轮协议：
   *   Phase 1: sync-query 广播 → 收集各个 peer 的最新 seq
   *   Phase 2: 选 maxSeq 的 peer → sync-request → 接收 sync-batch
   */
  requestSync(): void {
    if (!this.running) return
    const query: TransportMessage = {
      msgId: `sync-query-${this.config.nodeId}-${Date.now()}`,
      type: 'sync-query',
      srcNodeId: this.config.nodeId,
      data: { requester: this.config.nodeId, lastSeq: this.seq },
    }
    this.bus.broadcast(query)

    // 收集 Phase 1 回复（1.5s timeout）
    const seqs: { nodeId: string; seq: number }[] = []
    const timer = setTimeout(() => {
      let bestPeer = ''
      let bestSeq = -1
      for (const s of seqs) {
        if (s.seq > bestSeq) { bestSeq = s.seq; bestPeer = s.nodeId }
      }
      if (!bestPeer) {
        this.logger.warn('requestSync: no peer responded, skipping')
        return
      }
      this._requestCatchup(bestPeer, bestSeq)
    }, 1500)
    if (typeof timer === 'object' && 'unref' in timer) (timer as any).unref()

    ;(this as any)._syncQueryReplies = seqs
    ;(this as any)._syncQueryTimer = timer
  }

  private _requestCatchup(peerNodeId: string, targetSeq: number): void {
    const req: TransportMessage = {
      msgId: `sync-req-${this.config.nodeId}-${Date.now()}`,
      type: 'sync-request',
      srcNodeId: this.config.nodeId,
      data: { fromSeq: this.seq, requester: this.config.nodeId, targetSeq },
    }
    void this.bus.send(peerNodeId, req)
  }

  // ── ROUTER/DEALER 消息收发 ─────────

  /**
   * 注册到 EventBus 的 receive handler
   */
  private _registerBusReceive(): void {
    this.bus.setReceiveHandler((msg: TransportMessage, fromNodeId: string) => {
      switch (msg.type) {
        case 'ack':
          this._onRemoteAck(msg)
          break
        case 'data':
          this._onRemoteData(msg, fromNodeId)
          break
        case 'sync-query':
          this._onSyncQuery(msg)
          break
        case 'sync-query-reply':
          this._onSyncQueryReply(msg)
          break
        case 'sync-request':
          this._onSyncRequest(msg)
          break
        case 'sync-batch':
          this._onSyncBatch(msg)
          break
      }
    })
  }

  /**
   * 收到远程 ACK：更新 pendingTracker 和 WAL，
   * 并通知 OutboxReplicationManager 的 ackTracker。
   */
  private _onRemoteAck(msg: TransportMessage): void {
    const ackMsgId = msg.ackMsgId
    if (!ackMsgId) return
    this.pendingTracker.delete(ackMsgId)
    this.wal.acknowledge([ackMsgId])
    // 通知 Outbox 层的 ACK tracker
    if (this.onAckCallback && msg.srcNodeId) {
      this.onAckCallback(msg.srcNodeId, ackMsgId)
    }
    // LMDB mmap ACK（多进程场景：主进程写入 LMDB，Worker 子进程 mmap 读到）
    if (this.onAckMmapCallback) {
      this.onAckMmapCallback(ackMsgId)
    }
  }

  /**
   * 收到远程数据事件
   * 流程：dedup → applyHandler（持久化）→ 回传 ACK → 本地回调
   */
  private _onRemoteData(msg: TransportMessage, fromNodeId: string): void {
    const raw = msg.data.__es_msg as StreamMessage | undefined
    if (!raw) {
      // 没有 __es_msg 的 data 消息 → 可能是 Outbox Worker 直接发的 replicated 事件
      // 直接交给 applyHandler 处理（If any注册）
      if (this.applyHandler && msg.data && typeof msg.data === 'object') {
        const inlineMsg: StreamMessage = {
          msgId: msg.msgId,
          seq: 0,
          nodeId: msg.srcNodeId ?? fromNodeId,
          timestamp: Date.now(),
          type: (msg.data as any).type ?? 'unknown',
          data: (msg.data as any).data ?? msg.data,
        }
        this.applyHandler(inlineMsg).catch(err => {
          this.logger.error(`applyHandler error for inline msg ${msg.msgId}: ${err.message}`)
        })
      }
      return
    }

    if (this.dedup.has(raw.msgId)) return
    this.dedup.add(raw.msgId)

    const sendAck = () => {
      const ack: TransportMessage = {
        msgId: `ack-${raw.msgId}`,
        type: 'ack',
        srcNodeId: this.config.nodeId,
        ackMsgId: raw.msgId,
        data: {},
      }
      void this.bus.send(fromNodeId, ack)
    }

    if (this.applyHandler) {
      this.applyHandler(raw)
        .then(() => {
          sendAck()
          this.wal.markConsumed([raw.msgId])
          this._emitLocal(raw)
        })
        .catch((err) => {
          this.logger.error(`applyHandler error for ${raw.msgId}: ${err.message}`)
        })
    } else {
      sendAck()
      this.wal.markConsumed([raw.msgId])
      this._emitLocal(raw)
    }
  }

  /**
   * 收到 sync-query：Phase 1，回复自己的最新 seq
   */
  private _onSyncQuery(msg: TransportMessage): void {
    const requester = msg.data.requester as string
    if (requester === this.config.nodeId) return

    const reply: TransportMessage = {
      msgId: `sync-query-reply-${this.config.nodeId}-${Date.now()}`,
      type: 'sync-query-reply',
      srcNodeId: this.config.nodeId,
      dstNodeId: requester,
      data: { nodeId: this.config.nodeId, currentSeq: this.seq },
    }
    void this.bus.send(requester, reply)
  }

  /**
   * 收到 sync-query-reply：Phase 1 的回复，收集 seq
   */
  private _onSyncQueryReply(msg: TransportMessage): void {
    const seqs = (this as any)._syncQueryReplies as { nodeId: string; seq: number }[] | undefined
    if (!seqs) return
    const nodeId = msg.data.nodeId as string
    const currentSeq = msg.data.currentSeq as number
    if (nodeId && typeof currentSeq === 'number') {
      seqs.push({ nodeId, seq: currentSeq })
    }
  }

  /**
   * 收到 sync-request：Phase 2，从 WAL 读取 batch 回复
   */
  private _onSyncRequest(msg: TransportMessage): void {
    const requester = msg.data.requester as string
    const fromSeq = msg.data.fromSeq as number
    const targetSeq = msg.data.targetSeq as number
    if (requester === this.config.nodeId) return

    const msgs = this.wal.replay(fromSeq + 1)
    if (msgs.length === 0) return

    const filtered = targetSeq > 0 ? msgs.filter(m => m.seq <= targetSeq) : msgs
    if (filtered.length === 0) return

    const batchSize = this.config.catchupBatchSize!

    for (let i = 0; i < filtered.length; i += batchSize) {
      const batch = filtered.slice(i, i + batchSize)
      const reply: TransportMessage = {
        msgId: `sync-batch-${this.config.nodeId}-${Date.now()}-${i}`,
        type: 'sync-batch',
        srcNodeId: this.config.nodeId,
        dstNodeId: requester,
        data: { msgs: batch },
      }
      void this.bus.send(requester, reply)
    }
  }

  /**
   * 收到 sync-batch：重放接收到的历史消息
   */
  private _onSyncBatch(msg: TransportMessage): void {
    const msgs = msg.data.msgs as StreamMessage[] | undefined
    if (!msgs) return
    for (const m of msgs) {
      if (this.dedup.has(m.msgId)) continue
      this.dedup.add(m.msgId)
      this._emitLocal(m)
      const ack: TransportMessage = {
        msgId: `ack-${m.msgId}`,
        type: 'ack',
        srcNodeId: this.config.nodeId,
        ackMsgId: m.msgId,
        data: {},
      }
      void this.bus.send(msg.srcNodeId, ack)
    }
  }

  // ── WAL 恢复与定时扫描 ─────────────

  private _restoreSeq(): void {
    try {
      const all = this.wal.replay(0)
      for (const msg of all) {
        if (msg.seq > this.seq) this.seq = msg.seq
      }
      const pending = this.wal.readPending(Date.now() + 3600000)
      for (const msg of pending) {
        if (!this.pendingTracker.has(msg.msgId)) {
          this.pendingTracker.set(msg.msgId, { sentAt: 0, retries: 0 })
        }
      }
      if (pending.length > 0) {
        this.logger.info(`EventStream: recovered ${pending.length} pending messages from WAL`)
      }
    } catch {
      // 首次运行，WAL 为空
    }
  }

  private _startScan(): void {
    const interval = this.config.ackTimeoutMs! / 3 || 1000
    this.scanTimer = setInterval(() => { this._scanPending() }, interval)
    this.scanTimer.unref()
    const pruneTimer = setInterval(() => { this.wal.pruneByTimestamp(Date.now() - 3600000) }, 3600000)
    pruneTimer.unref()
  }

  private _scanPending(): void {
    const now = Date.now()
    const timeout = this.config.ackTimeoutMs!
    const maxRetries = 3
    for (const [msgId, info] of this.pendingTracker) {
      if (now - info.sentAt < timeout) continue
      info.retries++

      /* 超过最大重试次数（第 4 次及以上）：记录 warn 但不阻塞 */
      if (info.retries > maxRetries) {
        if (info.retries === maxRetries + 1) {
          this.logger.warn(`EventStream: ${msgId} exceeded max retries (${maxRetries}), giving up on retransmit`)
        }
        continue
      }

      if (this.config.onStall && info.retries === this.config.stallThreshold) {
        const msg = this.wal.readPending(Date.now() + 3600000).find(m => m.msgId === msgId)
        if (msg) {
          this.config.onStall({ msgId, seq: msg.seq, type: msg.type, retries: info.retries, durationMs: now - info.sentAt })
        }
      }

      const pendingMsgs = this.wal.readPending(now)
      const msg = pendingMsgs.find(m => m.msgId === msgId)
      if (!msg) { this.pendingTracker.delete(msgId); continue }

      const transport: TransportMessage = {
        msgId: msg.msgId,
        type: 'data',
        srcNodeId: this.config.nodeId,
        data: { __es_msg: msg },
      }
      this.bus.broadcast(transport)
      info.sentAt = now
      this.logger.info(`EventStream: retry ${msgId} (attempt ${info.retries})`)
    }
  }
}
