/**
 * AC-FI-R9: Partition → Outbox freeze → heal → resume
 *
 * Fault injection test:
 * 1. Simulate partition via setMajorityStatus(false)
 * 2. Verify outbox freezes (no sends on PerPeerWorker)
 * 3. Simulate healing via setMajorityStatus(true)
 * 4. Verify outbox resumes sending
 *
 * Uses real timers (setTimeout/setInterval) with short tick intervals.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OutboxReplicationManager } from '../../src/core/outbox-replication'
import * as fs from 'node:fs'
import * as path from 'node:path'

describe('AC-FI-R9: Partition → Outbox freeze → heal → resume', () => {
  const nodeId = 'test-node'
  const peerId = 'peer-1'

  let curveDir: string
  let dbPath: string
  let mgr: OutboxReplicationManager
  const sentMsgs: string[] = []

  beforeEach(() => {
    curveDir = path.join('/tmp', `agentiX-fault-partition-outbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    dbPath = path.join('/tmp', `agentiX-fault-partition-outbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.lmdb`)

    fs.mkdirSync(curveDir, { recursive: true })
    // .pub files must follow {nodeId}_{port}.pub convention for parsePubFilename
    fs.writeFileSync(path.join(curveDir, `${peerId}_5555.pub`), 'dummy-pub-key\n')

    sentMsgs.length = 0

    mgr = new OutboxReplicationManager({
      nodeId,
      peers: [
        { nodeId: peerId, addr: 'tcp://peer1:5555' },
      ],
      curveDir,
      dbPath,
      tickMs: 50,
      maxBackoffSeconds: 1,
      eventBus: {
        send: async (_peerId: string, _msg: any) => {
          sentMsgs.push(_peerId)
        },
        _recoverDealerByNodeId: async () => {},
        _handleDealerSendError: () => {},
      },
    })
  })

  afterEach(() => {
    if (mgr) {
      try {
        mgr.setMajorityStatus(true) // unfreeze for safe cleanup
        mgr.stop()
      } catch { /* cleanup best-effort */ }
    }
    try { fs.rmSync(curveDir, { recursive: true, force: true }) } catch { /* ignore */ }
    try { fs.rmSync(dbPath, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('Simulate partition → outbox freezes → partition heals → outbox resumes', async () => {
    // Start the manager (creates workers with tickMs=50)
    mgr.start()
    await new Promise(r => setTimeout(r, 200))

    // Get worker reference
    const worker = mgr.getWorker(peerId)
    expect(worker).toBeDefined()
    expect(worker!.isRunning).toBe(true)

    // Freeze: simulate partition
    mgr.setMajorityStatus(false)

    // Add message while frozen
    mgr.addMessage('test_type', { key: 'value-1' })
    expect(mgr.getStats().pending).toBeGreaterThan(0)

    // Wait for several tick cycles while frozen
    await new Promise(r => setTimeout(r, 400))

    // While frozen, the worker's tick should skip sending
    expect(sentMsgs.length).toBe(0)

    // Heal: simulate partition recovery
    mgr.setMajorityStatus(true)

    // Wait for ticks to resume sending
    await new Promise(r => setTimeout(r, 1200))

    // Now messages should have been sent
    expect(sentMsgs.length).toBeGreaterThan(0)

    // Cleanup
    mgr.stop()
  })
})
