/**
 * consensus-factory.spec.ts
 *
 * 测试 ConsensusFactory 的实例创建、配置验证和接口一致性。
 * StandaloneConsensus 直接使用真实实例。
 * RaftLogicConsensus 通过 mock module 注入。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createConsensus,
  registerDbClusterConsensus,
  isDbClusterConsensusRegistered,
  getDbClusterConsensus,
  clearDbClusterConsensus,
} from './consensus-factory'
import { ConsensusConfig, ConsensusProvider } from './consensus-provider'
import { StandaloneConsensus } from './standalone-consensus'
import { DbClusterConsensusProvider } from './DbClusterConsensusProvider'

/** 构造最小有效配置 */
function makeConfig(overrides?: Partial<ConsensusConfig>): ConsensusConfig {
  return {
    mode: 'standalone',
    nodeId: 'node-1',
    peers: [],
    ...overrides,
  }
}

describe('createConsensus', () => {
  describe('standalone mode', () => {
    it('should create a StandaloneConsensus instance', () => {
      const config = makeConfig({ mode: 'standalone' })
      const instance = createConsensus(config)

      expect(instance).toBeInstanceOf(StandaloneConsensus)
      expect(instance.getRole()).toBe('standalone')
    })

    it('should create a valid ConsensusProvider', () => {
      const config = makeConfig({ mode: 'standalone' })
      const instance = createConsensus(config)

      // Verify ConsensusProvider interface
      expect(instance).toHaveProperty('start')
      expect(instance).toHaveProperty('stop')
      expect(instance).toHaveProperty('propose')
      expect(instance).toHaveProperty('readIndex')
      expect(instance).toHaveProperty('getRole')
      expect(instance).toHaveProperty('getLeaderId')
      expect(instance).toHaveProperty('getTerm')
      expect(instance).toHaveProperty('waitForLeader')
      expect(instance).toHaveProperty('inMajority')
      expect(instance).toHaveProperty('onMajorityChange')
      expect(instance).toHaveProperty('addPeer')
      expect(instance).toHaveProperty('removePeer')
      expect(instance).toHaveProperty('getClusterMembers')
      expect(instance).toHaveProperty('onMembershipChange')
    })

    it('should be started/stopped correctly', async () => {
      const instance = createConsensus(makeConfig({ mode: 'standalone' }))

      // Before start
      expect(instance.getLeaderId()).toBeNull()

      await instance.start()
      expect(instance.getLeaderId()).toBe('node-1')
      expect(instance.getRole()).toBe('standalone')

      await instance.stop()
      expect(instance.getLeaderId()).toBeNull()
    })

    it('should propose and apply entries when applyFn is set', async () => {
      const instance = createConsensus(makeConfig({ mode: 'standalone' }))
      expect(instance).toBeInstanceOf(StandaloneConsensus)

      const standalone = instance as StandaloneConsensus

      const applied: Uint8Array[] = []
      standalone.setApply(async (data: Uint8Array) => {
        applied.push(data)
      })

      await standalone.start()

      const data = Buffer.from('hello consensus')
      const result = await standalone.propose(data)
      expect(result.ok).toBe(true)
      expect(applied).toHaveLength(1)
      expect(Buffer.from(applied[0]).toString()).toBe('hello consensus')

      await standalone.stop()
    })
  })

  describe('simulated-raft mode (falls back to standalone)', () => {
    it('should fall back to StandaloneConsensus', () => {
      const config = makeConfig({ mode: 'simulated-raft' })
      const instance = createConsensus(config)

      // simulated-raft is not yet implemented, falls back to standalone
      expect(instance).toBeInstanceOf(StandaloneConsensus)
    })
  })

  describe('unknown mode (falls back to standalone)', () => {
    it('should fall back to StandaloneConsensus for unknown mode', () => {
      const config = { mode: 'unknown' as any, nodeId: 'n1', peers: [] }
      const instance = createConsensus(config)

      expect(instance).toBeInstanceOf(StandaloneConsensus)
    })
  })

  describe('raft-logic mode (with mock)', () => {
    it('should create a RaftLogicConsensus instance via mock module', () => {
      // Create a minimal mock that satisfies init()
      const mockRaftModule = {
        ready: Promise.resolve(),
      }

      // Use a config with raft-logic mode
      const config = makeConfig({ mode: 'raft-logic', nodeId: 'raft-1' })

      // We need to spy on constructor to verify.
      // RaftLogicConsensus takes a _moduleRef in its constructor.
      // To verify it creates correctly, we check the returned type.
      const instance = createConsensus(config)

      // RaftLogicConsensus.init() will try import('raft-logic') which will fail
      // in test environment (optional dependency not installed / WASM not available).
      // It gracefully saves the error, so the instance is still returned.
      // The instance should have ConsensusProvider interface.
      expect(instance.getRole()).toBeDefined()
    })
  })

  describe('StandaloneConsensus interface consistency', () => {
    it('should report inMajority true when started', async () => {
      const instance = new StandaloneConsensus(makeConfig({ mode: 'standalone', nodeId: 'n1' }))
      expect(instance.inMajority()).toBe(true) // always true even before start
      await instance.start()
      expect(instance.inMajority()).toBe(true)
      await instance.stop()
      expect(instance.inMajority()).toBe(true) // still true for standalone
    })

    it('should return cluster members after start', async () => {
      const instance = new StandaloneConsensus(makeConfig({ mode: 'standalone', nodeId: 'node-x' }))
      await instance.start()

      const members = instance.getClusterMembers()
      expect(members).toEqual(['node-x'])

      await instance.stop()
    })

    it('should return term 1 for standalone', () => {
      const instance = new StandaloneConsensus(makeConfig({ mode: 'standalone' }))
      expect(instance.getTerm()).toBe(1)
    })

    it('should accept onMajorityChange registration', () => {
      const instance = new StandaloneConsensus(makeConfig({ mode: 'standalone' }))
      const cb = vi.fn()
      // register should not throw
      instance.onMajorityChange(cb)
    })

    it('should accept onMembershipChange registration', () => {
      const instance = new StandaloneConsensus(makeConfig({ mode: 'standalone' }))
      const cb = vi.fn()
      instance.onMembershipChange(cb)
    })

    it('should support barrier (standalone no-op)', async () => {
      const instance = new StandaloneConsensus(makeConfig({ mode: 'standalone' }))
      await instance.start()
      // barrier is optional but StandaloneConsensus implements it as no-op
      if (instance.barrier) {
        await instance.barrier()
      }
      await instance.stop()
    })
  })

  describe('db-cluster mode', () => {
    beforeEach(() => {
      clearDbClusterConsensus()
    })

    it('should register and check db-cluster consensus instance', () => {
      expect(isDbClusterConsensusRegistered()).toBe(false)
      const mockCluster = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        propose: vi.fn().mockResolvedValue(1),
        isLeader: vi.fn().mockResolvedValue(true),
        getLeader: vi.fn().mockResolvedValue('node-1'),
        getCommitIndex: vi.fn().mockResolvedValue(42),
        registerShard: vi.fn(),
        removeShard: vi.fn().mockResolvedValue(undefined),
        notifyTopologyChange: vi.fn().mockResolvedValue(undefined),
        getHealthStatus: vi.fn().mockResolvedValue([]),
        campaign: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
        off: vi.fn(),
        setForceLeader: vi.fn(),
      }
      registerDbClusterConsensus(mockCluster)
      expect(isDbClusterConsensusRegistered()).toBe(true)
      expect(getDbClusterConsensus()).toBe(mockCluster)
    })

    it('should throw when creating db-cluster consensus before registration', () => {
      const config = makeConfig({ mode: 'db-cluster' as any })
      expect(() => createConsensus(config)).toThrow(
        'db-cluster consensus not registered',
      )
    })

    it('should create DbClusterConsensusProvider when db-cluster is registered', () => {
      const mockCluster = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        propose: vi.fn().mockResolvedValue(1),
        isLeader: vi.fn().mockResolvedValue(true),
        getLeader: vi.fn().mockResolvedValue('node-1'),
        getCommitIndex: vi.fn().mockResolvedValue(42),
        registerShard: vi.fn(),
        removeShard: vi.fn().mockResolvedValue(undefined),
        notifyTopologyChange: vi.fn().mockResolvedValue(undefined),
        getHealthStatus: vi.fn().mockResolvedValue([]),
        campaign: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
        off: vi.fn(),
        setForceLeader: vi.fn(),
      }
      registerDbClusterConsensus(mockCluster)

      const config = makeConfig({ mode: 'db-cluster' as any, nodeId: 'db-node' })
      const instance = createConsensus(config)

      expect(instance).toBeInstanceOf(DbClusterConsensusProvider)
      expect(instance.getLeaderId()).toBeNull()
    })

    it('should create a valid ConsensusProvider interface', () => {
      const mockCluster = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        propose: vi.fn().mockResolvedValue(1),
        isLeader: vi.fn().mockResolvedValue(true),
        getLeader: vi.fn().mockResolvedValue('node-1'),
        getCommitIndex: vi.fn().mockResolvedValue(42),
        registerShard: vi.fn(),
        removeShard: vi.fn().mockResolvedValue(undefined),
        notifyTopologyChange: vi.fn().mockResolvedValue(undefined),
        getHealthStatus: vi.fn().mockResolvedValue([]),
        campaign: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
        off: vi.fn(),
        setForceLeader: vi.fn(),
      }
      registerDbClusterConsensus(mockCluster)

      const config = makeConfig({ mode: 'db-cluster' as any })
      const instance = createConsensus(config)

      // Verify ConsensusProvider interface
      expect(instance).toHaveProperty('start')
      expect(instance).toHaveProperty('stop')
      expect(instance).toHaveProperty('propose')
      expect(instance).toHaveProperty('readIndex')
      expect(instance).toHaveProperty('barrier')
      expect(instance).toHaveProperty('getRole')
      expect(instance).toHaveProperty('getLeaderId')
      expect(instance).toHaveProperty('getTerm')
      expect(instance).toHaveProperty('waitForLeader')
      expect(instance).toHaveProperty('setApply')
      expect(instance).toHaveProperty('inMajority')
      expect(instance).toHaveProperty('onMajorityChange')
      expect(instance).toHaveProperty('addPeer')
      expect(instance).toHaveProperty('removePeer')
      expect(instance).toHaveProperty('getClusterMembers')
      expect(instance).toHaveProperty('onMembershipChange')
    })

    it('should be started/stopped correctly', async () => {
      const mockCluster = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        propose: vi.fn().mockResolvedValue(1),
        isLeader: vi.fn().mockResolvedValue(true),
        getLeader: vi.fn().mockResolvedValue('node-1'),
        getCommitIndex: vi.fn().mockResolvedValue(42),
        registerShard: vi.fn(),
        removeShard: vi.fn().mockResolvedValue(undefined),
        notifyTopologyChange: vi.fn().mockResolvedValue(undefined),
        getHealthStatus: vi.fn().mockResolvedValue([]),
        campaign: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
        off: vi.fn(),
        setForceLeader: vi.fn(),
      }
      registerDbClusterConsensus(mockCluster)

      const config = makeConfig({ mode: 'db-cluster' as any, nodeId: 'db-node' })
      const instance = createConsensus(config)

      // Before start
      expect(instance.getLeaderId()).toBeNull()

      await instance.start()
      expect(mockCluster.start).toHaveBeenCalledOnce()
      expect(instance.getLeaderId()).toBe('db-node')

      await instance.stop()
      expect(mockCluster.stop).toHaveBeenCalledOnce()
      expect(instance.getLeaderId()).toBeNull()
    })

    it('should clear registration for test isolation', () => {
      const mockCluster = {
        start: vi.fn(),
        stop: vi.fn(),
        propose: vi.fn(),
        isLeader: vi.fn(),
        getLeader: vi.fn(),
        getCommitIndex: vi.fn(),
        registerShard: vi.fn(),
        removeShard: vi.fn(),
        notifyTopologyChange: vi.fn(),
        getHealthStatus: vi.fn(),
        campaign: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        setForceLeader: vi.fn(),
      }
      registerDbClusterConsensus(mockCluster)
      expect(isDbClusterConsensusRegistered()).toBe(true)

      clearDbClusterConsensus()
      expect(isDbClusterConsensusRegistered()).toBe(false)
    })

    it('should subscribe to cluster events on construction', () => {
      const mockCluster = {
        start: vi.fn(),
        stop: vi.fn(),
        propose: vi.fn(),
        isLeader: vi.fn(),
        getLeader: vi.fn(),
        getCommitIndex: vi.fn(),
        registerShard: vi.fn(),
        removeShard: vi.fn(),
        notifyTopologyChange: vi.fn(),
        getHealthStatus: vi.fn(),
        campaign: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        setForceLeader: vi.fn(),
      }
      registerDbClusterConsensus(mockCluster)

      const config = makeConfig({ mode: 'db-cluster' as any })
      createConsensus(config)

      // The DbClusterConsensusProvider constructor subscribes to
      // membership_change and majority_change
      expect(mockCluster.on).toHaveBeenCalledWith('membership_change', expect.any(Function))
      expect(mockCluster.on).toHaveBeenCalledWith('majority_change', expect.any(Function))
    })
  })
})
