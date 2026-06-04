/**
 * SegmentStreamWal 压力测试
 */
import { SegmentStreamWal, type StreamMessage } from './segment-stream-wal'
import * as fs from 'fs'
import * as path from 'path'

const TEST_DIR = '/tmp/wal-stress-test-' + Date.now()

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true })
})

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('SegmentStreamWal 压力测试', () => {
  test('并发 append 1000 条消息', () => {
    const wal = new SegmentStreamWal(path.join(TEST_DIR, 'concurrent-1000'))
    wal.open()
    const batch: StreamMessage[] = []
    for (let i = 0; i < 1000; i++) {
      batch.push({
        msgId: `node-${i}`,
        seq: i,
        nodeId: 'test-node',
        timestamp: Date.now(),
        type: 'test:msg',
        data: { idx: i, payload: 'x'.repeat(100) },
      })
    }
    for (const msg of batch) {
      wal.append(msg)
    }
    const entries = wal.replay(0)
    expect(entries.length).toBe(1000)
    entries.forEach((msg, i) => {
      expect(msg.msgId).toBe(`node-${i}`)
    })
    wal.close()
  })

  test('ACK + markConsumed 后 replay 不包含已消费消息', () => {
    const wal = new SegmentStreamWal(path.join(TEST_DIR, 'consume-test'))
    wal.open()
    for (let i = 0; i < 500; i++) {
      wal.append({
        msgId: `m-${i}`,
        seq: i,
        nodeId: 'test-node',
        timestamp: Date.now(),
        type: 'test:consume',
        data: { i },
      })
    }

    // consume 前 250 条
    const ids: string[] = []
    for (let i = 0; i < 250; i++) {
      ids.push(`m-${i}`)
    }
    wal.markConsumed(ids)

    // 追加更多
    for (let i = 500; i < 600; i++) {
      wal.append({
        msgId: `m-${i}`,
        seq: i,
        nodeId: 'test-node',
        timestamp: Date.now(),
        type: 'test:consume',
        data: { i },
      })
    }

    // replay 应只返回未 CONSUMED 的: 250~599 = 350
    const entries = wal.replay(0)
    expect(entries.length).toBe(350)
    entries.forEach(msg => {
      const idx = parseInt(msg.msgId.split('-')[1], 10)
      expect(idx).toBeGreaterThanOrEqual(250)
    })
    wal.close()
  })

  test('close + reopen 数据完整性', () => {
    const dir = path.join(TEST_DIR, 'reopen-test')

    // 写入
    const wal1 = new SegmentStreamWal(dir)
    wal1.open()
    for (let i = 0; i < 2000; i++) {
      wal1.append({
        msgId: `re-${i}`,
        seq: i,
        nodeId: 'test',
        timestamp: Date.now(),
        type: 'test:re',
        data: { i },
      })
    }
    wal1.close()

    // 重新打开
    const wal2 = new SegmentStreamWal(dir)
    wal2.open()
    const entries = wal2.replay(0)
    expect(entries.length).toBe(2000)
    entries.forEach((msg, i) => {
      expect(msg.msgId).toBe(`re-${i}`)
    })
    wal2.close()
  })

  test('empty WAL replay returns empty array', () => {
    const wal = new SegmentStreamWal(path.join(TEST_DIR, 'empty-wal'))
    wal.open()
    const entries = wal.replay(0)
    expect(entries).toEqual([])
    wal.close()
  })

  test('large batch replay with varying data sizes', () => {
    const wal = new SegmentStreamWal(path.join(TEST_DIR, 'mixed-sizes'))
    wal.open()
    const sizes = [10, 100, 500, 1000, 50]
    for (let i = 0; i < 5; i++) {
      wal.append({
        msgId: `s-${i}`,
        seq: i,
        nodeId: 'test',
        timestamp: Date.now(),
        type: 'test:mixed',
        data: { payload: 'x'.repeat(sizes[i]) },
      })
    }
    const entries = wal.replay(0)
    expect(entries.length).toBe(5)
    wal.close()
  })

  test('replay with offset skips earlier entries', () => {
    const wal = new SegmentStreamWal(path.join(TEST_DIR, 'offset-test'))
    wal.open()
    for (let i = 0; i < 100; i++) {
      wal.append({
        msgId: `off-${i}`,
        seq: i,
        nodeId: 'test',
        timestamp: Date.now(),
        type: 'test:offset',
        data: { i },
      })
    }
    const entries = wal.replay(50)
    expect(entries.length).toBe(50)
    expect(entries[0].seq).toBe(50)
    wal.close()
  })
})
