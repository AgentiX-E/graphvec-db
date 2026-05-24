"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const standalone_consensus_1 = require("./standalone-consensus");
describe('StandaloneConsensus — graceful degradation', () => {
    const config = {
        mode: 'standalone',
        nodeId: 'test-node',
        peers: [],
    };
    test('should handle propose before start — return { ok: false }', async () => {
        const consensus = new standalone_consensus_1.StandaloneConsensus(config);
        const result = await consensus.propose(new Uint8Array([1, 2, 3]));
        expect(result).toEqual({ ok: false });
    });
    test('should propose successfully after start with applyFn', async () => {
        const consensus = new standalone_consensus_1.StandaloneConsensus(config);
        let applied = null;
        consensus.setApply(async (data) => {
            applied = data;
        });
        await consensus.start();
        const result = await consensus.propose(new Uint8Array([1, 2, 3]));
        expect(result).toEqual({ ok: true });
        expect(applied).toEqual(new Uint8Array([1, 2, 3]));
    });
    test('should return { ok: false } after start when no applyFn set', async () => {
        const consensus = new standalone_consensus_1.StandaloneConsensus(config);
        await consensus.start();
        const result = await consensus.propose(new Uint8Array([1, 2, 3]));
        expect(result).toEqual({ ok: false });
    });
    test('should degrade gracefully on applyFn error', async () => {
        const consensus = new standalone_consensus_1.StandaloneConsensus(config);
        consensus.setApply(async (_data) => {
            throw new Error('apply error');
        });
        await consensus.start();
        const result = await consensus.propose(new Uint8Array([1, 2, 3]));
        expect(result).toEqual({ ok: false });
    });
    test('should return fallback role and leader before/after start', async () => {
        const consensus = new standalone_consensus_1.StandaloneConsensus(config);
        expect(consensus.getRole()).toBe('standalone');
        expect(consensus.getLeaderId()).toBeNull();
        expect(consensus.getTerm()).toBe(1);
        await consensus.start();
        expect(consensus.getRole()).toBe('standalone');
        expect(consensus.getLeaderId()).toBe('test-node');
        await consensus.stop();
        expect(consensus.getLeaderId()).toBeNull();
    });
    test('should handle consecutive propose calls gracefully', async () => {
        const consensus = new standalone_consensus_1.StandaloneConsensus(config);
        let appliedCount = 0;
        consensus.setApply(async (_data) => {
            appliedCount++;
        });
        await consensus.start();
        const results = await Promise.all([
            consensus.propose(new Uint8Array([1])),
            consensus.propose(new Uint8Array([2])),
            consensus.propose(new Uint8Array([3])),
        ]);
        results.forEach((r) => expect(r).toEqual({ ok: true }));
        expect(appliedCount).toBe(3);
    });
    test('should return { ok: false } when propose called after stop', async () => {
        const consensus = new standalone_consensus_1.StandaloneConsensus(config);
        consensus.setApply(async (_data) => {
            /* no-op */
        });
        await consensus.start();
        await consensus.stop();
        const result = await consensus.propose(new Uint8Array([1, 2, 3]));
        expect(result).toEqual({ ok: false });
    });
    test('readIndex should resolve immediately even before start', async () => {
        const consensus = new standalone_consensus_1.StandaloneConsensus(config);
        // standalone 模式 readIndex 应始终无等待返回
        await expect(consensus.readIndex()).resolves.toBeUndefined();
    });
    test('waitForLeader should resolve immediately even before start', async () => {
        const consensus = new standalone_consensus_1.StandaloneConsensus(config);
        // standalone 模式 waitForLeader 应始终无等待返回
        await expect(consensus.waitForLeader()).resolves.toBeUndefined();
    });
});
//# sourceMappingURL=standalone-consensus.spec.js.map