/**
 * AC-IT-R10: Membership Change
 *
 * Tests R10: StandaloneConsensus.addPeer/removePeer/getClusterMembers
 * and onMembershipChange callback behavior.
 *
 * No real ZMQ/Raft needed — all tests use StandaloneConsensus.
 */
import { describe, expect, it, vi } from 'vitest'
import { StandaloneConsensus } from '../../src/consensus/standalone-consensus'

describe('AC-IT-R10: Membership Change (StandaloneConsensus)', () => {
  const nodeId = 'member-test-node'
  const config = {
    mode: 'standalone' as const,
    nodeId,
    peers: [] as string[],
  }

  describe('addPeer / removePeer are no-ops', () => {
    const consensus = new StandaloneConsensus(config)

    it('1. addPeer does not throw and does not change members', async () => {
      const before = consensus.getClusterMembers()
      expect(before).toEqual([nodeId])

      // Should not throw
      await expect(consensus.addPeer('new-peer-1')).resolves.toBeUndefined()

      // Members should remain unchanged (standalone mode)
      const after = consensus.getClusterMembers()
      expect(after).toEqual([nodeId])
    })

    it('2. removePeer does not throw and does not change members', async () => {
      const before = consensus.getClusterMembers()
      expect(before).toEqual([nodeId])

      // Should not throw
      await expect(consensus.removePeer('non-existent-peer')).resolves.toBeUndefined()

      // Members should remain unchanged
      const after = consensus.getClusterMembers()
      expect(after).toEqual([nodeId])
    })
  })

  describe('onMembershipChange callback', () => {
    it('3. onMembershipChange registers callbacks without errors', () => {
      const consensus = new StandaloneConsensus(config)
      const callback = vi.fn()

      // Should not throw
      expect(() => {
        consensus.onMembershipChange(callback)
      }).not.toThrow()

      // Callback should NOT fire automatically (standalone has no membership changes)
      expect(callback).not.toHaveBeenCalled()
    })

    it('4. Multiple callbacks can be registered', () => {
      const consensus = new StandaloneConsensus(config)
      const cb1 = vi.fn()
      const cb2 = vi.fn()

      consensus.onMembershipChange(cb1)
      consensus.onMembershipChange(cb2)

      // Neither fires automatically
      expect(cb1).not.toHaveBeenCalled()
      expect(cb2).not.toHaveBeenCalled()
    })

    it('5. addPeer/removePeer do not trigger membership callbacks in standalone mode', async () => {
      const consensus = new StandaloneConsensus(config)
      const callback = vi.fn()

      consensus.onMembershipChange(callback)
      expect(callback).not.toHaveBeenCalled()

      await consensus.addPeer('any-peer')
      expect(callback).not.toHaveBeenCalled()

      await consensus.removePeer('any-peer')
      expect(callback).not.toHaveBeenCalled()
    })
  })

  describe('getClusterMembers', () => {
    it('6. Returns only the current node in standalone mode', () => {
      const consensus = new StandaloneConsensus(config)
      const members = consensus.getClusterMembers()
      expect(members).toBeInstanceOf(Array)
      expect(members).toHaveLength(1)
      expect(members[0]).toBe(nodeId)
    })

    it('7. Returns consistent results across calls', () => {
      const consensus = new StandaloneConsensus(config)
      const m1 = consensus.getClusterMembers()
      const m2 = consensus.getClusterMembers()
      expect(m1).toEqual(m2)
    })
  })

  describe('Raft-logic specific (skip if no raft-logic WASM)', () => {
    // These tests would need the actual raft-logic WASM module.
    // They are kept as documentation of what needs testing when
    // addPeer/removePeer are implemented in RaftLogicConsensus.
    describe.skip('raft-logic-specific', () => {
      it('addPeer on started RaftLogicConsensus throws "not supported"', async () => {
        // Placeholder: import { RaftLogicConsensus } from '../../src/consensus/raft-logic-consensus'
        // Would test: addPeer throws correct error message
      })

      it('removePeer on started RaftLogicConsensus throws "not supported"', async () => {
        // Placeholder: Would test correct error
      })

      it('membership callbacks registered on RaftLogicConsensus', () => {
        // Placeholder: Would test callback registration
      })
    })
  })
})
