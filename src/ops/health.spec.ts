import { Health } from './health'
import { ShardManager } from '../shard/shard-manager'
import { ShardMap } from '../types'
import { HlcClock } from '../replication/hlc-clock'

vi.mock('../shard/shard-manager', () => {
  return {
    ShardManager: vi.fn().mockImplementation(function() { return {
      getShardStatus: vi.fn().mockReturnValue([]),
      getRange: vi.fn(),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    }}),
  }
})

vi.mock('../core/graph-engine', () => {
  return {
    GraphEngine: vi.fn().mockImplementation(function() { return {
      open: vi.fn(),
      close: vi.fn(),
      upsertNode: vi.fn().mockReturnValue(999999),
      deleteNode: vi.fn().mockReturnValue(true),
      stats: vi.fn().mockReturnValue({
        nodeCount: 0,
        edgeCount: 0,
        diskSizeBytes: 0,
      }),
      isOpen: true,
    }}),
  }
})

import { GraphEngine } from '../core/graph-engine'

describe('Health', () => {
  let shardManager: ShardManager
  let health: Health

  beforeEach(() => {
    const shardMap: ShardMap = {
      version: 1,
      ranges: [],
      hashRing: { virtualNodes: 100, nodes: [] },
    }
    const clock = new HlcClock()
    shardManager = new (ShardManager as any)(shardMap, clock)
    const engine = new (GraphEngine as any)()
    health = new Health(shardManager, engine)
  })

  test('should start with unhealthy status when no shards', () => {
    const status = health.getStatus()
    expect(status.status).toBe('unhealthy') // no leader, so unhealthy
    expect(status.uptime).toBeGreaterThanOrEqual(0)
  })

  test('should report healthy when all shards have leader', () => {
    // Override mock to return shards with leader
    ;(shardManager.getShardStatus as vi.Mock).mockReturnValue([
      { rangeId: 'r1', raftRole: 'leader', nodeCount: 100 },
      { rangeId: 'r2', raftRole: 'follower', nodeCount: 100 },
    ])

    const status = health.getStatus()
    expect(status.status).toBe('healthy')
    expect(status.shards.total).toBe(2)
    expect(status.shards.healthy).toBe(2)
  })

  test('should report degraded when some shards are unhealthy', () => {
    ;(shardManager.getShardStatus as vi.Mock).mockReturnValue([
      { rangeId: 'r1', raftRole: 'leader', nodeCount: 100 },
      { rangeId: 'r2', raftRole: 'candidate', nodeCount: 50 },
    ])

    const status = health.getStatus()
    expect(status.status).toBe('degraded')
    expect(status.shards.healthy).toBe(1) // only leader is healthy
  })

  test('should report unhealthy when no leader', () => {
    ;(shardManager.getShardStatus as vi.Mock).mockReturnValue([
      { rangeId: 'r1', raftRole: 'candidate', nodeCount: 100 },
      { rangeId: 'r2', raftRole: 'follower', nodeCount: 100 },
    ])

    const status = health.getStatus()
    expect(status.status).toBe('unhealthy')
  })

  test('should return summary string', () => {
    ;(shardManager.getShardStatus as vi.Mock).mockReturnValue([
      { rangeId: 'r1', raftRole: 'leader', nodeCount: 100 },
    ])

    const summary = health.getSummary()
    expect(typeof summary).toBe('string')
    expect(summary).toContain('healthy')
    expect(summary).toContain('leader')
  })

  describe('check() — engine probe', () => {
    test('should detect healthy engine', async () => {
      ;(shardManager.getShardStatus as vi.Mock).mockReturnValue([
        { rangeId: 'r1', raftRole: 'leader', nodeCount: 100 },
      ])

      const result = await health.check()
      expect(result.status).toBe('healthy')
      expect(result.lastError).toBeNull()
    })

    test('should detect engine failure', async () => {
      ;(shardManager.getShardStatus as vi.Mock).mockReturnValue([
        { rangeId: 'r1', raftRole: 'leader', nodeCount: 100 },
      ])

      // Create a health instance with a failing engine
      const failingEngine = new (GraphEngine as any)()
      failingEngine.upsertNode = vi.fn().mockImplementation(function() {
        throw new Error('Engine crash')
      })
      const h = new Health(shardManager, failingEngine)
      const result = await h.check()
      expect(result.status).toBe('degraded')
      expect(result.lastError).toContain('Engine crash')
    })
  })

  // ── K8s 三探针 ──

  describe('K8s probes', () => {
    test('liveness should return alive when engine responds', async () => {
      const result = await health.liveness()
      expect(result.alive).toBe(true)
    })

    test('liveness should return not alive when engine fails', async () => {
      const failingEngine = new (GraphEngine as any)()
      failingEngine.stats = vi.fn().mockImplementation(() => {
        throw new Error('engine dead')
      })
      const h = new Health(shardManager, failingEngine)
      const result = await h.liveness()
      expect(result.alive).toBe(false)
      expect(result.error).toContain('engine dead')
    })

    test('readiness should return ready when all conditions met', async () => {
      ;(shardManager.getShardStatus as vi.Mock).mockReturnValue([
        { rangeId: 'r1', raftRole: 'leader', nodeCount: 100 },
      ])
      const result = await health.readiness()
      expect(result.ready).toBe(true)
    })

    test('readiness should return not ready when no leader', async () => {
      ;(shardManager.getShardStatus as vi.Mock).mockReturnValue([
        { rangeId: 'r1', raftRole: 'candidate', nodeCount: 100 },
      ])
      const result = await health.readiness()
      expect(result.ready).toBe(false)
      expect(result.error).toContain('no raft leader')
    })

    test('startup should return started after successful probe', async () => {
      ;(shardManager.getShardStatus as vi.Mock).mockReturnValue([
        { rangeId: 'r1', raftRole: 'leader', nodeCount: 100 },
      ])
      const result = await health.startup()
      expect(result.started).toBe(true)
      expect(result.duration).toBeGreaterThanOrEqual(0)
    })

    test('startup should return not started when engine is not open', async () => {
      const closedEngine = new (GraphEngine as any)()
      closedEngine.isOpen = false
      const h = new Health(shardManager, closedEngine)
      const result = await h.startup()
      expect(result.started).toBe(false)
      expect(result.error).toContain('engine not open')
    })

    test('startup should return not started when no shards available', async () => {
      // getShardStatus already returns empty array
      const result = await health.startup()
      expect(result.started).toBe(false)
      expect(result.error).toContain('no shards')
    })

    test('should return cached startup result on subsequent calls', async () => {
      ;(shardManager.getShardStatus as vi.Mock).mockReturnValue([
        { rangeId: 'r1', raftRole: 'leader', nodeCount: 100 },
      ])
      const result1 = await health.startup()
      expect(result1.started).toBe(true)

      // Second call should return cached result without re-probing
      const result2 = await health.startup()
      expect(result2.started).toBe(true)
      expect(result2.duration).toBeGreaterThanOrEqual(0)
    })
  })
})

describe('D-09 — K8s 三探针', () => {
  let shardManager: ShardManager
  let health: Health

  beforeEach(() => {
    const shardMap: ShardMap = { version: 1, ranges: [], hashRing: { virtualNodes: 100, nodes: [] } }
    const clock = new HlcClock()
    shardManager = new (ShardManager as any)(shardMap, clock)
    const engine = new (GraphEngine as any)()
    health = new Health(shardManager, engine)
  })

  describe('liveness probe', () => {
    test('返回 alive=true 当引擎正常', async () => {
      const result = await health.liveness()
      expect(result.alive).toBe(true)
      expect(result.timestamp).toBeGreaterThan(0)
      expect(result.error).toBeUndefined()
    })

    test('返回 alive=false 当引擎挂起', async () => {
      // 创建一个 Health 实例，其引擎 stats 抛出异常
      const failingEngine = new (GraphEngine as any)()
      failingEngine.stats = vi.fn().mockImplementation(function() {
        throw new Error('Engine deadlocked')
      })
      const h = new Health(shardManager, failingEngine)
      const result = await h.liveness()
      expect(result.alive).toBe(false)
      expect(result.error).toContain('Engine deadlocked')
      expect(result.timestamp).toBeGreaterThan(0)
    })
  })

  describe('startup probe', () => {
    test('返回 started=true 当引擎和分片都已初始化', async () => {
      ;(shardManager.getShardStatus as vi.Mock).mockReturnValue([
        { rangeId: 'r1', raftRole: 'leader', nodeCount: 100 },
      ])
      const result = await health.startup()
      expect(result.started).toBe(true)
      expect(result.error).toBeUndefined()
    })

    test('返回 started=false 当分片未初始化', async () => {
      ;(shardManager.getShardStatus as vi.Mock).mockReturnValue([])
      const result = await health.startup()
      expect(result.started).toBe(false)
      expect(result.error).toContain('no shards')
    })

    test('返回 started=false 当引擎未就绪', async () => {
      const failingEngine = new (GraphEngine as any)()
      failingEngine.isOpen = true
      failingEngine.upsertNode = vi.fn().mockImplementation(function() {
        throw new Error('Engine not ready')
      })
      const h = new Health(shardManager, failingEngine)
      ;(shardManager.getShardStatus as vi.Mock).mockReturnValue([
        { rangeId: 'r1', raftRole: 'leader', nodeCount: 100 },
      ])
      const result = await h.startup()
      expect(result.started).toBe(false)
      expect(result.error).toContain('Engine not ready')
    })
  })

  describe('readiness probe', () => {
    test('返回 ready=true 当所有条件满足', async () => {
      ;(shardManager.getShardStatus as vi.Mock).mockReturnValue([
        { rangeId: 'r1', raftRole: 'leader', nodeCount: 100 },
      ])
      const result = await health.readiness()
      expect(result.ready).toBe(true)
      expect(result.details).toBeDefined()
      expect(result.details!.hasLeader).toBe(true)
      expect(result.details!.healthyShards).toBe(1)
      expect(result.details!.totalShards).toBe(1)
      expect(result.details!.engineOk).toBe(true)
    })

    test('返回 ready=false 当无 Raft Leader', async () => {
      ;(shardManager.getShardStatus as vi.Mock).mockReturnValue([
        { rangeId: 'r1', raftRole: 'candidate', nodeCount: 100 },
      ])
      const result = await health.readiness()
      expect(result.ready).toBe(false)
      expect(result.error).toContain('no raft leader')
    })

    test('返回 ready=false 当有分片不健康', async () => {
      ;(shardManager.getShardStatus as vi.Mock).mockReturnValue([
        { rangeId: 'r1', raftRole: 'leader', nodeCount: 100 },
        { rangeId: 'r2', raftRole: 'candidate', nodeCount: 50 },
      ])
      const result = await health.readiness()
      expect(result.ready).toBe(false)
      expect(result.error).toBeDefined()
    })

    test('返回 ready=false 当引擎探测失败', async () => {
      const failingEngine = new (GraphEngine as any)()
      failingEngine.stats = vi.fn().mockImplementation(function() {
        throw new Error('Engine crash')
      })
      const h = new Health(shardManager, failingEngine)
      ;(shardManager.getShardStatus as vi.Mock).mockReturnValue([
        { rangeId: 'r1', raftRole: 'leader', nodeCount: 100 },
      ])
      const result = await h.readiness()
      expect(result.ready).toBe(false)
      expect(result.error).toContain('engine not responding')
    })
  })
})
