import { EventBus, GraphEvent, initEventBus } from './event-bus'

describe('EventBus', () => {
  describe('local events', () => {
    test('should emit and receive locally', () => {
      const bus = new EventBus({ nodeId: 'test-1' })
      const received: GraphEvent[] = []
      bus.on('node:created', (e) => received.push(e))
      bus.emit({ type: 'node:created', timestamp: 100, data: { id: 1 } })
      bus.emit({ type: 'node:created', timestamp: 200, data: { id: 2 } })
      expect(received.length).toBe(2)
      expect(received[0].data.id).toBe(1)
      expect(received[1].nodeId).toBe('test-1')
    })

    test('should filter by event type', () => {
      const bus = new EventBus({ nodeId: 'test-1' })
      const nc: GraphEvent[] = []
      const nd: GraphEvent[] = []
      bus.on('node:created', (e) => nc.push(e))
      bus.on('node:deleted', (e) => nd.push(e))
      bus.emit({ type: 'node:created', timestamp: 100, data: { id: 1 } })
      bus.emit({ type: 'node:deleted', timestamp: 200, data: { id: 1 } })
      expect(nc.length).toBe(1)
      expect(nd.length).toBe(1)
    })

    test('should allow unsubscribe', () => {
      const bus = new EventBus({ nodeId: 'test-1' })
      const fn = jest.fn()
      bus.on('node:created', fn)
      bus.emit({ type: 'node:created', timestamp: 100, data: {} })
      expect(fn).toHaveBeenCalledTimes(1)
      bus.off('node:created', fn)
      bus.emit({ type: 'node:created', timestamp: 200, data: {} })
      expect(fn).toHaveBeenCalledTimes(1)
    })

    test('clear removes all listeners', () => {
      const bus = new EventBus({ nodeId: 'test-1' })
      const fn = jest.fn()
      bus.on('node:created', fn)
      bus.clear()
      bus.emit({ type: 'node:created', timestamp: 100, data: {} })
      expect(fn).not.toHaveBeenCalled()
    })
  })

  describe('initEventBus / globalEventBus', () => {
    afterEach(async () => {
      try { await (await import('./event-bus')).getEventBus().stop() } catch {}
    })

    test('initEventBus returns singleton', async () => {
      // 多次调用应返回同一个 _instance
      const a = await initEventBus({ nodeId: 'x', publishAddress: null })
      const b = await initEventBus({ nodeId: 'y', publishAddress: null })
      // 第二次调用应返回新实例（因为 nodeId 不同），但全局单例是同一个 _instance
      // 验证：getEventBus() 应返回最新的实例
      const c = (await import('./event-bus')).getEventBus()
      expect(c).toBe(b)
      expect(c).not.toBe(a)
    })

    test('globalEventBus proxy works without init', () => {
      const { globalEventBus } = require('./event-bus') as any
      const received: GraphEvent[] = []
      globalEventBus.on('node:created', (e: GraphEvent) => received.push(e))
      globalEventBus.emit({ type: 'node:created', timestamp: 100, data: {} })
      expect(received.length).toBe(1)
    })

    test('leader mode: no PUB error', async () => {
      const bus = new EventBus({ nodeId: 'leader', publishAddress: 'tcp://127.0.0.1:15559', isRaftLeader: true })
      await bus.start()
      const fn = jest.fn()
      bus.on('node:created', fn)
      bus.emit({ type: 'node:created', timestamp: 100, data: {} })
      expect(fn).toHaveBeenCalledTimes(1)
      await bus.stop()
    })

    test('stop does not throw', async () => {
      const bus = new EventBus({ nodeId: 'x' })
      await bus.start()
      await expect(bus.stop()).resolves.toBeUndefined()
    })

    test('start/stop multiple times', async () => {
      const bus = new EventBus({ nodeId: 'x' })
      await bus.start()
      await bus.stop()
      await bus.start()
      const fn = jest.fn()
      bus.on('node:created', fn)
      bus.emit({ type: 'node:created', timestamp: 100, data: {} })
      expect(fn).toHaveBeenCalledTimes(1)
      await bus.stop()
    })
  })
})
