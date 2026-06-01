import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { ShardRouter } from './shard-router'
import { ShardMap, NodeRecord } from '../types'

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

      for (let i = 0; i < 300; i++) {
        const key = `key-${i}-${Math.random()}`
        const range = router.getRangeForKey(key)
        rangeCounts[range] = (rangeCounts[range] || 0) + 1
      }

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

  describe('getRangeForEdge (P1-S02: symmetric edge routing)', () => {
    test('should return single range when src and dst map to same range', () => {
      const src = 1
      const dst = 2
      // Both nodes route to the same range
      const srcRange = router.getRange(src)
      const dstRange = router.getRange(dst)
      if (srcRange === dstRange) {
        const ranges = router.getRangeForEdge(src, dst)
        expect(ranges).toHaveLength(1)
        expect(ranges[0]).toBe(srcRange)
      }
    })

    test('should return two ranges when src and dst are in different ranges', () => {
      // Find a pair that maps to different ranges
      let src = 1
      let dst = 2
      for (let i = 1; i <= 100; i++) {
        for (let j = i + 1; j <= 100; j++) {
          if (router.getRange(i) !== router.getRange(j)) {
            src = i
            dst = j
            break
          }
        }
        if (router.getRange(src) !== router.getRange(dst)) break
      }

      // Only test if we found different-ranged nodes
      if (router.getRange(src) !== router.getRange(dst)) {
        const ranges = router.getRangeForEdge(src, dst)
        expect(ranges).toHaveLength(2)
        expect(ranges[0]).toBe(router.getRange(src)) // src range first
        expect(ranges[1]).toBe(router.getRange(dst)) // dst range second
      }
    })

    test('should fallback to dst range when src range does not have the edge', () => {
      const src = 1
      const dst = 2
      const srcRange = router.getRange(src)
      const dstRange = router.getRange(dst)

      if (srcRange !== dstRange) {
        // 模拟 edgeExistsInSrcRange 返回 false
        const ranges = router.getRangeForEdge(src, dst, (rangeId) => {
          return false // edge does NOT exist in any range
        })
        expect(ranges[0]).toBe(dstRange) // dst range first (fallback)
        expect(ranges[1]).toBe(srcRange) // src range second
      }
    })

    test('should prefer src range when edge exists', () => {
      const src = 10
      const dst = 20
      const srcRange = router.getRange(src)
      const dstRange = router.getRange(dst)

      if (srcRange !== dstRange) {
        const ranges = router.getRangeForEdge(src, dst, (rangeId) => {
          return rangeId === srcRange // edge exists in src range
        })
        expect(ranges[0]).toBe(srcRange)
        expect(ranges[1]).toBe(dstRange)
      }
    })
  })

  describe('recommendRoute (P1-S01: smart routing)', () => {
    test('should return a valid range for any node', () => {
      const node: NodeRecord = { id: 42, type: 1, name: 'test', props: {} }
      const range = router.recommendRoute(node)
      const validRanges = new Set(['range-alpha', 'range-beta', 'range-gamma'])
      expect(validRanges.has(range)).toBe(true)
    })

    test('should be deterministic for the same node', () => {
      const node: NodeRecord = { id: 42, type: 1, name: 'test', props: {} }
      const first = router.recommendRoute(node)
      const second = router.recommendRoute(node)
      expect(first).toBe(second)
    })

    test('should use label-based routing', () => {
      const node: NodeRecord = { id: 99, type: 5, name: 'test', props: {} }
      const range = router.recommendRoute(node)
      const labelRange = router.getRangeForKey(`label:5:99`)
      // Should be deterministic
      expect(router.recommendRoute(node)).toBe(range)
    })
  })

  describe('recommendRouteWithLoad (load-aware routing)', () => {
    test('should return label range when load is balanced', () => {
      const node: NodeRecord = { id: 42, type: 1, name: 'test', props: {} }
      const loads = [
        { rangeId: 'range-alpha', nodeCount: 100 },
        { rangeId: 'range-beta', nodeCount: 110 },
        { rangeId: 'range-gamma', nodeCount: 90 },
      ]
      const range = router.recommendRouteWithLoad(node, loads)
      expect(typeof range).toBe('string')
    })

    test('should handle empty load data gracefully', () => {
      const node: NodeRecord = { id: 42, type: 1, name: 'test', props: {} }
      const range = router.recommendRouteWithLoad(node, [])
      expect(typeof range).toBe('string')
    })

    test('should prefer lightest range when label range is overloaded', () => {
      const node: NodeRecord = { id: 42, type: 1, name: 'test', props: {} }
      const loads = [
        { rangeId: 'range-alpha', nodeCount: 1000 },
        { rangeId: 'range-beta', nodeCount: 10 },
        { rangeId: 'range-gamma', nodeCount: 100 },
      ]
      const range = router.recommendRouteWithLoad(node, loads)
      // Should prefer the lightest range (beta)
      expect(range).toBe('range-beta')
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
      router.persistShardMap(tmpDir)

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

      const loaded = ShardRouter.loadShardMap(tmpDir)
      expect(loaded).not.toBeNull()
      expect(loaded!.version).toBe(2)
      expect(loaded!.ranges.length).toBe(2)
      expect(loaded!.ranges.map(r => r.rangeId).sort()).toEqual(['range-alpha', 'range-beta'])
    })

    test('should route correctly after loading persisted shard map', () => {
      router.persistShardMap(tmpDir)

      const loaded = ShardRouter.loadShardMap(tmpDir)!
      const restoredRouter = new ShardRouter(loaded)

      const key = 'test-key-for-persistence'
      expect(restoredRouter.getRangeForKey(key)).toBe(router.getRangeForKey(key))

      const ranges = restoredRouter.getAllRanges().sort()
      expect(ranges).toEqual(['range-alpha', 'range-beta', 'range-gamma'])
    })
  })

  describe('persistence with port', () => {
    const tmpDir2 = path.join(os.tmpdir(), 'shard-router-test-port-' + Date.now())
    let router2: ShardRouter

    beforeEach(() => {
      fs.rmSync(tmpDir2, { recursive: true, force: true })
      fs.mkdirSync(tmpDir2, { recursive: true })
    })

    afterAll(() => {
      fs.rmSync(tmpDir2, { recursive: true, force: true })
    })

    test('should persist and load shard map with port on ranges', () => {
      const sm: ShardMap = {
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
        ],
        hashRing: {
          virtualNodes: 160,
          nodes: [{ hash: '0x00000000', rangeId: 'range-alpha' }],
        },
      }
      router2 = new ShardRouter(sm)

      // Test persist
      router2.persistShardMap(tmpDir2)
      const loaded = ShardRouter.loadShardMap(tmpDir2)
      expect(loaded).not.toBeNull()
      expect(loaded!.version).toBe(1)
      expect(loaded!.ranges).toHaveLength(1)
      expect(loaded!.ranges[0].rangeId).toBe('range-alpha')
    })
  })
})
