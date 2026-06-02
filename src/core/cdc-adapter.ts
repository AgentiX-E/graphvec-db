/**
 * cdc-adapter.ts — CDC 变更数据捕获适配器
 *
 * 挂接到 EventStream 的 emit 路径，将图变更事件转为标准化 CDC 事件，
 * 供外部系统通过 WebSocket / HTTP Long-Polling / Webhook 消费。
 *
 * GAP-60 增强：
 * - 新增 PropertyFilter 按属性值过滤
 * - CdcFilter.properties 支持 eq/neq/gt/gte/lt/lte/exists 操作符
 * - querySince 支持属性过滤
 *
 * 架构：
 *   GraphEngine → EventStream.emit()
 *     → EventStream 的 handlers 回调（已注册 on()）
 *       → CdcAdapter.onNodeEvent / onEdgeEvent
 *         → CdcEventStore 持久化（WAL 风格）
 *           → WebSocket / HTTP / Webhook 订阅者接收
 *
 * 事件格式：
 *   {
 *     op: "create" | "update" | "delete",
 *     entity: "node" | "edge",
 *     before?: Record<string, unknown>,
 *     after?: Record<string, unknown>,
 *     seq: number,
 *     ts: number
 *   }
 *
 * 复用 SegmentStreamWal 的 seq 作为 offset 标记，
 * 客户端通过 seq 参数实现断点续传。
 */

import type { StreamMessage } from './segment-stream-wal'

export type CdcOp = 'create' | 'update' | 'delete'
export type CdcEntity = 'node' | 'edge'

/**
 * CDC 事件标准格式
 */
export interface CdcEvent {
  op: CdcOp
  entity: CdcEntity
  /** 变更前的快照（如有） */
  before?: Record<string, unknown>
  /** 变更后的快照 */
  after?: Record<string, unknown>
  seq: number
  ts: number
}

/**
 * 属性值过滤操作符。
 * eq=等于, neq=不等于, gt=大于, gte=大于等于, lt=小于, lte=小于等于,
 * exists=属性存在性检查（值是否存在，忽略比较值）。
 */
export type CdcPropertyOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists'

/**
 * 属性值过滤条件。
 * - op='exists' 时忽略 value
 * - 字符串比较按字典序
 * - 数字比较按数值大小
 */
export interface CdcPropertyFilter {
  op: CdcPropertyOp
  value?: string | number
}

/**
 * CDC 事件过滤条件
 */
export interface CdcFilter {
  /** 只接收指定 label/type 的事件，空数组或 undefined 表示全部接收 */
  labels?: string[]
  /** 只接收指定操作类型，空数组或 undefined 表示全部接收 */
  ops?: CdcOp[]
  /** 只接收指定实体类型 */
  entities?: CdcEntity[]
  /**
   * 按属性值过滤。
   * 键为属性名，值为过滤条件。
   * 多个属性之间为 AND 关系（必须所有条件都匹配）。
   * 只对 after（create/update）和 before（delete）中的属性进行匹配。
   */
  properties?: Record<string, CdcPropertyFilter>
}

/**
 * CDC 事件接收回调
 */
export type CdcEventHandler = (event: CdcEvent) => void

// ── 节点/边事件类型常量 ────────────────
export const NODE_CREATED = 'node:created'
export const NODE_DELETED = 'node:deleted'
export const EDGE_CREATED = 'edge:created'
export const EDGE_DELETED = 'edge:deleted'

// 同时支持 graph-engine 现有的更新事件
export const NODE_UPDATED = 'node:updated'
export const EDGE_UPDATED = 'edge:updated'

/**
 * 判断 StreamMessage 是否包含节点或边的前后快照。
 * 对于 GraphEngine 的变更事件，data 中包含 id/typeId/name/props 等字段。
 */
function extractBeforeAfter(
  type: string,
  data: Record<string, unknown>,
): { before?: Record<string, unknown>; after?: Record<string, unknown>; entity: CdcEntity } {
  if (type.startsWith('node:')) {
    return { entity: 'node', after: data as Record<string, unknown> }
  } else {
    return { entity: 'edge', after: data as Record<string, unknown> }
  }
}

/**
 * 检查属性的值是否符合 CdcPropertyFilter 条件。
 * 用于属性级过滤。
 *
 * @param actualVal  事件中的实际属性值
 * @param filter     过滤条件
 * @returns true 如果匹配
 */
function matchesPropertyFilter(actualVal: unknown, filter: CdcPropertyFilter): boolean {
  switch (filter.op) {
    case 'exists':
      return actualVal !== undefined && actualVal !== null

    case 'eq': {
      if (filter.value === undefined) return actualVal === undefined || actualVal === null
      return actualVal === filter.value
    }

    case 'neq': {
      if (filter.value === undefined) return actualVal !== undefined && actualVal !== null
      return actualVal !== filter.value
    }

    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (filter.value === undefined) return false
      if (typeof actualVal !== 'number' && typeof actualVal !== 'string') return false
      if (typeof filter.value !== typeof actualVal) {
        // 尝试数值比较
        const numActual = Number(actualVal)
        const numFilter = Number(filter.value)
        if (isNaN(numActual) || isNaN(numFilter)) return false
        return compare(numActual, numFilter, filter.op)
      }
      return compare(actualVal as string | number, filter.value, filter.op)
    }

    default:
      return false
  }
}

/**
 * 数值/字符串比较内部函数
 */
function compare(a: string | number, b: string | number, op: CdcPropertyOp): boolean {
  switch (op) {
    case 'gt': return a > b
    case 'gte': return a >= b
    case 'lt': return a < b
    case 'lte': return a <= b
    default: return false
  }
}

/**
 * CdcAdapter — CDC 变更数据捕获适配器
 *
 * 事件流：
 *   CdcAdapter.onNodeEvent(msg) / onEdgeEvent(msg)
 *     → filters (按 label/type 过滤)
 *     → 转换为 CdcEvent
 *     → 存储到 RingBuffer（最近 N 条）+ 通知所有订阅者
 */
export class CdcAdapter {
  /** 事件序列号 */
  private seq = 0
  /** RingBuffer 存储最近事件（最大 10000 条），用于断点续传 */
  private buffer: CdcEvent[] = []
  /** RingBuffer 最大容量 */
  private maxBufferSize: number
  /** 当前订阅者 */
  private subscribers: Map<string, { handler: CdcEventHandler; filter?: CdcFilter }> = new Map()
  /** 标签订阅映射表（快速查找某个 label 的订阅者） */
  private labelSubscriberIds: Map<string, string[]> = new Map()
  /** 默认过滤器（全局过滤，对所有订阅者生效） */
  private defaultFilter?: CdcFilter

  constructor(options?: { maxBufferSize?: number; defaultFilter?: CdcFilter }) {
    this.maxBufferSize = options?.maxBufferSize ?? 10000
    this.defaultFilter = options?.defaultFilter
  }

  /**
   * 获取当前序列号（当前最新 seq）。
   */
  get currentSeq(): number {
    return this.seq
  }

  /**
   * 处理 EventStream 的 StreamMessage。
   * 将其转换为 CdcEvent 并分发给订阅者。
   *
   * @param msg - EventStream 消息
   */
  handleEvent(msg: StreamMessage): void {
    const { type, data, seq } = msg
    let op: CdcOp
    let entity: CdcEntity
    let before: Record<string, unknown> | undefined
    let after: Record<string, unknown> | undefined

    switch (type) {
      case NODE_CREATED:
      case NODE_UPDATED:
        op = type === NODE_CREATED ? 'create' : 'update'
        entity = 'node'
        after = data as Record<string, unknown>
        break
      case NODE_DELETED:
        op = 'delete'
        entity = 'node'
        before = data as Record<string, unknown>
        break
      case EDGE_CREATED:
      case EDGE_UPDATED:
        op = type === EDGE_CREATED ? 'create' : 'update'
        entity = 'edge'
        after = data as Record<string, unknown>
        break
      case EDGE_DELETED:
        op = 'delete'
        entity = 'edge'
        before = data as Record<string, unknown>
        break
      default:
        return // 不识别的类型，跳过
    }

    // 提取 label/type 信息用于过滤
    const label = data.label as string | undefined
    const typeId = data.typeId as number | undefined

    this.seq++
    const cdcEvent: CdcEvent = {
      op,
      entity,
      before,
      after,
      seq: this.seq,
      ts: msg.timestamp,
    }

    // 存储到环形缓冲区
    this._storeEvent(cdcEvent)

    // 分发给订阅者
    this._dispatch(cdcEvent, label, typeId)
  }

  /**
   * 将 CdcEvent 存储到环形缓冲区。
   */
  private _storeEvent(event: CdcEvent): void {
    this.buffer.push(event)
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.shift()
    }
  }

  /**
   * 将事件分发给所有匹配的订阅者。
   */
  private _dispatch(event: CdcEvent, label?: string, typeId?: number): void {
    for (const [id, sub] of this.subscribers) {
      if (this._matchesFilter(event, sub.filter, label, typeId)) {
        try {
          sub.handler(event)
        } catch (err) {
          // 订阅者异常不应影响其他订阅者
          console.error(`CdcAdapter: subscriber ${id} handler error:`, err)
        }
      }
    }
  }

  /**
   * 检查 CDC 事件是否匹配属性过滤条件。
   * 对 create/update 事件匹配 after 中的属性，对 delete 事件匹配 before 中的属性。
   */
  private _matchesPropertiesFilter(
    event: CdcEvent,
    properties: Record<string, CdcPropertyFilter>,
  ): boolean {
    const props = event.op === 'delete' ? event.before : event.after
    if (!props) return false

    for (const [propName, propFilter] of Object.entries(properties)) {
      const actualVal = props[propName]
      if (!matchesPropertyFilter(actualVal, propFilter)) {
        return false
      }
    }

    return true
  }

  /**
   * 检查事件是否匹配过滤条件。
   */
  private _matchesFilter(
    event: CdcEvent,
    filter?: CdcFilter,
    label?: string,
    _typeId?: number,
  ): boolean {
    // 默认过滤器
    const effectiveFilter = filter ?? this.defaultFilter
    if (!effectiveFilter) return true

    // 过滤操作类型
    if (effectiveFilter.ops && effectiveFilter.ops.length > 0) {
      if (!effectiveFilter.ops.includes(event.op)) return false
    }

    // 过滤实体类型
    if (effectiveFilter.entities && effectiveFilter.entities.length > 0) {
      if (!effectiveFilter.entities.includes(event.entity)) return false
    }

    // 过滤 label
    if (effectiveFilter.labels && effectiveFilter.labels.length > 0) {
      if (!label) return false
      if (!effectiveFilter.labels.includes(label)) return false
    }

    // GAP-60: 按属性值过滤
    if (effectiveFilter.properties && Object.keys(effectiveFilter.properties).length > 0) {
      if (!this._matchesPropertiesFilter(event, effectiveFilter.properties)) {
        return false
      }
    }

    return true
  }

  // ── 订阅者管理 ──────────────────────

  /**
   * 注册一个 CDC 事件订阅者。
   *
   * @param id - 订阅者唯一 ID
   * @param handler - 事件回调
   * @param filter - 可选过滤条件
   */
  subscribe(id: string, handler: CdcEventHandler, filter?: CdcFilter): void {
    this.subscribers.set(id, { handler, filter })
    // 如果 filter 指定了 labels，建立反向索引
    if (filter?.labels) {
      for (const label of filter.labels) {
        const ids = this.labelSubscriberIds.get(label) || []
        if (!ids.includes(id)) {
          ids.push(id)
          this.labelSubscriberIds.set(label, ids)
        }
      }
    }
  }

  /**
   * 注销一个 CDC 事件订阅者。
   */
  unsubscribe(id: string): void {
    this.subscribers.delete(id)
    // 清理 label 索引
    for (const [, ids] of this.labelSubscriberIds) {
      const idx = ids.indexOf(id)
      if (idx !== -1) ids.splice(idx, 1)
    }
  }

  /**
   * 获取所有订阅者 ID。
   */
  getSubscriberIds(): string[] {
    return Array.from(this.subscribers.keys())
  }

  // ── 事件查询 ──────────────────────

  /**
   * 查询从指定 seq 之后的所有事件（用于断点续传）。
   *
   * @param sinceSeq - 起始 seq（不包含）
   * @param filter - 可选过滤条件
   * @returns 匹配的事件列表
   */
  querySince(sinceSeq: number, filter?: CdcFilter): CdcEvent[] {
    const results: CdcEvent[] = []
    for (const event of this.buffer) {
      if (event.seq <= sinceSeq) continue
      // 基础过滤
      if (filter?.ops && !filter.ops.includes(event.op)) continue
      if (filter?.entities && !filter.entities.includes(event.entity)) continue

      // GAP-60: 属性过滤
      if (filter?.properties && Object.keys(filter.properties).length > 0) {
        if (!this._matchesPropertiesFilter(event, filter.properties)) continue
      }

      results.push(event)
    }
    return results
  }

  /**
   * 清除缓冲区。
   */
  clear(): void {
    this.buffer = []
  }

  /**
   * 获取缓冲区长度。
   */
  get bufferLength(): number {
    return this.buffer.length
  }
}
