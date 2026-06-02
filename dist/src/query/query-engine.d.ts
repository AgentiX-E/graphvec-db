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
 *
 * 支持 DML 语句：
 *   CREATE (n:Label {prop: "val"})
 *   CREATE (a)-[:KNOWS]->(b)
 *   MATCH (n) DELETE n
 *   MATCH (n) SET n.name = "val"
 *   MERGE (n:Label {id: 1})
 */
/** 默认查询 LIMIT，当查询没有显式 LIMIT 子句时使用 */
export declare const DEFAULT_LIMIT = 1000;
export interface QueryAST {
    type: 'QUERY';
    match?: {
        type: 'MATCH';
        patterns: PatternAST[];
    };
    /** OPTIONAL MATCH clauses */
    optionalMatches?: Array<{
        type: 'OPTIONAL_MATCH';
        patterns: PatternAST[];
        where?: WhereClauseAST | null;
    }>;
    /** WITH clause */
    with?: WithClauseAST;
    where?: WhereClauseAST | null;
    return?: ReturnClauseAST;
    orderBy?: OrderByAST | null;
    /** GROUP BY columns */
    groupBy?: PrimaryAST[];
    limit?: number | undefined;
    skip?: number | undefined;
    aggregate?: AggregateClause;
    unionType?: 'union' | 'union_all' | 'intersect' | 'subtract';
    rightQuery?: QueryAST;
    create?: CreateClauseAST;
    delete?: DeleteClauseAST;
    set?: SetClauseAST;
    merge?: MergeClauseAST;
}
/** WITH clause: WITH expr1 AS alias1, expr2 AS alias2 [WHERE condition] [ORDER BY ...] [LIMIT n] */
export interface WithClauseAST {
    type: 'WITH';
    columns: ColumnAST[];
    where?: WhereClauseAST | null;
    orderBy?: OrderByAST | null;
    limit?: number | undefined;
    skip?: number | undefined;
    aggregate?: AggregateClause;
}
export interface CreateClauseAST {
    type: 'CREATE';
    patterns: CreateNodeItemAST[];
}
export interface CreateNodeItemAST {
    type: 'CREATE_NODE' | 'CREATE_PATH';
    node: NodePatternAST;
    edges?: EdgeStepAST[];
}
export interface DeleteClauseAST {
    type: 'DELETE';
    targets: string[];
}
export interface SetClauseAST {
    type: 'SET';
    items: SetItemAST[];
}
export interface SetItemAST {
    type: 'SET_ITEM';
    property: PrimaryAST;
    value: PrimaryAST;
}
export interface MergeClauseAST {
    type: 'MERGE';
    patterns: CreateNodeItemAST[];
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
        range?: {
            min: number;
            max: number | null;
        };
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
    /** 操作类型 */
    type?: 'QUERY' | 'CREATE' | 'DELETE' | 'SET' | 'MERGE';
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
    /** 是否来自 MATCH 扫描（用于区分无标签 MATCH 和纯 WITH/UNWIND） */
    hasMatch?: boolean;
    /** 聚合子句（如 count, sum, avg, max, min） */
    aggregate?: AggregateClause;
    /** GROUP BY 列 */
    groupBy?: string[];
    /** HAVING 过滤器 */
    having?: HavingClause[];
    /** OPTIONAL MATCH 步骤（如果匹配不到返回 null 绑定） */
    optionalMatchSteps?: Array<{
        scanLabel: string | null;
        steps: TraverseStep[];
        filters: FilterClause[];
    }>;
    /** WITH 子句：管道中间投影 */
    with?: {
        columns: Array<{
            expression: string;
            alias: string | null;
        }>;
        filters: FilterClause[];
        orderBy: Array<{
            property: string;
            direction: 'ASC' | 'DESC';
        }>;
        limit: number | undefined;
        skip: number | undefined;
        aggregate?: AggregateClause;
    };
    /** 集合运算类型 */
    unionType?: 'union' | 'union_all' | 'intersect' | 'subtract';
    /** 集合运算右半部分 */
    rightPlan?: QueryPlan;
    /** UNWIND 子句 */
    unwind?: {
        list: any[];
        name: string;
        var?: string;
    };
    /** CASE 表达式列（需要运行时求值的复杂表达式） */
    caseColumns?: Array<{
        expression: any;
        alias: string;
    }>;
    /** EXISTS 子查询过滤器 */
    existsFilters?: Array<{
        source: string;
        edgeLabel: string | null;
        direction: 'out' | 'in' | 'any';
        target: string;
    }>;
    /** CALL 子查询 */
    callQuery?: QueryPlan;
    /** CREATE 节点 */
    createNodes?: Array<{
        alias: string;
        label: string | null;
        props: Record<string, unknown> | null;
    }>;
    /** CREATE 边 */
    createEdges?: Array<{
        source: string;
        target: string;
        label: string | null;
        direction: 'out' | 'in' | 'any';
    }>;
    /** DELETE 目标 */
    deleteTargets?: string[];
    /** SET 子句 */
    setClauses?: Array<{
        property: string;
        value: unknown;
    }>;
    /** MERGE 节点 */
    mergeNodes?: Array<{
        alias: string;
        label: string | null;
        props: Record<string, unknown> | null;
    }>;
    mergeEdges?: Array<{
        source: string;
        target: string;
        label: string | null;
        direction: 'out' | 'in' | 'any';
    }>;
}
export interface TraverseStep {
    source: string;
    direction: 'out' | 'in' | 'any';
    edgeLabel: string | null;
    targetAlias: string;
    targetLabel: string | null;
    targetProps: Record<string, unknown> | null;
    /** 变长路径范围（如果此步为变长路径） */
    range?: {
        min: number;
        max: number | null;
    };
}
export interface FilterClause {
    source: string;
    property: string;
    operator: 'EQ' | 'NEQ' | 'GT' | 'GTE' | 'LT' | 'LTE' | 'IN' | 'STARTS_WITH' | 'ENDS_WITH' | 'CONTAINS';
    value: unknown;
}
/**
 * 解析 Cypher-lite 查询字符串为 QueryPlan，支持参数化查询
 * 以防注入风险。
 *
 * 参数占位符格式：$1, $2, ..., $N
 * 参数会被安全地序列化并替换到查询语句中。
 *
 * @param query - 查询字符串（可包含 $N 占位符）
 * @param params - 可选参数数组
 * @returns QueryPlan
 *
 * @example
 *   execQuery('MATCH (n:Person) WHERE n.name = $1', ['Alice'])
 *   execQuery('MATCH (n:Person) WHERE n.age IN $1', [[25, 30, 35]])
 */
export declare function execQuery(query: string, params?: unknown[]): QueryPlan;
/**
 * 预处理查询：提取 OPTIONAL MATCH 和 WITH 子句，
 * 将其替换为 peggy 可解析的等效语法，再以结构化数据形式附加到 AST 上。
 *
 * 策略：
 *   OPTIONAL MATCH (a)-[:KNOWS]->(b) WHERE b.age > 30
 *   → 在 OPTIONAL 后插入 `__OPT__N__` 标记节点，使 peggy 能解析为 MATCH，
 *     解析后我们通过检测该节点名识别出它是 OPTIONAL MATCH。
 *
 *   WITH n, n.age AS age WHERE age > 18 RETURN n
 *   → WITH 后的内容转换为伪 MATCH + RETURN 语法使 peggy 可解析，
 *     然后从 AST 中提取所需信息重构 WITH 子句。
 */
export declare function _preprocessQuery(query: string): {
    cleanQuery: string;
    extracts: _QueryExtracts;
};
/**
 * Raw extraction result data for post-processing.
 */
export interface _QueryExtracts {
    optionalMatches: string[];
    withRaw?: string[];
    withClause: null;
    havingRaw?: string;
    orderByAggReplacements?: Array<{
        placeholder: string;
        original: string;
    }>;
}
/**
 * Parse a raw OPTIONAL MATCH extraction string into a pattern + where for plan building.
 * The extraction string is like: "(a:Person)-[:KNOWS]->(b) WHERE b.age > 30"
 */
export declare function _parseOptionalMatchExtract(extract: string): {
    pattern: PatternAST | null;
    filters: FilterClause[];
};
/**
 * Parse a raw WITH extraction string into structured information.
 * Format: "expr1 AS alias1, expr2 AS alias2 [WHERE ...] [ORDER BY ...] [LIMIT n]"
 */
export declare function _parseWithExtract(extract: string): {
    columns: Array<{
        expression: string;
        alias: string | null;
    }>;
    filters: FilterClause[];
    orderBy: Array<{
        property: string;
        direction: 'ASC' | 'DESC';
    }>;
    limit: number | undefined;
    skip: number | undefined;
    aggregate?: AggregateClause;
};
/**
 * 解析 Cypher-lite 查询字符串为 QueryPlan
 */
export declare function parseQuery(query: string): QueryPlan;
/**
 * Post-process the parsed AST to attach OPTIONAL MATCH and WITH information
 * extracted during preprocessing.
 */
export declare function _postProcessAST(ast: QueryAST, extracts: _QueryExtracts): void;
/**
 * Cached version of parseQuery: checks planCache before parsing.
 * Only caches on success (parse errors still throw without caching).
 */
export declare function parseQueryCached(query: string, schema?: import('../schema/schema-types').SchemaDef): QueryPlan;
/**
 * 将 AST 转换为 QueryPlan
 *
 * @param ast - parsed query AST
 * @param schema - optional schema for lightweight type validation
 */
export declare function planFromAST(ast: QueryAST, schema?: import('../schema/schema-types').SchemaDef): QueryPlan;
export interface AggregateResult {
    type: 'count' | 'sum' | 'avg' | 'max' | 'min';
    field: string;
    alias: string | null;
    value: number | null;
}
/**
 * 计算聚合函数值。
 *
 * 对给定的一组数值应用聚合函数：
 * - count: 返回数组长度
 * - sum: 返回所有值之和
 * - avg: 返回平均值
 * - max: 返回最大值
 * - min: 返回最小值
 *
 * @param fn - 聚合函数类型
 * @param values - 数值数组（count 忽略值内容，只计数）
 * @returns 聚合结果
 *
 * @example
 *   _evaluateAggregate('count', [1, 2, 3])   // { ..., value: 3 }
 *   _evaluateAggregate('sum', [1, 2, 3])      // { ..., value: 6 }
 *   _evaluateAggregate('avg', [1, 2, 3])      // { ..., value: 2 }
 *   _evaluateAggregate('max', [1, 2, 3])      // { ..., value: 3 }
 *   _evaluateAggregate('min', [1, 2, 3])      // { ..., value: 1 }
 */
export declare function _evaluateAggregate(fn: AggregateResult['type'], values: unknown[], field?: string): AggregateResult;
/**
 * 从节点记录列表中计算聚合值，返回 Map<aggregateKey, value>。
 *
 * @param fn - 聚合函数类型
 * @param field - 聚合字段（如 'age' 或 '*'）
 * @param records - 节点记录数组
 * @returns Map，key 是聚合字段名，value 是聚合结果
 */
export declare function aggregateRecords(fn: AggregateResult['type'], field: string, records: Array<Record<string, unknown>>): Map<string, number | null>;
/**
 * Parse an aggregate function call string into structured info.
 * Returns null if the expression is not an aggregate.
 *
 * @example
 *   _parseAggregate('count(*)')       → { fn: 'COUNT', field: '*', distinct: false }
 *   _parseAggregate('COUNT(DISTINCT name)') → { fn: 'COUNT', field: 'name', distinct: true }
 *   _parseAggregate('sum(n.age)')     → { fn: 'SUM', field: 'n.age', distinct: false }
 *   _parseAggregate('n.name')         → null
 */
export interface AggColumnInfo {
    fn: 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';
    field: string;
    prop: string;
    distinct: boolean;
    alias: string | null;
}
export declare function _parseAggregate(expr: string): AggColumnInfo | null;
/**
 * Check if an expression string is an aggregate function call.
 */
export declare function _isAggregateExpression(expr: string): boolean;
/**
 * Extract all aggregate column info from a list of column strings.
 * Returns both aggregate columns and non-aggregate (group-by) columns.
 *
 * @example
 *   _extractAggColumns(['n', 'count(*) AS cnt'])
 *   → { aggCols: [{ fn: 'COUNT', field: '*', ... }], groupByCols: ['n'] }
 */
export interface AggColumnGroup {
    aggCols: AggColumnInfo[];
    groupByCols: string[];
}
export declare function _extractAggColumns(colExprs: string[]): AggColumnGroup;
/**
 * Row type for query execution — a flat record mapping aliases to values.
 * Unlike NodeRecord which is a formal node representation, QueryRow is
 * a simple key-value projection used during WITH/RETURN transformation.
 */
export type QueryRow = Record<string, unknown>;
/**
 * Execute aggregation over a set of rows.
 *
 * Behavior:
 * - If there are only aggregate columns (no group-by columns): return a single row
 * - If there are both aggregate and non-aggregate columns: group by non-aggregate columns
 *   (SQL standard behavior: every non-aggregate column in SELECT/WITH implicitly
 *   becomes a GROUP BY key)
 *
 * @param rows - Input rows (projected to column expressions)
 * @param aggCols - Aggregate column definitions
 * @param groupByCols - Non-aggregate column expressions for grouping
 * @returns Aggregated rows
 */
export declare function _executeAggregation(rows: QueryRow[], aggCols: AggColumnInfo[], groupByCols: string[], withColAliases?: Array<{
    expression: string;
    alias: string | null;
}>): QueryRow[];
/**
 * Check whether a column list contains any aggregate expressions.
 */
export declare function _hasAggregates(colExprs: string[]): boolean;
/**
 * Convert a WITH clause raw columns to column expression strings,
 * detecting aggregates and setting the aggregate flag on the plan.
 *
 * @returns Enhanced columns with aggregate detection
 */
export declare function _enrichWithAggregates(columns: Array<{
    expression: string;
    alias: string | null;
}>): Array<{
    expression: string;
    alias: string | null;
    isAggregate?: boolean;
    aggFn?: string;
    distinct?: boolean;
    aggField?: string;
}>;
/**
 * Result of a query execution — a list of flat rows.
 */
export type QueryResult = QueryRow[];
export declare function _executeQuery(plan: QueryPlan, nodes: Array<Record<string, unknown>>): QueryResult;
/**
 * 优化 AST，返回优化后的 AST。
 *
 * 优化策略：
 * 1. 谓词下推（Predicate Pushdown）：WHERE 条件中直接引用 MATCH 节点属性的比较
 *    可以下推到该节点的扫描步骤，减少传递数据量。
 * 2. 投影剪裁（Projection Pruning）：RETURN 中只引用某些属性时，可以提前只解析
 *    需要的字段，减少数据加载量。
 * 3. 简单成本估算：根据扫描标签的类型组基数估算每个步骤的代价，
 *    重新排序遍历步骤以最小化中间结果集。
 *
 * @param ast - 原始 AST
 * @returns 优化后的 AST（新对象，不修改原始 AST）
 */
export declare function _optimizePlan(ast: QueryAST): QueryAST;
/**
 * Lightweight query-time type validation.
 *
 * Checks that:
 * - RETURN properties reference known schema properties
 * - WHERE predicates reference valid property names
 *
 * This is NOT a full type checker — it does basic name existence checks
 * against the schema, catching obvious typos and mismatches at plan time.
 *
 * @throws Error with a descriptive message on first validation failure
 */
export declare function _validateQueryTypes(query: QueryAST, schema?: import('../schema/schema-types').SchemaDef): void;
/**
 * Simple LRU-like in-memory cache for pre-compiled QueryPlan objects.
 *
 * Cache key = djb2 hash of normalized query string (computed inline).
 * Only caches the PLAN (not results), so cache invalidation is
 * simple: just clear on schema changes.
 * Max size prevents unbounded memory growth.
 * Backed by lru-cache v11.
 *
 * Delegates to query-planner's global planCache for cross-module
 * coordination — sets and clears are mirrored, and get() falls back
 * to planner's cache with on-the-fly re-parse of cache key presence.
 */
export declare class QueryPlanCache {
    private _lru;
    constructor(maxSize?: number);
    /** Normalize a query string for hashing */
    private static _normalize;
    /** Simple djb2 hash of a string */
    private static _hash;
    /** Generate cache key from a query string */
    static key(query: string): string;
    /** Get cached plan, or undefined on miss */
    get(query: string): QueryPlan | undefined;
    /** Store a plan in the cache. Also mirrors to planner's cache when possible. */
    set(query: string, plan: QueryPlan): void;
    /** Remove a specific entry */
    delete(query: string): void;
    /** Clear all cached plans */
    clear(): void;
    /** Current cache size */
    get size(): number;
}
/**
 * Global query plan cache instance.
 * Cleared automatically when schema changes are detected.
 */
export declare const planCache: QueryPlanCache;
/**
 * ParameterizedQuery — 预编译 + 安全绑定的参数化查询。
 *
 * 编译阶段：将 $name 替换为 sentinel 大数（800000000+）并解析。
 * 执行阶段：深拷贝缓存的 QueryPlan，检测 sentinel 值并替换为实际参数。
 *
 * 使用示例：
 * ```ts
 * const pq = new ParameterizedQuery("MATCH (n:Person) WHERE n.name = $name AND n.age > $age")
 * const plan = pq.execute({ name: 'Alice', age: 25 })
 * ```
 */
export declare class ParameterizedQuery {
    /** 原始查询模板字符串 */
    readonly template: string;
    /** 参数名列表（按出现顺序） */
    private paramNames;
    /** 参数名 → 唯一 sentinel 数字字符串 */
    private paramSentinels;
    /** 编译后的 QueryPlan */
    private cachedPlan;
    constructor(template: string);
    /**
     * 获取参数名列表。
     */
    getParamNames(): string[];
    /**
     * 检查是否包含指定参数。
     */
    hasParam(name: string): boolean;
    /**
     * 绑定参数并返回 QueryPlan。
     *
     * @param params - 参数对象，如 { name: 'Alice', age: 25 }
     * @throws 如果缺少必填参数
     */
    execute(params: Record<string, unknown>): QueryPlan;
    /**
     * 静态工厂。
     */
    static compile(query: string): ParameterizedQuery;
}
/**
 * 执行参数化 Cypher-lite 查询。
 *
 * 对同一模板的多次调用只解析一次，后续从缓存获取。
 * 参数安全注入（无字符串拼接）。
 *
 * @param template - 查询模板，如 "MATCH (n:Person) WHERE n.name = $name"
 * @param params - 参数对象，如 { name: 'Alice' }
 * @returns QueryPlan（参数已注入）
 *
 * @example
 * ```ts
 * const plan = cypher("MATCH (n) WHERE n.id = $id", { id: 5 })
 * const plan = cypher("MATCH (n:Person) WHERE n.name = $name AND n.age > $age", {
 *   name: 'Alice',
 *   age: 25
 * })
 * ```
 */
export declare function cypher(template: string, params?: Record<string, unknown>): QueryPlan;
/**
 * 预编译并缓存参数化查询模板，返回可复用的 ParameterizedQuery 实例。
 */
export declare function compileCypher(template: string): ParameterizedQuery;
export declare const BUILTIN_FUNCTIONS: Record<string, (...args: any[]) => any>;
export declare function isBuiltinFunction(name: string): boolean;
export declare function executeBuiltinFunction(name: string, args: any[]): any;
export interface HavingClause {
    property: string;
    operator: 'GT' | 'GTE' | 'LT' | 'LTE' | 'EQ' | 'NEQ';
    value: number;
}
/**
 * Apply GROUP BY aggregation and HAVING filter on data.
 * Groups data by groupBy keys, applies aggregate function, then filters by HAVING.
 */
export declare function _applyGroupByHaving(data: Array<Record<string, unknown>>, groupBy: string[], aggregate: {
    type: string;
    field?: string;
}, having?: HavingClause[]): Array<Record<string, unknown>>;
//# sourceMappingURL=query-engine.d.ts.map