"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const transaction_1 = require("./transaction");
const graph_engine_1 = require("./graph-engine");
const path = __importStar(require("node:path"));
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
function createTempEngine() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txn-test-'));
    return new graph_engine_1.GraphEngine({ path: path.join(dir, 'graph.db') });
}
describe('Transaction', () => {
    describe('basic operations', () => {
        test('should record upsert nodes', () => {
            const txn = new transaction_1.Transaction();
            txn.upsertNode(1, 'test', { props: { a: 1 } });
            txn.upsertNode(2, 'test2');
            const snap = txn.snapshot();
            expect(snap.writes.length).toBe(2);
            expect(snap.writes[0].kind).toBe('upsertNode');
        });
        test('should record delete nodes', () => {
            const txn = new transaction_1.Transaction();
            txn.deleteNode(42);
            const snap = txn.snapshot();
            expect(snap.writes.length).toBe(1);
            expect(snap.writes[0].kind).toBe('deleteNode');
        });
        test('should record edge ops', () => {
            const txn = new transaction_1.Transaction();
            txn.upsertEdge(1, 2, 1, { props: { weight: 5 } });
            txn.deleteEdge(1, 2, 1);
            const snap = txn.snapshot();
            expect(snap.writes.length).toBe(2);
        });
        test('should throw on double commit', async () => {
            const txn = new transaction_1.Transaction();
            const engine = createTempEngine();
            await txn.commit(engine);
            await expect(txn.commit(engine)).rejects.toThrow('already committed');
            engine.close();
        });
        test('should throw on commit after rollback', async () => {
            const txn = new transaction_1.Transaction();
            txn.rollback();
            const engine = createTempEngine();
            await expect(txn.commit(engine)).rejects.toThrow('already rolled back');
            engine.close();
        });
        test('should throw on use after rollback', () => {
            const txn = new transaction_1.Transaction();
            txn.rollback();
            expect(() => txn.upsertNode(1, 'x')).toThrow('already rolled back');
        });
        test('should flush writes to engine on commit', async () => {
            const engine = createTempEngine();
            engine.open();
            const txn = new transaction_1.Transaction();
            txn.upsertNode(1, 'hello', { props: { v: 42 } });
            await txn.commit(engine);
            const node = engine.getNode(1);
            expect(node).not.toBeNull();
            expect(node.name).toBe('hello');
            engine.close();
        });
    });
    describe('TransactionManager', () => {
        test('should begin transactions', () => {
            const mgr = new transaction_1.TransactionManager();
            const txn = mgr.begin();
            expect(txn.id).toBeGreaterThan(0);
            expect(mgr.activeCount).toBe(1);
        });
        test('should limit active transactions', () => {
            const mgr = new transaction_1.TransactionManager(2);
            mgr.begin();
            mgr.begin();
            expect(() => mgr.begin()).toThrow('Too many active');
        });
        test('should get and remove transactions', () => {
            const mgr = new transaction_1.TransactionManager();
            const txn = mgr.begin();
            expect(mgr.get(txn.id)).toBe(txn);
            mgr.remove(txn.id);
            expect(mgr.get(txn.id)).toBeUndefined();
        });
    });
});
//# sourceMappingURL=transaction.spec.js.map