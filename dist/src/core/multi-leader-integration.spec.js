"use strict";
/**
 * multi-leader-integration.spec.ts — Multi-Leader 3 进程集成测试
 *
 * 启动 3 个独立子进程（通过 npx tsx 执行），通过 stdin/stdout JSON line 通信。
 * EventBus 使用 NAS 模式（共享曲线密钥目录），自动发现 peer。
 *
 * 使用方式：
 *   npx jest src/core/multi-leader-integration.spec.ts --forceExit
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
const node_child_process_1 = require("node:child_process");
const path = __importStar(require("node:path"));
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TEST_DIR = path.join(os.tmpdir(), `ml-integration-${Date.now()}`);
describe('Multi-Leader 3 进程集成测试', () => {
    const nodes = [];
    const nodeIds = ['node-1', 'node-2'];
    const basePort = 16550 + Math.floor(Math.random() * 10000);
    beforeAll(async () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        const curveDir = path.join(TEST_DIR, 'curve-keys');
        fs.mkdirSync(curveDir, { recursive: true });
        // 先启动所有进程
        for (let i = 0; i < nodeIds.length; i++) {
            const nodeId = nodeIds[i];
            const port = basePort + i;
            const dataDir = path.join(TEST_DIR, nodeId);
            fs.mkdirSync(dataDir, { recursive: true });
            const proc = (0, node_child_process_1.spawn)('npx', ['tsx', path.join(__dirname, 'multi-leader-test-node.ts')], {
                env: {
                    ...process.env,
                    ML_NODE_ID: nodeId,
                    ML_PEERS: JSON.stringify(nodeIds),
                    ML_PORT: String(port),
                    ML_DATA_DIR: dataDir,
                    ML_CURVE_DIR: curveDir,
                },
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            let errBuf = '';
            proc.stderr?.on('data', (d) => { errBuf += d.toString(); });
            proc.on('exit', (code) => {
                if (errBuf)
                    console.log(`[${nodeId}] stderr:`, errBuf.slice(0, 300));
            });
            nodes.push({ proc, nodeId, port, stdin: (msg) => { proc.stdin?.write(JSON.stringify(msg) + '\n'); } });
            // 依次启动，每启动一个进程等 500ms，给其它进程写 .pub 的时间
            await sleep(500);
        }
        // 等 3s 让所有进程写 .pub 文件
        await sleep(3000);
        // 等待所有节点就绪（通过 stdout JSON line 检测）
        await Promise.all(nodes.map((n) => new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(`Node ${n.nodeId} (port ${n.port}) timeout waiting for ready`)), 45000);
            let buf = '';
            const onData = (chunk) => {
                buf += chunk.toString();
                const lines = buf.split('\n');
                buf = lines.pop() || '';
                for (const line of lines) {
                    try {
                        const msg = JSON.parse(line);
                        if (msg?.type === 'ready') {
                            console.log(`✅ ${n.nodeId} ready`);
                            clearTimeout(timeout);
                            n.proc.stdout?.off('data', onData);
                            resolve();
                            return;
                        }
                    }
                    catch { /* partial JSON line */ }
                }
            };
            n.proc.stdout?.on('data', onData);
            n.proc.on('exit', (code) => {
                clearTimeout(timeout);
                reject(new Error(`Node ${n.nodeId} exited with code ${code} (before ready)`));
            });
        })));
    }, 60000);
    afterAll(async () => {
        for (const n of nodes) {
            n.proc.stdin?.end();
            n.proc.kill();
        }
        try {
            fs.rmSync(TEST_DIR, { recursive: true, force: true });
        }
        catch { /* ignore */ }
    }, 10000);
    test('2 节点写入后远程数据持久化验证', async () => {
        const writeStart = Date.now();
        const node1 = nodes[0];
        const node2 = nodes[1];
        const createdId = await new Promise((resolve, reject) => {
            node1.stdin({ type: 'upsertNode', payload: { typeId: 1, name: 'ml-test-node', props: { color: 'red' } } });
            const timeout = setTimeout(() => reject(new Error('write timeout')), 15000);
            let buf = '';
            const onData = (chunk) => {
                buf += chunk.toString();
                const lines = buf.split('\n');
                buf = lines.pop() || '';
                for (const line of lines) {
                    try {
                        const msg = JSON.parse(line);
                        if (msg?.type === 'writeResult') {
                            clearTimeout(timeout);
                            node1.proc.stdout?.off('data', onData);
                            resolve(msg.nodeId);
                            return;
                        }
                    }
                    catch { /* partial */ }
                }
            };
            node1.proc.stdout?.on('data', onData);
        });
        const writeElapsed = Date.now() - writeStart;
        console.log(`⏱ write+ACK round-trip: ${writeElapsed}ms`);
        expect(writeElapsed).toBeLessThan(1000);
        expect(createdId).toBeDefined();
        // 确认节点 2 已持久化
        node2.stdin({ type: 'getNode', payload: { id: createdId } });
        const remoteNode = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('remote getNode timeout')), 10000);
            let buf = '';
            const onData = (chunk) => {
                buf += chunk.toString();
                const lines = buf.split('\n');
                buf = lines.pop() || '';
                for (const line of lines) {
                    try {
                        const msg = JSON.parse(line);
                        if (msg?.type === 'getNodeResult') {
                            clearTimeout(timeout);
                            node2.proc.stdout?.off('data', onData);
                            resolve(msg.node);
                            return;
                        }
                    }
                    catch { /* partial */ }
                }
            };
            node2.proc.stdout?.on('data', onData);
        });
        expect(remoteNode).not.toBeNull();
        expect(remoteNode.name).toBe('ml-test-node');
    }, 60000);
});
//# sourceMappingURL=multi-leader-integration.spec.js.map