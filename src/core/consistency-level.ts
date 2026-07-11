/**
 * consistency-level.ts — 一致性级别可配置
 *
 * 支持三种级别：
 * - STRONG  （强一致性）：通过 Raft readIndex 或 barrier 保证线性一致读
 * - EVENTUAL（最终一致性）：直接读取本地存储，不等待任何同步
 * - CAUSAL  （因果一致性）：使用 HLC 时钟确保前序写入可见
 *
 * 集成方式：
 *   将 ConsistencyLevel 传入 SafeReader 或 GraphEngine 的读操作，
 *   其根据级别选择不同的读路径。
 *
 * 用法：
 *   const reader = new SafeReader(provider, { level: ConsistencyLevel.STRONG })
 *   const result = await reader.consistentRead(() => storage.getNode(id))
 *
 *   或运行时切换：
 *   reader.setLevel(ConsistencyLevel.EVENTUAL)
 *   const data = await reader.read(() => storage.getNode(id))
 */

import type { HlcClock } from '../replication/hlc-clock'

/** 一致性级别枚举 */
export enum ConsistencyLevel {
  /** 强一致：通过 Raft readIndex / barrier 保证线性一致 */
  STRONG = 'STRONG',
  /** 最终一致：直接读取，不做同步 */
  EVENTUAL = 'EVENTUAL',
  /** 因果一致：通过 HLC 时钟Trace因果 */
  CAUSAL = 'CAUSAL',
}

/** 一致性级别配置 */
export interface ConsistencyConfig {
  /** 默认一致性级别 */
  level: ConsistencyLevel
  /** HLC 时钟实例（因果一致时需要） */
  hlcClock?: HlcClock
}

/**
 * 默认一致性配置：文件级 singleton
 */
let _defaultConfig: ConsistencyConfig = {
  level: ConsistencyLevel.STRONG,
}

/**
 * 设置全局默认一致性级别。
 *
 * @param config 一致性配置
 */
export function setDefaultConsistency(config: Partial<ConsistencyConfig>): void {
  _defaultConfig = {
    ..._defaultConfig,
    ...config,
  }
}

/**
 * 获取全局默认一致性级别。
 */
export function getDefaultConsistency(): ConsistencyConfig {
  return { ..._defaultConfig }
}

/**
 * 一致性级别标签（用于日志、监控等）。
 *
 * @param level 一致性级别
 * @returns 人类可读的标签
 */
export function consistencyLabel(level: ConsistencyLevel): string {
  switch (level) {
    case ConsistencyLevel.STRONG:
      return 'Strong'
    case ConsistencyLevel.EVENTUAL:
      return 'Eventual'
    case ConsistencyLevel.CAUSAL:
      return 'Causal'
  }
}
