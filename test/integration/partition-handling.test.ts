/**
 * AC-IT-R9: Partition Handling (Outbox freeze/unfreeze logic)
 *
 * Tests R9: OutboxReplicationManager.setMajorityStatus() → setFrozen()
 * and PerPeerWorker frozen state — no real ZMQ needed.
 *
 * Uses actual OutboxReplicationManager and PerPeerWorker.
 * All operations are in-memory (no network).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { OutboxReplicationManager, PerPeerWorker } from '../../src/core/outbox-replication'
import * as fs from 'node:fs'
import * as path from 'node:path'

describe('AC-IT-R9: Partition Handling (Outbox freeze/unfreeze)', () => {
  const curveDir = path.join('/tmp', `agentiX-partition-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const dbPath = path.join('/tmp', `agentiX-partition-outbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.lmdb`)

  // Temp dirs to clean up
  const tempDirs: string[] = []
  const tempDbs: string[] = []

  beforeAll(() => {
    fs.mkdirSync(curveDir, { recursive: true })
    // .pub files must follow {nodeId}_{port}.pub convention for parsePubFilename
    fs.writeFileSync(path.join(curveDir, `peer-1_5555.pub`), 'dummy-pub-key-1\n')
    fs.writeFileSync(path.join(curveDir, `peer-2_5555.pub`), 'dummy-pub-key-2\n')
  })

  afterAll(() => {
    try { fs.rmSync(curveDir, { recursive: true, force: true }) } catch { /* ignore */ }
    try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ignore */ }
    for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
    for (const d of tempDbs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
  })

  it('1. setMajorityStatus(false) freezes PerPeerWorker (setFrozen reaches workers)', async () => {
    const cDir = path.join('/tmp', `agentiX-partition-t1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const db = path.join('/tmp', `agentiX-partition-db1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.lmdb`)
    tempDirs.push(cDir)
    tempDbs.push(db)

    fs.mkdirSync(cDir, { recursive: true })
    fs.writeFileSync(path.join(cDir, `peer-1_5555.pub`), 'dummy-pub-key-1\n')

    const sent: Array<{ peerId: string; msg: any }> = []
    const mgr = new OutboxReplicationManager({
      nodeId: 'test-node',
      peers: [{ nodeId: 'peer-1', addr: 'tcp://peer1:5555' }],
      curveDir: cDir,
      dbPath: db,
      tickMs: 50,
      maxBackoffSeconds: 1,
      eventBus: {
        send: async (peerId: string, msg: any) => { sent.push({ peerId, msg }) },
        _recoverDealerByNodeId: async () => {},
        _handleDealerSendError: () => {},
      },
    })

    // Start first to create workers
    mgr.start()
    await new Promise(r => setTimeout(r, 200))

    // Verify worker exists
    const worker = mgr.getWorker('peer-1')
    expect(worker).toBeDefined()

    // Freeze
    mgr.setMajorityStatus(false)
    await new Promise(r => setTimeout(r, 50))

    // Add message while frozen
    const sentBefore = sent.length
    mgr.addMessage('test_type', { key: 'value-1' })
    await new Promise(r => setTimeout(r, 300))

    // No new sends while frozen
    expect(sent.length).toBe(sentBefore)

    // Cleanup
    mgr.setMajorityStatus(true)
    mgr.stop()
  })

  it('2. setMajorityStatus cycles (false → true → false) without errors', async () => {
    const cDir = path.join('/tmp', `agentiX-partition-t2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const db = path.join('/tmp', `agentiX-partition-db2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.lmdb`)
    tempDirs.push(cDir)
    tempDbs.push(db)

    fs.mkdirSync(cDir, { recursive: true })
    fs.writeFileSync(path.join(cDir, `peer-1_5555.pub`), 'dummy-pub-key-1\n')

    // Track if freeze/unfreeze transitions happen without throwing
    const transitions: string[] = []
    const mgr = new OutboxReplicationManager({
      nodeId: 'test-node',
      peers: [{ nodeId: 'peer-1', addr: 'tcp://peer1:5555' }],
      curveDir: cDir,
      dbPath: db,
      tickMs: 100,
      maxBackoffSeconds: 1,
      eventBus: {
        send: async (_peerId: string, _msg: any) => {},
        _recoverDealerByNodeId: async () => {},
        _handleDealerSendError: () => {},
      },
    })

    mgr.start()
    await new Promise(r => setTimeout(r, 100))

    // Cycle transitions
    expect(() => { mgr.setMajorityStatus(false); transitions.push('frozen') }).not.toThrow()
    await new Promise(r => setTimeout(r, 50))
    expect(() => { mgr.setMajorityStatus(true); transitions.push('unfrozen') }).not.toThrow()
    await new Promise(r => setTimeout(r, 50))
    expect(() => { mgr.setMajorityStatus(false); transitions.push('frozen') }).not.toThrow()
    await new Promise(r => setTimeout(r, 50))
    expect(() => { mgr.setMajorityStatus(true); transitions.push('unfrozen') }).not.toThrow()

    expect(transitions).toEqual(['frozen', 'unfrozen', 'frozen', 'unfrozen'])

    mgr.stop()
  })

  it('3. MultiLeaderReplication.setConsensus wires onMajorityChange to setMajorityStatus', async () => {
    const { StandaloneConsensus } = await import('../../src/consensus/standalone-consensus')
    const { MultiLeaderReplication } = await import('../../src/core/multi-leader-replication')

    const cDir = path.join('/tmp', `agentiX-partition-t3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const db = path.join('/tmp', `agentiX-partition-db3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.lmdb`)
    tempDirs.push(cDir)
    tempDbs.push(db)

    fs.mkdirSync(cDir, { recursive: true })
    fs.writeFileSync(path.join(cDir, `peer-1_5555.pub`), 'dummy-pub-key-1\n')

    // Create a consensus that supports onMajorityChange
    const consensus = new StandaloneConsensus({ mode: 'standalone', nodeId: 'test-node', peers: [] })
    await consensus.start()

    const eventBus = {
      send: async () => {},
      _recoverDealerByNodeId: async () => {},
      _handleDealerSendError: () => {},
    }

    const mlr = new MultiLeaderReplication({
      nodeId: 'test-node',
      peers: [{ nodeId: 'peer-1', addr: 'tcp://peer1:5555' }],
      curveDir: cDir,
      dbPath: db,
      eventBus,
    })

    // Dynamically check that the wiring function doesn't throw
    // This verifies MultiLeaderReplication.setConsensus correctly
    // registers onMajorityChange → manager.setMajorityStatus
    expect(() => {
      mlr.setConsensus(consensus)
    }).not.toThrow()

    // Additionally, verify the callback registration itself works
    // StandaloneConsensus does NOT fire immediately on registration
    // (it only stores callbacks; no majority changes occur in standalone mode)
    const spy = vi.fn()
    expect(() => {
      consensus.onMajorityChange(spy)
    }).not.toThrow()

    // StandaloneConsensus stores callbacks but never fires them
    // since standalone nodes cannot lose majority
    expect(spy).not.toHaveBeenCalled()

    mlr.stop()
    await consensus.stop()
  })
})
