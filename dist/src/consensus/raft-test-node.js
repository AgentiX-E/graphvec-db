"use strict";
/**
 * raft-test-node.ts — Raft 跨进程集成测试子进程
 *
 * 通过 stdin JSON 行协议接收命令，stdout 返回结果。
 *
 * 启动：npx tsx src/consensus/raft-test-node.ts
 * 环境变量：
 *   RT_NODE_ID — 节点 ID
 *   RT_PEERS  — JSON: ["2:127.0.0.1:17551", "3:127.0.0.1:17552"]
 *   RT_PORT   — TCP 监听端口
 *   RT_DATA_DIR — 数据目录
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
const raft_logic_consensus_1 = require("./raft-logic-consensus");
const fs = __importStar(require("node:fs"));
const readline = __importStar(require("node:readline"));
const logger_1 = require("../ops/logger");
const logger = new logger_1.Logger('RaftTestNode');
function logOut(msg) {
    const str = JSON.stringify(msg) + '\n';
    try {
        fs.writeSync(process.stdout.fd, str);
    }
    catch { }
}
async function main() {
    const nodeId = process.env.RT_NODE_ID;
    const peers = JSON.parse(process.env.RT_PEERS);
    const port = parseInt(process.env.RT_PORT, 10);
    const dataDir = process.env.RT_DATA_DIR;
    // 确保数据目录
    fs.mkdirSync(dataDir, { recursive: true });
    // 修改 cwd 使 SqliteStorage 写到数据目录
    process.chdir(dataDir);
    // ── 为 raft-logic mock 注入一个真实的 raft-logic 模块 ──
    // 由于 raft-logic 可选依赖在实际环境中可能未安装，
    // 我们构造一个 mock raftLogic 模块
    const mockRaftModule = {
        RaftNode: class MockRaftNode {
            _id;
            _peers;
            _transport;
            _apply;
            _status;
            _leaderStableResolve = null;
            // 用于 InMemoryTransport 的静态注册表
            static instances = [];
            constructor(opts) {
                this._id = opts.id;
                this._peers = opts.peers || [];
                this._transport = opts.transport;
                this._apply = opts.apply;
                this._status = { role: 'follower', leaderId: null, term: 0 };
                MockRaftNode.instances.push(this);
            }
            async start() {
                // 注册消息处理器，接收 TCP 消息
                const self = this;
                this._transport.onMessage(async (from, msgBuf) => {
                    // 收到消息后通过 apply 处理（模拟 leader → follower 复制）
                    if (self._apply) {
                        await self._apply({ data: Buffer.from(msgBuf) });
                    }
                });
                // 启动后延迟触发 leader 选举（固定让最小 ID 的节点当 leader）
                setTimeout(() => {
                    const sorted = [...this._peers, this._id].sort();
                    if (this._id === sorted[0]) {
                        this._status = { role: 'leader', leaderId: String(this._id), term: 1 };
                        if (this._leaderStableResolve) {
                            this._leaderStableResolve();
                            this._leaderStableResolve = null;
                        }
                    }
                    else {
                        this._status = { role: 'follower', leaderId: String(sorted[0]), term: 1 };
                    }
                }, 200);
                // 连接 peer
                for (const peerId of this._peers) {
                    if (this._transport.connectTo) {
                        // 查找 peer 地址（从外部传入）
                    }
                }
                logOut({ type: 'started', nodeId: this._id });
            }
            async stop() {
                const idx = MockRaftNode.instances.indexOf(this);
                if (idx >= 0)
                    MockRaftNode.instances.splice(idx, 1);
            }
            async clientRequest(data, opts) {
                if (this._status.role === 'leader') {
                    // Leader: 广播给 followers
                    for (const peerId of this._peers) {
                        if (this._transport.sendTo) {
                            this._transport.sendTo(String(peerId), Buffer.from(data, 'base64'));
                        }
                    }
                    return { ok: true };
                }
                return { ok: false };
            }
            async readIndex(opts) { }
            status() {
                return { ...this._status };
            }
            async waitForLeaderStable(opts) {
                if (this._status.leaderId)
                    return;
                return new Promise(resolve => {
                    this._leaderStableResolve = resolve;
                });
            }
        },
        SqliteStorage: class MockSqliteStorage {
            async open() { }
        },
        InMemoryTransport: class InMemMock {
            sendTo(peerId, msg) { return false; }
            onMessage(handler) { }
        },
        ready: Promise.resolve(),
    };
    const config = {
        mode: 'raft-logic',
        nodeId,
        peers,
        transportPort: port,
    };
    const consensus = new raft_logic_consensus_1.RaftLogicConsensus(config, mockRaftModule);
    await consensus.start();
    logOut({ type: 'ready', nodeId });
    // ── 监听 stdin 命令 ──
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', async (line) => {
        try {
            const msg = JSON.parse(line);
            if (!msg || !msg.type)
                return;
            switch (msg.type) {
                case 'propose': {
                    try {
                        const data = Buffer.from(msg.payload?.data ?? '', 'utf-8');
                        const result = await consensus.propose(data, msg.payload?.timeout ?? 5000);
                        logOut({ type: 'proposeResult', ok: result.ok });
                    }
                    catch (err) {
                        logOut({ type: 'proposeResult', ok: false, error: err.message });
                    }
                    break;
                }
                case 'getRole': {
                    logOut({ type: 'roleResult', role: consensus.getRole(), leaderId: consensus.getLeaderId(), term: consensus.getTerm() });
                    break;
                }
                case 'waitForLeader': {
                    try {
                        await consensus.waitForLeader(msg.payload?.timeout ?? 5000);
                        logOut({ type: 'leaderReady', leaderId: consensus.getLeaderId() });
                    }
                    catch (err) {
                        logOut({ type: 'leaderReady', error: err.message });
                    }
                    break;
                }
                case 'stop': {
                    await consensus.stop();
                    logOut({ type: 'stopped' });
                    process.exit(0);
                    break;
                }
                default:
                // ignore
            }
        }
        catch { }
    });
}
main().catch(err => {
    logger.error(`Fatal:`, err);
    process.exit(1);
});
//# sourceMappingURL=raft-test-node.js.map