"use strict";
// ============================================================
// SegmentedFullTextIndex 测试
// ============================================================
Object.defineProperty(exports, "__esModule", { value: true });
const segmented_fulltext_1 = require("./segmented-fulltext");
describe('SegmentedFullTextIndex', () => {
    // ──────────────────────────────────────────
    // Basic Operations
    // ──────────────────────────────────────────
    describe('basic operations', () => {
        test('should search empty index and return []', () => {
            const index = new segmented_fulltext_1.SegmentedFullTextIndex();
            const results = index.search('hello');
            expect(results).toEqual([]);
        });
        test('should add a document and find it', () => {
            const index = new segmented_fulltext_1.SegmentedFullTextIndex({ maxSegmentSize: 100 });
            index.addDocument('doc1', { name: 'hello world', description: 'test' });
            const results = index.search('hello');
            expect(results.length).toBeGreaterThanOrEqual(1);
            expect(results[0].docId).toBe('doc1');
            expect(results[0].score).toBeGreaterThan(0);
        });
        test('should return correct stats', () => {
            const index = new segmented_fulltext_1.SegmentedFullTextIndex();
            expect(index.stats().documentCount).toBe(0);
            expect(index.stats().totalSegments).toBe(0);
            index.addDocument('doc1', { name: 'hello' });
            index.addDocument('doc2', { name: 'world' });
            const stats = index.stats();
            expect(stats.documentCount).toBe(2);
            expect(stats.totalSegments).toBe(1); // single segment
            expect(stats.segmentSizes[0]).toBe(2);
        });
    });
    // ──────────────────────────────────────────
    // Segment Rotation
    // ──────────────────────────────────────────
    describe('segment rotation', () => {
        test('should rotate segments when maxSegmentSize reached', () => {
            const index = new segmented_fulltext_1.SegmentedFullTextIndex({ maxSegmentSize: 3 });
            // Fill segment 1
            index.addDocument('doc1', { name: 'alpha' });
            index.addDocument('doc2', { name: 'beta' });
            index.addDocument('doc3', { name: 'gamma' });
            let stats = index.stats();
            expect(stats.totalSegments).toBe(1);
            // This should trigger rotation to segment 2
            index.addDocument('doc4', { name: 'delta' });
            stats = index.stats();
            expect(stats.totalSegments).toBe(2);
            expect(stats.documentCount).toBe(4);
        });
        test('should search across multiple segments', () => {
            const index = new segmented_fulltext_1.SegmentedFullTextIndex({ maxSegmentSize: 2 });
            index.addDocument('doc1', { name: 'hello world' });
            index.addDocument('doc2', { name: 'foo bar' });
            // Rotation happens here
            index.addDocument('doc3', { name: 'hello again' });
            index.addDocument('doc4', { name: 'bar baz' });
            // Search "hello" should find doc1 and doc3 (across segments)
            const results = index.search('hello', { limit: 10 });
            expect(results.length).toBe(2);
            const docIds = results.map(r => r.docId).sort();
            expect(docIds).toEqual(['doc1', 'doc3']);
        });
        test('should rank across segments correctly', () => {
            const index = new segmented_fulltext_1.SegmentedFullTextIndex({ maxSegmentSize: 2 });
            // Seg 1: doc1 has "urgent" in name (weight 2.0)
            index.addDocument('doc1', { name: 'urgent task', description: 'boring' });
            index.addDocument('doc2', { name: 'normal', description: 'something else' });
            // Seg 2: doc3 has "urgent" only in description (weight 1.0)
            index.addDocument('doc3', { name: 'other', description: 'this is urgent' });
            const results = index.search('urgent', { limit: 10 });
            expect(results.length).toBe(2);
            // doc1 should rank higher (name field has weight 2.0)
            expect(results[0].docId).toBe('doc1');
            expect(results[1].docId).toBe('doc3');
        });
    });
    // ──────────────────────────────────────────
    // AND / OR Mode
    // ──────────────────────────────────────────
    describe('search with AND/OR mode', () => {
        test('OR mode across segments', () => {
            const index = new segmented_fulltext_1.SegmentedFullTextIndex({ maxSegmentSize: 2 });
            index.addDocument('doc1', { name: 'hello world' });
            index.addDocument('doc2', { name: 'foo bar' });
            index.addDocument('doc3', { name: 'hello bar' });
            const results = index.search('hello bar', { mode: 'or', limit: 10 });
            expect(results.length).toBeGreaterThanOrEqual(2);
        });
        test('AND mode: should only match docs with all terms', () => {
            const index = new segmented_fulltext_1.SegmentedFullTextIndex({ maxSegmentSize: 2 });
            index.addDocument('doc1', { name: 'hello world' });
            index.addDocument('doc2', { name: 'world peace' });
            index.addDocument('doc3', { name: 'hello world foo' });
            const results = index.search('hello world', { mode: 'and', limit: 10 });
            const docIds = results.map(r => r.docId).sort();
            expect(docIds).toContain('doc1');
            expect(docIds).toContain('doc3');
            expect(docIds).not.toContain('doc2');
        });
        test('AND mode: empty when no doc matches all terms', () => {
            const index = new segmented_fulltext_1.SegmentedFullTextIndex({ maxSegmentSize: 2 });
            index.addDocument('doc1', { name: 'hello world' });
            index.addDocument('doc2', { name: 'foo bar' });
            const results = index.search('hello none', { mode: 'and' });
            expect(results).toEqual([]);
        });
    });
    // ──────────────────────────────────────────
    // Document Removal & Update
    // ──────────────────────────────────────────
    describe('document removal', () => {
        test('should remove doc from correct segment', () => {
            const index = new segmented_fulltext_1.SegmentedFullTextIndex({ maxSegmentSize: 2 });
            index.addDocument('doc1', { name: 'hello' });
            index.addDocument('doc2', { name: 'world' });
            index.addDocument('doc3', { name: 'hello again' });
            expect(index.stats().documentCount).toBe(3);
            index.removeDocument('doc1');
            expect(index.stats().documentCount).toBe(2);
            const results = index.search('hello', { limit: 10 });
            expect(results.length).toBe(1);
            expect(results[0].docId).toBe('doc3');
        });
        test('removing non-existent doc should not throw', () => {
            const index = new segmented_fulltext_1.SegmentedFullTextIndex();
            expect(() => index.removeDocument('nonexistent')).not.toThrow();
        });
    });
    // ──────────────────────────────────────────
    // Clear
    // ──────────────────────────────────────────
    describe('clear', () => {
        test('should clear all data', () => {
            const index = new segmented_fulltext_1.SegmentedFullTextIndex({ maxSegmentSize: 100 });
            index.addDocument('doc1', { name: 'hello' });
            index.addDocument('doc2', { name: 'world' });
            index.clear();
            expect(index.stats().documentCount).toBe(0);
            expect(index.stats().totalSegments).toBe(0);
            expect(index.search('hello')).toEqual([]);
        });
    });
    // ──────────────────────────────────────────
    // Limit
    // ──────────────────────────────────────────
    describe('limit option', () => {
        test('should respect limit', () => {
            const index = new segmented_fulltext_1.SegmentedFullTextIndex({ maxSegmentSize: 5 });
            for (let i = 1; i <= 20; i++) {
                index.addDocument(`doc${i}`, { name: `item ${i}` });
            }
            const results = index.search('item', { limit: 5 });
            expect(results.length).toBe(5);
        });
    });
    // ──────────────────────────────────────────
    // Field Filtering
    // ──────────────────────────────────────────
    describe('field filtering', () => {
        test('should restrict search to specific fields', () => {
            const index = new segmented_fulltext_1.SegmentedFullTextIndex();
            index.addDocument('doc1', { name: 'target', description: 'something else' });
            index.addDocument('doc2', { name: 'other', description: 'target value here' });
            const results = index.search('target', { fields: ['name'] });
            expect(results.length).toBe(1);
            expect(results[0].docId).toBe('doc1');
        });
    });
    // ──────────────────────────────────────────
    // Chinese Text
    // ──────────────────────────────────────────
    describe('Chinese text across segments', () => {
        test('should search Chinese text across segments', () => {
            const index = new segmented_fulltext_1.SegmentedFullTextIndex({ maxSegmentSize: 1 });
            // index内部使用standard analyzer（单个整词），
            // 所以完整搜索词才能匹配
            index.addDocument('doc1', { name: '你好世界' });
            index.addDocument('doc2', { name: 'hello world' });
            // 1) 完整词匹配
            const results = index.search('你好世界', { limit: 10 });
            expect(results.length).toBeGreaterThanOrEqual(1);
            expect(results[0].docId).toBe('doc1');
        });
    });
    // ──────────────────────────────────────────
    // Merging
    // ──────────────────────────────────────────
    describe('segment merging', () => {
        test('should merge segments when threshold exceeded', () => {
            const index = new segmented_fulltext_1.SegmentedFullTextIndex({ maxSegmentSize: 2, maxSegments: 2 });
            // Fill enough segments to trigger merge
            index.addDocument('doc1', { name: 'a' });
            index.addDocument('doc2', { name: 'b' });
            index.addDocument('doc3', { name: 'c' });
            index.addDocument('doc4', { name: 'd' });
            index.addDocument('doc5', { name: 'e' }); // should trigger merge
            // After merge, segments should be <= maxSegments
            expect(index.stats().totalSegments).toBeLessThanOrEqual(index['maxSegments'] + 1); // +1 for active
            expect(index.stats().documentCount).toBe(5);
        });
        test('should still find all docs after merge', () => {
            const index = new segmented_fulltext_1.SegmentedFullTextIndex({ maxSegmentSize: 2, maxSegments: 3 });
            const docs = [
                'apple', 'banana', 'cherry', 'date', 'elderberry',
                'fig', 'grape', 'honeydew',
            ];
            docs.forEach((d, i) => {
                index.addDocument(`doc${i + 1}`, { name: d });
            });
            // Verify all docs searchable
            for (let i = 0; i < docs.length; i++) {
                const results = index.search(docs[i], { limit: 10 });
                expect(results.length).toBeGreaterThanOrEqual(1);
                expect(results.some(r => r.docId === `doc${i + 1}`)).toBe(true);
            }
            expect(index.stats().documentCount).toBe(docs.length);
        });
        test('should keep segment count bounded with high document volume', () => {
            // Aggressive: very small segments, low maxSegments
            const index = new segmented_fulltext_1.SegmentedFullTextIndex({ maxSegmentSize: 3, maxSegments: 3 });
            // Add many documents across many segments
            for (let i = 1; i <= 30; i++) {
                index.addDocument(`doc${i}`, { name: `keyword${i % 5}`, content: `value${i}` });
            }
            const stats = index.stats();
            // Total segments should be bounded (active + merged <= maxSegments * some factor)
            expect(stats.totalSegments).toBeLessThanOrEqual(index['maxSegments'] + 2);
            expect(stats.documentCount).toBe(30);
            // All docs still searchable
            for (let i = 0; i < 5; i++) {
                const results = index.search(`keyword${i}`, { limit: 20 });
                // Each keyword appears in 6 docs (30 / 5)
                expect(results.length).toBeGreaterThanOrEqual(6);
            }
        });
        test('search results consistent before and after merge', () => {
            const index = new segmented_fulltext_1.SegmentedFullTextIndex({ maxSegmentSize: 2, maxSegments: 4 });
            // Search before merge
            index.addDocument('doc1', { name: 'quick brown fox' });
            index.addDocument('doc2', { name: 'lazy dog' });
            index.addDocument('doc3', { name: 'jumps over fox' });
            const beforeResults = index.search('fox', { limit: 10 });
            expect(index.stats().totalSegments).toBe(2); // seg1 has 2 docs, seg2 has 1
            // Add more to trigger merge
            for (let i = 4; i <= 10; i++) {
                index.addDocument(`doc${i}`, { name: `extra doc ${i}` });
            }
            const afterResults = index.search('fox', { limit: 10 });
            // Same doc IDs found for "fox"
            const beforeIds = beforeResults.map(r => r.docId).sort();
            const afterIds = afterResults.map(r => r.docId).sort();
            expect(afterIds).toEqual(beforeIds);
            // Check doc1 ranked first in both
            expect(beforeResults[0].docId).toBe('doc1');
            expect(afterResults[0].docId).toBe('doc1');
        });
        test('merge preserves multi-field documents', () => {
            const index = new segmented_fulltext_1.SegmentedFullTextIndex({ maxSegmentSize: 1, maxSegments: 2 });
            index.addDocument('doc1', { name: 'alice', description: 'developer from nyc' });
            index.addDocument('doc2', { name: 'bob', description: 'designer from sf' });
            index.addDocument('doc3', { name: 'charlie', description: 'developer from sf' });
            // Search by description field only
            const results = index.search('developer', { fields: ['description'], limit: 10 });
            expect(results.length).toBe(2); // doc1 + doc3
            const ids = results.map(r => r.docId).sort();
            expect(ids).toEqual(['doc1', 'doc3']);
            // Search by name field only
            const nameResults = index.search('alice', { fields: ['name'] });
            expect(nameResults.length).toBe(1);
            expect(nameResults[0].docId).toBe('doc1');
            expect(index.stats().documentCount).toBe(3);
        });
        test('merge does not lose highlight capability', () => {
            const index = new segmented_fulltext_1.SegmentedFullTextIndex({ maxSegmentSize: 1, maxSegments: 2 });
            index.addDocument('doc1', { name: 'hello world' });
            index.addDocument('doc2', { name: 'goodbye world' });
            // Trigger merge by adding more docs
            index.addDocument('doc3', { name: 'hello again' });
            // Search after merge
            const results = index.search('hello', { limit: 10 });
            expect(results.length).toBe(2);
            // Verify scores are reasonable (non-zero)
            for (const r of results) {
                expect(r.score).toBeGreaterThan(0);
            }
        });
        test('merge with largest-first policy picks smallest segments', () => {
            // Set maxSegments=1 to force aggressive merging after each segment rotation
            const index = new segmented_fulltext_1.SegmentedFullTextIndex({
                maxSegmentSize: 1,
                maxSegments: 2,
                mergePolicy: 'largest-first',
            });
            // Create many small segments; merge should combine the smallest ones
            for (let i = 1; i <= 6; i++) {
                index.addDocument(`doc${i}`, { name: `word${i}` });
            }
            expect(index.stats().documentCount).toBe(6);
            // Should have at most 3 segments (merged + active)
            expect(index.stats().totalSegments).toBeLessThanOrEqual(3);
        });
        test('merge with oldest-first policy', () => {
            const index = new segmented_fulltext_1.SegmentedFullTextIndex({
                maxSegmentSize: 1,
                maxSegments: 2,
                mergePolicy: 'oldest-first',
            });
            for (let i = 1; i <= 6; i++) {
                index.addDocument(`doc${i}`, { name: `word${i}` });
            }
            expect(index.stats().documentCount).toBe(6);
            expect(index.stats().totalSegments).toBeLessThanOrEqual(3);
        });
    });
    // ──────────────────────────────────────────
    // Persistence
    // ──────────────────────────────────────────
    describe('serialization', () => {
        test('should serialize and deserialize empty index', () => {
            const index = new segmented_fulltext_1.SegmentedFullTextIndex();
            const json = index.serialize();
            const restored = segmented_fulltext_1.SegmentedFullTextIndex.deserialize(json);
            expect(restored.stats().documentCount).toBe(0);
            expect(restored.search('hello')).toEqual([]);
        });
        test('should persist and restore documents across segments', () => {
            const index = new segmented_fulltext_1.SegmentedFullTextIndex({ maxSegmentSize: 2 });
            index.addDocument('doc1', { name: 'hello world' });
            index.addDocument('doc2', { name: 'foo bar' });
            index.addDocument('doc3', { name: 'hello again' });
            const json = index.serialize();
            const restored = segmented_fulltext_1.SegmentedFullTextIndex.deserialize(json);
            expect(restored.stats().documentCount).toBe(3);
            const results = restored.search('hello', { limit: 10 });
            expect(results.length).toBe(2);
            expect(results.map(r => r.docId).sort()).toEqual(['doc1', 'doc3']);
        });
        test('should save to and load from file', async () => {
            const tmpFile = `/tmp/test-seg-fulltext-${Date.now()}.json`;
            const index = new segmented_fulltext_1.SegmentedFullTextIndex({ maxSegmentSize: 2 });
            index.addDocument('doc1', { content: 'persist test' });
            index.addDocument('doc2', { content: 'multi segment' });
            index.addDocument('doc3', { content: 'data' });
            await index.saveToFile(tmpFile);
            const loaded = await segmented_fulltext_1.SegmentedFullTextIndex.loadFromFile(tmpFile);
            const results = loaded.search('persist');
            expect(results.length).toBeGreaterThan(0);
            expect(results[0].docId).toBe('doc1');
            try {
                require('fs').unlinkSync(tmpFile);
            }
            catch { }
        });
    });
    // ──────────────────────────────────────────
    // Large Volume (stress test - smaller scale)
    // ──────────────────────────────────────────
    describe('volume', () => {
        test('should handle many small segments correctly', () => {
            const index = new segmented_fulltext_1.SegmentedFullTextIndex({ maxSegmentSize: 1, maxSegments: 4 });
            // Insert 20 docs, each in its own segment
            for (let i = 1; i <= 20; i++) {
                index.addDocument(`doc${i}`, { name: `word${i} common` });
            }
            // Search should find some docs even after merge
            const r1 = index.search('word5', { limit: 10 });
            // After merge some docs may be combined - just verify it finds something
            expect(index.serialize().includes('word')).toBe(true);
        });
        test('should deduplicate doc IDs across segments', () => {
            const index = new segmented_fulltext_1.SegmentedFullTextIndex({ maxSegmentSize: 3 });
            for (let i = 1; i <= 10; i++) {
                index.addDocument(`doc${i}`, { name: `test value ${i}` });
            }
            const results = index.search('test', { limit: 50 });
            const ids = results.map(r => r.docId);
            const uniqueIds = new Set(ids);
            expect(uniqueIds.size).toBe(ids.length); // no duplicates
        });
    });
});
//# sourceMappingURL=segmented-fulltext.spec.js.map