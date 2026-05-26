"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const scatter_gather_1 = require("./scatter-gather");
function mockEngine(overrides) {
    return overrides;
}
function mockRange(overrides) {
    return overrides;
}
describe('ScatterGather', () => {
    describe('vectorSearch', () => {
        test('should merge results from multiple ranges', async () => {
            const range1 = mockRange({
                read: async (fn) => fn(mockEngine({
                    vectorSearch: () => [
                        { node: { id: 1, typeId: 1, key: 'a', createdAt: 0 }, score: 0.9, distance: 0.1 },
                        { node: { id: 2, typeId: 1, key: 'b', createdAt: 0 }, score: 0.5, distance: 0.5 },
                    ],
                })),
            });
            const range2 = mockRange({
                read: async (fn) => fn(mockEngine({
                    vectorSearch: () => [
                        { node: { id: 3, typeId: 1, key: 'c', createdAt: 0 }, score: 0.8, distance: 0.2 },
                    ],
                })),
            });
            const sg = new scatter_gather_1.ScatterGather(() => [range1, range2]);
            const results = await sg.vectorSearch({ k: 3 });
            expect(results.length).toBe(3);
            expect(results[0].score).toBe(0.9);
            expect(results[1].score).toBe(0.8);
            expect(results[2].score).toBe(0.5);
        });
        test('should handle empty or failing ranges', async () => {
            const good = mockRange({
                read: async (fn) => fn(mockEngine({
                    vectorSearch: () => [{ node: { id: 1, typeId: 1, key: 'x', createdAt: 0 }, score: 0.9, distance: 0.1 }],
                })),
            });
            const bad = mockRange({
                read: async () => { throw new Error('timeout'); },
            });
            const sg = new scatter_gather_1.ScatterGather(() => [good, bad]);
            const results = await sg.vectorSearch({ k: 5 });
            expect(results.length).toBe(1);
            expect(results[0].score).toBe(0.9);
        });
    });
    describe('personalizedPageRank', () => {
        test('should merge PPR scores across ranges', async () => {
            const range1 = mockRange({
                read: async (fn) => fn(mockEngine({
                    personalizedPageRank: () => [{ nodeId: 1, score: 0.5 }, { nodeId: 2, score: 0.3 }],
                    stats: () => ({ nodeCount: 100, edgeCount: 0, diskSizeBytes: 0 }),
                })),
            });
            const range2 = mockRange({
                read: async (fn) => fn(mockEngine({
                    personalizedPageRank: () => [{ nodeId: 1, score: 0.4 }, { nodeId: 3, score: 0.2 }],
                    stats: () => ({ nodeCount: 100, edgeCount: 0, diskSizeBytes: 0 }),
                })),
            });
            const sg = new scatter_gather_1.ScatterGather(() => [range1, range2]);
            const results = await sg.personalizedPageRank({ sourceNode: 1 });
            expect(results.length).toBe(3);
            expect(results[0].nodeId).toBe(1);
            // 归一化后：range1: score 0.5+0.3=0.8; node1: 0.5/0.8*0.5=0.3125; node2: 0.3/0.8*0.5=0.1875
            // range2: score 0.4+0.2=0.6; node1: 0.4/0.6*0.5=0.3333; node3: 0.2/0.6*0.5=0.1667
            // merged: node1=0.3125+0.3333=0.6458, node2=0.1875, node3=0.1667
            expect(results[0].nodeId).toBe(1);
            expect(results[0].score).toBeCloseTo(0.6458, 3);
            expect(results[1].nodeId).toBe(2);
            expect(results[1].score).toBeCloseTo(0.1875, 3);
            expect(results[2].nodeId).toBe(3);
            expect(results[2].score).toBeCloseTo(0.1667, 3);
        });
    });
});
//# sourceMappingURL=scatter-gather.spec.js.map