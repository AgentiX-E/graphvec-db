"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const safe_reader_1 = require("./safe-reader");
describe('SafeReader', () => {
    describe('with consensus provider', () => {
        let mockProvider;
        beforeEach(() => {
            mockProvider = {
                readIndex: jest.fn().mockResolvedValue(undefined),
                sync: jest.fn(),
                on: jest.fn(),
                start: jest.fn(),
                stop: jest.fn(),
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
                readIndex: jest.fn().mockResolvedValue(undefined),
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
                readIndex: jest.fn().mockResolvedValue(undefined),
            };
            reader.setProvider(mockProvider);
            await reader.read(() => 'late');
            expect(mockProvider.readIndex).toHaveBeenCalled();
        });
    });
});
//# sourceMappingURL=safe-reader.spec.js.map