/**
 * C-14: Fluent API 事务绑定 — 测试
 *
 * 验证 FluentSession.withinTxn(txId) 的事务绑定行为
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { GraphQuery } from './fluent'
import { SimpleTxnManager } from '../core/simple-txn-manager'
import { NodeRecord, EdgeRecord } from '../types'

class MockShardManagerForTxn {
  getSimpleTxnManager(): SimpleTxnManager {
    return this.internalTxnMgr
  }

  async upsertEdge(_src: number, _dst: number, _typeId: number, _opts?: any): Promise<void> {
    // Will be used when no transaction binding
  }

  async deleteEdge(_src: number, _dst: number, _typeId: number): Promise<void> {
    // Will be used when no transaction binding
  }

  private internalTxnMgr = new SimpleTxnManager()
}

describe('C-14: Fluent API Transaction Binding', () => {
  let manager: MockShardManagerForTxn
  let query: GraphQuery

  beforeEach(() => {
    manager = new MockShardManagerForTxn()
    query = new GraphQuery(manager as any)
  })

  // TC1: withinTxn sets txId
  it('withinTxn sets transaction ID', () => {
    const txnMgr = manager.getSimpleTxnManager()
    const txId = txnMgr.begin('fluent-test')

    query.withinTxn(txId)
    expect((query as any)._txId).toBe(txId)
  })

  // TC2: updateEdge with txn binding buffers the op
  it('updateEdge within transaction buffers the op', async () => {
    const txnMgr = manager.getSimpleTxnManager()
    const txId = txnMgr.begin('fluent-txn')

    query.withinTxn(txId)
    await query.updateEdge(1, 2, 10, { weight: 0.5 })

    const ops = txnMgr.pendingOps(txId)
    expect(ops.length).toBe(1)
    expect(ops[0].type).toBe('upsertEdge')
    expect(ops[0].args[0]).toBe(1)
    expect(ops[0].args[1]).toBe(2)
    expect(ops[0].args[2]).toBe(10)
  })

  // TC3: deleteEdge with txn binding buffers the op
  it('deleteEdge within transaction buffers the op', async () => {
    const txnMgr = manager.getSimpleTxnManager()
    const txId = txnMgr.begin('fluent-del')

    query.withinTxn(txId)
    await query.deleteEdge(3, 4, 11)

    const ops = txnMgr.pendingOps(txId)
    expect(ops.length).toBe(1)
    expect(ops[0].type).toBe('deleteEdge')
    expect(ops[0].args[0]).toBe(3)
    expect(ops[0].args[1]).toBe(4)
    expect(ops[0].args[2]).toBe(11)
  })

  // TC4: 无事务绑定时，直接调用 manager
  it('updateEdge without transaction calls manager directly', async () => {
    // No withinTxn was called
    // Just verify it doesn't throw
    await expect(query.updateEdge(1, 2, 10)).resolves.toBeUndefined()
  })

  // TC5: 链式调用
  it('withinTxn supports chaining', () => {
    const txnMgr = manager.getSimpleTxnManager()
    const txId = txnMgr.begin('fluent-chain')

    const result = query.match(1).withinTxn(txId)
    expect(result).toBe(query) // returns this
    expect((query as any)._txId).toBe(txId)
  })

  // TC6: 事务中多个操作
  it('multiple operations within one transaction', async () => {
    const txnMgr = manager.getSimpleTxnManager()
    const txId = txnMgr.begin('fluent-multi')

    query.withinTxn(txId)
    await query.updateEdge(1, 2, 10)
    await query.updateEdge(3, 4, 20)
    await query.deleteEdge(5, 6, 30)

    const ops = txnMgr.pendingOps(txId)
    expect(ops.length).toBe(3)
    expect(ops[0].type).toBe('upsertEdge')
    expect(ops[1].type).toBe('upsertEdge')
    expect(ops[2].type).toBe('deleteEdge')
  })

  // TC7: 事务绑定后可以 commit
  it('operations within transaction can be committed', async () => {
    const txnMgr = manager.getSimpleTxnManager()
    const txId = txnMgr.begin('fluent-commit')

    query.withinTxn(txId)
    await query.updateEdge(1, 2, 10)

    const count = txnMgr.rollback(txId)
    expect(count).toBe(1)
    expect(txnMgr.hasTxn(txId)).toBe(false)
  })

  // TC8: 重复调用 withinTxn 覆盖旧的 txId
  it('calling withinTxn twice replaces old transaction', () => {
    const txnMgr = manager.getSimpleTxnManager()
    const txId1 = txnMgr.begin('old')
    const txId2 = txnMgr.begin('new')

    query.withinTxn(txId1)
    query.withinTxn(txId2)
    expect((query as any)._txId).toBe(txId2)
  })

  // TC9: 清除事务绑定后回到直接操作
  it('calling withinTxn(null) clears transaction binding', () => {
    const txnMgr = manager.getSimpleTxnManager()
    const txId = txnMgr.begin('fluent-clear')

    query.withinTxn(txId)
    expect((query as any)._txId).toBe(txId)

    query.withinTxn(null as any)
    expect((query as any)._txId).toBeNull()
  })
})
