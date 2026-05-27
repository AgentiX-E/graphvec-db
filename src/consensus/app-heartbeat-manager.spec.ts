/**
 * AppHeartbeatManager spec
 *
 * Tests for application-layer heartbeat-based partition detection.
 * No fake timers — uses manualTick() to control timing precisely.
 * No real ZMQ, EventBus, or database dependencies.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AppHeartbeatManager } from './app-heartbeat-manager'

// ── Mock Helpers ──

function createMockTransport() {
  const sent: Array<{ to: string; msg: any }> = []
  return {
    sent,
    send: async (peerId: string, msg: any) => {
      sent.push({ to: peerId, msg })
    },
  }
}

function makePeers(ids: string[]): Array<{ nodeId: string; addr: string }> {
  return ids.map(id => ({
    nodeId: id,
    addr: `tcp://127.0.0.1:${3000 + Number(id.slice(-1))}`,
  }))
}

function createManager(
  nodeId: string,
  peerIds: string[],
  opts?: {
    pingIntervalMs?: number
    suspectThreshold?: number
    recoveryThreshold?: number
  },
) {
  const transport = createMockTransport()
  const majorityChanges: boolean[] = []
  const manager = new AppHeartbeatManager({
    nodeId,
    peers: makePeers([nodeId, ...peerIds]),
    transport,
    pingIntervalMs: opts?.pingIntervalMs ?? 1000,
    suspectThreshold: opts?.suspectThreshold ?? 3,
    recoveryThreshold: opts?.recoveryThreshold ?? 3,
    onMajorityChange: (inMajority) => {
      majorityChanges.push(inMajority)
    },
  })
  return { manager, transport, majorityChanges }
}

describe('AppHeartbeatManager', () => {
  describe('start/stop lifecycle', () => {
    it('should start without error', () => {
      const { manager } = createManager('node-1', ['node-2', 'node-3'])
      expect(() => manager.start()).not.toThrow()
    })

    it('should be idempotent on repeated start', () => {
      const { manager } = createManager('node-1', ['node-2'])
      manager.start()
      expect(() => manager.start()).not.toThrow()
      manager.stop()
    })

    it('should clean up timers on stop', () => {
      const { manager } = createManager('node-1', ['node-2', 'node-3'])
      manager.start()
      // stop() should not throw
      expect(() => manager.stop()).not.toThrow()
    })

    it('should not send pings after stop', async () => {
      const { manager, transport } = createManager('node-1', ['node-2'])
      manager.start()
      manager.stop()
      await manager.sendPings()
      expect(transport.sent).toHaveLength(0)
    })
  })

  describe('single-node cluster', () => {
    it('should always be in majority with only self as peer', () => {
      const { manager } = createManager('node-1', [])
      manager.start()
      expect(manager.isMajority()).toBe(true)
      manager.stop()
    })

    it('should have zero peers in stats', () => {
      const { manager } = createManager('node-1', [])
      manager.start()
      expect(manager.getStats().total).toBe(0)
      expect(manager.getStats().inMajority).toBe(true)
      manager.stop()
    })
  })

  describe('ping sending', () => {
    it('should send pings to each peer after start', async () => {
      const { manager, transport } = createManager('node-1', ['node-2', 'node-3'])
      manager.start()
      await manager.sendPings()
      expect(transport.sent).toHaveLength(2)
      const targets = transport.sent.map(s => s.to).sort()
      expect(targets).toEqual(['node-2', 'node-3'])
      manager.stop()
    })

    it('should include type and from in ping message', async () => {
      const { manager, transport } = createManager('node-1', ['node-2'])
      manager.start()
      await manager.sendPings()
      expect(transport.sent[0].msg).toMatchObject({ type: 'heartbeat', from: 'node-1' })
      manager.stop()
    })

    it('should increment seq on each call', async () => {
      const { manager, transport } = createManager('node-1', ['node-2'])
      manager.start()
      await manager.sendPings()
      await manager.sendPings()
      expect(transport.sent[0].msg.seq).toBe(0)
      expect(transport.sent[1].msg.seq).toBe(1)
      manager.stop()
    })
  })

  describe('heartbeat received', () => {
    it('should clear suspect when handleHeartbeat received', async () => {
      const { manager } = createManager('node-1', ['node-2'])
      // skip start() — we manual tick
      manager.start()

      // Simulate: peer becomes suspect by doing N ticks without heartbeat
      // Each tick marks missedPings. After suspectThreshold ticks, peer is suspect.
      await manager.manualTick() // missed=1
      await manager.manualTick() // missed=2
      await manager.manualTick() // missed=3 — suspect
      await manager.manualTick() // missed=4 — stays suspect

      expect(manager.getSuspects().get('node-2')).toBe(true)

      // Receive heartbeat — should reset
      manager.handleHeartbeat('node-2')

      const suspects = manager.getSuspects()
      expect(suspects.get('node-2')).toBe(false)
      expect(manager.getStats().suspect).toBe(0)
      manager.stop()
    })

    it('should handle heartbeat from unknown peer gracefully', () => {
      const { manager } = createManager('node-1', ['node-2'])
      manager.start()
      expect(() => manager.handleHeartbeat('unknown-peer')).not.toThrow()
      manager.stop()
    })
  })

  describe('suspect on missed heartbeats', () => {
    it('should mark peer suspect after threshold missed pings', async () => {
      const { manager } = createManager('node-1', ['node-2'])
      manager.start()

      // 3 ticks = suspectThreshold=3
      await manager.manualTick()
      await manager.manualTick()
      await manager.manualTick()

      expect(manager.getSuspects().get('node-2')).toBe(true)
      manager.stop()
    })
  })

  describe('majority change', () => {
    it('should fire false when majority suspect + outbox confirmed', async () => {
      const { manager, majorityChanges } = createManager('node-1', ['node-2', 'node-3'])
      manager.start()

      await manager.manualTick() // T1
      await manager.manualTick() // T2
      await manager.manualTick() // T3 — both suspect

      // No outbox confirm yet
      expect(majorityChanges).toHaveLength(0)

      // Outbox confirms both failing
      manager.reportSendFailure('node-2', 3)
      manager.reportSendFailure('node-3', 3)

      // manualTick to trigger _recalculateMajority after outbox confirm
      await manager.manualTick()

      expect(majorityChanges).toContain(false)
      expect(manager.isMajority()).toBe(false)
      manager.stop()
    })

    it('should not fire when suspect without outbox confirm', async () => {
      const { manager, majorityChanges } = createManager('node-1', ['node-2', 'node-3'])
      manager.start()

      await manager.manualTick()
      await manager.manualTick()
      await manager.manualTick()

      // Both suspect, no outbox confirm
      expect(majorityChanges).toEqual([])
      expect(manager.isMajority()).toBe(true)
      manager.stop()
    })

    it('should fire true after recovery', async () => {
      const { manager, majorityChanges } = createManager('node-1', ['node-2'])
      manager.start()

      // Partition
      await manager.manualTick()
      await manager.manualTick()
      await manager.manualTick()
      manager.reportSendFailure('node-2', 3)
      await manager.manualTick()

      expect(majorityChanges).toContain(false)

      // Recovery — single heartbeat clears suspect + outboxConfirmedFailing
      manager.handleHeartbeat('node-2')
      await manager.manualTick()

      expect(majorityChanges).toContain(true)
      expect(manager.isMajority()).toBe(true)

      expect(majorityChanges).toContain(true)
      expect(manager.isMajority()).toBe(true)
      manager.stop()
    })

    it('should require suspect + outbox confirm to count as lost', async () => {
      const { manager } = createManager('node-1', ['node-2', 'node-3', 'node-4'])
      manager.start()

      await manager.manualTick()
      await manager.manualTick()
      await manager.manualTick()

      // All 3 suspect but only 2 confirmed
      manager.reportSendFailure('node-2', 3)
      manager.reportSendFailure('node-3', 3)
      await manager.manualTick()

      // confirmedFailed=2, total=3
      // healthy = 3-2 = 1, quorum = 2 — not enough
      expect(manager.isMajority()).toBe(false)

      // Now confirm all 3 — still no majority
      manager.reportSendFailure('node-4', 3)
      expect(manager.isMajority()).toBe(false)
      manager.stop()
    })
  })

  describe('updatePeers', () => {
    it('should track new peers', () => {
      const { manager } = createManager('node-1', ['node-2'])
      manager.start()
      expect(manager.getStats().total).toBe(1)

      manager.updatePeers(makePeers(['node-1', 'node-2', 'node-3']))
      expect(manager.getStats().total).toBe(2)
      manager.stop()
    })

    it('should preserve state for existing peers', async () => {
      const { manager } = createManager('node-1', ['node-2', 'node-3'])
      manager.start()

      await manager.manualTick()
      await manager.manualTick()
      await manager.manualTick()
      manager.reportSendFailure('node-2', 3)

      manager.updatePeers(makePeers(['node-1', 'node-2', 'node-3']))
      expect(manager.getStats().total).toBe(2)
      // node-2's outboxConfirmedFailing should persist
      const suspects = manager.getSuspects()
      // After updatePeers, _recalculateMajority runs
      // node-2 was suspect + outbox confirmed
      expect(manager.isMajority()).toBe(false)
      manager.stop()
    })

    it('should remove peers no longer in the list', () => {
      const { manager } = createManager('node-1', ['node-2', 'node-3'])
      manager.start()
      manager.updatePeers(makePeers(['node-1', 'node-3']))
      expect(manager.getStats().total).toBe(1) // only node-3
      manager.stop()
    })

    it('should recalculate majority after updatePeers', async () => {
      const { manager, majorityChanges } = createManager('node-1', ['node-2'])
      manager.start()

      await manager.manualTick()
      await manager.manualTick()
      await manager.manualTick()
      manager.reportSendFailure('node-2', 3)
      await manager.manualTick()

      expect(manager.isMajority()).toBe(false)

      // Remove the failing peer
      manager.updatePeers(makePeers(['node-1']))
      expect(majorityChanges).toContain(true)
      expect(manager.isMajority()).toBe(true)
      manager.stop()
    })
  })

  describe('getStats', () => {
    it('should return correct counts when all peers healthy', () => {
      const { manager } = createManager('node-1', ['node-2', 'node-3'])
      manager.start()
      const stats = manager.getStats()
      expect(stats.total).toBe(2)
      expect(stats.suspect).toBe(0)
      expect(stats.confirmedFailed).toBe(0)
      expect(stats.inMajority).toBe(true)
      manager.stop()
    })

    it('should return suspect count without outbox confirm', async () => {
      const { manager } = createManager('node-1', ['node-2', 'node-3'])
      manager.start()

      await manager.manualTick()
      await manager.manualTick()
      await manager.manualTick()

      const stats = manager.getStats()
      expect(stats.suspect).toBe(2)
      expect(stats.confirmedFailed).toBe(0)
      expect(stats.inMajority).toBe(true)
      manager.stop()
    })

    it('should return confirmed count with outbox', async () => {
      const { manager } = createManager('node-1', ['node-2', 'node-3'])
      manager.start()

      await manager.manualTick()
      await manager.manualTick()
      await manager.manualTick()
      manager.reportSendFailure('node-2', 3)
      manager.reportSendFailure('node-3', 3)

      const stats = manager.getStats()
      expect(stats.suspect).toBe(2)
      expect(stats.confirmedFailed).toBe(2)
      expect(stats.inMajority).toBe(false)
      manager.stop()
    })

    it('should return correct counts after recovery', async () => {
      const { manager } = createManager('node-1', ['node-2'])
      manager.start()

      await manager.manualTick()
      await manager.manualTick()
      await manager.manualTick()
      manager.reportSendFailure('node-2', 3)
      await manager.manualTick()

      // Recover with single heartbeat
      manager.handleHeartbeat('node-2')

      const stats = manager.getStats()
      expect(stats.suspect).toBe(0)
      expect(stats.confirmedFailed).toBe(0)
      expect(stats.inMajority).toBe(true)
      manager.stop()
    })
  })

  describe('edge cases', () => {
    it('should handle reportSendFailure for non-existent peer', () => {
      const { manager } = createManager('node-1', ['node-2'])
      manager.start()
      expect(() => manager.reportSendFailure('node-999', 5)).not.toThrow()
      manager.stop()
    })

    it('should not mark outbox when failures < threshold', () => {
      const { manager } = createManager('node-1', ['node-2', 'node-3'], { suspectThreshold: 5 })
      manager.start()
      manager.reportSendFailure('node-2', 3) // 3 < 5
      expect(manager.getStats().confirmedFailed).toBe(0)
      manager.stop()
    })

    it('should be no-op when not started', async () => {
      const { manager, transport } = createManager('node-1', ['node-2'])
      await manager.sendPings()
      expect(transport.sent).toHaveLength(0)
    })
  })
})
