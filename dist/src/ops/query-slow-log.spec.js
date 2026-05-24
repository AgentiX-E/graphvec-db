"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const query_slow_log_1 = require("./query-slow-log");
describe('QuerySlowLog', () => {
    test('should create with default threshold', () => {
        const qsl = new query_slow_log_1.QuerySlowLog();
        expect(qsl.count).toBe(0);
    });
    test('should create with custom threshold', () => {
        const qsl = new query_slow_log_1.QuerySlowLog(200);
        expect(qsl.count).toBe(0);
    });
    test('should create with custom max entries', () => {
        const qsl = new query_slow_log_1.QuerySlowLog(100, 50);
        expect(qsl.count).toBe(0);
    });
    test('should record a slow query via track', async () => {
        const qsl = new query_slow_log_1.QuerySlowLog(100);
        const result = await qsl.track('testOp', async () => {
            await new Promise(r => setTimeout(r, 200));
            return 'done';
        });
        expect(result).toBe('done');
        expect(qsl.count).toBe(1);
    });
    test('should not record fast queries', async () => {
        const qsl = new query_slow_log_1.QuerySlowLog(1000); // high threshold
        await qsl.track('fastOp', async () => 'result');
        expect(qsl.count).toBe(0);
    });
    test('should record slow queries with user info', async () => {
        const qsl = new query_slow_log_1.QuerySlowLog(50);
        await qsl.track('testOp', async () => {
            await new Promise(r => setTimeout(r, 100));
            return 'done';
        }, 'user-1');
        expect(qsl.count).toBe(1);
    });
    test('should return slow queries via getSlowQueries', async () => {
        const qsl = new query_slow_log_1.QuerySlowLog(50);
        await qsl.track('op1', async () => {
            await new Promise(r => setTimeout(r, 100));
            return 'ok';
        });
        const queries = qsl.getSlowQueries();
        expect(queries.length).toBe(1);
        expect(queries[0].op).toBe('op1');
        expect(queries[0].duration).toBeGreaterThanOrEqual(50);
        expect(queries[0].timestamp).toBeGreaterThan(0);
    });
    test('should clear all logs', async () => {
        const qsl = new query_slow_log_1.QuerySlowLog(50);
        await qsl.track('op1', async () => {
            await new Promise(r => setTimeout(r, 100));
            return 'ok';
        });
        expect(qsl.count).toBe(1);
        qsl.clear();
        expect(qsl.count).toBe(0);
    });
    test('should update threshold', async () => {
        const qsl = new query_slow_log_1.QuerySlowLog(1000);
        qsl.setThreshold(50);
        await qsl.track('op1', async () => {
            await new Promise(r => setTimeout(r, 100));
            return 'ok';
        });
        expect(qsl.count).toBe(1);
    });
    test('should track returned result from wrapped function', async () => {
        const qsl = new query_slow_log_1.QuerySlowLog(50);
        const data = await qsl.track('fetchData', async () => ({ id: 1, name: 'test' }));
        expect(data).toEqual({ id: 1, name: 'test' });
    });
    test('should propagate exceptions from wrapped function', async () => {
        const qsl = new query_slow_log_1.QuerySlowLog(50);
        await expect(qsl.track('errorOp', async () => {
            throw new Error('test error');
        })).rejects.toThrow('test error');
    });
    test('should limit max entries', async () => {
        const qsl = new query_slow_log_1.QuerySlowLog(1, 5); // max 5 entries
        const promises = [];
        for (let i = 0; i < 10; i++) {
            promises.push(qsl.track(`op${i}`, async () => {
                await new Promise(r => setTimeout(r, 10));
                return i;
            }));
        }
        await Promise.all(promises);
        expect(qsl.count).toBeLessThanOrEqual(5);
    });
});
//# sourceMappingURL=query-slow-log.spec.js.map