"use strict";
/**
 * multi-leader-replication.ts — Multi-Leader 复制层
 *
 * 基于 Outbox Worker 的最终一致性复制：
 * 1. replicate() 写入 Outbox（LMDB 持久化）后立即返回
 * 2. 单一 OutboxWorker 后台发送，per-peer 退避独立
 * 3. 退避重试（maxBackoffSeconds = 60s），无限重试
 * 4. 节点下线（.pub 删除）→ Worker 自动停止发送
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
exports.MultiLeaderReplication = void 0;
const outbox_replication_1 = require("./outbox-replication");
const crypto = __importStar(require("node:crypto"));
/**
 * Multi-Leader 复制层
 */
class MultiLeaderReplication {
    manager;
    config;
    constructor(config) {
        this.config = { ...config };
        const peerAddrs = config.peers.filter(p => p.nodeId !== config.nodeId);
        // Derive maxBackoffSeconds from topology if not explicitly set.
        // Store result back in config so getConfig() reflects the resolved value.
        if (this.config.maxBackoffSeconds === undefined) {
            switch (this.config.topology ?? 'cross-dc') {
                case 'intra-dc':
                    this.config.maxBackoffSeconds = 3;
                    break;
                case 'cross-dc':
                    this.config.maxBackoffSeconds = 60;
                    break;
                case 'edge':
                    this.config.maxBackoffSeconds = 300;
                    break;
            }
        }
        const mgrConfig = {
            nodeId: this.config.nodeId,
            peers: peerAddrs,
            dbPath: this.config.dbPath,
            curveDir: this.config.curveDir,
            tickMs: this.config.tickMs,
            maxBackoffSeconds: this.config.maxBackoffSeconds,
            batchSize: this.config.batchSize,
            entryTTLDays: this.config.entryTTLDays,
            housekeepingIntervalMs: this.config.housekeepingIntervalMs,
            usePerPeerDb: this.config.usePerPeerDb,
            eventBus: this.config.eventBus,
        };
        this.manager = new outbox_replication_1.OutboxReplicationManager(mgrConfig);
    }
    /** 当前节点 ID */
    get nodeId() { return this.config.nodeId; }
    /** 获取当前配置副本（包含由 topology 推导的最终值） */
    getConfig() {
        return { ...this.config };
    }
    /** 启动所有 Outbox Worker 并注册 shutdown hook */
    start() {
        this.manager.start();
        this.manager.registerShutdownHook();
    }
    /**
     * 写入 Outbox（不等待远程 ACK）
     */
    async replicate(type, data, opts) {
        const expectedAcks = opts?.emitReplica ?? this.config.peers.filter(p => p.nodeId !== this.config.nodeId).length;
        if (expectedAcks <= 0) {
            return { success: true, acksReceived: 0, expectedAcks: 0 };
        }
        // 标记消息 ID
        const msgId = crypto.randomUUID();
        const payload = { ...data, msgId };
        this.manager.addMessage(type, payload);
        return { success: true, acksReceived: 0, expectedAcks };
    }
    /** 停止 */
    stop() {
        this.manager.stop();
    }
    /** 统计信息 */
    getStats() {
        return {
            workers: this.config.peers.filter(p => p.nodeId !== this.config.nodeId).length,
            pending: this.manager.getStats().pending,
        };
    }
    /** 通知 Worker 某个 peer 已连接 */
    notifyConnected(peerId) {
        this.manager.notifyConnected(peerId);
    }
    /** 通知 Worker 收到某个 peer 的 ACK */
    notifyAcked(peerId) {
        this.manager.notifyAcked(peerId);
    }
    /** R9: 绑定 ConsensusProvider，自动注册 majority-change 回调
     *
     * 当节点失去 majority（网络分区）时，自动冻结 Outbox 出站发送；
     * 恢复 majority 后自动解冻。
     */
    setConsensus(consensus) {
        consensus.onMajorityChange((inMajority) => {
            this.manager.setMajorityStatus(inMajority);
        });
    }
}
exports.MultiLeaderReplication = MultiLeaderReplication;
//# sourceMappingURL=multi-leader-replication.js.map