/**
 * consensus-factory.ts — 共识层工厂
 *
 * 根据配置创建相应的 ConsensusProvider 实例
 * - 'standalone': 单节点模式（开发/测试）
 * - 'raft-logic': 生产级 tikv/raft-rs WASM 共识
 */
import { ConsensusProvider, ConsensusConfig } from './consensus-provider';
/**
 * 根据配置创建共识实例（不启动，需返回后调用 start()）
 */
export declare function createConsensus(config: ConsensusConfig): ConsensusProvider;
//# sourceMappingURL=consensus-factory.d.ts.map