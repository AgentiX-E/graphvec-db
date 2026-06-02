"use strict";
/**
 * multi-leader-replication.spec.ts — Multi-Leader 复制层单元测试
 *
 * 测试 Outbox Worker 方案的核心逻辑：
 * 1. replicate 写入 Outbox 后立即返回 success
 * 2. 构造参数验证
 * 3. Worker 生命周期
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
const multi_leader_replication_1 = require("./multi-leader-replication");
const outbox_replication_1 = require("./outbox-replication");
const path = __importStar(require("node:path"));
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const TEST_DIR = path.join(os.tmpdir(), 'ml-rep-unit-' + Date.now());
// 模拟的 eventBus
function mockEventBus() {
    return {
        send: async () => { },
        _recoverDealerByNodeId: async () => { },
    };
}
beforeAll(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
});
afterAll(() => {
    try {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    catch { /* */ }
});
describe('MultiLeaderReplication', () => {
    test('单节点 peers 返回成功（无 remote peer）', async () => {
        const rep = new multi_leader_replication_1.MultiLeaderReplication({
            nodeId: 'alone',
            peers: [{ nodeId: 'alone', addr: 'tcp://127.0.0.1:1800' }],
            curveDir: TEST_DIR,
            dbPath: path.join(TEST_DIR, 'outbox-alone'),
            eventBus: mockEventBus(),
        });
        const result = await rep.replicate('node:created', { test: 1 });
        expect(result.success).toBe(true);
        expect(result.expectedAcks).toBe(0);
        rep.stop();
    });
    test('多节点 replicate 写入 Outbox 成功', async () => {
        const rep = new multi_leader_replication_1.MultiLeaderReplication({
            nodeId: 'local',
            peers: [
                { nodeId: 'local', addr: 'tcp://127.0.0.1:1800' },
                { nodeId: 'remote-1', addr: 'tcp://127.0.0.1:1801' },
                { nodeId: 'remote-2', addr: 'tcp://127.0.0.1:1802' },
            ],
            curveDir: TEST_DIR,
            dbPath: path.join(TEST_DIR, 'outbox-multi'),
            eventBus: mockEventBus(),
        });
        const result = await rep.replicate('node:created', { test: 1 });
        expect(result.success).toBe(true);
        expect(result.expectedAcks).toBe(2); // 2 remote peers
        expect(rep.getStats().workers).toBe(2);
        rep.stop();
    });
    test('Outbox 持久化和操作', () => {
        const dbPath = path.join(TEST_DIR, 'outbox-unit.lmdb');
        const outbox = new outbox_replication_1.Outbox(dbPath);
        const seq1 = outbox.add({
            msgId: 'msg-1',
            targetNodeId: 'peer-1',
            type: 'node:created',
            payload: '{"id":"n1"}',
            createdAt: Date.now(),
            delivered: false,
            deliveredAt: 0,
        });
        expect(seq1).toBe(1);
        const seq2 = outbox.add({
            msgId: 'msg-2',
            targetNodeId: 'peer-1',
            type: 'node:created',
            payload: '{"id":"n2"}',
            createdAt: Date.now(),
            delivered: false,
            deliveredAt: 0,
        });
        expect(seq2).toBe(2);
        // fetchOldestPending 取最早 pending
        const oldest = outbox.fetchOldestPending('peer-1');
        expect(oldest).not.toBeNull();
        expect(oldest.msgId).toBe('msg-1');
        expect(oldest.seq).toBe(1);
        // 标记已送达后，不等 peer-1 pending
        outbox.markDeliveredBatch([seq1]);
        const oldest2 = outbox.fetchOldestPending('peer-1');
        expect(oldest2).not.toBeNull();
        expect(oldest2.msgId).toBe('msg-2');
        outbox.close();
    });
    test('Outbox 清理过期记录', () => {
        const dbPath = path.join(TEST_DIR, 'outbox-clean.lmdb');
        const outbox = new outbox_replication_1.Outbox(dbPath);
        const now = Date.now();
        outbox.add({
            msgId: 'old',
            targetNodeId: 'peer-1',
            type: 'node:created',
            payload: '{}',
            createdAt: now - 30 * 86400000, // 30 days ago
            delivered: false,
            deliveredAt: 0,
        });
        outbox.add({
            msgId: 'delivered-old',
            targetNodeId: 'peer-1',
            type: 'node:created',
            payload: '{}',
            createdAt: now - 30 * 86400000,
            delivered: true,
            deliveredAt: now - 20 * 86400000, // 20 days ago delivered
        });
        outbox.add({
            msgId: 'recent',
            targetNodeId: 'peer-1',
            type: 'node:created',
            payload: '{}',
            createdAt: now,
            delivered: true,
            deliveredAt: now,
        });
        const cleaned = outbox.cleanDeliveredBefore(now - 14 * 86400000); // 14 days cutoff
        expect(cleaned).toBe(1); // only 'delivered-old'
        expect(outbox.getPendingCount()).toBe(1); // 'old' is still pending (not delivered)
        outbox.close();
    });
    test('getPendingCountForPeer 区分不同 peer', () => {
        const dbPath = path.join(TEST_DIR, 'outbox-peerCnt.lmdb');
        const outbox = new outbox_replication_1.Outbox(dbPath);
        outbox.add({ msgId: 'a', targetNodeId: 'peer-1', type: 't', payload: '{}', createdAt: 1, delivered: false, deliveredAt: 0 });
        outbox.add({ msgId: 'b', targetNodeId: 'peer-2', type: 't', payload: '{}', createdAt: 2, delivered: false, deliveredAt: 0 });
        outbox.add({ msgId: 'c', targetNodeId: 'peer-1', type: 't', payload: '{}', createdAt: 3, delivered: false, deliveredAt: 0 });
        expect(outbox.getPendingCountForPeer('peer-1')).toBe(2);
        expect(outbox.getPendingCountForPeer('peer-2')).toBe(1);
        expect(outbox.getPendingCountForPeer('peer-3')).toBe(0);
        outbox.close();
    });
    test('cleanDeliveredBefore 精确边界', () => {
        const dbPath = path.join(TEST_DIR, 'outbox-boundary.lmdb');
        const outbox = new outbox_replication_1.Outbox(dbPath);
        const now = Date.now();
        outbox.add({ msgId: 'exactly', targetNodeId: 'p', type: 't', payload: '{}', createdAt: 1, delivered: true, deliveredAt: now });
        // cutoff = now, deliveredAt < cutoff 才删除。deliveredAt = now 不小于 now，不应删除
        const cleaned = outbox.cleanDeliveredBefore(now);
        expect(cleaned).toBe(0);
        // deliveredAt < now - 1ms
        const cleaned2 = outbox.cleanDeliveredBefore(now + 1);
        expect(cleaned2).toBe(1);
        outbox.close();
    });
    test('OutboxReplicationManager updateConfig 热加载', () => {
        const mgr = new outbox_replication_1.OutboxReplicationManager({
            nodeId: 'test',
            peers: [{ nodeId: 'p1', addr: 'tcp://127.0.0.1:1899' }, { nodeId: 'p2', addr: 'tcp://127.0.0.1:1898' }],
            curveDir: TEST_DIR,
            dbPath: path.join(TEST_DIR, 'outbox-hotload'),
            eventBus: mockEventBus(),
            tickMs: 999,
            maxBackoffSeconds: 123,
            housekeepingIntervalMs: 3600000,
            entryTTLDays: 7,
        });
        // 初始值
        const initial = mgr.getConfig();
        expect(initial.tickMs).toBe(999);
        expect(initial.entryTTLDays).toBe(7);
        // 热加载更新
        mgr.updateConfig({ tickMs: 500, maxBackoffSeconds: 30 });
        const updated = mgr.getConfig();
        expect(updated.tickMs).toBe(500);
        expect(updated.maxBackoffSeconds).toBe(30);
        expect(updated.entryTTLDays).toBe(7); // 未变更
        mgr.stop();
    });
    test('loadConfigFile 从文件加载配置', () => {
        const configPath = path.join(TEST_DIR, 'ml-config.json');
        fs.writeFileSync(configPath, JSON.stringify({ tickMs: 888, maxBackoffSeconds: 42 }), 'utf-8');
        // 设置环境变量
        const origEnv = process.env.ML_CONFIG_PATH;
        process.env.ML_CONFIG_PATH = configPath;
        const mgr = new outbox_replication_1.OutboxReplicationManager({
            nodeId: 'test',
            peers: [],
            curveDir: TEST_DIR,
            dbPath: path.join(TEST_DIR, 'outbox-load'),
            eventBus: mockEventBus(),
        });
        // 启动时自动 loadConfigFile
        mgr.start();
        const config = mgr.getConfig();
        expect(config.tickMs).toBe(888);
        expect(config.maxBackoffSeconds).toBe(42);
        mgr.stop();
        if (origEnv)
            process.env.ML_CONFIG_PATH = origEnv;
        else
            delete process.env.ML_CONFIG_PATH;
    });
    test('saveConfigFile 持久化到文件', () => {
        const configPath = path.join(TEST_DIR, 'ml-config-save.json');
        const origEnv = process.env.ML_CONFIG_PATH;
        process.env.ML_CONFIG_PATH = configPath;
        const mgr = new outbox_replication_1.OutboxReplicationManager({
            nodeId: 'test',
            peers: [],
            curveDir: TEST_DIR,
            dbPath: path.join(TEST_DIR, 'outbox-save'),
            eventBus: mockEventBus(),
            tickMs: 300,
            entryTTLDays: 10,
        });
        mgr.saveConfigFile();
        const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        expect(content.tickMs).toBe(300);
        expect(content.entryTTLDays).toBe(10);
        expect(content.housekeepingIntervalMs).toBe(86400000);
        // 验证 updateConfig 自动写文件
        mgr.updateConfig({ tickMs: 500 });
        const reloaded = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        expect(reloaded.tickMs).toBe(500);
        mgr.stop();
        if (origEnv)
            process.env.ML_CONFIG_PATH = origEnv;
        else
            delete process.env.ML_CONFIG_PATH;
    });
    test('updateConfig 后进程重启从文件恢复', () => {
        const configPath = path.join(TEST_DIR, 'ml-config-restore.json');
        const origEnv = process.env.ML_CONFIG_PATH;
        // 第一次启动
        process.env.ML_CONFIG_PATH = configPath;
        const mgr1 = new outbox_replication_1.OutboxReplicationManager({
            nodeId: 'test',
            peers: [],
            curveDir: TEST_DIR,
            dbPath: path.join(TEST_DIR, 'outbox-restore'),
            eventBus: mockEventBus(),
        });
        mgr1.updateConfig({ tickMs: 777 });
        mgr1.stop();
        // 模拟进程重启
        const mgr2 = new outbox_replication_1.OutboxReplicationManager({
            nodeId: 'test',
            peers: [],
            curveDir: TEST_DIR,
            dbPath: path.join(TEST_DIR, 'outbox-restore'),
            eventBus: mockEventBus(),
        });
        mgr2.start(); // start 中调用 loadConfigFile
        const config = mgr2.getConfig();
        expect(config.tickMs).toBe(777);
        mgr2.stop();
        if (origEnv)
            process.env.ML_CONFIG_PATH = origEnv;
        else
            delete process.env.ML_CONFIG_PATH;
    });
});
//# sourceMappingURL=multi-leader-replication.spec.js.map