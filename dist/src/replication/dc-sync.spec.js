"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const dc_sync_1 = require("./dc-sync");
const delta_sync_1 = require("./delta-sync");
const hlc_clock_1 = require("./hlc-clock");
const graph_engine_1 = require("../core/graph-engine");
jest.mock('../core/graph-engine', () => {
    return {
        GraphEngine: jest.fn().mockImplementation(() => ({
            upsertNode: jest.fn(),
            open: jest.fn(),
            close: jest.fn(),
            isOpen: false,
            stats: jest.fn().mockReturnValue({ nodeCount: 0, edgeCount: 0, diskSizeBytes: 0 }),
            queryPattern: jest.fn().mockReturnValue([]),
        })),
    };
});
// ──────────────────────────────────────────
// resolveConflict 纯函数单元测试
// ──────────────────────────────────────────
describe('resolveConflict', () => {
    function makeTs(value, extra = []) {
        return new Uint8Array([
            ...Array(8).fill(0).map((_, i) => (value >> (56 - i * 8)) & 0xff).filter((_, i) => i >= 8 - Math.ceil(Math.log2(value + 1) / 8) || (i < 8 && ((value >> (56 - i * 8)) & 0xff) !== 0)),
            ...extra
        ]);
    }
    // 用更可靠的 HLC 编码方式
    function encodeHlc(wallTime, logical) {
        const buf = new ArrayBuffer(12);
        const view = new DataView(buf);
        view.setBigUint64(0, wallTime, false); // big-endian
        view.setUint32(8, logical, false);
        return new Uint8Array(buf);
    }
    test('should accept when no local timestamp (first sync)', () => {
        const remote = {
            dcId: 'dc-west',
            hlcTimestamp: encodeHlc(2000n, 1),
            delta: { nodes: { a: { x: { value: 1 } } } },
            batchId: 'b1',
        };
        expect((0, dc_sync_1.resolveConflict)(remote, null, 'lww')).toBe('accept');
    });
    test('should reject remote when local is newer (LWW)', () => {
        const remote = { hlcTimestamp: encodeHlc(1000n, 1) };
        const local = encodeHlc(2000n, 1);
        expect((0, dc_sync_1.resolveConflict)(remote, local, 'lww')).toBe('reject');
    });
    test('should accept remote when remote is newer (LWW)', () => {
        const remote = { hlcTimestamp: encodeHlc(3000n, 1) };
        const local = encodeHlc(1000n, 1);
        expect((0, dc_sync_1.resolveConflict)(remote, local, 'lww')).toBe('accept');
    });
    test('should accept when timestamps are identical', () => {
        const ts = encodeHlc(1500n, 5);
        const remote = { hlcTimestamp: ts };
        expect((0, dc_sync_1.resolveConflict)(remote, ts, 'lww')).toBe('accept');
    });
    test('should compare logical component when wall times equal', () => {
        const remote = { hlcTimestamp: encodeHlc(1000n, 10) };
        const local = encodeHlc(1000n, 5);
        // remote logical=10 > local logical=5 → accept
        expect((0, dc_sync_1.resolveConflict)(remote, local, 'lww')).toBe('accept');
    });
    test('should reject remote when local logical is higher', () => {
        const remote = { hlcTimestamp: encodeHlc(1000n, 3) };
        const local = encodeHlc(1000n, 7);
        expect((0, dc_sync_1.resolveConflict)(remote, local, 'lww')).toBe('reject');
    });
    test('should always reject in ignore mode', () => {
        const remote = { hlcTimestamp: encodeHlc(9999n, 999) };
        expect((0, dc_sync_1.resolveConflict)(remote, null, 'ignore')).toBe('reject');
        expect((0, dc_sync_1.resolveConflict)(remote, encodeHlc(1n, 1), 'ignore')).toBe('reject');
    });
    test('should always merge in crdt mode', () => {
        const remote = { hlcTimestamp: encodeHlc(100n, 1) };
        expect((0, dc_sync_1.resolveConflict)(remote, null, 'crdt')).toBe('merge');
        expect((0, dc_sync_1.resolveConflict)(remote, encodeHlc(200n, 1), 'crdt')).toBe('merge');
    });
});
// ──────────────────────────────────────────
// DCSync 集成测试（带 mock）
// ──────────────────────────────────────────
describe('DCSync', () => {
    let config;
    let deltaSync;
    let dcSync;
    beforeEach(() => {
        config = {
            dcId: 'dc-east',
            peers: [{ dcId: 'dc-west', address: 'tcp://west.example.com:5556', port: 5556 }],
            zmqPubAddress: 'tcp://0.0.0.0:5555',
            zmqSubAddress: 'tcp://0.0.0.0:5556',
            syncIntervalMs: 100,
        };
        const clock = new hlc_clock_1.HlcClock();
        const engine = new graph_engine_1.GraphEngine({ path: ':memory:' });
        deltaSync = new delta_sync_1.DeltaSync('dc-east', engine, clock);
        dcSync = new dc_sync_1.DCSync(config, deltaSync);
    });
    test('should create DCSync', () => {
        expect(dcSync).toBeDefined();
    });
    test('should not be running initially', () => {
        expect(dcSync.isRunning).toBe(false);
    });
    test('should start and become running', async () => {
        await dcSync.start();
        expect(dcSync.isRunning).toBe(true);
        await dcSync.stop();
    });
    test('should stop and become not running', async () => {
        await dcSync.start();
        expect(dcSync.isRunning).toBe(true);
        await dcSync.stop();
        expect(dcSync.isRunning).toBe(false);
    });
    test('should publish delta via ZMQ', async () => {
        await dcSync.start();
        const delta = {
            dcId: 'dc-east',
            hlcTimestamp: new Uint8Array([1, 2, 3]),
            delta: { nodes: {} },
            batchId: 'test-batch-1',
        };
        await dcSync.publishDelta(delta);
        await dcSync.stop();
    });
    test('should stop without error when not started', async () => {
        await expect(dcSync.stop()).resolves.not.toThrow();
    });
});
//# sourceMappingURL=dc-sync.spec.js.map