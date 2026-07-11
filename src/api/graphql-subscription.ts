/**
 * graphql-subscription.ts — GraphQL Subscription via SSE
 *
 * 不引入新 npm 包，使用 Node.js 内置 http + EventEmitter（EventBus）实现。
 * 订阅图变更事件（node/edge created/updated/deleted），通过 SSE 推送。
 *
 * 单机和分布式均正常工作：
 * - 本节点变更 → EventStream.emit → EventBus.local.emit → SSE 推送
 * - 远端节点变更 → ZMQ broadcast → EventStream._emitLocal → EventBus.local.emit → SSE 推送
 *
 * 用法：
 * ```ts
 * const sub = new GraphQLSubscription(eventBus)
 * sub.subscribe(res, { events: 'node:created,node:deleted' })
 * ```
 *
 * SSE 输出格式：
 *   event: node:created
 *   data: {"id":1,"type":0,"name":"Alice","nodeId":"node-1"}
 */

import type { EventBus } from '../core/event-bus'
import type * as http from 'http'

// ── 类型 ────────────────────────────────────────────────

export type SubscriptionEventType =
  | 'node:created' | 'node:updated' | 'node:deleted'
  | 'edge:created' | 'edge:updated' | 'edge:deleted'

export interface SubscriptionOptions {
  /** 逗号分隔的事件类型列表，空=全部 */
  events?: string
}

/** 推送给客户端的变更事件（序列化为 JSON） */
export interface SubscriptionEvent {
  /** 事件类型，如 node:created */
  type: SubscriptionEventType
  /** 变更发生的时间戳 */
  timestamp: number
  /** 发出事件的Node ID */
  nodeId: string
  /** 变更数据 */
  data: Record<string, unknown>
}

// ── 订阅管理器 ──────────────────────────────────────────

type EventBusLike = {
  on(type: string, handler: (...args: any[]) => void): void
  off(type: string, handler: (...args: any[]) => void): void
}

export class GraphQLSubscription {
  private bus: EventBusLike
  /** 活跃的 SSE 连接数 */
  private _activeConnections = 0

  constructor(bus: EventBusLike) {
    this.bus = bus
  }

  /** 当前活跃连接数 */
  get activeConnections(): number {
    return this._activeConnections
  }

  /**
   * 订阅并建立 SSE 连接
   * @param res HTTP 响应对象（SSE 流）
   * @param opts 订阅选项
   * @returns 清理函数（断开时调用）
   */
  subscribe(
    res: http.ServerResponse,
    opts: SubscriptionOptions = {},
  ): () => void {
    const allowedTypes = this._parseEventFilter(opts.events)

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // 禁止 nginx 缓冲
      'Access-Control-Allow-Origin': '*',
    })

    // 发送初始连接确认
    this._sendSSE(res, 'connected', { timestamp: Date.now() })

    this._activeConnections++

    // 为每个订阅的事件类型注册 listener
    const handlers = new Map<string, (event: any) => void>()

    const allEvents: SubscriptionEventType[] = [
      'node:created', 'node:updated', 'node:deleted',
      'edge:created', 'edge:updated', 'edge:deleted',
    ]

    for (const eventType of allEvents) {
      if (allowedTypes.length > 0 && !allowedTypes.includes(eventType)) continue

      const handler = (event: any) => {
        // EventBus 事件的格式：EventBus.emit(type, fullEvent)
        // fullEvent 包含 nodeId, data 等
        const timestamp = event.timestamp ?? Date.now()
        const nodeId = event.nodeId ?? ''
        const eventData = event.data ?? event

        const subEvent: SubscriptionEvent = {
          type: eventType,
          timestamp,
          nodeId,
          data: typeof eventData === 'object' && eventData !== null
            ? eventData as Record<string, unknown>
            : { value: eventData },
        }

        this._sendSSE(res, eventType, subEvent)
      }

      this.bus.on(eventType, handler)
      handlers.set(eventType, handler)
    }

    // 返回清理函数
    return () => {
      for (const [eventType, handler] of handlers) {
        this.bus.off(eventType, handler)
      }
      this._activeConnections--
    }
  }

  /**
   * 解析事件过滤器字符串
   * 例如 "node:created,node:deleted" → ['node:created', 'node:deleted']
   * 空字符串或 undefined → []（全部订阅）
   */
  private _parseEventFilter(filter?: string): SubscriptionEventType[] {
    if (!filter || filter.trim() === '') return []
    return filter.split(',').map(s => s.trim()).filter(Boolean) as SubscriptionEventType[]
  }

  /**
   * 发送 SSE 消息
   */
  private _sendSSE(
    res: http.ServerResponse,
    eventType: string,
    data: unknown,
  ): void {
    try {
      const json = JSON.stringify(data)
      res.write(`event: ${eventType}\ndata: ${json}\n\n`)
    } catch {
      // 连接已关闭，忽略
    }
  }
}
