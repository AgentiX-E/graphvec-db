/**
 * consensus-factory.ts — Consensus provider factory
 *
 * Create a ConsensusProvider instance based on the config
 * - 'standalone': Single-node mode (dev / test)
 * - 'raft-logic': Production-grade tikv/raft-rs WASM consensus
 * - 'db-cluster': Bridge to db-cluster consensus layer via DbClusterConsensusProvider
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
 * Create a consensus instance (not started — caller must call start())
 */
export function createConsensus(config: ConsensusConfig): ConsensusProvider {
  switch (config.mode) {
    case 'standalone':
      return new StandaloneConsensus(config)

    case 'raft-logic': {
      // Auto-inject mock via config (Test only)
      const consensus = new RaftLogicConsensus(config)
      consensus.init().catch(err => {
        logger.warn('[ConsensusFactory] raft-logic init failed, will retry at start()', { err: (err as Error).message })
      })
      return consensus
    }

    case 'simulated-raft':
      // simulated-raft not implemented yet — fallback to standalone
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
