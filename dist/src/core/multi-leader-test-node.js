"use strict";
/**
 * multi-leader-test-node.ts — Multi-Leader 集成测试子进程
 *
 * 通过 `npx tsx ...` 启动，通过 stdin（JSON line）接收命令，
 * 通过 stdout（JSON line）返回结果。
 *
 * 环境变量:
 *   ML_NODE_ID          — 节点 ID（如 node-1）
 *   ML_PEERS            — JSON 数组: ["node-1","node-2","node-3"]
 *   ML_PORT             — ZMQ 端口
 *   ML_DATA_DIR         — WAL / 数据目录
 *   ML_CURVE_DIR        — NAS 公钥共享目录
 *
 * NAS 模式自动发现 peer，不需要传地址列表。
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
const graph_engine_1 = require("./graph-engine");
const event_stream_1 = require("./event-stream");
const overgraph_storage_1 = require("./overgraph-storage");
const event_bus_1 = require("./event-bus");
const multi_leader_replication_1 = require("./multi-leader-replication");
const hlc_clock_1 = require("../replication/hlc-clock");
const path = __importStar(require("node:path"));
const fs = __importStar(require("node:fs"));
const readline = __importStar(require("node:readline"));
const logger_1 = require("../ops/logger");
const logger = new logger_1.Logger('MultiLeaderTestNode');
function logOut(msg) {
    const str = JSON.stringify(msg) + '\n';
    try {
        fs.writeSync(process.stdout.fd, str);
    }
    catch {
        // stdio already closed, ignore
    }
}
async function main() {
    const nodeId = process.env.ML_NODE_ID;
    const peers = JSON.parse(process.env.ML_PEERS);
    const port = parseInt(process.env.ML_PORT, 10);
    const dataDir = process.env.ML_DATA_DIR;
    const curveDir = process.env.ML_CURVE_DIR;
    // ── 读取额外的环境变量 ──
    const workerPoolConcurrency = parseInt(process.env.ML_WORKER_POOL_CONCURRENCY ?? '0', 10);
    const usePerPeerDb = process.env.ML_USE_PER_PEER_DB === 'true';
    const tickMs = parseInt(process.env.ML_TICK_MS ?? '500', 10);
    const batchSize = parseInt(process.env.ML_BATCH_SIZE ?? '1', 10);
    // ── 初始化 EventBus（NAS 模式：自动发现 peer） ──
    const bus = await (0, event_bus_1.initEventBus)({
        nodeId,
        port,
        security: {
            curve: {
                nodeId,
                port,
                server: true,
                publicKeyDir: curveDir,
            },
        },
    });
    // ── 如果配置了 WorkerPool，在 EventBus 上设置 WorkerPool ──
    if (workerPoolConcurrency > 0) {
        const { EventBusWorkerPool } = await Promise.resolve().then(() => __importStar(require('./event-bus-worker-pool')));
        const workerPool = new EventBusWorkerPool();
        const peersList = peers
            .filter((pid) => pid !== nodeId)
            .map((pid) => {
            const pIdx = parseInt(pid.split('-')[1], 10);
            return { nodeId: pid, port: port + pIdx - 1, address: `tcp://127.0.0.1:${port + pIdx - 1}` };
        });
        await workerPool.start(peersList, workerPoolConcurrency, {
            curveDir,
            basePort: port,
            ackCallback: (peerId, msgId) => {
                // 收到 ACK 时调用 replication 的 notifyAcked
            },
        });
        bus.workerPool = workerPool;
        logger.info(`WorkerPool configured with concurrency=${workerPoolConcurrency}`);
    }
    // ── 确保所有 DEALER 连接建立后再发送就绪信号 ──
    // 不重试：NAS 模式下顺序启动的第一个节点看不到任何 peer 公钥是正常的。
    // 后续节点的 DEALER 会连接到此节点的 ROUTER。
    const dealerCount = bus.getPeerNodeIds?.()?.length ?? 0;
    // ── 初始化 HLC ──
    const clock = new hlc_clock_1.HlcClock();
    // ── 初始化 EventStream ──
    const es = new event_stream_1.EventStream({
        nodeId,
        eventBus: bus,
        walDir: path.join(dataDir, 'wal.bin'),
    });
    es.open();
    // 注册 ACK 回调：收到 ACK 时通知 Outbox 的 ackTracker（驱动 Outbox pending drain）
    es.registerOnAck((peerId, msgId) => {
        replication.notifyAcked(peerId);
    });
    // ── 初始化 Multi-Leader 复制层 ──
    const peersWithAddr = peers.map((pid) => {
        const pIdx = parseInt(pid.split('-')[1], 10);
        return { nodeId: pid, addr: `tcp://127.0.0.1:${port + pIdx - 1}` };
    });
    const replication = new multi_leader_replication_1.MultiLeaderReplication({
        nodeId,
        peers: peersWithAddr,
        curveDir,
        dbPath: path.join(dataDir, 'outbox.lmdb'),
        eventBus: bus,
        maxBackoffSeconds: 3, // 测试环境退避更快
        tickMs,
        batchSize,
        usePerPeerDb,
    });
    replication.start();
    // ── 初始化 GraphEngine ──
    const engine = new graph_engine_1.GraphEngine({ path: dataDir }, new overgraph_storage_1.OverGraphStorage(), es, replication);
    engine.open();
    logOut({ type: 'status', nodeId, peers: bus.dealerSockets ? [...bus.dealerSockets.keys()] : [] });
    logOut({ type: 'ready', nodeId, dealerCount });
    // ── 监听 stdin 命令 ──
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', async (line) => {
        try {
            const msg = JSON.parse(line);
            if (!msg || !msg.type)
                return;
            switch (msg.type) {
                case 'upsertNode': {
                    try {
                        const opts = { props: msg.payload.props };
                        const id = await engine.upsertNode(msg.payload.typeId, msg.payload.name, opts);
                        logOut({ type: 'writeResult', success: true, nodeId: id, name: msg.payload.name });
                    }
                    catch (err) {
                        logOut({ type: 'writeResult', success: false, error: err.message });
                    }
                    break;
                }
                case 'upsertEdge': {
                    try {
                        const src = msg.payload.from ?? '';
                        const dst = msg.payload.to ?? '';
                        const typeId = Number(msg.payload.edgeType ?? 0);
                        const edgeOpts = {};
                        if (msg.payload.props)
                            edgeOpts.props = msg.payload.props;
                        // @ts-expect-error — TS incorrectly resolves typeId as string
                        await engine.upsertEdge(src, dst, typeId, edgeOpts);
                        logOut({ type: 'edgeResult', success: true });
                    }
                    catch (err) {
                        logOut({ type: 'edgeResult', success: false, error: err.message });
                    }
                    break;
                }
                case 'batchUpsertNode': {
                    try {
                        const items = msg.payload.items ?? [];
                        const ids = [];
                        const names = [];
                        for (const item of items) {
                            const typeIdNum = Number(item.typeId);
                            const id = await engine.upsertNode(typeIdNum, item.name, { props: (item.props ?? {}) });
                            // @ts-expect-error — TS incorrectly resolves id as number
                            ids.push(id);
                            names.push(item.name);
                        }
                        logOut({ type: 'batchResult', success: true, ids, names });
                    }
                    catch (err) {
                        logOut({ type: 'batchResult', success: false, error: err.message });
                    }
                    break;
                }
                case 'getNode': {
                    const node = engine.getNode(msg.payload.id);
                    logOut({ type: 'getNodeResult', node: node ? { ...node } : null });
                    break;
                }
                case 'getDealerStatus': {
                    let cnt = bus.getPeerNodeIds?.()?.length ?? 0;
                    // WorkerPool 模式下 DEALER 在子进程中，通过 WorkerPool 统计总 DEALER 数
                    const wp = bus.workerPool;
                    if (wp) {
                        const stats = wp.getStats();
                        const totalDealers = stats.workers.reduce((sum, w) => sum + (w.peerIds?.length ?? 0), 0);
                        if (totalDealers > cnt)
                            cnt = totalDealers;
                    }
                    logOut({ type: 'dealerStatus', dealerCount: cnt });
                    break;
                }
                case 'getOutboxStats': {
                    const stats = replication.getStats();
                    logOut({ type: 'outboxStats', pending: stats.pending, workers: stats.workers });
                    break;
                }
                case 'getWorkerPoolStats': {
                    const wp = bus.workerPool;
                    const wStats = wp ? wp.getStats() : null;
                    logOut({ type: 'workerPoolStats', stats: wStats });
                    break;
                }
                case 'getPeerReports': {
                    logOut({ type: 'peerReports', reports: replication.manager?.getPeerReports?.() ?? [] });
                    break;
                }
                case 'updateConfig': {
                    try {
                        const partial = msg.payload ?? {};
                        replication.manager?.updateConfig?.(partial);
                        logOut({ type: 'configUpdated', partial });
                    }
                    catch (err) {
                        logOut({ type: 'configUpdated', success: false, error: err.message });
                    }
                    break;
                }
                case 'killWorkerPoolWorker': {
                    const wp = bus.workerPool;
                    if (wp) {
                        const stats = wp.getStats();
                        const targetIdx = msg.payload?.workerIndex;
                        const worker = typeof targetIdx === 'number' ? stats.workers[targetIdx] : stats.workers[0];
                        if (worker?.pid) {
                            try {
                                process.kill(worker.pid, 'SIGKILL');
                                logOut({ type: 'killResult', success: true, killedPid: worker.pid });
                            }
                            catch (e) {
                                logOut({ type: 'killResult', success: false, error: e.message });
                            }
                        }
                        else {
                            logOut({ type: 'killResult', success: false, error: 'no worker pid' });
                        }
                    }
                    else {
                        logOut({ type: 'killResult', success: false, error: 'no workerPool' });
                    }
                    break;
                }
                case 'getLog': {
                    logOut({ type: 'log', msg: 'check' });
                    break;
                }
                default:
                // ignore
            }
        }
        catch {
            // ignore malformed JSON
        }
    });
}
main().catch(err => {
    logger.error(`Fatal:`, err);
    process.exit(1);
});
//# sourceMappingURL=multi-leader-test-node.js.map