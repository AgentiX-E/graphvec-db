import { RaftNode } from '../consensus/raft-node'
import { MockTransport } from '../consensus/transport'
import { GraphEngine } from '../core/graph-engine'
import { HlcClock } from '../replication/hlc-clock'
import { RangeConfig, RaftOperation } from '../types'

/**
 * RangeInstance — 单个分片的完整封装
 *
 * 一个 RangeInstance = 一个 Raft 组 + 一个 OverGraph 实例
 * 数据独立性通过 OverGraph 的独立文件目录保证
 */
export class RangeInstance {
  readonly config: RangeConfig
  readonly raft: RaftNode
  readonly engine: GraphEngine

  constructor(config: RangeConfig, clock: HlcClock, transport?: import('../consensus/transport').Transport) {
    this.config = config
    this.engine = new GraphEngine(config.overgraphConfig)
    this.raft = new RaftNode(config.raftConfig, this.engine, clock, undefined, transport)
  }

  async start(): Promise<void> {
    await this.raft.start()
  }

  async stop(): Promise<void> {
    await this.raft.stop()
  }

  /** 通过 Raft 写入 */
  async write(op: Omit<RaftOperation, 'id'>): Promise<unknown> {
    return this.raft.write(op)
  }

  /** 线性一致读 */
  async read<T>(reader: (engine: GraphEngine) => T): Promise<T> {
    return this.raft.read(reader)
  }

  /** 获取状态 */
  getStatus() {
    return {
      raft: this.raft.getStatus(),
      storage: this.engine.stats(),
    }
  }

  /** 检查范围是否健康 */
  isHealthy(): boolean {
    // RaftCore 单节点无 peer，无选举，role='follower' 且 leaderId=null
    // isStarted 说明 Raft 已启动，engine.isOpen 说明数据层可用
    return this.raft.isStarted && this.engine.isOpen
  }
}
