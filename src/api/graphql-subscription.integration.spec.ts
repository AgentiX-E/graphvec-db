/**
 * graphql-subscription.integration.spec.ts
 *
 * GraphQL Subscription 端到端集成测试。
 * 使用真实 LocalEventBus（非 mock）验证完整的 pub/sub → SSE 推送链路。
 *
 * 关键设计：
 * - LocalEventBus 实现了 EventBusLike 接口（on/emit/off/removeAllListeners）
 * - MockServerResponse 捕获所有 write() 调用，方便断言 SSE 格式和内容
 * - 不修改生产代码，所有逻辑在 spec 文件中
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { GraphQLSubscription, type SubscriptionEvent } from './graphql-subscription'
import type * as http from 'http'

// ── LocalEventBus ───────────────────────────────────────
//
// 模拟真实 EventBus 的核心行为：on/emit/off/removeAllListeners
// 不使用 ZMQ 或外部依赖，纯 Node.js EventEmitter 实现

class LocalEventBus {
  private listeners = new Map<string, Set<(...args: any[]) => void>>()

  on(type: string, handler: (...args: any[]) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set())
    }
    this.listeners.get(type)!.add(handler)
  }

  off(type: string, handler: (...args: any[]) => void): void {
    const set = this.listeners.get(type)
    if (set) {
      set.delete(handler)
      if (set.size === 0) this.listeners.delete(type)
    }
  }

  /**
   * 发射事件，格式与真实 EventBus.emit() 一致：
   * bus.on(type, handler) 收到 handler(fullEvent)
   * 其中 fullEvent 包含 nodeId, timestamp, data 等字段
   */
  emit(type: string, eventPayload: Record<string, unknown>): void {
    const set = this.listeners.get(type)
    if (!set) return
    // 构造完整的 GraphEvent-like 对象
    const fullEvent = {
      type,
      nodeId: eventPayload.nodeId ?? 'test-node',
      timestamp: eventPayload.timestamp ?? Date.now(),
      data: eventPayload.data ?? eventPayload,
    }
    for (const handler of set) {
      handler(fullEvent)
    }
  }

  removeAllListeners(): void {
    this.listeners.clear()
  }

  listenerCount(type?: string): number {
    if (type) {
      return this.listeners.get(type)?.size ?? 0
    }
    let count = 0
    for (const set of this.listeners.values()) {
      count += set.size
    }
    return count
  }
}

// ── Mock ServerResponse ─────────────────────────────────
//
// 模拟 Node.js http.ServerResponse，捕获所有 SSE write() 调用
// 支持断言 SSE 格式（event: xxx\ndata: {...}\n\n）

interface CapturedSSEChunk {
  event: string
  data: string
}

class MockServerResponse {
  /** 捕获的 SSE chunks（初始 connected 消息 + 事件推送） */
  chunks: CapturedSSEChunk[] = []

  writeHead = vi.fn()
  end = vi.fn()
  on = vi.fn()

  /** 标记此连接是否已 "关闭"（用于容错测试） */
  private _closed = false

  write: http.ServerResponse['write'] = vi.fn((chunk: any): boolean => {
    if (this._closed) {
      throw new Error('write after end')
    }
    const str = String(chunk)
    // 解析 SSE 格式: event: xxx\ndata: {...}\n\n
    const eventMatch = str.match(/^event: (.+)$/m)
    const dataMatch = str.match(/^data: (.+)$/m)
    if (eventMatch && dataMatch) {
      this.chunks.push({
        event: eventMatch[1],
        data: dataMatch[1],
      })
    }
    return true
  }) as any

  /** 设置 closed 状态（模拟连接已关闭） */
  setClosed(): void {
    this._closed = true
  }

  /** 重置捕获状态 */
  reset(): void {
    this.chunks = []
    vi.clearAllMocks()
  }
}

// ── 工具函数 ────────────────────────────────────────────

/**
 * 等待一段时间，让异步事件处理完成
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── 测试套件 ────────────────────────────────────────────

describe('GraphQLSubscription — 集成测试 (LocalEventBus)', () => {
  let bus: LocalEventBus
  let sub: GraphQLSubscription

  beforeEach(() => {
    bus = new LocalEventBus()
    sub = new GraphQLSubscription(bus)
  })

  afterEach(() => {
    bus.removeAllListeners()
  })

  // ── 测试 1: 完整 pub/sub 链路 ─────────────────────

  test('1. 注册 listener + 发射 → SSE 收到事件内容', () => {
    const res = new MockServerResponse()
    const cleanup = sub.subscribe(res as any)

    // 验证初始 connected 消息
    expect(res.chunks.length).toBeGreaterThanOrEqual(1)
    expect(res.chunks[0].event).toBe('connected')
    expect(() => JSON.parse(res.chunks[0].data)).not.toThrow()

    // 发射 node:created 事件
    bus.emit('node:created', {
      nodeId: 'node-1',
      data: { id: 1, name: 'Alice', type: 0 },
      timestamp: 1000,
    })

    // 验证 SSE 格式正确
    expect(res.chunks.length).toBe(2)
    const eventChunk = res.chunks[1]
    expect(eventChunk.event).toBe('node:created')

    // 验证 data 内容
    const parsed = JSON.parse(eventChunk.data)
    expect(parsed.type).toBe('node:created')
    expect(parsed.nodeId).toBe('node-1')
    expect(parsed.timestamp).toBe(1000)
    expect(parsed.data).toEqual({ id: 1, name: 'Alice', type: 0 })

    cleanup()
  })

  // ── 测试 2: 多个 subscription 独立通道 ────────────

  test('2. 多个 subscription 独立通道，各自收到事件', () => {
    const res1 = new MockServerResponse()
    const res2 = new MockServerResponse()
    const cleanup1 = sub.subscribe(res1 as any)
    const cleanup2 = sub.subscribe(res2 as any)

    // 每个连接都应收到初始 connected 消息
    expect(res1.chunks.length).toBe(1)
    expect(res2.chunks.length).toBe(1)

    // 发射事件
    bus.emit('node:created', {
      nodeId: 'node-1',
      data: { id: 1, name: 'Alice' },
      timestamp: 100,
    })

    // 两个连接都应收到事件
    expect(res1.chunks.length).toBe(2)
    expect(res2.chunks.length).toBe(2)

    // 验证两个连接收到的是相同内容
    expect(res1.chunks[1].data).toBe(res2.chunks[1].data)
    const parsed = JSON.parse(res1.chunks[1].data)
    expect(parsed.data.name).toBe('Alice')

    cleanup1()
    cleanup2()
  })

  // ── 测试 3: 事件过滤 ──────────────────────────────

  test('3. 事件过滤：不同 subscriber 收到不同事件', () => {
    const resA = new MockServerResponse()
    const resB = new MockServerResponse()

    // Subscriber A 只订阅 node:created，B 只订阅 edge:created
    const cleanupA = sub.subscribe(resA as any, { events: 'node:created' })
    const cleanupB = sub.subscribe(resB as any, { events: 'edge:created' })

    // 重置初始 connected 消息
    resA.reset()
    resB.reset()

    // 发射 node:created — 只影响 A
    bus.emit('node:created', {
      nodeId: 'node-1',
      data: { id: 1 },
      timestamp: 100,
    })
    expect(resA.chunks.length).toBe(1)
    expect(resB.chunks.length).toBe(0)

    // 发射 edge:created — 只影响 B
    resA.reset()
    bus.emit('edge:created', {
      nodeId: 'node-2',
      data: { src: 10, dst: 20 },
      timestamp: 200,
    })
    expect(resA.chunks.length).toBe(0)
    expect(resB.chunks.length).toBe(1)

    // 验证 B 收到的是 edge 事件
    const parsed = JSON.parse(resB.chunks[0].data)
    expect(parsed.type).toBe('edge:created')
    expect(parsed.data.src).toBe(10)

    cleanupA()
    cleanupB()
  })

  // ── 测试 4: cleanup 后 listener 移除 ─────────────

  test('4. cleanup 后 listener 移除，不再收到事件', () => {
    const res = new MockServerResponse()
    const cleanup = sub.subscribe(res as any)

    // 验证 cleanup 前有 listener
    expect(bus.listenerCount()).toBeGreaterThan(0)

    // 发射事件 → 应该收到
    bus.emit('node:created', {
      nodeId: 'node-1',
      data: { id: 1 },
      timestamp: 100,
    })
    expect(res.chunks.length).toBe(2) // connected + event

    // cleanup
    cleanup()

    // 验证 cleanup 后所有 listener 被移除
    expect(bus.listenerCount()).toBe(0)

    // 重置并再次发射
    res.reset()
    bus.emit('node:created', {
      nodeId: 'node-2',
      data: { id: 2 },
      timestamp: 200,
    })

    // cleanup 后不应再收到
    expect(res.chunks.length).toBe(0)
  })

  // ── 测试 5: SSE 格式验证 ─────────────────────────

  test('5. SSE 格式正确：data: 前缀，\\n\\n 分隔', () => {
    const res = new MockServerResponse()
    const cleanup = sub.subscribe(res as any)

    // 模拟真实的 write() 调用，直接用生产代码写入
    bus.emit('node:created', {
      nodeId: 'node-1',
      data: { id: 1, name: 'Test' },
      timestamp: 500,
    })

    // 手动检查最近一次 write 调用的格式
    const lastWriteCall = (res.write as any).mock.calls.find(
      (c: string[]) => c[0] && String(c[0]).includes('event: node:created')
    )
    expect(lastWriteCall).toBeDefined()
    const raw = String(lastWriteCall[0])

    // SSE 必须包含 event: line
    expect(raw.startsWith('event: ')).toBe(true)
    // 必须包含 data: line
    expect(raw).toContain('\ndata: ')
    // 必须以 \n\n 结尾（SSE 消息分隔）
    expect(raw.endsWith('\n\n')).toBe(true)
    // data: 之后必须是有效 JSON
    const dataLine = raw.match(/data: (.+)/)?.[1]
    expect(dataLine).toBeDefined()
    expect(() => JSON.parse(dataLine!)).not.toThrow()

    cleanup()
  })

  // ── 测试 6: 断连后写容错 ─────────────────────────

  test('6. 断连后 write 失败不抛异常（容错）', () => {
    const res = new MockServerResponse()
    const cleanup = sub.subscribe(res as any)

    // 模拟连接已关闭（write 会抛错）
    res.setClosed()

    // 发射事件 → 不应抛异常
    expect(() => {
      bus.emit('node:created', {
        nodeId: 'node-1',
        data: { id: 1, name: 'FailTest' },
        timestamp: 600,
      })
    }).not.toThrow()

    // 再发射几个事件，仍然不抛异常
    expect(() => {
      bus.emit('node:updated', {
        nodeId: 'node-1',
        data: { id: 1, name: 'StillFail' },
        timestamp: 700,
      })
      bus.emit('edge:created', {
        nodeId: 'node-2',
        data: { src: 1, dst: 2 },
        timestamp: 800,
      })
    }).not.toThrow()

    cleanup()
  })

  // ── 测试 7: 高并发场景 ───────────────────────────

  test('7. 高并发场景 — 100 个事件快速推送', () => {
    const res = new MockServerResponse()
    const cleanup = sub.subscribe(res as any)

    // 批量发射 100 个事件
    for (let i = 0; i < 100; i++) {
      bus.emit('node:created', {
        nodeId: `node-${i}`,
        data: { id: i, name: `Entity-${i}` },
        timestamp: 1000 + i,
      })
    }

    // 验证收到全部 100 个事件（+ 1 个 connected = 101）
    expect(res.chunks.length).toBe(101)

    // 验证事件顺序正确
    for (let i = 0; i < 100; i++) {
      const chunk = res.chunks[i + 1] // +1 跳过 connected
      expect(chunk.event).toBe('node:created')
      const parsed = JSON.parse(chunk.data) as SubscriptionEvent
      expect(parsed.data.id).toBe(i)
      expect(parsed.nodeId).toBe(`node-${i}`)
    }

    cleanup()
  })

  // ── 测试 8: 高并发 + 多事件类型 ─────────────────

  test('8. 高并发多类型 — 混合事件类型推送', () => {
    const res = new MockServerResponse()
    const cleanup = sub.subscribe(res as any)
    res.reset()

    const eventTypes = ['node:created', 'node:updated', 'node:deleted', 'edge:created', 'edge:updated', 'edge:deleted']

    // 混合发射 60 个事件（每种类型 10 个）
    for (let i = 0; i < 60; i++) {
      const type = eventTypes[i % eventTypes.length]
      bus.emit(type, {
        nodeId: `n-${i}`,
        data: { index: i, type },
        timestamp: 2000 + i,
      })
    }

    // 验证收到 60 个事件
    expect(res.chunks.length).toBe(60)

    // 验证每种类型都有收到
    const receivedTypes = new Set(res.chunks.map(c => c.event))
    expect(receivedTypes.size).toBe(6)
    for (const t of eventTypes) {
      expect(receivedTypes.has(t)).toBe(true)
    }

    cleanup()
  })

  // ── 测试 9: 事件数据 fallback ────────────────────

  test('9. 事件无 data 字段时回退到整个 event 对象', () => {
    const res = new MockServerResponse()
    const cleanup = sub.subscribe(res as any, { events: 'node:updated' })

    // 发射不带 data 字段的事件（整个 event 被当作 data）
    bus.emit('node:updated', {
      nodeId: 'node-99',
      id: 42,
      name: 'NoDataFallback',
      timestamp: 999,
    })

    const eventChunk = res.chunks.find(c => c.event === 'node:updated')
    expect(eventChunk).toBeDefined()
    const parsed = JSON.parse(eventChunk!.data)

    // 当 event 没有 data 字段时，整个 event 对象被放入 data
    expect(parsed.type).toBe('node:updated')
    expect(parsed.nodeId).toBe('node-99')
    expect(parsed.data.id).toBe(42)
    expect(parsed.data.name).toBe('NoDataFallback')

    cleanup()
  })

  // ── 测试 10: activeConnections 计数 ──────────────

  test('10. activeConnections 多个连接计数正确', () => {
    expect(sub.activeConnections).toBe(0)

    const res1 = new MockServerResponse()
    const cleanup1 = sub.subscribe(res1 as any)
    expect(sub.activeConnections).toBe(1)

    const res2 = new MockServerResponse()
    const cleanup2 = sub.subscribe(res2 as any)
    expect(sub.activeConnections).toBe(2)

    const res3 = new MockServerResponse()
    const cleanup3 = sub.subscribe(res3 as any)
    expect(sub.activeConnections).toBe(3)

    cleanup2()
    expect(sub.activeConnections).toBe(2)

    cleanup1()
    expect(sub.activeConnections).toBe(1)

    cleanup3()
    expect(sub.activeConnections).toBe(0)
  })

  // ── 测试 11: 并发订阅后逐个 cleanup ────────────────

  test('11. 并发订阅 + 逐个 cleanup 不影响其他连接', () => {
    const resA = new MockServerResponse()
    const resB = new MockServerResponse()
    const resC = new MockServerResponse()

    const cleanupA = sub.subscribe(resA as any)
    const cleanupB = sub.subscribe(resB as any)
    const cleanupC = sub.subscribe(resC as any)

    // 重置初始 connected
    resA.reset()
    resB.reset()
    resC.reset()

    // 清理 B
    cleanupB()
    expect(sub.activeConnections).toBe(2)

    // 发射事件 — A 和 C 收到，B 不再收到
    bus.emit('node:created', {
      nodeId: 'node-main',
      data: { id: 1 },
      timestamp: 100,
    })

    expect(resA.chunks.length).toBe(1)
    expect(resB.chunks.length).toBe(0) // already cleaned up
    expect(resC.chunks.length).toBe(1)

    // 再清掉 A
    cleanupA()
    expect(sub.activeConnections).toBe(1)

    // 再次发射 — 只有 C 收到
    resA.reset()
    resC.reset()
    bus.emit('node:updated', {
      nodeId: 'node-main',
      data: { id: 2 },
      timestamp: 200,
    })

    expect(resA.chunks.length).toBe(0)
    expect(resC.chunks.length).toBe(1)

    cleanupC()
    expect(sub.activeConnections).toBe(0)
  })
})
