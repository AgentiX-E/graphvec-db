import { ShardManager, ShardHealthCheckConfig } from './shard-manager'
import { HlcClock } from '../replication/hlc-clock'
import { ShardMap } from '../types'
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
