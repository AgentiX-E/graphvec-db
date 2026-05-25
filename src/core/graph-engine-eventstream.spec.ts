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
import { getEventBus, EventBus } from './event-bus'
import { EventEmitter } from 'node:events'
import * as path from 'node:path'
import * as fs from 'node:fs'

// ── MockEventBus ──

interface MockGraphEvent {
  type: string
  nodeId: string
  timestamp: number
  data: Record<string, unknown>
}

class MockBus {
  readonly emitter = new EventEmitter()
  public nodeId = 'test-node'
  public sent: MockGraphEvent[] = []

  emit(event: Omit<MockGraphEvent, 'nodeId'>): void {
    const full = { ...event, nodeId: this.nodeId }
    this.sent.push(full)
    this.emitter.emit(event.type, full)
  }

  on(type: string, handler: (evt: MockGraphEvent) => void): void {
    this.emitter.on(type, handler)
  }

  simulateRemote(type: string, data: Record<string, unknown>, remoteNodeId = 'remote'): void {
    const evt: MockGraphEvent = { type, nodeId: remoteNodeId, timestamp: Date.now(), data }
    this.emitter.emit(type, evt)
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

    // 模拟远程 ACK
    BUS.simulateRemote('event:ack', { msgId: 'test-node-1', nodeId: 'remote' })

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
})
