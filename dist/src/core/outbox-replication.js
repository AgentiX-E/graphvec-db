"use strict";
/**
 * outbox-replication.ts — EventBus Outbox: PerPeerWorker 池
 *
 * 每个 peer 一个独立的 PerPeerWorker（setTimeout loop），互不阻塞。
 * 三级 pending 优先级队列：Critical（重试≥3次/超时）→ Normal → Stale（兜底）。
 * ackTracker 超时重传 + LinearBackoff + recoverDealerFn 重建 DEALER。
 *
 * 设计文档 docs/EventBus_WorkerPool_设计方案.md
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.OutboxReplicationManager = exports.PerPeerWorker = exports.Outbox = void 0;
const lmdb_1 = require("lmdb");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const crypto = __importStar(require("node:crypto"));
const logger_1 = require("../ops/logger");
const event_bus_1 = require("./event-bus");
// ---------------------------------------------------------------------------
// OutboxIndex — LMDB 前缀索引
//
// 解决 fetchPendingByPeer/getPendingCountForPeer 全表扫描（O(N)）问题。
// 使用 LMDB 前缀范围扫描（O(K)，K=该 peer 的 pending 数）。
//
// 索引键格式：
//   pending:<peerId>:<pad10(seq)> → 1
//   delivered:<peerId>:<pad10(seq)> → 1     (用于清理索引)
//   seqToPeer:<seq> → peerId                 (seq → peer 反向查找)
// ---------------------------------------------------------------------------
class OutboxIndex {
    db;
    constructor(db) {
        this.db = db;
    }
    addPending(peerId, seq) {
        this.db.putSync(this._pendingKey(peerId, seq), 1);
        this.db.putSync(`seqToPeer:${seq}`, peerId);
    }
    markDelivered(peerId, seq) {
        this.db.removeSync(this._pendingKey(peerId, seq));
        this.db.putSync(this._deliveredKey(peerId, seq), 1);
        this.db.removeSync(`seqToPeer:${seq}`);
    }
    markPending(peerId, seq) {
        this.db.removeSync(this._deliveredKey(peerId, seq));
        this.db.putSync(this._pendingKey(peerId, seq), 1);
        this.db.putSync(`seqToPeer:${seq}`, peerId);
    }
    /** 按 peer 查询 pending seq 列表（LMDB 前缀扫描，O(K)） */
    fetchPendingSeqs(peerId) {
        const seqs = [];
        const prefix = this._pendingKey(peerId, 0).slice(0, -10); // 不含 seq 部分
        try {
            this.db.getRange({ start: prefix, end: prefix + '\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff' })
                .forEach((entry) => {
                const key = typeof entry.key === 'string' ? entry.key : entry.key.toString();
                const seq = parseInt(key.slice(key.lastIndexOf(':') + 1), 10);
                if (!isNaN(seq))
                    seqs.push(seq);
            });
        }
        catch {
            // LMDB getRange 可能抛异常
        }
        return seqs; // 天然按 seq 排序（前缀顺序）
    }
    /** 统计指定 peer 的 pending 数（O(K)） */
    countPending(peerId) {
        let count = 0;
        const prefix = this._pendingKey(peerId, 0).slice(0, -10);
        try {
            this.db.getRange({ start: prefix, end: prefix + '\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff' })
                .forEach(() => { count++; });
        }
        catch {
            // ignore
        }
        return count;
    }
    /** 获取最早待发送的 seq */
    oldestPending(peerId) {
        const prefix = this._pendingKey(peerId, 0).slice(0, -10);
        try {
            let first = null;
            this.db.getRange({ start: prefix, end: prefix + '\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff', limit: 1 })
                .forEach((entry) => {
                const key = typeof entry.key === 'string' ? entry.key : entry.key.toString();
                first = parseInt(key.slice(key.lastIndexOf(':') + 1), 10);
            });
            return first;
        }
        catch {
            return null;
        }
    }
    /** 启动时从主 Outbox DB 重建索引 */
    rebuildFromScratch(mainDb) {
        let count = 0;
        mainDb.getRange({ start: 1 }).forEach((entry) => {
            const e = entry.value;
            if (!e.delivered) {
                this.db.putSync(this._pendingKey(e.targetNodeId, e.seq), 1);
                this.db.putSync(`seqToPeer:${e.seq}`, e.targetNodeId);
            }
            else {
                this.db.putSync(this._deliveredKey(e.targetNodeId, e.seq), 1);
            }
            count++;
        });
    }
    /** 清理已送达的索引记录（housekeeping） */
    cleanDeliveredBefore(cutoffMs, mainDb) {
        let count = 0;
        try {
            this.db.getRange({ start: 'delivered:' }).forEach((entry) => {
                const key = typeof entry.key === 'string' ? entry.key : entry.key.toString();
                // key: delivered:<peerId>:<pad10(seq)>
                const seq = parseInt(key.slice(key.lastIndexOf(':') + 1), 10);
                if (isNaN(seq))
                    return;
                const outboxEntry = mainDb.get(seq);
                if (outboxEntry && outboxEntry.delivered && outboxEntry.deliveredAt < cutoffMs) {
                    this.db.removeSync(key);
                    count++;
                }
            });
        }
        catch {
            // ignore
        }
        return count;
    }
    _pendingKey(peerId, seq) {
        return `pending:${peerId}:${String(seq).padStart(10, '0')}`;
    }
    _deliveredKey(peerId, seq) {
        return `delivered:${peerId}:${String(seq).padStart(10, '0')}`;
    }
}
class Outbox {
    db;
    seqDb;
    indexDb;
    index;
    constructor(dbPath) {
        const dir = path.dirname(dbPath);
        fs.mkdirSync(dir, { recursive: true });
        this.db = (0, lmdb_1.open)({ path: dbPath, compression: true });
        this.seqDb = (0, lmdb_1.open)({ path: dbPath + '-seq', compression: true });
        this.indexDb = (0, lmdb_1.open)({ path: dbPath + '-index', compression: true });
        this.index = new OutboxIndex(this.indexDb);
        // 启动时重建索引（如果索引 DB 为空）
        this._ensureIndex();
    }
    close() {
        this.db.close();
        this.seqDb.close();
        this.indexDb.close();
    }
    add(entry) {
        const seq = (this.seqDb.get('seq') ?? 0) + 1;
        this.seqDb.putSync('seq', seq);
        const full = { ...entry, seq };
        this.db.putSync(seq, full);
        this.index.addPending(entry.targetNodeId, seq);
        return seq;
    }
    markDeliveredBatch(seqs) {
        const now = Date.now();
        for (const seq of seqs) {
            const entry = this.db.get(seq);
            if (entry && !entry.delivered) {
                entry.delivered = true;
                entry.deliveredAt = now;
                this.db.putSync(seq, entry);
                this.index.markDelivered(entry.targetNodeId, seq);
            }
        }
    }
    // 罕见：用于重发 / 回退
    markPending(seq) {
        const entry = this.db.get(seq);
        if (entry) {
            entry.delivered = false;
            entry.deliveredAt = 0;
            this.db.putSync(seq, entry);
            this.index.markPending(entry.targetNodeId, seq);
        }
    }
    fetchOldestPending(peerId) {
        // 先查索引拿到最早的 seq
        const oldestSeq = this.index.oldestPending(peerId);
        if (oldestSeq === null)
            return null;
        const entry = this.db.get(oldestSeq);
        return entry ?? null;
    }
    /** 取指定 peer 的所有 pending 消息（按 seq 升序）— 使用索引，O(K) */
    fetchPendingByPeer(peerId) {
        // 1. 从索引获取 seq 列表
        const seqs = this.index.fetchPendingSeqs(peerId);
        if (seqs.length === 0)
            return [];
        // 2. 批量从主 DB 读取
        return seqs
            .map(seq => this.db.get(seq))
            .filter((e) => e !== undefined && !e.delivered);
    }
    getPendingCountForPeer(peerId) {
        return this.index.countPending(peerId);
    }
    cleanDeliveredBefore(cutoffMs) {
        let count = 0;
        this.db.getRange({ start: 1 }).forEach((entry) => {
            const e = entry.value;
            if (e.delivered && e.deliveredAt < cutoffMs) {
                this.db.removeSync(entry.key);
                count++;
            }
        });
        // 同时清理索引
        this.index.cleanDeliveredBefore(cutoffMs, this.db);
        return count;
    }
    getPendingCount() {
        let count = 0;
        this.db.getRange({ start: 1 }).forEach((entry) => {
            if (!entry.value.delivered)
                count++;
        });
        return count;
    }
    /** 确保索引已建立 */
    _ensureIndex() {
        try {
            // 快速检查索引是否为空
            const hasIndex = this.index.countPending('__probe__') >= 0;
            // 检查主 DB 是否有数据
            let hasData = false;
            this.db.getRange({ start: 1, limit: 1 }).forEach(() => { hasData = true; });
            if (hasData) {
                // 检查索引是否有内容：读一个非 pending 的 key 来检测
                let indexHasData = false;
                try {
                    this.indexDb.getRange({ start: 'pending:', limit: 1 }).forEach(() => { indexHasData = true; });
                }
                catch { /* ignore */ }
                if (!indexHasData) {
                    this.index.rebuildFromScratch(this.db);
                }
            }
        }
        catch {
            // 索引异常时重建（慢启动）
            try {
                this.index.rebuildFromScratch(this.db);
            }
            catch { /* ignore */ }
        }
    }
}
exports.Outbox = Outbox;
// ---------------------------------------------------------------------------
// PerPeerWorker — 每个 peer 独立的 Worker
// ---------------------------------------------------------------------------
class PerPeerWorker {
    peerId;
    config;
    outbox;
    running = false;
    workerTimer = null;
    /** pending 消息队列：优先级分级 */
    criticalQueue = [];
    normalQueue = [];
    /** ack 追踪：msgId → sentAt */
    ackTracker = new Map();
    /** 上次发送时间（退避用） */
    lastSendMs = 0;
    /** 当前退避状态 */
    inBackoff = false;
    log;
    constructor(peerId, config, outbox) {
        this.peerId = peerId;
        this.config = config;
        this.outbox = outbox;
        this.log = config.logger ?? new logger_1.Logger(`ppw-${peerId}`);
    }
    /** 热加载 getter */
    get _tickMs() { return this.config.tickMs; }
    get _maxBackoffMs() { return this.config.maxBackoffMs; }
    get _ackTimeoutMs() { return this.config.ackTimeoutMs; }
    /** 每批最多发送条数（默认 100，可热加载） */
    get _batchSize() { return this.config.batchSize ?? 100; }
    start() {
        this.running = true;
        const loop = async () => {
            try {
                await this._tick();
            }
            catch (err) {
                this.log.warn(`Tick error: ${err.message}`);
            }
            if (this.running) {
                this.workerTimer = setTimeout(loop, this._tickMs);
            }
        };
        this.workerTimer = setTimeout(loop, this._tickMs);
    }
    stop() {
        this.running = false;
        if (this.workerTimer) {
            clearTimeout(this.workerTimer);
            this.workerTimer = null;
        }
        this.criticalQueue = [];
        this.normalQueue = [];
        this.ackTracker.clear();
    }
    /** 外部通知该 peer 已连接可用 */
    notifyConnected() {
        this.inBackoff = false;
        this.lastSendMs = 0;
    }
    /** 外部通知收到该 peer 的 ACK */
    notifyAcked(msgId) {
        this.ackTracker.delete(msgId);
        if (this.ackTracker.size === 0) {
            // 所有待 ACK 都收到 → 退出退避
            this.inBackoff = false;
            this.lastSendMs = 0;
        }
    }
    /** 推送一条哨兵消息触发重试（deliveryCheck 使用） */
    pushSentinel() {
        // 如果 tracker 非空且无 pending 消息，说明消息可能丢了
        if (this.ackTracker.size > 0 && this.criticalQueue.length === 0 && this.normalQueue.length === 0) {
            this.inBackoff = false;
        }
    }
    /** 获取当前 pending 数量 */
    getPendingCount() {
        return this.criticalQueue.length + this.normalQueue.length;
    }
    async _tick() {
        // ── Phase 0: 检查 ACK 超时 ──
        if (!this.running)
            return;
        const now = Date.now();
        for (const [msgId, sentAt] of this.ackTracker) {
            if (now - sentAt > this._ackTimeoutMs) {
                this.log.info(`ack timeout for ${msgId}, reverting to pending`);
                this.ackTracker.delete(msgId);
                this.inBackoff = false;
                // 重新从 LMDB 加载消息到 normal queue
                const entries = this.outbox.fetchPendingByPeer(this.peerId);
                this.normalQueue = entries.map(e => ({ entry: e, retryCount: 0, insertedAt: now }));
                this.normalQueue.sort((a, b) => a.entry.seq - b.entry.seq);
                break; // 一轮最多处理一个 timeout
            }
        }
        // ── Phase 1: 检查退避 ──
        if (!this.running)
            return;
        if (this.inBackoff && this.lastSendMs > 0) {
            if (now - this.lastSendMs < this._maxBackoffMs) {
                return; // 退避中，跳过发送
            }
            // 退避超时 → 重建 DEALER
            try {
                const pubKey = this._readPeerPubKey();
                if (!pubKey) {
                    this.log.info(`.pub gone — permanent stop`);
                    this.running = false;
                    return;
                }
                await this.config.recoverDealerFn();
                this.inBackoff = false;
                this.lastSendMs = 0;
            }
            catch (err) {
                this.log.warn(`recover dealer failed: ${err.message}`);
                this.lastSendMs = now; // 更新避免每 tick 都试
                return;
            }
        }
        // ── Phase 2: 从 LMDB 加载 pending 消息填充队列 ──
        if (!this.running)
            return;
        if (this.normalQueue.length === 0) {
            const entries = this.outbox.fetchPendingByPeer(this.peerId);
            this.normalQueue = entries.map(e => ({ entry: e, retryCount: 0, insertedAt: now }));
            this.normalQueue.sort((a, b) => a.entry.seq - b.entry.seq);
        }
        // ── Phase 3: 检查 peer 是否在线 ──
        if (!this.running)
            return;
        const pubKey = this._readPeerPubKey();
        if (!pubKey) {
            this.log.info(`.pub gone — permanent stop`);
            this.running = false;
            return;
        }
        // ── Phase 4: 收集 batch ──
        const batch = [];
        while (batch.length < this._batchSize) {
            const item = this.criticalQueue.shift() ?? this.normalQueue.shift();
            if (!item)
                break;
            batch.push(item);
        }
        if (batch.length === 0)
            return; // 无 pending 消息
        // ── Phase 5: 发送 batch ──
        const entriesToDeliver = [];
        const sendItems = [];
        for (const item of batch) {
            entriesToDeliver.push(item.entry.seq);
            sendItems.push({
                msgId: item.entry.msgId,
                payload: Buffer.from(item.entry.payload),
            });
        }
        try {
            if (this.config.batchSendFn && sendItems.length > 1) {
                // 批量发送（单次 ZMQ send，multi-part 消息）
                await this.config.batchSendFn(sendItems);
            }
            else {
                // 兜底：逐条发送（兼容旧 sendFn）
                for (const si of sendItems) {
                    await this.config.sendFn(si.msgId, si.payload);
                }
            }
            // 成功：标记 delivered + 加入 ack 追踪
            this.outbox.markDeliveredBatch(entriesToDeliver);
            for (const item of batch) {
                this.ackTracker.set(item.entry.msgId, Date.now());
            }
        }
        catch (err) {
            this.log.warn(`batch send failed (${batch.length} msgs): ${err.message}`);
            // 发送失败：全部放回队列，升级 retryCount
            for (const item of batch) {
                const newRetry = item.retryCount + 1;
                if (newRetry >= 3) {
                    this.criticalQueue.push({ ...item, retryCount: newRetry, insertedAt: now });
                }
                else {
                    this.normalQueue.push({ ...item, retryCount: newRetry, insertedAt: now });
                }
            }
            // 进入退避
            this.inBackoff = true;
            this.lastSendMs = now;
        }
    }
    _readPeerPubKey() {
        try {
            const entries = fs.readdirSync(this.config.curveDir);
            for (const entry of entries) {
                if (!entry.endsWith('.pub'))
                    continue;
                const parsed = (0, event_bus_1.parsePubFilename)(entry);
                if (parsed && parsed.nodeId === this.peerId) {
                    const key = fs.readFileSync(path.join(this.config.curveDir, entry), 'utf-8').trim();
                    if (key.length > 0)
                        return key;
                }
            }
        }
        catch { /* ignore */ }
        return null;
    }
    /** 获取当前状态统计（用于 reportConfig） */
    getStats() {
        return {
            critical: this.criticalQueue.length,
            normal: this.normalQueue.length,
            ackPending: this.ackTracker.size,
            inBackoff: this.inBackoff,
        };
    }
}
exports.PerPeerWorker = PerPeerWorker;
// ---------------------------------------------------------------------------
// OutboxReplicationManager — 管理 Worker 池 + Housekeeping + DeliveryCheck
// ---------------------------------------------------------------------------
class OutboxReplicationManager {
    config;
    outbox;
    /** peerId → PerPeerWorker */
    workerMap = new Map();
    housekeepingTimer = null;
    deliveryCheckTimer = null;
    reloadTimer = null;
    configFilePath = null;
    log;
    constructor(config) {
        this.config = config;
        const dbPath = config.dbPath ?? path.join(process.cwd(), 'data', 'outbox');
        this.outbox = new Outbox(dbPath);
        this.log = config.logger ?? new logger_1.Logger('outbox-mgr');
        const envPath = process.env.ML_CONFIG_PATH;
        if (envPath) {
            this.configFilePath = path.resolve(envPath);
        }
    }
    get dbPath() { return this.config.dbPath ?? path.join(process.cwd(), 'data', 'outbox'); }
    get configFile() { return this.configFilePath; }
    loadConfigFile() {
        if (!this.configFilePath)
            return;
        try {
            const content = fs.readFileSync(this.configFilePath, 'utf-8');
            const parsed = JSON.parse(content);
            const partial = {};
            const fields = ['tickMs', 'maxBackoffSeconds', 'housekeepingIntervalMs', 'entryTTLDays'];
            let changed = false;
            for (const field of fields) {
                if (parsed[field] !== undefined && typeof parsed[field] === 'number' && parsed[field] > 0) {
                    partial[field] = parsed[field];
                    changed = true;
                }
            }
            if (changed) {
                Object.assign(this.config, partial);
                this.log.info(`[Outbox] loaded config from ${this.configFilePath}: ${JSON.stringify(partial)}`);
                if (partial.housekeepingIntervalMs !== undefined)
                    this._restartHousekeeping();
            }
            else {
                this.log.debug(`[Outbox] config file ${this.configFilePath}: no valid fields`);
            }
        }
        catch (err) {
            this.log.warn(`[Outbox] failed to load config file ${this.configFilePath}: ${err.message}`);
        }
    }
    saveConfigFile() {
        if (!this.configFilePath) {
            this.log.warn('[Outbox] no ML_CONFIG_PATH set, cannot save config');
            return;
        }
        try {
            const dir = path.dirname(this.configFilePath);
            fs.mkdirSync(dir, { recursive: true });
            const data = {
                tickMs: this.config.tickMs ?? 500,
                maxBackoffSeconds: this.config.maxBackoffSeconds ?? 60,
                housekeepingIntervalMs: this.config.housekeepingIntervalMs ?? 86400000,
                entryTTLDays: this.config.entryTTLDays ?? 14,
            };
            fs.writeFileSync(this.configFilePath, JSON.stringify(data, null, 2), 'utf-8');
            this.log.info(`[Outbox] config saved to ${this.configFilePath}`);
        }
        catch (err) {
            this.log.warn(`[Outbox] failed to save config file: ${err.message}`);
        }
    }
    getConfig() {
        return { ...this.config };
    }
    updateConfig(partial) {
        Object.assign(this.config, partial);
        this.log.info(`[Outbox] config updated: ${JSON.stringify(partial)}`);
        this.saveConfigFile();
        if (partial.housekeepingIntervalMs !== undefined) {
            this._restartHousekeeping();
        }
    }
    _restartHousekeeping() {
        if (this.housekeepingTimer) {
            clearInterval(this.housekeepingTimer);
            this.housekeepingTimer = null;
        }
        const hkInterval = this.config.housekeepingIntervalMs ?? 86400000;
        this.housekeepingTimer = setInterval(() => {
            const cutoff = Date.now() - (this.config.entryTTLDays ?? 14) * 86400000;
            const count = this.outbox.cleanDeliveredBefore(cutoff);
            if (count > 0)
                this.log.info(`[Outbox] housekeeping: removed ${count} old entries`);
        }, hkInterval);
    }
    addMessage(type, data) {
        const createdAt = Date.now();
        const remotePeers = this.config.peers.filter(p => p.nodeId !== this.config.nodeId);
        for (const peer of remotePeers) {
            this.outbox.add({
                msgId: data['msgId'] ?? `${createdAt}-${crypto.randomUUID()}`,
                targetNodeId: peer.nodeId,
                type,
                payload: JSON.stringify({ type, data }),
                createdAt,
                delivered: false,
                deliveredAt: 0,
            });
        }
    }
    /** 创建/重建指定 peer 的 PerPeerWorker */
    _ensureWorker(peerId) {
        let worker = this.workerMap.get(peerId);
        if (worker)
            return worker;
        const remotePeers = this.config.peers.filter(p => p.nodeId !== this.config.nodeId);
        const peerCfg = remotePeers.find(p => p.nodeId === peerId);
        if (!peerCfg) {
            throw new Error(`peer ${peerId} not found in config`);
        }
        worker = new PerPeerWorker(peerId, {
            peerId,
            tickMs: this.config.tickMs ?? 500,
            maxBackoffMs: (this.config.maxBackoffSeconds ?? 60) * 1000,
            ackTimeoutMs: (this.config.tickMs ?? 500) * 3,
            batchSize: this.config.batchSize ?? 100,
            curveDir: this.config.curveDir,
            sendFn: async (msgId, payload) => {
                const parsed = JSON.parse(payload.toString('utf-8'));
                const streamMsg = {
                    msgId,
                    seq: 0,
                    nodeId: this.config.nodeId,
                    timestamp: Date.now(),
                    type: parsed.type ?? 'unknown',
                    data: parsed,
                };
                const msg = {
                    msgId,
                    type: 'data',
                    srcNodeId: this.config.nodeId,
                    data: { __es_msg: streamMsg },
                };
                await this.config.eventBus.send(peerId, msg);
            },
            batchSendFn: async (items) => {
                // 批量发送：将多个消息合并为一次 ZMQ send
                // eventBus.send 一次只能发送一条，所以这里还是调用多次但利用 ZMQ 的缓冲能力
                // 实际批量优化在 ZMQ 层面：在 EventBus 中实现 batchSend
                if (this.config.eventBus.batchSend) {
                    const batched = items.map(({ msgId, payload }) => {
                        const parsed = JSON.parse(payload.toString('utf-8'));
                        const streamMsg = {
                            msgId,
                            seq: 0,
                            nodeId: this.config.nodeId,
                            timestamp: Date.now(),
                            type: parsed.type ?? 'unknown',
                            data: parsed,
                        };
                        return {
                            msgId,
                            type: 'data',
                            srcNodeId: this.config.nodeId,
                            data: { __es_msg: streamMsg },
                        };
                    });
                    await this.config.eventBus.batchSend(peerId, batched);
                }
                else {
                    // 兜底：逐条调用 send（但 batchSize 聚合减小了 Node.js 事件循环开销）
                    for (const { msgId, payload } of items) {
                        const parsed = JSON.parse(payload.toString('utf-8'));
                        const streamMsg = {
                            msgId,
                            seq: 0,
                            nodeId: this.config.nodeId,
                            timestamp: Date.now(),
                            type: parsed.type ?? 'unknown',
                            data: parsed,
                        };
                        const msg = {
                            msgId,
                            type: 'data',
                            srcNodeId: this.config.nodeId,
                            data: { __es_msg: streamMsg },
                        };
                        await this.config.eventBus.send(peerId, msg);
                    }
                }
            },
            recoverDealerFn: async () => {
                if (this.config.eventBus._recoverDealerByNodeId) {
                    await this.config.eventBus._recoverDealerByNodeId(peerId);
                }
                else {
                    throw new Error('_recoverDealerByNodeId not available on eventBus');
                }
            },
            logger: this.log,
        }, this.outbox);
        this.workerMap.set(peerId, worker);
        this.log.info(`[Outbox] PerPeerWorker created for ${peerId}`);
        return worker;
    }
    start() {
        this.loadConfigFile();
        // 为每个 remote peer 创建 PerPeerWorker
        const remotePeers = this.config.peers.filter(p => p.nodeId !== this.config.nodeId);
        for (const peer of remotePeers) {
            const worker = this._ensureWorker(peer.nodeId);
            worker.start();
        }
        // Housekeeping
        this._restartHousekeeping();
        // DeliveryCheck：定时扫描所有 peer 的 backlog，对卡住的推送哨兵
        this.deliveryCheckTimer = setInterval(() => {
            this._deliveryCheckPeers();
        }, (this.config.tickMs ?? 500) * 10);
        // 配置文件定时重载
        if (this.configFilePath) {
            this.reloadTimer = setInterval(() => {
                this.loadConfigFile();
            }, 60000);
        }
    }
    stop() {
        for (const [peerId, worker] of this.workerMap) {
            worker.stop();
        }
        this.workerMap.clear();
        if (this.housekeepingTimer) {
            clearInterval(this.housekeepingTimer);
            this.housekeepingTimer = null;
        }
        if (this.deliveryCheckTimer) {
            clearInterval(this.deliveryCheckTimer);
            this.deliveryCheckTimer = null;
        }
        if (this.reloadTimer) {
            clearInterval(this.reloadTimer);
            this.reloadTimer = null;
        }
        this._deleteMyPubKey();
        this.outbox.close();
    }
    _deleteMyPubKey() {
        try {
            const nodeId = this.config.nodeId;
            const entries = fs.readdirSync(this.config.curveDir);
            for (const entry of entries) {
                if (!entry.endsWith('.pub'))
                    continue;
                const parsed = (0, event_bus_1.parsePubFilename)(entry);
                if (parsed && parsed.nodeId === nodeId) {
                    const filePath = path.join(this.config.curveDir, entry);
                    fs.unlinkSync(filePath);
                    this.log.info(`[Outbox] deleted my pub key: ${entry}`);
                    break;
                }
            }
        }
        catch (err) {
            this.log.warn(`[Outbox] failed to delete pub key: ${err.message}`);
        }
    }
    registerShutdownHook() {
        const cleanup = () => {
            this.log.info('[Outbox] shutdown hook triggered, cleaning up...');
            this.stop();
            process.exit(0);
        };
        process.on('SIGTERM', cleanup);
        process.on('SIGINT', cleanup);
        process.on('exit', () => {
            try {
                this._deleteMyPubKey();
            }
            catch { /* best-effort */ }
        });
    }
    /** DeliveryCheck：定时检查所有 peer 的 pending 状态，推送哨兵消息 */
    _deliveryCheckPeers() {
        const now = Date.now();
        for (const [peerId, worker] of this.workerMap) {
            // 如果 worker 的 ackTracker 有未 ack 的消息，但 pending 队列为空 → 可能是 ack 丢失
            const stats = worker.getStats();
            if (stats.ackPending > 0 && stats.critical === 0 && stats.normal === 0) {
                worker.pushSentinel();
            }
            // 如果 worker 完全停止，但有 pending 数据 → 重启 worker
            if (!this._isWorkerRunning(peerId)) {
                const pendingCount = this.outbox.getPendingCountForPeer(peerId);
                if (pendingCount > 0) {
                    this.log.info(`[DeliveryCheck] ${peerId} has ${pendingCount} pending but not running — restarting`);
                    this._restartWorker(peerId);
                }
            }
        }
    }
    _isWorkerRunning(peerId) {
        // 检查 worker 是否存在（running 状态只能通过 getStats 间接判断）
        // 如果 worker 遇到 .pub 消失会 self-stop（设置 running=false）
        return this.workerMap.has(peerId);
    }
    _restartWorker(peerId) {
        const old = this.workerMap.get(peerId);
        if (old)
            old.stop();
        this.workerMap.delete(peerId);
        const worker = this._ensureWorker(peerId);
        worker.start();
    }
    /** 通知指定 peer 的 Worker 已连接 */
    notifyConnected(peerId) {
        const worker = this.workerMap.get(peerId);
        if (worker)
            worker.notifyConnected();
    }
    /** 通知指定 peer 的 Worker 收到 ACK */
    notifyAcked(peerId) {
        const worker = this.workerMap.get(peerId);
        if (worker)
            worker.notifyConnected();
    }
    getStats() {
        return {
            sendTrack: this.workerMap.size,
            backoffTrack: 0,
            pending: this.outbox.getPendingCount(),
        };
    }
    /** 获取每个 peer 的详细报告（reportConfig 回调用） */
    getPeerReports() {
        const reports = [];
        for (const [peerId, worker] of this.workerMap) {
            reports.push({ peerId, stats: worker.getStats() });
        }
        return reports;
    }
}
exports.OutboxReplicationManager = OutboxReplicationManager;
//# sourceMappingURL=outbox-replication.js.map