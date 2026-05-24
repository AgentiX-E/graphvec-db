import { RaftNode } from './raft-node';
import { RaftNodeConfig, RaftStatus } from '../types';
import { GraphEngine } from '../core/graph-engine';
import { HlcClock } from '../replication/hlc-clock';
import { TimerProvider } from './mock-timer';
export interface RaftClusterOptions {
    /** waitForAllStable 默认超时（毫秒），默认 30000 */
    leaderTimeoutMs?: number;
}
export declare class RaftCluster {
    /** 基础数据目录，每个节点在其下创建子目录 */
    private baseDataDir;
    private nodes;
    private configs;
    /** 每个节点拥有独立的 GraphEngine */
    private engines;
    private nodeIds;
    private clock;
    private leaderTimeoutMs;
    private timerProvider?;
    constructor(
    /** 基础数据目录，每个节点在其下创建子目录 */
    baseDataDir: string, clock: HlcClock, options?: RaftClusterOptions);
    /** 设置计时器提供者（用于测试注入 MockTimer） */
    setTimerProvider(tp: TimerProvider): void;
    /** 添加一个 Raft 节点到集群（每个节点创建独立的 GraphEngine） */
    addNode(config: RaftNodeConfig): RaftNode;
    /** 获取指定节点的 GraphEngine */
    getEngine(nodeId: string): GraphEngine | undefined;
    /** 获取节点 */
    getNode(nodeId: string): RaftNode | undefined;
    /** 获取 Leader 节点 */
    getLeader(): RaftNode | undefined;
    /** 启动所有节点 */
    start(): Promise<void>;
    /** 停止所有节点 */
    stop(): Promise<void>;
    /** 获取所有节点状态 */
    getAllStatus(): Map<string, RaftStatus>;
    /**
     * 等待所有节点找到 Leader
     * @param timeout 超时毫秒（可选，默认使用构造时传入的 leaderTimeoutMs 或 30000）
     */
    waitForAllStable(timeout?: number): Promise<void>;
    /** 写入到 Leader */
    write(op: Parameters<RaftNode['write']>[0]): Promise<unknown>;
    /** 获取节点数量 */
    get size(): number;
}
//# sourceMappingURL=raft-cluster.d.ts.map