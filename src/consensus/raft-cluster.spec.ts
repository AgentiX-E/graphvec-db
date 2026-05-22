/**
 * RaftCluster spec
 *
 * 测试策略：
 * RaftNode 不再支持 CONSENSUS_MODE 环境变量切换共识模式。
 * 所有实例固定使用 RaftCore + MockTransport。
 * 测试在网络发现阶段通过 waitForAllStable 等待 leader 选举完成。
 *
 * 注意：MockTransport 使用进程内全局注册表，测试间通过 MockTransport.reset() 隔离。
 */
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { RaftCluster } from './raft-cluster'
import { GraphEngine } from '../core/graph-engine'
import { HlcClock } from '../replication/hlc-clock'
import { MockTransport } from './transport'
import { createMockEngine, createNodeConfig, createClusterWithNodes } from './raft-test-utils'

// Mock GraphEngine at module level — OverGraph is a native module
jest.mock('../core/graph-engine', () => {
  return {
    GraphEngine: jest.fn().mockImplementation(() => ({
      open: jest.fn(),
      close: jest.fn(),
      upsertNode: jest.fn().mockReturnValue(BigInt(1)),
      upsertEdge: jest.fn(),
      deleteNode: jest.fn(),
      deleteEdge: jest.fn(),
      batchUpsertNodes: jest.fn().mockReturnValue([]),
      queryPattern: jest.fn().mockReturnValue([]),
      neighbors: jest.fn().mockReturnValue({ edges: [], nodes: [] }),
      getNode: jest.fn(),
      getEdge: jest.fn(),
      stats: jest.fn().mockReturnValue({ nodeCount: 0, edgeCount: 0, diskSizeBytes: 0 }),
      compact: jest.fn(),
      isOpen: false,
    })),
  }
})

/** 创建临时数据目录 */
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'raft-cluster-test-'))
}

describe('RaftCluster', () => {
  let clock: HlcClock

  beforeEach(() => {
    clock = new HlcClock()
  })

  afterEach(() => {
    MockTransport.reset()
  })

  describe('construction and basic operations', () => {
    test('should create cluster with 3 nodes', () => {
      const cluster = createClusterWithNodes(3, undefined, clock)
      expect(cluster).toBeInstanceOf(RaftCluster)
      expect(cluster.size).toBe(3)
    })

    test('should create empty cluster', () => {
      const cluster = new RaftCluster(tmpDir(), clock)
      expect(cluster.size).toBe(0)
    })

    test('should handle empty node list without error', () => {
      const cluster = new RaftCluster(tmpDir(), clock)
      // These operations should not throw on empty cluster
      expect(() => cluster.getAllStatus()).not.toThrow()
      expect(() => cluster.getLeader()).not.toThrow()
      expect(() => cluster.getNode('nonexistent')).not.toThrow()
    })

    test('should add and retrieve individual nodes', () => {
      const cluster = new RaftCluster(tmpDir(), clock)

      const config1 = createNodeConfig('node-A', ['node-B'])
      const config2 = createNodeConfig('node-B', ['node-A'])

      const node1 = cluster.addNode(config1)
      const node2 = cluster.addNode(config2)

      expect(node1).toBeDefined()
      expect(node2).toBeDefined()
      expect(cluster.size).toBe(2)

      // Retrieve by ID
      expect(cluster.getNode('node-A')).toBe(node1)
      expect(cluster.getNode('node-B')).toBe(node2)
      expect(cluster.getNode('nonexistent')).toBeUndefined()
    })

    test('should replace node when adding duplicate nodeId', () => {
      const cluster = new RaftCluster(tmpDir(), clock)

      const config1 = createNodeConfig('node-1', [])
      const config2 = createNodeConfig('node-1', [])

      const node1 = cluster.addNode(config1)
      const node2 = cluster.addNode(config2)

      expect(cluster.size).toBe(1) // replaced
      expect(cluster.getNode('node-1')).toBe(node2) // last one wins
      expect(cluster.getNode('node-1')).not.toBe(node1)
    })
  })

  describe('start and stop', () => {
    afterEach(async () => {
      MockTransport.reset()
    })

    test('should start all nodes (follower before election)', async () => {
      const cluster = createClusterWithNodes(3, undefined, clock)
      await cluster.start()

      const statuses = cluster.getAllStatus()
      expect(statuses.size).toBe(3)
      for (const [_, status] of statuses) {
        // RaftCore starts as follower; election happens asynchronously
        expect(['follower', 'candidate', 'leader']).toContain(status.role)
      }

      await cluster.stop()
    })

    test('should start empty cluster without error', async () => {
      const cluster = new RaftCluster(tmpDir(), clock)
      await expect(cluster.start()).resolves.toBeUndefined()
    })

    test('should stop all nodes', async () => {
      const cluster = createClusterWithNodes(3, undefined, clock)
      await cluster.start()
      await cluster.stop()
      await cluster.stop()
    })

    test('should stop empty cluster without error', async () => {
      const cluster = new RaftCluster(tmpDir(), clock)
      await expect(cluster.stop()).resolves.toBeUndefined()
    })

    test('should stop idle cluster (never started)', async () => {
      const cluster = createClusterWithNodes(2, undefined, clock)
      await expect(cluster.stop()).resolves.toBeUndefined()
    })

    test('should handle start/stop cycle', async () => {
      const cluster = createClusterWithNodes(2, undefined, clock)
      await cluster.start()
      await cluster.stop()
      await cluster.start()
      await cluster.stop()
      // Should cycle without error
      expect(cluster.size).toBe(2)
    })
  })

  describe('leader election', () => {
    let cluster: RaftCluster | null = null

    afterEach(async () => {
      if (cluster) {
        await cluster.stop()
        cluster = null
      }
      MockTransport.reset()
    })

    test('should have undefined leader in empty cluster', () => {
      const c = new RaftCluster(tmpDir(), clock)
      expect(c.getLeader()).toBeUndefined()
    })

    test('should have undefined leader before start', () => {
      const c = createClusterWithNodes(3, undefined, clock)
      expect(c.getLeader()).toBeUndefined()
    })

    test('should elect a leader after start', async () => {
      cluster = createClusterWithNodes(3, undefined, clock)
      await cluster.start()

      // Wait for election to complete
      await cluster.waitForAllStable(5000)

      const leader = cluster.getLeader()
      expect(leader).toBeDefined()
      const status = leader!.getStatus()
      expect(status.role).toBe('leader')
      expect(status.leaderId).toBe(leader!.getStatus().leaderId)
    }, 15000)

    test('should not write after stop', async () => {
      cluster = createClusterWithNodes(3, undefined, clock)
      await cluster.start()
      await cluster.waitForAllStable(5000)
      await cluster.stop()

      // After stop, propose returns { ok: false } — writes should fail
      await expect(
        cluster.write({ type: 'admin', payload: { command: 'barrier' } }),
      ).rejects.toThrow()
    }, 15000)

    test('should write to leader after stable election', async () => {
      cluster = createClusterWithNodes(3, undefined, clock)
      await cluster.start()
      await cluster.waitForAllStable(5000)

      const leader = cluster.getLeader()
      expect(leader).toBeDefined()

      await expect(
        cluster.write({ type: 'admin', payload: { command: 'barrier' } }),
      ).resolves.toBeUndefined()
    }, 15000)

    test('should throw on write before start', async () => {
      const cluster = createClusterWithNodes(3, undefined, clock)
      await expect(
        cluster.write({ type: 'admin', payload: {} }),
      ).rejects.toThrow(/No Raft leader/)
    })

    test('should throw on write for empty cluster', async () => {
      const cluster = new RaftCluster(tmpDir(), clock)
      await expect(
        cluster.write({ type: 'admin', payload: {} }),
      ).rejects.toThrow(/No Raft leader/)
    })

    test('should handle single node cluster', async () => {
      const cluster = createClusterWithNodes(1, undefined, clock)
      await cluster.start()
      // Single node: it should elect itself as leader
      await cluster.waitForAllStable(5000)
      const leader = cluster.getLeader()
      expect(leader).toBeDefined()
      expect(leader!.getStatus().role).toBe('leader')
      await cluster.stop()
    }, 10000)
  })

  describe('getAllStatus', () => {
    test('should return all node statuses', () => {
      const cluster = createClusterWithNodes(3, undefined, clock)

      const statuses = cluster.getAllStatus()
      expect(statuses.size).toBe(3)

      const ids = Array.from(statuses.keys())
      expect(ids).toContain('node-0')
      expect(ids).toContain('node-1')
      expect(ids).toContain('node-2')
    })

    test('should return empty map for empty cluster', () => {
      const cluster = new RaftCluster(tmpDir(), clock)
      const statuses = cluster.getAllStatus()
      expect(statuses.size).toBe(0)
    })

    test('should include committed/applied fields', () => {
      const cluster = createClusterWithNodes(1, undefined, clock)
      const statuses = cluster.getAllStatus()
      const status = statuses.get('node-0')!
      expect(status).toHaveProperty('committed')
      expect(status).toHaveProperty('applied')
      expect(status).toHaveProperty('term')
      expect(status).toHaveProperty('role')
      expect(status).toHaveProperty('leaderId')
    })
  })

  describe('edge cases', () => {
    test('should handle 5 node cluster', async () => {
      const cluster = createClusterWithNodes(5, undefined, clock)
      expect(cluster.size).toBe(5)
      await cluster.start()
      await cluster.stop()
    })

    test('should handle 7 node cluster', async () => {
      const cluster = createClusterWithNodes(7, undefined, clock)
      expect(cluster.size).toBe(7)
      await cluster.start()
      const statuses = cluster.getAllStatus()
      expect(statuses.size).toBe(7)
      await cluster.stop()
    })
  })

  describe('waitForAllStable', () => {
    test('should timeout on empty cluster', async () => {
      const cluster = new RaftCluster(tmpDir(), clock)
      // No nodes — no leader possible
      await expect(cluster.waitForAllStable(200)).rejects.toThrow(/failed to elect/)
    })

    test('should timeout with unstarted cluster', async () => {
      const cluster = createClusterWithNodes(3, undefined, clock)
      // Not started — no leader possible
      await expect(cluster.waitForAllStable(300)).rejects.toThrow(/failed to elect/)
    }, 5000)
  })
})
