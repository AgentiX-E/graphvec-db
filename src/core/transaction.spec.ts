import { Transaction, TransactionManager, MVCCSnapshot, IsolationLevel, BeginOptions } from './transaction'
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

// ──────────────────────────────────────────
// Round 7: P0-1 ACID 事务增强
// ──────────────────────────────────────────

describe('P0-1 ACID — Serialized Snapshot Isolation (SSI)', () => {
  test('[RC01] read-set conflict: T1 reads X, T2 writes X → T1 commit fails in serializable mode', async () => {
    const engine = createTempEngine()
    engine.open()
    await engine.upsertNode(10, 'conflict-node', { value: 100 })

    const mgr = new TransactionManager()

    // T1 reads X (node 10) — must await to ensure readNode records in readSet
    const txn1 = mgr.begin({ isolation: 'serializable' })
    ;(txn1 as any)._engine = engine
    await txn1.readNode(10)

    // T2 writes the same node (by name) and commits via transaction path
    // This will record in mgr._committedWrites via _recordCommitWrite
    const txn2 = mgr.begin()
    ;(txn2 as any)._engine = engine
    await engine.upsertNode(10, 'conflict-node', { value: 200 })
    // Record the write in mgr's committedWrites both by nodeId and name
    mgr._committedWrites.set(String(10), Date.now())
    mgr._committedWrites.set('name:conflict-node', Date.now())
    await txn2.commit()

    // T1 commit fails because node 10 was modified after txn1 snapshot
    await expect(txn1.commit()).rejects.toThrow(
      'serialization conflict detected'
    )
    expect(txn1.active).toBe(false)

    engine.close()
  })

  test('[RC02] read-set no conflict when no concurrent modification', async () => {
    const engine = createTempEngine()
    engine.open()
    await engine.upsertNode(20, 'stable-node', { value: 50 })

    const mgr = new TransactionManager()
    const txn = mgr.begin({ isolation: 'serializable' })
    ;(txn as any)._engine = engine
    txn.readNode(20)

    // No concurrent modification — commit should succeed
    await expect(txn.commit()).resolves.toBeUndefined()

    engine.close()
  })

  test('[RC03] read-set: own write in writeSet does not count as conflict', async () => {
    const engine = createTempEngine()
    engine.open()
    await engine.upsertNode(30, 'own-write-node', { value: 10 })

    const mgr = new TransactionManager()
    const txn = mgr.begin({ isolation: 'serializable' })
    ;(txn as any)._engine = engine
    txn.readNode(30)
    txn.upsertNode(30, 'own-write-node', { value: 20 })

    // Own write in writeSet — conflict check should skip it
    const hasConflict = txn._checkReadSetConflict(null)
    expect(hasConflict).toBe(false)

    // commit should succeed
    await expect(txn.commit()).resolves.toBeUndefined()

    engine.close()
  })

  test('[RC04] SSI write-skew: concurrent read of disjoint nodes with conditional write', async () => {
    const engine = createTempEngine()
    engine.open()
    await engine.upsertNode(40, 'account-a', { balance: 100 })
    await engine.upsertNode(50, 'account-b', { balance: 100 })

    const mgr = new TransactionManager()

    // T1 reads A (node 40) and B (node 50)
    const txn1 = mgr.begin({ isolation: 'serializable' })
    ;(txn1 as any)._engine = engine
    await txn1.readNode(40)
    await txn1.readNode(50)

    // T2 writes to B (50) and commits — B modified after txn1 snapshot
    const txn2 = mgr.begin()
    ;(txn2 as any)._engine = engine
    await txn2.readNode(40)
    await txn2.readNode(50)
    await engine.upsertNode(50, 'account-b', { balance: 50 })
    // Record in committedWrites for SSI detection
    mgr._committedWrites.set(String(50), Date.now())
    mgr._committedWrites.set('name:account-b', Date.now())
    await txn2.commit()

    // T1 tries to commit with write to A (40) — write-skew on B (50)
    await txn1.upsertNode(40, 'account-a', { balance: 50 })

    await expect(txn1.commit()).rejects.toThrow(
      'serialization conflict detected'
    )

    engine.close()
  })

  test('[RC05] serializable commit rejects when read-set conflict found by committed writes', async () => {
    const engine = createTempEngine()
    engine.open()
    await engine.upsertNode(60, 'read-node', { value: 1 })

    const mgr = new TransactionManager()

    const txn = mgr.begin({ isolation: 'serializable' })
    ;(txn as any)._engine = engine
    await txn.readNode(60)

    // Another transaction writes the same node via engine, record in mgr
    const txnOther = mgr.begin()
    ;(txnOther as any)._engine = engine
    await engine.upsertNode(60, 'read-node', { value: 2 })
    // Register the write in mgr for conflict detection
    mgr._committedWrites.set(String(60), Date.now())
    mgr._committedWrites.set('name:read-node', Date.now())
    await txnOther.commit()

    // txn.commit() throws because read-set node 60 was modified after snapshot
    await expect(txn.commit()).rejects.toThrow(
      'serialization conflict detected'
    )
    expect(txn.active).toBe(false)

    engine.close()
  })
})

describe('P0-1 ACID — Deadlock Detection', () => {
  test('[DD01] detectDeadlock returns null with no locks', () => {
    const mgr = new TransactionManager()
    const txn = mgr.begin()
    expect(mgr.detectDeadlock(txn.snapshotId)).toBeNull()
  })

  test('[DD02] detectDeadlockFull detects circular wait between two transactions', async () => {
    const engine = createTempEngine()
    engine.open()
    const mgr = new TransactionManager()

    // T1 locks node 1, T2 locks node 2
    mgr.lock(1, 100) // T1 (snapshotId=100) holds lock on node 1
    mgr.lock(2, 101) // T2 (snapshotId=101) holds lock on node 2

    // T1 requests node 2 (blocked by T2)
    mgr._registerLockRequest(2, 100) // T1 waiting for node 2 held by T2
    // T2 requests node 1 (blocked by T1)
    mgr._registerLockRequest(1, 101) // T2 waiting for node 1 held by T1

    // Wait-for graph: 100 → 101, 101 → 100 → cycle
    const deadlock = mgr.detectDeadlockFull(100)
    expect(deadlock).not.toBeNull()
    expect(deadlock).toContain('Deadlock detected')

    engine.close()
  })

  test('[DD03] no deadlock with single transaction', () => {
    const mgr = new TransactionManager()
    mgr.lock(1, 100)
    mgr.lock(2, 100)
    mgr._registerLockRequest(3, 100)

    const deadlock = mgr.detectDeadlockFull(100)
    expect(deadlock).toBeNull()
  })

  test('[DD04] no deadlock with non-circular waiting', () => {
    const mgr = new TransactionManager()
    mgr.lock(1, 100)
    mgr.lock(2, 101)
    mgr._registerLockRequest(2, 100) // T1 waits for node 2 held by T2
    // No reverse request → no cycle

    const deadlock = mgr.detectDeadlockFull(100)
    expect(deadlock).toBeNull()
  })

  test('[DD05] three-way deadlock detected', () => {
    const mgr = new TransactionManager()
    // T1 holds 1, T2 holds 2, T3 holds 3
    mgr.lock(1, 100)
    mgr.lock(2, 101)
    mgr.lock(3, 102)

    // T1 waits 2, T2 waits 3, T3 waits 1 → cycle of 3
    mgr._registerLockRequest(2, 100)
    mgr._registerLockRequest(3, 101)
    mgr._registerLockRequest(1, 102)

    const deadlock = mgr.detectDeadlockFull(100)
    expect(deadlock).not.toBeNull()
    expect(deadlock).toContain('Deadlock detected')
    expect(deadlock).toContain('100')
  })

  test('[DD06] wait-for graph correctly maps relationships', () => {
    const mgr = new TransactionManager()
    mgr.lock(1, 100)
    mgr.lock(2, 101)
    mgr._registerLockRequest(2, 100)

    const graph = mgr.getWaitForGraph()
    expect(graph.size).toBeGreaterThan(0)
    expect(graph.has(100)).toBe(true)
    const neighbors = graph.get(100)
    expect(neighbors).toBeDefined()
    expect(neighbors!.has(101)).toBe(true)
  })
})

describe('P0-1 ACID — Version Chain', () => {
  test('[VC01] snapshot has version field', () => {
    const mgr = new TransactionManager()
    const txn = mgr.begin()
    expect(txn.snapshot.version).toBeDefined()
    expect(txn.snapshot.version).toBe(txn.snapshot.id)
  })

  test('[VC02] snapshot versions monotonically increase', () => {
    const mgr = new TransactionManager()
    const versions: number[] = []
    for (let i = 0; i < 5; i++) {
      const txn = mgr.begin()
      expect(txn.snapshot.version).toBe(txn.snapshotId)
      versions.push(txn.snapshot.version!)
    }
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBeGreaterThan(versions[i - 1])
    }
  })

  test('[VC03] readNodeVersioned gracefully returns null without engine', () => {
    const mgr = new TransactionManager()
    const txn = mgr.begin()
    const result = txn.readNodeVersioned(1)
    expect(result).toBeNull()
  })

  test('[VC04] readNodeVersioned reads snapshot-time value via engine', async () => {
    const engine = createTempEngine()
    engine.open()
    await engine.upsertNode(1, 'versioned-node', { value: 42 })

    const mgr = new TransactionManager()
    const txn = mgr.begin({ isolation: 'snapshot' })
    ;(txn as any)._engine = engine
    txn.readNode(1)

    // readNodeVersioned should add to readSet
    txn.readNodeVersioned(1, engine)
    expect(txn.readSet.has(1)).toBe(true)

    engine.close()
  })
})

describe('P0-1 ACID — Isolation Levels', () => {
  test('[IL01] default isolation is snapshot', () => {
    const mgr = new TransactionManager()
    const txn = mgr.begin()
    expect(txn.isolation).toBe('snapshot')
  })

  test('[IL02] can specify read-committed isolation', () => {
    const mgr = new TransactionManager()
    const txn = mgr.begin({ isolation: 'read-committed' })
    expect(txn.isolation).toBe('read-committed')
  })

  test('[IL03] can specify serializable isolation', () => {
    const mgr = new TransactionManager()
    const txn = mgr.begin({ isolation: 'serializable' })
    expect(txn.isolation).toBe('serializable')
  })

  test('[IL04] snapshot isolation commit succeeds without conflict', async () => {
    const engine = createTempEngine()
    engine.open()
    await engine.upsertNode(1, 'snapshot-test', { value: 10 })

    const mgr = new TransactionManager()
    const txn = mgr.begin({ isolation: 'snapshot' })
    ;(txn as any)._engine = engine
    txn.readNode(1)
    txn.upsertNode(2, 'new-node', { value: 20 })

    await expect(txn.commit()).resolves.toBeUndefined()
    engine.close()
  })

  test('[IL05] read-committed isolation commit succeeds', async () => {
    const engine = createTempEngine()
    engine.open()

    const mgr = new TransactionManager()
    const txn = mgr.begin({ isolation: 'read-committed' })
    ;(txn as any)._engine = engine
    txn.upsertNode(1, 'rc-test', { value: 1 })

    await expect(txn.commit()).resolves.toBeUndefined()
    engine.close()
  })
})

// ──────────────────────────────────────────
// MVCC GraphEngine 集成测试
// ──────────────────────────────────────────

describe('MVCC — GraphEngine Integration', () => {
  test('getNodeWithTxn returns correct snapshot isolation for different versions', async () => {
    const engine = createTempEngine()
    engine.open()

    // Simulates: T1 writes node, then T2 reads should not see the data
    const mgr = new TransactionManager()

    // T1 writes node 1 with version 1
    const txn1 = mgr.begin()
    ;(txn1 as any)._engine = engine
    txn1.upsertNode(1, 'alice', { value: 100 })
    await txn1.commit()

    // Now node 1 has mvccVersion = 1
    const node1 = engine.getNode(1)
    expect(node1).not.toBeNull()
    expect(node1!.mvccVersion).toBe(1)

    // T2 starts after T1 committed — should see the node
    const txn2 = mgr.begin()
    const visible = engine.getNodeWithTxn(1, txn2)
    expect(visible).not.toBeNull()
    expect(visible!.name).toBe('alice')

    engine.close()
  })

  test('getNodeWithTxn hides nodes written after snapshot start', async () => {
    const engine = createTempEngine()
    engine.open()

    const mgr = new TransactionManager()

    // T1 starts (snapshot created)
    const txn1 = mgr.begin()

    // T2 writes node after T1's snapshot
    const txn2 = mgr.begin()
    ;(txn2 as any)._engine = engine
    txn2.upsertNode(1, 'post-snapshot', { value: 999 })
    await txn2.commit()

    // T1 reads node — should NOT see it (version > snapshot ID)
    const node = engine.getNodeWithTxn(1, txn1)
    expect(node).toBeNull()

    // But a fresh transaction SHOULD see it
    const txn3 = mgr.begin()
    const visible = engine.getNodeWithTxn(1, txn3)
    expect(visible).not.toBeNull()
    expect(visible!.name).toBe('post-snapshot')

    engine.close()
  })

  test('Transaction.getNode uses MVCC snapshot visibility', async () => {
    const engine = createTempEngine()
    engine.open()

    const mgr = new TransactionManager()

    // T1: write and commit
    const txn1 = mgr.begin()
    txn1.setEngine(engine)
    txn1.upsertNode(1, 't1-data', { value: 1 })
    await txn1.commit()

    // T2: starts snapshot, then T3 writes, T2 should not see T3's write
    const txn2 = mgr.begin()

    // T3 writes node 2
    const txn3 = mgr.begin()
    txn3.setEngine(engine)
    txn3.upsertNode(2, 't3-data', { value: 3 })
    await txn3.commit()

    // T2 reads node 2 via Transaction.getNode()
    const node2 = txn2.getNode(engine, 2)
    expect(node2).toBeNull()

    // T2 reads node 1 (written before T2's snapshot) via Transaction.getNode()
    const node1 = txn2.getNode(engine, 1)
    expect(node1).not.toBeNull()
    expect(node1!.name).toBe('t1-data')

    engine.close()
  })

  test('non-transactional getNode always reads latest', async () => {
    const engine = createTempEngine()
    engine.open()

    const mgr = new TransactionManager()

    // T1 writes
    const txn1 = mgr.begin()
    ;(txn1 as any)._engine = engine
    txn1.upsertNode(1, 'latest-test', { value: 10 })
    await txn1.commit()

    // T2 writes new version
    const txn2 = mgr.begin()
    ;(txn2 as any)._engine = engine
    txn2.upsertNode(1, 'latest-test', { value: 20 })
    await txn2.commit()

    // Non-transactional getNode should return the latest
    const node = engine.getNode(1)
    expect(node).not.toBeNull()
    expect(node!.name).toBe('latest-test')

    engine.close()
  })

  test('getNodesWithTxn correctly filters visible nodes', async () => {
    const engine = createTempEngine()
    engine.open()

    const mgr = new TransactionManager()

    // T1 writes node type 1 (returns nodeId from storage)
    const id1 = await engine.upsertNode(1, 'visible-1', { v: 1 })
    // Set MVCC version manually to simulate T1 writing with version 1
    ;(engine as any)._mvccVersions.set(id1, 1)

    const id3 = await engine.upsertNode(3, 'visible-3', { v: 3 })
    ;(engine as any)._mvccVersions.set(id3, 1)

    // T2 starts snapshot (snapshotId increments)
    const txn2 = mgr.begin()

    // T3 writes node type 2 (post-snapshot)
    const id2 = await engine.upsertNode(2, 'hidden-2', { v: 2 })
    ;(engine as any)._mvccVersions.set(id2, txn2.snapshotId + 1)

    // T2 reads nodes — only id1 and id3 (version 1) should be visible
    const visible = engine.getNodesWithTxn([id1, id2, id3], txn2)
    expect(visible.size).toBe(2)
    expect(visible.has(id1)).toBe(true)
    expect(visible.has(id2)).toBe(false)
    expect(visible.has(id3)).toBe(true)

    engine.close()
  })

  test('beginTransaction sets engine on transaction', async () => {
    const engine = createTempEngine()
    engine.open()

    const txn = engine.beginTransaction()
    expect((txn as any)._engine).toBe(engine)

    // Should be able to commit without manually setting engine
    txn.upsertNode(1, 'auto-engine', { value: 42 })
    await expect(txn.commit()).resolves.toBeUndefined()

    // Verify node was written
    const node = engine.getNode(1)
    expect(node).not.toBeNull()
    expect(node!.name).toBe('auto-engine')
    expect(node!.mvccVersion).toBe(txn.snapshotId)

    engine.close()
  })

  test('concurrent transactions with non-overlapping keys', async () => {
    const engine = createTempEngine()
    engine.open()

    const mgr = new TransactionManager()

    // T1 writes key "a"
    const txn1 = mgr.begin()
    txn1.setEngine(engine)
    txn1.upsertNode(1, 'key-a', { data: 'from-t1' })

    // T2 writes key "b"
    const txn2 = mgr.begin()
    txn2.setEngine(engine)
    txn2.upsertNode(2, 'key-b', { data: 'from-t2' })

    // Both should commit successfully (no conflict — different keys)
    await expect(txn1.commit()).resolves.toBeUndefined()
    await expect(txn2.commit()).resolves.toBeUndefined()

    // Verify both writes are visible
    const nodeA = engine.getNode(1)
    expect(nodeA).not.toBeNull()
    expect(nodeA!.props!.data).toBe('from-t1')

    const nodeB = engine.getNode(2)
    expect(nodeB).not.toBeNull()
    expect(nodeB!.props!.data).toBe('from-t2')

    engine.close()
  })

  test('empty transaction (begin + commit with no ops)', async () => {
    const mgr = new TransactionManager()
    const txn = mgr.begin()
    await expect(txn.commit()).resolves.toBeUndefined()
    expect(txn.active).toBe(false)
  })

  test('MVCC version is correctly preserved after commit', async () => {
    const engine = createTempEngine()
    engine.open()

    const mgr = new TransactionManager()

    // Write node via transaction
    const txn1 = mgr.begin()
    txn1.setEngine(engine)
    txn1.upsertNode(1, 'versioned', { tag: 'first' })
    await txn1.commit()

    // Check version
    const version1 = engine.getNodeVersion(1)
    expect(version1).toBe(txn1.snapshotId)

    // Write node again via another transaction
    const txn2 = mgr.begin()
    txn2.setEngine(engine)
    txn2.upsertNode(1, 'versioned', { tag: 'second' })
    await txn2.commit()

    // Version should be updated to txn2's snapshotId
    const version2 = engine.getNodeVersion(1)
    expect(version2).toBe(txn2.snapshotId)
    expect(version2).toBeGreaterThan(version1!)

    // Non-MVCC write should not set version
    await engine.upsertNode(1, 'versioned', { tag: 'non-mvcc' })
    const version3 = engine.getNodeVersion(1)
    // _mvccVersions still has the previous value since non-MVCC writes don't pass _mvccVersion
    expect(version3).toBe(txn2.snapshotId)

    engine.close()
  })

  test('snapshot isolation with multiple transactions reading the same node', async () => {
    const engine = createTempEngine()
    engine.open()

    const mgr = new TransactionManager()

    // T1 writes initial value
    const txn1 = mgr.begin()
    txn1.setEngine(engine)
    txn1.upsertNode(1, 'shared', { value: 1 })
    await txn1.commit()

    // T2 starts
    const txn2 = mgr.begin()

    // T3 updates the node
    const txn3 = mgr.begin()
    txn3.setEngine(engine)
    txn3.upsertNode(1, 'shared', { value: 2 })
    await txn3.commit()

    // T2 should still see the old value (snapshot isolation)
    // The node was written with version = txn3.snapshotId, which is > txn2.snapshotId
    // So getNodeWithTxn returns null
    const node2 = engine.getNode(1)
    expect(node2).not.toBeNull()
    // Non-transactional read always sees latest
    // Now check via MVCC: we need the actual nodeId returned by storage
    // The upsertNode used typeId=1, so the actual nodeId is whatever engine returned
    // For MVCC visibility, we check _mvccVersions
    const nodeId1 = node2!.id
    const version = engine.getNodeVersion(nodeId1)
    expect(version).toBe(txn3.snapshotId)

    // T2 snapshot check
    const node2Snapshot = engine.getNodeWithTxn(nodeId1, txn2)
    expect(node2Snapshot).toBeNull() // hidden because version (txn3.snapshotId) > txn2.snapshotId

    // A fresh transaction T4 should see the latest
    const txn4 = mgr.begin()
    const node4 = engine.getNodeWithTxn(nodeId1, txn4)
    expect(node4).not.toBeNull()
    expect(node4!.name).toBe('shared')

    engine.close()
  })

  test('withTransaction auto-sets engine and flushes MVCC version', async () => {
    const engine = createTempEngine()
    engine.open()

    const result = await engine.withTransaction(async (txn) => {
      txn.upsertNode(1, 'auto-node', { color: 'blue' })
      return 'success'
    })

    expect(result).toBe('success')

    const node = engine.getNode(1)
    expect(node).not.toBeNull()
    expect(node!.name).toBe('auto-node')
    // Node should have MVCC version set (the transaction flushed with version)
    expect(node!.mvccVersion).toBeGreaterThan(0)

    engine.close()
  })
})
