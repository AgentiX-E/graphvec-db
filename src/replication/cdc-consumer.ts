/**
 * cdc-consumer.ts — 基于 EventStream 的 CDC (Change Data Capture) Consumer Group
 *
 * 将图引擎的变更事件（node:created, node:deleted, edge:created, edge:deleted）
 * 转为结构化 CDC 变更记录，支持：
 *   - 单调递增 seq + offset 追踪
 *   - 断点续传（从指定 offset 开始消费）
 *   - pause/resume 流量控制
 *   - 批量消费
 *   - Consumer Group 管理多个消费者
 *
 * 典型用途：
 *   - 实时同步到 ElasticSearch
 *   - CDC 到数据仓库
 *   - 审计日志
 */

import { EventStream, EventHandler } from '../core/event-stream'
import { StreamMessage } from '../core/segment-stream-wal'
import { NodeId } from '../types'
import { Logger } from '../ops/logger'

// ──────────────────────────────────────────
// CDC 变更记录类型
// ──────────────────────────────────────────

export type CDCOperation = 'upsert_node' | 'upsert_edge' | 'delete_node' | 'delete_edge'

export interface CDCChangeRecord {
  /** 单调递增序列号（对应 StreamMessage.seq） */
  seq: number
  /** 操作类型 */
  operation: CDCOperation
  /** 节点 ID（node 操作时必填） */
  nodeId?: NodeId
  /** 边标识（edge 操作时使用格式 "src:dst:typeId"） */
  edgeKey?: string
  /** 毫秒时间戳 */
  timestamp: number
  /** 原始事件数据（保留完整上下文供下游自定义处理） */
  rawData?: Record<string, unknown>
}

export type CDCErrorHandler = (err: Error, record: CDCChangeRecord) => void

// ──────────────────────────────────────────
// CDC 消费者
// ──────────────────────────────────────────

export interface CDCConsumerConfig {
  /** 起始 offset（断点续传时使用）。默认为 0（从头开始消费） */
  startOffset?: number
  /** 批处理大小，默认 1（单条立即回调） */
  batchSize?: number
  /** 轮询间隔（ms），仅在 pause/resume 模式下有效。默认 10ms */
  pollIntervalMs?: number
  /** 每条 CDC 记录的回调 */
  onRecord?: (record: CDCChangeRecord) => void
  /** 错误处理回调 */
  onError?: CDCErrorHandler
}

/**
 * CDCConsumer — 单个 CDC 消费者实例
 *
 * 订阅 EventStream 的变更事件，将其转换为结构化的 CDCChangeRecord，
 * 通过回调逐条或批量推送给下游消费者。
 */
export class CDCConsumer {
  /** 当前消费进度（已消费的最大 seq） */
  private _offset: number
  private readonly config: Required<CDCConsumerConfig>
  /** 绑定的 EventStream */
  private eventStream: EventStream | null = null
  /** 已注册的事件处理函数引用（用于取消订阅） */
  private handlers: Map<string, EventHandler> = new Map()
  /** pause/resume 控制 */
  private _paused = false
  /** 是否已关闭 */
  private _closed = false
  private logger: Logger

  constructor(config: CDCConsumerConfig = {}) {
    this.logger = new Logger('CDCConsumer')
    this.config = {
      startOffset: config.startOffset ?? 0,
      batchSize: config.batchSize ?? 1,
      pollIntervalMs: config.pollIntervalMs ?? 10,
      onRecord: config.onRecord ?? (() => {}),
      onError: config.onError ?? ((err) => this.logger.error(err.message)),
    }
    this._offset = this.config.startOffset
  }

  /**
   * 订阅 EventStream 的变更事件
   */
  subscribe(eventStream: EventStream): void {
    if (!eventStream) {
      throw new Error('EventStream cannot be null')
    }
    if (!eventStream.isOpen) {
      throw new Error('EventStream must be open before subscribing')
    }
    this.eventStream = eventStream

    // 注册各变更事件类型的处理器
    const eventTypes = ['node:created', 'node:updated', 'node:deleted', 'edge:created', 'edge:updated', 'edge:deleted']
    for (const eventType of eventTypes) {
      const handler: EventHandler = (msg) => this._handleStreamMessage(msg)
      this.handlers.set(eventType, handler)
      eventStream.on(eventType, handler)
    }
  }

  /**
   * 暂停消费（已提交的事件仍会走 handler，但 handler 内会丢弃）
   */
  pause(): void {
    this._paused = true
  }

  /**
   * 恢复消费
   */
  resume(): void {
    this._paused = false
  }

  /** 当前是否暂停 */
  get paused(): boolean {
    return this._paused
  }

  /**
   * 获取当前 offset（已成功消费的最新 seq）
   */
  getOffset(): number {
    return this._offset
  }

  /**
   * 关闭消费者，取消所有事件订阅
   */
  close(): void {
    if (this._closed) return
    this._closed = true
    this._paused = false

    if (this.eventStream) {
      for (const [eventType, handler] of this.handlers) {
        this.eventStream.off(eventType, handler)
      }
    }
    this.handlers.clear()
    this.eventStream = null
  }

  /** 是否已关闭 */
  get closed(): boolean {
    return this._closed
  }

  // ── 内部方法 ─────────────────────────

  /**
   * 将 StreamMessage 转为 CDCChangeRecord
   */
  private _toCDCRecord(msg: StreamMessage): CDCChangeRecord | null {
    const { type, data, seq, timestamp } = msg

    let operation: CDCOperation | null = null
    let nodeId: NodeId | undefined
    let edgeKey: string | undefined

    switch (type) {
      case 'node:created':
      case 'node:updated':
        operation = 'upsert_node'
        nodeId = data.id as NodeId
        break
      case 'node:deleted':
        operation = 'delete_node'
        nodeId = data.id as NodeId
        break
      case 'edge:created':
      case 'edge:updated':
        operation = 'upsert_edge'
        edgeKey = `${data.src}:${data.dst}:${data.typeId}`
        break
      case 'edge:deleted':
        operation = 'delete_edge'
        edgeKey = `${data.src}:${data.dst}:${data.typeId}`
        break
      default:
        return null
    }

    return {
      seq,
      operation,
      nodeId,
      edgeKey,
      timestamp,
      rawData: data,
    }
  }

  /**
   * 处理一条 StreamMessage
   */
  private _handleStreamMessage(msg: StreamMessage): void {
    if (this._closed || this._paused) return

    // 跳过已消费的消息（seq <= offset）
    if (msg.seq <= this._offset) return

    let record: CDCChangeRecord
    try {
      const converted = this._toCDCRecord(msg)
      if (!converted) return // 不认识的类型，跳过
      record = converted
    } catch (err) {
      this.config.onError(err as Error, {
        seq: msg.seq,
        operation: 'upsert_node',
        timestamp: Date.now(),
      })
      return
    }

    try {
      this._offset = record.seq
      this.config.onRecord(record)
    } catch (err) {
      this.config.onError(err as Error, record)
    }
  }
}

// ──────────────────────────────────────────
// CDC 消费者组
// ──────────────────────────────────────────

export interface CDCConsumerGroupConfig {
  /** 默认配置（被每个 addConsumer 继承） */
  defaults?: CDCConsumerConfig
}

/**
 * CDCConsumerGroup — 管理多个 CDC 消费者
 *
 * 适用于需要将同一变更流分发给多个下游的场景
 * （如同时同步到 ES 和数仓）。
 * 注意：当前实现每个 consumer 独立消费同一事件流，
 * 每个 consumer 有独立的 offset。
 * 未来可扩展为 partition-based 模式。
 */
export class CDCConsumerGroup {
  private consumers: CDCConsumer[] = []
  private defaults: CDCConsumerConfig

  constructor(config: CDCConsumerGroupConfig = {}) {
    this.defaults = config.defaults ?? {}
  }

  /**
   * 添加一个消费者
   *
   * @param config - 消费者配置（与 defaults 合并）
   * @returns 创建的 CDCConsumer 实例
   */
  addConsumer(config: CDCConsumerConfig = {}): CDCConsumer {
    const merged: CDCConsumerConfig = { ...this.defaults, ...config }
    const consumer = new CDCConsumer(merged)
    this.consumers.push(consumer)
    return consumer
  }

  /**
   * 批量订阅所有消费者到 EventStream
   */
  subscribeAll(eventStream: EventStream): void {
    for (const consumer of this.consumers) {
      consumer.subscribe(eventStream)
    }
  }

  /**
   * 暂停所有消费者
   */
  pauseAll(): void {
    for (const consumer of this.consumers) {
      consumer.pause()
    }
  }

  /**
   * 恢复所有消费者
   */
  resumeAll(): void {
    for (const consumer of this.consumers) {
      consumer.resume()
    }
  }

  /**
   * 关闭所有消费者
   */
  closeAll(): void {
    for (const consumer of this.consumers) {
      consumer.close()
    }
    this.consumers = []
  }

  /**
   * 获取消费者列表
   */
  getConsumers(): ReadonlyArray<CDCConsumer> {
    return [...this.consumers]
  }

  /** 消费者数量 */
  get size(): number {
    return this.consumers.length
  }
}
