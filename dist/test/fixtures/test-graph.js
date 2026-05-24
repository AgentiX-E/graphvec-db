"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.testEngineConfig = void 0;
exports.makeTestNode = makeTestNode;
exports.makeTestBatch = makeTestBatch;
exports.cleanTestData = cleanTestData;
/** 测试用的 OverGraph 配置 */
exports.testEngineConfig = {
    path: './test-data/test-graph',
    denseVector: { dimension: 384 },
};
/** 创建一个测试节点 */
function makeTestNode(name, opts) {
    return {
        typeId: 1,
        name,
        opts: {
            props: { name: `Test-${name}`, created: Date.now() },
            ...opts,
        },
    };
}
/** 创建一批测试节点的输入 */
function makeTestBatch(count) {
    return Array.from({ length: count }, (_, i) => ({
        typeId: 1,
        name: `batch-node-${i}`,
        opts: {
            props: { index: i, group: 'test-batch' },
        },
    }));
}
/** 清理测试数据目录 */
function cleanTestData(dir = './test-data') {
    try {
        const fs = require('fs');
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
    catch {
        // ignore
    }
}
//# sourceMappingURL=test-graph.js.map