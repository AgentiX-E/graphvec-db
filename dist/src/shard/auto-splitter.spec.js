"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const auto_splitter_1 = require("./auto-splitter");
describe('AutoSplitter', () => {
    let splitter;
    afterEach(() => {
        splitter.stop();
    });
    function mockRange(overrides) {
        return overrides;
    }
    test('should start and stop', () => {
        splitter = new auto_splitter_1.AutoSplitter(() => [], () => { });
        expect(splitter.running).toBe(false);
        splitter.start();
        expect(splitter.running).toBe(true);
        splitter.stop();
        expect(splitter.running).toBe(false);
    });
    test('should check and detect oversized ranges and pass SplitSuggestion', async () => {
        let suggestion;
        const getRanges = () => [mockRange({
                config: { rangeId: 'r1' },
                isDraining: () => false,
                engine: {
                    stats: () => ({ nodeCount: 200000, edgeCount: 50000, diskSizeBytes: 0 }),
                },
            })];
        const onReshard = (s) => { suggestion = s; };
        splitter = new auto_splitter_1.AutoSplitter(getRanges, onReshard, { maxNodesPerRange: 100000 });
        const count = await splitter.checkNow();
        expect(count).toBe(1);
        expect(suggestion).toBeDefined();
        expect(suggestion.rangeId).toBe('r1');
        expect(suggestion.nodeCount).toBe(200000);
        expect(suggestion.edgeCount).toBe(50000);
        expect(suggestion.suggestedTargetCount).toBe(2);
        expect(suggestion.reason).toBe('node_count_exceeded');
    });
    test('should compute suggestedTargetCount correctly (1500/1000 → ceil=2)', async () => {
        let suggestion;
        const getRanges = () => [mockRange({
                config: { rangeId: 'r2' },
                isDraining: () => false,
                engine: {
                    stats: () => ({ nodeCount: 1500, edgeCount: 300, diskSizeBytes: 0 }),
                },
            })];
        const onReshard = (s) => { suggestion = s; };
        splitter = new auto_splitter_1.AutoSplitter(getRanges, onReshard, { maxNodesPerRange: 1000 });
        const count = await splitter.checkNow();
        expect(count).toBe(1);
        expect(suggestion).toBeDefined();
        expect(suggestion.suggestedTargetCount).toBe(2);
        expect(suggestion.nodeCount).toBe(1500);
    });
    test('should skip ranges below threshold', async () => {
        let resharded = false;
        const getRanges = () => [mockRange({
                config: { rangeId: 'r1' },
                isDraining: () => false,
                engine: {
                    stats: () => ({ nodeCount: 1000, edgeCount: 500, diskSizeBytes: 0 }),
                },
            })];
        const onReshard = () => { resharded = true; };
        splitter = new auto_splitter_1.AutoSplitter(getRanges, onReshard, { maxNodesPerRange: 100000 });
        const count = await splitter.checkNow();
        expect(count).toBe(0);
        expect(resharded).toBe(false);
    });
    test('should skip draining ranges', async () => {
        let resharded = false;
        const getRanges = () => [mockRange({
                config: { rangeId: 'r1' },
                isDraining: () => true,
                engine: {
                    stats: () => ({ nodeCount: 200000, edgeCount: 50000, diskSizeBytes: 0 }),
                },
            })];
        const onReshard = () => { resharded = true; };
        splitter = new auto_splitter_1.AutoSplitter(getRanges, onReshard, { maxNodesPerRange: 100000 });
        const count = await splitter.checkNow();
        expect(count).toBe(0);
        expect(resharded).toBe(false);
    });
    test('should respect minSplitInterval', async () => {
        let reshardCount = 0;
        const getRanges = () => [mockRange({
                config: { rangeId: 'r1' },
                isDraining: () => false,
                engine: {
                    stats: () => ({ nodeCount: 200000, edgeCount: 50000, diskSizeBytes: 0 }),
                },
            })];
        const onReshard = () => { reshardCount++; };
        splitter = new auto_splitter_1.AutoSplitter(getRanges, onReshard, {
            maxNodesPerRange: 100000,
            minSplitIntervalMs: 60000,
        });
        await splitter.checkNow();
        // 第二次立即检查 — 应跳过
        await splitter.checkNow();
        expect(reshardCount).toBe(1);
    });
    // ── B-11: 风暴预防 — maxSplitsPerCycle ──
    test('should limit splits per cycle to maxSplitsPerCycle', async () => {
        let reshardCount = 0;
        const suggestions = [];
        // 10 个超过阈值范围的 Range
        const ranges = Array.from({ length: 10 }, (_, i) => mockRange({
            config: { rangeId: `r${i}` },
            isDraining: () => false,
            engine: {
                stats: () => ({ nodeCount: 200000, edgeCount: 50000, diskSizeBytes: 0 }),
            },
        }));
        const getRanges = () => ranges;
        const onReshard = (s) => {
            if (s) {
                suggestions.push(s);
            }
            reshardCount++;
        };
        splitter = new auto_splitter_1.AutoSplitter(getRanges, onReshard, {
            maxNodesPerRange: 100000,
            maxSplitsPerCycle: 2,
        });
        const count = await splitter.checkNow();
        expect(count).toBe(2);
        expect(suggestions.length).toBe(2);
    });
    test('should split all when maxSplitsPerCycle is large enough', async () => {
        let reshardCount = 0;
        const suggestions = [];
        const ranges = Array.from({ length: 5 }, (_, i) => mockRange({
            config: { rangeId: `r${i}` },
            isDraining: () => false,
            engine: {
                stats: () => ({ nodeCount: 200000, edgeCount: 50000, diskSizeBytes: 0 }),
            },
        }));
        const getRanges = () => ranges;
        const onReshard = (s) => {
            if (s) {
                suggestions.push(s);
            }
            reshardCount++;
        };
        splitter = new auto_splitter_1.AutoSplitter(getRanges, onReshard, {
            maxNodesPerRange: 100000,
            maxSplitsPerCycle: 10,
        });
        const count = await splitter.checkNow();
        expect(count).toBe(5);
        expect(suggestions.length).toBe(5);
    });
});
//# sourceMappingURL=auto-splitter.spec.js.map