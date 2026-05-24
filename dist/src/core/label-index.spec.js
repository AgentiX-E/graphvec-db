"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const label_engine_1 = require("./label-engine");
describe('LabelEngine', () => {
    let engine;
    beforeEach(() => {
        engine = new label_engine_1.LabelEngine();
    });
    afterEach(() => {
        engine.clear();
    });
    // ──────────────────────────────────────────
    // addNode / getNodeIds
    // ──────────────────────────────────────────
    test('should add a node to a type and retrieve it', () => {
        engine.addNode(1, 100);
        const ids = engine.getNodeIds(1);
        expect(ids).toEqual([100]);
    });
    test('should add multiple nodes to the same type', () => {
        engine.addNode(1, 100);
        engine.addNode(1, 200);
        engine.addNode(1, 300);
        const ids = engine.getNodeIds(1);
        expect(ids).toHaveLength(3);
        expect(ids).toContain(100);
        expect(ids).toContain(200);
        expect(ids).toContain(300);
    });
    test('should add nodes to different types independently', () => {
        engine.addNode(1, 100);
        engine.addNode(2, 200);
        engine.addNode(2, 201);
        expect(engine.getNodeIds(1)).toEqual([100]);
        expect(engine.getNodeIds(2)).toHaveLength(2);
        expect(engine.getNodeIds(2)).toContain(200);
        expect(engine.getNodeIds(2)).toContain(201);
    });
    test('should return empty array for non-existent type', () => {
        const ids = engine.getNodeIds(99);
        expect(ids).toEqual([]);
    });
    test('should not duplicate node IDs for the same type', () => {
        engine.addNode(1, 100);
        engine.addNode(1, 100);
        const ids = engine.getNodeIds(1);
        expect(ids).toEqual([100]);
    });
    test('should allow the same node in multiple types', () => {
        engine.addNode(1, 100);
        engine.addNode(2, 100);
        expect(engine.getNodeIds(1)).toContain(100);
        expect(engine.getNodeIds(2)).toContain(100);
    });
    // ──────────────────────────────────────────
    // removeNode
    // ──────────────────────────────────────────
    test('should remove a node from a type', () => {
        engine.addNode(1, 100);
        engine.addNode(1, 200);
        const removed = engine.removeNode(1, 100);
        expect(removed).toBe(true);
        const ids = engine.getNodeIds(1);
        expect(ids).toEqual([200]);
    });
    test('should remove the type entry when last node is removed', () => {
        engine.addNode(1, 100);
        engine.removeNode(1, 100);
        expect(engine.getNodeIds(1)).toEqual([]);
        const stats = engine.stats();
        expect(stats.types).toBe(0);
    });
    test('should return false when removing non-existent node from existing type', () => {
        engine.addNode(1, 100);
        const removed = engine.removeNode(1, 999);
        expect(removed).toBe(false);
    });
    test('should return false when removing from non-existent type', () => {
        const removed = engine.removeNode(99, 100);
        expect(removed).toBe(false);
    });
    test('should handle remove and re-add of the same node', () => {
        engine.addNode(1, 100);
        engine.removeNode(1, 100);
        expect(engine.getNodeIds(1)).toEqual([]);
        engine.addNode(1, 100);
        expect(engine.getNodeIds(1)).toEqual([100]);
    });
    // ──────────────────────────────────────────
    // stats()
    // ──────────────────────────────────────────
    test('stats should return zero counts for empty engine', () => {
        const s = engine.stats();
        expect(s.types).toBe(0);
        expect(s.totalNodes).toBe(0);
        expect(s.typeCounts).toEqual({});
    });
    test('stats should reflect added nodes', () => {
        engine.addNode(1, 100);
        engine.addNode(1, 200);
        engine.addNode(2, 300);
        const s = engine.stats();
        expect(s.types).toBe(2);
        expect(s.totalNodes).toBe(3);
        expect(s.typeCounts[1]).toBe(2);
        expect(s.typeCounts[2]).toBe(1);
    });
    test('stats should reflect removed nodes', () => {
        engine.addNode(1, 100);
        engine.addNode(1, 200);
        engine.removeNode(1, 100);
        const s = engine.stats();
        expect(s.types).toBe(1);
        expect(s.totalNodes).toBe(1);
        expect(s.typeCounts[1]).toBe(1);
    });
    test('stats typeCounts should handle multiple types', () => {
        for (let t = 1; t <= 3; t++) {
            for (let i = 0; i < t * 2; i++) {
                engine.addNode(t, t * 100 + i);
            }
        }
        const s = engine.stats();
        expect(s.types).toBe(3);
        expect(s.totalNodes).toBe(12);
        expect(s.typeCounts[1]).toBe(2);
        expect(s.typeCounts[2]).toBe(4);
        expect(s.typeCounts[3]).toBe(6);
    });
    // ──────────────────────────────────────────
    // clear / reset
    // ──────────────────────────────────────────
    test('clear should remove all data', () => {
        engine.addNode(1, 100);
        engine.addNode(2, 200);
        engine.clear();
        expect(engine.getNodeIds(1)).toEqual([]);
        expect(engine.getNodeIds(2)).toEqual([]);
        const s = engine.stats();
        expect(s.types).toBe(0);
        expect(s.totalNodes).toBe(0);
    });
    test('reset should work like clear', () => {
        engine.addNode(1, 100);
        engine.reset();
        expect(engine.getNodeIds(1)).toEqual([]);
        expect(engine.stats().types).toBe(0);
    });
    test('should work after clear (reusable)', () => {
        engine.addNode(1, 100);
        engine.clear();
        engine.addNode(1, 200);
        expect(engine.getNodeIds(1)).toEqual([200]);
        expect(engine.stats().totalNodes).toBe(1);
    });
    // ──────────────────────────────────────────
    // Edge cases
    // ──────────────────────────────────────────
    test('should handle large number of nodes in one type', () => {
        const count = 1000;
        for (let i = 0; i < count; i++) {
            engine.addNode(1, i);
        }
        expect(engine.getNodeIds(1)).toHaveLength(count);
        expect(engine.stats().typeCounts[1]).toBe(count);
    });
    test('should handle many types', () => {
        const typeCount = 100;
        for (let t = 0; t < typeCount; t++) {
            engine.addNode(t, t);
        }
        expect(engine.stats().types).toBe(typeCount);
        expect(engine.stats().totalNodes).toBe(typeCount);
    });
    test('getNodeIds should return a copy (not mutable reference)', () => {
        engine.addNode(1, 100);
        const ids = engine.getNodeIds(1);
        ids.push(200);
        const ids2 = engine.getNodeIds(1);
        expect(ids2).toEqual([100]);
    });
});
//# sourceMappingURL=label-index.spec.js.map