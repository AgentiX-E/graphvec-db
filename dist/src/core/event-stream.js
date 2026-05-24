"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventStream = void 0;
exports.webhookOnStall = webhookOnStall;
const stream_wal_1 = require("./stream-wal");
const logger_1 = require("../ops/logger");
/**
 * 从环境变量自动注册 webhook onStall（默认不启用）
 * 设置 EVENTSTREAM_STALL_WEBHOOK_URL 环境变量即可。
 * 可选：EVENTSTREAM_STALL_THRESHOLD（默认 100）
 */
function webhookOnStall() {
    const url = process.env.EVENTSTREAM_STALL_WEBHOOK_URL;
    if (!url)
        return undefined;
    // 解析自定义 headers（可选），如：
    // EVENTSTREAM_STALL_WEBHOOK_HEADERS='{"Authorization":"Bearer xxx","X-Custom":"val"}'
    let extraHeaders = {};
    const rawHeaders = process.env.EVENTSTREAM_STALL_WEBHOOK_HEADERS;
    if (rawHeaders) {
        try {
            extraHeaders = JSON.parse(rawHeaders);
        }
        catch {
            // 静默忽略格式错误
        }
    }
    // HTTP Method，默认 POST，支持 PUT / PATCH
    const method = (process.env.EVENTSTREAM_STALL_WEBHOOK_METHOD || 'POST').toUpperCase();
    const headers = {
        'Content-Type': 'application/json',
        ...extraHeaders,
    };
    return (info) => {
        // fire-and-forget
        fetch(url, {
            method,
            headers,
            body: JSON.stringify({
                level: 'WARN',
                source: 'EventStream',
                message: `Event ${info.msgId} stalled after ${info.retries} retries (${info.durationMs}ms)`,
                data: info,
            }),
        }).catch(() => { });
    };
}
/**
 * 事件去重器 — 环形缓冲区实现，O(1) 插入和淘汰
 */
class DedupRing {
    set = new Set();
    order = [];
    capacity;
    constructor(capacity) {
        this.capacity = capacity;
    }
    has(msgId) {
        return this.set.has(msgId);
    }
    add(msgId) {
        if (this.set.has(msgId))
            return;
        if (this.order.length >= this.capacity) {
            const oldest = this.order.shift();
            this.set.delete(oldest);
        }
        this.set.add(msgId);
        this.order.push(msgId);
    }
    get size() {
        return this.set.size;
    }
}
/**
 * EventStream — 包装 EventBus 的可靠事件流
 */
class EventStream {
    config;
    wal;
    bus;
    logger;
    seq = 0;
    dedup;
    /** 发送 pending 追踪：msgId → { sentAt, retries } */
    pendingTracker = new Map();
    /** 本地事件回调 */
    handlers = new Map();
    /** 后台扫描 timer */
    scanTimer = null;
    /** 是否正在运行 */
    running = false;
    constructor(config) {
        this.config = {
            ackTimeoutMs: 5000,
            retryIntervalMs: 3000,
            maxRetries: 10,
            dedupCapacity: 10000,
            catchupBatchSize: 100,
            stallThreshold: 100,
            ...config,
        };
        this.bus = config.eventBus;
        this.wal = new stream_wal_1.StreamWal(config.walDir);
        this.logger = new logger_1.Logger('EventStream');
        this.dedup = new DedupRing(this.config.dedupCapacity);
    }
    /** 快捷构造 Omit<GraphEvent, 'nodeId'> */
    _busEvent(type, data) {
        return { type: type, timestamp: Date.now(), data };
    }
    get isOpen() { return this.wal.isOpen; }
    /**
     * 打开 StreamWal 并订阅 EventBus
     */
    open() {
        if (this.wal.isOpen)
            return;
        this.wal.open();
        this.running = true;
        // 从本地 WAL 恢复 seq
        this._restoreSeq();
        // 订阅 EventBus 所有事件
        this._subscribeBus();
        // 启动扫描
        this._startScan();
    }
    /**
     * 关闭 EventStream
     */
    async close() {
        this.running = false;
        if (this.scanTimer) {
            clearInterval(this.scanTimer);
            this.scanTimer = null;
        }
        this.wal.close();
        this.handlers.clear();
        this.pendingTracker.clear();
    }
    /**
     * 注册事件处理器
     */
    on(type, handler) {
        const list = this.handlers.get(type) || [];
        list.push(handler);
        this.handlers.set(type, list);
    }
    /**
     * 移除事件处理器
     */
    off(type, handler) {
        const list = this.handlers.get(type) || [];
        this.handlers.set(type, list.filter(h => h !== handler));
    }
    /**
     * 发送可靠事件
     *
     * 1. 写入本地 WAL（PENDING 状态）
     * 2. 通过 EventBus 发布
     * 3. 记录 tracking 等待 ACK
     */
    emit(event) {
        if (!this.running) {
            throw new Error('EventStream is not open');
        }
        this.seq++;
        const msg = {
            msgId: `${this.config.nodeId}-${this.seq}`,
            seq: this.seq,
            nodeId: this.config.nodeId,
            timestamp: Date.now(),
            type: event.type,
            data: { ...event.data },
        };
        // 1. 持久化
        this.wal.append(msg);
        // 2. 发布到 EventBus（作为原始 GraphEvent）
        this.bus.emit(this._busEvent('node:created', { __es_msg: msg }));
        // 3. 追踪
        this.pendingTracker.set(msg.msgId, { sentAt: Date.now(), retries: 0 });
        // 4. 本地也触发 handler（同进程订阅者立即收到）
        this._emitLocal(msg);
    }
    /**
     * 请求完整回放（用于新节点加入时的追赶）
     * 发送 event:sync 到所有远程节点
     */
    requestSync() {
        if (!this.running)
            return;
        this.bus.emit(this._busEvent('event:sync', { requester: this.config.nodeId, lastSeq: this.seq }));
    }
    // ── 内部 ─────────────────────────
    _restoreSeq() {
        // 从 WAL 找到最大 seq，并将 PENDING 消息重新加入 pendingTracker
        try {
            const all = this.wal.replay(0);
            for (const msg of all) {
                if (msg.seq > this.seq)
                    this.seq = msg.seq;
            }
            // Crash recovery: 将有 seq 的 PENDING 消息加入 tracker 等待重发
            const pending = this.wal.readPending(Date.now() + 3600000);
            for (const msg of pending) {
                if (!this.pendingTracker.has(msg.msgId)) {
                    this.pendingTracker.set(msg.msgId, { sentAt: 0, retries: 0 });
                }
            }
            if (pending.length > 0) {
                this.logger.info(`EventStream: recovered ${pending.length} pending messages from WAL`);
            }
        }
        catch {
            // 首次运行，WAL 为空
        }
    }
    _subscribeBus() {
        // 订阅所有事件类型
        const controlTypes = new Set(['event:ack', 'event:sync', 'event:sync-batch']);
        // EventBus 不能按类型过滤，我们通过 on 收到所有远程事件后过滤
        // 利用 EventBus 现有的 on 机制
        const types = [
            'node:created', 'node:updated', 'node:deleted',
            'edge:created', 'edge:updated', 'edge:deleted',
            'backup:start', 'backup:complete',
            'graph:cleared',
            'cluster:node-joined', 'cluster:node-left',
            'cluster:leader-changed',
            'event:ack', 'event:sync', 'event:sync-batch',
        ];
        for (const t of types) {
            this.bus.on(t, (evt) => {
                if (evt.nodeId === this.config.nodeId)
                    return; // 跳过自己（Raft leader 场景）
                if (controlTypes.has(evt.type)) {
                    this._onControlMessage(evt);
                    return;
                }
                this._onDataEvent(evt);
            });
        }
    }
    _onDataEvent(evt) {
        const raw = evt.data.__es_msg;
        if (!raw)
            return; // 非 EventStream 消息，忽略（兼容旧版无 EventStream 的事件）
        // 1. 去重
        if (this.dedup.has(raw.msgId))
            return;
        this.dedup.add(raw.msgId);
        // 2. 回传 ACK
        this.bus.emit(this._busEvent('event:ack', { msgId: raw.msgId, nodeId: raw.nodeId }));
        // 3. 标记消费
        this.wal.markConsumed([raw.msgId]);
        // 4. 回调
        this._emitLocal(raw);
    }
    _onControlMessage(evt) {
        switch (evt.type) {
            case 'event:ack': {
                const msgId = evt.data.msgId;
                if (msgId) {
                    this.pendingTracker.delete(msgId);
                    this.wal.acknowledge([msgId]);
                }
                break;
            }
            case 'event:sync': {
                // 收到 SYNC 请求：从 WAL 读取缺失消息，批量回复
                const requester = evt.data.requester;
                const lastSeq = evt.data.lastSeq;
                this._handleSyncRequest(requester, lastSeq);
                break;
            }
            case 'event:sync-batch': {
                // 收到 SYNC 回复：重放接收到的消息
                const msgs = evt.data.msgs;
                if (msgs) {
                    for (const msg of msgs) {
                        if (this.dedup.has(msg.msgId))
                            continue;
                        this.dedup.add(msg.msgId);
                        this._emitLocal(msg);
                        // 追赶来的消息也回传 ACK
                        this.bus.emit(this._busEvent('event:ack', { msgId: msg.msgId, nodeId: msg.nodeId }));
                    }
                }
                break;
            }
        }
    }
    _handleSyncRequest(requester, fromSeq) {
        if (requester === this.config.nodeId)
            return;
        const msgs = this.wal.replay(fromSeq + 1);
        if (msgs.length === 0)
            return;
        const batchSize = this.config.catchupBatchSize;
        for (let i = 0; i < msgs.length; i += batchSize) {
            const batch = msgs.slice(i, i + batchSize);
            this.bus.emit(this._busEvent('event:sync-batch', { msgs: batch }));
        }
    }
    _startScan() {
        this.scanTimer = setInterval(() => {
            this._scanPending();
        }, this.config.retryIntervalMs);
    }
    _scanPending() {
        const now = Date.now();
        const timeout = this.config.ackTimeoutMs;
        // 清理已 ACK 的 tracker 条目
        for (const [msgId] of this.pendingTracker) {
            // StreamWal.acknowledge 可能在别处被调用（如 _onDataEvent 的 ACK 回传后）
            // 但 tracker 是内存状态，需要从 WAL 同步确认 — 如果 WAL 里已标记 ACKED 则移除
            // 简单方式：检查 msgId 在 WAL readPending 中是否还存在
        }
        // 重试超时未 ACK 的消息
        for (const [msgId, info] of this.pendingTracker) {
            if (now - info.sentAt < timeout)
                continue;
            info.retries++;
            // 每 10 次打印一次 warn（持续重试，不放弃）
            if (info.retries % 10 === 0) {
                this.logger.warn(`EventStream: ${msgId} still pending after ${info.retries} retries`);
            }
            // 达到存活阈值时触发告警回调
            if (this.config.onStall && info.retries === this.config.stallThreshold) {
                const msg = this.wal.readPending(Date.now() + 3600000).find(m => m.msgId === msgId);
                this.config.onStall({
                    msgId,
                    seq: msg?.seq ?? 0,
                    type: msg?.type ?? 'unknown',
                    retries: info.retries,
                    durationMs: Date.now() - info.sentAt,
                });
            }
            // 从 WAL 读取原始消息
            const pendingMsgs = this.wal.readPending(now);
            const msg = pendingMsgs.find(m => m.msgId === msgId);
            if (!msg) {
                // WAL 中已不存在（可能已被 acknowledge 但 tracker 未同步）
                this.pendingTracker.delete(msgId);
                continue;
            }
            // 重发
            this.bus.emit(this._busEvent('node:created', { __es_msg: msg }));
            info.sentAt = now;
            this.logger.info(`EventStream: retry ${msgId} (attempt ${info.retries})`);
        }
    }
    _emitLocal(msg) {
        const list = this.handlers.get(msg.type) || [];
        for (const handler of list) {
            try {
                handler(msg);
            }
            catch (err) {
                this.logger.error(`EventStream handler error: ${err.message}`);
            }
        }
    }
}
exports.EventStream = EventStream;
//# sourceMappingURL=event-stream.js.map