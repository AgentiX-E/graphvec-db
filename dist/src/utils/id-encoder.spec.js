"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const id_encoder_1 = require("./id-encoder");
describe('IdEncoder', () => {
    describe('nameToId', () => {
        test('should hash a name to a positive number', () => {
            const id = id_encoder_1.IdEncoder.nameToId('hello');
            expect(typeof id).toBe('number');
            expect(id).toBeGreaterThan(0);
        });
        test('should produce consistent hashes for same name', () => {
            const id1 = id_encoder_1.IdEncoder.nameToId('test-node');
            const id2 = id_encoder_1.IdEncoder.nameToId('test-node');
            expect(id1).toBe(id2);
        });
        test('should produce different hashes for different names', () => {
            const id1 = id_encoder_1.IdEncoder.nameToId('node-a');
            const id2 = id_encoder_1.IdEncoder.nameToId('node-b');
            expect(id1).not.toBe(id2);
        });
        test('should handle empty string', () => {
            const id = id_encoder_1.IdEncoder.nameToId('');
            expect(typeof id).toBe('number');
            expect(id).toBeGreaterThan(0);
        });
    });
    describe('generateUniqueId', () => {
        test('should generate a unique ID with default prefix', () => {
            const id = id_encoder_1.IdEncoder.generateUniqueId();
            expect(typeof id).toBe('string');
            expect(id).toMatch(/^node_\d+_/);
        });
        test('should generate a unique ID with custom prefix', () => {
            const id = id_encoder_1.IdEncoder.generateUniqueId('agent');
            expect(id).toMatch(/^agent_\d+_/);
        });
        test('should generate different IDs on each call', () => {
            const id1 = id_encoder_1.IdEncoder.generateUniqueId();
            const id2 = id_encoder_1.IdEncoder.generateUniqueId();
            expect(id1).not.toBe(id2);
        });
    });
});
//# sourceMappingURL=id-encoder.spec.js.map