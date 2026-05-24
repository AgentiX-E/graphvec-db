"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DCSync = void 0;
exports.resolveConflict = resolveConflict;
const zeromq_1 = require("zeromq");
const logger_1 = require("../ops/logger");
const otel_1 = require("../ops/otel");
const otel_metrics_1 = require("../ops/otel-metrics");
/**
 * 纯函数：基于 HLC 时间戳的 LWW 冲突解决
 *
 * @param remote 远程 delta
 * @param localTimestamp 本地已应用的 HLC 时间戳（可选）
 * @param strategy 冲突策略
 * @returns 'accept' — 接受远程变更 | 'reject' — 拒绝远程变更 | 'merge' — 合并双方
 */
function resolveConflict(remote, localTimestamp, strategy = 'lww') {
    if (strategy === 'ignore')
        return 'reject';
    if (strategy === 'crdt')
        return 'merge';
    // LWW: 比较 HLC 时间戳
    if (localTimestamp === null || localTimestamp.length === 0) {
        return 'accept';
    }
    // 解码 HLC 进行字节级比较
    // Uint8Array 按字典序比较即可（高位在前）
    for (let i = 0; i < Math.min(remote.hlcTimestamp.length, localTimestamp.length); i++) {
        if (remote.hlcTimestamp[i] > localTimestamp[i]) {
            return 'accept'; // 远程更新 → accept
        }
        if (remote.hlcTimestamp[i] < localTimestamp[i]) {
            return 'reject'; // 本地更新 → reject
        }
    }
    // 长度不同时的处理（长的更大）
    if (remote.hlcTimestamp.length > localTimestamp.length)
        return 'accept';
    if (remote.hlcTimestamp.length < localTimestamp.length)
        return 'reject';
    // 完全相等 → 不管谁先收到都不会丢失数据，接受即可
    return 'accept';
}
/**
 * DCSync — 跨数据中心同步协调器
 *
 * 使用 ZMQ PUB/SUB 模式：
 * - PUB: 定时广播本 DC 的 delta 变更
 * - SUB: 接收其他 DC 的 delta 变更
 *
 * ZMQ 具有自动重连和消息缓冲，跨 DC 网络中断恢复后自动继续
 */
class DCSync {
    config;
    deltaSync;
    logger;
    pubSocket;
    subSocket;
    _running = false;
    /** 记录每个 dcId 最近应用的 HLC 时间戳（用于冲突解决） */
    lastAppliedHlc = new Map();
    telemetry;
    metrics;
    constructor(config, deltaSync) {
        this.config = config;
        this.deltaSync = deltaSync;
        this.logger = new logger_1.Logger('DCSync');
        this.telemetry = otel_1.Telemetry.getInstance();
        this.metrics = otel_metrics_1.MetricsCollector.getInstance();
        this.pubSocket = new zeromq_1.Publisher();
        this.subSocket = new zeromq_1.Subscriber();
    }
    get isRunning() { return this._running; }
    async start() {
        await this.pubSocket.bind(this.config.zmqPubAddress);
        for (const peer of this.config.peers) {
            await this.subSocket.connect(peer.address);
        }
        this.subSocket.subscribe('');
        this._running = true;
        this._startReceiveLoop();
        this.deltaSync.startAutoFlush(async (delta) => this.publishDelta(delta), this.config.syncIntervalMs ?? 100);
    }
    async stop() {
        this._running = false;
        this.deltaSync.stopAutoFlush();
        this.pubSocket.close();
        this.subSocket.close();
    }
    async publishDelta(delta) {
        return this.telemetry.traceAsync('dcsync.publish', async () => {
            const payload = JSON.stringify(delta);
            await this.pubSocket.send(['graph_delta', Buffer.from(payload)]);
        });
    }
    async _startReceiveLoop() {
        for await (const [topic, msg] of this.subSocket) {
            if (!this._running)
                break;
            if (topic.toString() === 'graph_delta') {
                try {
                    const delta = JSON.parse(msg.toString());
                    // 冲突解决：基于 LWW 判断是否接受远程变更
                    const strategy = this.config.conflictStrategy ?? 'lww';
                    const localTs = this.lastAppliedHlc.get(delta.dcId) ?? null;
                    const resolution = resolveConflict(delta, localTs, strategy);
                    if (resolution === 'reject') {
                        this.logger.debug(`[DCSync] Rejected delta from ${delta.dcId} (local is newer)`);
                        continue;
                    }
                    // accept 或 merge → 照常处理
                    const count = await this.deltaSync.receiveDelta(delta);
                    // 更新该 DC 的最新 HLC 时间戳
                    this.lastAppliedHlc.set(delta.dcId, delta.hlcTimestamp);
                    if (count > 0) {
                        this.logger.info(`[DCSync] Applied ${count} remote changes from ${delta.dcId}`);
                    }
                }
                catch (err) {
                    this.logger.error('[DCSync] Failed to process remote delta:', err);
                }
            }
        }
    }
}
exports.DCSync = DCSync;
//# sourceMappingURL=dc-sync.js.map