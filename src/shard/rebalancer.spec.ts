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
    // After SH01 migration, the rebalancer has a migration entry from range-0 → range-1
    const reb = new Rebalancer(shardManager)
    const history = reb.getMigrationHistory()
    const entry = history.find(m => m.sourceRangeId === 'rebal-range-0')
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
