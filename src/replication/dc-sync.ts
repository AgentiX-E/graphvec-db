import { Publisher, Subscriber } from 'zeromq'
import { DeltaSync } from './delta-sync'
import { DCSyncConfig, DeltaMessage } from '../types'
import { Logger } from '../ops/logger'
import { HlcClock } from './hlc-clock'
import { Telemetry } from '../ops/otel'
import { MetricsCollector } from '../ops/otel-metrics'

/**
 * Conflict resolution strategy枚举
 */
export type ConflictResolution = 'accept' | 'reject' | 'merge'

/**
 * 纯函数：基于 HLC 时间戳的 LWW 冲突解决
 *
 * @param remote 远程 delta
 * @param localTimestamp 本地已应用的 HLC 时间戳（Optional）
 * @param strategy 冲突策略
 * @returns 'accept' — 接受远程变更 | 'reject' — 拒绝远程变更 | 'merge' — 合并双方
 */
export function resolveConflict(
  remote: { hlcTimestamp: Uint8Array },
  localTimestamp: Uint8Array | null,
  strategy: 'lww' | 'ignore' | 'crdt' = 'lww'
): ConflictResolution {
  if (strategy === 'ignore') return 'reject'
  if (strategy === 'crdt') return 'merge'

  // LWW: 比较 HLC 时间戳
  if (localTimestamp === null || localTimestamp.length === 0) {
    return 'accept'
  }

  // 解码 HLC 进行字节级比较
  // Uint8Array 按字典序比较即可（高位在前）
  for (let i = 0; i < Math.min(remote.hlcTimestamp.length, localTimestamp.length); i++) {
    if (remote.hlcTimestamp[i] > localTimestamp[i]) {
      return 'accept' // 远程更新 → accept
    }
    if (remote.hlcTimestamp[i] < localTimestamp[i]) {
      return 'reject' // 本地更新 → reject
    }
  }

  // 长度不同时的处理（长的更大）
  if (remote.hlcTimestamp.length > localTimestamp.length) return 'accept'
  if (remote.hlcTimestamp.length < localTimestamp.length) return 'reject'

  // 完全相等 → 不管谁先收到都不会丢失数据，接受即可
  return 'accept'
}

/**
 * DCSync — Cross-DC sync协调器
 *
 * 使用 ZMQ PUB/SUB 模式：
 * - PUB: 定时广播本 DC 的 delta 变更
 * - SUB: 接收其他 DC 的 delta 变更
 *
 * ZMQ 具有自动重连和消息缓冲，跨 DC 网络中断恢复后自动继续
 */
export class DCSync {
  private config: DCSyncConfig
  private deltaSync: DeltaSync
  private logger: Logger
  private pubSocket: Publisher
  private subSocket: Subscriber
  private _running = false
  /** 记录每个 dcId 最近应用的 HLC 时间戳（用于冲突解决） */
  private lastAppliedHlc: Map<string, Uint8Array> = new Map()
  private telemetry: Telemetry
  private metrics: MetricsCollector

  constructor(config: DCSyncConfig, deltaSync: DeltaSync) {
    this.config = config
    this.deltaSync = deltaSync
    this.logger = new Logger('DCSync')
    this.telemetry = Telemetry.getInstance()
    this.metrics = MetricsCollector.getInstance()
    this.pubSocket = new Publisher()
    this.subSocket = new Subscriber()
  }

  get isRunning(): boolean { return this._running }

  async start(): Promise<void> {
    await this.pubSocket.bind(this.config.zmqPubAddress)

    for (const peer of this.config.peers) {
      await this.subSocket.connect(peer.address)
    }

    this.subSocket.subscribe('')
    this._running = true

    this._startReceiveLoop()

    this.deltaSync.startAutoFlush(
      async (delta) => this.publishDelta(delta),
      this.config.syncIntervalMs ?? 100
    )
  }

  async stop(): Promise<void> {
    this._running = false
    this.deltaSync.stopAutoFlush()
    this.pubSocket.close()
    this.subSocket.close()
  }

  async publishDelta(delta: DeltaMessage): Promise<void> {
    return this.telemetry.traceAsync('dcsync.publish', async () => {
      const payload = JSON.stringify(delta)
      await this.pubSocket.send(['graph_delta', Buffer.from(payload)])
    })
  }

  private async _startReceiveLoop(): Promise<void> {
    for await (const [topic, msg] of this.subSocket) {
      if (!this._running) break
      if (topic.toString() === 'graph_delta') {
        try {
          const delta: DeltaMessage = JSON.parse(msg.toString())
          // LWW 冲突解决：总是接受远程变更（不丢写）
          // 在收到后通过 CRDT merge 保证数据完整（各 DC 本地写入保留）
          // 不做 reject 丢弃，只记录日志用于诊断
          const strategy = this.config.conflictStrategy ?? 'lww'
          const localTs = this.lastAppliedHlc.get(delta.dcId) ?? null
          if (strategy === 'lww' && localTs && localTs.length > 0) {
            const cmp = Buffer.from(delta.hlcTimestamp).compare(Buffer.from(localTs))
            if (cmp < 0) {
              this.logger.debug(`[DCSync] Delta from ${delta.dcId} is stale (local HLC ahead)`)
              // 不 reject，用 CRDT merge 保留双方版本
            }
          }
          // 总是接受并 merge
          const count = await this.deltaSync.receiveDelta(delta)
          // 更新该 DC 的最新 HLC 时间戳
          this.lastAppliedHlc.set(delta.dcId, delta.hlcTimestamp)
          if (count > 0) {
            this.logger.info(`[DCSync] Applied ${count} remote changes from ${delta.dcId}`)
          }
        } catch (err) {
          this.logger.error('[DCSync] Failed to process remote delta:', err as Error)
        }
      }
    }
  }
}
