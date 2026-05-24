"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const hlc_clock_1 = require("./hlc-clock");
describe('HlcClock', () => {
    let clock;
    beforeEach(() => {
        clock = new hlc_clock_1.HlcClock();
    });
    describe('now()', () => {
        test('should return an object with wallTime (bigint), logical (number), and toBytes (function)', () => {
            const ts = clock.now();
            expect(ts).toBeDefined();
            expect(typeof ts.wallTime).toBe('bigint');
            expect(typeof ts.logical).toBe('number');
            expect(ts.logical).toBeGreaterThanOrEqual(0);
            expect(typeof ts.toBytes).toBe('function');
        });
        test('should be monotonically increasing over 100 consecutive calls', () => {
            const timestamps = [];
            for (let i = 0; i < 100; i++) {
                timestamps.push(clock.now());
            }
            for (let i = 1; i < timestamps.length; i++) {
                const prev = timestamps[i - 1];
                const curr = timestamps[i];
                // Walltime持平，logical严格递增
                const isLater = curr.wallTime > prev.wallTime ||
                    (curr.wallTime === prev.wallTime && curr.logical > prev.logical);
                expect(isLater).toBe(true);
            }
        });
    });
    describe('nowWithWallTime()', () => {
        test('wallTime should be a positive bigint based on real time', () => {
            const ts = clock.nowWithWallTime();
            expect(ts.wallTime).toBeGreaterThan(0n);
        });
        test('should be monotonically increasing', () => {
            const t1 = clock.nowWithWallTime();
            const t2 = clock.nowWithWallTime();
            const cmp = clock.compare(t2, t1);
            expect(cmp).toBeGreaterThanOrEqual(0);
        });
    });
    describe('toBytes()', () => {
        test('toBytes should produce a non-empty Uint8Array', () => {
            const ts = clock.now();
            const bytes = ts.toBytes();
            expect(bytes).toBeInstanceOf(Uint8Array);
            expect(bytes.length).toBeGreaterThan(0);
        });
        test('toBytes encoded data with wallTime should be decodable', () => {
            const ts = clock.nowWithWallTime();
            const bytes = ts.toBytes();
            // update accepts Uint8Array
            const clock2 = new hlc_clock_1.HlcClock();
            expect(() => clock2.update(bytes)).not.toThrow();
        });
    });
    describe('update()', () => {
        test('should accept a Timestamp object from another clock', () => {
            const ts1 = clock.nowWithWallTime();
            expect(() => clock.update({ wallTime: ts1.wallTime, logical: ts1.logical })).not.toThrow();
        });
        test('should accept Uint8Array from remote clock', () => {
            const ts1 = clock.nowWithWallTime();
            const bytes = ts1.toBytes();
            const clock2 = new hlc_clock_1.HlcClock();
            expect(() => clock2.update(bytes)).not.toThrow();
            // After update, clock2 should have advanced
            const ts2 = clock2.now();
            const cmp = clock.compare(ts2, ts1);
            expect(cmp).toBeGreaterThanOrEqual(0);
        });
        test('should advance logical clock after receiving a later remote timestamp', () => {
            const ts1 = clock.nowWithWallTime();
            // Create a remote timestamp with same wallTime but higher logical
            clock.update({ wallTime: ts1.wallTime, logical: ts1.logical + 100 });
            const ts2 = clock.now();
            expect(ts2.logical).toBeGreaterThan(ts1.logical + 100);
        });
        test('should advance wallTime clock after receiving remote timestamp with later time', () => {
            const ts1 = clock.nowWithWallTime();
            const remoteLater = { wallTime: ts1.wallTime + 5000n, logical: 0 };
            clock.update(remoteLater);
            const ts2 = clock.nowWithWallTime();
            expect(ts2.wallTime).toBeGreaterThanOrEqual(ts1.wallTime + 5000n);
        });
    });
    describe('compare()', () => {
        test('should return -1 when tsA < tsB', () => {
            const tsA = clock.nowWithWallTime();
            const laterWall = { wallTime: tsA.wallTime + 1000n, logical: 0 };
            const earlierWall = { wallTime: tsA.wallTime, logical: 0 };
            const result = clock.compare(earlierWall, laterWall);
            expect(result).toBe(-1);
        });
        test('should return 0 when timestamps are equal', () => {
            const ts = { wallTime: 1000n, logical: 5 };
            expect(clock.compare(ts, ts)).toBe(0);
        });
        test('should return 1 when tsA > tsB', () => {
            const tsA = { wallTime: 2000n, logical: 0 };
            const tsB = { wallTime: 1000n, logical: 0 };
            expect(clock.compare(tsA, tsB)).toBe(1);
        });
        test('should use logical as tiebreaker when wallTime equal', () => {
            const tsA = { wallTime: 1000n, logical: 10 };
            const tsB = { wallTime: 1000n, logical: 5 };
            expect(clock.compare(tsA, tsB)).toBe(1);
            expect(clock.compare(tsB, tsA)).toBe(-1);
        });
    });
});
//# sourceMappingURL=hlc-clock.spec.js.map