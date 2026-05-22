/**
 * raft-test-utils — Raft 测试共享工具
 *
 * 提供：
 * - createMockEngine(): 创建模拟 GraphEngine（避免依赖原生 OverGraph 模块）
 * - createNodeConfig(): 快速创建 RaftNodeConfig
 * - createClusterWithNodes(): 快速创建带 N 个节点的 RaftCluster
 */
import * as os from 'node:os'
import * as path from 'node:path'
import { GraphEngine } from '../core/graph-engine'
import { HlcClock } from '../replication/hlc-clock'
import { RaftCluster } from './raft-cluster'
import { RaftNodeConfig } from '../types'
import { TimerProvider } from './mock-timer'

/**
 * 创建一个模拟的 GraphEngine
 * GraphEngine 依赖原生 OverGraph 模块，测试时需要 mock
 */
export function createMockEngine(): GraphEngine {
  return {
    constructor: jest.fn(),
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
  } as unknown as GraphEngine
}

/**
 * 创建测试用的 RaftNodeConfig
 */
export function createNodeConfig(
  nodeId: string,
  peerIds: string[] = [],
): RaftNodeConfig {
  return {
    nodeId,
    peers: peerIds.map(id => ({ id, address: `127.0.0.1:0` })),
    storagePath: `:memory:${nodeId}`,
    electionTimeoutMinMs: 100,
    electionTimeoutMaxMs: 200,
    heartbeatIntervalMs: 50,
  }
}

/**
 * 创建一个 RaftCluster（每个节点拥有独立引擎），并添加指定数量的节点
 * 明确设置 CONSENSUS_MODE=standalone 避免网络依赖
 *
 * @param nodeCount 节点数量
 * @param engine （已弃用，保留参数仅为兼容旧调用方）每个节点会自动创建独立引擎
 * @param clock 时钟（可选，默认创建新的 HlcClock）
 * @param timerProvider 计时器提供者（可选，用于测试注入 MockTimer）
 * @param dataDir 数据目录（可选，默认使用临时目录）
 */
export function createClusterWithNodes(
  nodeCount: number,
  engine?: GraphEngine,
  clock?: HlcClock,
  timerProvider?: TimerProvider,
  dataDir?: string,
): RaftCluster {
  const dir = dataDir || path.join(os.tmpdir(), `raft-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const actualClock = clock ?? new HlcClock()
  const cluster = new RaftCluster(dir, actualClock)
  if (timerProvider) cluster.setTimerProvider(timerProvider)

  if (nodeCount > 0) {
    const nodeIds = Array.from({ length: nodeCount }, (_, i) => `node-${i}`)
    for (const nodeId of nodeIds) {
      const peers = nodeIds.filter(id => id !== nodeId)
      cluster.addNode(createNodeConfig(nodeId, peers))
    }
  }

  return cluster
}
