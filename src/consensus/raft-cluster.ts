/**
 * RaftCluster — 多节点 Raft 集群管理
 *
 * 管理同一 Range 内的多个 RaftNode 实例
 * 每个节点拥有独立的 GraphEngine 实例（独立的 dataDir）
 * 支持 1/3/5 节点配置
 */
import * as path from 'node:path'
import * as fs from 'node:fs'
import { RaftNode } from './raft-node'
import { RaftNodeConfig, RaftStatus } from '../types'
import { GraphEngine } from '../core/graph-engine'
import { HlcClock } from '../replication/hlc-clock'
import { TimerProvider } from './mock-timer'

export interface RaftClusterOptions {
  /** waitForAllStable 默认超时（毫秒），默认 30000 */
  leaderTimeoutMs?: number
}

export class RaftCluster {
  private nodes: Map<string, RaftNode> = new Map()
  private configs: Map<string, RaftNodeConfig> = new Map()
  /** 每个节点拥有独立的 GraphEngine */
  private engines: Map<string, GraphEngine> = new Map()
  private nodeIds: string[] = []
  private clock: HlcClock
  private leaderTimeoutMs: number
  private timerProvider?: TimerProvider

  constructor(
    /** 基础数据目录，每个节点在其下创建子目录 */
    private baseDataDir: string,
    clock: HlcClock,
    options?: RaftClusterOptions,
  ) {
    // 确保基础目录存在
    fs.mkdirSync(baseDataDir, { recursive: true })
    this.clock = clock
    this.leaderTimeoutMs = options?.leaderTimeoutMs ?? 30000
  }

  /** 设置计时器提供者（用于测试注入 MockTimer） */
  setTimerProvider(tp: TimerProvider): void {
    this.timerProvider = tp
  }

  /** 添加一个 Raft 节点到集群（每个节点创建独立的 GraphEngine） */
  addNode(config: RaftNodeConfig): RaftNode {
    // 为每个节点创建独立的 GraphEngine
    const nodeDataDir = path.join(this.baseDataDir, `node-${config.nodeId}`)
    fs.mkdirSync(nodeDataDir, { recursive: true })
    const engine = new GraphEngine({
      path: path.join(nodeDataDir, 'graph.db'),
    })
    this.engines.set(config.nodeId, engine)

    const node = new RaftNode(config, engine, this.clock, this.timerProvider)
    this.nodes.set(config.nodeId, node)
    this.configs.set(config.nodeId, config)
    this.nodeIds.push(config.nodeId)
    return node
  }

  /** 获取指定节点的 GraphEngine */
  getEngine(nodeId: string): GraphEngine | undefined {
    return this.engines.get(nodeId)
  }

  /** 获取节点 */
  getNode(nodeId: string): RaftNode | undefined {
    return this.nodes.get(nodeId)
  }

  /** 获取 Leader 节点 */
  getLeader(): RaftNode | undefined {
    for (const [_, node] of this.nodes) {
      if (node.getStatus().role === 'leader') return node
    }
    return undefined
  }

  /** 启动所有节点 */
  async start(): Promise<void> {
    const promises: Promise<void>[] = []
    for (const [_, node] of this.nodes) {
      promises.push(node.start())
    }
    await Promise.all(promises)
  }

  /** 停止所有节点 */
  async stop(): Promise<void> {
    const promises: Promise<void>[] = []
    for (const [_, node] of this.nodes) {
      promises.push(node.stop())
    }
    await Promise.all(promises)
  }

  /** 获取所有节点状态 */
  getAllStatus(): Map<string, RaftStatus> {
    const result = new Map<string, RaftStatus>()
    for (const [id, node] of this.nodes) {
      result.set(id, node.getStatus())
    }
    return result
  }

  /**
   * 等待所有节点找到 Leader
   * @param timeout 超时毫秒（可选，默认使用构造时传入的 leaderTimeoutMs 或 30000）
   */
  async waitForAllStable(timeout?: number): Promise<void> {
    const effectiveTimeout = timeout ?? this.leaderTimeoutMs
    const sleep = (ms: number): Promise<void> => new Promise(r => {
      if (this.timerProvider) {
        this.timerProvider.setTimeout(r, ms)
      } else {
        setTimeout(r, ms)
      }
    })
    const start = Date.now()
    while (Date.now() - start < effectiveTimeout) {
      const leader = this.getLeader()
      if (leader && leader.getStatus().role === 'leader') {
        // 确认所有节点都启动完毕（followers 不跟踪 leaderId）
        let allUp = true
        for (const [_, node] of this.nodes) {
          if (!node.isStarted) {
            allUp = false
            break
          }
        }
        if (allUp) return
      }
      await sleep(100)
    }
    throw new Error('Raft cluster failed to elect a leader within timeout')
  }

  /** 写入到 Leader */
  async write(op: Parameters<RaftNode['write']>[0]): Promise<unknown> {
    const leader = this.getLeader()
    if (!leader) throw new Error('No Raft leader available')
    return leader.write(op)
  }

  /** 获取节点数量 */
  get size(): number { return this.nodes.size }
}
