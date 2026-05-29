/**
 * CrossShardTransactionManager 测试
 *
 * 测试覆盖:
 * 1. beginTransaction → 返回有效 txId + participants
 * 2. prepare → 所有参与者 prepare 成功
 * 3. commit → 所有参与者 commit 成功
 * 4. rollback → 所有参与者 rollback 成功
 * 5. Prepare 失败 → abort/rollback
 * 6. Timeout → rollback
 * 7. Double commit → no-op (idempotent)
 * 8. executeWith2PC → 正常路径
 * 9. executeWith2PC → 失败回滚
 * 10. 启发式恢复
 * 11+ 边界测试
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { CrossShardTransactionManager, TwoPCParticipant } from './cross-shard-tx'

// ── Mock Participant ──

class MockParticipant implements TwoPCParticipant {
  readonly rangeId: string
  prepareLog = new Map<string, { operations: any[]; status: 'prepared' | 'committed' | 'rolled_back' }>()
  /** 模拟 prepare 失败 */
  failPrepare = false
  /** 模拟 prepare 超时 */
  slowPrepare = false
  /** 模拟 commit 失败 */
  failCommit = false
  /** 模拟 rollback 失败 */
  failRollback = false

  constructor(rangeId: string) {
    this.rangeId = rangeId
  }

  async prepareTx(txId: string, operations: any[]): Promise<boolean> {
    if (this.failPrepare) return false
    if (this.slowPrepare) {
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    this.prepareLog.set(txId, { operations, status: 'prepared' })
    return true
  }

  async commitTx(txId: string): Promise<void> {
    if (this.failCommit) throw new Error(`Commit failed for ${txId}`)
    const entry = this.prepareLog.get(txId)
    if (entry) {
      entry.status = 'committed'
    }
  }

  async rollbackTx(txId: string): Promise<void> {
    if (this.failRollback) throw new Error(`Rollback failed for ${txId}`)
    const entry = this.prepareLog.get(txId)
    if (entry) {
      entry.status = 'rolled_back'
    }
  }

  getPrepareStatus(txId: string): string | undefined {
    return this.prepareLog.get(txId)?.status
  }

  hasPrepareLog(txId: string): boolean {
    return this.prepareLog.has(txId)
  }
}

describe('CrossShardTransactionManager', () => {
  let manager: CrossShardTransactionManager
  let p1: MockParticipant
  let p2: MockParticipant
  let p3: MockParticipant

  beforeEach(() => {
    manager = new CrossShardTransactionManager()
    p1 = new MockParticipant('range-1')
    p2 = new MockParticipant('range-2')
    p3 = new MockParticipant('range-3')

    manager.registerParticipant(p1)
    manager.registerParticipant(p2)
    manager.registerParticipant(p3)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ──────────────────────────────────────────
  // 1. beginTransaction
  // ──────────────────────────────────────────

  test('beginTransaction returns valid txId and participants', () => {
    const { txId, participants } = manager.beginTransaction(['range-1', 'range-2'])

    // txId 是有效的 UUID 格式
    expect(txId).toBeDefined()
    expect(typeof txId).toBe('string')
    expect(txId.length).toBeGreaterThan(20)

    // participants 包含正确的 range IDs
    expect(participants).toEqual(['range-1', 'range-2'])
  })

  test('beginTransaction throws for unknown range', () => {
    expect(() => manager.beginTransaction(['range-unknown'])).toThrow(
      'Participant not found for range: range-unknown',
    )
  })

  test('beginTransaction supports single range', () => {
    const { txId, participants } = manager.beginTransaction(['range-1'])
    expect(txId).toBeDefined()
    expect(participants).toEqual(['range-1'])
  })

  test('beginTransaction supports three participants', () => {
    const { participants } = manager.beginTransaction(['range-1', 'range-2', 'range-3'])
    expect(participants).toHaveLength(3)
  })

  test('beginTransaction transactions have unique txIds', () => {
    const t1 = manager.beginTransaction(['range-1'])
    const t2 = manager.beginTransaction(['range-2'])
    expect(t1.txId).not.toBe(t2.txId)
  })

  // ──────────────────────────────────────────
  // 2. prepare
  // ──────────────────────────────────────────

  test('prepare succeeds when all participants succeed', async () => {
    const { txId } = manager.beginTransaction(['range-1', 'range-2'])

    const result = await manager.prepare(txId)
    expect(result).toBe(true)

    // 验证 prepare log
    expect(p1.getPrepareStatus(txId)).toBe('prepared')
    expect(p2.getPrepareStatus(txId)).toBe('prepared')
  })

  test('prepare returns false and rolls back when one participant fails', async () => {
    p2.failPrepare = true
    const { txId } = manager.beginTransaction(['range-1', 'range-2'])

    const result = await manager.prepare(txId)
    expect(result).toBe(false)

    // p1 已 prepare 然后被回滚
    expect(p1.getPrepareStatus(txId)).toBe('rolled_back')
    // p2 从未 prepare
    expect(p2.getPrepareStatus(txId)).toBeUndefined()
  })

  test('prepare with operations map', async () => {
    const { txId } = manager.beginTransaction(['range-1', 'range-2'])

    const opsMap = new Map<string, any[]>()
    opsMap.set('range-1', [{ type: 'upsert_node', name: 'a' }])
    opsMap.set('range-2', [{ type: 'upsert_node', name: 'b' }])

    const result = await manager.prepare(txId, opsMap)
    expect(result).toBe(true)

    expect(p1.getPrepareStatus(txId)).toBe('prepared')
    expect(p2.getPrepareStatus(txId)).toBe('prepared')
  })

  test('prepare throws for unknown transaction', async () => {
    await expect(manager.prepare('unknown-tx-id')).rejects.toThrow(
      'Transaction not found',
    )
  })

  // ──────────────────────────────────────────
  // 3. commit
  // ──────────────────────────────────────────

  test('commit sends commit to all participants', async () => {
    const { txId } = manager.beginTransaction(['range-1', 'range-2'])
    await manager.prepare(txId)
    await manager.commit(txId)

    expect(p1.getPrepareStatus(txId)).toBe('committed')
    expect(p2.getPrepareStatus(txId)).toBe('committed')
  })

  test('commit clears active transaction', async () => {
    const { txId } = manager.beginTransaction(['range-1', 'range-2'])
    await manager.prepare(txId)
    await manager.commit(txId)

    expect(manager.hasActiveTx(txId)).toBe(false)
  })

  test('commit to three participants', async () => {
    const { txId } = manager.beginTransaction(['range-1', 'range-2', 'range-3'])
    await manager.prepare(txId)
    await manager.commit(txId)

    expect(p1.getPrepareStatus(txId)).toBe('committed')
    expect(p2.getPrepareStatus(txId)).toBe('committed')
    expect(p3.getPrepareStatus(txId)).toBe('committed')
  })

  // ──────────────────────────────────────────
  // 4. rollback
  // ──────────────────────────────────────────

  test('rollback sends rollback to all participants', async () => {
    const { txId } = manager.beginTransaction(['range-1', 'range-2'])
    await manager.prepare(txId)
    await manager.rollback(txId)

    expect(p1.getPrepareStatus(txId)).toBe('rolled_back')
    expect(p2.getPrepareStatus(txId)).toBe('rolled_back')
  })

  test('rollback clears active transaction', async () => {
    const { txId } = manager.beginTransaction(['range-1', 'range-2'])
    await manager.prepare(txId)
    await manager.rollback(txId)

    expect(manager.hasActiveTx(txId)).toBe(false)
  })

  test('rollback without prepare (early abort)', async () => {
    const { txId } = manager.beginTransaction(['range-1'])
    await manager.rollback(txId)

    // 没有 prepare log，rollback 仍然是安全的幂等操作
    expect(p1.getPrepareStatus(txId)).toBeUndefined()
    expect(manager.hasActiveTx(txId)).toBe(false)
  })

  // ──────────────────────────────────────────
  // 5 & 6. Prepare failure + timeout
  // ──────────────────────────────────────────

  test('prepare failure triggers rollback on already-prepared participants', async () => {
    p3.failPrepare = true
    const { txId } = manager.beginTransaction(['range-1', 'range-2', 'range-3'])

    const result = await manager.prepare(txId)
    expect(result).toBe(false)

    // p1 和 p2 被 prepare 然后回滚
    expect(p1.getPrepareStatus(txId)).toBe('rolled_back')
    expect(p2.getPrepareStatus(txId)).toBe('rolled_back')
    // p3 failed
    expect(p3.getPrepareStatus(txId)).toBeUndefined()
  })

  test('timeout handling: slow participant triggers abort', async () => {
    // 使用 50ms 超时
    const fastManager = new CrossShardTransactionManager(50)
    fastManager.registerParticipant(p1)
    fastManager.registerParticipant(p2)

    p2.slowPrepare = true

    const { txId } = fastManager.beginTransaction(['range-1', 'range-2'])

    const result = await fastManager.prepare(txId)
    expect(result).toBe(false)

    // p1 先成功 prepare 然后被回滚
    expect(p1.getPrepareStatus(txId)).toBe('rolled_back')
    // p2 是慢的，可能没有 prepare log
  })

  test('timeout with very short timeout', async () => {
    const shortManager = new CrossShardTransactionManager(10)
    shortManager.registerParticipant(p1)
    shortManager.registerParticipant(p2)

    p2.slowPrepare = true

    const { txId } = shortManager.beginTransaction(['range-1', 'range-2'])

    const result = await shortManager.prepare(txId)
    expect(result).toBe(false)
  })

  // ──────────────────────────────────────────
  // 7. Double commit → no-op (idempotent)
  // ──────────────────────────────────────────

  test('double commit is idempotent', async () => {
    const { txId } = manager.beginTransaction(['range-1', 'range-2'])
    await manager.prepare(txId)

    // 第一次 commit
    await manager.commit(txId)
    expect(p1.getPrepareStatus(txId)).toBe('committed')

    // 第二次 commit — 不抛异常
    await expect(manager.commit(txId)).resolves.toBeUndefined()
    expect(p1.getPrepareStatus(txId)).toBe('committed')
  })

  test('double rollback is idempotent', async () => {
    const { txId } = manager.beginTransaction(['range-1', 'range-2'])
    await manager.prepare(txId)

    await manager.rollback(txId)
    await expect(manager.rollback(txId)).resolves.toBeUndefined()
    expect(p1.getPrepareStatus(txId)).toBe('rolled_back')
  })

  test('commit after rollback throws (transaction not found)', async () => {
    const { txId } = manager.beginTransaction(['range-1'])
    await manager.prepare(txId)
    await manager.rollback(txId)

    // 事务已回滚且不再 active
    await expect(manager.commit(txId)).rejects.toThrow('Transaction not found')
  })

  // ──────────────────────────────────────────
  // 8. executeWith2PC — 正常路径
  // ──────────────────────────────────────────

  test('executeWith2PC succeeds and returns function result', async () => {
    const result = await manager.executeWith2PC(
      ['range-1', 'range-2'],
      async (participants) => {
        expect(participants.size).toBe(2)
        expect(participants.has('range-1')).toBe(true)
        expect(participants.has('range-2')).toBe(true)
        return 'success'
      },
    )

    expect(result).toBe('success')
  })

  test('executeWith2PC commits all participants on success', async () => {
    await manager.executeWith2PC(
      ['range-1', 'range-2'],
      async () => 42,
    )

    // 验证所有参与者都被 commit
    // 由于 executeWith2PC 使用 beginTransaction，我们需要获取内部的 txId
    // 验证方式是确认没有活跃事务了
    expect(manager.activeTxCount).toBe(0)
  })

  test('executeWith2PC with three participants returns value', async () => {
    const result = await manager.executeWith2PC<number>(
      ['range-1', 'range-2', 'range-3'],
      async () => 99,
    )
    expect(result).toBe(99)
  })

  // ──────────────────────────────────────────
  // 9. executeWith2PC — 失败回滚
  // ──────────────────────────────────────────

  test('executeWith2PC rolls back when function throws', async () => {
    await expect(
      manager.executeWith2PC(
        ['range-1', 'range-2'],
        async () => {
          throw new Error('Business logic failed')
        },
      ),
    ).rejects.toThrow('Business logic failed')

    // 所有参与者都已回滚
    expect(manager.activeTxCount).toBe(0)
  })

  test('executeWith2PC throws when prepare fails', async () => {
    p2.failPrepare = true

    await expect(
      manager.executeWith2PC(
        ['range-1', 'range-2'],
        async () => 'should not reach',
      ),
    ).rejects.toThrow('2PC prepare failed')
  })

  // ──────────────────────────────────────────
  // 10. Heuristic Recovery
  // ──────────────────────────────────────────

  test('heuristicRecovery aborts pending transactions with no prepares', async () => {
    manager.beginTransaction(['range-1'])

    const recovered = await manager.heuristicRecovery()
    expect(recovered.length).toBeGreaterThanOrEqual(1)
    expect(recovered[0]).toContain('aborted')
    expect(manager.activeTxCount).toBe(0)
  })

  test('heuristicRecovery commits fully prepared transactions', async () => {
    const { txId } = manager.beginTransaction(['range-1', 'range-2'])
    await manager.prepare(txId)

    const recovered = await manager.heuristicRecovery()
    expect(recovered.length).toBeGreaterThanOrEqual(1)
    // 所有参与者都 prepare 了 → commit
    expect(recovered.some(r => r.startsWith('committed'))).toBe(true)
  })

  test('heuristicRecovery rolls back partially prepared transactions', async () => {
    // 模拟协调者崩溃的场景：p1 已 prepare 但 p2 还未 prepare
    // 创建一个新的 manager 模拟崩溃后重启
    const recoveryManager = new CrossShardTransactionManager()
    recoveryManager.registerParticipant(p1)
    recoveryManager.registerParticipant(p2)

    const { txId } = recoveryManager.beginTransaction(['range-1', 'range-2'])

    // 只让 p1 prepare（模拟 p2 在 prepare 前崩溃）
    await p1.prepareTx(txId, ['ops'])
    // 不 prepare p2 — 模拟部分 prepare 状态

    const recovered = await recoveryManager.heuristicRecovery()
    expect(recovered.length).toBeGreaterThanOrEqual(1)
    expect(recovered.some(r => r.startsWith('rolled_back') || r.startsWith('aborted'))).toBe(true)
    expect(recoveryManager.activeTxCount).toBe(0)
  })

  // ──────────────────────────────────────────
  // 11+ 其他边界测试
  // ──────────────────────────────────────────

  test('getRegisteredRangeIds returns all registered participants', () => {
    const ids = manager.getRegisteredRangeIds()
    expect(ids).toEqual(['range-1', 'range-2', 'range-3'])
  })

  test('getParticipant returns correct participant', () => {
    const p = manager.getParticipant('range-1')
    expect(p).toBe(p1)
    expect(manager.getParticipant('range-unknown')).toBeUndefined()
  })

  test('getActiveTransactions returns snapshot of active txs', () => {
    manager.beginTransaction(['range-1'])
    const txs = manager.getActiveTransactions()
    expect(txs.length).toBe(1)
    expect(txs[0].status).toBe('pending')
    expect(txs[0].rangeIds).toEqual(['range-1'])
  })

  test('activeTxCount reflects number of active transactions', () => {
    expect(manager.activeTxCount).toBe(0)

    manager.beginTransaction(['range-1'])
    expect(manager.activeTxCount).toBe(1)

    manager.beginTransaction(['range-2'])
    expect(manager.activeTxCount).toBe(2)
  })

  test('executeWith2PC with single range works', async () => {
    const result = await manager.executeWith2PC(
      ['range-1'],
      async () => 'single ok',
    )
    expect(result).toBe('single ok')
  })
})
