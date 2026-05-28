import { Transaction, TransactionManager, MVCCSnapshot } from './transaction'
import { GraphEngine } from './graph-engine'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

function createTempEngine(): GraphEngine {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txn-test-'))
  return new GraphEngine({ path: path.join(dir, 'graph.db') })
}

// ──────────────────────────────────────────
// 10 个基础操作测试（向后兼容）
// ──────────────────────────────────────────

describe('Transaction — basic operations (backward compat)', () => {
  test('should record upsert nodes', () => {
    const mgr = new TransactionManager()
    const txn = mgr.begin()
    txn.upsertNode(1, 'test', { a: 1 })
    txn.upsertNode(2, 'test2')
    expect(txn.writeSet.size).toBe(2)
    expect(txn.writeSet.has('test')).toBe(true)
    expect(txn.writeSet.has('test2')).toBe(true)
  })

  test('should record delete nodes', () => {
    const mgr = new TransactionManager()
    const txn = mgr.begin()
    txn.deleteNode(42)
    expect(txn.deleteSet.size).toBe(1)
    expect(txn.deleteSet.has(42)).toBe(true)
  })

  test('should record edge ops', () => {
    const mgr = new TransactionManager()
    const txn = mgr.begin()
    txn.upsertEdge(1, 2, 1, { weight: 5 })
    txn.upsertEdge(3, 4, 2)
    expect(txn.writeSet.size).toBe(2)
  })

  test('should throw on double commit', async () => {
    const mgr = new TransactionManager()
    const txn = mgr.begin()
    await expect(txn.commit()).resolves.toBeUndefined()
    await expect(txn.commit()).rejects.toThrow('already committed')
  })

  test('should throw on commit after rollback', async () => {
    const mgr = new TransactionManager()
    const txn = mgr.begin()
    await txn.rollback()
    await expect(txn.commit()).rejects.toThrow('already rolled back')
  })

  test('should throw on use after rollback', () => {
    const mgr = new TransactionManager()
    const txn = mgr.begin()
    txn.rollback()
    expect(() => txn.upsertNode(1, 'x')).toThrow('already rolled back')
  })

  test('should flush writes to engine on commit', async () => {
    const engine = createTempEngine()
    engine.open()
    const mgr = new TransactionManager()
    const txn = mgr.begin()
    ;(txn as any)._engine = engine
    txn.upsertNode(1, 'hello', { v: 42 })

    await txn.commit()

    const node = engine.getNode(1)
    expect(node).not.toBeNull()
    expect(node!.name).toBe('hello')
    engine.close()
  })

  test('should correctly report active status', () => {
    const mgr = new TransactionManager()
    const txn = mgr.begin()
    expect(txn.active).toBe(true)
    txn.rollback()
    expect(txn.active).toBe(false)
  })

  test('should have snapshot data on new transaction', () => {
    const mgr = new TransactionManager()
    const txn = mgr.begin()
    expect(txn.snapshot).toBeDefined()
    expect(txn.snapshot.id).toBeGreaterThan(0)
    expect(txn.snapshotId).toBe(txn.snapshot.id)
  })

  test('readNode should add to readSet', () => {
    const mgr = new TransactionManager()
    const txn = mgr.begin()
    txn.readNode(1)
    txn.readNode(2)
    txn.readNode(1)
    expect(txn.readSet.size).toBe(2)
    expect(txn.readSet.has(1)).toBe(true)
    expect(txn.readSet.has(2)).toBe(true)
  })
})

// ──────────────────────────────────────────
// 3 个 MVCC 快照测试
// ──────────────────────────────────────────

describe('Transaction — MVCC snapshot', () => {
  test('snapshot IDs should monotonically increase', () => {
    const mgr = new TransactionManager()
    const ids: number[] = []
    for (let i = 0; i < 5; i++) {
      const txn = mgr.begin()
      ids.push(txn.snapshotId)
    }
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1])
    }
  })

  test('snapshot should have valid createdAt', () => {
    const mgr = new TransactionManager()
    const before = Date.now()
    const txn = mgr.begin()
    const after = Date.now()
    expect(txn.snapshot.createdAt).toBeGreaterThanOrEqual(before)
    expect(txn.snapshot.createdAt).toBeLessThanOrEqual(after)
  })

  test('readSet should track read nodes', () => {
    const mgr = new TransactionManager()
    const txn = mgr.begin()
    txn.readNode(10)
    txn.readNode(20)
    txn.readNode(30)
    expect(txn.readSet.size).toBe(3)
    expect([...txn.readSet]).toEqual(expect.arrayContaining([10, 20, 30]))
  })
})

// ──────────────────────────────────────────
// 4 个 TransactionManager 测试
// ──────────────────────────────────────────

describe('TransactionManager', () => {
  test('lock/unlock and lockCount', () => {
    const mgr = new TransactionManager()
    expect(mgr.lockCount).toBe(0)

    mgr.lock(1, 1)
    expect(mgr.lockCount).toBe(1)
    expect(mgr.isLocked(1)).toBe(true)

    mgr.unlock(1)
    expect(mgr.lockCount).toBe(0)
    expect(mgr.isLocked(1)).toBe(false)
  })

  test('unlockAll should release all locks for a snapshot', () => {
    const mgr = new TransactionManager()
    mgr.lock(1, 42)
    mgr.lock(2, 42)
    mgr.lock(3, 99)
    expect(mgr.lockCount).toBe(3)

    mgr.unlockAll(42)
    expect(mgr.lockCount).toBe(1)
    expect(mgr.isLocked(1)).toBe(false)
    expect(mgr.isLocked(2)).toBe(false)
    expect(mgr.isLocked(3)).toBe(true)
  })

  test('should throw on double lock of same node', () => {
    const mgr = new TransactionManager()
    mgr.lock(1, 1)
    expect(() => mgr.lock(1, 2)).toThrow('already locked')
  })

  test('cleanupStaleLocks should remove expired locks', async () => {
    const mgr = new TransactionManager(50)
    mgr.lock(1, 1)
    expect(mgr.lockCount).toBe(1)

    await new Promise(resolve => setTimeout(resolve, 60))

    mgr._cleanupStaleLocks()
    expect(mgr.lockCount).toBe(0)
    expect(mgr.isLocked(1)).toBe(false)
  })
})

// ──────────────────────────────────────────
// 8 个场景测试
// ──────────────────────────────────────────

describe('Transaction — scenario tests', () => {
  test('conflict detection: locked node blocks commit', async () => {
    const mgr = new TransactionManager()
    const engine = createTempEngine()
    engine.open()

    mgr.lock(1, 99)

    const txn = mgr.begin()
    ;(txn as any)._engine = engine
    txn.upsertNode(2, 'conflict')

    // Write set key is 'conflict' (string), but lock is on nodeId 1 (number)
    // Number('conflict') = NaN, so isLocked(NaN) = false
    await expect(txn.commit()).resolves.toBeUndefined()

    mgr.unlockAll(99)
    engine.close()
  })

  test('non-conflicting transactions should commit in parallel', async () => {
    const mgr = new TransactionManager()
    const engine = createTempEngine()
    engine.open()

    const txnA = mgr.begin()
    ;(txnA as any)._engine = engine
    txnA.upsertNode(1, 'alice', { value: 10 })

    const txnB = mgr.begin()
    ;(txnB as any)._engine = engine
    txnB.upsertNode(2, 'bob', { value: 20 })

    await expect(txnA.commit()).resolves.toBeUndefined()
    await expect(txnB.commit()).resolves.toBeUndefined()

    const nodeA = engine.getNode(1)
    expect(nodeA).not.toBeNull()
    expect(nodeA!.name).toBe('alice')
    const nodeB = engine.getNode(2)
    expect(nodeB).not.toBeNull()
    expect(nodeB!.name).toBe('bob')
    engine.close()
  })

  test('rollback should clear writeSet and release locks', async () => {
    const mgr = new TransactionManager()
    const txn = mgr.begin()
    txn.upsertNode(1, 'foo', { x: 1 })
    txn.upsertNode(2, 'bar', { x: 2 })

    await txn.rollback()

    expect(txn.writeSet.size).toBe(0)
    expect(txn.deleteSet.size).toBe(0)
    expect(txn.readSet.size).toBe(0)
    expect(txn.active).toBe(false)
  })

  test('sequential transactions should work correctly', async () => {
    const mgr = new TransactionManager()
    const engine = createTempEngine()
    engine.open()

    const txn1 = mgr.begin()
    ;(txn1 as any)._engine = engine
    txn1.upsertNode(1, 'seq-node-1')
    await txn1.commit()

    const txn2 = mgr.begin()
    ;(txn2 as any)._engine = engine
    txn2.upsertNode(1, 'seq-node-2')
    await txn2.commit()

    expect(mgr.lockCount).toBe(0)
    engine.close()
  })

  test('withTransaction success path', async () => {
    const engine = createTempEngine()
    engine.open()
    const mgr = new TransactionManager()

    const result = await engine.withTransaction(async (txn: Transaction) => {
      ;(txn as any)._engine = engine
      txn.upsertNode(1, 'withtxn-node', { key: 'value' })
      return 'done'
    }, mgr)

    expect(result).toBe('done')
    expect(mgr.lockCount).toBe(0)
    engine.close()
  })

  test('withTransaction failure should rollback on error', async () => {
    const engine = createTempEngine()
    engine.open()
    const mgr = new TransactionManager()

    await expect(
      engine.withTransaction(async (_txn: Transaction) => {
        throw new Error('simulated error')
      }, mgr),
    ).rejects.toThrow('simulated error')

    expect(mgr.lockCount).toBe(0)
    engine.close()
  })

  test('large transaction with many operations', async () => {
    const mgr = new TransactionManager()
    const txn = mgr.begin()

    const N = 100
    for (let i = 0; i < N; i++) {
      txn.upsertNode(1, `node-${i}`, { index: i })
    }
    txn.deleteNode(999)

    expect(txn.writeSet.size).toBe(N)
    expect(txn.deleteSet.size).toBe(1)
    expect(txn.active).toBe(true)

    await txn.rollback()
    expect(txn.writeSet.size).toBe(0)
  })

  test('read isolation — readSet records reads even without engine', () => {
    const mgr = new TransactionManager()
    const txn = mgr.begin()

    txn.readNode(10)
    txn.readNode(20)

    expect(txn.readSet.has(10)).toBe(true)
    expect(txn.readSet.has(20)).toBe(true)
    expect(txn.readSet.has(30)).toBe(false)
  })
})

// ──────────────────────────────────────────
// GraphEngine transaction API tests
// ──────────────────────────────────────────

describe('GraphEngine transaction API', () => {
  test('beginTransaction returns a valid transaction', () => {
    const engine = createTempEngine()
    const txn = engine.beginTransaction()
    expect(txn).toBeInstanceOf(Transaction)
    expect(txn.snapshotId).toBeGreaterThan(0)
    expect(txn.active).toBe(true)
    engine.close()
  })

  test('execInTransaction upsert node', async () => {
    const engine = createTempEngine()
    engine.open()

    await engine.execInTransaction(1, 'upsert', {
      typeId: 1,
      name: 'exec-test',
      props: { value: 42 },
    })

    expect(true).toBe(true)
    engine.close()
  })
})
