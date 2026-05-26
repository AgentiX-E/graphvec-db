"use strict";
/**
 * consensus-factory.ts — 共识层工厂
 *
 * 根据配置创建相应的 ConsensusProvider 实例
 * - 'standalone': 单节点模式（开发/测试）
 * - 'raft-logic': 生产级 tikv/raft-rs WASM 共识
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createConsensus = createConsensus;
const standalone_consensus_1 = require("./standalone-consensus");
const raft_logic_consensus_1 = require("./raft-logic-consensus");
const logger_1 = require("../ops/logger");
const logger = new logger_1.Logger('ConsensusFactory');
/**
 * 根据配置创建共识实例（不启动，需返回后调用 start()）
 */
function createConsensus(config) {
    switch (config.mode) {
        case 'standalone':
            return new standalone_consensus_1.StandaloneConsensus(config);
        case 'raft-logic': {
            // 使用 mock? 配置项自动注入（测试用）
            const consensus = new raft_logic_consensus_1.RaftLogicConsensus(config);
            consensus.init().catch(err => {
                logger.warn('[ConsensusFactory] raft-logic init failed, will retry at start()', { err: err.message });
            });
            return consensus;
        }
        case 'simulated-raft':
            // simulated-raft 尚未实现，回退到 standalone
            logger.warn('[ConsensusFactory] simulated-raft not yet implemented, falling back to standalone');
            return new standalone_consensus_1.StandaloneConsensus(config);
        default:
            logger.warn(`[ConsensusFactory] Unknown mode "${config.mode}", falling back to standalone`);
            return new standalone_consensus_1.StandaloneConsensus(config);
    }
}
//# sourceMappingURL=consensus-factory.js.map