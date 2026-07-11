/**
 * simulated-raft.ts — 模拟 Raft 共识（保留为测试辅助）
 *
 * 提供 SimulatedRaftInstanceManager（测试辅助类，管理多个内存 Raft 实例）
 * 提供向后兼容的别名：SimulatedRaftConsensus → RaftCore
 *
 * Note: SimulatedRaftConsensus 已由 RaftCore 替代。
 * 旧的 SimulatedRaftConsensus class 已移除，改为 RaftCore 的别名。
 */
import { RaftCore } from './raft-core'
import type { RaftCoreConfig } from './raft-core'

export { RaftCore as SimulatedRaftConsensus }
export type { RaftCoreConfig as SimulatedRaftConfig }

/**
 * SimulatedRaftInstanceManager — 管理 RaftCore 实例集合
 *
 * 每个测试可以创建独立的 manager，避免全局静态 Map 在 Jest 并行测试时的状态泄漏。
 * 向后兼容：defaultManager 提供旧代码使用的全局实例。
 */
export class SimulatedRaftInstanceManager {
  readonly instances = new Map<string, RaftCore>()

  register(id: string, instance: RaftCore): void {
    this.instances.set(id, instance)
  }

  unregister(id: string): void {
    this.instances.delete(id)
  }

  get(id: string): RaftCore | undefined {
    return this.instances.get(id)
  }

  clear(): void {
    this.instances.clear()
  }

  get size(): number {
    return this.instances.size
  }

  /** 遍历所有实例 */
  [Symbol.iterator](): IterableIterator<[string, RaftCore]> {
    return this.instances[Symbol.iterator]()
  }

  /** 向后兼容：默认全局 manager（旧代码仍可正常工作） */
  static defaultManager = new SimulatedRaftInstanceManager()

  /** 重置集群（测试辅助） */
  static reset(): void {
    SimulatedRaftInstanceManager.defaultManager.clear()
  }
}
