import { UpsertNodeOptions, OverGraphConfig } from '../../src/types';
/** 测试用的 OverGraph 配置 */
export declare const testEngineConfig: OverGraphConfig;
/** 创建一个测试节点 */
export declare function makeTestNode(name: string, opts?: Partial<UpsertNodeOptions>): {
    typeId: number;
    name: string;
    opts: {
        props: import("../../src/types").NodeProperties;
        denseVector?: Float32Array | number[];
        sparseVector?: Record<number, number>;
        temporalValidity?: import("../../src/types").TemporalValidity;
        decayFactor?: number;
        ttlSeconds?: number;
    };
};
/** 创建一批测试节点的输入 */
export declare function makeTestBatch(count: number): {
    typeId: number;
    name: string;
    opts: UpsertNodeOptions;
}[];
/** 清理测试数据目录 */
export declare function cleanTestData(dir?: string): void;
//# sourceMappingURL=test-graph.d.ts.map