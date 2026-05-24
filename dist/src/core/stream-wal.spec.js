"use strict";
/**
 * StreamWal 单元测试
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
const stream_wal_1 = require("./stream-wal");
const path = __importStar(require("node:path"));
const fs = __importStar(require("node:fs"));
const TEST_DIR = path.join('/tmp', `stream-wal-test-${Date.now()}`);
function makeMsg(seq, overrides) {
    return {
        msgId: `node-a-${seq}`,
        seq,
        nodeId: 'node-a',
        timestamp: Date.now(),
        type: 'node:created',
        data: { id: seq },
        ...overrides,
    };
}
beforeAll(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
});
afterAll(() => {
    try {
        fs.rmSync(TEST_DIR, { recursive: true });
    }
    catch { /* ignore */ }
});
describe('StreamWal', () => {
    let wal;
    beforeEach(() => {
        wal = new stream_wal_1.StreamWal(path.join(TEST_DIR, 'test.wal'));
        wal.open();
    });
    afterEach(() => {
        wal.drop();
    });
    describe('基本 append / read / count', () => {
        it('append 后 size 增加', () => {
            expect(wal.size).toBe(0);
            wal.append(makeMsg(1));
            expect(wal.size).toBe(1);
            wal.append(makeMsg(2));
            expect(wal.size).toBe(2);
        });
        it('readPending 返回超时的 PENDING 消息', () => {
            const past = Date.now() - 10000;
            const now = Date.now();
            wal.append(makeMsg(1, { timestamp: past }));
            wal.append(makeMsg(2, { timestamp: now + 10000 })); // 未超时
            const pending = wal.readPending(Date.now());
            expect(pending.length).toBe(1);
            expect(pending[0].seq).toBe(1);
        });
        it('acknowledge 标记后不再被 readPending 返回', () => {
            const past = Date.now() - 10000;
            wal.append(makeMsg(1, { timestamp: past }));
            wal.acknowledge(['node-a-1']);
            const pending = wal.readPending(Date.now());
            expect(pending.length).toBe(0);
        });
    });
    describe('acknowledge', () => {
        it('支持多种 ID 批量确认', () => {
            wal.append(makeMsg(1));
            wal.append(makeMsg(2));
            wal.append(makeMsg(3));
            wal.acknowledge(new Set(['node-a-1', 'node-a-3']));
            const past = Date.now() + 60000; // 所有消息都已超时
            const pending = wal.readPending(past);
            expect(pending.length).toBe(1);
            expect(pending[0].seq).toBe(2);
        });
        it('空 Set 不产生副作用', () => {
            wal.append(makeMsg(1));
            wal.acknowledge([]);
            expect(wal.size).toBe(1);
        });
    });
    describe('markConsumed', () => {
        it('标记消费后 replay 不再包含', () => {
            wal.append(makeMsg(1));
            wal.append(makeMsg(2));
            wal.markConsumed(['node-a-1']);
            const replayed = wal.replay(0);
            expect(replayed.length).toBe(1);
            expect(replayed[0].seq).toBe(2);
        });
    });
    describe('replay', () => {
        it('从指定 seq 回放', () => {
            for (let i = 1; i <= 5; i++)
                wal.append(makeMsg(i));
            const replayed = wal.replay(3);
            expect(replayed.length).toBe(3); // seq 3, 4, 5
            expect(replayed.map(m => m.seq)).toEqual([3, 4, 5]);
        });
        it('ACKED 的消息也应该回放（等待重试的超时确认）', () => {
            wal.append(makeMsg(1));
            wal.append(makeMsg(2));
            wal.acknowledge(['node-a-1']);
            const replayed = wal.replay(0);
            expect(replayed.length).toBe(2); // ACKED 也会回放（确认重试场景暂不需要）
        });
    });
    describe('prune', () => {
        it('只保留 PENDING 消息', () => {
            wal.append(makeMsg(1));
            wal.append(makeMsg(2));
            wal.append(makeMsg(3));
            wal.acknowledge(['node-a-2']);
            const remain = wal.prune();
            expect(remain).toBe(2); // seq 1, 3 都是 PENDING（1 没确认，3 没确认）
        });
    });
    describe('pruneByTimestamp', () => {
        it('清理早于时间戳的 ACKED/CONSUMED', () => {
            const oldTime = Date.now() - 10000;
            wal.append(makeMsg(1, { timestamp: oldTime }));
            wal.append(makeMsg(2));
            wal.acknowledge(['node-a-1']);
            wal.acknowledge(['node-a-2']);
            const remain = wal.pruneByTimestamp(Date.now() - 5000);
            // msg 1 已被 ACK 且时间戳 < 阈值 → 清理
            // msg 2 已被 ACK 但时间戳 > 阈值 → 保留
            expect(remain).toBe(1);
        });
    });
    describe('文件持久化', () => {
        it('重新打开后应保留消息', () => {
            wal.append(makeMsg(1));
            wal.append(makeMsg(2));
            wal.close();
            const wal2 = new stream_wal_1.StreamWal(path.join(TEST_DIR, 'test.wal'));
            wal2.open();
            expect(wal2.size).toBe(2);
            const pending = wal2.readPending(Date.now() + 60000);
            expect(pending.length).toBe(2);
            wal2.drop();
        });
    });
});
//# sourceMappingURL=stream-wal.spec.js.map