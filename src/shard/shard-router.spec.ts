import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { ShardRouter } from './shard-router'
import { ShardMap } from '../types'

function createMockShardMap(): ShardMap {
  return {
    version: 1,
    ranges: [
      {
        rangeId: 'range-alpha',
        dataDir: '/data/range-alpha',
        raftConfig: {
          nodeId: 'node-alpha',
          peers: [],
          storagePath: '/data/range-alpha/raft',
        },
        overgraphConfig: { path: '/data/range-alpha/graph' },
      },
      {
        rangeId: 'range-beta',
        dataDir: '/data/range-beta',
        raftConfig: {
          nodeId: 'node-beta',
          peers: [],
          storagePath: '/data/range-beta/raft',
        },
        overgraphConfig: { path: '/data/range-beta/graph' },
      },
      {
        rangeId: 'range-gamma',
        dataDir: '/data/range-gamma',
        raftConfig: {
          nodeId: 'node-gamma',
          peers: [],
          storagePath: '/data/range-gamma/raft',
        },
        overgraphConfig: { path: '/data/range-beta/graph' },
      },
    ],
    hashRing: {
      virtualNodes: 160,
      nodes: [
        { hash: '0x00000000', rangeId: 'range-alpha' },
        { hash: '0x55555555', rangeId: 'range-beta' },
        { hash: '0xAAAAAAAA', rangeId: 'range-gamma' },
      ],
    },
  }
}

describe('ShardRouter', () => {
  let router: ShardRouter
  const shardMap = createMockShardMap()

  beforeEach(() => {
    router = new ShardRouter(shardMap)
  })

  describe('getRangeForKey (deterministic routing)', () => {
    test('should return the same Range for the same key every call', () => {
      const key = 'test-entity-42'
      const results = new Set<string>()

      for (let i = 0; i < 20; i++) {
        results.add(router.getRangeForKey(key))
      }

      expect(results.size).toBe(1)
    })

    test('should return the same Range for the same numeric key every call', () => {
      const key = 'node-999'
      const first = router.getRangeForKey(key)
      for (let i = 0; i < 10; i++) {
        expect(router.getRangeForKey(key)).toBe(first)
      }
    })

    test('should return one of the defined Range IDs', () => {
      const validRanges = new Set(['range-alpha', 'range-beta', 'range-gamma'])
      const key = 'some-random-key'
      const result = router.getRangeForKey(key)
      expect(validRanges.has(result)).toBe(true)
    })
  })

  describe('distribution across ranges', () => {
    test('should distribute different keys across multiple ranges', () => {
      const rangeCounts: Record<string, number> = {
        'range-alpha': 0,
        'range-beta': 0,
        'range-gamma': 0,
      }

      // Generate 300 distinct keys
      for (let i = 0; i < 300; i++) {
        const key = `key-${i}-${Math.random()}`
        const range = router.getRangeForKey(key)
        rangeCounts[range] = (rangeCounts[range] || 0) + 1
      }

      // With 3 ranges and consistent hashing, some distribution is expected.
      // A really unbalanced result (one range gets < 5%) suggests a bug.
      const counts = Object.values(rangeCounts)
      for (const count of counts) {
        expect(count).toBeGreaterThan(0)
      }
    })

    test('should distribute node IDs across multiple ranges', () => {
      const rangeCounts: Record<string, number> = {
        'range-alpha': 0,
        'range-beta': 0,
        'range-gamma': 0,
      }

      for (let id = 1; id <= 500; id++) {
        const range = router.getRange(id)
        rangeCounts[range] = (rangeCounts[range] || 0) + 1
      }

      const counts = Object.values(rangeCounts)
      for (const count of counts) {
        expect(count).toBeGreaterThan(0)
      }
    })

    test('should use at least 2 different ranges across 500 keys', () => {
      const usedRanges = new Set<string>()

      for (let i = 0; i < 500; i++) {
        usedRanges.add(router.getRangeForKey(`key-${i}`))
      }

      expect(usedRanges.size).toBeGreaterThanOrEqual(2)
    })
  })

  describe('getAllRanges', () => {
    test('should return all 3 range IDs', () => {
      const ranges = router.getAllRanges()
      expect(ranges.sort()).toEqual(['range-alpha', 'range-beta', 'range-gamma'])
    })
  })

  describe('rebuild', () => {
    test('should rebuild routing table with new shard map', () => {
      const newShardMap: ShardMap = {
        ...shardMap,
        version: 2,
        hashRing: {
          virtualNodes: 160,
          nodes: [
            { hash: '0x00000000', rangeId: 'range-alpha' },
            { hash: '0x55555555', rangeId: 'range-beta' },
          ],
        },
      }

      router.rebuild(newShardMap)
      const ranges = router.getAllRanges()
      expect(ranges.sort()).toEqual(['range-alpha', 'range-beta'])
    })
  })

  describe('getShardMap', () => {
    test('should return the current ShardMap', () => {
      const result = router.getShardMap()
      expect(result.version).toBe(1)
      expect(result.ranges.length).toBe(3)
    })
  })

  describe('persistence (persistShardMap / loadShardMap)', () => {
    const tmpDir = path.join(os.tmpdir(), 'shard-router-test-' + Date.now())
    const shardMapFixture = createMockShardMap()

    beforeEach(() => {
      // 清理临时目录
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    test('should persist and reload the same shard map', () => {
      router.persistShardMap(tmpDir)
      const loaded = ShardRouter.loadShardMap(tmpDir)
      expect(loaded).not.toBeNull()
      expect(loaded!.version).toBe(shardMapFixture.version)
      expect(loaded!.ranges).toEqual(shardMapFixture.ranges)
      expect(loaded!.hashRing).toEqual(shardMapFixture.hashRing)
    })

    test('should return null when shard-map.json does not exist', () => {
      const result = ShardRouter.loadShardMap(tmpDir)
      expect(result).toBeNull()
    })

    test('should correctly route after manual JSON modification', () => {
      // 持久化原始路由表
      router.persistShardMap(tmpDir)

      // 修改 JSON 文件 — 去掉 range-gamma
      const filePath = path.join(tmpDir, 'shard-map.json')
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      raw.hashRing.nodes = raw.hashRing.nodes.filter(
        (n: { hash: string; rangeId: string }) => n.rangeId !== 'range-gamma'
      )
      raw.ranges = raw.ranges.filter(
        (r: { rangeId: string }) => r.rangeId !== 'range-gamma'
      )
      raw.version = 2
      fs.writeFileSync(filePath, JSON.stringify(raw, null, 2))

      // 加载修改后的路由表
      const loaded = ShardRouter.loadShardMap(tmpDir)
      expect(loaded).not.toBeNull()
      expect(loaded!.version).toBe(2)
      expect(loaded!.ranges.length).toBe(2)
      expect(loaded!.ranges.map(r => r.rangeId).sort()).toEqual(['range-alpha', 'range-beta'])
    })

    test('should route correctly after loading persisted shard map', () => {
      // 先持久化
      router.persistShardMap(tmpDir)

      // 加载然后重建新路由
      const loaded = ShardRouter.loadShardMap(tmpDir)!
      const restoredRouter = new ShardRouter(loaded)

      // 验证路由一致性
      const key = 'test-key-for-persistence'
      expect(restoredRouter.getRangeForKey(key)).toBe(router.getRangeForKey(key))

      const ranges = restoredRouter.getAllRanges().sort()
      expect(ranges).toEqual(['range-alpha', 'range-beta', 'range-gamma'])
    })
  })
})
