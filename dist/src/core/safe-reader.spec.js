"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const safe_reader_1 = require("./safe-reader");
describe('SafeReader', () => {
    describe('with consensus provider', () => {
        let mockProvider;
        beforeEach(() => {
            mockProvider = {
                readIndex: vi.fn().mockResolvedValue(undefined),
                sync: vi.fn(),
                on: vi.fn(),
                start: vi.fn(),
                stop: vi.fn(),
            };
        });
        test('should call readIndex before read', async () => {
            const reader = new safe_reader_1.SafeReader(mockProvider);
            const result = await reader.read(() => 42);
            expect(mockProvider.readIndex).toHaveBeenCalledTimes(1);
            expect(result.data).toBe(42);
        });
        test('should return refreshedAt timestamp', async () => {
            const reader = new safe_reader_1.SafeReader(mockProvider);
            const before = Date.now();
            const result = await reader.read(() => 'hello');
            expect(result.refreshedAt).toBeGreaterThanOrEqual(before);
        });
    });
    describe('without consensus provider', () => {
        test('should execute read directly when disabled', async () => {
            const reader = new safe_reader_1.SafeReader(undefined, { enabled: false });
            const result = await reader.read(() => 'no-raft');
            expect(result.data).toBe('no-raft');
        });
        test('should execute read directly when no provider', async () => {
            const reader = new safe_reader_1.SafeReader();
            const result = await reader.read(() => 99);
            expect(result.data).toBe(99);
        });
    });
    describe('config', () => {
        test('should accept custom timeout', async () => {
            const mockProvider = {
                readIndex: vi.fn().mockResolvedValue(undefined),
            };
            const reader = new safe_reader_1.SafeReader(mockProvider, { readIndexTimeoutMs: 100 });
            await reader.read(() => true);
            expect(mockProvider.readIndex).toHaveBeenCalledWith(100);
        });
    });
    describe('setEnabled / setProvider', () => {
        test('should toggle enabled', () => {
            const reader = new safe_reader_1.SafeReader();
            expect(reader.enabled).toBe(false);
            reader.setEnabled(true);
            expect(reader.enabled).toBe(true);
        });
        test('should accept late provider injection', async () => {
            const reader = new safe_reader_1.SafeReader();
            reader.setEnabled(true);
            const mockProvider = {
                readIndex: vi.fn().mockResolvedValue(undefined),
            };
            reader.setProvider(mockProvider);
            await reader.read(() => 'late');
            expect(mockProvider.readIndex).toHaveBeenCalled();
        });
    });
    // ──────────────────────────────────────────────────
    // consistentRead — barrier 语义测试
    // ──────────────────────────────────────────────────
    describe('consistentRead', () => {
        test('should call barrier() when provider exposes it', async () => {
            const barrierFn = vi.fn().mockResolvedValue(undefined);
            const providerWithBarrier = {
                readIndex: vi.fn(),
                barrier: barrierFn,
            };
            const reader = new safe_reader_1.SafeReader(providerWithBarrier);
            const result = await reader.consistentRead(() => 'barrier-done');
            expect(barrierFn).toHaveBeenCalledTimes(1);
            expect(result.data).toBe('barrier-done');
        });
        test('should fallback to readIndex when provider lacks barrier()', async () => {
            const readIndexFn = vi.fn().mockResolvedValue(undefined);
            const providerNoBarrier = {
                readIndex: readIndexFn,
            };
            const reader = new safe_reader_1.SafeReader(providerNoBarrier);
            const result = await reader.consistentRead(() => 'fallback-to-readindex');
            expect(readIndexFn).toHaveBeenCalledTimes(1);
            expect(result.data).toBe('fallback-to-readindex');
        });
        test('should pass timeoutMs to barrier()', async () => {
            const barrierFn = vi.fn().mockResolvedValue(undefined);
            const providerWithBarrier = {
                readIndex: vi.fn(),
                barrier: barrierFn,
            };
            const reader = new safe_reader_1.SafeReader(providerWithBarrier, { readIndexTimeoutMs: 42 });
            await reader.consistentRead(() => 'timed-barrier');
            expect(barrierFn).toHaveBeenCalledWith(42);
        });
        test('should return refreshedAt with consistentRead', async () => {
            const providerWithBarrier = {
                readIndex: vi.fn(),
                barrier: vi.fn().mockResolvedValue(undefined),
            };
            const reader = new safe_reader_1.SafeReader(providerWithBarrier);
            const before = Date.now();
            const result = await reader.consistentRead(() => 'timed');
            expect(result.refreshedAt).toBeGreaterThanOrEqual(before);
        });
        test('should not call barrier or readIndex when disabled', async () => {
            const barrierFn = vi.fn();
            const readIndexFn = vi.fn();
            const providerWithBarrier = {
                readIndex: readIndexFn,
                barrier: barrierFn,
            };
            const reader = new safe_reader_1.SafeReader(providerWithBarrier, { enabled: false });
            await reader.consistentRead(() => 'disabled');
            expect(barrierFn).not.toHaveBeenCalled();
            expect(readIndexFn).not.toHaveBeenCalled();
        });
        test('should execute directly when no provider', async () => {
            const reader = new safe_reader_1.SafeReader();
            const result = await reader.consistentRead(() => 'no-provider');
            expect(result.data).toBe('no-provider');
        });
        test('should propagate barrier() errors when no fallback tolerance', async () => {
            const barrierFn = vi.fn().mockRejectedValue(new Error('barrier failed'));
            const readIndexFn = vi.fn().mockResolvedValue(undefined);
            const provider = {
                readIndex: readIndexFn,
                barrier: barrierFn,
            };
            const reader = new safe_reader_1.SafeReader(provider);
            // barrier 抛错 — SafeReader 的 consistentRead 不吞错误
            // （错误容忍由 RAFT Consensus 层的 barrier 实现保证）
            await expect(reader.consistentRead(() => 'should-throw')).rejects.toThrow('barrier failed');
        });
    });
});
//# sourceMappingURL=safe-reader.spec.js.map