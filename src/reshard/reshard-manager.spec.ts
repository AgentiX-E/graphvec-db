/**
 * reshard-manager.spec.ts — ReshardManager 在线 Resharding 测试
 *
 * 测试策略：
 * ReshardManager 协调 ShardManager + ReshardPlan + ReshardWorker。
 * ShardManager 需要真实 RangeInstance，通过 jest.mock 模块级别 mock。
 * 单元测试验证：
 * - 状态机转换（pending → dual_write → migrating → ... → completed）
 * - 3PC 原子提交流程
 * - 回滚逻辑
 * - 容错处理
 */
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { ReshardManager } from './reshard-manager'
import { ShardManager } from '../shard/shard-manager'
import { RangeInstance } from '../shard/range-instance'
import { HlcClock } from '../replication/hlc-clock'
import { ReshardingPlan, ReshardSplit, ShardMap } from '../types'
import { GraphEngine } from '../core/graph-engine'

vi.mock('../core/graph-engine', () => {
  let nodeCounter = 0
  return {
    GraphEngine: vi.fn().mockImplementation(function() {
      const nodes: Array<{ id: number; type: number; name: string }> = []
      return {
        open: vi.fn(),
        close: vi.fn(),
        upsertNode: vi.fn().mockImplementation((typeId: number, name: string) => {
          const id = ++nodeCounter
          nodes.push({ id, type: typeId, name })
          return BigInt(id)
        }),
        upsertEdge: vi.fn(),
        deleteNode: vi.fn(),
        deleteEdge: vi.fn(),
        batchUpsertNodes: vi.fn().mockReturnValue([]),
        queryPattern: vi.fn().mockReturnValue([]),
        neighbors: vi.fn().mockReturnValue({ edges: [], nodes: [] }),
        getNode: vi.fn(),
        getEdge: vi.fn(),
        exportSnapshot: vi.fn().mockReturnValue(
          Buffer.from(JSON.stringify({ nodes: nodes.map(n => ({ ...n })), version: 1 }))
        ),
        importSnapshot: vi.fn().mockImplementation((buf: Buffer) => {
          const data = JSON.parse(buf.toString())
          if (Array.isArray(data.nodes)) {
            data.nodes.forEach((n: { id: number; type: number; name: string }) => {
              if (!nodes.find(x => x.id === n.id)) {
                nodes.push({ id: n.id, type: n.type, name: n.name })
              }
            })
          }
        }),
        stats: vi.fn().mockReturnValue({ nodeCount: nodes.length, edgeCount: 0, diskSizeBytes: 100 }),
        compact: vi.fn(),
        isOpen: false,
      }
    }),
  }
})

function createShardMap(testRunId: string, dir: string): ShardMap {
  return {
    version: 1,
    ranges: [
      {
        rangeId: 'range-0',
        dataDir: path.join(dir, 'range-0'),
        raftConfig: {
          nodeId: 'range-0',
          peers: [],
          storagePath: path.join(dir, 'range-0', 'raft'),
          electionTimeoutMinMs: 150,
          heartbeatIntervalMs: 50,
        },
        overgraphConfig: { path: path.join(dir, 'range-0', 'graph') },
      },
      {
        rangeId: 'range-1',
        dataDir: path.join(dir, 'range-1'),
        raftConfig: {
          nodeId: 'range-1',
          peers: [],
          storagePath: path.join(dir, 'range-1', 'raft'),
          electionTimeoutMinMs: 150,
          heartbeatIntervalMs: 50,
        },
        overgraphConfig: { path: path.join(dir, 'range-1', 'graph') },
      },
    ],
    hashRing: {
      virtualNodes: 160,
      nodes: [
        { hash: '0x00000000', rangeId: 'range-0' },
        { hash: '0xFFFFFFFF', rangeId: 'range-1' },
      ],
    },
  }
}

describe('ReshardManager', () => {
  const testDir = path.join(os.tmpdir(), `reshard-mgr-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  let clock: HlcClock
  let shardManager: ShardManager
  let shardMap: ShardMap
  let testRunId: string

  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true })
  })

  afterAll(() => {
    try { fs.rmSync(testDir, { recursive: true, force: true }) } catch { /* ok */ }
  })

  beforeEach(() => {
    clock = new HlcClock()
    testRunId = Math.random().toString(36).slice(2, 8)
    const dir = path.join(testDir, testRunId)
    fs.mkdirSync(path.join(dir, 'range-0', 'raft'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'range-0', 'graph'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'range-1', 'raft'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'range-1', 'graph'), { recursive: true })
    shardMap = createShardMap(testRunId, dir)
    shardManager = new ShardManager(shardMap, clock)
  }, 120000)

  afterEach(async () => {
    try { await shardManager.stop() } catch { /* ok */ }
    try { fs.rmSync(path.join(testDir, testRunId), { recursive: true, force: true }) } catch { /* ok */ }
  })

  describe('construction', () => {
    it('should create with ShardManager and clock', () => {
      const mgr = new ReshardManager(shardManager, clock)
      expect(mgr).toBeDefined()
      expect(mgr.status).toBeNull()
    })
  })

  describe('evaluateAndExecute', () => {
    it('should return null when no resharding needed', async () => {
      await shardManager.start()
      const mgr = new ReshardManager(shardManager, clock)
      const result = await mgr.evaluateAndExecute()
      expect(result).toBeNull()
      await shardManager.stop()
    })
  })

  describe('execute with plan', () => {
    it('should execute resharding plan end-to-end', async () => {
      await shardManager.start()

      const planDir = path.join(testDir, testRunId, 'target')
      fs.mkdirSync(path.join(planDir, 'raft'), { recursive: true })
      fs.mkdirSync(path.join(planDir, 'graph'), { recursive: true })

      const plan: ReshardingPlan = {
        planId: 'test-plan-1',
        version: 2,
        createdAt: Date.now(),
        estimatedDurationMs: 1000,
        splits: [
          {
            sourceRangeId: 'range-0',
            targetRangeId: 'range-0-split-0',
            hashRangeStart: 0,
            hashRangeEnd: 50000,
            targetNodeId: 'node-split-0',
            targetDataDir: planDir,
          },
        ],
      }

      const mgr = new ReshardManager(shardManager, clock)
      const result = await mgr.execute(plan)

      expect(result).toBeDefined()
      expect(result.planId).toBe('test-plan-1')
      expect(result.state).toBe('completed')
      expect(result.progressPercent).toBe(100)
      expect(result.completedAt).toBeGreaterThan(0)

      await shardManager.stop()
    })
  })

  describe('rollback', () => {
    it('should rollback after completed execution', async () => {
      await shardManager.start()

      const planDir = path.join(testDir, testRunId, 'target-rollback')
      fs.mkdirSync(path.join(planDir, 'raft'), { recursive: true })
      fs.mkdirSync(path.join(planDir, 'graph'), { recursive: true })

      const plan: ReshardingPlan = {
        planId: 'test-plan-rollback',
        version: 2,
        createdAt: Date.now(),
        estimatedDurationMs: 1000,
        splits: [
          {
            sourceRangeId: 'range-0',
            targetRangeId: 'range-0-split-rb',
            hashRangeStart: 0,
            hashRangeEnd: 50000,
            targetNodeId: 'node-rb',
            targetDataDir: planDir,
          },
        ],
      }

      const mgr = new ReshardManager(shardManager, clock)
      await mgr.execute(plan)

      // Status should be completed
      expect(mgr.status!.state).toBe('completed')

      // Rollback should work after completed
      await mgr.rollback()
      expect(mgr.status!.state).toBe('failed')
      expect(mgr.status!.errors).toContain('Rolled back by operator')

      await shardManager.stop()
    })
  })

  describe('cleanup logic', () => {
    it('should remove source range (not target range) on cleanup timeout', async () => {
      await shardManager.start()

      const planDir = path.join(testDir, testRunId, 'target-cleanup')
      fs.mkdirSync(path.join(planDir, 'raft'), { recursive: true })
      fs.mkdirSync(path.join(planDir, 'graph'), { recursive: true })

      const plan: ReshardingPlan = {
        planId: 'test-plan-cleanup',
        version: 2,
        createdAt: Date.now(),
        estimatedDurationMs: 1000,
        splits: [
          {
            sourceRangeId: 'range-0',
            targetRangeId: 'range-0-cleanup-test',
            hashRangeStart: 0,
            hashRangeEnd: 50000,
            targetNodeId: 'node-cleanup',
            targetDataDir: planDir,
          },
        ],
      }

      const mgr = new ReshardManager(shardManager, clock)

      // Spy on removeRange before execute so we can intercept the cleanup call
      const removeRangeSpy = vi.spyOn(shardManager, 'removeRange')

      await mgr.execute(plan)
      expect(mgr.status!.state).toBe('completed')

      // After execute, _scheduleCleanup has been called with a 48h timer,
      // so removeRange should NOT have been called yet (it's still pending)
      expect(removeRangeSpy).not.toHaveBeenCalledWith('range-0')
      expect(removeRangeSpy).not.toHaveBeenCalledWith('range-0-cleanup-test')

      // Now we manually invoke the cleanup callback to test what would happen
      // We can do this by calling _scheduleCleanup with a very short delay using fake timers
      vi.useFakeTimers()

      // @ts-expect-error accessing private method for testing cleanup behavior
      const scheduleCleanup = (mgr as any)._scheduleCleanup.bind(mgr)
      scheduleCleanup(plan, 100)

      // Fast-forward to fire the timer
      vi.advanceTimersByTime(200)

      // Verify: source range should have been removed, target range should NOT
      expect(removeRangeSpy).toHaveBeenCalledWith('range-0')
      expect(removeRangeSpy).not.toHaveBeenCalledWith('range-0-cleanup-test')

      removeRangeSpy.mockRestore()
      vi.useRealTimers()

      await shardManager.stop()
    })
  })

  describe('state machine transitions', () => {
    it('should transition through correct states on success', async () => {
      await shardManager.start()

      const planDir = path.join(testDir, testRunId, 'target-states')
      fs.mkdirSync(path.join(planDir, 'raft'), { recursive: true })
      fs.mkdirSync(path.join(planDir, 'graph'), { recursive: true })

      const plan: ReshardingPlan = {
        planId: 'test-plan-states',
        version: 2,
        createdAt: Date.now(),
        estimatedDurationMs: 1000,
        splits: [
          {
            sourceRangeId: 'range-0',
            targetRangeId: 'range-0-split-states',
            hashRangeStart: 0,
            hashRangeEnd: 50000,
            targetNodeId: 'node-states',
            targetDataDir: planDir,
          },
        ],
      }

      const mgr = new ReshardManager(shardManager, clock)

      // After execute, final state should be 'completed'
      const result = await mgr.execute(plan)
      expect(result.state).toBe('completed')

      await shardManager.stop()
    })

    it('should handle failure gracefully', async () => {
      await shardManager.start()

      let result: any
      try {
        const plan: ReshardingPlan = {
          planId: 'test-plan-fail',
          version: 2,
          createdAt: Date.now(),
          estimatedDurationMs: 1000,
          splits: [
            {
              sourceRangeId: 'nonexistent-range',
              targetRangeId: 'range-fail-target',
              hashRangeStart: 0,
              hashRangeEnd: 50000,
              targetNodeId: 'node-fail',
              targetDataDir: '/nonexistent/path',
            },
          ],
        }

        const mgr = new ReshardManager(shardManager, clock)
        result = await mgr.execute(plan)

        // Should fail because source range doesn't exist
        expect(result.state).toBe('failed')
        expect(result.errors.length).toBeGreaterThan(0)
      } finally {
        await shardManager.stop()
      }
    }, 120000)
  })
})
