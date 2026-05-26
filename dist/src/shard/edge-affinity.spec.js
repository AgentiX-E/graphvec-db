"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const edge_affinity_1 = require("./edge-affinity");
describe('EdgeAffinity', () => {
    describe('source strategy (default)', () => {
        test('should return src as partition key', () => {
            const aff = new edge_affinity_1.EdgeAffinity();
            expect(aff.getPartitionKey(1, 2)).toBe(1);
            expect(aff.getPartitionKey(100, 200)).toBe(100);
        });
        test('should have strategy = source', () => {
            const aff = new edge_affinity_1.EdgeAffinity();
            expect(aff.strategy).toBe('source');
        });
    });
    describe('target strategy', () => {
        test('should return dst as partition key', () => {
            const aff = new edge_affinity_1.EdgeAffinity({ strategy: 'target' });
            expect(aff.getPartitionKey(1, 2)).toBe(2);
        });
    });
    describe('source-target strategy', () => {
        test('should return same key for (a,b) and (b,a)', () => {
            const aff = new edge_affinity_1.EdgeAffinity({ strategy: 'source-target' });
            const k1 = aff.getPartitionKey(1, 2);
            const k2 = aff.getPartitionKey(2, 1);
            expect(k1).toBe(k2);
        });
        test('should produce different keys for different pairs', () => {
            const aff = new edge_affinity_1.EdgeAffinity({ strategy: 'source-target' });
            const k1 = aff.getPartitionKey(1, 2);
            const k2 = aff.getPartitionKey(1, 3);
            expect(k1).not.toBe(k2);
        });
    });
    describe('property strategy', () => {
        test('should use property value as key', () => {
            const aff = new edge_affinity_1.EdgeAffinity({ strategy: 'property:tenant' });
            const key = aff.getPartitionKey(1, 2, { tenant: 42 });
            expect(key).toBe(42);
        });
        test('should fallback to src when property missing', () => {
            const aff = new edge_affinity_1.EdgeAffinity({ strategy: 'property:region' });
            const key = aff.getPartitionKey(1, 2, { tenant: 42 });
            expect(key).toBe(1);
        });
    });
    describe('setStrategy', () => {
        test('should change strategy dynamically', () => {
            const aff = new edge_affinity_1.EdgeAffinity();
            expect(aff.getPartitionKey(1, 2)).toBe(1);
            aff.setStrategy('target');
            expect(aff.getPartitionKey(1, 2)).toBe(2);
        });
    });
});
//# sourceMappingURL=edge-affinity.spec.js.map