/**
 * event-stream.ts — EventBus 之上的可靠事件流
 *
 * 在 EventBus（ZeroMQ PUB/SUB）之上增加至少送达一次、去重和离线追赶。
 *
 * 架构：
 *   GraphEngine.emit(event)
 *       │
 *       ▼
 *   EventStream.emit(msg)                ← 用户入口
 *       ├── StreamWal.append(msg)
 *       └── eventBus.emit(event)         ← 原始 EventBus PUB（fire-and-forget）
 *
 *   eventBus.subSocket.receive()
 *       │
 *       ▼
 *   EventStream._onRemoteEvent(evt)
 *       ├── 控制消息（ack / sync / sync-batch）→ 特殊处理
 *       ├── 普通事件 → dedup → eventBus.emit('event:ack', { msgIds })
 *       │              → StreamWal.markConsumed
 *       │              → 回调
 *       └──
 *
 *   后台定时扫描:
 *       ─ readPending → 超时未 ACK 的重发
 *
 *   ACK 通过 EventBus 自身的 `event:ack` 事件类型，不依赖额外 ZeroMQ 连接。
 *   SYNC 请求通过 `event:sync`，回复通过 `event:sync-batch`
 */

import { EventBus, GraphEventType, GraphEvent } from './event-bus'
import { StreamWal, StreamMessage } from './stream-wal'
import { Logger } from '../ops/logger'

/**
 * onStall callback info
 */
export interface StallInfo {
  msgId: string
  seq: number
  type: string
  retries: number
  durationMs: number
}

/**
 * 从环境变量自动注册 webhook onStall（默认不启用）
 * 设置 EVENTSTREAM_STALL_WEBHOOK_URL 环境变量即可。
 * 可选：EVENTSTREAM_STALL_THRESHOLD（默认 100）
 */
export function webhookOnStall(): ((info: StallInfo) => void) | undefined {
  const url = process.env.EVENTSTREAM_STALL_WEBHOOK_URL
  if (!url) return undefined

  // 解析自定义 headers（可选），如：
  // EVENTSTREAM_STALL_WEBHOOK_HEADERS='{"Authorization":"Bearer xxx","X-Custom":"val"}'
  let extraHeaders: Record<string, string> = {}
  const rawHeaders = process.env.EVENTSTREAM_STALL_WEBHOOK_HEADERS
  if (rawHeaders) {
    try {
      extraHeaders = JSON.parse(rawHeaders)
    } catch {
      // 静默忽略格式错误
    }
  }

  // HTTP Method，默认 POST，支持 PUT / PATCH
  const method = (process.env.EVENTSTREAM_STALL_WEBHOOK_METHOD || 'POST').toUpperCase()

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  }

  return (info: StallInfo) => {
    // fire-and-forget
    fetch(url, {
      method,
      headers,
      body: JSON.stringify({
        level: 'WARN',
        source: 'EventStream',
        message: `Event ${info.msgId} stalled after ${info.retries} retries (${info.durationMs}ms)`,
        data: info,
      }),
    }).catch(() => { /* best-effort */ })
  }
}

export interface EventStreamConfig {
  nodeId: string
  eventBus: EventBus
  walDir: string
  /**
   * ACK 超时（毫秒）。发送后超过此时间未收到 ACK 即视为需要重试。
   * 默认 5000
   */
  ackTimeoutMs?: number
  /**
   * ACK 事件前缀。默认与普通事件共用 topic space。
   */
  ackPrefix?: string
  /**
   * 重试间隔（毫秒）。后台扫描间隔。
   * 默认 3000
   */
  retryIntervalMs?: number
  /**
   * 最大重试次数。超过后放弃（记录 warn）。
   * 默认 10
   */
  maxRetries?: number
  /**
   * 去重缓存容量。默认 10000
   */
  dedupCapacity?: number
  /**
   * 追赶批大小。默认 100
   */
  catchupBatchSize?: number
  /**
   * 存活告警阈值（重试次数）。当某条消息重试次数达到此值时，
   * 触发 onStall 回调。默认 100（约 5 分钟 @ 3s 间隔）
   */
  stallThreshold?: number
  /**
   * 存活告警回调。当某条消息持续重试超过 stallThreshold 时被调用。
   * 可在此发送报警/通知给运维。
   */
  onStall?: (info: StallInfo) => void
}

/**
 * 事件回调
 */
export type EventHandler = (msg: StreamMessage) => void

/** 应用层回调 — async，持久化完成后才发 ACK */
export type ApplyHandler = (msg: StreamMessage) => Promise<void>

/**
 * 事件去重器 — 环形缓冲区实现，O(1) 插入和淘汰
 */
/**
 * DedupRing — 固定容量环形缓冲区去重器
 *
 * O(1) 插入和淘汰，使用 Set + 环形索引，无数组 shift 开销
 */
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

  has(msgId: string): boolean {
    return this.set.has(msgId)
  }

  add(msgId: string): void {
    if (this.set.has(msgId)) return
    if (this._size >= this.capacity) {
      // 淘汰 oldest
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

  get size(): number {
    return this._size
  }
}

/**
 * EventStream — 包装 EventBus 的可靠事件流
 */
export class EventStream {
  private config: EventStreamConfig
  private wal: StreamWal
  private bus: EventBus
  private logger: Logger
  private seq = 0
  private dedup: DedupRing
  /** 发送 pending 追踪：msgId → { sentAt, retries } */
  private pendingTracker = new Map<string, { sentAt: number; retries: number }>()
  /** 本地事件回调 */
  private handlers = new Map<string, EventHandler[]>()
  /** 远程事件应用回调（持久化后才发 ACK） */
  private applyHandler: ApplyHandler | null = null
  /** 后台扫描 timer */
  private scanTimer: ReturnType<typeof setInterval> | null = null
  /** 是否正在运行 */
  private running = false

  constructor(config: EventStreamConfig) {
    this.config = {
      ackTimeoutMs: 5000,
      retryIntervalMs: 3000,
      maxRetries: 10,
      dedupCapacity: 10000,
      catchupBatchSize: 100,
      stallThreshold: 100,
      ...config,
    }
    this.bus = config.eventBus
    this.wal = new StreamWal(config.walDir)
    this.logger = new Logger('EventStream')
    this.dedup = new DedupRing(this.config.dedupCapacity!)
  }

  /** 快捷构造 Omit<GraphEvent, 'nodeId'> */
  private _busEvent(type: string, data: Record<string, unknown>): { type: GraphEventType; timestamp: number; data: Record<string, unknown> } {
    return { type: type as GraphEventType, timestamp: Date.now(), data }
  }

  get isOpen(): boolean { return this.wal.isOpen }

  /**
   * 打开 StreamWal 并订阅 EventBus
   */
  open(): void {
    if (this.wal.isOpen) return
    this.wal.open()
    this.running = true

    // 从本地 WAL 恢复 seq
    this._restoreSeq()

    // 订阅 EventBus 所有事件
    this._subscribeBus()

    // 启动扫描
    this._startScan()
  }

  /**
   * 关闭 EventStream
   */
  async close(): Promise<void> {
    this.running = false
    if (this.scanTimer) {
      clearInterval(this.scanTimer)
      this.scanTimer = null
    }
    this.wal.close()
    this.handlers.clear()
    this.pendingTracker.clear()
  }

  /**
   * 注册事件处理器
   */
  on(type: string, handler: EventHandler): void {
    const list = this.handlers.get(type) || []
    list.push(handler)
    this.handlers.set(type, list)
  }

  /**
   * 移除事件处理器
   */
  off(type: string, handler: EventHandler): void {
    const list = this.handlers.get(type) || []
    this.handlers.set(type, list.filter(h => h !== handler))
  }

  /**
   * 注册远程事件应用回调
   *
   * 当收到远程节点的事件时，先调用此回调完成本地持久化，再发 ACK。
   * 确保 ACK 回来时数据已写入远程存储。
   */
  registerApplyHandler(handler: ApplyHandler): void {
    this.applyHandler = handler
  }

  /**
   * 发送可靠事件
   *
   * 1. 写入本地 WAL（PENDING 状态）
   * 2. 通过 EventBus 发布
   * 3. 记录 tracking 等待 ACK
   */
  emit(event: { type: string; data: Record<string, unknown>; timestamp?: number }): void {
    if (!this.running) {
      throw new Error('EventStream is not open')
    }
    const msg = this._buildMessage(event)
    this._appendAndPublish(msg)
  }

  /**
   * 发送并同步等待指定数量的远程 ACK
   *
   * 用于 Multi-Leader 同步复制：写入本地后等待其他节点持久化确认
   */
  async emitSync(event: { type: string; data: Record<string, unknown>; timestamp?: number }, expectedAcks: number, timeoutMs = 30000): Promise<number> {
    if (!this.running) throw new Error('EventStream is not open')
    if (expectedAcks <= 0) {
      this.emit(event)
      return 0
    }

    const msg = this._buildMessage(event)
    this._appendAndPublish(msg)

    return new Promise<number>((resolve, reject) => {
      let ackCount = 0
      let settled = false


      const ackHandler = (evt: GraphEvent) => {
        if (settled) return
        const ackMsgId = evt.data.msgId as string
        if (ackMsgId === msg.msgId) {
          ackCount++
          if (ackCount >= expectedAcks) {
            settled = true
            this.bus.off('event:ack', ackHandler as any)
            clearTimeout(timer)
            resolve(ackCount)
          }
        }
      }

      this.bus.on('event:ack', ackHandler as any)

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          this.bus.off('event:ack', ackHandler as any)
          reject(new Error(`emitSync timeout after ${timeoutMs}ms: got ${ackCount}/${expectedAcks} ACKs`))
        }
      }, timeoutMs)

      if (typeof timer === 'object' && 'unref' in timer) {
        (timer as any).unref()
      }
    })
  }

  /** 构建内部消息 */
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

  /** 持久化 + 发布 + 本地触发 */
  private _appendAndPublish(msg: StreamMessage): void {
    this.wal.append(msg)
    this.bus.emit(this._busEvent('node:created', { __es_msg: msg }))
    this.pendingTracker.set(msg.msgId, { sentAt: Date.now(), retries: 0 })
    this._emitLocal(msg)
  }

  /**
   * 请求完整回放（用于新节点加入时的追赶）
   * 发送 event:sync 到所有远程节点
   */
  requestSync(): void {
    if (!this.running) return
    this.bus.emit(this._busEvent('event:sync', { requester: this.config.nodeId, lastSeq: this.seq }))
  }

  // ── 内部 ─────────────────────────

  private _restoreSeq(): void {
    // 从 WAL 找到最大 seq，并将 PENDING 消息重新加入 pendingTracker
    try {
      const all = this.wal.replay(0)
      for (const msg of all) {
        if (msg.seq > this.seq) this.seq = msg.seq
      }

      // Crash recovery: 将有 seq 的 PENDING 消息加入 tracker 等待重发
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

  private _subscribeBus(): void {
    // 订阅所有事件类型
    const controlTypes = new Set(['event:ack', 'event:sync', 'event:sync-batch'])

    // EventBus 不能按类型过滤，我们通过 on 收到所有远程事件后过滤
    // 利用 EventBus 现有的 on 机制
    const types: GraphEventType[] = [
      'node:created', 'node:updated', 'node:deleted',
      'edge:created', 'edge:updated', 'edge:deleted',
      'backup:start', 'backup:complete',
      'graph:cleared',
      'cluster:node-joined', 'cluster:node-left',
      'cluster:leader-changed',
      'event:ack', 'event:sync', 'event:sync-batch',
    ]

    for (const t of types) {
      this.bus.on(t, (evt: GraphEvent) => {
        if (evt.nodeId === this.config.nodeId) return // 跳过自己（Raft leader 场景）

        if (controlTypes.has(evt.type)) {
          this._onControlMessage(evt)
          return
        }

        this._onDataEvent(evt)
      })
    }
  }

  private _onDataEvent(evt: GraphEvent): void {
    const raw = evt.data.__es_msg as StreamMessage | undefined
    if (!raw) return // 非 EventStream 消息，忽略（兼容旧版无 EventStream 的事件）

    // 1. 去重
    if (this.dedup.has(raw.msgId)) return
    this.dedup.add(raw.msgId)

    if (this.applyHandler) {
      // 有 applyHandler：先持久化，再发 ACK
      this.applyHandler(raw)
        .then(() => {
          this.bus.emit(this._busEvent('event:ack', { msgId: raw.msgId, nodeId: raw.nodeId }))
          this.wal.markConsumed([raw.msgId])
          this._emitLocal(raw)
        })
        .catch((err) => {
          console.error(`[${this.config.nodeId}] applyHandler error for ${raw.msgId}: ${err.message}`)
          // 不发送 ACK — 写入失败，发送端会超时重试
        })
    } else {
      // 无 applyHandler：立刻发 ACK（向后兼容 fire-and-forget 模式）
      this.bus.emit(this._busEvent('event:ack', { msgId: raw.msgId, nodeId: raw.nodeId }))
      this.wal.markConsumed([raw.msgId])
      this._emitLocal(raw)
    }
  }

  private _onControlMessage(evt: GraphEvent): void {
    switch (evt.type) {
      case 'event:ack': {
        const msgId = evt.data.msgId as string
        if (msgId) {
          this.pendingTracker.delete(msgId)
          this.wal.acknowledge([msgId])
        }
        break
      }

      case 'event:sync': {
        // 收到 SYNC 请求：从 WAL 读取缺失消息，批量回复
        const requester = evt.data.requester as string
        const lastSeq = evt.data.lastSeq as number
        this._handleSyncRequest(requester, lastSeq)
        break
      }

      case 'event:sync-batch': {
        // 收到 SYNC 回复：重放接收到的消息
        const msgs = evt.data.msgs as StreamMessage[] | undefined
        if (msgs) {
          for (const msg of msgs) {
            if (this.dedup.has(msg.msgId)) continue
            this.dedup.add(msg.msgId)
            this._emitLocal(msg)
            // 追赶来的消息也回传 ACK
            this.bus.emit(this._busEvent('event:ack', { msgId: msg.msgId, nodeId: msg.nodeId }))
          }
        }
        break
      }
    }
  }

  private _handleSyncRequest(requester: string, fromSeq: number): void {
    if (requester === this.config.nodeId) return

    const msgs = this.wal.replay(fromSeq + 1)
    if (msgs.length === 0) return

    const batchSize = this.config.catchupBatchSize!

    for (let i = 0; i < msgs.length; i += batchSize) {
      const batch = msgs.slice(i, i + batchSize)
      this.bus.emit(this._busEvent('event:sync-batch', { msgs: batch }))
    }
  }

  private _startScan(): void {
    // 主扫描：重试超时未 ACK 消息
    this.scanTimer = setInterval(() => {
      this._scanPending()
    }, this.config.retryIntervalMs!)
    this.scanTimer.unref()

    // WAL 清理：每小时 prune 一次，保留 1 小时窗口
    const pruneTimer = setInterval(() => {
      this.wal.pruneByTimestamp(Date.now() - 3600000)
    }, 3600000)
    pruneTimer.unref()
  }

  private _scanPending(): void {
    const now = Date.now()
    const timeout = this.config.ackTimeoutMs!

    // 重试超时未 ACK 的消息
    for (const [msgId, info] of this.pendingTracker) {
      if (now - info.sentAt < timeout) continue

      info.retries++

      // 每 10 次打印一次 warn（持续重试，不放弃）
      if (info.retries % 10 === 0) {
        this.logger.warn(`EventStream: ${msgId} still pending after ${info.retries} retries`)
      }

      // 达到存活阈值时触发告警回调
      if (this.config.onStall && info.retries === this.config.stallThreshold) {
        const msg = this.wal.readPending(Date.now() + 3600000).find(m => m.msgId === msgId)
        this.config.onStall({
          msgId,
          seq: msg?.seq ?? 0,
          type: msg?.type ?? 'unknown',
          retries: info.retries,
          durationMs: Date.now() - info.sentAt,
        })
      }

      // 从 WAL 读取原始消息
      const pendingMsgs = this.wal.readPending(now)
      const msg = pendingMsgs.find(m => m.msgId === msgId)
      if (!msg) {
        // WAL 中已不存在（可能已被 acknowledge 但 tracker 未同步）
        this.pendingTracker.delete(msgId)
        continue
      }

      // 重发
      this.bus.emit(this._busEvent('node:created', { __es_msg: msg }))

      info.sentAt = now
      this.logger.info(`EventStream: retry ${msgId} (attempt ${info.retries})`)
    }
  }

  private _emitLocal(msg: StreamMessage): void {
    const list = this.handlers.get(msg.type) || []
    for (const handler of list) {
      try {
        handler(msg)
      } catch (err) {
        this.logger.error(`EventStream handler error: ${(err as Error).message}`)
      }
    }
  }
}
