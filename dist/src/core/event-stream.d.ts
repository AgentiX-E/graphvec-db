/**
 * event-stream.ts — EventBus 之上的可靠事件流
 *
 * 在 EventBus（ZeroMQ PUB/SUB）之上增加至少送达一次、去重和离线追赶。
 *
 * 架构：
 *   GraphEngine.emit(event)
 *       │
 *       ▼
 *   EventStream.emit(msg)                ← 用户入口
 *       ├── StreamWal.append(msg)
 *       └── eventBus.emit(event)         ← 原始 EventBus PUB（fire-and-forget）
 *
 *   eventBus.subSocket.receive()
 *       │
 *       ▼
 *   EventStream._onRemoteEvent(evt)
 *       ├── 控制消息（ack / sync / sync-batch）→ 特殊处理
 *       ├── 普通事件 → dedup → eventBus.emit('event:ack', { msgIds })
 *       │              → StreamWal.markConsumed
 *       │              → 回调
 *       └──
 *
 *   后台定时扫描:
 *       ─ readPending → 超时未 ACK 的重发
 *
 *   ACK 通过 EventBus 自身的 `event:ack` 事件类型，不依赖额外 ZeroMQ 连接。
 *   SYNC 请求通过 `event:sync`，回复通过 `event:sync-batch`
 */
import { EventBus } from './event-bus';
import { StreamMessage } from './stream-wal';
/**
 * onStall callback info
 */
export interface StallInfo {
    msgId: string;
    seq: number;
    type: string;
    retries: number;
    durationMs: number;
}
/**
 * 从环境变量自动注册 webhook onStall（默认不启用）
 * 设置 EVENTSTREAM_STALL_WEBHOOK_URL 环境变量即可。
 * 可选：EVENTSTREAM_STALL_THRESHOLD（默认 100）
 */
export declare function webhookOnStall(): ((info: StallInfo) => void) | undefined;
export interface EventStreamConfig {
    nodeId: string;
    eventBus: EventBus;
    walDir: string;
    /**
     * ACK 超时（毫秒）。发送后超过此时间未收到 ACK 即视为需要重试。
     * 默认 5000
     */
    ackTimeoutMs?: number;
    /**
     * 重试间隔（毫秒）。后台扫描间隔。
     * 默认 3000
     */
    retryIntervalMs?: number;
    /**
     * 最大重试次数。超过后放弃（记录 warn）。
     * 默认 10
     */
    maxRetries?: number;
    /**
     * 去重缓存容量。默认 10000
     */
    dedupCapacity?: number;
    /**
     * 追赶批大小。默认 100
     */
    catchupBatchSize?: number;
    /**
     * 存活告警阈值（重试次数）。当某条消息重试次数达到此值时，
     * 触发 onStall 回调。默认 100（约 5 分钟 @ 3s 间隔）
     */
    stallThreshold?: number;
    /**
     * 存活告警回调。当某条消息持续重试超过 stallThreshold 时被调用。
     * 可在此发送报警/通知给运维。
     */
    onStall?: (info: StallInfo) => void;
}
/**
 * 事件回调
 */
export type EventHandler = (msg: StreamMessage) => void;
/**
 * EventStream — 包装 EventBus 的可靠事件流
 */
export declare class EventStream {
    private config;
    private wal;
    private bus;
    private logger;
    private seq;
    private dedup;
    /** 发送 pending 追踪：msgId → { sentAt, retries } */
    private pendingTracker;
    /** 本地事件回调 */
    private handlers;
    /** 后台扫描 timer */
    private scanTimer;
    /** 是否正在运行 */
    private running;
    constructor(config: EventStreamConfig);
    /** 快捷构造 Omit<GraphEvent, 'nodeId'> */
    private _busEvent;
    get isOpen(): boolean;
    /**
     * 打开 StreamWal 并订阅 EventBus
     */
    open(): void;
    /**
     * 关闭 EventStream
     */
    close(): Promise<void>;
    /**
     * 注册事件处理器
     */
    on(type: string, handler: EventHandler): void;
    /**
     * 移除事件处理器
     */
    off(type: string, handler: EventHandler): void;
    /**
     * 发送可靠事件
     *
     * 1. 写入本地 WAL（PENDING 状态）
     * 2. 通过 EventBus 发布
     * 3. 记录 tracking 等待 ACK
     */
    emit(event: {
        type: string;
        data: Record<string, unknown>;
        timestamp?: number;
    }): void;
    /**
     * 请求完整回放（用于新节点加入时的追赶）
     * 发送 event:sync 到所有远程节点
     */
    requestSync(): void;
    private _restoreSeq;
    private _subscribeBus;
    private _onDataEvent;
    private _onControlMessage;
    private _handleSyncRequest;
    private _startScan;
    private _scanPending;
    private _emitLocal;
}
//# sourceMappingURL=event-stream.d.ts.map