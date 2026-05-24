/**
 * consensus-factory.ts — 共识层工厂
 *
 * 根据配置创建相应的 ConsensusProvider 实例
 * - 'standalone': 单节点模式（开发/测试）
 * - 'raft-logic': 生产级 tikv/raft-rs WASM 共识
 */

import { ConsensusProvider, ConsensusConfig } from './consensus-provider'
import { StandaloneConsensus } from './standalone-consensus'
import { RaftLogicConsensus } from './raft-logic-consensus'
import { Logger } from '../ops/logger'

const logger = new Logger('ConsensusFactory')

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

    default:
      logger.warn(`[ConsensusFactory] Unknown mode "${(config as any).mode}", falling back to standalone`)
      return new StandaloneConsensus(config)
  }
}
