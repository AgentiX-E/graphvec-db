"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const dinic_flow_1 = require("./dinic-flow");
test('max flow basic', () => {
    const r = (0, dinic_flow_1.maxFlow)([1, 2, 3, 4], [
        { src: 1, dst: 2, capacity: 10 }, { src: 1, dst: 3, capacity: 10 },
        { src: 2, dst: 4, capacity: 10 }, { src: 3, dst: 4, capacity: 10 },
    ], 1, 4);
    expect(r.maxFlow).toBe(20);
});
//# sourceMappingURL=mini-flow.spec.js.map