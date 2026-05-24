"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mst_1 = require("./mst");
describe('MST', () => {
    test('empty', () => {
        expect((0, mst_1.minimumSpanningTree)([], []).edges).toEqual([]);
    });
    test('simple', () => {
        const r = (0, mst_1.minimumSpanningTree)([1, 2, 3, 4], [
            { src: 1, dst: 2, weight: 1 },
            { src: 2, dst: 3, weight: 2 },
            { src: 3, dst: 4, weight: 3 },
            { src: 1, dst: 3, weight: 4 },
        ]);
        expect(r.edges.length).toBe(3);
        expect(r.totalWeight).toBe(6);
    });
    test('disconnected', () => {
        const r = (0, mst_1.minimumSpanningTree)([1, 2, 3, 4], [
            { src: 1, dst: 2, weight: 1 },
            { src: 3, dst: 4, weight: 2 },
        ]);
        expect(r.edges.length).toBe(2);
        expect(r.totalWeight).toBe(3);
    });
});
//# sourceMappingURL=mst.spec.js.map