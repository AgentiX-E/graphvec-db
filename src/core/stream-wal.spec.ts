/**
 * StreamWal 单元测试
 */

import { StreamWal, StreamMessage, FLAG_PENDING } from './stream-wal'
import * as path from 'node:path'
import * as fs from 'node:fs'

const TEST_DIR = path.join('/tmp', `stream-wal-test-${Date.now()}`)

function makeMsg(seq: number, overrides?: Partial<StreamMessage>): StreamMessage {
  return {
    msgId: `node-a-${seq}`,
    seq,
    nodeId: 'node-a',
    timestamp: Date.now(),
    type: 'node:created',
    data: { id: seq },
    ...overrides,
  }
}

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true })
})

afterAll(() => {
  try { fs.rmSync(TEST_DIR, { recursive: true }) } catch { /* ignore */ }
})

describe('StreamWal', () => {
  let wal: StreamWal

  beforeEach(() => {
    wal = new StreamWal(path.join(TEST_DIR, 'test.wal'))
    wal.open()
  })

  afterEach(() => {
    wal.drop()
  })

  describe('基本 append / read / count', () => {
    it('append 后 size 增加', () => {
      expect(wal.size).toBe(0)
      wal.append(makeMsg(1))
      expect(wal.size).toBe(1)
      wal.append(makeMsg(2))
      expect(wal.size).toBe(2)
    })

    it('readPending 返回超时的 PENDING 消息', () => {
      const past = Date.now() - 10000
      const now = Date.now()
      wal.append(makeMsg(1, { timestamp: past }))
      wal.append(makeMsg(2, { timestamp: now + 10000 })) // 未超时

      const pending = wal.readPending(Date.now())
      expect(pending.length).toBe(1)
      expect(pending[0].seq).toBe(1)
    })

    it('acknowledge 标记后不再被 readPending 返回', () => {
      const past = Date.now() - 10000
      wal.append(makeMsg(1, { timestamp: past }))
      wal.acknowledge(['node-a-1'])
      const pending = wal.readPending(Date.now())
      expect(pending.length).toBe(0)
    })
  })

  describe('acknowledge', () => {
    it('支持多种 ID 批量确认', () => {
      wal.append(makeMsg(1))
      wal.append(makeMsg(2))
      wal.append(makeMsg(3))
      wal.acknowledge(new Set(['node-a-1', 'node-a-3']))

      const past = Date.now() + 60000 // 所有消息都已超时
      const pending = wal.readPending(past)
      expect(pending.length).toBe(1)
      expect(pending[0].seq).toBe(2)
    })

    it('空 Set 不产生副作用', () => {
      wal.append(makeMsg(1))
      wal.acknowledge([])
      expect(wal.size).toBe(1)
    })
  })

  describe('markConsumed', () => {
    it('标记消费后 replay 不再包含', () => {
      wal.append(makeMsg(1))
      wal.append(makeMsg(2))
      wal.markConsumed(['node-a-1'])

      const replayed = wal.replay(0)
      expect(replayed.length).toBe(1)
      expect(replayed[0].seq).toBe(2)
    })
  })

  describe('replay', () => {
    it('从指定 seq 回放', () => {
      for (let i = 1; i <= 5; i++) wal.append(makeMsg(i))

      const replayed = wal.replay(3)
      expect(replayed.length).toBe(3) // seq 3, 4, 5
      expect(replayed.map(m => m.seq)).toEqual([3, 4, 5])
    })

    it('ACKED 的消息也应该回放（等待重试的超时确认）', () => {
      wal.append(makeMsg(1))
      wal.append(makeMsg(2))
      wal.acknowledge(['node-a-1'])

      const replayed = wal.replay(0)
      expect(replayed.length).toBe(2) // ACKED 也会回放（确认重试场景暂不需要）
    })
  })

  describe('prune', () => {
    it('只保留 PENDING 消息', () => {
      wal.append(makeMsg(1))
      wal.append(makeMsg(2))
      wal.append(makeMsg(3))
      wal.acknowledge(['node-a-2'])

      const remain = wal.prune()
      expect(remain).toBe(2) // seq 1, 3 都是 PENDING（1 没确认，3 没确认）
    })
  })

  describe('pruneByTimestamp', () => {
    it('清理早于时间戳的 ACKED/CONSUMED', () => {
      const oldTime = Date.now() - 10000
      wal.append(makeMsg(1, { timestamp: oldTime }))
      wal.append(makeMsg(2))
      wal.acknowledge(['node-a-1'])
      wal.acknowledge(['node-a-2'])

      const remain = wal.pruneByTimestamp(Date.now() - 5000)
      // msg 1 已被 ACK 且时间戳 < 阈值 → 清理
      // msg 2 已被 ACK 但时间戳 > 阈值 → 保留
      expect(remain).toBe(1)
    })
  })

  describe('文件持久化', () => {
    it('重新打开后应保留消息', () => {
      wal.append(makeMsg(1))
      wal.append(makeMsg(2))
      wal.close()

      const wal2 = new StreamWal(path.join(TEST_DIR, 'test.wal'))
      wal2.open()
      expect(wal2.size).toBe(2)

      const pending = wal2.readPending(Date.now() + 60000)
      expect(pending.length).toBe(2)
      wal2.drop()
    })
  })
})
