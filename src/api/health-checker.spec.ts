// ============================================================
// HealthChecker 测试
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest'
import { HealthChecker } from './health-checker'

// Mock ShardManager
const createMockShardManager = (overrides?: Record<string, unknown>) => {
  const sm = {
    getShardStatus: overrides?.getShardStatus as unknown as () => unknown[] || (() => []),
  }
  return sm as any
}

// Mock GraphEngine
const createMockEngine = (overrides?: Record<string, unknown>) => {
  const engine = {
    stats: () => ({ nodeCount: 100, edgeCount: 50, diskSizeBytes: 1024 }),
    upsertNode: () => Promise.resolve(999999),
    deleteNode: () => Promise.resolve(true),
    ...overrides,
  }
  return engine as any
}

describe('HealthChecker', () => {
  describe('livez', () => {
    it('should always return ok=true', async () => {
      const checker = new HealthChecker(createMockShardManager(), createMockEngine())
      const result = await checker.livez()
      expect(result.ok).toBe(true)
      expect(result.timestamp).toBeGreaterThan(0)
      expect(result.uptime).toBeGreaterThanOrEqual(0)
    })
  })

  describe('readyz', () => {
    it('should return ok=true when all components healthy', async () => {
      const shardManager = createMockShardManager({
        getShardStatus: () => [{ rangeId: 'r1', raftRole: 'leader', nodeCount: 100 }],
      })
      const engine = createMockEngine()
      const checker = new HealthChecker(shardManager, engine)

      const result = await checker.readyz()
      expect(result.ok).toBe(true)
      expect(result.summary).toBe('healthy')
      expect(result.components).toHaveLength(3)
    })

    it('should return ok=false when consensus has no leader', async () => {
      const shardManager = createMockShardManager({
        getShardStatus: () => [{ rangeId: 'r1', raftRole: 'candidate', nodeCount: 100 }],
      })
      const engine = createMockEngine()
      const checker = new HealthChecker(shardManager, engine)

      const result = await checker.readyz()
      expect(result.ok).toBe(false)
      expect(result.summary).toBe('unhealthy')

      const consensus = result.components.find(c => c.name === 'consensus')!
      expect(consensus.result.status).toBe('unhealthy')
    })

    it('should return ok=false when storage unhealthy', async () => {
      const shardManager = createMockShardManager({
        getShardStatus: () => [{ rangeId: 'r1', raftRole: 'leader', nodeCount: 100 }],
      })
      const failingEngine = createMockEngine({
        stats: () => { throw new Error('Engine crashed') },
      })
      const checker = new HealthChecker(shardManager, failingEngine)

      const result = await checker.readyz()
      expect(result.ok).toBe(false)

      const storage = result.components.find(c => c.name === 'storage')!
      expect(storage.result.status).toBe('unhealthy')
    })

    it('should return ok=false when index unhealthy', async () => {
      const shardManager = createMockShardManager({
        getShardStatus: () => [{ rangeId: 'r1', raftRole: 'leader', nodeCount: 100 }],
      })
      const failingEngine = createMockEngine({
        upsertNode: () => Promise.reject(new Error('Index write failure')),
      })
      const checker = new HealthChecker(shardManager, failingEngine)

      const result = await checker.readyz()
      expect(result.ok).toBe(false)

      const index = result.components.find(c => c.name === 'index')!
      expect(index.result.status).toBe('unhealthy')
    })
  })

  describe('组件探针', () => {
    it('probeStorage: healthy 状态', async () => {
      const checker = new HealthChecker(createMockShardManager(), createMockEngine())
      const probe = await checker.probeStorage()
      expect(probe.name).toBe('storage')
      expect(probe.result.status).toBe('healthy')
      expect(probe.result.latencyMs).toBeGreaterThanOrEqual(0)
    })

    it('probeStorage: unhealthy 当引擎失效', async () => {
      const failingEngine = createMockEngine({
        stats: () => { throw new Error('Dead engine') },
      })
      const checker = new HealthChecker(createMockShardManager(), failingEngine)
      const probe = await checker.probeStorage()
      expect(probe.result.status).toBe('unhealthy')
      expect(probe.result.error).toContain('Dead engine')
    })

    it('probeConsensus: healthy 状态', async () => {
      const shardManager = createMockShardManager({
        getShardStatus: () => [{ rangeId: 'r1', raftRole: 'leader', nodeCount: 100 }],
      })
      const checker = new HealthChecker(shardManager, createMockEngine())
      const probe = await checker.probeConsensus()
      expect(probe.name).toBe('consensus')
      expect(probe.result.status).toBe('healthy')
    })

    it('probeConsensus: degraded 当无 shard', async () => {
      const checker = new HealthChecker(createMockShardManager(), createMockEngine())
      const probe = await checker.probeConsensus()
      expect(probe.result.status).toBe('degraded')
      expect(probe.result.detail).toContain('No shards')
    })

    it('probeConsensus: unhealthy 当无 leader', async () => {
      const shardManager = createMockShardManager({
        getShardStatus: () => [{ rangeId: 'r1', raftRole: 'candidate', nodeCount: 100 }],
      })
      const checker = new HealthChecker(shardManager, createMockEngine())
      const probe = await checker.probeConsensus()
      expect(probe.result.status).toBe('unhealthy')
      expect(probe.result.detail).toContain('No Raft leader')
    })

    it('probeConsensus: degraded 当有 candidate', async () => {
      const shardManager = createMockShardManager({
        getShardStatus: () => [
          { rangeId: 'r1', raftRole: 'leader', nodeCount: 100 },
          { rangeId: 'r2', raftRole: 'candidate', nodeCount: 50 },
        ],
      })
      const checker = new HealthChecker(shardManager, createMockEngine())
      const probe = await checker.probeConsensus()
      expect(probe.result.status).toBe('degraded')
    })

    it('probeIndex: healthy 状态', async () => {
      const checker = new HealthChecker(createMockShardManager(), createMockEngine())
      const probe = await checker.probeIndex()
      expect(probe.name).toBe('index')
      expect(probe.result.status).toBe('healthy')
    })

    it('probeIndex: unhealthy 当引擎无响应', async () => {
      const failingEngine = createMockEngine({
        upsertNode: () => Promise.reject(new Error('Storage full')),
      })
      const checker = new HealthChecker(createMockShardManager(), failingEngine)
      const probe = await checker.probeIndex()
      expect(probe.result.status).toBe('unhealthy')
    })

    it('probeAll 应返回所有组件的探测结果', async () => {
      const shardManager = createMockShardManager({
        getShardStatus: () => [{ rangeId: 'r1', raftRole: 'leader', nodeCount: 100 }],
      })
      const checker = new HealthChecker(shardManager, createMockEngine())
      const results = await checker.probeAll()
      expect(results).toHaveLength(3)
      const names = results.map(r => r.name).sort()
      expect(names).toEqual(['consensus', 'index', 'storage'])
    })
  })

  describe('detail', () => {
    it('应返回结构化组件详情', async () => {
      const shardManager = createMockShardManager({
        getShardStatus: () => [{ rangeId: 'r1', raftRole: 'leader', nodeCount: 100 }],
      })
      const checker = new HealthChecker(shardManager, createMockEngine())
      const result = await checker.detail()
      expect(result.timestamp).toBeGreaterThan(0)
      expect(result.uptime).toBeGreaterThanOrEqual(0)
      expect(result.components.storage.status).toBe('healthy')
      expect(result.components.consensus.status).toBe('healthy')
      expect(result.components.index.status).toBe('healthy')
      expect(result.summary).toBe('healthy')
    })

    it('故障组件应在 detail 中反映', async () => {
      const failingEngine = createMockEngine({
        stats: () => { throw new Error('Crashed') },
      })
      const shardManager = createMockShardManager({
        getShardStatus: () => [{ rangeId: 'r1', raftRole: 'candidate', nodeCount: 100 }],
      })
      const checker = new HealthChecker(shardManager, failingEngine)
      const result = await checker.detail()
      expect(result.summary).toBe('unhealthy')
      expect(result.components.storage.status).toBe('unhealthy')
      expect(result.components.consensus.status).toBe('unhealthy')
    })
  })

  describe('uptime', () => {
    it('应返回正确的运行时长', async () => {
      const checker = new HealthChecker(createMockShardManager(), createMockEngine())
      const uptime = checker.uptime
      expect(uptime).toBeGreaterThanOrEqual(0)
    })
  })
})
