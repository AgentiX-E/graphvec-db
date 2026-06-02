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
    /**
     * 优化的批量发送接口：items 中携带预序列化的 buffer（TransportMessage JSON Buffer）。
     * 当 serializedCache 命中时使用此接口，跳过 JSON.parse → 重构 → JSON.stringify 的重复开销。
     * fallback到 batchSendFn 或 sendFn。
     */
    batchSendSerializedFn?: (items: Array<{
        msgId: string;
        buffer: Buffer;
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
    batchSize?: number;
    entryTTLDays?: number;
    housekeepingIntervalMs?: number;
    /** 启用 per-peer 分库（OutboxV2）。WorkerPool 多进程架构时零锁竞争。 */
    usePerPeerDb?: boolean;
    eventBus: {
        send: (nodeId: string, msg: any) => Promise<void>;
        batchSend?: (nodeId: string, msgs: any[]) => Promise<void>;
        _recoverDealerByNodeId?: (nodeId: string) => Promise<void>;
        _handleDealerSendError?: (nodeId: string, err: Error) => void;
    };
    logger?: Logger;
}
export declare class Outbox implements IOutbox {
    private db;
    private seqDb;
    private indexDb;
    private index;
    constructor(dbPath: string);
    close(): void;
    add(entry: Omit<OutboxEntry, 'seq'>): number;
    markDeliveredBatch(seqs: number[]): void;
    /**
     * 标记 ACK 已到达（多进程场景：主进程直接写入 LMDB mmap，Worker 立即可见）。
     * 单进程场景 ACK 直接回调到 PerPeerWorker 的 ackTracker，不需要此方法。
     * 但统一接口保证迁移到多进程时零代码改动。
     */
    markAcked(seq: number): void;
    /**
     * 查询指定 seq 的 ACK 是否已到达（多进程场景：Worker 子进程通过 LMDB mmap 读到主进程写入的 ACK）。
     * O(1) 查询——前缀键定位。
     */
    isAcked(seq: number): boolean;
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
export declare class OutboxV2 implements IOutbox {
    private basePath;
    /** peerId → LMDB 环境 */
    private peerDbs;
    /** 全局序列计数器 DB */
    private seqCounterDb;
    /** 已打开的 LMDB 路径集合，共 close */
    private allDbs;
    constructor(dbPath: string);
    close(): void;
    /** 获取或创建 peer 对应的 LMDB 环境 */
    private _getOrOpenPeerDb;
    /** 返回 peer LMDB 目录路径 */
    getPeerDbPath(peerId: string): string;
    /**
     * 通过 seq 找到 peer LMDB → 用于 markDelivered/markAcked 等操作。
     * 遍历所有 peer LMDB 查找（peer 数量有限，O(P) 可接受）。
     * 如果频繁调用可加 peer→seq 缓存，但当前场景不需要。
     */
    private _findPeerDbBySeq;
    /** 生成全局唯一递增 seq */
    private _nextSeq;
    add(entry: Omit<OutboxEntry, 'seq'>): number;
    markDeliveredBatch(seqs: number[]): void;
    fetchPendingByPeer(peerId: string): OutboxEntry[];
    fetchOldestPending(peerId: string): OutboxEntry | null;
    getPendingCountForPeer(peerId: string): number;
    markAcked(seq: number): void;
    isAcked(seq: number): boolean;
    markPending(seq: number): void;
    cleanDeliveredBefore(cutoffMs: number): number;
    getPendingCount(): number;
}
export interface IOutbox {
    add(entry: Omit<OutboxEntry, 'seq'>): number;
    markDeliveredBatch(seqs: number[]): void;
    fetchPendingByPeer(peerId: string): OutboxEntry[];
    fetchOldestPending(peerId: string): OutboxEntry | null;
    getPendingCountForPeer(peerId: string): number;
    markAcked(seq: number): void;
    isAcked(seq: number): boolean;
    markPending(seq: number): void;
    cleanDeliveredBefore(cutoffMs: number): number;
    getPendingCount(): number;
    close(): void;
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
    /**
     * 序列化缓存：msgId → Buffer（预序列化的 TransportMessage）。
     * 在 Phase 2 加载 pending 时构建，Phase 5 发送后清除。
     * 避免每条消息在每个 peer 上分别 JSON.parse → 重构 → JSON.stringify 的重复开销。
     */
    private serializedCache;
    /** 记录每次成功发送的时间戳（按 peerId） */
    private lastSuccessfulSend;
    /** 最近一次失败的时间戳 */
    private lastFailedMs;
    /** R9: 分区冻结 — 不在 majority 时暂停发送 */
    private _frozen;
    private log;
    constructor(peerId: string, config: PerPeerConfig, outbox: IOutbox);
    /**
     * 检查指定 peer 的 DEALER 连接是否已就绪。
     *
     * 策略：
     * - 如果该 peer 在最近 30s 内有成功发送 → 跳过探针，直接认为就绪
     * - 否则检查 .pub 文件是否存在 → 存在即视为就绪
     */
    isPeerReady(probePeerId: string): boolean;
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
    /** R9: 设置 frozen 状态 — 不在 majority 时暂停发送 */
    setFrozen(frozen: boolean): void;
    /**
     * 外部通知收到该 peer 的 ACK（同进程/单进程场景）。
      this.ackTracker.delete(msgId)
      if (this.ackTracker.size === 0) {
        // 所有待 ACK 都收到 → 退出退避
        this.inBackoff = false
        this.lastSendMs = 0
      }
    }
  
    /** 推送一条哨兵消息触发重试（deliveryCheck 使用） */
    pushSentinel(): void;
    /** 获取当前 pending 数量 */
    getPendingCount(): number;
    /** Worker 是否正在运行 */
    get isRunning(): boolean;
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
    /** NAS curve 目录路径（用于 Worker 动态发现） */
    private curveDir;
    /** R9: 分区冻结标志 — 不在 majority 时暂停所有出站发送 */
    private _frozen;
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
    /**
     * Worker 动态发现：扫描 curveDir 中的 *.pub 文件，
     * 为新增 peer 创建 Worker，清理已消失 peer 的 Worker 记录。
     */
    discoverPeers(): void;
    private _isWorkerRunning;
    private _restartWorker;
    /** 获取指定 peer 的 Worker 实例（用于测试） */
    getWorker(peerId: string): PerPeerWorker | undefined;
    /** 通知指定 peer 的 Worker 已连接 */
    notifyConnected(peerId: string): void;
    /** 通知指定 peer 的 Worker 收到 ACK */
    notifyAcked(peerId: string): void;
    /** R9: 设置 frozen 状态 — 暂停/恢复所有 PerPeerWorker 的出站发送 */
    setFrozen(frozen: boolean): void;
    /**
     * R9: 设置 majority 状态，同步反映为 Outbox frozen/unfrozen
     * true = in majority → unfrozen（正常发送）
     * false = not in majority → frozen（暂停发送，防止幽灵消息）
     */
    setMajorityStatus(inMajority: boolean): void;
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