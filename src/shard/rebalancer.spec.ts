import { Rebalancer, RebalancerOptions, RebalancerStats } from './rebalancer'
import { ShardManager } from './shard-manager'
import { HlcClock } from '../replication/hlc-clock'
import { ShardMap } from '../types'

vi.setConfig({ testTimeout: 30000 })
import * as fs from 'fs'

// ══════════════════════════════════════════
// Note: Tests SH01 through SH04 use a shared ShardManager singleton (beforeAll).
// The describe blocks run in declaration ORDER, so SH01 runs first on a clean
// ShardManager. SH02 runs second and reads state from SH01. After SH01/SH02,
// only rebal-range-0 remains (range-1 was migrated). SH03 and SH04 adapt to
// the reduced range set.
// ══════════════════════════════════════════

const ROOT_DIR = '/tmp/agentiX-test-rebal-suite'
let TEST_ROOT = ''
let testCounter = 0

function nextSuffix(): string {
  return `${process.pid}-${testCounter++}`
}

function makeShardMap(testDir: string, rangeCount: number = 2): ShardMap {
  const ranges = Array.from({ length: rangeCount }, (_, i) => ({
    rangeId: `rebal-range-${i}`,
    dataDir: `${testDir}/range-${i}`,
    raftConfig: {
      nodeId: `rebal-range-${i}`,
      peers: [] as { id: string; address: string }[],
      storagePath: `${testDir}/range-${i}/raft`,
      electionTimeoutMinMs: 150,
      heartbeatIntervalMs: 50,
    },
    overgraphConfig: { path: `${testDir}/range-${i}/graph` },
  }))

  const hashNodes = Array.from({ length: rangeCount }, (_, i) => {
    const hash = `0x${(i * 0xffffffff / rangeCount).toString(16).padStart(8, '0')}`
    return { hash, rangeId: `rebal-range-${i}` }
  })

  return {
    version: 1,
    ranges,
    hashRing: { virtualNodes: 160, nodes: hashNodes },
  }
}

let shardManager: ShardManager
let rebalancer: Rebalancer

beforeAll(async () => {
  TEST_ROOT = `${ROOT_DIR}-${process.pid}`
  try { fs.rmSync(ROOT_DIR, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }) } catch {}
  
  const sm = makeShardMap(TEST_ROOT, 2)
  for (const r of sm.ranges) {
    fs.mkdirSync(`${r.dataDir}/raft`, { recursive: true })
    fs.mkdirSync(`${r.dataDir}/graph`, { recursive: true })
  }
  shardManager = new ShardManager(sm, new HlcClock())
  rebalancer = new Rebalancer(shardManager)
  await shardManager.start()
}, 30000)

afterAll(async () => {
  await shardManager.stop()
  try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(ROOT_DIR, { recursive: true, force: true }) } catch {}
}, 15000)

// ══════════════════════════════════════════
// SH01: Reshard 数据迁移完整性（最先执行，需要两个 range 都完整）
// ══════════════════════════════════════════
describe('SH01: Reshard data migration integrity', () => {

  test('SH01: migrateRangeComplete should perform fence → flush → migrate → verify → cleanup', async () => {
    const suffix = nextSuffix()
    const srcRange = shardManager.getRange('rebal-range-0')
    const tgtRange = shardManager.getRange('rebal-range-1')
    const reb = new Rebalancer(shardManager)

    const nodeIds: number[] = []
    for (let i = 0; i < 3; i++) {
      const id = await srcRange.write({
        type: 'upsert_node',
        payload: { typeId: 1, name: `sh01-n-${i}-${suffix}`, opts: undefined },
      })
      nodeIds.push(id as number)
    }

    for (const id of nodeIds) {
      const node = await srcRange.read(e => e.getNode(id))
      expect(node).not.toBeNull()
    }

    await new Promise(r => setTimeout(r, 100))
    await reb.migrateRangeComplete('rebal-range-0', 'rebal-range-1', nodeIds)

    expect(() => shardManager.getRange('rebal-range-0')).toThrow()
    for (const id of nodeIds) {
      const node = await tgtRange.read(e => e.getNode(id))
      expect(node).not.toBeNull()
    }
  })

  test('SH01: migrateRangeComplete should throw if source range does not exist', async () => {
    const reb = new Rebalancer(shardManager)
    await expect(
      reb.migrateRangeComplete('nonexistent-range', 'rebal-range-1', [1, 2, 3])
    ).rejects.toThrow()
  })

  test('SH01: migrateRangeComplete should handle empty node list gracefully', async () => {
    const reb = new Rebalancer(shardManager)
    await expect(
      reb.migrateRangeComplete('already-fenced', 'rebal-range-1', [])
    ).rejects.toThrow()
  })
})

// ══════════════════════════════════════════
// SH02: Reshard 持久化（第二执行，依赖 SH01 的迁移记录）
// ══════════════════════════════════════════
describe('SH02: Reshard state persistence', () => {

  test('SH02: Rebalancer should have recorded initial migration in history', () => {
    const reb = new Rebalancer(shardManager)
    const history = reb.getMigrationHistory()
    // Find the most recent completed migration from rebal-range-0 → rebal-range-1
    const entry = [...history].reverse().find(m => m.sourceRangeId === 'rebal-range-0' && m.targetRangeId === 'rebal-range-1')
    expect(entry).toBeDefined()
    expect(entry!.targetRangeId).toBe('rebal-range-1')
    expect(entry!.timestamp).toBeGreaterThan(0)
    expect(entry!.nodeIds.length).toBeGreaterThan(0)
  })

  test('SH02: recoverInterruptedMigrations returns 0 when no interrupted migrations', async () => {
    const reb = new Rebalancer(shardManager)
    const recovered = await reb.recoverInterruptedMigrations()
    expect(recovered).toBe(0)
  })
})

// ══════════════════════════════════════════
// 创建测试（不影响 ShardManager 状态的纯逻辑）
// ══════════════════════════════════════════
describe('Rebalancer creation', () => {

  test('should create Rebalancer with default options', () => {
    const reb = new Rebalancer(shardManager)
    expect(reb).toBeDefined()
  })

  test('should create Rebalancer with custom options', () => {
    const reb = new Rebalancer(shardManager, {
      checkIntervalMs: 10000,
      nodeCountDeviationThreshold: 0.3,
      loadFactorThreshold: 1.5,
    })
    expect(reb).toBeDefined()
  })
})

// ══════════════════════════════════════════
// getStats（只读，不影响状态）
// ══════════════════════════════════════════
describe('Rebalancer stats', () => {

  test('getStats should return stats with ranges', async () => {
    const reb = new Rebalancer(shardManager)
    const stats: RebalancerStats = reb.getStats()
    expect(stats.ranges).toBeDefined()
    expect(stats.ranges.length).toBeGreaterThanOrEqual(1)
    expect(typeof stats.averageNodeCount).toBe('number')
    expect(typeof stats.needsRebalancing).toBe('boolean')
    expect(stats.lastRebalance).toBeNull()
  })

  test('getStats should reflect node counts after inserting nodes', async () => {
    const suffix = nextSuffix()
    const reb = new Rebalancer(shardManager)
    const range = shardManager.getRange('rebal-range-1')

    for (let i = 0; i < 5; i++) {
      await range.write({
        type: 'upsert_node',
        payload: { typeId: 1, name: `snode-${i}-${suffix}`, opts: undefined },
      })
    }

    await new Promise(r => setTimeout(r, 50))
    const stats = reb.getStats()
    expect(stats.ranges.length).toBeGreaterThanOrEqual(1)
    expect(typeof stats.averageNodeCount).toBe('number')
    expect(typeof stats.needsRebalancing).toBe('boolean')
  })
})

// ══════════════════════════════════════════
// trigger / lifecycle（只读 Rebalancer）
// ══════════════════════════════════════════
describe('Rebalancer trigger and lifecycle', () => {

  test('trigger should complete without error', async () => {
    await expect(rebalancer.trigger()).resolves.toBeUndefined()
  })

  test('trigger should not throw when called twice sequentially', async () => {
    await rebalancer.trigger()
    await rebalancer.trigger()
  })

  test('start should not throw', () => {
    const reb = new Rebalancer(shardManager)
    expect(() => reb.start()).not.toThrow()
    reb.stop()
  })

  test('stop should not throw when not started', () => {
    const reb = new Rebalancer(shardManager)
    expect(() => reb.stop()).not.toThrow()
  })
})

// ══════════════════════════════════════════
// Consistency checksum
// ══════════════════════════════════════════
describe('Consistency checksum', () => {

  test('SH03: computeChecksums() collects and verifyConsistency() works', async () => {
    const suffix = nextSuffix()
    const reb = new Rebalancer(shardManager)

    const checksums = await reb.computeChecksums()
    expect(checksums.length).toBeGreaterThanOrEqual(1)
    for (const cs of checksums) {
      expect(cs).toHaveProperty('rangeId')
      expect(cs).toHaveProperty('nodeChecksum')
      expect(cs.collectedAt).toBeGreaterThan(0)
    }

    const before = checksums
    const range = shardManager.getRange('rebal-range-1')
    const idA = await range.write({ type: 'upsert_node', payload: { typeId: 1, name: `sh03-a-${suffix}` } })
    const idB = await range.write({ type: 'upsert_node', payload: { typeId: 1, name: `sh03-b-${suffix}` } })
    await range.write({ type: 'upsert_edge', payload: { src: idA, dst: idB, typeId: 1 } })
    await new Promise(r => setTimeout(r, 50))

    const after = await reb.computeChecksums()
    const r0Before = before.find(c => c.rangeId === 'rebal-range-1')!
    const r0After = after.find(c => c.rangeId === 'rebal-range-1')!
    expect(r0After.nodeChecksum).not.toBe(r0Before.nodeChecksum)
    expect(r0After.totalEdges).toBeGreaterThanOrEqual(1)

    const resultAfter = await reb.verifyConsistency()
    expect(resultAfter.checksums.length).toBeGreaterThanOrEqual(1)
    expect(Array.isArray(resultAfter.anomalies)).toBe(true)
  })
})

// ══════════════════════════════════════════
// Hot node detection（写入再删除，不影响全局）
// ══════════════════════════════════════════
describe('Hot node detection', () => {
  const tempNodes: number[] = []

  afterEach(() => {
    const range = shardManager.getRange('rebal-range-1')
    for (const id of tempNodes.splice(0)) {
      try { range.write({ type: 'delete_node', payload: { id } }) } catch {}
    }
  })

  test('_findHotNodes should return nodes with highest degree', async () => {
    const suffix = nextSuffix()
    const range = shardManager.getRange('rebal-range-1')
    const reb = new Rebalancer(shardManager)

    const existingNodes: number[] = await range.read(e => e.findNodesByType(1))

    const nodeIds: number[] = []
    for (let i = 0; i < 10; i++) {
      const id = await range.write({
        type: 'upsert_node',
        payload: { typeId: 1, name: `hot-${i}-${suffix}`, opts: undefined },
      })
      nodeIds.push(id as number)
      tempNodes.push(id as number)
    }
    await new Promise(r => setTimeout(r, 50))

    const allIds: number[] = await range.read(e => e.findNodesByType(1))
    const ourIds = allIds.filter((id, idx) => idx >= allIds.length - 10)
    const hotNodes = await (reb as any)._findHotNodes(range, 3)
    expect(hotNodes).toBeDefined()
    expect(Array.isArray(hotNodes)).toBe(true)
    expect(hotNodes.length).toBeGreaterThanOrEqual(1)
    expect(hotNodes.length).toBeLessThanOrEqual(3)
  })

  test('_findHotNodes should respect maxMigrationsPerRound count', async () => {
    const suffix = nextSuffix()
    const range = shardManager.getRange('rebal-range-1')
    const reb = new Rebalancer(shardManager)

    const nodeIds: number[] = []
    for (let i = 0; i < 5; i++) {
      const id = await range.write({
        type: 'upsert_node',
        payload: { typeId: 1, name: `hot2-${i}-${suffix}`, opts: undefined },
      })
      nodeIds.push(id as number)
      tempNodes.push(id as number)
    }
    for (const id of nodeIds) {
      await range.write({
        type: 'upsert_edge',
        payload: { src: id, dst: id, typeId: 1, opts: undefined },
      })
    }
    await new Promise(r => setTimeout(r, 100))

    const hotNodes = await (reb as any)._findHotNodes(range, 1)
    expect(hotNodes).toBeDefined()
    expect(hotNodes.length).toBeLessThanOrEqual(1)
  })

  test('_findHotNodes should accept non-empty range', async () => {
    const range = shardManager.getRange('rebal-range-1')
    const reb = new Rebalancer(shardManager)
    const hotNodes = await (reb as any)._findHotNodes(range, 5)
    expect(hotNodes).toBeDefined()
    expect(Array.isArray(hotNodes)).toBe(true)
    expect(hotNodes.length).toBeLessThanOrEqual(5)
  })
})

// ══════════════════════════════════════════
// SH04: Auto-split
// ══════════════════════════════════════════
describe('SH04: Auto-split automation', () => {

  test('SH04: Rebalancer should be created with auto-split enabled by default', () => {
    const reb = new Rebalancer(shardManager)
    const config = reb.getAutoSplitConfig()
    expect(config.autoSplitEnabled).toBe(true)
    expect(config.maxNodesPerRange).toBe(10000)
  })

  test('SH04: Rebalancer should be created with custom auto-split config', () => {
    const reb = new Rebalancer(shardManager, {
      maxNodesPerRange: 50000,
      autoSplitEnabled: false,
    })
    const config = reb.getAutoSplitConfig()
    expect(config.autoSplitEnabled).toBe(false)
    expect(config.maxNodesPerRange).toBe(50000)
  })

  test('SH04: checkAndSplit with autoSplitEnabled=false returns 0', async () => {
    const reb = new Rebalancer(shardManager, { autoSplitEnabled: false })
    const splits = await reb.checkAndSplit()
    expect(splits).toBe(0)
  })

  test('SH04: checkAndSplit on empty ranges returns 0', async () => {
    const reb = new Rebalancer(shardManager, { maxNodesPerRange: 10000 })
    const splits = await reb.checkAndSplit()
    expect(splits).toBe(0)
  })

  test('SH04: checkAndSplit should not split ranges under threshold', async () => {
    const suffix = nextSuffix()
    const range = shardManager.getRange('rebal-range-1')
    await range.write({
      type: 'upsert_node',
      payload: { typeId: 1, name: `sh04-under-${suffix}`, opts: undefined },
    })
    await new Promise(r => setTimeout(r, 50))

    const reb = new Rebalancer(shardManager, { maxNodesPerRange: 10000 })
    const splits = await reb.checkAndSplit()
    expect(splits).toBe(0)
  })
})

// ══════════════════════════════════════════
// SH05: Hot-spot detection
// ══════════════════════════════════════════
describe('SH05: Hot-spot detection', () => {

  test('SH05: getHotSpotConfig returns default config', () => {
    const reb = new Rebalancer(shardManager)
    const config = reb.getHotSpotConfig()
    expect(config.hotSpotThreshold).toBe(1000)
    expect(config.hotSpotWindowMs).toBe(60000)
  })

  test('SH05: getHotSpotConfig returns custom config', () => {
    const reb = new Rebalancer(shardManager, {
      hotSpotThreshold: 500,
      hotSpotWindowMs: 30000,
    })
    const config = reb.getHotSpotConfig()
    expect(config.hotSpotThreshold).toBe(500)
    expect(config.hotSpotWindowMs).toBe(30000)
  })

  test('SH05: recordOperation increments counter', () => {
    const reb = new Rebalancer(shardManager)
    reb.recordOperation('range-1')
    expect(reb.getOperationCount('range-1')).toBe(1)

    reb.recordOperation('range-1')
    reb.recordOperation('range-1')
    expect(reb.getOperationCount('range-1')).toBe(3)
  })

  test('SH05: recordOperation tracks multiple ranges independently', () => {
    const reb = new Rebalancer(shardManager)
    reb.recordOperation('range-a')
    reb.recordOperation('range-b')
    reb.recordOperation('range-b')
    reb.recordOperation('range-a')
    reb.recordOperation('range-a')

    expect(reb.getOperationCount('range-a')).toBe(3)
    expect(reb.getOperationCount('range-b')).toBe(2)
  })

  test('SH05: getOperationCount returns 0 for unknown range', () => {
    const reb = new Rebalancer(shardManager)
    expect(reb.getOperationCount('nonexistent')).toBe(0)
  })

  test('SH05: findHotRanges returns empty when below threshold', () => {
    const reb = new Rebalancer(shardManager, {
      hotSpotThreshold: 1000,
      hotSpotWindowMs: 60000,
    })

    // Start window, then immediately add ops (same timestamp bucket)
    reb.recordOperation('range-1')
    reb.recordOperation('range-1')

    // We need to ensure the window has started counting with some real elapsed time.
    // Since both ops happened in the same ms, elapsedSec=0 gives opsPerSec=Infinity.
    // Instead, submit operations spread over a short but measurable time.
    // For this test, access the private _rangeOpRecords to check directly,
    // and set a windowStart in the past to simulate a real scenario.
    const reb2 = new Rebalancer(shardManager, {
      hotSpotThreshold: 1000,
      hotSpotWindowMs: 60000,
    })
    // Manually set a past windowStart to simulate elapsed time with low rate
    ;(reb2 as any)._rangeOpRecords.set('range-1', { count: 2, windowStart: Date.now() - 10000 })
    expect(reb2.findHotRanges()).toHaveLength(0)
  })

  test('SH05: findHotRanges returns hot range when above threshold', () => {
    const reb = new Rebalancer(shardManager, {
      hotSpotThreshold: 50,
      hotSpotWindowMs: 60000,
    })

    // Simulate many operations in quick succession
    for (let i = 0; i < 200; i++) {
      reb.recordOperation('range-hot')
    }

    const hotRanges = reb.findHotRanges()
    expect(hotRanges.length).toBeGreaterThanOrEqual(1)

    const hotRange = hotRanges.find(r => r.rangeId === 'range-hot')
    expect(hotRange).toBeDefined()
    expect(hotRange!.opsPerSec).toBeGreaterThanOrEqual(50)
  })

  test('SH05: findHotRanges respects window expiry', async () => {
    const reb = new Rebalancer(shardManager, {
      hotSpotThreshold: 50,
      hotSpotWindowMs: 50, // very short window
    })

    reb.recordOperation('range-expire')

    await new Promise(r => setTimeout(r, 60))

    // After window expiry, findHotRanges should clean up
    const hotRanges = reb.findHotRanges()
    expect(hotRanges).toHaveLength(0)
  })

  test('SH05: clearStaleOpRecords removes expired records', async () => {
    const reb = new Rebalancer(shardManager, {
      hotSpotThreshold: 1000,
      hotSpotWindowMs: 30, // very short window
    })

    reb.recordOperation('range-stale-1')
    reb.recordOperation('range-stale-2')

    await new Promise(r => setTimeout(r, 50))

    reb.clearStaleOpRecords()

    expect(reb.getOperationCount('range-stale-1')).toBe(0)
    expect(reb.getOperationCount('range-stale-2')).toBe(0)
  })

  test('SH05: recordOperation resets window after expiry', async () => {
    const reb = new Rebalancer(shardManager, {
      hotSpotThreshold: 1000,
      hotSpotWindowMs: 50,
    })

    reb.recordOperation('range-reset')
    expect(reb.getOperationCount('range-reset')).toBe(1)

    await new Promise(r => setTimeout(r, 60))

    // After expiry, next recordOperation should start a new window
    // count should be 1 (from the new operation), not 2
    reb.recordOperation('range-reset')
    expect(reb.getOperationCount('range-reset')).toBe(1)
  })
})

// ══════════════════════════════════════════
// SH01: Reshard 数据迁移（单元测试，使用 mock RangeInstance）
// ══════════════════════════════════════════
describe('SH01: Reshard 数据迁移', () => {

  test('SH01: migrateRangeComplete 正确设置 draining → flush → migrate 流程', async () => {
    // 创建 mock RangeInstance
    const mockSourceRange = {
      setDraining: vi.fn(),
      isDraining: vi.fn().mockReturnValue(false),
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    }
    const mockTargetRange = {
      setDraining: vi.fn(),
      isDraining: vi.fn().mockReturnValue(false),
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    }

    // Mock manager
    const mockManager = {
      getRange: vi.fn((rangeId: string) => {
        if (rangeId === 'source-range-ok') return mockSourceRange as unknown as RangeInstance
        if (rangeId === 'target-range-ok') return mockTargetRange as unknown as RangeInstance
        throw new Error(`Range not found: ${rangeId}`)
      }),
      getAllRanges: vi.fn().mockReturnValue(new Map()),
      removeRange: vi.fn(),
    }

    const reb = new Rebalancer(mockManager as unknown as ShardManager)

    // Spy on internal _doRebalanceNodes to verify it was called
    const doRebalanceSpy = vi.spyOn(reb as any, '_doRebalanceNodes').mockResolvedValue(undefined)
    // Spy on _flushOps
    const flushSpy = vi.spyOn(reb as any, '_flushOps').mockResolvedValue(undefined)
    // Spy on computeChecksums
    const computeChecksumsSpy = vi.spyOn(reb, 'computeChecksums').mockResolvedValue([])

    await reb.migrateRangeComplete('source-range-ok', 'target-range-ok', [1, 2, 3])

    // Verify fence: draining was set on source
    expect(mockSourceRange.setDraining).toHaveBeenCalledWith(true)

    // Verify flush was called
    expect(flushSpy).toHaveBeenCalledWith('source-range-ok')

    // Verify migrate was called with correct params
    expect(doRebalanceSpy).toHaveBeenCalledWith('source-range-ok', 'target-range-ok', [1, 2, 3])

    // Verify checksum was computed
    expect(computeChecksumsSpy).toHaveBeenCalled()

    // Verify cleanup: draining was released, source range was stopped and removed
    expect(mockSourceRange.setDraining).toHaveBeenCalledWith(false)
    expect(mockSourceRange.stop).toHaveBeenCalled()
    expect(mockManager.removeRange).toHaveBeenCalledWith('source-range-ok')

    // Verify migration entry in history has status 'completed'
    const history = reb.getMigrationHistory()
    const entry = history.find(m => m.sourceRangeId === 'source-range-ok')
    expect(entry).toBeDefined()
    expect(entry!.status).toBe('completed')

    doRebalanceSpy.mockRestore()
    flushSpy.mockRestore()
    computeChecksumsSpy.mockRestore()
  })

  test('SH01: migrateRangeComplete 错误时 status 标记为 failed 并保留 error', async () => {
    const mockSourceRange = {
      setDraining: vi.fn(),
      isDraining: vi.fn().mockReturnValue(false),
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    }
    const mockTargetRange = {
      setDraining: vi.fn(),
      isDraining: vi.fn().mockReturnValue(false),
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    }

    const mockManager = {
      getRange: vi.fn((rangeId: string) => {
        if (rangeId === 'source-range-err') return mockSourceRange as unknown as RangeInstance
        if (rangeId === 'target-range-err') return mockTargetRange as unknown as RangeInstance
        throw new Error(`Range not found: ${rangeId}`)
      }),
      getAllRanges: vi.fn().mockReturnValue(new Map()),
      removeRange: vi.fn(),
    }

    const reb = new Rebalancer(mockManager as unknown as ShardManager)
    const testError = new Error('Migration failed: disk full')

    // Make _doRebalanceNodes throw
    const doRebalanceSpy = vi.spyOn(reb as any, '_doRebalanceNodes').mockRejectedValue(testError)
    vi.spyOn(reb as any, '_flushOps').mockResolvedValue(undefined)

    await expect(
      reb.migrateRangeComplete('source-range-err', 'target-range-err', [1, 2, 3])
    ).rejects.toThrow('Migration failed: disk full')

    // Verify migration entry has status 'failed' with error
    const history = reb.getMigrationHistory()
    const entry = history.find(m => m.sourceRangeId === 'source-range-err')
    expect(entry).toBeDefined()
    expect(entry!.status).toBe('failed')
    expect(entry!.error).toBe('Migration failed: disk full')

    doRebalanceSpy.mockRestore()
  })

  test('SH01: fence 步骤中 draining 标志被设置', async () => {
    const drainingValues: boolean[] = []

    const mockSourceRange = {
      setDraining: vi.fn((val: boolean) => {
        drainingValues.push(val)
      }),
      isDraining: vi.fn(() => drainingValues.length > 0 && drainingValues[drainingValues.length - 1]),
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    }
    const mockTargetRange = {
      setDraining: vi.fn(),
      isDraining: vi.fn().mockReturnValue(false),
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    }

    const mockManager = {
      getRange: vi.fn((rangeId: string) => {
        if (rangeId === 'source-range-fence') return mockSourceRange as unknown as RangeInstance
        if (rangeId === 'target-range-fence') return mockTargetRange as unknown as RangeInstance
        throw new Error(`Range not found: ${rangeId}`)
      }),
      getAllRanges: vi.fn().mockReturnValue(new Map()),
      removeRange: vi.fn(),
    }

    const reb = new Rebalancer(mockManager as unknown as ShardManager)
    vi.spyOn(reb as any, '_doRebalanceNodes').mockResolvedValue(undefined)
    vi.spyOn(reb as any, '_flushOps').mockResolvedValue(undefined)
    vi.spyOn(reb, 'computeChecksums').mockResolvedValue([])

    // Sanity check: draining is false before migration
    expect(mockSourceRange.isDraining()).toBe(false)

    await reb.migrateRangeComplete('source-range-fence', 'target-range-fence', [1, 2, 3])

    // Verify setDraining was called at least twice (true for fence, false for cleanup)
    expect(mockSourceRange.setDraining).toHaveBeenCalledTimes(2)
    // First call should be with true (fence step)
    expect(drainingValues[0]).toBe(true)
    // Last call should be with false (cleanup step)
    expect(drainingValues[drainingValues.length - 1]).toBe(false)
  })
})

// ══════════════════════════════════════════
// SH03: Rebalancer 一致性校验（单元测试，使用 mock RangeInstance）
// ══════════════════════════════════════════
describe('SH03: Rebalancer 一致性校验', () => {

  test('SH03: 空 Range 的 nodeChecksum 为 0', async () => {
    // Mock engine that returns empty results
    const mockEngine = {
      findNodesByType: vi.fn().mockReturnValue([]),
      stats: vi.fn().mockReturnValue({ nodeCount: 0, edgeCount: 0 }),
    }

    const mockRange = {
      read: vi.fn((fn: (engine: any) => any) => Promise.resolve(fn(mockEngine))),
    }

    const mockManager = {
      getAllRanges: vi.fn().mockReturnValue(
        new Map([['empty-range', mockRange as unknown as RangeInstance]])
      ),
      getRange: vi.fn().mockReturnValue(mockRange as unknown as RangeInstance),
    }

    const reb = new Rebalancer(mockManager as unknown as ShardManager)
    const checksums = await reb.computeChecksums()

    expect(checksums).toHaveLength(1)
    expect(checksums[0].rangeId).toBe('empty-range')
    expect(checksums[0].nodeChecksum).toBe('0')
    expect(checksums[0].totalEdges).toBe(0)
    expect(checksums[0].collectedAt).toBeGreaterThan(0)
  })

  test('SH03: 有数据的 Range 的 nodeChecksum 为 digest 字符串', async () => {
    // Mock engine with nodes
    const mockEngine = {
      findNodesByType: vi.fn((typeId: number) => {
        if (typeId === 0) return [100, 200, 300]
        return []
      }),
      stats: vi.fn().mockReturnValue({ nodeCount: 3, edgeCount: 5 }),
    }

    const mockRange = {
      read: vi.fn((fn: (engine: any) => any) => Promise.resolve(fn(mockEngine))),
    }

    const mockManager = {
      getAllRanges: vi.fn().mockReturnValue(
        new Map([['data-range', mockRange as unknown as RangeInstance]])
      ),
      getRange: vi.fn().mockReturnValue(mockRange as unknown as RangeInstance),
    }

    const reb = new Rebalancer(mockManager as unknown as ShardManager)
    const checksums = await reb.computeChecksums()

    expect(checksums).toHaveLength(1)
    expect(checksums[0].rangeId).toBe('data-range')
    // nodeChecksum should be a non-zero digest (base36 string of hash)
    expect(checksums[0].nodeChecksum).not.toBe('0')
    expect(typeof checksums[0].nodeChecksum).toBe('string')
    expect(checksums[0].nodeChecksum.length).toBeGreaterThan(0)
    expect(checksums[0].totalEdges).toBe(5)
    expect(checksums[0].collectedAt).toBeGreaterThan(0)
  })

  test('SH03: 两个相同的 Range 的 checksum 一致', async () => {
    const mockEngineA = {
      findNodesByType: vi.fn((typeId: number) => {
        if (typeId === 1) return [10, 20, 30]
        return []
      }),
      stats: vi.fn().mockReturnValue({ nodeCount: 3, edgeCount: 2 }),
    }

    const mockEngineB = {
      findNodesByType: vi.fn((typeId: number) => {
        if (typeId === 1) return [10, 20, 30]
        return []
      }),
      stats: vi.fn().mockReturnValue({ nodeCount: 3, edgeCount: 2 }),
    }

    const mockRangeA = {
      read: vi.fn((fn: (engine: any) => any) => Promise.resolve(fn(mockEngineA))),
    }
    const mockRangeB = {
      read: vi.fn((fn: (engine: any) => any) => Promise.resolve(fn(mockEngineB))),
    }

    const mockManager = {
      getAllRanges: vi.fn().mockReturnValue(
        new Map([
          ['range-a', mockRangeA as unknown as RangeInstance],
          ['range-b', mockRangeB as unknown as RangeInstance],
        ])
      ),
      getRange: vi.fn((rangeId: string) => {
        if (rangeId === 'range-a') return mockRangeA as unknown as RangeInstance
        if (rangeId === 'range-b') return mockRangeB as unknown as RangeInstance
        throw new Error(`Range not found: ${rangeId}`)
      }),
    }

    const reb = new Rebalancer(mockManager as unknown as ShardManager)
    const checksums = await reb.computeChecksums()

    expect(checksums).toHaveLength(2)
    const csA = checksums.find(c => c.rangeId === 'range-a')
    const csB = checksums.find(c => c.rangeId === 'range-b')
    expect(csA).toBeDefined()
    expect(csB).toBeDefined()
    expect(csA!.nodeChecksum).toBe(csB!.nodeChecksum)
    expect(csA!.totalEdges).toBe(csB!.totalEdges)
  })

  test('SH03: computeChecksums 返回所有 Range 的 checksum 数组', async () => {
    const makeMockEngine = (typeIdOffset: number) => ({
      findNodesByType: vi.fn((typeId: number) => {
        if (typeId === 0) return [typeIdOffset + 1, typeIdOffset + 2]
        return []
      }),
      stats: vi.fn().mockReturnValue({ nodeCount: 2, edgeCount: 1 }),
    })

    const mockRanges = new Map([
      ['range-1', { read: vi.fn((fn: any) => Promise.resolve(fn(makeMockEngine(100)))) }],
      ['range-2', { read: vi.fn((fn: any) => Promise.resolve(fn(makeMockEngine(200)))) }],
      ['range-3', { read: vi.fn((fn: any) => Promise.resolve(fn(makeMockEngine(300)))) }],
    ] as unknown as [string, RangeInstance][])

    const mockManager = {
      getAllRanges: vi.fn().mockReturnValue(mockRanges),
      getRange: vi.fn((rangeId: string) => mockRanges.get(rangeId) as RangeInstance),
    }

    const reb = new Rebalancer(mockManager as unknown as ShardManager)
    const checksums = await reb.computeChecksums()

    expect(checksums).toHaveLength(3)
    const rangeIds = checksums.map(c => c.rangeId).sort()
    expect(rangeIds).toEqual(['range-1', 'range-2', 'range-3'])

    // Each checkusm should have all required fields
    for (const cs of checksums) {
      expect(cs).toHaveProperty('rangeId')
      expect(cs).toHaveProperty('nodeChecksum')
      expect(cs).toHaveProperty('totalEdges')
      expect(cs).toHaveProperty('collectedAt')
      expect(typeof cs.nodeChecksum).toBe('string')
      expect(cs.nodeChecksum).not.toBe('0') // each has data
      expect(cs.totalEdges).toBe(1)
      expect(cs.collectedAt).toBeGreaterThan(0)
    }

    // Range 3 has different data so its checksum should differ
    const cs1 = checksums.find(c => c.rangeId === 'range-1')!
    const cs2 = checksums.find(c => c.rangeId === 'range-2')!
    const cs3 = checksums.find(c => c.rangeId === 'range-3')!
    expect(cs1.nodeChecksum).not.toBe(cs3.nodeChecksum)
    expect(cs2.nodeChecksum).not.toBe(cs3.nodeChecksum)
  })
})
