"use strict";
// ============================================================
// FullTextIndex 测试
// ============================================================
Object.defineProperty(exports, "__esModule", { value: true });
const fulltext_1 = require("./fulltext");
// ──────────────────────────────────────────
// 基础操作测试（25 tests — original set）
// ──────────────────────────────────────────
describe('FullTextIndex', () => {
    // 基础操作（insert + search + delete + clear + setOptions + count）
    describe('基础搜索', () => {
        test('should return empty results for empty index', () => {
            const idx = new fulltext_1.FullTextIndex();
            const results = idx.search('hello');
            expect(results).toEqual([]);
        });
        test('should find a document by single term', () => {
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { content: 'hello world' });
            const results = idx.search('hello');
            expect(results).toHaveLength(1);
            expect(results[0].docId).toBe('doc1');
        });
        test('should find a document by multi-word query', () => {
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { content: 'hello world foo bar' });
            const results = idx.search('hello foo');
            expect(results).toHaveLength(1);
        });
        test('should return multiple matching documents', () => {
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { content: 'hello world' });
            idx.addDocument('doc2', { content: 'hello there' });
            idx.addDocument('doc3', { content: 'goodbye world' });
            const results = idx.search('hello');
            expect(results).toHaveLength(2);
        });
        test('should not find document for non-matching term', () => {
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { content: 'hello world' });
            const results = idx.search('nonexistent');
            expect(results).toEqual([]);
        });
        test('should handle empty query string', () => {
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { content: 'hello' });
            expect(idx.search('')).toEqual([]);
            expect(idx.search('  ')).toEqual([]);
        });
    });
    describe('insert + delete + clear', () => {
        test('should delete a document and not find it', () => {
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { content: 'hello world' });
            idx.addDocument('doc2', { content: 'foo bar' });
            expect(idx.search('hello')).toHaveLength(1);
            idx.removeDocument('doc1');
            expect(idx.search('hello')).toHaveLength(0);
            expect(idx.search('foo')).toHaveLength(1);
        });
        test('should delete non-existent doc without error', () => {
            const idx = new fulltext_1.FullTextIndex();
            expect(() => idx.removeDocument('nonexistent')).not.toThrow();
        });
        test('should clear all documents', () => {
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { content: 'hello' });
            idx.addDocument('doc2', { content: 'world' });
            expect(idx.count()).toBe(2);
            idx.clear();
            expect(idx.count()).toBe(0);
            expect(idx.search('hello')).toEqual([]);
        });
    });
    describe('setOptions / count', () => {
        test('should count documents correctly', () => {
            const idx = new fulltext_1.FullTextIndex();
            expect(idx.count()).toBe(0);
            idx.addDocument('doc1', { name: 'a' });
            expect(idx.count()).toBe(1);
            idx.addDocument('doc2', { name: 'b' });
            expect(idx.count()).toBe(2);
            idx.removeDocument('doc1');
            expect(idx.count()).toBe(1);
        });
        test('setOptions should update field weights', () => {
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { name: 'urgent task', description: 'normal' });
            idx.addDocument('doc2', { name: 'normal', description: 'urgent matter' });
            // Default: name has weight 2.0
            const before = idx.search('urgent');
            expect(before[0].docId).toBe('doc1');
            expect(before[0].score).toBeGreaterThan(0);
            // Update weights: description gets higher weight
            idx.setOptions({ fieldWeights: { name: 0.5, description: 3.0 } });
            const after = idx.search('urgent');
            // doc2 should now rank higher due to description weight
            expect(after[0].docId).toBe('doc2');
        });
    });
    // ──────────────────────────────────────────
    // 字段权重 & 高亮（14 tests）
    // ──────────────────────────────────────────
    describe('字段权重', () => {
        test('should weight name field higher than description by default', () => {
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { name: 'important task', description: 'some details' });
            idx.addDocument('doc2', { name: 'other thing', description: 'important details here' });
            const results = idx.search('important');
            expect(results[0].docId).toBe('doc1');
        });
        test('should apply custom field weights', () => {
            const idx = new fulltext_1.FullTextIndex({ fieldWeights: { title: 3.0, content: 1.0 } });
            idx.addDocument('doc1', { title: 'hello', content: 'world' });
            idx.addDocument('doc2', { title: 'world', content: 'hello' });
            const results = idx.search('hello');
            expect(results[0].docId).toBe('doc1');
        });
        test('should use custom weights passed in search options', () => {
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { name: 'hello', description: 'world' });
            idx.addDocument('doc2', { name: 'world', description: 'hello' });
            const results = idx.search('hello', { weights: { name: 1.0, description: 5.0 } });
            expect(results[0].docId).toBe('doc2');
        });
        test('should rank by score correctly', () => {
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { name: 'alpha beta', description: 'minor' });
            idx.addDocument('doc2', { name: 'gamma', description: 'alpha alpha alpha' });
            const results = idx.search('alpha', { weights: { name: 2.0, description: 1.0 } });
            expect(results[0].docId).toBe('doc1');
        });
    });
    describe('highlight()', () => {
        test('should highlight matching terms with default tags', () => {
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { name: 'hello world', description: 'test content' });
            const highlighted = idx.highlight('doc1', 'hello');
            expect(highlighted.name).toContain('<b>hello</b>');
            expect(highlighted.name).toContain('world');
        });
        test('should highlight with custom tags', () => {
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { name: 'hello world' });
            const highlighted = idx.highlight('doc1', 'hello', '**', '**');
            expect(highlighted.name).toContain('**hello**');
        });
        test('should highlight multiple terms', () => {
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { name: 'hello world foo bar' });
            const highlighted = idx.highlight('doc1', 'hello foo');
            expect(highlighted.name).toContain('<b>hello</b>');
            expect(highlighted.name).toContain('<b>foo</b>');
        });
        test('should return empty object for non-existent doc', () => {
            const idx = new fulltext_1.FullTextIndex();
            expect(idx.highlight('nonexistent', 'hello')).toEqual({});
        });
        test('should return original fields for empty query', () => {
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { name: 'hello world' });
            const result = idx.highlight('doc1', '');
            expect(result.name).toBe('hello world');
        });
        test('should highlight across all fields', () => {
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { name: 'hello', description: 'hello again' });
            const highlighted = idx.highlight('doc1', 'hello');
            expect(highlighted.name).toContain('<b>hello</b>');
            expect(highlighted.description).toContain('<b>hello</b>');
        });
        test('should handle special regex characters in query', () => {
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { name: 'price (total)' });
            const highlighted = idx.highlight('doc1', 'price');
            expect(highlighted.name).toContain('<b>price</b>');
        });
    });
    describe('spellCorrect()', () => {
        test('should return exact match for known term', () => {
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { content: 'hello world' });
            const suggestions = idx.spellCorrect('hello');
            expect(suggestions).toContain('hello');
        });
        test('should suggest correction for close misspelling', () => {
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { content: 'hello world' });
            const suggestions = idx.spellCorrect('hllo');
            expect(suggestions.some(s => s === 'hello')).toBe(true);
        });
        test('should return original token when no suggestion found', () => {
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { content: 'hello' });
            const suggestions = idx.spellCorrect('xyzzy');
            expect(suggestions).toContain('xyzzy');
        });
        test('should handle empty query', () => {
            const idx = new fulltext_1.FullTextIndex();
            expect(idx.spellCorrect('')).toEqual([]);
        });
        test('should respect max suggestions', () => {
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { content: 'apple banana cherry date' });
            const suggestions = idx.spellCorrect('aplle bananna', 2);
            expect(suggestions.length).toBeLessThanOrEqual(2);
        });
        test('should correct multiple misspellings', () => {
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { content: 'hello world' });
            const suggestions = idx.spellCorrect('hllo werld');
            expect(suggestions.some(s => s === 'hello')).toBe(true);
        });
    });
    // ──────────────────────────────────────────
    // 持久化（4 tests）
    // ──────────────────────────────────────────
    describe('持久化', () => {
        test('should serialize and deserialize empty index', () => {
            const idx = new fulltext_1.FullTextIndex();
            const json = idx.serialize();
            const restored = fulltext_1.FullTextIndex.deserialize(json);
            expect(restored.count()).toBe(0);
            expect(restored.search('hello')).toEqual([]);
        });
        test('should persist documents through serialize/deserialize', () => {
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { name: 'hello world' });
            idx.addDocument('doc2', { name: 'foo bar' });
            const json = idx.serialize();
            const restored = fulltext_1.FullTextIndex.deserialize(json);
            expect(restored.count()).toBe(2);
            expect(restored.search('hello')).toHaveLength(1);
            expect(restored.search('foo')).toHaveLength(1);
        });
        test('should save to and load from file', async () => {
            const tmpFile = `/tmp/test-fulltext-${Date.now()}.json`;
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { content: 'persist test' });
            await idx.saveToFile(tmpFile);
            const loaded = await fulltext_1.FullTextIndex.loadFromFile(tmpFile);
            expect(loaded.count()).toBe(1);
            const results = loaded.search('persist');
            expect(results).toHaveLength(1);
            expect(results[0].docId).toBe('doc1');
            try {
                require('fs').unlinkSync(tmpFile);
            }
            catch { /* ignore */ }
        });
        test('should preserve search options after deserialize', () => {
            const idx = new fulltext_1.FullTextIndex({ fieldWeights: { custom: 5.0 } });
            idx.addDocument('doc1', { custom: 'important' });
            const json = idx.serialize();
            const restored = fulltext_1.FullTextIndex.deserialize(json);
            restored.addDocument('doc2', { custom: 'trivial', other: 'important' });
            const results = restored.search('important');
            expect(results[0].docId).toBe('doc1');
        });
    });
    // ──────────────────────────────────────────
    // 召回评估 & autoTune
    // ──────────────────────────────────────────
    describe('evaluateRecall() and autoTune()', () => {
        test('evaluateRecall should return perfect scores for exact match', () => {
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { content: 'hello world' });
            idx.addDocument('doc2', { content: 'foo bar' });
            const { precision, recall, f1 } = idx.evaluateRecall([
                { query: 'hello', relevantDocIds: ['doc1'] },
            ]);
            expect(precision).toBe(1);
            expect(recall).toBe(1);
            expect(f1).toBe(1);
        });
        test('evaluateRecall should handle partial match', () => {
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { content: 'hello world' });
            idx.addDocument('doc2', { content: 'hello there' });
            idx.addDocument('doc3', { content: 'goodbye' });
            const { precision, recall } = idx.evaluateRecall([
                { query: 'hello', relevantDocIds: ['doc1', 'doc3'] },
            ]);
            // Retrieved: doc1, doc2 (2 docs). Relevant among retrieved: doc1 (1). Relevant total: 2 (doc1, doc3)
            // precision = 1/2 = 0.5, recall = 1/2 = 0.5
            expect(precision).toBe(0.5);
            expect(recall).toBe(0.5);
        });
        test('autoTune should return best weights', () => {
            const idx = new fulltext_1.FullTextIndex({ fieldWeights: { name: 1.0, description: 1.0 } });
            idx.addDocument('doc1', { name: 'urgent task', description: 'normal' });
            idx.addDocument('doc2', { name: 'normal', description: 'urgent matter' });
            const testQueries = [
                { query: 'urgent', relevantDocIds: ['doc1'] },
            ];
            const result = idx.autoTune(testQueries, { name: [2.0], description: [0.5] }, 1);
            expect(result.bestF1).toBeGreaterThan(0);
            expect(result.bestWeights.name).toBe(2.0);
        });
    });
    // ──────────────────────────────────────────
    // AND / OR mode
    // ──────────────────────────────────────────
    describe('AND/OR search mode', () => {
        test('OR mode finds docs matching any term', () => {
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { content: 'hello world' });
            idx.addDocument('doc2', { content: 'foo bar' });
            const results = idx.search('hello bar', { mode: 'or' });
            expect(results).toHaveLength(2);
        });
        test('AND mode finds docs matching all terms', () => {
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { content: 'hello world' });
            idx.addDocument('doc2', { content: 'hello foo' });
            const results = idx.search('hello foo', { mode: 'and' });
            expect(results).toHaveLength(1);
            expect(results[0].docId).toBe('doc2');
        });
        test('AND mode returns empty when no doc matches all terms', () => {
            const idx = new fulltext_1.FullTextIndex();
            idx.addDocument('doc1', { content: 'hello world' });
            idx.addDocument('doc2', { content: 'foo bar' });
            const results = idx.search('hello bar', { mode: 'and' });
            expect(results).toEqual([]);
        });
    });
});
//# sourceMappingURL=fulltext.spec.js.map