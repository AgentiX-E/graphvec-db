/**
 * reshard-worker.spec.ts — ReshardWorker 数据迁移测试
 */

// Need to import types for the mock helper
import { GraphEngine } from '../core/graph-engine'
import { RangeInstance } from '../shard/range-instance'
import { ReshardWorker } from './reshard-worker'
import { ReshardSplit } from '../types'

describe('ReshardWorker', () => {
  let split: ReshardSplit

  beforeEach(() => {
    split = {
      sourceRangeId: 'range-source',
      targetRangeId: 'range-target',
      hashRangeStart: 0,
      hashRangeEnd: 100000,
      targetNodeId: 'node-target',
      targetDataDir: ':memory-target',
    }
  })

  describe('construction', () => {
    it('should create with source and target RangeInstances', () => {
      const sourceRange = createMockRange('range-source', { nodeCount: 0 }) as unknown as RangeInstance
      const targetRange = createMockRange('range-target') as unknown as RangeInstance
      const worker = new ReshardWorker(split, undefined as any, sourceRange, targetRange)
      expect(worker).toBeDefined()
      expect(worker.progress).toBe(0)
      expect(worker.split).toBe(split)
    })

    it('should report split info', () => {
      const sourceRange = createMockRange('range-source') as unknown as RangeInstance
      const targetRange = createMockRange('range-target') as unknown as RangeInstance
      const worker = new ReshardWorker(split, undefined as any, sourceRange, targetRange)
      expect(worker.split.sourceRangeId).toBe('range-source')
      expect(worker.split.targetRangeId).toBe('range-target')
    })
  })

  describe('execute (snapshot migration)', () => {
    it('should progress through phases and reach 100%', async () => {
      const sourceRange = createMockRange('range-source', { nodeCount: 0 }) as unknown as RangeInstance
      const targetRange = createMockRange('range-target') as unknown as RangeInstance

      const worker = new ReshardWorker(split, undefined as any, sourceRange, targetRange)
      expect(worker.progress).toBe(0)

      await worker.execute()
      expect(worker.progress).toBe(100)
    })

    it('should handle execute without error when source has nodes', async () => {
      const nodeCount = 5
      const edgeCount = 3
      const mockTargetState = { nodeCount: 0, edgeCount: 0 }
      const sourceRange = createMockRange('range-source', { nodeCount, edgeCount }) as unknown as RangeInstance
      const targetRange = createMockRange('range-target', {
        nodeCount: 0,
        edgeCount: 0,
        mutableState: mockTargetState,
        snapshotCallback: (data: string) => {
          const parsed = JSON.parse(Buffer.from(data, 'base64').toString())
          mockTargetState.nodeCount = parsed.nodes?.length ?? 0
          mockTargetState.edgeCount = parsed.edges?.length ?? 0
        },
      }) as unknown as RangeInstance

      const worker = new ReshardWorker(split, undefined as any, sourceRange, targetRange)
      await expect(worker.execute()).resolves.toBeUndefined()
    })

    it('should migrate snapshot data and verify node/edge counts match', async () => {
      const nodeCount = 10
      const edgeCount = 5

      // 用 Buffer 存储真实导出的快照数据
      const snapshotBuffer = Buffer.from(
        JSON.stringify({
          nodes: Array.from({ length: nodeCount }, (_, i) => ({
            id: i + 1,
            type: 1,
            name: `node-${i}`,
            props: {},
          })),
          edges: Array.from({ length: edgeCount }, (_, i) => ({
            src: i + 1,
            dst: ((i + 1) % nodeCount) + 1,
            type: 10,
            props: {},
          })),
        })
      )

      // 记录目标 range 接收到的 write 操作
      const targetWrites: any[] = []

      const sourceRange = createMockRange('range-source', {
        nodeCount,
        edgeCount,
        snapshotOverride: snapshotBuffer,
      }) as unknown as RangeInstance

      // 目标 range 使用可变的 nodeCount/edgeCount，模拟 snapshot 写入后的状态更新
      const mockTargetState = { nodeCount: 0, edgeCount: 0 }
      const targetRange = createMockRange('range-target', {
        nodeCount: 0,
        edgeCount: 0,
        mutableState: mockTargetState,
        // 安装 snapshot 后更新统计
        snapshotCallback: (data: string) => {
          const parsed = JSON.parse(Buffer.from(data, 'base64').toString())
          const nCount = parsed.nodes?.length ?? 0
          const eCount = parsed.edges?.length ?? 0
          mockTargetState.nodeCount = nCount
          mockTargetState.edgeCount = eCount
          targetWrites.push({ type: 'install_snapshot', nodeCount: nCount, edgeCount: eCount })
        },
      }) as unknown as RangeInstance

      const worker = new ReshardWorker(split, undefined as any, sourceRange, targetRange)
      await worker.execute()

      expect(worker.progress).toBe(100)
      expect(targetWrites.length).toBeGreaterThanOrEqual(1)
      expect(targetWrites[0].type).toBe('install_snapshot')
      // 校验快照包含了正确的数据量
      expect(targetWrites[0].nodeCount).toBe(nodeCount)
      expect(targetWrites[0].edgeCount).toBe(edgeCount)
    })

    it('should throw on stats mismatch between source and target', async () => {
      const sourceRange = createMockRange('range-source', {
        nodeCount: 10,
        edgeCount: 0,
      }) as unknown as RangeInstance

      const targetRange = createMockRange('range-target', {
        nodeCount: 5, // intentionally mismatched
        edgeCount: 0,
      }) as unknown as RangeInstance

      const worker = new ReshardWorker(split, undefined as any, sourceRange, targetRange)

      // expect execute to throw because node counts don't match
      await expect(worker.execute()).rejects.toThrow(/count mismatch/)
    })
  })

  describe('prepare', () => {
    it('should return true when target range is ready', async () => {
      const sourceRange = createMockRange('range-source', { nodeCount: 100 }) as unknown as RangeInstance
      const targetRange = createMockRange('range-target', { nodeCount: 95 }) as unknown as RangeInstance

      const worker = new ReshardWorker(split, undefined as any, sourceRange, targetRange)

      const ready = await worker.prepare()
      expect(ready).toBe(true)
    })

    it('should return true when node counts match within 10% tolerance', async () => {
      const sourceRange = createMockRange('range-source', { nodeCount: 100 }) as unknown as RangeInstance
      const targetRange = createMockRange('range-target', { nodeCount: 92 }) as unknown as RangeInstance

      const worker = new ReshardWorker(split, undefined as any, sourceRange, targetRange)

      const ready = await worker.prepare()
      expect(ready).toBe(true)
    })

    it('should return false when target is too far behind', async () => {
      const sourceRange = createMockRange('range-source', { nodeCount: 100 }) as unknown as RangeInstance
      const targetRange = createMockRange('range-target', { nodeCount: 5 }) as unknown as RangeInstance

      const worker = new ReshardWorker(split, undefined as any, sourceRange, targetRange)

      const ready = await worker.prepare()
      expect(ready).toBe(false)
    })

    it('should return false when target range throws', async () => {
      const sourceRange = createMockRange('range-source', { nodeCount: 0 }) as unknown as RangeInstance
      const targetRange = createMockRange('range-target', {
        nodeCount: 0,
        throwOnGetStatus: true,
      }) as unknown as RangeInstance

      const worker = new ReshardWorker(split, undefined as any, sourceRange, targetRange)
      const ready = await worker.prepare()
      expect(ready).toBe(false)
    })
  })

  describe('rollback', () => {
    it('should stop target range during rollback', async () => {
      const targetStop = vi.fn().mockResolvedValue(undefined)
      const sourceRange = createMockRange('range-source') as unknown as RangeInstance
      const targetRange = { ...createMockRange('range-target'), stop: targetStop } as unknown as RangeInstance

      const worker = new ReshardWorker(split, undefined as any, sourceRange, targetRange)
      await worker.rollback()
      expect(targetStop).toHaveBeenCalled()
    })
  })
})

// Helper: create mock RangeInstance
function createMockRange(rangeId: string, opts?: {
  nodeCount?: number
  throwOnGetStatus?: boolean
  edgeCount?: number
  snapshotOverride?: Buffer
  snapshotCallback?: (data: string) => void
  mutableState?: { nodeCount: number; edgeCount: number }
}) {
  const nodeCount = opts?.nodeCount ?? 0
  const edgeCount = opts?.edgeCount ?? 0
  const throwOnGetStatus = opts?.throwOnGetStatus ?? false
  const snapshotOverride = opts?.snapshotOverride
  const snapshotCallback = opts?.snapshotCallback
  const mutableState = opts?.mutableState

  // 用于 stats() 的实时值：If any mutableState 则使用它，否则使用初始值
  const getNodeCount = () => mutableState?.nodeCount ?? nodeCount
  const getEdgeCount = () => mutableState?.edgeCount ?? edgeCount

  return {
    config: { rangeId, dataDir: '.', raftConfig: { nodeId: rangeId, peers: [], storagePath: '.' }, overgraphConfig: { path: '.' } },
    raft: { isStarted: false } as unknown as RangeInstance,
    engine: { isOpen: false } as unknown as GraphEngine,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    isDraining: vi.fn().mockReturnValue(false),
    setDraining: vi.fn(),
    write: vi.fn().mockImplementation(async (op: any) => {
      if (op.type === 'install_snapshot' && snapshotCallback) {
        snapshotCallback(op.payload.snapshotData)
      }
    }),
    read: vi.fn().mockImplementation(async (reader: Function) => {
      // 构造 mock 的 GraphEngine-like 对象
      const mockEngine: any = {
        queryPattern: () =>
          Array.from({ length: nodeCount }, (_, i) => ({
            id: i + 1,
            type: 1,
            name: `node-${i}`,
            props: {},
          })),
        neighbors: () => ({
          edges: Array.from({ length: edgeCount }, (_, i) => ({
            src: i + 1,
            dst: (i + 1) % (nodeCount || 1) + 1,
            type: 10,
            props: {},
          })),
          nodes: [],
        }),
        exportSnapshot: () => {
          if (snapshotOverride) return snapshotOverride
          // 默认生成快照 Buffer
          return Buffer.from(
            JSON.stringify({
              nodes: Array.from({ length: nodeCount }, (_, i) => ({
                id: i + 1,
                type: 1,
                name: `node-${i}`,
                props: {},
              })),
              edges: Array.from({ length: edgeCount }, (_, i) => ({
                src: i + 1,
                dst: ((i + 1) % (nodeCount || 1)) + 1,
                type: 10,
                props: {},
              })),
            })
          )
        },
        stats: () => ({
          nodeCount: getNodeCount(),
          edgeCount: getEdgeCount(),
          diskSizeBytes: 100,
        }),
      }
      return reader(mockEngine)
    }),
    getStatus: vi.fn().mockImplementation(function() {
      if (throwOnGetStatus) {
        throw new Error('range not available')
      }
      return {
        raft: { role: 'leader', leaderId: rangeId, term: 1 },
        storage: { nodeCount: getNodeCount(), edgeCount: getEdgeCount(), diskSizeBytes: 100 },
      }
    }),
    isHealthy: vi.fn().mockReturnValue(true),
  }
}
