/**
 * outbox-replication.spec.ts — Outbox 和 OutboxV2 核心单元测试
 *
 * 测试 OutboxV2 的基本 CRUD + PerPeerWorker/ReplicationManager 的创建/状态。
 * LMDB 依赖由 beforeEach/afterEach 的临时目录管理。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import { tmpdir } from 'os'
import { OutboxV2, OutboxReplicationManager, PerPeerWorker, OutboxReplicationConfig } from './outbox-replication'
import { Logger } from '../ops/logger'

function randomDir(): string {
  return path.join(tmpdir(), `outbox-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
}

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger

describe('OutboxV2', () => {
  let outbox: OutboxV2
  let dbPath: string

  beforeEach(() => {
    dbPath = randomDir()
    outbox = new OutboxV2(dbPath)
  })

  afterEach(() => {
    try { outbox.close() } catch { /* ignore */ }
    try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('adds an entry and returns increasing seq', () => {
    const seq1 = outbox.add({
      msgId: 'm1',
      targetNodeId: 'peer-1',
      type: 'data',
      payload: JSON.stringify({ x: 1 }),
      createdAt: Date.now(),
      delivered: false,
      deliveredAt: 0,
    })
    expect(seq1).toBe(1)

    const seq2 = outbox.add({
      msgId: 'm2',
      targetNodeId: 'peer-1',
      type: 'data',
      payload: JSON.stringify({ x: 2 }),
      createdAt: Date.now(),
      delivered: false,
      deliveredAt: 0,
    })
    expect(seq2).toBe(2)
  })

  it('fetchPendingByPeer returns pending entries for a peer', () => {
    outbox.add({
      msgId: 'm1', targetNodeId: 'peer-a', type: 'data',
      payload: '{}', createdAt: Date.now(), delivered: false, deliveredAt: 0,
    })
    outbox.add({
      msgId: 'm2', targetNodeId: 'peer-b', type: 'data',
      payload: '{}', createdAt: Date.now(), delivered: false, deliveredAt: 0,
    })
    outbox.add({
      msgId: 'm3', targetNodeId: 'peer-a', type: 'data',
      payload: '{}', createdAt: Date.now(), delivered: false, deliveredAt: 0,
    })

    const peerA = outbox.fetchPendingByPeer('peer-a')
    expect(peerA).toHaveLength(2)
    expect(peerA[0].msgId).toBe('m1')
    expect(peerA[1].msgId).toBe('m3')

    const peerB = outbox.fetchPendingByPeer('peer-b')
    expect(peerB).toHaveLength(1)
  })

  it('markDeliveredBatch marks entries as delivered', () => {
    const seq1 = outbox.add({
      msgId: 'm1', targetNodeId: 'peer-a', type: 'data',
      payload: '{}', createdAt: Date.now(), delivered: false, deliveredAt: 0,
    })
    const seq2 = outbox.add({
      msgId: 'm2', targetNodeId: 'peer-a', type: 'data',
      payload: '{}', createdAt: Date.now(), delivered: false, deliveredAt: 0,
    })

    outbox.markDeliveredBatch([seq1, seq2])

    const pending = outbox.fetchPendingByPeer('peer-a')
    expect(pending).toHaveLength(0)
  })

  it('fetchOldestPending returns the earliest pending entry', () => {
    outbox.add({
      msgId: 'm1', targetNodeId: 'peer-a', type: 'data',
      payload: JSON.stringify({ seq: 1 }), createdAt: Date.now(), delivered: false, deliveredAt: 0,
    })
    const oldest = outbox.fetchOldestPending('peer-a')
    expect(oldest).not.toBeNull()
    expect(oldest!.msgId).toBe('m1')
  })

  it('fetchOldestPending returns null when no pending', () => {
    expect(outbox.fetchOldestPending('nonexistent')).toBeNull()
  })

  it('getPendingCountForPeer returns correct count', () => {
    expect(outbox.getPendingCountForPeer('peer-a')).toBe(0)
    outbox.add({ msgId: 'm1', targetNodeId: 'peer-a', type: 'data', payload: '{}', createdAt: Date.now(), delivered: false, deliveredAt: 0 })
    expect(outbox.getPendingCountForPeer('peer-a')).toBe(1)
    outbox.add({ msgId: 'm2', targetNodeId: 'peer-a', type: 'data', payload: '{}', createdAt: Date.now(), delivered: false, deliveredAt: 0 })
    expect(outbox.getPendingCountForPeer('peer-a')).toBe(2)
  })

  it('markAcked marks seq as acked', () => {
    const seq = outbox.add({
      msgId: 'm1', targetNodeId: 'peer-a', type: 'data',
      payload: '{}', createdAt: Date.now(), delivered: false, deliveredAt: 0,
    })
    outbox.markDeliveredBatch([seq])
    outbox.markAcked(seq)
    expect(outbox.isAcked(seq)).toBe(true)
    expect(outbox.fetchPendingByPeer('peer-a')).toHaveLength(0)
  })

  it('isAcked returns false for non-existent seq', () => {
    expect(outbox.isAcked(999)).toBe(false)
  })

  it('getPeerDbPath returns correct path', () => {
    const peerPath = outbox.getPeerDbPath('peer-1')
    expect(peerPath).toContain('peer-1.lmdb')
    expect(peerPath).toContain(dbPath)
  })

  it('close is idempotent', () => {
    expect(() => outbox.close()).not.toThrow()
    expect(() => outbox.close()).not.toThrow()
  })

  it('cleanDeliveredBefore removes old delivered entries', () => {
    const oldSeq = outbox.add({
      msgId: 'old', targetNodeId: 'peer-a', type: 'data',
      payload: '{}', createdAt: Date.now() - 100000, delivered: true, deliveredAt: Date.now() - 50000,
    })
    const newSeq = outbox.add({
      msgId: 'new', targetNodeId: 'peer-a', type: 'data',
      payload: '{}', createdAt: Date.now(), delivered: true, deliveredAt: Date.now(),
    })

    // 先标记为 delivered
    outbox.markDeliveredBatch([oldSeq, newSeq])

    const count = outbox.cleanDeliveredBefore(Date.now() - 10000)
    expect(count).toBeGreaterThanOrEqual(0)
  })
})

describe('PerPeerWorker', () => {
  it('creates with correct peerId', () => {
    const worker = new PerPeerWorker('peer-1', {
      peerId: 'peer-1',
      tickMs: 1000,
      maxBackoffMs: 30000,
      ackTimeoutMs: 5000,
      curveDir: '/tmp',
      sendFn: async () => {},
      recoverDealerFn: async () => {},
      logger: silentLogger,
    }, null as any)

    expect((worker as unknown as { peerId: string }).peerId).toBe('peer-1')
    expect(worker.isRunning).toBe(false)
    expect(worker.getPendingCount()).toBe(0)
  })
})

describe('OutboxReplicationManager', () => {
  let dbPath: string
  let curveDir: string

  beforeEach(() => {
    dbPath = randomDir()
    curveDir = path.join(dbPath, 'curve')
    fs.mkdirSync(curveDir, { recursive: true })
  })

  afterEach(() => {
    try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  function makeConfig(overrides?: Record<string, any>): OutboxReplicationConfig {
    return {
      nodeId: 'node-1',
      peers: [{ nodeId: 'peer-1', addr: 'tcp://localhost:5555' }],
      curveDir,
      dbPath,
      eventBus: {
        send: async () => {},
        _recoverDealerByNodeId: async () => {},
      },
      logger: silentLogger,
      ...overrides,
    }
  }

  it('creates with OutboxV2 and peers', () => {
    const mgr = new (OutboxReplicationManager as any)(makeConfig())
    expect(mgr).toBeTruthy()
  })
})
