"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const hnsw_1 = require("./hnsw");
describe('HnswIndex', () => {
    const dim = 128;
    function randomVec() {
        const v = new Float32Array(dim);
        for (let i = 0; i < dim; i++)
            v[i] = Math.random() - 0.5;
        // 归一化
        let norm = 0;
        for (let i = 0; i < dim; i++)
            norm += v[i] * v[i];
        norm = Math.sqrt(norm);
        for (let i = 0; i < dim; i++)
            v[i] /= norm;
        return v;
    }
    describe('基础操作', () => {
        test('should be empty initially', () => {
            const idx = new hnsw_1.HnswIndex();
            expect(idx.size).toBe(0);
        });
        test('should insert a vector', () => {
            const idx = new hnsw_1.HnswIndex();
            idx.insert(1, randomVec());
            expect(idx.size).toBe(1);
        });
        test('should search empty index', () => {
            const idx = new hnsw_1.HnswIndex();
            expect(idx.search(randomVec(), 5)).toEqual([]);
        });
        test('should find exact match', () => {
            const idx = new hnsw_1.HnswIndex();
            const v = randomVec();
            idx.insert(1, v);
            const results = idx.search(v, 5);
            expect(results.length).toBeGreaterThanOrEqual(1);
            expect(results[0].id).toBe(1);
            expect(results[0].distance).toBeCloseTo(0, 1);
        });
        test('should find nearest neighbor', () => {
            const idx = new hnsw_1.HnswIndex();
            const query = randomVec();
            // 插入 10 个随机向量
            for (let i = 0; i < 10; i++) {
                idx.insert(i + 1, randomVec());
            }
            // 插入与 query 相同的向量
            idx.insert(99, query);
            const results = idx.search(query, 3);
            expect(results.length).toBeGreaterThanOrEqual(1);
            expect(results[0].id).toBe(99);
            expect(results[0].distance).toBeLessThan(0.01);
        });
        test('should delete a vector', () => {
            const idx = new hnsw_1.HnswIndex();
            idx.insert(1, randomVec());
            expect(idx.size).toBe(1);
            expect(idx.delete(1)).toBe(true);
            expect(idx.size).toBe(0);
        });
        test('deleting non-existent returns false', () => {
            const idx = new hnsw_1.HnswIndex();
            expect(idx.delete(99)).toBe(false);
        });
    });
    describe('批量操作', () => {
        test('should batch insert', () => {
            const idx = new hnsw_1.HnswIndex();
            const vectors = Array.from({ length: 50 }, (_, i) => ({
                id: i + 1,
                vector: randomVec(),
            }));
            idx.batchInsert(vectors);
            expect(idx.size).toBe(50);
        });
        test('should find nearest after batch insert', () => {
            const idx = new hnsw_1.HnswIndex();
            const query = randomVec();
            const vectors = Array.from({ length: 100 }, (_, i) => ({
                id: i + 1,
                vector: randomVec(),
            }));
            vectors.push({ id: 999, vector: query });
            idx.batchInsert(vectors);
            const results = idx.search(query, 5);
            // HNSW 是近似搜索，精确匹配不保证排第一，但应在 top 5 内
            const ids = results.map(r => r.id);
            expect(ids).toContain(999);
            expect(results[0].distance).toBeLessThan(0.1);
        });
    });
    describe('性能', () => {
        test('should insert 500 vectors', () => {
            const idx = new hnsw_1.HnswIndex();
            const start = Date.now();
            for (let i = 0; i < 500; i++) {
                idx.insert(i, randomVec());
            }
            expect(idx.size).toBe(500);
            expect(Date.now() - start).toBeLessThan(5000);
        });
    });
    describe('配置', () => {
        test('should accept custom config', () => {
            const idx = new hnsw_1.HnswIndex({ M: 32, efConstruction: 100, efSearch: 30, distance: 'euclidean' });
            expect(idx.getConfig().M).toBe(32);
            expect(idx.getConfig().distance).toBe('euclidean');
            expect(idx.size).toBe(0);
        });
    });
});
//# sourceMappingURL=hnsw.spec.js.map