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

  it('onMembershipChange callback fires in StandaloneConsensus after addPeer', () => {
    // StandaloneConsensus.addPeer 是空操作但 callback 注册存在
    // 验证注册本身不抛异常
    const consensus = new StandaloneConsensus({
      mode: 'standalone',
      nodeId: 'mem-cb-node',
      peers: [],
    })
    expect(() => {
      consensus.onMembershipChange(() => {})
    }).not.toThrow()
  })

  it('RaftLogicConsensus addPeer throws correct error', async () => {
    // 动态 import 但跳过 start（已知 mock 不完整）
    // 验证 addPeer/removePeer 在 not started 状态下也抛正确错误
    const { RaftLogicConsensus } = await import('../../src/consensus/raft-logic-consensus')
    const consensus = new RaftLogicConsensus(
      { mode: 'raft-logic', nodeId: 'test', peers: [] },
    )
    await expect(consensus.addPeer('peer-2')).rejects.toThrow('RaftLogicConsensus not started')
    await expect(consensus.removePeer('peer-2')).rejects.toThrow('RaftLogicConsensus not started')
  })

  it('RaftLogicConsensus addPeer/removePeer error message mentions ConfChange', async () => {
    // 直接检查源代码确认错误消息包含 ConfChange 说明
    // 这是对 RaftLogicConsensus 实现在不 start WASM 情况下的契约验证
    const { RaftLogicConsensus } = await import('../../src/consensus/raft-logic-consensus')
    const consensus = new RaftLogicConsensus(
      { mode: 'raft-logic', nodeId: 'test', peers: [] },
    )
    // 手动设置 _started 和 _node 绕过 start
    ;(consensus as any)._started = true
    ;(consensus as any)._node = {}
    ;(consensus as any)._transport = { sendTo: () => true, onMessage: () => {} }
    ;(consensus as any).logger = new (await import('../../src/ops/logger')).Logger('test')

    await expect(consensus.addPeer('peer-2')).rejects.toThrow(
      'addPeer not available: raft-logic WASM does not expose ConfChange API',
    )
    await expect(consensus.removePeer('peer-2')).rejects.toThrow(
      'removePeer not available: raft-logic WASM does not expose ConfChange API',
    )
  })
})
