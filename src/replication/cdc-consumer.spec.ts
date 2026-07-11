/**
 * cdc-consumer.spec.ts — CDCConsumer 与 CDCConsumerGroup 测试
 *
 * 测试策略：
 *   1. CDC 记录转换正确性（StreamMessage → CDCChangeRecord）
 *   2. offset 递增和读取
 *   3. pause/resume 控制
 *   4. 从指定 offset 开始消费（断点续传）
 *   5. Consumer Group 管理
 *   6. close 后不再消费
 */

import { CDCConsumer, CDCConsumerGroup, CDCChangeRecord } from './cdc-consumer'
import { StreamMessage } from '../core/segment-stream-wal'

// ──────────────────────────────────────────
// Mock EventStream
// ──────────────────────────────────────────

type EventHandler = (msg: StreamMessage) => void

class MockEventStream {
  public isOpen = true
  private handlers = new Map<string, EventHandler[]>()
  private emitted: StreamMessage[] = []

  on(type: string, handler: EventHandler): void {
    const list = this.handlers.get(type) || []
    list.push(handler)
    this.handlers.set(type, list)
  }

  off(type: string, handler: EventHandler): void {
    const list = this.handlers.get(type) || []
    this.handlers.set(type, list.filter(h => h !== handler))
  }

  /** 模拟 emit 过程：触发对应 type 的 local handler */
  emitRaw(msg: StreamMessage): void {
    this.emitted.push(msg)
    const list = this.handlers.get(msg.type) || []
    for (const handler of list) {
      handler(msg)
    }
  }

  /** 获取已 emit 的消息数量 */
  get emittedCount(): number {
    return this.emitted.length
  }
}

// ──────────────────────────────────────────
// 辅助函数：创建测试 StreamMessage
// ──────────────────────────────────────────

let _seqCounter = 0
function resetSeqCounter() { _seqCounter = 0 }
function nextSeq(): number {
  _seqCounter++
  return _seqCounter
}

function makeNodeCreatedMsg(seq?: number, overrides?: Partial<StreamMessage>): StreamMessage {
  const s = seq ?? nextSeq()
  return {
    msgId: `test-node-created-${s}`,
    seq: s,
    nodeId: 'node-1',
    timestamp: Date.now(),
    type: 'node:created',
    data: { id: 1001, typeId: 1, name: 'TestNode', props: { color: 'red' } },
    ...overrides,
  }
}

function makeNodeDeletedMsg(seq?: number, overrides?: Partial<StreamMessage>): StreamMessage {
  const s = seq ?? nextSeq()
  return {
    msgId: `test-node-deleted-${s}`,
    seq: s,
    nodeId: 'node-1',
    timestamp: Date.now(),
    type: 'node:deleted',
    data: { id: 1001, typeId: 1, name: 'TestNode' },
    ...overrides,
  }
}

function makeEdgeCreatedMsg(seq?: number, overrides?: Partial<StreamMessage>): StreamMessage {
  const s = seq ?? nextSeq()
  return {
    msgId: `test-edge-created-${s}`,
    seq: s,
    nodeId: 'node-1',
    timestamp: Date.now(),
    type: 'edge:created',
    data: { src: 1001, dst: 1002, typeId: 10, props: { weight: 1.5 } },
    ...overrides,
  }
}

function makeEdgeDeletedMsg(seq?: number, overrides?: Partial<StreamMessage>): StreamMessage {
  const s = seq ?? nextSeq()
  return {
    msgId: `test-edge-deleted-${s}`,
    seq: s,
    nodeId: 'node-1',
    timestamp: Date.now(),
    type: 'edge:deleted',
    data: { src: 1001, dst: 1002, typeId: 10 },
    ...overrides,
  }
}

function makeUnknownTypeMsg(seq?: number, overrides?: Partial<StreamMessage>): StreamMessage {
  const s = seq ?? nextSeq()
  return {
    msgId: `test-unknown-${s}`,
    seq: s,
    nodeId: 'node-1',
    timestamp: Date.now(),
    type: 'metrics:heartbeat',
    data: { cpu: 42 },
    ...overrides,
  }
}

// ──────────────────────────────────────────
// Test Suites
// ──────────────────────────────────────────

describe('CDCConsumer', () => {
  let consumer: CDCConsumer
  let mockStream: MockEventStream
  let records: CDCChangeRecord[]

  beforeEach(() => {
    resetSeqCounter()
    records = []
    mockStream = new MockEventStream()
    consumer = new CDCConsumer({
      onRecord: (rec) => { records.push(rec) },
    })
  })

  afterEach(() => {
    consumer.close()
  })

  // ── 1. CDC 记录转换 ──

  test('converts node:created to CDC record', () => {
    consumer.subscribe(mockStream as any)
    const msg = makeNodeCreatedMsg()
    mockStream.emitRaw(msg)

    expect(records).toHaveLength(1)
    expect(records[0].operation).toBe('upsert_node')
    expect(records[0].nodeId).toBe(1001)
    expect(records[0].seq).toBe(msg.seq)
    expect(records[0].rawData?.props).toEqual({ color: 'red' })
  })

  test('converts node:deleted to CDC record', () => {
    consumer.subscribe(mockStream as any)
    mockStream.emitRaw(makeNodeDeletedMsg())

    expect(records).toHaveLength(1)
    expect(records[0].operation).toBe('delete_node')
    expect(records[0].nodeId).toBe(1001)
  })

  test('converts edge:created to CDC record', () => {
    consumer.subscribe(mockStream as any)
    mockStream.emitRaw(makeEdgeCreatedMsg())

    expect(records).toHaveLength(1)
    expect(records[0].operation).toBe('upsert_edge')
    expect(records[0].edgeKey).toBe('1001:1002:10')
  })

  test('converts edge:deleted to CDC record', () => {
    consumer.subscribe(mockStream as any)
    mockStream.emitRaw(makeEdgeDeletedMsg())

    expect(records).toHaveLength(1)
    expect(records[0].operation).toBe('delete_edge')
    expect(records[0].edgeKey).toBe('1001:1002:10')
  })

  test('ignores unknown event types', () => {
    consumer.subscribe(mockStream as any)
    mockStream.emitRaw(makeUnknownTypeMsg())

    expect(records).toHaveLength(0)
  })

  test('emitting 5 events records exactly 5 records', () => {
    consumer.subscribe(mockStream as any)
    mockStream.emitRaw(makeNodeCreatedMsg())
    mockStream.emitRaw(makeNodeDeletedMsg())
    mockStream.emitRaw(makeEdgeCreatedMsg())
    mockStream.emitRaw(makeEdgeDeletedMsg())
    mockStream.emitRaw(makeNodeCreatedMsg())

    expect(records).toHaveLength(5)
  })

  // ── 2. Offset 递增 ──

  test('offset increments after each record', () => {
    consumer.subscribe(mockStream as any)

    const msg1 = makeNodeCreatedMsg()
    mockStream.emitRaw(msg1)
    expect(consumer.getOffset()).toBe(msg1.seq)

    const msg2 = makeNodeDeletedMsg()
    mockStream.emitRaw(msg2)
    expect(consumer.getOffset()).toBe(msg2.seq)
  })

  test('initial offset is 0 if startOffset not specified', () => {
    expect(consumer.getOffset()).toBe(0)
  })

  // ── 3. Pause / Resume ──

  test('pause() stops consuming events', () => {
    consumer.subscribe(mockStream as any)
    consumer.pause()

    mockStream.emitRaw(makeNodeCreatedMsg())
    expect(records).toHaveLength(0)
    expect(consumer.paused).toBe(true)
  })

  test('resume() resumes consuming events', () => {
    consumer.subscribe(mockStream as any)
    consumer.pause()
    mockStream.emitRaw(makeNodeCreatedMsg())

    consumer.resume()
    mockStream.emitRaw(makeNodeDeletedMsg())

    expect(records).toHaveLength(1) // 只收到 resume 后的那一条
    expect(records[0].operation).toBe('delete_node')
    expect(consumer.paused).toBe(false)
  })

  test('pause/resume lifecycle works across multiple toggles', () => {
    consumer.subscribe(mockStream as any)

    // emit 1
    mockStream.emitRaw(makeNodeCreatedMsg())
    expect(records).toHaveLength(1)

    consumer.pause()
    // emit 2 (paused — 被丢弃)
    mockStream.emitRaw(makeNodeDeletedMsg())
    expect(records).toHaveLength(1)

    consumer.resume()
    // emit 3
    mockStream.emitRaw(makeEdgeCreatedMsg())
    expect(records).toHaveLength(2)
  })

  // ── 4. 断点续传 ──

  test('starts from specified offset (resume from checkpoint)', () => {
    resetSeqCounter()

    // 先创建一个消费到 seq=2 的 consumer
    const oldConsumer = new CDCConsumer({
      onRecord: () => {},
    })
    oldConsumer.subscribe(mockStream as any)
    const msg1 = makeNodeCreatedMsg()
    mockStream.emitRaw(msg1)
    const msg2 = makeNodeDeletedMsg()
    mockStream.emitRaw(msg2)
    const checkpointOffset = oldConsumer.getOffset()
    oldConsumer.close()

    // 新 consumer 从 checkpoint 开始（startOffset = 2）
    const resumedRecords: CDCChangeRecord[] = []
    const resumedConsumer = new CDCConsumer({
      startOffset: checkpointOffset,
      onRecord: (rec) => { resumedRecords.push(rec) },
    })
    resumedConsumer.subscribe(mockStream as any)

    const msg3 = makeEdgeCreatedMsg()
    mockStream.emitRaw(msg3)
    const msg4 = makeEdgeDeletedMsg()
    mockStream.emitRaw(msg4)

    // 应该只收到 seq > checkpoint 的消息
    expect(resumedRecords).toHaveLength(2)
    expect(resumedRecords[0].operation).toBe('upsert_edge')
    expect(resumedRecords[1].operation).toBe('delete_edge')
    // 不包含之前消费过的消息
    const seqs = resumedRecords.map(r => r.seq)
    expect(seqs).not.toContain(msg1.seq)
    expect(seqs).not.toContain(msg2.seq)
  })

  test('consumer with non-zero startOffset ignores earlier messages', () => {
    resetSeqCounter()

    const skippedRecords: CDCChangeRecord[] = []
    const resumeConsumer = new CDCConsumer({
      startOffset: 5,
      onRecord: (rec) => { skippedRecords.push(rec) },
    })
    resumeConsumer.subscribe(mockStream as any)

    // seq=6,4,8（startOffset=5 时，跳过 seq<=5，只收 6 和 8）
    mockStream.emitRaw(makeNodeCreatedMsg(6))
    mockStream.emitRaw(makeNodeCreatedMsg(4))
    mockStream.emitRaw(makeNodeCreatedMsg(8))

    expect(skippedRecords).toHaveLength(2)
    expect(skippedRecords.map(r => r.seq)).toEqual([6, 8])
  })

  // ── 5. Close ──

  test('close() stops consuming events', () => {
    consumer.subscribe(mockStream as any)
    mockStream.emitRaw(makeNodeCreatedMsg())
    expect(records).toHaveLength(1)

    consumer.close()
    mockStream.emitRaw(makeNodeDeletedMsg())
    expect(records).toHaveLength(1) // close 后不增加
  })

  test('close() is idempotent', () => {
    consumer.close()
    consumer.close() // should not throw
    expect(consumer.closed).toBe(true)
  })

  test('subscribe on non-open stream throws', () => {
    const closedStream = new MockEventStream()
    closedStream.isOpen = false
    expect(() => consumer.subscribe(closedStream as any)).toThrow('EventStream must be open')
  })

  test('subscribe with null throws', () => {
    expect(() => consumer.subscribe(null as any)).toThrow('EventStream cannot be null')
  })
})

// ──────────────────────────────────────────
// CDCConsumerGroup Tests
// ──────────────────────────────────────────

describe('CDCConsumerGroup', () => {
  let group: CDCConsumerGroup
  let mockStream: MockEventStream

  beforeEach(() => {
    resetSeqCounter()
    mockStream = new MockEventStream()
    group = new CDCConsumerGroup()
  })

  afterEach(() => {
    group.closeAll()
  })

  test('addConsumer creates and tracks consumers', () => {
    const c1 = group.addConsumer()
    const c2 = group.addConsumer()

    expect(group.size).toBe(2)
    expect(group.getConsumers()).toHaveLength(2)
    expect(c1).toBeInstanceOf(CDCConsumer)
    expect(c2).toBeInstanceOf(CDCConsumer)
  })

  test('subscribeAll subscribes all consumers to event stream', () => {
    const records1: CDCChangeRecord[] = []
    const records2: CDCChangeRecord[] = []

    group.addConsumer({ onRecord: (r) => records1.push(r) })
    group.addConsumer({ onRecord: (r) => records2.push(r) })

    group.subscribeAll(mockStream as any)

    mockStream.emitRaw(makeNodeCreatedMsg())
    mockStream.emitRaw(makeEdgeCreatedMsg())

    // 两个消费者都收到了同样的记录
    expect(records1).toHaveLength(2)
    expect(records2).toHaveLength(2)
  })

  test('pauseAll / resumeAll controls all consumers', () => {
    const records: CDCChangeRecord[] = []
    group.addConsumer({ onRecord: (r) => records.push(r) })
    group.subscribeAll(mockStream as any)

    group.pauseAll()
    mockStream.emitRaw(makeNodeCreatedMsg())
    expect(records).toHaveLength(0)

    group.resumeAll()
    mockStream.emitRaw(makeNodeDeletedMsg())
    expect(records).toHaveLength(1)
  })

  test('closeAll clears all consumers', () => {
    group.addConsumer()
    group.addConsumer()
    expect(group.size).toBe(2)

    group.closeAll()
    expect(group.size).toBe(0)
    expect(group.getConsumers()).toHaveLength(0)
  })

  test('defaults are applied to consumers', () => {
    const groupWithDefaults = new CDCConsumerGroup({
      defaults: { startOffset: 10, batchSize: 5 },
    })

    const c1 = groupWithDefaults.addConsumer()
    const c2 = groupWithDefaults.addConsumer({ batchSize: 3 })

    expect(c1.getOffset()).toBe(10)
    // c2 的 batchSize 应覆盖Default value
    expect((c2 as any).config.batchSize).toBe(3)
  })

  test('multiple consumers each maintain independent offset', () => {
    resetSeqCounter()

    const offsets1: number[] = []
    const offsets2: number[] = []

    const c1 = group.addConsumer({
      onRecord: () => { offsets1.push(c1.getOffset()) },
    })
    const c2 = group.addConsumer({
      onRecord: () => { offsets2.push(c2.getOffset()) },
    })
    group.subscribeAll(mockStream as any)

    mockStream.emitRaw(makeNodeCreatedMsg(1))
    mockStream.emitRaw(makeNodeDeletedMsg(2))

    expect(offsets1).toEqual([1, 2])
    expect(offsets2).toEqual([1, 2])
  })
})
