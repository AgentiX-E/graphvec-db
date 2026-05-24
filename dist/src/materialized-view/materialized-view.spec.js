"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const materialized_view_1 = require("./materialized-view");
const graph_engine_1 = require("../core/graph-engine");
jest.mock('../core/graph-engine', () => {
    return {
        GraphEngine: jest.fn().mockImplementation(() => ({
            upsertNode: jest.fn(),
            open: jest.fn(),
            close: jest.fn(),
            isOpen: false,
            stats: jest.fn().mockReturnValue({ nodeCount: 42, edgeCount: 7, diskSizeBytes: 65536 }),
            queryPattern: jest.fn().mockReturnValue([
                { type: 1, name: 'node-1', props: { name: 'Alice' } },
                { type: 1, name: 'node-2', props: { name: 'Bob' } },
            ]),
        })),
    };
});
describe('MaterializedView', () => {
    let config;
    let sourceEngine;
    let mv;
    beforeEach(() => {
        config = {
            name: 'test-view',
            pattern: { depth: 1 },
            refreshPolicy: 'manual',
        };
        sourceEngine = new graph_engine_1.GraphEngine({ path: ':memory:' });
        mv = new materialized_view_1.MaterializedView(config, sourceEngine, '/tmp/test-view');
    });
    test('should create with valid config', () => {
        expect(mv).toBeDefined();
    });
    test('should open and close', () => {
        expect(() => mv.open()).not.toThrow();
        expect(() => mv.close()).not.toThrow();
    });
    test('should refresh from source engine', async () => {
        const count = await mv.refresh();
        expect(count).toBe(2); // 2 mock nodes returned
    });
    test('should return status with view info', () => {
        mv.open();
        const status = mv.getStatus();
        expect(status.name).toBe('test-view');
        expect(status.nodeCount).toBe(42);
        expect(status.edgeCount).toBe(7);
        expect(status.sizeBytes).toBe(65536);
        mv.close();
    });
    test('should query view engine', () => {
        mv.open();
        const results = mv.query({ depth: 1 });
        expect(Array.isArray(results)).toBe(true);
        expect(results.length).toBe(2);
        mv.close();
    });
    test('should drop without throwing', () => {
        expect(() => mv.drop()).not.toThrow();
    });
    test('should start periodic refresh when refreshPolicy is periodic', () => {
        const periodicConfig = {
            name: 'periodic-view',
            pattern: { depth: 2 },
            refreshPolicy: 'periodic',
            refreshIntervalSeconds: 10,
        };
        const periodicMv = new materialized_view_1.MaterializedView(periodicConfig, sourceEngine, '/tmp/periodic-view');
        expect(() => periodicMv.open()).not.toThrow();
        expect(() => periodicMv.close()).not.toThrow();
    });
});
//# sourceMappingURL=materialized-view.spec.js.map