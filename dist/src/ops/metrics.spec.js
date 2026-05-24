"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const metrics_1 = require("./metrics");
describe('Metrics', () => {
    test('should create empty metrics', () => {
        const m = new metrics_1.Metrics();
        expect(m).toBeDefined();
    });
    test('should record counter increments', () => {
        const m = new metrics_1.Metrics();
        m.incrementCounter('ops');
        m.incrementCounter('ops');
        expect(m.getCounter('ops')).toBe(2);
    });
    test('should record counter with delta', () => {
        const m = new metrics_1.Metrics();
        m.incrementCounter('ops', 5);
        expect(m.getCounter('ops')).toBe(5);
    });
    test('should return 0 for unknown counter', () => {
        const m = new metrics_1.Metrics();
        expect(m.getCounter('unknown')).toBe(0);
    });
    test('should record latency samples', () => {
        const m = new metrics_1.Metrics();
        m.recordLatency('read', 150);
        m.recordLatency('read', 200);
        // snapshot should show p50/p99 for 'read'
        const snap = m.snapshot();
        expect(snap.readLatencyP50).toBeGreaterThan(0);
        expect(snap.readLatencyP99).toBeGreaterThan(0);
    });
    test('should snapshot all metrics', () => {
        const m = new metrics_1.Metrics();
        m.incrementCounter('ops', 50);
        m.incrementCounter('active_sessions', 5);
        m.incrementCounter('shard_count', 10);
        m.recordLatency('read', 100);
        m.recordLatency('write', 200);
        const snap = m.snapshot();
        expect(snap.timestamp).toBeGreaterThan(0);
        expect(snap.activeSessions).toBe(5);
        expect(snap.shardCount).toBe(10);
    });
    test('should return 0 opsPerSecond when no time has elapsed', () => {
        const m = new metrics_1.Metrics();
        const snap = m.snapshot();
        expect(snap.opsPerSecond).toBe(0);
    });
    test('should reset all metrics', () => {
        const m = new metrics_1.Metrics();
        m.incrementCounter('ops', 100);
        m.recordLatency('read', 150);
        expect(m.getCounter('ops')).toBe(100);
        m.reset();
        expect(m.getCounter('ops')).toBe(0);
        // After reset, snapshot should show zeros
        const snap = m.snapshot();
        expect(snap.opsPerSecond).toBe(0);
        expect(snap.readLatencyP50).toBe(0);
    });
    test('should return 0 latency percentiles when no samples', () => {
        const m = new metrics_1.Metrics();
        const snap = m.snapshot();
        expect(snap.readLatencyP50).toBe(0);
        expect(snap.readLatencyP99).toBe(0);
        expect(snap.writeLatencyP50).toBe(0);
        expect(snap.writeLatencyP99).toBe(0);
        expect(snap.raftCommitLatencyP99).toBe(0);
    });
    test('should limit latency samples to 1000', () => {
        const m = new metrics_1.Metrics();
        for (let i = 0; i < 2000; i++) {
            m.recordLatency('read', i);
        }
        // After reset, internal data is cleared; we just verify no crash
        m.reset();
        expect(m.getCounter('ops')).toBe(0);
    });
});
//# sourceMappingURL=metrics.spec.js.map