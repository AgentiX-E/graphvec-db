/**
 * Integration tests: AppMembershipManager (R10)
 *
 * Tests the full membership change lifecycle using manual message routing.
 * All message delivery is SYNCHRONOUS — no setImmediate, no setTimeout.
 * No real ZMQ, no real EventBus.
 */
import { describe, it, expect, vi } from 'vitest'
import { AppMembershipManager, type MembershipTransport } from '../../src/consensus/app-membership-manager'

/**
 * Creates a simulated cluster with synchronous message routing.
 * Each node's transport sends directly to the target's handleMessage.
 * No async delays, no fake timers.
 */
function createCluster(nodeIds: string[], ackTimeoutMs = 5000) {
  const managers: Record<string, AppMembershipManager> = {}
  const membersLog: Record<string, Array<string[]>> = {}
  /** Message handlers registered by each manager's start() */
  const handlers: Record<string, (from: string, msg: any) => void> = {}

  for (const nodeId of nodeIds) {
    membersLog[nodeId] = []

    const transport: MembershipTransport = {
      send: vi.fn((target: string, msg: any) => {
        const handler = handlers[target]
        if (handler) {
          handler(nodeId, msg)
        }
        return Promise.resolve()
      }),

      broadcast: vi.fn((msg: any) => {
        for (const otherId of nodeIds) {
          if (otherId !== nodeId) {
            const handler = handlers[otherId]
            if (handler) {
              handler(nodeId, msg)
            }
          }
        }
        return Promise.resolve()
      }),

      onMessage: vi.fn((cb: (from: string, msg: any) => void) => {
        handlers[nodeId] = cb
      }),

      getPeers: vi.fn(() => {
        return nodeIds
          .filter(id => id !== nodeId)
          .map(id => ({ nodeId: id, addr: `tcp://${id}:5555` }))
      }),
    }

    const manager = new AppMembershipManager({
      nodeId,
      transport,
      onMembershipChange: (members: string[]) => {
        membersLog[nodeId].push([...members])
      },
      ackTimeoutMs,
    })
    managers[nodeId] = manager
  }

  return {
    managers,
    membersLog,
    nodeIds,
    startAll() {
      for (const mgr of Object.values(managers)) mgr.start()
    },
    stopAll() {
      for (const mgr of Object.values(managers)) mgr.stop()
    },
    getMembers(nodeId: string) {
      return managers[nodeId].getMembers()
    },
    async proposeChange(nodeId: string, type: 'add' | 'remove', peerId: string) {
      return managers[nodeId].proposeChange(type, peerId)
    },
  }
}

describe('AC-IT-R10: AppMembershipManager', () => {
  it('adds peer-4 to a 3-node cluster', async () => {
    const cluster = createCluster(['node-1', 'node-2', 'node-3'])
    cluster.startAll()

    await cluster.proposeChange('node-1', 'add', 'node-4')

    const expected = ['node-1', 'node-2', 'node-3', 'node-4'].sort()
    for (const nodeId of cluster.nodeIds) {
      expect(cluster.getMembers(nodeId).sort()).toEqual(expected)
    }
    for (const nodeId of cluster.nodeIds) {
      expect(cluster.membersLog[nodeId].length).toBeGreaterThanOrEqual(1)
    }
    cluster.stopAll()
  })

  it('removes node-2 from a 3-node cluster', async () => {
    const cluster = createCluster(['node-1', 'node-2', 'node-3'])
    cluster.startAll()

    await cluster.proposeChange('node-1', 'remove', 'node-2')

    // node-1 and node-3 have the updated member list
    for (const nodeId of ['node-1', 'node-3']) {
      expect(cluster.getMembers(nodeId)).toContain('node-1')
      expect(cluster.getMembers(nodeId)).toContain('node-3')
      expect(cluster.getMembers(nodeId)).not.toContain('node-2')
    }
    cluster.stopAll()
  })

  it('add peer is idempotent', async () => {
    const cluster = createCluster(['node-1', 'node-2', 'node-3'])
    cluster.startAll()

    await cluster.proposeChange('node-1', 'add', 'node-4')
    // Adding again is a no-op
    await expect(cluster.proposeChange('node-1', 'add', 'node-4')).resolves.toBeUndefined()

    cluster.stopAll()
  })

  it('rejects concurrent proposals', async () => {
    const cluster = createCluster(['node-1', 'node-2', 'node-3'])
    cluster.startAll()

    const p1 = cluster.proposeChange('node-1', 'add', 'node-4')
    await expect(cluster.proposeChange('node-1', 'add', 'node-5')).rejects.toThrow(/Concurrent membership change/)
    await p1

    expect(cluster.getMembers('node-1')).toContain('node-4')

    // After p1 completes, can propose again
    await cluster.proposeChange('node-1', 'add', 'node-5')
    expect(cluster.getMembers('node-1')).toContain('node-5')

    cluster.stopAll()
  })

  it('validates cannot add self', async () => {
    const cluster = createCluster(['node-1', 'node-2'])
    cluster.startAll()
    await expect(cluster.proposeChange('node-1', 'add', 'node-1')).rejects.toThrow(/Cannot add self/)
    cluster.stopAll()
  })

  it('validates cannot remove self', async () => {
    const cluster = createCluster(['node-1', 'node-2'])
    cluster.startAll()
    await expect(cluster.proposeChange('node-1', 'remove', 'node-1')).rejects.toThrow(/Cannot remove self/)
    cluster.stopAll()
  })

  it('rejects proposal when not started', async () => {
    const manager = new AppMembershipManager({
      nodeId: 'node-1',
      transport: { send: vi.fn(), broadcast: vi.fn(), onMessage: vi.fn(), getPeers: vi.fn(() => []) },
      onMembershipChange: vi.fn(),
    })
    await expect(manager.proposeChange('add', 'node-2')).rejects.toThrow(/not started/)
  })

  it('handles add → add → remove sequence', async () => {
    const cluster = createCluster(['node-1', 'node-2', 'node-3'])
    cluster.startAll()

    await cluster.proposeChange('node-1', 'add', 'node-4')
    let expected = ['node-1', 'node-2', 'node-3', 'node-4'].sort()
    for (const nodeId of cluster.nodeIds) {
      expect(cluster.getMembers(nodeId).sort()).toEqual(expected)
    }

    await cluster.proposeChange('node-1', 'add', 'node-5')
    expected = ['node-1', 'node-2', 'node-3', 'node-4', 'node-5'].sort()
    for (const nodeId of cluster.nodeIds) {
      expect(cluster.getMembers(nodeId).sort()).toEqual(expected)
    }

    await cluster.proposeChange('node-1', 'remove', 'node-2')
    expected = ['node-1', 'node-3', 'node-4', 'node-5'].sort()
    for (const nodeId of cluster.nodeIds) {
      expect(cluster.getMembers(nodeId).sort()).toEqual(expected)
    }

    cluster.stopAll()
  })

  it('remove non-existent peer is no-op', async () => {
    const cluster = createCluster(['node-1', 'node-2', 'node-3'])
    cluster.startAll()

    await cluster.proposeChange('node-1', 'remove', 'node-fake')
    const expected = ['node-1', 'node-2', 'node-3'].sort()
    for (const nodeId of cluster.nodeIds) {
      expect(cluster.getMembers(nodeId).sort()).toEqual(expected)
    }

    cluster.stopAll()
  })
})
