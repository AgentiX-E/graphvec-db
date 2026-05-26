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
    // ── 初始化 EventBus（NAS 模式：自动发现 peer） ──
    const bus = await (0, event_bus_1.initEventBus)({
        nodeId,
        port,
        security: {
            curve: {
                mode: 'nas',
                nodeId,
                port,
                server: true,
                publicKeyDir: curveDir,
            },
        },
    });
    // ── 初始化 HLC ──
    const clock = new hlc_clock_1.HlcClock();
    // ── 初始化 EventStream ──
    const es = new event_stream_1.EventStream({
        nodeId,
        eventBus: bus,
        walDir: path.join(dataDir, 'wal.bin'),
    });
    es.open();
    // ── 初始化 Multi-Leader 复制层 ──
    const replication = new multi_leader_replication_1.MultiLeaderReplication({
        nodeId,
        peers,
        eventStream: es,
        clock,
        syncTimeoutMs: 5000,
    });
    // ── 初始化 GraphEngine ──
    const engine = new graph_engine_1.GraphEngine({ path: dataDir }, new overgraph_storage_1.OverGraphStorage(), es, replication);
    engine.open();
    // ── 发送就绪信号 ──
    logOut({ type: 'ready', nodeId });
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
                        const id = await engine.upsertNode(msg.payload.typeId, msg.payload.name, { props: msg.payload.props });
                        logOut({ type: 'writeResult', success: true, nodeId: id });
                    }
                    catch (err) {
                        logOut({ type: 'writeResult', success: false, error: err.message });
                    }
                    break;
                }
                case 'getNode': {
                    const node = engine.getNode(msg.payload.id);
                    logOut({ type: 'getNodeResult', node: node ? { ...node } : null });
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
    console.error(`[${process.env.ML_NODE_ID}] Fatal:`, err);
    process.exit(1);
});
//# sourceMappingURL=multi-leader-test-node.js.map