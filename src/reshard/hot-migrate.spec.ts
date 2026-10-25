// ============================================================
// hot-migrate.spec.ts — Hot Migration + Geo-Aware Routing Unit Tests
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HotMigrator, selectNearestNode, haversineDistance, GeoAwareRouteHint, HotMigrateProgress } from './hot-migrate'
import { ShardManager } from '../shard/shard-manager'
import { HlcClock } from '../replication/hlc-clock'
import { ShardMap, ReshardSplit, RangeConfig, Role, AuthError } from '../types'
import * as fs from 'fs'

const randomId = Math.random().toString(36).slice(2, 8)
const TEST_DIR = `/tmp/agentiX-test-hot-migrate-${randomId}`

// ── Mock ShardManager ──

function createMockShardManager(): ShardManager {
  const clock = new HlcClock()
  const shardMap: ShardMap = {
    version: 1,
    ranges: [
      {
        rangeId: 'range-a',
        dataDir: `${TEST_DIR}/range-a`,
        raftConfig: {
          nodeId: 'range-a',
          peers: [],
          storagePath: `${TEST_DIR}/range-a/raft`,
        },
        overgraphConfig: { path: `${TEST_DIR}/range-a/graph` },
      },
    ],
    hashRing: {
      virtualNodes: 160,
      nodes: [{ hash: '0x00000000', rangeId: 'range-a' }],
    },
  }

  const mockMgr: any = {
    clock,
    ranges: new Map<string, any>(),
    _dualWriteTargets: new Map<string, any>(),
    router: {
      getShardMap: vi.fn().mockReturnValue(shardMap),
    },
    addRange: vi.fn().mockImplementation((rangeId: string, instance: any) => {
      mockMgr.ranges.set(rangeId, instance)
    }),
    removeRange: vi.fn().mockImplementation((rangeId: string) => {
      mockMgr.ranges.delete(rangeId)
    }),
    getRange: vi.fn().mockImplementation((rangeId: string) => {
      const r = mockMgr.ranges.get(rangeId)
      if (!r) throw new Error(`Range not found: ${rangeId}`)
      return r
    }),
    enableDualWrite: vi.fn(),
    disableDualWrite: vi.fn(),
    rebuildRouter: vi.fn(),
    upsertNode: vi.fn().mockResolvedValue(42),
    getAllRanges: vi.fn().mockReturnValue(new Map()),
    getRouter: vi.fn().mockReturnValue({
      getShardMap: vi.fn().mockReturnValue(shardMap),
    }),
  }

  return mockMgr as unknown as ShardManager
}

function createMockRange(rangeId: string, opts?: {
  nodeCount?: number
  edgeCount?: number
}) {
  const nodeCount = opts?.nodeCount ?? 100
  const edgeCount = opts?.edgeCount ?? 50

  return {
    config: { rangeId },
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    write: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockImplementation(async (fn: (engine: any) => any) => {
      const mockEngine: any = {
        exportSnapshot: vi.fn().mockResolvedValue(
          Buffer.from(JSON.stringify({
            nodes: Array.from({ length: nodeCount }, (_, i) => ({ id: i, type: 1, name: `n-${i}`, props: {} })),
            edges: Array.from({ length: edgeCount }, (_, i) => ({ src: i, dst: i + 1, type: 10, props: {} })),
          }))
        ),
        stats: vi.fn().mockResolvedValue({ nodeCount, edgeCount, diskSizeBytes: 100 }),
        getNode: vi.fn().mockResolvedValue({ id: 42, name: 'test', type: 1, props: {} }),
      }
      return fn(mockEngine)
    }),
    getStatus: vi.fn().mockReturnValue({
      raft: { role: 'leader', leaderId: rangeId, term: 1 },
      storage: { nodeCount, edgeCount, diskSizeBytes: 100 },
    }),
    isHealthy: vi.fn().mockReturnValue(true),
  }
}

describe('HotMigrator', () => {
  let migrator: HotMigrator
  let shardManager: ShardManager
  let clock: HlcClock
  let split: ReshardSplit

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true })
    clock = new HlcClock()
    shardManager = createMockShardManager()
    migrator = new HotMigrator(shardManager, clock)

    // Add source and target mock ranges
    const sourceRange = createMockRange('range-a', { nodeCount: 100, edgeCount: 50 })
    const targetRange = createMockRange('range-b', { nodeCount: 100, edgeCount: 50 })

    ;(shardManager as any).ranges.set('range-a', sourceRange)
    ;(shardManager as any).ranges.set('range-b', targetRange)

    split = {
      sourceRangeId: 'range-a',
      targetRangeId: 'range-b',
      hashRangeStart: 0,
      hashRangeEnd: 2147483647,
      targetNodeId: 'node-b',
      targetDataDir: `${TEST_DIR}/range-b`,
    }
  })

  afterEach(() => {
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  describe('construction', () => {
    it('should create with ShardManager and clock', () => {
      expect(migrator).toBeInstanceOf(HotMigrator)
    })

    it('should return null progress for unknown range', () => {
      expect(migrator.getProgress('unknown')).toBeNull()
    })

    it('should return empty array when no migrations in progress', () => {
      const all = migrator.getProgress()
      expect(all).toBeInstanceOf(Array)
      expect(all).toHaveLength(0)
    })
  })

  describe('migrate (full lifecycle)', () => {
    it('should complete hot migration through all phases', async () => {
      const targetConfig: RangeConfig = {
        rangeId: 'range-b',
        dataDir: `${TEST_DIR}/range-b`,
        raftConfig: {
          nodeId: 'range-b',
          peers: [],
          storagePath: `${TEST_DIR}/range-b/raft`,
        },
        overgraphConfig: { path: `${TEST_DIR}/range-b/graph` },
      }

      // Use a migrator that has its addRange mocked so it doesn't create real RangeInstances
      // We manually pre-add both ranges
      const sourceMock = createMockRange('range-a', { nodeCount: 100, edgeCount: 50 })
      const targetMock = createMockRange('range-b', { nodeCount: 100, edgeCount: 50 })
      ;(shardManager as any).ranges.set('range-a', sourceMock)
      ;(shardManager as any).ranges.set('range-b', targetMock)

      // Make addRange just record the call, don't actually create
      ;(shardManager as any).addRange = vi.fn()

      const progress = await migrator.migrate(split, targetConfig)

      expect(progress.phase).toBe('completed')
      expect(progress.progressPercent).toBe(100)
      expect(progress.completedAt).toBeGreaterThan(0)
      expect(progress.error).toBeNull()
    })

    it('should fail gracefully on migration error', async () => {
      // Make target range throw on start
      const targetConfig: RangeConfig = {
        rangeId: 'range-b',
        dataDir: `${TEST_DIR}/range-b`,
        raftConfig: {
          nodeId: 'range-b',
          peers: [],
          storagePath: `${TEST_DIR}/range-b/raft`,
        },
        overgraphConfig: { path: `${TEST_DIR}/range-b/graph` },
      }

      // Corrupt source range to cause failure
      const failRange = (shardManager as any).ranges.get('range-a')
      failRange.read = vi.fn().mockRejectedValue(new Error('Engine error'))

      const progress = await migrator.migrate(split, targetConfig)

      expect(progress.phase).toBe('failed')
      expect(progress.error).not.toBeNull()
    })
  })

  describe('rollback', () => {
    it('should rollback before atomic switch successfully', async () => {
      // simulate: migration started but not yet switched
      (shardManager as any).ranges.set('range-b', createMockRange('range-b'))

      await migrator.rollback(split)

      // Verify: ranges cleaned up, dual write disabled
      expect((shardManager as any).disableDualWrite).toHaveBeenCalled()
      expect((shardManager as any).removeRange).toHaveBeenCalledWith('range-b')
    })

    it('should throw if trying to rollback after atomic switch', async () => {
      const progress: HotMigrateProgress = {
        rangeId: 'range-a',
        targetRangeId: 'range-b',
        phase: 'atomic_switch',
        progressPercent: 85,
        startedAt: Date.now(),
        completedAt: null,
        error: null,
      }

      // Directly set the internal state
      ;(migrator as any)._progress.set('range-a', progress)

      await expect(migrator.rollback(split)).rejects.toThrow('Cannot rollback after atomic switch')
    })
  })

  describe('selectOptimalRegion', () => {
    it('should prefer same region', () => {
      const source: GeoAwareRouteHint = {
        nodeId: 'node-cn-east',
        region: 'cn-east',
        lat: 31.23, lon: 121.47,
      }
      const target: GeoAwareRouteHint = {
        nodeId: 'node-cn-east-2',
        region: 'cn-east',
        lat: 31.23, lon: 121.47,
      }

      const result = migrator.selectOptimalRegion(source, target)
      expect(result.preferredNodeId).toBe('node-cn-east-2')
      expect(result.preferredRegion).toBe('cn-east')
    })

    it('should return target node for cross-region migration', () => {
      const source: GeoAwareRouteHint = {
        nodeId: 'node-cn-east',
        region: 'cn-east',
        lat: 31.23, lon: 121.47,
      }
      const target: GeoAwareRouteHint = {
        nodeId: 'node-us-west',
        region: 'us-west',
        lat: 37.77, lon: -122.42,
      }

      const result = migrator.selectOptimalRegion(source, target)
      expect(result.preferredNodeId).toBe('node-us-west')
      expect(result.preferredRegion).toBe('us-west')
    })
  })
})

describe('Geo-aware routing (selectNearestNode)', () => {
  it('should find the nearest node', () => {
    const nodes = [
      { nodeId: 'shanghai', region: 'cn-east', lat: 31.23, lon: 121.47 },
      { nodeId: 'tokyo', region: 'jp', lat: 35.68, lon: 139.76 },
      { nodeId: 'frankfurt', region: 'eu', lat: 50.11, lon: 8.68 },
    ]

    // Client in Shanghai
    const nearest = selectNearestNode(31.23, 121.47, nodes)
    expect(nearest).toBe('shanghai')

    // Client in EU
    const nearestEu = selectNearestNode(48.85, 2.35, nodes) // Paris
    expect(nearestEu).toBe('frankfurt')
  })

  it('should return the only node when only one is available', () => {
    const nodes = [{ nodeId: 'singleton', region: 'sg', lat: 1.35, lon: 103.82 }]
    const nearest = selectNearestNode(40.71, -74.01, nodes) // NYC
    expect(nearest).toBe('singleton')
  })

  it('should throw if no nodes available', () => {
    expect(() => selectNearestNode(0, 0, [])).toThrow('No nodes available')
  })
})

describe('haversineDistance', () => {
  it('should return 0 for same point', () => {
    expect(haversineDistance(31.23, 121.47, 31.23, 121.47)).toBeCloseTo(0, 1)
  })

  it('should calculate approximate distance between Shanghai and Tokyo', () => {
    const dist = haversineDistance(31.23, 121.47, 35.68, 139.76)
    // Shanghai → Tokyo ≈ 1750-1800 km
    expect(dist).toBeGreaterThan(1700)
    expect(dist).toBeLessThan(2000)
  })

  it('should calculate distance between NYC and London', () => {
    const dist = haversineDistance(40.71, -74.01, 51.51, -0.13)
    // NYC → London ≈ 5550-5600 km
    expect(dist).toBeGreaterThan(5400)
    expect(dist).toBeLessThan(5800)
  })
})
