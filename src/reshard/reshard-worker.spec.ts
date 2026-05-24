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

  describe('execute', () => {
    it('should progress through phases and reach 100%', async () => {
      const sourceRange = createMockRange('range-source', { nodeCount: 0 }) as unknown as RangeInstance
      const targetRange = createMockRange('range-target') as unknown as RangeInstance

      const worker = new ReshardWorker(split, undefined as any, sourceRange, targetRange)
      expect(worker.progress).toBe(0)

      await worker.execute()

      // Should reach 100% progress
      expect(worker.progress).toBe(100)
    })

    it('should handle execute without error when source has nodes', async () => {
      const sourceRange = createMockRange('range-source', { nodeCount: 5 }) as unknown as RangeInstance
      const targetRange = createMockRange('range-target') as unknown as RangeInstance

      const worker = new ReshardWorker(split, undefined as any, sourceRange, targetRange)
      await expect(worker.execute()).resolves.toBeUndefined()
    })
  })

  describe('prepare', () => {
    it('should return true when target range is ready', async () => {
      const sourceRange = createMockRange('range-source', { nodeCount: 100 }) as unknown as RangeInstance
      const targetRange = createMockRange('range-target', { nodeCount: 95 }) as unknown as RangeInstance

      const worker = new ReshardWorker(split, undefined as any, sourceRange, targetRange)
      await worker.execute()

      const ready = await worker.prepare()
      expect(ready).toBe(true)
    })

    it('should return true when node counts match within 10% tolerance', async () => {
      const sourceRange = createMockRange('range-source', { nodeCount: 100 }) as unknown as RangeInstance
      const targetRange = createMockRange('range-target', { nodeCount: 92 }) as unknown as RangeInstance

      const worker = new ReshardWorker(split, undefined as any, sourceRange, targetRange)
      await worker.execute()

      const ready = await worker.prepare()
      expect(ready).toBe(true)
    })

    it('should return false when target is too far behind', async () => {
      const sourceRange = createMockRange('range-source', { nodeCount: 100 }) as unknown as RangeInstance
      const targetRange = createMockRange('range-target', { nodeCount: 5 }) as unknown as RangeInstance

      const worker = new ReshardWorker(split, undefined as any, sourceRange, targetRange)
      await worker.execute()

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
      const targetStop = jest.fn().mockResolvedValue(undefined)
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
}) {
  const nodeCount = opts?.nodeCount ?? 0
  const edgeCount = opts?.edgeCount ?? 0
  const throwOnGetStatus = opts?.throwOnGetStatus ?? false

  return {
    config: { rangeId, dataDir: '.', raftConfig: { nodeId: rangeId, peers: [], storagePath: '.' }, overgraphConfig: { path: '.' } },
    raft: { isStarted: false } as unknown as RangeInstance,
    engine: { isOpen: false } as unknown as GraphEngine,
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    isDraining: jest.fn().mockReturnValue(false),
    setDraining: jest.fn(),
    write: jest.fn().mockResolvedValue(undefined),
    read: jest.fn().mockImplementation(async (reader: Function) => {
      if (nodeCount === 0) {
        return reader({ queryPattern: () => [], neighbors: () => ({ edges: [] }) })
      }
      const nodes = Array.from({ length: nodeCount }, (_, i) => ({
        id: i + 1,
        type: 1,
        name: `node-${i}`,
        props: {},
      }))
      return reader({
        queryPattern: () => nodes,
        neighbors: () => ({
          edges: Array.from({ length: edgeCount }, (_, i) => ({
            src: i + 1,
            dst: (i + 1) % nodeCount + 1,
            type: 10,
            props: {},
          })),
          nodes,
        }),
      })
    }),
    getStatus: jest.fn().mockImplementation(() => {
      if (throwOnGetStatus) {
        throw new Error('range not available')
      }
      return {
        raft: { role: 'leader', leaderId: rangeId, term: 1 },
        storage: { nodeCount, edgeCount, diskSizeBytes: 100 },
      }
    }),
    isHealthy: jest.fn().mockReturnValue(true),
  }
}
