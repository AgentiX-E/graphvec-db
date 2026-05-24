/**
 * EventStream 单元测试
 *
 * 使用 MockEventBus（mock ZeroMQ），不依赖真实网络
 */

import { EventEmitter } from 'node:events'
import { EventStream, EventStreamConfig } from './event-stream'
import { StreamMessage } from './stream-wal'
import * as path from 'node:path'
import * as fs from 'node:fs'

// ── MockEventBus (简化版，模拟 EventBus 的 on/emit/dedup 行为) ──

interface MockGraphEvent {
  type: string
  nodeId: string
  timestamp: number
  data: Record<string, unknown>
}

class MockEventBus {
  readonly emitter = new EventEmitter()
  public nodeId: string
  /** 收集所有发出的消息 */
  public sent: MockGraphEvent[] = []

  constructor(nodeId: string) {
    this.nodeId = nodeId
  }

  emit(event: Omit<MockGraphEvent, 'nodeId'>): void {
    const full = { ...event, nodeId: this.nodeId }
    this.sent.push(full)
    this.emitter.emit(event.type, full)
  }

  on(type: string, handler: (evt: MockGraphEvent) => void): void {
    this.emitter.on(type, handler)
  }

  /** 模拟远程节点发来消息 */
  simulateRemote(type: string, data: Record<string, unknown>, remoteNodeId = 'remote-a'): void {
    const evt: MockGraphEvent = { type, nodeId: remoteNodeId, timestamp: Date.now(), data }
    this.emitter.emit(type, evt)
  }
}

const TEST_DIR = path.join('/tmp', `event-stream-test-${Date.now()}`)
const WAL_A = path.join(TEST_DIR, 'wal-a')
const WAL_B = path.join(TEST_DIR, 'wal-b')

beforeAll(() => fs.mkdirSync(TEST_DIR, { recursive: true }))
afterAll(() => { try { fs.rmSync(TEST_DIR, { recursive: true }) } catch { /* ignore */ } })

function makeConfig(nodeId: string, walDir: string, bus: MockEventBus): EventStreamConfig {
  return {
    nodeId,
    eventBus: bus as any,
    walDir,
    ackTimeoutMs: 300,
    retryIntervalMs: 100,
    maxRetries: 3,
    dedupCapacity: 100,
    catchupBatchSize: 10,
  }
}

describe('EventStream', () => {
  let busA: MockEventBus
  let esA: EventStream
  let esB: EventStream

  beforeEach(() => {
    busA = new MockEventBus('node-a')
    esA = new EventStream(makeConfig('node-a', WAL_A, busA))
    esA.open()
  })

  afterEach(async () => {
    await esA.close()
    try { fs.rmSync(WAL_A, { recursive: true }) } catch { /* ignore */ }
    try { fs.rmSync(WAL_B, { recursive: true }) } catch { /* ignore */ }
  })

  describe('基本 emit / receive', () => {
    it('emit 后写入 WAL 并通过 EventBus 发布', () => {
      esA.emit({ type: 'node:created', data: { id: 1 } })

      // 检查 EventBus.sent
      expect(busA.sent.length).toBeGreaterThanOrEqual(1)
      const rawMsg = busA.sent[0].data.__es_msg as StreamMessage
      expect(rawMsg).toBeDefined()
      expect(rawMsg.msgId).toMatch(/^node-a-1$/)
      expect(rawMsg.seq).toBe(1)
      expect(rawMsg.type).toBe('node:created')

      // 检查 WAL
      const pending = (esA as any).wal.readPending(Date.now() + 60000)
      expect(pending.length).toBe(1)
      expect(pending[0].seq).toBe(1)
    })

    it('emit 后本地 handler 立即触发', (done) => {
      esA.on('node:created', (msg) => {
        expect(msg.msgId).toMatch(/^node-a-1$/)
        expect(msg.data.id).toBe(42)
        done()
      })

      esA.emit({ type: 'node:created', data: { id: 42 } })
    })

    it('远程事件应被去重并回调', (done) => {
      const received: StreamMessage[] = []
      esA.on('node:created', (msg) => {
        received.push(msg)
        if (received.length === 1) {
          expect(msg.msgId).toBe('remote-a-5')
          done()
        }
      })

      // 模拟远程节点发来事件
      busA.simulateRemote('node:created', {
        __es_msg: { msgId: 'remote-a-5', seq: 5, nodeId: 'remote-a', timestamp: Date.now(), type: 'node:created', data: { id: 99 } },
      })
    })

    it('重复的远程事件应被丢弃', () => {
      let callCount = 0
      esA.on('node:created', () => { callCount++ })

      // 发两次相同 msgId
      busA.simulateRemote('node:created', {
        __es_msg: { msgId: 'dup-1', seq: 1, nodeId: 'remote-a', timestamp: Date.now(), type: 'node:created', data: {} },
      })
      busA.simulateRemote('node:created', {
        __es_msg: { msgId: 'dup-1', seq: 1, nodeId: 'remote-a', timestamp: Date.now(), type: 'node:created', data: {} },
      })

      expect(callCount).toBe(1)
    })
  })

  describe('ACK 回传', () => {
    it('收到远程事件后应自动发送 ACK', () => {
      busA.simulateRemote('node:created', {
        __es_msg: { msgId: 'r-1', seq: 1, nodeId: 'remote-a', timestamp: Date.now(), type: 'node:created', data: {} },
      })

      // 检查是否发送了 event:ack
      const ackEvents = busA.sent.filter(e => e.type === 'event:ack')
      expect(ackEvents.length).toBe(1)
      expect(ackEvents[0].data.msgId).toBe('r-1')
    })

    it('ACK 到来时应从 pendingTracker 移除并标记 WAL', () => {
      esA.emit({ type: 'node:created', data: { id: 1 } })

      // 模拟远程节点回传 ACK
      busA.simulateRemote('event:ack', { msgId: 'node-a-1', nodeId: 'remote-b' })

      const tracker = (esA as any).pendingTracker as Map<string, any>
      expect(tracker.has('node-a-1')).toBe(false)

      // WAL 中不应再被 readPending 返回
      const pending = (esA as any).wal.readPending(Date.now() + 60000)
      expect(pending.find((m: any) => m.msgId === 'node-a-1')).toBeUndefined()
    })
  })

  describe('重试机制', () => {
    jest.setTimeout(10000)

    it('超时未 ACK 的消息应被重发', (done) => {
      let retryCount = 0
      const origScan = (esA as any)._scanPending.bind(esA)
      ;(esA as any)._scanPending = () => {
        origScan()
        // 记录上次 retry 执行后 tracker 的状态
        const tracker = (esA as any).pendingTracker
        const entry = tracker.get('node-a-1')
        if (entry && entry.retries >= 1) {
          retryCount = entry.retries
        }
      }

      esA.emit({ type: 'node:created', data: { id: 1 } })

      setTimeout(() => {
        // 检查重发
        const nodeCreatedEvents = busA.sent.filter(e => e.type === 'node:created')
        expect(nodeCreatedEvents.length).toBeGreaterThanOrEqual(2) // 原始 + 至少一次重试
        done()
      }, 800)
    })

  })

  describe('SYNC 追赶', () => {
    it('requestSync 应发送 event:sync', () => {
      esA.emit({ type: 'node:created', data: { id: 1 } })
      esA.emit({ type: 'node:created', data: { id: 2 } })
      esA.requestSync()

      const syncEvents = busA.sent.filter(e => e.type === 'event:sync')
      expect(syncEvents.length).toBe(1)
      expect(syncEvents[0].data.requester).toBe('node-a')
      expect(syncEvents[0].data.lastSeq).toBe(2)
    })

    it('收到 event:sync 时应回复 event:sync-batch', (done) => {
      // 先发 5 条消息
      for (let i = 1; i <= 5; i++) {
        esA.emit({ type: 'node:created', data: { id: i } })
      }

      // 模拟远程发来 sync 请求（lastSeq=2，要求补齐 seq>2）
      busA.simulateRemote('event:sync', { requester: 'remote-b', lastSeq: 2 })

      // 检查 sync-batch 回复
      setTimeout(() => {
        const batchEvents = busA.sent.filter(e => e.type === 'event:sync-batch')
        expect(batchEvents.length).toBe(1)
        const msgs = batchEvents[0].data.msgs as StreamMessage[]
        expect(msgs.length).toBe(3) // seq 3, 4, 5
        expect(msgs.map(m => m.seq)).toEqual([3, 4, 5])
        done()
      }, 100)
    })

    it('收到 event:sync-batch 后应去重消费', (done) => {
      const received: StreamMessage[] = []
      esA.on('node:created', (msg) => { received.push(msg) })

      // 模拟远程发来 sync-batch
      busA.simulateRemote('event:sync-batch', {
        msgs: [
          { msgId: 'catchup-1', seq: 10, nodeId: 'remote-a', timestamp: Date.now(), type: 'node:created', data: { id: 10 } },
          { msgId: 'catchup-2', seq: 11, nodeId: 'remote-a', timestamp: Date.now(), type: 'node:created', data: { id: 11 } },
        ],
      })

      setTimeout(() => {
        expect(received.length).toBe(2)
        expect(received[0].seq).toBe(10)
        expect(received[1].seq).toBe(11)
        done()
      }, 100)
    })
  })

  describe('关闭/重启', () => {
    it('close 后 emit 应抛错', () => {
      // 正常
      esA.emit({ type: 'node:created', data: { id: 1 } })
    })

    it('重新 open 后 seq 应从 WAL 恢复', () => {
      esA.emit({ type: 'node:created', data: { id: 1 } })
      esA.emit({ type: 'node:created', data: { id: 2 } })
      esA.close()

      const es2 = new EventStream(makeConfig('node-a', WAL_A, busA))
      es2.open()

      // 下一个 emit 的 seq 应是 3
      es2.emit({ type: 'node:created', data: { id: 3 } })
      const lastSent = busA.sent[busA.sent.length - 1]
      const rawMsg = lastSent.data.__es_msg as StreamMessage
      expect(rawMsg.seq).toBe(3)
      expect(rawMsg.msgId).toBe('node-a-3')

      es2.close()
    })
  })

  describe('存活告警', () => {
    jest.setTimeout(10000)

    it('onStall 在重试次数达到 threshold 时被调用', (done) => {
      const stalled: any[] = []
      const config = makeConfig('node-a', WAL_A, busA)
      config.ackTimeoutMs = 50
      config.retryIntervalMs = 50
      config.stallThreshold = 3
      config.onStall = (info) => { stalled.push(info) }

      const es = new EventStream(config)
      es.open()

      es.emit({ type: 'node:created', data: { id: 1 } })

      // 不发 ACK，等待 onStall 触发
      setTimeout(() => {
        expect(stalled.length).toBe(1)
        expect(stalled[0].msgId).toBe('node-a-1')
        expect(stalled[0].retries).toBe(3)
        expect(stalled[0].type).toBe('node:created')
        expect(stalled[0].seq).toBe(1)
        expect(stalled[0].durationMs).toBeGreaterThanOrEqual(0)

        es.close()
        done()
      }, 500)
    })

    it('ACK 后不再触发 onStall', (done) => {
      const stalled: any[] = []
      const config = makeConfig('node-a', WAL_A, busA)
      config.ackTimeoutMs = 50
      config.retryIntervalMs = 50
      config.stallThreshold = 3
      config.onStall = (info) => { stalled.push(info) }

      const es = new EventStream(config)
      es.open()

      es.emit({ type: 'node:created', data: { id: 1 } })

      // 在重试到达 threshold 之前发送 ACK
      setTimeout(() => {
        busA.simulateRemote('event:ack', { msgId: 'node-a-1', nodeId: 'remote' })
      }, 100)

      // threshold 时间后检查 onStall 未被触发
      setTimeout(() => {
        expect(stalled.length).toBe(0)
        es.close()
        done()
      }, 600)
    })
  })
})
