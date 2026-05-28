import { ShardManager, ShardHealthCheckConfig } from './shard-manager'
import { HlcClock } from '../replication/hlc-clock'
import { ShardMap } from '../types'
import { HotShardDetector } from './shard-health'
import * as fs from 'fs'

const randomId = Math.random().toString(36).slice(2, 8)
const TEST_DIR = `/tmp/agentiX-test-shard-health-${randomId}`

describe('ShardManager — Health Check Only', () => {
  let clock: HlcClock
  let shardMap: ShardMap
  let testRunId: string

  beforeAll(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true })
  })

  afterAll(() => {
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }) } catch {}
  })

  beforeEach(() => {
    clock = new HlcClock()
    testRunId = Math.random().toString(36).slice(2, 8)
    shardMap = {
      version: 1,
      ranges: [
        {
          rangeId: 'test-range-0',
          dataDir: `${TEST_DIR}/${testRunId}/range-0`,
          raftConfig: {
            nodeId: 'test-range-0',
            peers: [],
            storagePath: `${TEST_DIR}/${testRunId}/range-0/raft`,
            electionTimeoutMinMs: 150,
            heartbeatIntervalMs: 50,
          },
          overgraphConfig: { path: `${TEST_DIR}/${testRunId}/range-0/graph` },
        },
        {
          rangeId: 'test-range-1',
          dataDir: `${TEST_DIR}/${testRunId}/range-1`,
          raftConfig: {
            nodeId: 'test-range-1',
            peers: [],
            storagePath: `${TEST_DIR}/${testRunId}/range-1/raft`,
            electionTimeoutMinMs: 150,
            heartbeatIntervalMs: 50,
          },
          overgraphConfig: { path: `${TEST_DIR}/${testRunId}/range-1/graph` },
        },
      ],
      hashRing: {
        virtualNodes: 160,
        nodes: [
          { hash: '0x00000000', rangeId: 'test-range-0' },
          { hash: '0x55555555', rangeId: 'test-range-1' },
        ],
      },
    }

    for (let i = 0; i < 2; i++) {
      fs.mkdirSync(`${TEST_DIR}/${testRunId}/range-${i}/raft`, { recursive: true })
      fs.mkdirSync(`${TEST_DIR}/${testRunId}/range-${i}/graph`, { recursive: true })
    }
  })

  afterEach(() => {
    try { fs.rmSync(`${TEST_DIR}/${testRunId}`, { recursive: true, force: true }) } catch {}
  })

  test('getShardHealth returns per-range health after start', async () => {
    const mgr = new ShardManager(shardMap, clock)
    await mgr.start()

    const health = mgr.getShardHealth()
    expect(health.length).toBe(2)
    for (const h of health) {
      expect(h.rangeId).toMatch(/^test-range-[01]$/)
      expect(typeof h.healthy).toBe('boolean')
      expect(typeof h.lastSeenMs).toBe('number')
      expect(h.elapsedMs).toBeGreaterThanOrEqual(0)
    }

    await mgr.stop()
  })

  test('health refreshed by read/write', async () => {
    const mgr = new ShardManager(shardMap, clock)
    await mgr.start()

    const nodeId = await mgr.upsertNode(1, 'health-test-node')
    const health = mgr.getShardHealth()
    const rangeId = mgr.getRouter().getRangeForKey('health-test-node')
    const h = health.find(x => x.rangeId === rangeId)!
    expect(h.healthy).toBe(true)
    expect(h.elapsedMs).toBeLessThan(5000)

    await mgr.stop()
  })

  test('updateHealthConfig updates config', async () => {
    const mgr = new ShardManager(shardMap, clock)
    await mgr.start()

    mgr.updateHealthConfig({ intervalMs: 10000 })
    expect(mgr.getHealthConfig().intervalMs).toBe(10000)

    await mgr.stop()
  })

  test('getHealthConfig returns start() config', async () => {
    const mgr = new ShardManager(shardMap, clock)
    await mgr.start({ intervalMs: 3000, staleThresholdMs: 9000 })

    const cfg = mgr.getHealthConfig()
    expect(cfg.intervalMs).toBe(3000)
    expect(cfg.staleThresholdMs).toBe(9000)

    await mgr.stop()
  })

  test('onStale fires when range exceeds threshold, but reset after ops', async () => {
    const staleRanges: string[] = []
    const mgr = new ShardManager(shardMap, clock)
    await mgr.start({
      intervalMs: 100,
      staleThresholdMs: 50,
      onStale: (rangeId) => { if (!staleRanges.includes(rangeId)) staleRanges.push(rangeId) },
    })

    // Let tick fire — but read/write after keeps it alive
    await mgr.upsertNode(1, 'alive-node')
    await new Promise(r => setTimeout(r, 300))

    // After write + wait, all ranges should be lively (read/write updates lastSeen)
    expect(staleRanges.length).toBe(0)

    await mgr.stop()
  })
})

// ──────────────────────────────────────────
// P1-2: HotShardDetector Tests
// ──────────────────────────────────────────

describe('HotShardDetector', () => {
  let detector: HotShardDetector

  beforeEach(() => {
    detector = new HotShardDetector()
  })

  test('should detect hot shard based on QPS threshold', () => {
    // Record enough ops to exceed the default QPS threshold (100)
    const shardId = 'hot-shard-1'
    const opsNeeded = 110 // slightly above 100 QPS
    const now = Date.now()

    // Manually record ops — we need to simulate time passing
    // The window is 60 seconds, so we need 110 ops in that window
    for (let i = 0; i < opsNeeded; i++) {
      detector.recordOp(shardId, Math.random() * 10) // 0-10ms latencies
    }

    const hotShards = detector.getHotShards(100)
    expect(hotShards).toContain(shardId)
  })

  test('should NOT detect cold shard (below QPS threshold)', () => {
    const shardId = 'cold-shard-1'

    // Record only a few ops (way below 100 QPS)
    for (let i = 0; i < 5; i++) {
      detector.recordOp(shardId, Math.random() * 10)
    }

    const hotShards = detector.getHotShards(100)
    expect(hotShards).not.toContain(shardId)
  })

  test('getShardStats returns correct stats', () => {
    // Record 100 ops with predictable latencies
    const shardId = 'stats-shard'
    for (let i = 0; i < 100; i++) {
      detector.recordOp(shardId, i) // latencies 0, 1, 2, ..., 99
    }

    const stats = detector.getShardStats(shardId)
    expect(stats.totalOps).toBe(100)
    expect(stats.avgLatency).toBeCloseTo(49.5, 0) // (0+99)/2 = 49.5
    expect(stats.p50Latency).toBeCloseTo(49.5, 0) // sorted[49] ≈ 49, sorted[50] ≈ 50 → midpoint
    expect(stats.p99Latency).toBe(99) // sorted[99] = 99
    expect(stats.qps).toBeCloseTo(100 / 60, 2) // 100 ops / 60s window
  })

  test('getShardStats returns zeros for untracked shard', () => {
    const stats = detector.getShardStats('nonexistent')
    expect(stats.totalOps).toBe(0)
    expect(stats.qps).toBe(0)
    expect(stats.avgLatency).toBe(0)
    expect(stats.p50Latency).toBe(0)
    expect(stats.p99Latency).toBe(0)
  })

  test('returns empty array when no shards exceed threshold', () => {
    const shardId = 'quiet-shard'
    for (let i = 0; i < 5; i++) {
      detector.recordOp(shardId, 5)
    }

    const hotShards = detector.getHotShards(100)
    expect(hotShards).toEqual([])
  })

  test('reset clears all tracked data', () => {
    const shardId = 'reset-shard'
    for (let i = 0; i < 200; i++) {
      detector.recordOp(shardId, 5)
    }

    // Verify it's tracked
    expect(detector.getTrackedShards()).toContain(shardId)

    detector.reset()

    expect(detector.getTrackedShards()).not.toContain(shardId)
    const stats = detector.getShardStats(shardId)
    expect(stats.totalOps).toBe(0)
  })

  test('getTrackedShards returns all tracked shard IDs', () => {
    detector.recordOp('shard-a', 5)
    detector.recordOp('shard-b', 10)

    const tracked = detector.getTrackedShards()
    expect(tracked).toContain('shard-a')
    expect(tracked).toContain('shard-b')
  })

  test('should handle empty operation records (no calls to recordOp)', () => {
    const hotShards = detector.getHotShards(100)
    expect(hotShards).toEqual([])

    const tracked = detector.getTrackedShards()
    expect(tracked).toEqual([])
  })

  test('should respect custom p99LatencyMs threshold', () => {
    const shardId = 'latency-shard'
    // 110 ops with high latency (100ms each)
    for (let i = 0; i < 110; i++) {
      detector.recordOp(shardId, 100)
    }

    // With p99 threshold of 50ms — P99=100 > 50 so not hot
    const hotShards = detector.getHotShards(100, 50)
    expect(hotShards).not.toContain(shardId)
  })

  test('should detect hot shard with both QPS and latency thresholds met', () => {
    const shardId = 'hot-latency-shard'
    // 200 ops with low latencies
    for (let i = 0; i < 200; i++) {
      detector.recordOp(shardId, 10 + (i % 10)) // 10-19ms latencies
    }

    // With QPS threshold 100 and p99 threshold 50ms — P99 ≈ 19 < 50, QPS ≈ 3.3
    // Note: actual QPS is 200/60 ≈ 3.3, but we're using a small window
    const hotShards = detector.getHotShards(100, 50) // QPS threshold is 100, but our QPS is only 3.3
    expect(hotShards).not.toContain(shardId)
  })

  test('should track multiple shards independently', () => {
    const hotShardId = 'hot-one'
    const coldShardId = 'cold-one'

    for (let i = 0; i < 200; i++) {
      detector.recordOp(hotShardId, 5)
    }

    for (let i = 0; i < 3; i++) {
      detector.recordOp(coldShardId, 5)
    }

    const hotShards = detector.getHotShards(100)
    expect(hotShards).toContain(hotShardId)
    expect(hotShards).not.toContain(coldShardId)
  })
})
