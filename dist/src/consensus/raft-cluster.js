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
exports.RaftCluster = void 0;
/**
 * RaftCluster — 多节点 Raft 集群管理
 *
 * 管理同一 Range 内的多个 RaftNode 实例
 * 每个节点拥有独立的 GraphEngine 实例（独立的 dataDir）
 * 支持 1/3/5 节点配置
 */
const path = __importStar(require("node:path"));
const fs = __importStar(require("node:fs"));
const raft_node_1 = require("./raft-node");
const graph_engine_1 = require("../core/graph-engine");
class RaftCluster {
    baseDataDir;
    nodes = new Map();
    configs = new Map();
    /** 每个节点拥有独立的 GraphEngine */
    engines = new Map();
    nodeIds = [];
    clock;
    leaderTimeoutMs;
    timerProvider;
    constructor(
    /** 基础数据目录，每个节点在其下创建子目录 */
    baseDataDir, clock, options) {
        this.baseDataDir = baseDataDir;
        // 确保基础目录存在
        fs.mkdirSync(baseDataDir, { recursive: true });
        this.clock = clock;
        this.leaderTimeoutMs = options?.leaderTimeoutMs ?? 30000;
    }
    /** 设置计时器提供者（用于测试注入 MockTimer） */
    setTimerProvider(tp) {
        this.timerProvider = tp;
    }
    /** 添加一个 Raft 节点到集群（每个节点创建独立的 GraphEngine） */
    addNode(config) {
        // 为每个节点创建独立的 GraphEngine
        const nodeDataDir = path.join(this.baseDataDir, `node-${config.nodeId}`);
        fs.mkdirSync(nodeDataDir, { recursive: true });
        const engine = new graph_engine_1.GraphEngine({
            path: path.join(nodeDataDir, 'graph.db'),
        });
        this.engines.set(config.nodeId, engine);
        const node = new raft_node_1.RaftNode(config, engine, this.clock, this.timerProvider);
        this.nodes.set(config.nodeId, node);
        this.configs.set(config.nodeId, config);
        this.nodeIds.push(config.nodeId);
        return node;
    }
    /** 获取指定节点的 GraphEngine */
    getEngine(nodeId) {
        return this.engines.get(nodeId);
    }
    /** 获取节点 */
    getNode(nodeId) {
        return this.nodes.get(nodeId);
    }
    /** 获取 Leader 节点 */
    getLeader() {
        for (const [_, node] of this.nodes) {
            if (node.getStatus().role === 'leader')
                return node;
        }
        return undefined;
    }
    /** 启动所有节点 */
    async start() {
        const promises = [];
        for (const [_, node] of this.nodes) {
            promises.push(node.start());
        }
        await Promise.all(promises);
    }
    /** 停止所有节点 */
    async stop() {
        const promises = [];
        for (const [_, node] of this.nodes) {
            promises.push(node.stop());
        }
        await Promise.all(promises);
    }
    /** 获取所有节点状态 */
    getAllStatus() {
        const result = new Map();
        for (const [id, node] of this.nodes) {
            result.set(id, node.getStatus());
        }
        return result;
    }
    /**
     * 等待所有节点找到 Leader
     * @param timeout 超时毫秒（可选，默认使用构造时传入的 leaderTimeoutMs 或 30000）
     */
    async waitForAllStable(timeout) {
        const effectiveTimeout = timeout ?? this.leaderTimeoutMs;
        const sleep = (ms) => new Promise(r => {
            if (this.timerProvider) {
                this.timerProvider.setTimeout(r, ms);
            }
            else {
                setTimeout(r, ms);
            }
        });
        const start = Date.now();
        while (Date.now() - start < effectiveTimeout) {
            const leader = this.getLeader();
            if (leader && leader.getStatus().role === 'leader') {
                // 确认所有节点都启动完毕（followers 不跟踪 leaderId）
                let allUp = true;
                for (const [_, node] of this.nodes) {
                    if (!node.isStarted) {
                        allUp = false;
                        break;
                    }
                }
                if (allUp)
                    return;
            }
            await sleep(100);
        }
        throw new Error('Raft cluster failed to elect a leader within timeout');
    }
    /** 写入到 Leader */
    async write(op) {
        const leader = this.getLeader();
        if (!leader)
            throw new Error('No Raft leader available');
        return leader.write(op);
    }
    /** 获取节点数量 */
    get size() { return this.nodes.size; }
}
exports.RaftCluster = RaftCluster;
//# sourceMappingURL=raft-cluster.js.map