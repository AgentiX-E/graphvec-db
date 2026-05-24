import { GraphEngine } from '../core/graph-engine';
import { HlcClock } from '../replication/hlc-clock';
import { RaftCluster } from './raft-cluster';
import { RaftNodeConfig } from '../types';
import { TimerProvider } from './mock-timer';
/**
 * 创建一个模拟的 GraphEngine
 * GraphEngine 依赖原生 OverGraph 模块，测试时需要 mock
 */
export declare function createMockEngine(): GraphEngine;
/**
 * 创建测试用的 RaftNodeConfig
 */
export declare function createNodeConfig(nodeId: string, peerIds?: string[], instanceId?: string): RaftNodeConfig;
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
export declare function createClusterWithNodes(nodeCount: number, engine?: GraphEngine, clock?: HlcClock, timerProvider?: TimerProvider, dataDir?: string): RaftCluster;
//# sourceMappingURL=raft-test-utils.d.ts.map