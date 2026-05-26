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
export interface QueryAST {
    type: 'QUERY';
    match: {
        type: 'MATCH';
        patterns: PatternAST[];
    };
    where: WhereClauseAST | null;
    return: ReturnClauseAST;
    orderBy: OrderByAST | null;
    limit: number | undefined;
    skip: number | undefined;
    aggregate?: AggregateClause;
    unionType?: 'union' | 'union_all' | 'intersect' | 'subtract';
    rightQuery?: QueryAST;
}
export interface PatternAST {
    type: 'PATH';
    node: NodePatternAST;
    edges: EdgeStepAST[];
}
export interface NodePatternAST {
    type: 'NODE';
    name: string;
    label: string | null;
    props: Record<string, unknown> | null;
}
export interface EdgeStepAST {
    edge: {
        type: 'EDGE';
        name: string | null;
        label: string | null;
        direction: 'out' | 'in' | 'any';
    };
    node: NodePatternAST;
}
export interface WhereClauseAST {
    type: 'WHERE';
    expression: ExpressionAST;
}
export type ExpressionAST = {
    type: 'OR';
    left: ExpressionAST;
    right: ExpressionAST | ExpressionAST[];
} | {
    type: 'AND';
    left: ExpressionAST;
    right: ExpressionAST | ExpressionAST[];
} | {
    type: 'COMPARISON';
    operator: string;
    left: PrimaryAST;
    right: PrimaryAST;
} | PrimaryAST;
export type PrimaryAST = {
    type: 'PROP_REF';
    name: string;
    property: string;
} | {
    type: 'STRING';
    value: string;
} | {
    type: 'NUMBER';
    value: number;
} | {
    type: 'BOOLEAN';
    value: boolean;
} | {
    type: 'IDENTIFIER';
    name: string;
} | {
    type: 'OR';
} | {
    type: 'AND';
} | {
    type: 'COMPARISON';
};
export interface ReturnClauseAST {
    type: 'RETURN';
    columns: ColumnAST[];
    aggregate?: AggregateClause;
}
export interface ColumnAST {
    type: 'COLUMN';
    expression: PrimaryAST;
    alias: string | null;
}
export interface OrderByAST {
    type: 'ORDER_BY';
    columns: OrderColumnAST[];
}
export interface OrderColumnAST {
    type: 'ORDER_COLUMN';
    expression: PrimaryAST;
    direction: 'ASC' | 'DESC';
}
export interface AggregateClause {
    type: 'count' | 'sum' | 'avg' | 'max' | 'min';
    field?: string;
    alias?: string;
}
export interface QueryPlan {
    /** 起始节点标签扫描（如果 MATCH 节点指定了 label） */
    scanLabel: string | null;
    /** 遍历步骤 */
    steps: TraverseStep[];
    /** WHERE 过滤器 */
    filters: FilterClause[];
    /** RETURN 列 */
    returnColumns: string[];
    /** ORDER BY */
    orderBy: Array<{
        property: string;
        direction: 'ASC' | 'DESC';
    }>;
    /** LIMIT */
    limit: number | undefined;
    /** SKIP */
    skip: number | undefined;
    /** 聚合子句（如 count, sum, avg, max, min） */
    aggregate?: AggregateClause;
    /** 集合运算类型 */
    unionType?: 'union' | 'union_all' | 'intersect' | 'subtract';
    /** 集合运算右半部分 */
    rightPlan?: QueryPlan;
}
export interface TraverseStep {
    source: string;
    direction: 'out' | 'in' | 'any';
    edgeLabel: string | null;
    targetAlias: string;
    targetLabel: string | null;
    targetProps: Record<string, unknown> | null;
}
export interface FilterClause {
    source: string;
    property: string;
    operator: 'EQ' | 'NEQ' | 'GT' | 'GTE' | 'LT' | 'LTE';
    value: unknown;
}
/**
 * 解析 Cypher-lite 查询字符串为 QueryPlan
 */
export declare function parseQuery(query: string): QueryPlan;
/**
 * 将 AST 转换为 QueryPlan
 */
export declare function planFromAST(ast: QueryAST): QueryPlan;
//# sourceMappingURL=query-engine.d.ts.map