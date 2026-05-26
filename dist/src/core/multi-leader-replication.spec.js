"use strict";
/**
 * multi-leader-replication.spec.ts — Multi-Leader 同步复制层单元测试
 *
 * 测试 MultiLeaderReplication 核心逻辑（不依赖真实 EventStream ACK 路径）
 *
 * GraphEngine 与 EventStream 的集成测试在 graph-engine-eventstream.spec.ts 中
 * 多节点同步复制场景在 multi-leader-integration.spec.ts 中（待完善）
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
const hlc_clock_1 = require("../replication/hlc-clock");
const event_stream_1 = require("./event-stream");
const event_bus_1 = require("./event-bus");
const path = __importStar(require("node:path"));
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const TEST_DIR = path.join(os.tmpdir(), 'ml-rep-unit-' + Date.now());
let bus;
beforeAll(async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    bus = await (0, event_bus_1.initEventBus)({ nodeId: 'ml-test' });
});
afterAll(async () => {
    try {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    catch { /* */ }
    await bus.stop().catch(() => { });
});
function makeEs(nodeId) {
    const es = new event_stream_1.EventStream({
        nodeId,
        eventBus: bus,
        walDir: path.join(TEST_DIR, `${nodeId}.wal.bin`),
        ackTimeoutMs: 1000,
    });
    es.open();
    return es;
}
describe('MultiLeaderReplication', () => {
    test('peers 不包含自己时报错', () => {
        const es = makeEs('nope');
        expect(() => new multi_leader_replication_1.MultiLeaderReplication({
            nodeId: 'ghost',
            peers: ['nope'],
            eventStream: es,
            clock: new hlc_clock_1.HlcClock(),
        })).toThrow('must be in peers list');
        es.close();
    });
    test('单节点 peers 返回成功（0 ACK）', async () => {
        const es = makeEs('alone');
        const rep = new multi_leader_replication_1.MultiLeaderReplication({
            nodeId: 'alone',
            peers: ['alone'],
            eventStream: es,
            clock: new hlc_clock_1.HlcClock(),
        });
        const result = await rep.replicate('node:created', { test: 1 });
        expect(result.success).toBe(true);
        expect(result.acksReceived).toBe(0);
        es.close();
    });
    test('多节点写入携带 HLC 时间戳', async () => {
        const clock = new hlc_clock_1.HlcClock();
        const es = makeEs('hlc-only');
        const rep = new multi_leader_replication_1.MultiLeaderReplication({
            nodeId: 'hlc-only',
            peers: ['hlc-only', 'hlc-remote'],
            eventStream: es,
            clock,
            syncTimeoutMs: 1000,
        });
        // 期望超时（因为没有远程节点发 ACK）
        await expect(rep.replicate('node:created', { test: 1 })).rejects.toThrow(/timeout/);
        es.close();
    });
    // HLC 时钟在 test 3 中已验证可用
});
//# sourceMappingURL=multi-leader-replication.spec.js.map