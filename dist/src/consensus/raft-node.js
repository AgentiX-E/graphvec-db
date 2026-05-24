"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RaftNode = void 0;
const raft_core_1 = require("./raft-core");
const transport_1 = require("./transport");
const uuid_1 = require("uuid");
const logger_1 = require("../ops/logger");
const otel_1 = require("../ops/otel");
const otel_metrics_1 = require("../ops/otel-metrics");
/**
 * RaftNode — 固定的 Raft 共识节点
 *
 * 没有 mode 概念，没有环境变量，没有插件化
 * 使用 RaftCore 作为固化共识实现
 * 默认使用 MockTransport（进程内测试），通过 transport 参数传入生产级实现切换
 */
class RaftNode {
    raft;
    engine;
    clock;
    _started = false;
    logger;
    applyResolvers = new Map();
    telemetry;
    metrics;
    constructor(config, engine, clock, timerProvider, 
    /** 传入已有 transport 实例用于测试；默认创建 MockTransport */
    transport) {
        this.engine = engine;
        this.clock = clock;
        this.logger = new logger_1.Logger('RaftNode');
        this.telemetry = otel_1.Telemetry.getInstance();
        this.metrics = otel_metrics_1.MetricsCollector.getInstance();
        // 确定 transport：默认 MockTransport（进程内测试），由外部注入生产级实现
        const actualTransport = transport ?? new transport_1.MockTransport(config.nodeId);
        // 创建 WAL 路径
        const walPath = `${config.storagePath}/wal-${config.nodeId}.bin`;
        // 创建 RaftCore
        this.raft = new raft_core_1.RaftCore({
            nodeId: config.nodeId,
            peers: config.peers.map(p => p.id),
            walPath,
            electionTimeoutMs: config.electionTimeoutMinMs ?? 150,
            heartbeatIntervalMs: config.heartbeatIntervalMs ?? 50,
        }, actualTransport, timerProvider);
        // 设置 state machine apply 回调
        this.raft.setApply(async (data) => {
            await this._applyToStateMachine(data);
        });
    }
    get engine_() {
        return this.engine;
    }
    get isStarted() {
        return this._started;
    }
    /** 启动 */
    async start() {
        this.engine.open();
        await this.raft.start();
        this._started = true;
    }
    /** 停止 */
    async stop() {
        if (!this._started)
            return;
        await this.raft.stop();
        this.engine.close();
        this._started = false;
    }
    /** 通过 Raft 共识写入 */
    async write(operation) {
        return this.telemetry.traceAsync('raft.write', async () => {
            const op = {
                ...operation,
                id: (0, uuid_1.v4)(),
                hlcTimestamp: this.clock.now().toBytes(),
            };
            const data = Buffer.from(JSON.stringify(op));
            // 先注册 promise，再 propose — 避免竞态
            const promise = new Promise((resolve, reject) => {
                this.applyResolvers.set(op.id, { resolve, reject });
            });
            const result = await this.raft.propose(data);
            if (!result.ok) {
                this.applyResolvers.delete(op.id);
                throw new Error('Raft proposal failed');
            }
            this.metrics.incrementCounter('graph.ops.writes');
            this.metrics.incrementCounter('graph.raft.proposals');
            return promise;
        });
    }
    /** 线性一致读 */
    async read(reader) {
        return this.telemetry.traceAsync('raft.read', async () => {
            await this.raft.readIndex();
            const result = reader(this.engine);
            this.metrics.incrementCounter('graph.ops.reads');
            return result;
        });
    }
    /** 获取状态 */
    getStatus() {
        return {
            role: this.raft.getRole(),
            leaderId: this.raft.getLeaderId(),
            term: this.raft.getTerm(),
            committed: 0,
            applied: 0,
            lastIndex: 0,
            snapshotIndex: 0,
        };
    }
    /** 等待成为 Leader */
    async waitForLeader(timeoutMs) {
        await this.raft.waitForLeader(timeoutMs);
    }
    /** 屏障（写入 admin barrier 操作） */
    async barrier() {
        await this.write({ type: 'admin', payload: { command: 'barrier' } });
    }
    /**
     * 校验并规范化 op 的 payload
     * 确保 payload 不为 null/undefined，并有必要的字段
     */
    _validatePayload(payload) {
        if (!payload || typeof payload !== 'object') {
            throw new Error(`Invalid RaftOperation payload: expected object, got ${typeof payload}`);
        }
        return payload;
    }
    /** 将共识提案应用到图引擎状态机 */
    async _applyToStateMachine(data) {
        const text = Buffer.from(data).toString();
        let op;
        try {
            op = JSON.parse(text);
        }
        catch {
            return;
        }
        if (op.hlcTimestamp) {
            this.clock.update(op.hlcTimestamp);
        }
        try {
            let result = undefined;
            switch (op.type) {
                case 'upsert_node': {
                    const p = this._validatePayload(op.payload);
                    result = this.engine.upsertNode(p.typeId, p.name, p.opts);
                    break;
                }
                case 'upsert_edge': {
                    const p = this._validatePayload(op.payload);
                    this.engine.upsertEdge(p.src, p.dst, p.typeId, p.opts);
                    break;
                }
                case 'delete_node':
                    this.engine.deleteNode(this._validatePayload(op.payload).id);
                    break;
                case 'delete_edge': {
                    const p = this._validatePayload(op.payload);
                    this.engine.deleteEdge(p.src, p.dst, p.typeId);
                    break;
                }
                case 'batch_upsert': {
                    const p = this._validatePayload(op.payload);
                    result = this.engine.batchUpsertNodes(p.inputs);
                    break;
                }
                case 'batch_edge': {
                    const p = this._validatePayload(op.payload);
                    const inputs = p.inputs;
                    for (const input of inputs) {
                        this.engine.upsertEdge(input.src, input.dst, input.typeId, input.opts);
                    }
                    break;
                }
                case 'admin': {
                    const p = this._validatePayload(op.payload);
                    if (p.command === 'compact')
                        this.engine.compact();
                    break;
                }
            }
            // 通过 op.id 解析到对应的 write() promise
            if (op.id && this.applyResolvers.has(op.id)) {
                this.applyResolvers.get(op.id).resolve(result);
                this.applyResolvers.delete(op.id);
            }
        }
        catch (err) {
            if (op.id && this.applyResolvers.has(op.id)) {
                this.applyResolvers.get(op.id).reject(err);
                this.applyResolvers.delete(op.id);
            }
            this.logger.error('[RaftNode] State machine apply error:', err);
        }
    }
}
exports.RaftNode = RaftNode;
//# sourceMappingURL=raft-node.js.map