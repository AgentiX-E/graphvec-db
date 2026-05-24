"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const graph_config_1 = require("./graph-config");
describe('GraphConfig', () => {
    test('should create with default config', () => {
        const config = new graph_config_1.GraphConfig({ path: '/tmp/test-graph' });
        expect(config).toBeDefined();
        const cfg = config.getConfig();
        expect(cfg.path).toBe('/tmp/test-graph');
        expect(cfg.denseVector?.dimension).toBe(384);
    });
    test('should apply overrides correctly', () => {
        const config = new graph_config_1.GraphConfig({
            path: '/custom/graph/path',
            denseVector: { dimension: 768 },
            cacheSize: 500,
        });
        const cfg = config.getConfig();
        expect(cfg.path).toBe('/custom/graph/path');
        expect(cfg.denseVector?.dimension).toBe(768);
        expect(cfg.cacheSize).toBe(500);
    });
    test('should create engine from config', () => {
        const config = new graph_config_1.GraphConfig({ path: '/tmp/test-graph-engine' });
        const engine = config.createEngine();
        expect(engine).toBeDefined();
        // Engine should not be open yet (we call open() separately)
    });
    test('should get config values via getConfig', () => {
        const config = new graph_config_1.GraphConfig({ path: '/tmp/config-values' });
        const cfg = config.getConfig();
        expect(cfg.path).toBe('/tmp/config-values');
        expect(typeof cfg.denseVector?.dimension).toBe('number');
    });
});
//# sourceMappingURL=graph-config.spec.js.map