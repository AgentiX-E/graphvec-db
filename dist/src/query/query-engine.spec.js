"use strict";
/**
 * query-engine 单元测试
 */
Object.defineProperty(exports, "__esModule", { value: true });
const query_engine_1 = require("./query-engine");
describe('parseQuery — Cypher-lite 解析 + QueryPlan 转换', () => {
    it('简单 MATCH + RETURN', () => {
        const plan = (0, query_engine_1.parseQuery)('MATCH (n) RETURN n');
        expect(plan.scanLabel).toBeNull();
        expect(plan.steps).toEqual([]);
        expect(plan.returnColumns).toEqual(['n']);
    });
    it('MATCH 带标签', () => {
        const plan = (0, query_engine_1.parseQuery)('MATCH (n:Person) RETURN n');
        expect(plan.scanLabel).toBe('Person');
        expect(plan.returnColumns).toEqual(['n']);
    });
    it('MATCH 单跳边', () => {
        const plan = (0, query_engine_1.parseQuery)('MATCH (a)-[:KNOWS]->(b) RETURN b');
        expect(plan.steps.length).toBe(1);
        expect(plan.steps[0].edgeLabel).toBe('KNOWS');
        expect(plan.steps[0].direction).toBe('out');
        expect(plan.steps[0].targetAlias).toBe('b');
    });
    it('MATCH 单跳边 + WHERE', () => {
        const plan = (0, query_engine_1.parseQuery)("MATCH (a)-[:KNOWS]->(b) WHERE b.age > 30 RETURN b.name");
        expect(plan.steps.length).toBe(1);
        expect(plan.filters.length).toBe(1);
        expect(plan.filters[0].property).toBe('age');
        expect(plan.filters[0].operator).toBe('GT');
        expect(plan.filters[0].value).toBe(30);
        expect(plan.returnColumns).toEqual(['name']);
    });
    it('MATCH 多跳', () => {
        const plan = (0, query_engine_1.parseQuery)("MATCH (a)-[:KNOWS]->(b)-[:WORKS_AT]->(c) WHERE c.name = 'Acme' RETURN a.name");
        expect(plan.steps.length).toBe(2);
        expect(plan.steps[0].edgeLabel).toBe('KNOWS');
        expect(plan.steps[1].edgeLabel).toBe('WORKS_AT');
        expect(plan.filters.length).toBe(1);
    });
    it('ORDER BY + LIMIT', () => {
        const plan = (0, query_engine_1.parseQuery)("MATCH (n:Person) WHERE n.age > 18 RETURN n.name ORDER BY n.age DESC LIMIT 10");
        expect(plan.orderBy.length).toBe(1);
        expect(plan.orderBy[0].direction).toBe('DESC');
        expect(plan.limit).toBe(10);
    });
    it('SKIP + LIMIT', () => {
        const plan = (0, query_engine_1.parseQuery)("MATCH (n) RETURN n SKIP 5 LIMIT 10");
        expect(plan.skip).toBe(5);
        expect(plan.limit).toBe(10);
    });
    it('节点属性模式', () => {
        const plan = (0, query_engine_1.parseQuery)("MATCH (n {status: 'active'}) RETURN n.name");
        expect(plan.scanLabel).toBeNull();
    });
    it('多 pattern（逗号分隔）', () => {
        const plan = (0, query_engine_1.parseQuery)("MATCH (a:Person), (b:Company) RETURN a");
        // 目前只处理第一个 pattern
        expect(plan.scanLabel).toBe('Person');
    });
    it('WHERE AND 复合条件', () => {
        const plan = (0, query_engine_1.parseQuery)("MATCH (n:Person) WHERE n.age > 18 AND n.status = 'active' RETURN n.name");
        expect(plan.filters.length).toBe(2);
        expect(plan.filters[0].operator).toBe('GT');
        expect(plan.filters[1].operator).toBe('EQ');
    });
    it('WHERE OR 条件——OR 不被 flatten', () => {
        const plan = (0, query_engine_1.parseQuery)("MATCH (n:Person) WHERE n.age > 18 OR n.status = 'vip' RETURN n.name");
        // OR 表达式不作为简单过滤器提取（需要执行时做短路评估）
        expect(plan.filters.length).toBe(0);
    });
    it('解析错误抛出有意义的错误', () => {
        expect(() => (0, query_engine_1.parseQuery)('SELECT * FROM users')).toThrow('Query parse error');
    });
    it('无 MATCH 抛出错误', () => {
        expect(() => (0, query_engine_1.parseQuery)('RETURN 1')).toThrow('Query parse error');
    });
    it('字符串值正确解析', () => {
        const plan = (0, query_engine_1.parseQuery)("MATCH (n) WHERE n.name = 'Alice' RETURN n");
        expect(plan.filters.length).toBe(1);
        expect(plan.filters[0].value).toBe('Alice');
        expect(plan.filters[0].operator).toBe('EQ');
    });
    it('数字比较', () => {
        const plan = (0, query_engine_1.parseQuery)('MATCH (n) WHERE n.score >= 90 RETURN n');
        expect(plan.filters.length).toBe(1);
        expect(plan.filters[0].value).toBe(90);
        expect(plan.filters[0].operator).toBe('GTE');
    });
    it('不等于', () => {
        const plan = (0, query_engine_1.parseQuery)("MATCH (n) WHERE n.status != 'deleted' RETURN n");
        expect(plan.filters[0].operator).toBe('NEQ');
    });
    it('返回值别名', () => {
        const plan = (0, query_engine_1.parseQuery)("MATCH (n:Person) RETURN n.name AS username");
        expect(plan.returnColumns).toEqual(['username']);
    });
});
//# sourceMappingURL=query-engine.spec.js.map