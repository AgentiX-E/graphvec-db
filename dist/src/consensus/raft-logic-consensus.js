"use strict";
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
exports.RaftLogicConsensus = void 0;
const logger_1 = require("../ops/logger");
/**
 * RaftLogicConsensus — raft-logic (tikv/raft-rs WASM) 共识实现
 *
 * 生产级共识，使用 etcd/TiKV 的 Raft 实现
 * 提供：Leader 选举、日志复制、preVote 防脑裂、checkQuorum
 *
 * 注意：raft-logic 为可选依赖，当安装时使用此实现
 *
 * 采用惰性加载模式：
 * - 构造时不加载模块，允许按需创建实例
 * - init() 中尝试加载模块，失败时保存错误但不抛出
 * - start() 时如果模块未加载则抛出明确错误（含安装指引）
 * - 测试可通过 _moduleRef 注入 mock 模块避免真实依赖
 */
class RaftLogicConsensus {
    _moduleRef;
    config;
    logger;
    applyFn = null;
    _node = null;
    _started = false;
    _loaded = false;
    _loadError = null;
    _raftModule = null;
    constructor(config, _moduleRef) {
        this._moduleRef = _moduleRef;
        this.config = { ...config, mode: 'raft-logic' };
        this.logger = new logger_1.Logger('RaftLogicConsensus');
    }
    /**
     * 惰性加载 raft-logic 模块
     * 加载失败时保存错误但不抛出，允许 graceful fallback
     */
    async init() {
        // 如果已注入 mock module，直接使用
        if (this._moduleRef) {
            this._raftModule = this._moduleRef;
            this._loaded = true;
            this._loadError = null;
            return;
        }
        try {
            this._raftModule = await importRaftLogic();
            this._loaded = true;
        }
        catch (err) {
            this._loadError = new Error(`RaftLogicConsensus failed to load 'raft-logic' module. ` +
                `Ensure 'raft-logic' is installed: npm install raft-logic. ` +
                `Original error: ${err.message}`);
            this._loaded = false;
            // 不抛出 — 让 init 通过，允许 graceful fallback
            // 等 start() 时再报
        }
    }
    setApply(fn) {
        this.applyFn = fn;
    }
    async start() {
        // 如果 init() 未被调用过，自动调用
        if (!this._loaded && !this._loadError) {
            await this.init();
        }
        if (!this._loaded) {
            throw this._loadError || new Error('RaftLogicConsensus not initialized (module unavailable)');
        }
        try {
            const { RaftNode, SqliteStorage, InMemoryTransport, ready } = this._raftModule;
            await ready;
            const nodeIds = [this.config.nodeId, ...this.config.peers];
            const transport = new InMemoryTransport();
            const storage = new SqliteStorage({ file: `./data/raft-${this.config.nodeId}.db` });
            await storage.open();
            const raft = new RaftNode({
                id: Number(this.config.nodeId),
                peers: nodeIds.map(Number),
                electionTick: 10,
                heartbeatTick: 3,
                storage,
                transport,
                apply: async (entry) => {
                    if (this.applyFn) {
                        await this.applyFn(Buffer.from(entry.data));
                    }
                },
                tickIntervalMs: 50,
                preVote: true,
                checkQuorum: true,
            });
            await raft.start();
            this._node = raft;
            this._started = true;
        }
        catch (err) {
            this.logger.warn('[RaftLogicConsensus] Failed to initialize raft-logic. Falling back?', { err: err.message });
            throw err;
        }
    }
    async stop() {
        if (this._node) {
            await this._node.stop();
            this._node = null;
        }
        this._started = false;
    }
    async propose(data, timeoutMs) {
        if (!this._node || !this._started)
            return { ok: false };
        try {
            const result = await this._node.clientRequest(Buffer.from(data).toString('base64'), { waitFor: 'apply', timeout: timeoutMs ?? 5000 });
            return { ok: result.ok };
        }
        catch {
            return { ok: false };
        }
    }
    async readIndex(timeoutMs) {
        if (!this._node)
            return;
        await this._node.readIndex({ timeout: timeoutMs ?? 3000 });
    }
    getRole() {
        if (!this._node)
            return 'follower';
        const status = this._node.status();
        return status.role || 'follower';
    }
    getLeaderId() {
        if (!this._node)
            return null;
        const status = this._node.status();
        return status.leaderId;
    }
    getTerm() {
        if (!this._node)
            return 0;
        return this._node.status().term;
    }
    async waitForLeader(timeoutMs) {
        if (!this._node)
            throw new Error('RaftLogicConsensus not started');
        try {
            await this._node.waitForLeaderStable({ timeout: timeoutMs ?? 5000 });
        }
        catch (err) {
            throw new Error(`waitForLeader failed: ${err.message}`);
        }
    }
    /** 测试辅助：获取加载状态 */
    _isLoaded() {
        return this._loaded;
    }
    /** 测试辅助：获取加载错误 */
    _getLoadError() {
        return this._loadError;
    }
}
exports.RaftLogicConsensus = RaftLogicConsensus;
/** 动态导入 raft-logic（可选依赖） */
async function importRaftLogic() {
    try {
        return await Promise.resolve().then(() => __importStar(require('raft-logic')));
    }
    catch {
        throw new Error('raft-logic is not installed. Install it: npm install raft-logic');
    }
}
//# sourceMappingURL=raft-logic-consensus.js.map