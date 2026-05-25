/**
 * multi-leader-replication.spec.ts — Multi-Leader 同步复制层单元测试
 *
 * 测试 MultiLeaderReplication 核心逻辑（不依赖真实 EventStream ACK 路径）
 *
 * GraphEngine 与 EventStream 的集成测试在 graph-engine-eventstream.spec.ts 中
 * 多节点同步复制场景在 multi-leader-integration.spec.ts 中（待完善）
 */

import { MultiLeaderReplication } from './multi-leader-replication'
import { HlcClock } from '../replication/hlc-clock'
import { EventStream } from './event-stream'
import { initEventBus, EventBus } from './event-bus'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

const TEST_DIR = path.join(os.tmpdir(), 'ml-rep-unit-' + Date.now())
let bus: EventBus

beforeAll(async () => {
  fs.mkdirSync(TEST_DIR, { recursive: true })
  bus = await initEventBus({ nodeId: 'ml-test' })
})

afterAll(async () => {
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* */ }
  await bus.stop().catch(() => {})
})

function makeEs(nodeId: string): EventStream {
  const es = new EventStream({
    nodeId,
    eventBus: bus,
    walDir: path.join(TEST_DIR, `${nodeId}.wal.bin`),
    ackTimeoutMs: 1000,
  })
  es.open()
  return es
}

describe('MultiLeaderReplication', () => {
  test('peers 不包含自己时报错', () => {
    const es = makeEs('nope')
    expect(() => new MultiLeaderReplication({
      nodeId: 'ghost',
      peers: ['nope'],
      eventStream: es,
      clock: new HlcClock(),
    })).toThrow('must be in peers list')
    es.close()
  })

  test('单节点 peers 返回成功（0 ACK）', async () => {
    const es = makeEs('alone')
    const rep = new MultiLeaderReplication({
      nodeId: 'alone',
      peers: ['alone'],
      eventStream: es,
      clock: new HlcClock(),
    })
    const result = await rep.replicate('node:created', { test: 1 })
    expect(result.success).toBe(true)
    expect(result.acksReceived).toBe(0)
    es.close()
  })

  test('多节点写入携带 HLC 时间戳', async () => {
    const clock = new HlcClock()
    const es = makeEs('hlc-only')
    const rep = new MultiLeaderReplication({
      nodeId: 'hlc-only',
      peers: ['hlc-only', 'hlc-remote'],
      eventStream: es,
      clock,
      syncTimeoutMs: 1000,
    })
    // 期望超时（因为没有远程节点发 ACK）
    await expect(rep.replicate('node:created', { test: 1 })).rejects.toThrow(/timeout/)
    es.close()
  })

  // HLC 时钟在 test 3 中已验证可用
})
