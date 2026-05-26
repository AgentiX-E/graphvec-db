"use strict";
/**
 * query-engine.ts — Cypher-lite AST → Fluent API Transformer
 *
 * 将 peggy 解析出的 AST 转换为 OverGraph Fluent API 调用链。
 * 主要转换：
 *   MATCH (a:Person)-[:KNOWS]->(b) WHERE b.age > 30 RETURN b.name
 *   → engine.scan('Person').as('a').traverse('out').filter('age', '>', 30).as('b').return(['name'])
 *
 * 多跳支持：
 *   MATCH (a)-[:KNOWS]->(b)-[:WORKS_AT]->(c) WHERE c.name = "Acme" RETURN a.name
 *   → engine.scan('KNOWS' direction: 'out').traverse('out', 'WORKS_AT').filter('name', 'EQ', "Acme").as('c').return(['name'])
 *
 * 注意：当前实现依赖 OverGraph 的 Fluent API，未完全覆盖所有匹配模式。
 * 复杂的多跳路径展开使用 expandPath() 算法。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseQuery = parseQuery;
exports.planFromAST = planFromAST;
const cypher_lite_parser_1 = require("./cypher-lite-parser");
// ── 解析 + 转换 ──────────────────────────────────────────────
/**
 * 解析 Cypher-lite 查询字符串为 QueryPlan
 */
function parseQuery(query) {
    let ast;
    try {
        ast = cypher_lite_parser_1.parser.parse(query);
    }
    catch (err) {
        throw new Error(`Query parse error: ${err.message}`);
    }
    return planFromAST(ast);
}
/**
 * 将 AST 转换为 QueryPlan
 */
function planFromAST(ast) {
    // 处理第一个 pattern
    const pattern = ast.match.patterns[0];
    if (!pattern) {
        throw new Error('MATCH clause requires at least one pattern');
    }
    const plan = {
        scanLabel: pattern.node.label,
        steps: [],
        filters: [],
        returnColumns: [],
        orderBy: [],
        limit: ast.limit,
        skip: ast.skip,
        aggregate: ast.aggregate,
        unionType: ast.unionType,
        rightPlan: ast.rightQuery ? planFromAST(ast.rightQuery) : undefined,
    };
    // 处理遍历步骤
    for (const step of pattern.edges) {
        plan.steps.push({
            source: step.node.name,
            direction: step.edge.direction,
            edgeLabel: step.edge.label,
            targetAlias: step.node.name,
            targetLabel: step.node.label,
            targetProps: step.node.props,
        });
    }
    // 处理 WHERE
    if (ast.where) {
        plan.filters.push(...extractFilters(ast.where.expression, plan.steps));
    }
    // 处理 RETURN
    if (ast.return.aggregate) {
        // 聚合函数：用 alias 或字段名作为返回列名
        const agg = ast.return.aggregate;
        plan.aggregate = agg;
        plan.returnColumns = [agg.alias ?? agg.field ?? agg.type];
    }
    else {
        plan.returnColumns = ast.return.columns.map(col => col.alias ?? formatColumn(col.expression));
    }
    // 处理 ORDER BY
    if (ast.orderBy) {
        plan.orderBy = ast.orderBy.columns.map(col => ({
            property: formatColumn(col.expression),
            direction: col.direction,
        }));
    }
    return plan;
}
// ── 帮助函数 ─────────────────────────────────────────────────
function extractFilters(expr, steps) {
    if (expr.type === 'AND') {
        const left = extractFilters(expr.left, steps);
        const right = extractFilters(
        // 如果 right 是数组
        Array.isArray(expr.right) ? expr.right[0] : expr.right, steps);
        return [...left, ...right];
    }
    if (expr.type === 'COMPARISON') {
        const left = expr.left;
        const right = expr.right;
        let propRef;
        let value;
        if (left.type === 'PROP_REF' && right.type !== 'PROP_REF') {
            propRef = left;
            value = resolvePrimary(right);
        }
        else if (right.type === 'PROP_REF' && left.type !== 'PROP_REF') {
            propRef = right;
            value = resolvePrimary(left);
        }
        else {
            return []; // 不支持 prop = prop 比较
        }
        return [{
                source: propRef.name,
                property: propRef.property,
                operator: expr.operator,
                value,
            }];
    }
    return [];
}
function resolvePrimary(p) {
    switch (p.type) {
        case 'STRING': return p.value;
        case 'NUMBER': return p.value;
        case 'BOOLEAN': return p.value;
        case 'IDENTIFIER': return p.name;
        default: return null;
    }
}
function formatColumn(expr) {
    if (expr.type === 'PROP_REF')
        return expr.property;
    if (expr.type === 'IDENTIFIER')
        return expr.name;
    if (expr.type === 'STRING')
        return expr.value;
    return String(expr);
}
//# sourceMappingURL=query-engine.js.map