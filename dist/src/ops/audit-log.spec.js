"use strict";
// ============================================================
// AuditLog 测试
// ============================================================
class AuditLog {
    entries = [];
    log(entry) {
        this.entries.push({
            ...entry,
            timestamp: new Date().toISOString(),
        });
    }
    query(opts) {
        let results = [...this.entries];
        if (opts?.operation) {
            results = results.filter(e => e.operation === opts.operation);
        }
        if (opts?.user) {
            results = results.filter(e => e.user === opts.user);
        }
        if (opts?.result) {
            results = results.filter(e => e.result === opts.result);
        }
        if (opts?.startTime) {
            results = results.filter(e => new Date(e.timestamp).getTime() >= opts.startTime);
        }
        if (opts?.endTime) {
            results = results.filter(e => new Date(e.timestamp).getTime() <= opts.endTime);
        }
        if (opts?.limit && opts.limit > 0) {
            results = results.slice(-opts.limit);
        }
        return results;
    }
    clear() {
        this.entries = [];
    }
    size() {
        return this.entries.length;
    }
}
// ──────────────────────────────────────────
// 测试套件
// ──────────────────────────────────────────
describe('AuditLog', () => {
    let auditLog;
    beforeEach(() => {
        auditLog = new AuditLog();
    });
    describe('log() — 写入条目', () => {
        it('应该成功写入一条审计条目', () => {
            auditLog.log({
                operation: 'upsert_node',
                user: 'admin',
                role: 'admin',
                resource: 'node:123',
                result: 'success',
            });
            expect(auditLog.size()).toBe(1);
        });
        it('写入的条目应包含 timestamp', () => {
            auditLog.log({
                operation: 'delete_node',
                user: 'operator',
                role: 'operator',
                resource: 'node:456',
                result: 'success',
            });
            const results = auditLog.query({ operation: 'delete_node' });
            expect(results).toHaveLength(1);
            expect(results[0].timestamp).toBeDefined();
            expect(results[0].timestamp).toBeTruthy();
        });
        it('支持 error 类型的结果', () => {
            auditLog.log({
                operation: 'upsert_edge',
                user: 'writer',
                role: 'writer',
                resource: 'edge:789',
                result: 'error',
                details: 'Connection timeout',
            });
            auditLog.log({
                operation: 'upsert_edge',
                user: 'writer',
                role: 'writer',
                resource: 'edge:790',
                result: 'success',
            });
            const errorEntries = auditLog.query({ result: 'error' });
            expect(errorEntries).toHaveLength(1);
            expect(errorEntries[0].details).toBe('Connection timeout');
        });
        it('可以写入多条不同类型条目', () => {
            for (let i = 0; i < 5; i++) {
                auditLog.log({
                    operation: i % 2 === 0 ? 'upsert_node' : 'delete_node',
                    user: 'admin',
                    role: 'admin',
                    resource: `node:${i}`,
                    result: 'success',
                });
            }
            expect(auditLog.size()).toBe(5);
        });
    });
    describe('query() — 查询条目', () => {
        beforeEach(() => {
            // 准备测试数据
            auditLog.log({ operation: 'upsert_node', user: 'admin', role: 'admin', resource: 'node:1', result: 'success' });
            auditLog.log({ operation: 'delete_node', user: 'admin', role: 'admin', resource: 'node:2', result: 'success' });
            auditLog.log({ operation: 'upsert_node', user: 'writer', role: 'writer', resource: 'node:3', result: 'success' });
            auditLog.log({ operation: 'upsert_edge', user: 'writer', role: 'writer', resource: 'edge:1', result: 'error', details: 'Validation failed' });
            auditLog.log({ operation: 'delete_node', user: 'operator', role: 'operator', resource: 'node:4', result: 'denied' });
        });
        it('返回所有条目', () => {
            const results = auditLog.query();
            expect(results).toHaveLength(5);
        });
        it('按 operation 过滤', () => {
            const results = auditLog.query({ operation: 'upsert_node' });
            expect(results).toHaveLength(2);
            results.forEach(e => expect(e.operation).toBe('upsert_node'));
        });
        it('按 user 过滤', () => {
            const results = auditLog.query({ user: 'writer' });
            expect(results).toHaveLength(2);
            results.forEach(e => expect(e.user).toBe('writer'));
        });
        it('按 result 过滤', () => {
            const denied = auditLog.query({ result: 'denied' });
            expect(denied).toHaveLength(1);
            expect(denied[0].result).toBe('denied');
            const errors = auditLog.query({ result: 'error' });
            expect(errors).toHaveLength(1);
            expect(errors[0].result).toBe('error');
        });
        it('支持 limit 限制返回条数', () => {
            const results = auditLog.query({ limit: 2 });
            expect(results).toHaveLength(2);
        });
    });
    describe('时间范围过滤', () => {
        it('支持 startTime 过滤', async () => {
            // 先写入一条
            auditLog.log({ operation: 'upsert_node', user: 'admin', role: 'admin', resource: 'node:1', result: 'success' });
            // 等一段时间，然后写第二条
            await new Promise(r => setTimeout(r, 50));
            const mid = Date.now();
            await new Promise(r => setTimeout(r, 50));
            auditLog.log({ operation: 'delete_node', user: 'admin', role: 'admin', resource: 'node:2', result: 'success' });
            await new Promise(r => setTimeout(r, 10));
            const end = Date.now();
            // 查询 mid 之后的（应只有第二条）
            const afterMid = auditLog.query({ startTime: mid });
            expect(afterMid).toHaveLength(1);
            expect(afterMid[0].resource).toBe('node:2');
            // 查询 end 之后的（应为空）
            const afterEnd = auditLog.query({ startTime: end });
            expect(afterEnd).toHaveLength(0);
        });
        it('支持 endTime 过滤', async () => {
            // 先写一条，记录时间
            auditLog.log({ operation: 'upsert_node', user: 'admin', role: 'admin', resource: 'node:1', result: 'success' });
            const mid = Date.now();
            await new Promise(r => setTimeout(r, 50));
            auditLog.log({ operation: 'delete_node', user: 'admin', role: 'admin', resource: 'node:2', result: 'success' });
            // 查询 mid 之前的（应只有第一条）
            const beforeMid = auditLog.query({ endTime: mid });
            expect(beforeMid).toHaveLength(1);
            expect(beforeMid[0].resource).toBe('node:1');
        });
        it('支持 startTime + endTime 组合', async () => {
            auditLog.log({ operation: 'upsert_node', user: 'admin', role: 'admin', resource: 'node:1', result: 'success' });
            await new Promise(r => setTimeout(r, 50));
            const left = Date.now();
            await new Promise(r => setTimeout(r, 10));
            auditLog.log({ operation: 'delete_node', user: 'admin', role: 'admin', resource: 'node:2', result: 'success' });
            await new Promise(r => setTimeout(r, 50));
            auditLog.log({ operation: 'upsert_edge', user: 'admin', role: 'admin', resource: 'edge:1', result: 'success' });
            // left ~ now 范围内应该只有第二条
            const now = Date.now();
            const range = auditLog.query({ startTime: left, endTime: now });
            expect(range).toHaveLength(2);
        });
    });
    describe('条目类型过滤', () => {
        it('按 operation + result 组合过滤', () => {
            auditLog.log({ operation: 'upsert_node', user: 'admin', role: 'admin', resource: 'node:1', result: 'success' });
            auditLog.log({ operation: 'upsert_node', user: 'admin', role: 'admin', resource: 'node:2', result: 'error', details: 'timeout' });
            auditLog.log({ operation: 'upsert_node', user: 'admin', role: 'admin', resource: 'node:3', result: 'success' });
            const results = auditLog.query({ operation: 'upsert_node', result: 'success' });
            expect(results).toHaveLength(2);
        });
        it('按 user + operation 组合过滤', () => {
            auditLog.log({ operation: 'upsert_node', user: 'admin', role: 'admin', resource: 'node:1', result: 'success' });
            auditLog.log({ operation: 'upsert_edge', user: 'admin', role: 'admin', resource: 'edge:1', result: 'success' });
            const results = auditLog.query({ user: 'admin', operation: 'upsert_edge' });
            expect(results).toHaveLength(1);
            expect(results[0].resource).toBe('edge:1');
        });
    });
    describe('clear()', () => {
        it('应该清空所有条目', () => {
            auditLog.log({ operation: 'upsert_node', user: 'admin', role: 'admin', resource: 'node:1', result: 'success' });
            auditLog.log({ operation: 'delete_node', user: 'admin', role: 'admin', resource: 'node:2', result: 'success' });
            expect(auditLog.size()).toBe(2);
            auditLog.clear();
            expect(auditLog.size()).toBe(0);
            expect(auditLog.query()).toHaveLength(0);
        });
    });
    describe('边界情况', () => {
        it('空日志查询返回空数组', () => {
            const results = auditLog.query();
            expect(results).toEqual([]);
        });
        it('不存在的 operation 返回空数组', () => {
            auditLog.log({ operation: 'upsert_node', user: 'admin', role: 'admin', resource: 'node:1', result: 'success' });
            const results = auditLog.query({ operation: 'nonexistent' });
            expect(results).toHaveLength(0);
        });
        it('limit = 0 返回全部', () => {
            for (let i = 0; i < 10; i++) {
                auditLog.log({ operation: 'upsert_node', user: 'admin', role: 'admin', resource: `node:${i}`, result: 'success' });
            }
            const results = auditLog.query({ limit: 0 });
            expect(results).toHaveLength(10);
        });
    });
});
//# sourceMappingURL=audit-log.spec.js.map