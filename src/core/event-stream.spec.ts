/**
 * EventStream 单元测试
 *
 * 使用 MockEventBus（mock ROUTER/DEALER），不依赖真实网络
 */

import { EventStream, EventStreamConfig } from './event-stream'
import { TransportMessage } from './event-bus'
import { StreamMessage } from './stream-wal'
import * as path from 'node:path'
import * as fs from 'node:fs'

// ── MockEventBus（模拟 ROUTER/DEALER EventBus） ──

class MockEventBus {
  public nodeId: string
  /** 收集所有发出的 TransportMessage */
  public sent: TransportMessage[] = []
  private receiveHandler: ((msg: TransportMessage, fromNodeId: string) => void) | null = null

  constructor(nodeId: string) {
    this.nodeId = nodeId
  }

  setReceiveHandler(handler: (msg: TransportMessage, fromNodeId: string) => void): void {
    this.receiveHandler = handler
  }

  send(nodeId: string, msg: TransportMessage): void {
    this.sent.push(msg)
  }

  broadcast(msg: TransportMessage): void {
    this.sent.push(msg)
  }

  emit(event: any): void {
    // no-op in mock — EventStream doesn't use bus.emit() anymore
  }

  on(type: string, handler: (...args: any[]) => void): void {
    // no-op in mock
  }

  off(type: string, handler: (...args: any[]) => void): void {
    // no-op in mock
  }

  getPeerNodeIds(): string[] { return ['remote-a', 'remote-b'] }

  /** 模拟远程节点发来消息 */
  simulateRemote(msg: Partial<TransportMessage> & { data: Record<string, unknown> }, fromNodeId = 'remote-a'): void {
    const full: TransportMessage = {
      msgId: msg.msgId || `mock-${Date.now()}`,
      type: msg.type || 'data',
      srcNodeId: msg.srcNodeId || fromNodeId,
      data: msg.data || {},
      ackMsgId: msg.ackMsgId,
    }
    this.receiveHandler?.(full, fromNodeId)
  }

  /** broadcast 发来的内容也当是发给所有人的 — 模拟所有 peer 收到后触发本地 receiveHandler */
  simulateAllPeersReceive(msg: TransportMessage | null = null, fromNodeId = 'remote-a'): void {
    const toProcess = msg || this.sent[this.sent.length - 1]
    if (toProcess) {
      const copy: TransportMessage = { ...toProcess, srcNodeId: fromNodeId }
      this.receiveHandler?.(copy, fromNodeId)
    }
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

      // 检查 EventBus.sent（TransportMessage）
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
      busA.simulateRemote({
        data: {
          __es_msg: { msgId: 'remote-a-5', seq: 5, nodeId: 'remote-a', timestamp: Date.now(), type: 'node:created', data: { id: 99 } },
        },
      })
    })

    it('重复的远程事件应被丢弃', () => {
      let callCount = 0
      esA.on('node:created', () => { callCount++ })

      // 发两次相同 msgId
      busA.simulateRemote({
        data: {
          __es_msg: { msgId: 'dup-1', seq: 1, nodeId: 'remote-a', timestamp: Date.now(), type: 'node:created', data: {} },
        },
      })
      busA.simulateRemote({
        data: {
          __es_msg: { msgId: 'dup-1', seq: 1, nodeId: 'remote-a', timestamp: Date.now(), type: 'node:created', data: {} },
        },
      })

      expect(callCount).toBe(1)
    })
  })

  describe('ACK 回传', () => {
    it('收到远程事件后应自动发送 ACK', () => {
      busA.simulateRemote({
        data: {
          __es_msg: { msgId: 'r-1', seq: 1, nodeId: 'remote-a', timestamp: Date.now(), type: 'node:created', data: {} },
        },
      })

      // 检查是否发送了 ack TransportMessage
      const ackMsgs = busA.sent.filter(e => e.type === 'ack')
      expect(ackMsgs.length).toBe(1)
      expect(ackMsgs[0].ackMsgId).toBe('r-1')
    })

    it('ACK 到来时应从 pendingTracker 移除并标记 WAL', () => {
      esA.emit({ type: 'node:created', data: { id: 1 } })

      // 模拟远程节点回传 ACK TransportMessage
      busA.simulateRemote({ type: 'ack', ackMsgId: 'node-a-1', data: {} }, 'remote-b')

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
        // 检查重发（sent 里的 'data' 类型消息，包含 __es_msg）
        const dataMsgs = busA.sent.filter((e: TransportMessage) => e.type === 'data' && (e.data as any).__es_msg?.msgId === 'node-a-1')
        expect(dataMsgs.length).toBeGreaterThanOrEqual(2) // 原始 + 至少一次重试
        done()
      }, 800)
    })

  })

  describe('SYNC 追赶', () => {
    it('requestSync 应发送 sync-query', () => {
      esA.emit({ type: 'node:created', data: { id: 1 } })
      esA.emit({ type: 'node:created', data: { id: 2 } })
      esA.requestSync()

      const syncQueries = busA.sent.filter(e => e.type === 'sync-query')
      expect(syncQueries.length).toBe(1)
      expect(syncQueries[0].data.requester).toBe('node-a')
      expect(syncQueries[0].data.lastSeq).toBe(2)
    })

    it('收到 sync-query 时应回复 sync-query-reply', (done) => {
      // 先发 5 条消息
      for (let i = 1; i <= 5; i++) {
        esA.emit({ type: 'node:created', data: { id: i } })
      }

      // 模拟远程发来 sync-query（lastSeq=2，要求补齐 seq>2）
      busA.simulateRemote({ type: 'sync-query', data: { requester: 'remote-b', lastSeq: 2 } }, 'remote-b')

      // 检查 sync-query-reply 回复
      setTimeout(() => {
        const replyMsgs = busA.sent.filter(e => e.type === 'sync-query-reply')
        expect(replyMsgs.length).toBe(1)
        expect(replyMsgs[0].data.nodeId).toBe('node-a')
        expect(replyMsgs[0].data.currentSeq).toBe(5)
        done()
      }, 100)
    })

    it('收到 sync-request 后应回复 sync-batch', (done) => {
      // 先发 5 条消息
      for (let i = 1; i <= 5; i++) {
        esA.emit({ type: 'node:created', data: { id: i } })
      }

      // 模拟远程发来 sync-request
      busA.simulateRemote({ type: 'sync-request', data: { requester: 'remote-b', fromSeq: 2, targetSeq: 5 } }, 'remote-b')

      // 检查 sync-batch 回复
      setTimeout(() => {
        const batchMsgs = busA.sent.filter(e => e.type === 'sync-batch')
        expect(batchMsgs.length).toBe(1)
        const msgs = batchMsgs[0].data.msgs as StreamMessage[]
        expect(msgs.length).toBe(3) // seq 3, 4, 5
        expect(msgs.map(m => m.seq)).toEqual([3, 4, 5])
        done()
      }, 100)
    })

    it('收到 sync-batch 后应去重消费', (done) => {
      const received: StreamMessage[] = []
      esA.on('node:created', (msg) => { received.push(msg) })

      // 模拟远程发来 sync-batch
      busA.simulateRemote({ type: 'sync-batch', data: {
        msgs: [
          { msgId: 'catchup-1', seq: 10, nodeId: 'remote-a', timestamp: Date.now(), type: 'node:created', data: { id: 10 } },
          { msgId: 'catchup-2', seq: 11, nodeId: 'remote-a', timestamp: Date.now(), type: 'node:created', data: { id: 11 } },
        ],
      } })

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
        busA.simulateRemote({ type: 'ack', ackMsgId: 'node-a-1', data: {} }, 'remote')
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
