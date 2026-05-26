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
/**
 * StreamWal 压力测试
 */
const stream_wal_1 = require("./stream-wal");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const TEST_DIR = '/tmp/wal-stress-test-' + Date.now();
beforeAll(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
});
afterAll(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
});
describe('StreamWal 压力测试', () => {
    test('并发 append 1000 条消息', () => {
        const wal = new stream_wal_1.StreamWal(path.join(TEST_DIR, 'concurrent-1000.wal'));
        wal.open();
        const batch = [];
        for (let i = 0; i < 1000; i++) {
            batch.push({
                msgId: `node-${i}`,
                seq: i,
                nodeId: 'test-node',
                timestamp: Date.now(),
                type: 'test:msg',
                data: { idx: i, payload: 'x'.repeat(100) },
            });
        }
        for (const msg of batch) {
            wal.append(msg);
        }
        const entries = wal.replay(0);
        expect(entries.length).toBe(1000);
        entries.forEach((msg, i) => {
            expect(msg.msgId).toBe(`node-${i}`);
        });
        wal.close();
    });
    test('ACK + markConsumed 后 replay 不包含已消费消息', () => {
        const wal = new stream_wal_1.StreamWal(path.join(TEST_DIR, 'consume-test.wal'));
        wal.open();
        for (let i = 0; i < 500; i++) {
            wal.append({
                msgId: `m-${i}`,
                seq: i,
                nodeId: 'test-node',
                timestamp: Date.now(),
                type: 'test:consume',
                data: { i },
            });
        }
        // consume 前 250 条
        const ids = [];
        for (let i = 0; i < 250; i++) {
            ids.push(`m-${i}`);
        }
        wal.markConsumed(ids);
        // 追加更多
        for (let i = 500; i < 600; i++) {
            wal.append({
                msgId: `m-${i}`,
                seq: i,
                nodeId: 'test-node',
                timestamp: Date.now(),
                type: 'test:consume',
                data: { i },
            });
        }
        // replay 应只返回未 CONSUMED 的: 250~599 = 350
        const entries = wal.replay(0);
        expect(entries.length).toBe(350);
        entries.forEach(msg => {
            const idx = parseInt(msg.msgId.split('-')[1], 10);
            expect(idx).toBeGreaterThanOrEqual(250);
        });
        wal.close();
    });
    test('close + reopen 数据完整性', () => {
        const fp = path.join(TEST_DIR, 'reopen-test.wal');
        // 写入
        const wal1 = new stream_wal_1.StreamWal(fp);
        wal1.open();
        for (let i = 0; i < 2000; i++) {
            wal1.append({
                msgId: `re-${i}`,
                seq: i,
                nodeId: 'test',
                timestamp: Date.now(),
                type: 'test:re',
                data: { i },
            });
        }
        wal1.close();
        // 重新打开
        const wal2 = new stream_wal_1.StreamWal(fp);
        wal2.open();
        const entries = wal2.replay(0);
        expect(entries.length).toBe(2000);
        entries.forEach((msg, i) => {
            expect(msg.msgId).toBe(`re-${i}`);
        });
        wal2.close();
    });
});
//# sourceMappingURL=stream-wal-stress.spec.js.map