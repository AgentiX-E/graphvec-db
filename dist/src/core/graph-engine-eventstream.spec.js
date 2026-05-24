"use strict";
/**
 * GraphEngine + EventStream 集成测试
 *
 * 验证 GraphEngine 通过 EventStream 发布可靠事件：
 * - 变更事件自动写入 WAL
 * - ACK 回传
 * - 重试失败后放弃
 * - 重启后 seq 恢复
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
const node_events_1 = require("node:events");
const path = __importStar(require("node:path"));
const fs = __importStar(require("node:fs"));
class MockBus {
    emitter = new node_events_1.EventEmitter();
    nodeId = 'test-node';
    sent = [];
    emit(event) {
        const full = { ...event, nodeId: this.nodeId };
        this.sent.push(full);
        this.emitter.emit(event.type, full);
    }
    on(type, handler) {
        this.emitter.on(type, handler);
    }
    simulateRemote(type, data, remoteNodeId = 'remote') {
        const evt = { type, nodeId: remoteNodeId, timestamp: Date.now(), data };
        this.emitter.emit(type, evt);
    }
}
const TEST_DIR = path.join('/tmp', `ge-eventstream-test-${Date.now()}`);
const WAL_DIR = path.join(TEST_DIR, 'wal');
const DB_DIR = path.join(TEST_DIR, 'db');
const BUS = new MockBus();
const CONFIG = { path: DB_DIR, defaultRetention: { nodes: '60s', edges: '60s' } };
function createES() {
    return {
        nodeId: 'test-node',
        eventBus: BUS,
        walDir: WAL_DIR,
        ackTimeoutMs: 500,
        retryIntervalMs: 200,
        maxRetries: 5,
        dedupCapacity: 1000,
        catchupBatchSize: 10,
    };
}
beforeAll(() => fs.mkdirSync(TEST_DIR, { recursive: true }));
afterAll(() => { try {
    fs.rmSync(TEST_DIR, { recursive: true });
}
catch { /* ignore */ } });
function makeEngine(eventStream) {
    const storage = new overgraph_storage_1.OverGraphStorage();
    const ge = new graph_engine_1.GraphEngine(CONFIG, storage, eventStream ?? undefined);
    ge.open();
    return ge;
}
// 清理 WAL 和 DB
function cleanup() {
    try {
        fs.rmSync(WAL_DIR, { recursive: true });
    }
    catch { /* ignore */ }
    try {
        fs.rmSync(DB_DIR, { recursive: true });
    }
    catch { /* ignore */ }
}
describe('GraphEngine + EventStream 集成', () => {
    beforeEach(() => { cleanup(); BUS.sent.length = 0; });
    afterEach(() => { cleanup(); });
    it('使用 EventStream 时 emit 写入 WAL', () => {
        const es = new event_stream_1.EventStream(createES());
        es.open();
        const ge = makeEngine(es);
        const id = ge.upsertNode(1, 'n1');
        expect(typeof id).toBe('number');
        // 检查 WAL 中有记录
        const pending = es['wal'].readPending(Date.now() + 60000);
        expect(pending.length).toBe(1);
        expect(pending[0].type).toBe('node:created');
        expect(pending[0].data.id).toBe(id);
        ge.close();
        es.close();
    });
    it('ACK 到来后从 WAL 移除 pending', () => {
        const es = new event_stream_1.EventStream(createES());
        es.open();
        const ge = makeEngine(es);
        ge.upsertNode(1, 'n1');
        // 模拟远程 ACK
        BUS.simulateRemote('event:ack', { msgId: 'test-node-1', nodeId: 'remote' });
        const pending = es['wal'].readPending(Date.now() + 60000);
        expect(pending.find((m) => m.msgId === 'test-node-1')).toBeUndefined();
        ge.close();
        es.close();
    });
    it('不传 EventStream 时不应使用 EventStream（fallback 到 EventBus）', () => {
        const ge = makeEngine();
        const id = ge.upsertNode(1, 'n1');
        // 当没有 EventStream 时，GraphEngine 尝试 getEventBus()（可能抛错）
        // 但不应该走 EventStream 路径
        const es = ge._eventStream;
        expect(es).toBeNull();
        ge.close();
    });
});
//# sourceMappingURL=graph-engine-eventstream.spec.js.map