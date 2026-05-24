"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const hybrid_search_1 = require("./hybrid-search");
const hnsw_1 = require("./hnsw");
describe('hybridSearch', () => {
    let hnsw;
    beforeEach(() => {
        hnsw = new hnsw_1.HnswIndex();
        // 插入 20 个随机向量
        for (let i = 1; i <= 20; i++) {
            const v = new Float32Array(64);
            for (let j = 0; j < 64; j++)
                v[j] = Math.random() - 0.5;
            let norm = 0;
            for (let j = 0; j < 64; j++)
                norm += v[j] * v[j];
            norm = Math.sqrt(norm);
            for (let j = 0; j < 64; j++)
                v[j] /= norm;
            hnsw.insert(i, v);
        }
    });
    const bm25Mock = (text, topK) => {
        if (text === 'graph') {
            return [
                { id: 1, score: 5.2 },
                { id: 5, score: 3.1 },
                { id: 10, score: 2.8 },
                { id: 15, score: 2.5 },
                { id: 3, score: 2.0 },
            ];
        }
        if (text === 'empty')
            return [];
        return [];
    };
    describe('RRF 策略', () => {
        test('should return empty for no results', () => {
            const results = (0, hybrid_search_1.hybridSearch)(null, null, { topK: 5 });
            expect(results).toEqual([]);
        });
        test('should return text-only results when no HNSW', () => {
            const results = (0, hybrid_search_1.hybridSearch)(null, bm25Mock, { text: 'graph', topK: 3 });
            expect(results.length).toBe(3);
            expect(results[0].id).toBe(1);
            expect(results[0].vectorScore).toBe(0);
        });
        test('should return vector-only results when no BM25', () => {
            const queryVec = hnsw.search(new Float32Array(64), 1);
            // 用 undefined BM25 模拟无法全文搜索的场景
            const results = (0, hybrid_search_1.hybridSearch)(hnsw, null, { vector: new Float32Array(64), topK: 3 });
            expect(results.length).toBe(3);
        });
        test('should merge text and vector results with RRF', () => {
            const queryVec = new Float32Array(64);
            for (let i = 0; i < 64; i++)
                queryVec[i] = 0.01;
            const results = (0, hybrid_search_1.hybridSearch)(hnsw, bm25Mock, { text: 'graph', strategy: 'rrf', topK: 5 });
            expect(results.length).toBeGreaterThan(0);
            expect(results.length).toBeLessThanOrEqual(5);
            // 所有结果都有 score
            for (const r of results) {
                expect(r.score).toBeGreaterThan(0);
                expect(typeof r.id).toBe('number');
            }
        });
    });
    describe('Weighted 策略', () => {
        test('should merge with weighted sum', () => {
            const queryVec = new Float32Array(64);
            for (let i = 0; i < 64; i++)
                queryVec[i] = 0.01;
            const results = (0, hybrid_search_1.hybridSearch)(hnsw, bm25Mock, {
                text: 'graph',
                strategy: 'weighted',
                vectorWeight: 0.3,
                textWeight: 0.7,
                topK: 5,
            });
            expect(results.length).toBeGreaterThan(0);
            expect(results.length).toBeLessThanOrEqual(5);
        });
    });
    describe('配置', () => {
        test('should accept custom rrfK', () => {
            const results = (0, hybrid_search_1.hybridSearch)(null, bm25Mock, { text: 'graph', rrfK: 10, topK: 3 });
            expect(results.length).toBe(3);
        });
        test('should work with topK = 1', () => {
            const results = (0, hybrid_search_1.hybridSearch)(null, bm25Mock, { text: 'graph', topK: 1 });
            expect(results.length).toBe(1);
        });
    });
});
//# sourceMappingURL=hybrid-search.spec.js.map