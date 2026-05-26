/**
 * outbox-replication.ts — EventBus Outbox: PerPeerWorker 池
 *
 * 每个 peer 一个独立的 PerPeerWorker（setTimeout loop），互不阻塞。
 * 三级 pending 优先级队列：Critical（重试≥3次/超时）→ Normal → Stale（兜底）。
 * ackTracker 超时重传 + LinearBackoff + recoverDealerFn 重建 DEALER。
 *
 * 设计文档 docs/EventBus_WorkerPool_设计方案.md
 */
import { Logger } from '../ops/logger';
export interface OutboxEntry {
    seq: number;
    msgId: string;
    targetNodeId: string;
    type: string;
    payload: string;
    createdAt: number;
    delivered: boolean;
    deliveredAt: number;
}
export interface OutboxPeerConfig {
    nodeId: string;
    addr: string;
}
/** PerPeerWorker 配置 */
interface PerPeerConfig {
    peerId: string;
    tickMs: number;
    maxBackoffMs: number;
    ackTimeoutMs: number;
    batchSize?: number;
    curveDir: string;
    sendFn: (msgId: string, payload: Buffer) => Promise<void>;
    batchSendFn?: (items: Array<{
        msgId: string;
        payload: Buffer;
    }>) => Promise<void>;
    recoverDealerFn: () => Promise<void>;
    logger?: Logger;
}
export interface OutboxConfig {
    nodeId: string;
    peers: OutboxPeerConfig[];
    curveDir: string;
    dbPath?: string;
    tickMs?: number;
    maxBackoffSeconds?: number;
    entryTTLDays?: number;
    housekeepingIntervalMs?: number;
    curveKeyPair?: {
        publicKey: string;
        secretKey: string;
    };
    sendFn: (peerId: string, msgId: string, payload: Buffer) => Promise<void>;
    recoverDealerFn: (peerId: string) => Promise<void>;
    logger?: Logger;
}
export interface OutboxReplicationConfig {
    nodeId: string;
    peers: Array<{
        nodeId: string;
        addr: string;
    }>;
    curveDir: string;
    dbPath?: string;
    tickMs?: number;
    maxBackoffSeconds?: number;
    entryTTLDays?: number;
    housekeepingIntervalMs?: number;
    eventBus: {
        send: (nodeId: string, msg: any) => Promise<void>;
        batchSend?: (nodeId: string, msgs: any[]) => Promise<void>;
        _recoverDealerByNodeId?: (nodeId: string) => Promise<void>;
        _handleDealerSendError?: (nodeId: string, err: Error) => void;
    };
    logger?: Logger;
}
export declare class Outbox {
    private db;
    private seqDb;
    private indexDb;
    private index;
    constructor(dbPath: string);
    close(): void;
    add(entry: Omit<OutboxEntry, 'seq'>): number;
    markDeliveredBatch(seqs: number[]): void;
    markPending(seq: number): void;
    fetchOldestPending(peerId: string): OutboxEntry | null;
    /** 取指定 peer 的所有 pending 消息（按 seq 升序）— 使用索引，O(K) */
    fetchPendingByPeer(peerId: string): OutboxEntry[];
    getPendingCountForPeer(peerId: string): number;
    cleanDeliveredBefore(cutoffMs: number): number;
    getPendingCount(): number;
    /** 确保索引已建立 */
    private _ensureIndex;
}
export declare class PerPeerWorker {
    private peerId;
    private config;
    private outbox;
    private running;
    private workerTimer;
    /** pending 消息队列：优先级分级 */
    private criticalQueue;
    private normalQueue;
    /** ack 追踪：msgId → sentAt */
    private ackTracker;
    /** 上次发送时间（退避用） */
    private lastSendMs;
    /** 当前退避状态 */
    private inBackoff;
    private log;
    constructor(peerId: string, config: PerPeerConfig, outbox: Outbox);
    /** 热加载 getter */
    private get _tickMs();
    private get _maxBackoffMs();
    private get _ackTimeoutMs();
    /** 每批最多发送条数（默认 100，可热加载） */
    private get _batchSize();
    start(): void;
    stop(): void;
    /** 外部通知该 peer 已连接可用 */
    notifyConnected(): void;
    /** 外部通知收到该 peer 的 ACK */
    notifyAcked(msgId: string): void;
    /** 推送一条哨兵消息触发重试（deliveryCheck 使用） */
    pushSentinel(): void;
    /** 获取当前 pending 数量 */
    getPendingCount(): number;
    private _tick;
    private _readPeerPubKey;
    /** 获取当前状态统计（用于 reportConfig） */
    getStats(): {
        critical: number;
        normal: number;
        ackPending: number;
        inBackoff: boolean;
    };
}
export declare class OutboxReplicationManager {
    private config;
    private outbox;
    /** peerId → PerPeerWorker */
    private workerMap;
    private housekeepingTimer;
    private deliveryCheckTimer;
    private reloadTimer;
    private configFilePath;
    private log;
    constructor(config: OutboxReplicationConfig);
    get dbPath(): string;
    get configFile(): string | null;
    loadConfigFile(): void;
    saveConfigFile(): void;
    getConfig(): Readonly<OutboxReplicationConfig>;
    updateConfig(partial: Partial<Pick<OutboxReplicationConfig, 'tickMs' | 'maxBackoffSeconds' | 'housekeepingIntervalMs' | 'entryTTLDays'>>): void;
    private _restartHousekeeping;
    addMessage(type: string, data: Record<string, unknown>): void;
    /** 创建/重建指定 peer 的 PerPeerWorker */
    private _ensureWorker;
    start(): void;
    stop(): void;
    private _deleteMyPubKey;
    registerShutdownHook(): void;
    /** DeliveryCheck：定时检查所有 peer 的 pending 状态，推送哨兵消息 */
    private _deliveryCheckPeers;
    private _isWorkerRunning;
    private _restartWorker;
    /** 通知指定 peer 的 Worker 已连接 */
    notifyConnected(peerId: string): void;
    /** 通知指定 peer 的 Worker 收到 ACK */
    notifyAcked(peerId: string): void;
    getStats(): {
        sendTrack: number;
        backoffTrack: number;
        pending: number;
    };
    /** 获取每个 peer 的详细报告（reportConfig 回调用） */
    getPeerReports(): Array<{
        peerId: string;
        stats: ReturnType<PerPeerWorker['getStats']> | null;
    }>;
}
export {};
//# sourceMappingURL=outbox-replication.d.ts.map