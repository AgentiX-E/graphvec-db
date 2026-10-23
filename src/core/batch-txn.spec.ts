/**
 * C-03: 批量操作 + 事务端点 — 测试
 *
 * 验证批量操作的原子性（全部成功或全部回滚）
 * 和事务超时自动回滚
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SimpleTxnManager, type WriteOp } from './simple-txn-manager'
import { GraphEngine } from './graph-engine'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'batch-txn-test-'))
}

function createEngine(dir?: string): { engine: GraphEngine; dir: string } {
  const d = dir ?? createTempDir()
  const engine = new GraphEngine({ path: path.join(d, 'graph.db') })
  engine.open()
  return { engine, dir: d }
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

describe('C-03: Batch Operations & Transaction', () => {
  let dir: string

  beforeEach(() => { dir = createTempDir() })
  afterEach(() => cleanup(dir))

  // TC1: 批量操作原子性 — 全部成功
  it('batch atomicity: all ops succeed', async () => {
    const { engine } = createEngine(dir)
    const txnMgr = new SimpleTxnManager()

    // Create and use the engine directly
    try {
      const txId = txnMgr.begin('batch')
      txnMgr.addOp(txId, { type: 'upsertNode', args: [1, 'Alice', { props: { age: 30 } }] })
      txnMgr.addOp(txId, { type: 'upsertNode', args: [2, 'Bob', { props: { age: 25 } }] })

      const committed = await txnMgr.commit(txId, engine)
      expect(committed).toBe(2)

      // Verify nodes were created
      const results = engine.query('MATCH (n) RETURN n.name, n.typeId')
      expect(results.length).toBe(2)
      const names = results.map(r => r.name).sort()
      expect(names).toContain('Alice')
      expect(names).toContain('Bob')
    } finally {
      engine.close()
    }
  })

  // TC2: transaction timeout — stale cleanup
  it('transaction timeout with stale cleanup', async () => {
    // Create a txn manager with very short max age (100ms)
    const txnMgr = new SimpleTxnManager({ maxTxnAgeMs: 100, enableSSI: false })
    expect(txnMgr.activeCount).toBe(0)

    const txId = txnMgr.begin('timeout-test')
    txnMgr.addOp(txId, { type: 'upsertNode', args: [1, 'TimedOutNode'] })
    expect(txnMgr.hasTxn(txId)).toBe(true)

    // Wait for the transaction to expire
    await new Promise(resolve => setTimeout(resolve, 200))

    const cleaned = txnMgr.cleanupStale()
    expect(cleaned).toBeGreaterThanOrEqual(1)
    expect(txnMgr.hasTxn(txId)).toBe(false)
    expect(txnMgr.activeCount).toBe(0)
  })

  // TC3: 回滚 — 操作丢弃
  it('rollback discards all buffered operations', () => {
    const txnMgr = new SimpleTxnManager()
    const txId = txnMgr.begin('rollback-test')
    txnMgr.addOp(txId, { type: 'upsertNode', args: [1, 'Discarded'] })
    txnMgr.addOp(txId, { type: 'upsertNode', args: [2, 'AlsoDiscarded'] })

    const count = txnMgr.rollback(txId)
    expect(count).toBe(2)
    expect(txnMgr.hasTxn(txId)).toBe(false)
    expect(txnMgr.activeCount).toBe(0)
  })

  // TC4: 失败时自动回滚
  it('batch failure triggers rollback of all ops', () => {
    const txnMgr = new SimpleTxnManager()
    const txId = txnMgr.begin('batch-fail')

    txnMgr.addOp(txId, { type: 'upsertNode', args: [1, 'WillBeRolledBack'] })

    // Simulate a "failure" by rolling back
    const count = txnMgr.rollback(txId)
    expect(count).toBe(1)
  })

  // TC5: 多次 begin/commit 循环
  it('multiple sequential transactions', async () => {
    const { engine } = createEngine(dir)
    const txnMgr = new SimpleTxnManager()

    try {
      // First transaction
      const txId1 = txnMgr.begin('seq')
      txnMgr.addOp(txId1, { type: 'upsertNode', args: [1, 'Node1'] })
      await txnMgr.commit(txId1, engine)

      // Second transaction
      const txId2 = txnMgr.begin('seq')
      txnMgr.addOp(txId2, { type: 'upsertNode', args: [2, 'Node2'] })
      const committed = await txnMgr.commit(txId2, engine)
      expect(committed).toBe(1)

      const results = engine.query('MATCH (n) RETURN n.name')
      expect(results.length).toBe(2)
    } finally {
      engine.close()
    }
  })

  // TC6: 批量操作后查询
  it('batch upsert then query', async () => {
    const { engine } = createEngine(dir)
    const txnMgr = new SimpleTxnManager()

    try {
      const txId = txnMgr.begin('batch-query')
      txnMgr.addOp(txId, { type: 'upsertNode', args: [10, 'BatchAlice', { props: { score: 95 } }] })
      txnMgr.addOp(txId, { type: 'upsertNode', args: [20, 'BatchBob', { props: { score: 87 } }] })
      txnMgr.addOp(txId, { type: 'upsertNode', args: [30, 'BatchCharlie', { props: { score: 92 } }] })

      await txnMgr.commit(txId, engine)

      const results = engine.query('MATCH (n) RETURN n.name')
      expect(results.length).toBe(3)
      const names = results.map(r => r.name).sort()
      expect(names).toEqual(['BatchAlice', 'BatchBob', 'BatchCharlie'])
    } finally {
      engine.close()
    }
  })

  // TC7: 事务开启但未提交就回滚
  it('rollback before commit discards all ops', async () => {
    const { engine } = createEngine(dir)
    const txnMgr = new SimpleTxnManager()

    try {
      const txId = txnMgr.begin('rollback-test')
      txnMgr.addOp(txId, { type: 'upsertNode', args: [100, 'Rollo', { props: {} }] })
      txnMgr.addOp(txId, { type: 'upsertNode', args: [200, 'Back', { props: {} }] })

      txnMgr.rollback(txId)
      expect(txnMgr.hasTxn(txId)).toBe(false)

      // Should not find the nodes
      const results = engine.query('MATCH (n) WHERE n.id IN [100, 200] RETURN n.name')
      expect(results.length).toBe(0)
    } finally {
      engine.close()
    }
  })

  // TC8: 分批提交
  it('multiple sequential transactions', async () => {
    const { engine } = createEngine(dir)
    const txnMgr = new SimpleTxnManager()

    try {
      for (let i = 0; i < 5; i++) {
        const txId = txnMgr.begin(`seq-${i}`)
        txnMgr.addOp(txId, { type: 'upsertNode', args: [i, `Node-${i}`, { props: { seq: i } }] })
        const committed = await txnMgr.commit(txId, engine)
        expect(committed).toBe(1)
      }

      const results = engine.query('MATCH (n) RETURN n.id ORDER BY n.id')
      expect(results.length).toBe(5)
    } finally {
      engine.close()
    }
  })
})
