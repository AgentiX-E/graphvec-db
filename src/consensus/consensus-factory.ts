/**
 * consensus-factory.ts — 共识层工厂
 *
 * 根据配置创建相应的 ConsensusProvider 实例
 * - 'standalone': 单节点模式（开发/测试）
 * - 'raft-logic': 生产级 tikv/raft-rs WASM 共识
 * - 'db-cluster': 通过 DbClusterConsensusProvider 桥接 db-cluster 共识层
 */

import { ConsensusProvider, ConsensusConfig } from './consensus-provider'
import { StandaloneConsensus } from './standalone-consensus'
import { RaftLogicConsensus } from './raft-logic-consensus'
import { Logger } from '../ops/logger'
import { DbClusterConsensusProvider } from './DbClusterConsensusProvider'
import type { DbClusterIConsensusLayer } from './DbClusterConsensusProvider'

const logger = new Logger('ConsensusFactory')

/**
 * Global registry for the db-cluster IConsensusLayer instance.
 *
 * Set by the application bootstrap before createConsensus('db-cluster') is called.
 * This avoids a hard npm dependency on db-cluster while still allowing the factory
 * to wire everything up at runtime.
 */
let _dbClusterInstance: DbClusterIConsensusLayer | null = null

/**
 * Register the db-cluster IConsensusLayer instance for use by
 * 'db-cluster' mode consensus providers.
 *
 * Must be called before createConsensus({ mode: 'db-cluster', ... }).
 */
export function registerDbClusterConsensus(instance: DbClusterIConsensusLayer): void {
  _dbClusterInstance = instance
  logger.info('[ConsensusFactory] db-cluster consensus instance registered')
}

/**
 * Check whether a db-cluster consensus instance has been registered.
 */
export function isDbClusterConsensusRegistered(): boolean {
  return _dbClusterInstance !== null
}

/**
 * Get the registered db-cluster consensus instance.
 * Throws if not registered.
 */
export function getDbClusterConsensus(): DbClusterIConsensusLayer {
  if (!_dbClusterInstance) {
    throw new Error(
      'db-cluster consensus not registered. Call registerDbClusterConsensus() first.',
    )
  }
  return _dbClusterInstance
}

/**
 * Clear the registered db-cluster consensus instance (for testing).
 */
export function clearDbClusterConsensus(): void {
  _dbClusterInstance = null
}

/**
 * 根据配置创建共识实例（不启动，需返回后调用 start()）
 */
export function createConsensus(config: ConsensusConfig): ConsensusProvider {
  switch (config.mode) {
    case 'standalone':
      return new StandaloneConsensus(config)

    case 'raft-logic': {
      // 使用 mock? 配置项自动注入（测试用）
      const consensus = new RaftLogicConsensus(config)
      consensus.init().catch(err => {
        logger.warn('[ConsensusFactory] raft-logic init failed, will retry at start()', { err: (err as Error).message })
      })
      return consensus
    }

    case 'simulated-raft':
      // simulated-raft 尚未实现，回退到 standalone
      logger.warn('[ConsensusFactory] simulated-raft not yet implemented, falling back to standalone')
      return new StandaloneConsensus(config)

    case 'db-cluster': {
      const cluster = getDbClusterConsensus()
      return new DbClusterConsensusProvider(cluster, config)
    }

    default:
      logger.warn(`[ConsensusFactory] Unknown mode "${(config as any).mode}", falling back to standalone`)
      return new StandaloneConsensus(config)
  }
}
