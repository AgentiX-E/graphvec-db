import { Transaction, TransactionManager } from './transaction'
import { GraphEngine } from './graph-engine'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

function createTempEngine(): GraphEngine {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txn-test-'))
  return new GraphEngine({ path: path.join(dir, 'graph.db') })
}

describe('Transaction', () => {
  describe('basic operations', () => {
    test('should record upsert nodes', () => {
      const txn = new Transaction()
      txn.upsertNode(1, 'test', { props: { a: 1 } })
      txn.upsertNode(2, 'test2')
      const snap = txn.snapshot()
      expect(snap.writes.length).toBe(2)
      expect(snap.writes[0].kind).toBe('upsertNode')
    })

    test('should record delete nodes', () => {
      const txn = new Transaction()
      txn.deleteNode(42)
      const snap = txn.snapshot()
      expect(snap.writes.length).toBe(1)
      expect(snap.writes[0].kind).toBe('deleteNode')
    })

    test('should record edge ops', () => {
      const txn = new Transaction()
      txn.upsertEdge(1, 2, 1, { props: { weight: 5 } })
      txn.deleteEdge(1, 2, 1)
      const snap = txn.snapshot()
      expect(snap.writes.length).toBe(2)
    })

    test('should throw on double commit', async () => {
      const txn = new Transaction()
      const engine = createTempEngine()
      await txn.commit(engine)
      await expect(txn.commit(engine)).rejects.toThrow('already committed')
      engine.close()
    })

    test('should throw on commit after rollback', async () => {
      const txn = new Transaction()
      txn.rollback()
      const engine = createTempEngine()
      await expect(txn.commit(engine)).rejects.toThrow('already rolled back')
      engine.close()
    })

    test('should throw on use after rollback', () => {
      const txn = new Transaction()
      txn.rollback()
      expect(() => txn.upsertNode(1, 'x')).toThrow('already rolled back')
    })

    test('should flush writes to engine on commit', async () => {
      const engine = createTempEngine()
      engine.open()
      const txn = new Transaction()
      txn.upsertNode(1, 'hello', { props: { v: 42 } })

      await txn.commit(engine)

      const node = engine.getNode(1)
      expect(node).not.toBeNull()
      expect(node!.name).toBe('hello')
      engine.close()
    })
  })

  describe('TransactionManager', () => {
    test('should begin transactions', () => {
      const mgr = new TransactionManager()
      const txn = mgr.begin()
      expect(txn.id).toBeGreaterThan(0)
      expect(mgr.activeCount).toBe(1)
    })

    test('should limit active transactions', () => {
      const mgr = new TransactionManager(2)
      mgr.begin()
      mgr.begin()
      expect(() => mgr.begin()).toThrow('Too many active')
    })

    test('should get and remove transactions', () => {
      const mgr = new TransactionManager()
      const txn = mgr.begin()
      expect(mgr.get(txn.id)).toBe(txn)
      mgr.remove(txn.id)
      expect(mgr.get(txn.id)).toBeUndefined()
    })
  })
})
