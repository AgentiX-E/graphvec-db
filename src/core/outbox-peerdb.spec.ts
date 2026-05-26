/**
 * outbox-peerdb.spec.ts — OutboxV2 Per-Peer LMDB 分库测试
 *
 * 覆盖：
 * 1. 基本 CRUD: add → fetchPendingByPeer → markDelivered → markAcked
 * 2. 多 peer 隔离: peer-1 和 peer-2 各自 add 10 条，确认 fetch 互不干扰
 * 3. 全局 seq 唯一递增: 连续 add 到不同 peer，确认 seq 严格递增
 * 4. cleanDeliveredBefore: 清理后确认数据移除
 * 5. isAcked: markAcked 后确认 isAcked 返回 true
 * 6. LMDB 文件隔离: 确认每个 peer 创建了独立的 LMDB 目录
 */

import { OutboxV2 } from './outbox-replication'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

const TEST_DIR = path.join(os.tmpdir(), 'outbox-v2-test-' + Date.now())

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true })
})

afterAll(() => {
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* */ }
})

/**
 * 每个测试使用独立的 dbPath，避免 LMDB 环境冲突
 */
function makeDbPath(name: string): string {
  return path.join(TEST_DIR, name)
}

describe('OutboxV2 — Per-Peer LMDB 分库', () => {
  // ================================================================
  // 1. 基本 CRUD
  // ================================================================
  test('基本 CRUD: add → fetchPendingByPeer → markDelivered → markAcked', () => {
    const dbPath = makeDbPath('basic-crud')
    const outbox = new OutboxV2(dbPath)

    const seq = outbox.add({
      msgId: 'msg-1',
      targetNodeId: 'peer-a',
      type: 'node:created',
      payload: '{"id":"n1"}',
      createdAt: Date.now(),
      delivered: false,
      deliveredAt: 0,
    })
    expect(seq).toBeGreaterThan(0)

    // fetchPendingByPeer
    const pending = outbox.fetchPendingByPeer('peer-a')
    expect(pending).toHaveLength(1)
    expect(pending[0].msgId).toBe('msg-1')
    expect(pending[0].seq).toBe(seq)

    // fetchOldestPending
    const oldest = outbox.fetchOldestPending('peer-a')
    expect(oldest).not.toBeNull()
    expect(oldest!.seq).toBe(seq)

    // getPendingCount
    expect(outbox.getPendingCount()).toBe(1)
    expect(outbox.getPendingCountForPeer('peer-a')).toBe(1)

    // markDeliveredBatch
    outbox.markDeliveredBatch([seq])
    const afterDelivered = outbox.fetchPendingByPeer('peer-a')
    expect(afterDelivered).toHaveLength(0)
    expect(outbox.getPendingCountForPeer('peer-a')).toBe(0)

    // markAcked
    outbox.markAcked(seq)

    // isAcked
    expect(outbox.isAcked(seq)).toBe(true)

    outbox.close()
  })

  // ================================================================
  // 2. 多 peer 隔离
  // ================================================================
  test('多 peer 隔离: peer-1 和 peer-2 各自 add 10 条，互不干扰', () => {
    const dbPath = makeDbPath('peer-isolation')
    const outbox = new OutboxV2(dbPath)

    // peer-1: 10 条
    const seqs1: number[] = []
    for (let i = 0; i < 10; i++) {
      const seq = outbox.add({
        msgId: `p1-msg-${i}`,
        targetNodeId: 'peer-1',
        type: 'data',
        payload: JSON.stringify({ idx: i }),
        createdAt: Date.now(),
        delivered: false,
        deliveredAt: 0,
      })
      seqs1.push(seq)
    }

    // peer-2: 10 条
    const seqs2: number[] = []
    for (let i = 0; i < 10; i++) {
      const seq = outbox.add({
        msgId: `p2-msg-${i}`,
        targetNodeId: 'peer-2',
        type: 'data',
        payload: JSON.stringify({ idx: i }),
        createdAt: Date.now(),
        delivered: false,
        deliveredAt: 0,
      })
      seqs2.push(seq)
    }

    // peer-1: 10 条 pending
    const p1Pending = outbox.fetchPendingByPeer('peer-1')
    expect(p1Pending).toHaveLength(10)
    for (let i = 0; i < 10; i++) {
      expect(p1Pending[i].msgId).toBe(`p1-msg-${i}`)
    }

    // peer-2: 10 条 pending
    const p2Pending = outbox.fetchPendingByPeer('peer-2')
    expect(p2Pending).toHaveLength(10)
    for (let i = 0; i < 10; i++) {
      expect(p2Pending[i].msgId).toBe(`p2-msg-${i}`)
    }

    // 互不干扰：peer-1 的 pending 不含 p2-msg
    for (const entry of p1Pending) {
      expect(entry.msgId).not.toMatch(/^p2-/)
    }
    for (const entry of p2Pending) {
      expect(entry.msgId).not.toMatch(/^p1-/)
    }

    // 批量标记 delivered
    outbox.markDeliveredBatch(seqs1)
    expect(outbox.getPendingCountForPeer('peer-1')).toBe(0)
    expect(outbox.getPendingCountForPeer('peer-2')).toBe(10)
    expect(outbox.getPendingCount()).toBe(10)

    outbox.close()
  })

  // ================================================================
  // 3. 全局 seq 唯一递增
  // ================================================================
  test('全局 seq 唯一递增: 连续 add 到不同 peer，seq 严格递增', () => {
    const dbPath = makeDbPath('global-seq')
    const outbox = new OutboxV2(dbPath)

    const seqs: number[] = []
    // 交替写入 peer-a / peer-b
    for (let i = 0; i < 5; i++) {
      const seqA = outbox.add({
        msgId: `a-msg-${i}`,
        targetNodeId: 'peer-a',
        type: 't',
        payload: '{}',
        createdAt: Date.now(),
        delivered: false,
        deliveredAt: 0,
      })
      seqs.push(seqA)

      const seqB = outbox.add({
        msgId: `b-msg-${i}`,
        targetNodeId: 'peer-b',
        type: 't',
        payload: '{}',
        createdAt: Date.now(),
        delivered: false,
        deliveredAt: 0,
      })
      seqs.push(seqB)
    }

    // 严格递增
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1])
    }

    // 全部唯一
    const unique = new Set(seqs)
    expect(unique.size).toBe(seqs.length)

    outbox.close()
  })

  // ================================================================
  // 4. cleanDeliveredBefore
  // ================================================================
  test('cleanDeliveredBefore: 清理后确认数据移除', () => {
    const dbPath = makeDbPath('clean-before')
    const outbox = new OutboxV2(dbPath)

    const now = Date.now()

    // 旧消息（30 天前）
    const oldMsgSeq = outbox.add({
      msgId: 'old-msg',
      targetNodeId: 'peer-a',
      type: 'data',
      payload: '{}',
      createdAt: now - 30 * 86400000,
      delivered: false,
      deliveredAt: 0,
    })

    // 已送达的旧消息（20 天前送达）
    const deliveredOld = outbox.add({
      msgId: 'delivered-old',
      targetNodeId: 'peer-a',
      type: 'data',
      payload: '{}',
      createdAt: now - 30 * 86400000,
      delivered: true,
      deliveredAt: now - 20 * 86400000,
    })

    // 新消息
    const recentMsg = outbox.add({
      msgId: 'recent',
      targetNodeId: 'peer-a',
      type: 'data',
      payload: '{}',
      createdAt: now,
      delivered: true,
      deliveredAt: now,
    })

    // 标记 delivered 并 ack
    outbox.markDeliveredBatch([deliveredOld, recentMsg])

    // 清理 cutoff=14天前
    const cleaned = outbox.cleanDeliveredBefore(now - 14 * 86400000)
    expect(cleaned).toBe(1) // 只有 delivered-old

    // old-msg 还在（pending）
    expect(outbox.isAcked(oldMsgSeq)).toBe(false)
    expect(outbox.fetchPendingByPeer('peer-a').length).toBeGreaterThanOrEqual(1)

    // recent 还在（deliveredAt=now > 14天前）
    expect(outbox.isAcked(recentMsg)).toBe(false) // not acked

    // delivered-old 已被清除
    expect(outbox.isAcked(deliveredOld)).toBe(false)

    outbox.close()
  })

  // ================================================================
  // 5. isAcked: markAcked 后确认 isAcked 返回 true
  // ================================================================
  test('isAcked: markAcked 后正确返回 true', () => {
    const dbPath = makeDbPath('is-acked')
    const outbox = new OutboxV2(dbPath)

    const seq = outbox.add({
      msgId: 'ack-test',
      targetNodeId: 'peer-x',
      type: 'data',
      payload: '{}',
      createdAt: Date.now(),
      delivered: false,
      deliveredAt: 0,
    })

    expect(outbox.isAcked(seq)).toBe(false)
    expect(outbox.isAcked(9999999)).toBe(false)

    outbox.markDeliveredBatch([seq])
    outbox.markAcked(seq)

    expect(outbox.isAcked(seq)).toBe(true)

    outbox.close()
  })

  // ================================================================
  // 6. LMDB 文件隔离: 确认每个 peer 创建了独立的 LMDB 文件
  // ================================================================
  test('LMDB 文件隔离: 每个 peer 创建独立的 LMDB 文件', () => {
    const dbPath = makeDbPath('file-isolation')
    const outbox = new OutboxV2(dbPath)

    outbox.add({ msgId: 'm1', targetNodeId: 'alpha', type: 't', payload: '{}', createdAt: 1, delivered: false, deliveredAt: 0 })
    outbox.add({ msgId: 'm2', targetNodeId: 'beta', type: 't', payload: '{}', createdAt: 2, delivered: false, deliveredAt: 0 })
    outbox.add({ msgId: 'm3', targetNodeId: 'gamma', type: 't', payload: '{}', createdAt: 3, delivered: false, deliveredAt: 0 })

    // 检查文件结构：LMDB 会创建 <name>.lmdb 文件 + <name>.lmdb-lock 文件
    const files = fs.readdirSync(dbPath)
    expect(files).toContain('alpha.lmdb')
    expect(files).toContain('beta.lmdb')
    expect(files).toContain('gamma.lmdb')
    expect(files).toContain('_seq-counter.lmdb')

    // 确认是文件（LMDB v3.x 数据文件）
    for (const peerId of ['alpha', 'beta', 'gamma']) {
      const peerFile = path.join(dbPath, `${peerId}.lmdb`)
      expect(fs.statSync(peerFile).isFile()).toBe(true)
      // 存在对应的锁文件
      const lockFile = path.join(dbPath, `${peerId}.lmdb-lock`)
      expect(fs.existsSync(lockFile)).toBe(true)
    }

    outbox.close()
  })

  // ================================================================
  // 7. markPending 往返测试
  // ================================================================
  test('markPending: delivered → pending 回退', () => {
    const dbPath = makeDbPath('mark-pending')
    const outbox = new OutboxV2(dbPath)

    const seq = outbox.add({
      msgId: 'revert-test',
      targetNodeId: 'peer-r',
      type: 'data',
      payload: '{}',
      createdAt: Date.now(),
      delivered: false,
      deliveredAt: 0,
    })

    outbox.markDeliveredBatch([seq])
    expect(outbox.fetchPendingByPeer('peer-r')).toHaveLength(0)

    outbox.markPending(seq)
    const pending = outbox.fetchPendingByPeer('peer-r')
    expect(pending).toHaveLength(1)
    expect(pending[0].msgId).toBe('revert-test')
    expect(pending[0].delivered).toBe(false)

    outbox.close()
  })

  // ================================================================
  // 8. 高并发 seq 生成验证
  // ================================================================
  test('高并发 seq 生成: 多 peer 写入大量消息，seq 全局唯一', () => {
    const dbPath = makeDbPath('seq-unique-stress')
    const outbox = new OutboxV2(dbPath)

    const allSeqs: number[] = []
    const peerIds = ['peer-alpha', 'peer-beta', 'peer-gamma', 'peer-delta']

    // 每个 peer 写入 25 条 = 100 条总
    for (const peerId of peerIds) {
      for (let i = 0; i < 25; i++) {
        const seq = outbox.add({
          msgId: `${peerId}-msg-${i}`,
          targetNodeId: peerId,
          type: 'data',
          payload: JSON.stringify({ idx: i }),
          createdAt: Date.now(),
          delivered: false,
          deliveredAt: 0,
        })
        allSeqs.push(seq)
      }
    }

    // 全部唯一
    const unique = new Set(allSeqs)
    expect(unique.size).toBe(allSeqs.length)
    expect(allSeqs.length).toBe(100)

    // 严格递增
    for (let i = 1; i < allSeqs.length; i++) {
      expect(allSeqs[i]).toBeGreaterThan(allSeqs[i - 1])
    }

    // 每个 peer 的 pending 数据
    for (const peerId of peerIds) {
      const entries = outbox.fetchPendingByPeer(peerId)
      expect(entries).toHaveLength(25)
    }

    outbox.close()
  })

  // ================================================================
  // 9. getPeerDbPath 方法
  // ================================================================
  test('getPeerDbPath 返回正确的 peer LMDB 路径', () => {
    const dbPath = makeDbPath('peer-db-path')
    const outbox = new OutboxV2(dbPath)

    const pathA = outbox.getPeerDbPath('node-x')
    expect(pathA).toBe(path.join(dbPath, 'node-x.lmdb'))

    // 写入后路径存在
    outbox.add({ msgId: 'm1', targetNodeId: 'node-x', type: 't', payload: '{}', createdAt: 1, delivered: false, deliveredAt: 0 })
    expect(fs.existsSync(pathA)).toBe(true)

    outbox.close()
  })
})
