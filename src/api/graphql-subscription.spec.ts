/**
 * graphql-subscription.spec.ts — GraphQL Subscription 单元测试
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { GraphQLSubscription, type SubscriptionEvent } from './graphql-subscription'

// ── Mock EventBus ───────────────────────────────────────

function createMockBus(): {
  bus: ReturnType<typeof vi.fn>
  emitter: EventEmitter
} {
  const emitter = new EventEmitter()
  const bus = {
    on: vi.fn((type: string, handler: (...args: any[]) => void) => {
      emitter.on(type, handler)
    }),
    off: vi.fn((type: string, handler: (...args: any[]) => void) => {
      emitter.off(type, handler)
    }),
  }
  return { bus, emitter }
}

// ── Mock ServerResponse ────────────────────────────────

function createMockRes(): http.ServerResponse {
  const chunks: Array<{ event: string; data: string }> = []
  const res = {
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => {
      // SSE 格式: `event: xxx\ndata: {...}\n\n`
      const lines = chunk.split('\n')
      const eventLine = lines.find(l => l.startsWith('event: '))
      const dataLine = lines.find(l => l.startsWith('data: '))
      if (eventLine && dataLine) {
        chunks.push({
          event: eventLine.slice(7),
          data: JSON.parse(dataLine.slice(6)),
        })
      }
    }),
    end: vi.fn(),
    on: vi.fn(),
  }
  return { ...res, chunks } as any
}

describe('GraphQLSubscription', () => {
  let sub: GraphQLSubscription
  let mockBus: ReturnType<typeof createMockBus>

  beforeEach(() => {
    mockBus = createMockBus()
    sub = new GraphQLSubscription(mockBus.bus as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('注册所有 6 种事件类型的 listener', () => {
    const res = createMockRes()
    const cleanup = sub.subscribe(res as any)

    // bus.on 应该被调用 6 次（每个事件类型一次）
    expect(mockBus.bus.on).toHaveBeenCalledTimes(6)
    expect(mockBus.bus.on).toHaveBeenCalledWith('node:created', expect.any(Function))
    expect(mockBus.bus.on).toHaveBeenCalledWith('node:updated', expect.any(Function))
    expect(mockBus.bus.on).toHaveBeenCalledWith('node:deleted', expect.any(Function))
    expect(mockBus.bus.on).toHaveBeenCalledWith('edge:created', expect.any(Function))
    expect(mockBus.bus.on).toHaveBeenCalledWith('edge:updated', expect.any(Function))
    expect(mockBus.bus.on).toHaveBeenCalledWith('edge:deleted', expect.any(Function))

    cleanup()
  })

  test('事件过滤器：只注册指定类型', () => {
    const res = createMockRes()
    const cleanup = sub.subscribe(res as any, { events: 'node:created,node:deleted' })

    expect(mockBus.bus.on).toHaveBeenCalledWith('node:created', expect.any(Function))
    expect(mockBus.bus.on).toHaveBeenCalledWith('node:deleted', expect.any(Function))
    // 未订阅的类型不应注册
    expect(mockBus.bus.on).not.toHaveBeenCalledWith('node:updated', expect.any(Function))
    expect(mockBus.bus.on).not.toHaveBeenCalledWith('edge:created', expect.any(Function))
    expect(mockBus.bus.on).not.toHaveBeenCalledWith('edge:updated', expect.any(Function))
    expect(mockBus.bus.on).not.toHaveBeenCalledWith('edge:deleted', expect.any(Function))

    cleanup()
  })

  test('收到 local emit 后通过 SSE 推送', () => {
    const res = createMockRes()
    const cleanup = sub.subscribe(res as any)

    // 模拟 EventBus 触发 node:created
    mockBus.emitter.emit('node:created', {
      nodeId: 'node-1',
      type: 'node:created',
      data: { id: 1, name: 'Alice', type: 0 },
      timestamp: 1000,
    })

    expect(res.write).toHaveBeenCalled()
    const writeCall = (res.write as any).mock.calls.find(
      (c: string[]) => c[0].includes('node:created')
    )
    expect(writeCall).toBeDefined()
    expect(writeCall[0]).toContain('event: node:created')
    expect(writeCall[0]).toContain('"id":1')
    expect(writeCall[0]).toContain('"name":"Alice"')

    cleanup()
  })

  test('初始连接确认消息', () => {
    const res = createMockRes()
    const cleanup = sub.subscribe(res as any)

    expect(res.write).toHaveBeenCalled()
    const connectCall = (res.write as any).mock.calls.find(
      (c: string[]) => c[0].includes('event: connected')
    )
    expect(connectCall).toBeDefined()
    expect(connectCall[0]).toContain('"timestamp"')

    cleanup()
  })

  test('事件数据传递：无 data 字段时回退到 event 本身', () => {
    const res = createMockRes()
    const cleanup = sub.subscribe(res as any, { events: 'node:updated' })

    // EventBus 直接 emit event 对象（data 字段是事件本身）
    mockBus.emitter.emit('node:updated', {
      nodeId: 'node-1',
      id: 42,
      name: 'Bob',
      timestamp: 2000,
    })

    const call = (res.write as any).mock.calls.find(
      (c: string[]) => c[0].includes('node:updated')
    )
    expect(call).toBeDefined()
    const parsed = JSON.parse(call[0].match(/data: (.+)/)?.[1])

    // 当 event 没有 data 字段时，整个 event 对象被当作 data
    expect(parsed.type).toBe('node:updated')
    expect(parsed.data.id).toBe(42)
    expect(parsed.data.name).toBe('Bob')

    cleanup()
  })

  test('cleanup 移除所有 listener', () => {
    const res = createMockRes()
    const cleanup = sub.subscribe(res as any)
    cleanup()

    // 6 个事件类型，每个都调用了 off
    expect(mockBus.bus.off).toHaveBeenCalledTimes(6)
  })

  test('cleanup 后不再推送', () => {
    const { bus, emitter } = createMockBus()
    const sub2 = new GraphQLSubscription(bus as any)
    const res = createMockRes()
    const cleanup = sub2.subscribe(res as any)
    expect(typeof cleanup).toBe('function')
    // cleanup 移除所有 listener
    cleanup()

    // 清理掉之前的 write calls（初始 connected 消息 + 前面的订阅调用）
    ;(res.write as any).mockClear()

    // 触发事件
    emitter.emit('node:created', {
      nodeId: 'node-1',
      data: { id: 1 },
    })

    // cleanup 后不应再调用 write
    expect(res.write).not.toHaveBeenCalled()
  })

  test('activeConnections 计数正确', () => {
    expect(sub.activeConnections).toBe(0)

    const res1 = createMockRes()
    const cleanup1 = sub.subscribe(res1 as any)
    expect(sub.activeConnections).toBe(1)

    const res2 = createMockRes()
    const cleanup2 = sub.subscribe(res2 as any)
    expect(sub.activeConnections).toBe(2)

    cleanup1()
    expect(sub.activeConnections).toBe(1)

    cleanup2()
    expect(sub.activeConnections).toBe(0)
  })

  test('SSE 响应头正确', () => {
    const res = createMockRes()
    const cleanup = sub.subscribe(res as any)

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    }))

    cleanup()
  })

  test('空事件过滤器 = 全部订阅', () => {
    const res = createMockRes()
    const cleanup = sub.subscribe(res as any, {})

    expect(mockBus.bus.on).toHaveBeenCalledTimes(6)

    cleanup()
  })

  test('edge 事件也能正确传递', () => {
    const res = createMockRes()
    const cleanup = sub.subscribe(res as any, { events: 'edge:created' })

    mockBus.emitter.emit('edge:created', {
      nodeId: 'node-2',
      data: { src: 1, dst: 2, type: 10 },
      timestamp: 3000,
    })

    const call = (res.write as any).mock.calls.find(
      (c: string[]) => c[0].includes('edge:created')
    )
    expect(call).toBeDefined()
    expect(call[0]).toContain('"src":1')
    expect(call[0]).toContain('"type":10')

    cleanup()
  })

  test('连接关闭时 write 不抛错（容错）', () => {
    const res = createMockRes()
    const cleanup = sub.subscribe(res as any)

    // 模拟连接已关闭
    let calls = 0
    ;(res.write as any).mockImplementation(() => {
      calls++
      throw new Error('write after end')
    })

    // 不应该抛异常
    expect(() => {
      mockBus.emitter.emit('node:created', {
        nodeId: 'node-1',
        data: { id: 1 },
      })
    }).not.toThrow()

    cleanup()
  })
})

import type http from 'http'
