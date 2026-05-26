/**
 * multi-leader-replication.ts — Multi-Leader 同步复制层
 *
 * 在 GraphEngine 的 upsert 路径上加入同步复制：写入本地 storage + WAL 后，
 * 通过 EventStream 广播到同 DC 内所有节点，等待所有节点持久化确认后再返回。
 *
 * 冲突解决：HLC 时间戳 + nodeId 比较（LWW），大者覆盖。
 *
 * 架构：
 *   upsertNode / upsertEdge
 *       │
 *       ▼
 *   MultiLeaderReplication.write()
 *       ├── 1. 写入本地 storage + 内存索引
 *       ├── 2. EventStream.emitSync()（同步等待所有远程节点 ACK）
 *       └── 3. 返回结果（或抛出异常）
 */
import { EventStream } from './event-stream';
import { HlcClock } from '../replication/hlc-clock';
/** Multi-Leader 复制配置 */
export interface MultiLeaderConfig {
    /** 当前节点 ID */
    nodeId: string;
    /** 同 DC 内所有参与 Multi-Leader 的节点 ID（包括自己） */
    peers: string[];
    /** EventStream 实例（需已 open） */
    eventStream: EventStream;
    /** HLC 时钟实例 */
    clock: HlcClock;
    /** emitSync 超时（毫秒），默认 30000 */
    syncTimeoutMs?: number;
}
/** Multi-Leader 复制结果 */
export interface WriteResult {
    success: boolean;
    acksReceived: number;
    expectedAcks: number;
    error?: string;
}
/**
 * Multi-Leader 同步复制层
 *
 * 封装写入同步 + LWW 冲突解决的逻辑
 */
export declare class MultiLeaderReplication {
    private config;
    constructor(config: MultiLeaderConfig);
    /** 当前节点 ID */
    get nodeId(): string;
    /**
     * 同步复制：将变更事件广播到所有 remote 节点并等待 ACK
     *
     * @param type 事件类型（'node:created' | 'node:updated' | 'node:deleted' | 'edge:created'等）
     * @param data 事件数据
     * @returns WriteResult
     * @throws 同步超时异常
     */
    replicate(type: string, data: Record<string, unknown>): Promise<WriteResult>;
}
//# sourceMappingURL=multi-leader-replication.d.ts.map