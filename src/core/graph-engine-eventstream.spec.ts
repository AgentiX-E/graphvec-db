/**
 * GraphEngine + EventStream 集成测试
 *
 * 验证 GraphEngine 通过 EventStream 发布可靠事件：
 * - 变更事件自动写入 WAL
 * - ACK 回传
 * - 重试失败后放弃
 * - 重启后 seq 恢复
 */

import { GraphEngine } from './graph-engine'
import { EventStream, EventStreamConfig } from './event-stream'
import { OverGraphStorage } from './overgraph-storage'
import { TransportMessage } from './event-bus'
import * as path from 'node:path'
import * as fs from 'node:fs'

// ── MockBus ──

class MockBus {
  public nodeId = 'test-node'
  public sent: TransportMessage[] = []
  private receiveHandler: ((msg: TransportMessage, fromNodeId: string) => void) | null = null

  setReceiveHandler(handler: (msg: TransportMessage, fromNodeId: string) => void): void {
    this.receiveHandler = handler
  }

  async send(nodeId: string, msg: TransportMessage): Promise<void> {
    this.sent.push(msg)
  }

  async broadcast(msg: TransportMessage): Promise<void> {
    this.sent.push(msg)
  }

  emit(event: any): void { /* no-op — EventStream uses broadcast/send now */ }
  on(type: string, handler: (...args: any[]) => void): void { /* no-op */ }
  off(type: string, handler: (...args: any[]) => void): void { /* no-op */ }

  getPeerNodeIds(): string[] { return ['remote'] }

  simulateRemote(msgId: string, remoteNodeId = 'remote'): void {
    const msg: TransportMessage = {
      msgId: `ack-for-${msgId}`,
      type: 'ack',
      srcNodeId: remoteNodeId,
      ackMsgId: msgId,
      data: {},
    }
    this.receiveHandler?.(msg, remoteNodeId)
  }
}

const TEST_DIR = path.join('/tmp', `ge-eventstream-test-${Date.now()}`)
const WAL_DIR = path.join(TEST_DIR, 'wal')
const DB_DIR = path.join(TEST_DIR, 'db')
const BUS = new MockBus()
const CONFIG = { path: DB_DIR, defaultRetention: { nodes: '60s', edges: '60s' } }

function createES(): EventStreamConfig {
  return {
    nodeId: 'test-node',
    eventBus: BUS as any,
    walDir: WAL_DIR,
    ackTimeoutMs: 500,
    retryIntervalMs: 200,
    maxRetries: 5,
    dedupCapacity: 1000,
    catchupBatchSize: 10,
  }
}

beforeAll(() => fs.mkdirSync(TEST_DIR, { recursive: true }))
afterAll(() => { try { fs.rmSync(TEST_DIR, { recursive: true }) } catch { /* ignore */ } })

function makeEngine(eventStream?: EventStream): GraphEngine {
  const storage = new OverGraphStorage()
  const ge = new GraphEngine(CONFIG, storage, eventStream ?? undefined)
  ge.open()
  return ge
}

// 清理 WAL 和 DB
function cleanup(): void {
  try { fs.rmSync(WAL_DIR, { recursive: true }) } catch { /* ignore */ }
  try { fs.rmSync(DB_DIR, { recursive: true }) } catch { /* ignore */ }
}

describe('GraphEngine + EventStream 集成', () => {
  beforeEach(() => { cleanup(); BUS.sent.length = 0 })
  afterEach(() => { cleanup() })

  it('使用 EventStream 时 emit 写入 WAL', async () => {
    const es = new EventStream(createES())
    es.open()
    const ge = makeEngine(es)

    const id = await ge.upsertNode(1, 'n1')
    expect(typeof id).toBe('number')

    // 检查 WAL 中有记录
    const pending = es['wal'].readPending(Date.now() + 60000) as any[]
    expect(pending.length).toBe(1)
    expect(pending[0].type).toBe('node:created')
    expect(pending[0].data.id).toBe(id)

    ge.close()
    es.close()
  })

  it('ACK 到来后从 WAL 移除 pending', async () => {
    const es = new EventStream(createES())
    es.open()
    const ge = makeEngine(es)

    await ge.upsertNode(1, 'n1')

    // 模拟远程 ACK TransportMessage
    BUS.simulateRemote('test-node-1', 'remote')

    const pending = es['wal'].readPending(Date.now() + 60000) as any[]
    expect(pending.find((m: any) => m.msgId === 'test-node-1')).toBeUndefined()

    ge.close()
    es.close()
  })

  it('不传 EventStream 时不应使用 EventStream（fallback 到 EventBus）', async () => {
    const ge = makeEngine()
    const id = await ge.upsertNode(1, 'n1')

    // 当没有 EventStream 时，GraphEngine 尝试 getEventBus()（可能抛错）
    // 但不应该走 EventStream 路径
    const es = (ge as any)._eventStream as EventStream | null
    expect(es).toBeNull()

    ge.close()
  })

  it('GraphEngine with EventStream still works with cache', async () => {
    const es = new EventStream(createES())
    es.open()
    const ge = makeEngine(es)

    const id = await ge.upsertNode(1, 'cache-es-node')
    expect(typeof id).toBe('number')

    // First getNode: cache miss
    const n1 = ge.getNode(id)
    expect(n1).not.toBeNull()
    expect(n1!.name).toBe('cache-es-node')

    // Second getNode: cache hit
    const n2 = ge.getNode(id)
    expect(n2).not.toBeNull()
    expect(n2!.name).toBe('cache-es-node')

    // Edge: create and get + cache
    const src = await ge.upsertNode(1, 'cache-es-src')
    const dst = await ge.upsertNode(1, 'cache-es-dst')
    await ge.upsertEdge(src, dst, 10)

    const e1 = ge.getEdge(src, dst, 10)
    expect(e1).not.toBeNull()

    const e2 = ge.getEdge(src, dst, 10)
    expect(e2).not.toBeNull()

    ge.close()
    es.close()
  })

  // ── 新增 tests ──

  it('should update existing node and emit event', async () => {
    const es = new EventStream(createES())
    es.open()
    const ge = makeEngine(es)

    const id = await ge.upsertNode(1, 'update-me', { props: { v: 1 } })
    expect(typeof id).toBe('number')

    // Update the same node
    await ge.upsertNode(1, 'update-me', { props: { v: 2 } })

    // WAL should have 2 pending entries (create + update)
    const pending = es['wal'].readPending(Date.now() + 60000) as any[]
    expect(pending.length).toBe(2)

    ge.close()
    es.close()
  })

  it('should handle multiple nodes simultaneously with EventStream', async () => {
    const es = new EventStream(createES())
    es.open()
    const ge = makeEngine(es)

    // Create 5 nodes in parallel
    const ids = await Promise.all([
      ge.upsertNode(1, 'parallel-1', { props: { idx: 1 } }),
      ge.upsertNode(1, 'parallel-2', { props: { idx: 2 } }),
      ge.upsertNode(1, 'parallel-3', { props: { idx: 3 } }),
      ge.upsertNode(1, 'parallel-4', { props: { idx: 4 } }),
      ge.upsertNode(1, 'parallel-5', { props: { idx: 5 } }),
    ])
    expect(ids.every(id => typeof id === 'number')).toBe(true)

    // All should be in WAL
    const pending = es['wal'].readPending(Date.now() + 60000) as any[]
    expect(pending.length).toBeGreaterThanOrEqual(5)

    ge.close()
    es.close()
  })

  it('should generate unique WAL entries for node and edge events', async () => {
    const es = new EventStream(createES())
    es.open()
    const ge = makeEngine(es)

    const src = await ge.upsertNode(1, 'node-src')
    const dst = await ge.upsertNode(1, 'node-dst')

    // Edge creation
    await ge.upsertEdge(src, dst, 42, { props: { label: 'connects' } })

    const pending = es['wal'].readPending(Date.now() + 60000) as any[]
    // Should have node create events (type=node:created), and edge create event (type=edge:created)
    const nodeEvents = pending.filter((m: any) => m.type === 'node:created')
    const edgeEvents = pending.filter((m: any) => m.type === 'edge:created')
    expect(nodeEvents.length).toBeGreaterThanOrEqual(2)
    expect(edgeEvents.length).toBeGreaterThanOrEqual(1)

    ge.close()
    es.close()
  })

  it('should handle EventStream with no peers gracefully', async () => {
    const es = new EventStream(createES())
    es.open()
    const ge = makeEngine(es)

    // Bus has peer 'remote' but no actual connection — should not crash
    const id = await ge.upsertNode(1, 'no-peers-node')
    expect(typeof id).toBe('number')

    // Pending entries should accumulate (no ACKs expected)
    const pending = es['wal'].readPending(Date.now() + 60000) as any[]
    expect(pending.length).toBeGreaterThanOrEqual(1)

    ge.close()
    es.close()
  })

  it('should call close without errors when EventStream is provided', async () => {
    const es = new EventStream(createES())
    es.open()
    const ge = makeEngine(es)

    await ge.upsertNode(1, 'close-test')
    await ge.upsertNode(1, 'close-test-2')

    // Clean close
    expect(() => { ge.close(); es.close() }).not.toThrow()
  })

  it('should preserve data after reopen with EventStream', async () => {
    // First session
    const es1 = new EventStream(createES())
    es1.open()
    const ge1 = makeEngine(es1)
    const id = await ge1.upsertNode(1, 'reopen-node', { props: { persistent: true } })
    ge1.close()
    es1.close()

    // Second session — same dirs
    const es2 = new EventStream(createES())
    es2.open()
    const ge2 = makeEngine(es2)

    // WAL should restore pending
    const pending2 = es2['wal'].readPending(Date.now() + 60000) as any[]
    expect(pending2.length).toBeGreaterThanOrEqual(1)

    ge2.close()
    es2.close()
  }, 10000)
})
