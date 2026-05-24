"use strict";
// ============================================================
// QueryPlanner — 查询计划生成器
// 将 GraphQuery 转换为可优化的计划树
// ============================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.QueryPlanner = exports.PlanNodeType = void 0;
exports.buildIRFromSpec = buildIRFromSpec;
exports.limitPushdown = limitPushdown;
exports.optimizeIR = optimizeIR;
exports.executeIR = executeIR;
exports.formatPlanExplain = formatPlanExplain;
// ──────────────────────────────────────────
// Plan 节点类型
// ──────────────────────────────────────────
var PlanNodeType;
(function (PlanNodeType) {
    PlanNodeType["SCAN"] = "scan";
    PlanNodeType["FILTER"] = "filter";
    PlanNodeType["NEIGHBORS"] = "neighbors";
    PlanNodeType["INDEX_LOOKUP"] = "index_lookup";
    PlanNodeType["LIMIT"] = "limit";
    PlanNodeType["SORT"] = "sort";
    PlanNodeType["PROJECT"] = "project";
    PlanNodeType["VECTOR_SEARCH"] = "vector_search";
    PlanNodeType["JOIN"] = "join";
    PlanNodeType["AGGREGATE"] = "aggregate";
    PlanNodeType["SHORTEST_PATH"] = "shortest_path";
    PlanNodeType["PERSONALIZED_PAGE_RANK"] = "personalized_page_rank";
    PlanNodeType["CONNECTED_COMPONENTS"] = "connected_components";
    PlanNodeType["PARALLEL_UNION"] = "parallel_union";
})(PlanNodeType || (exports.PlanNodeType = PlanNodeType = {}));
// ──────────────────────────────────────────
// 查询计划器
// ──────────────────────────────────────────
class QueryPlanner {
    shardManager;
    stats = new Map();
    constructor(shardManager) {
        this.shardManager = shardManager;
    }
    // ──────────────────────────────────────────
    // 计划构建
    // ──────────────────────────────────────────
    /**
     * 构建查询计划
     */
    plan(query) {
        const root = this.buildPlanTree(query);
        this.assignCosts(root);
        return root;
    }
    /**
     * 输出 EXPLAIN 形式的计划描述
     */
    explain(query) {
        const planNode = this.plan(query);
        return this.formatExplain(planNode, 0);
    }
    // ──────────────────────────────────────────
    // 选择性估算
    // ──────────────────────────────────────────
    /**
     * 估算谓词选择性
     */
    estimateSelectivity(columnStats, op, value) {
        if (!columnStats || columnStats.distinctCount === 0)
            return 0.5; // unknown
        switch (op) {
            case 'eq':
                return this.estimateEqualitySelectivity(columnStats);
            case 'gt':
            case 'lt':
            case 'gte':
            case 'lte':
                return this.estimateRangeSelectivity(columnStats);
            case 'prefix':
                return this.estimatePrefixSelectivity(columnStats);
            case 'in':
                if (Array.isArray(value) && value.length > 0) {
                    return Math.min(1, (value.length * this.estimateEqualitySelectivity(columnStats)));
                }
                return 0.5;
            case 'neq':
                return 1 - this.estimateEqualitySelectivity(columnStats);
            default:
                return 0.5;
        }
    }
    // ──────────────────────────────────────────
    // 优化
    // ──────────────────────────────────────────
    /**
     * 优化计划树——下推过滤条件
     */
    pushDownFilter(plan) {
        if (plan.type === PlanNodeType.FILTER && plan.children.length === 1) {
            const child = plan.children[0];
            if (child.type === PlanNodeType.SCAN || child.type === PlanNodeType.NEIGHBORS) {
                // 将 filter 合并到子节点
                child.details['pushedFilters'] = plan.details['predicates'];
                return child;
            }
        }
        plan.children = plan.children.map(c => this.pushDownFilter(c));
        return plan;
    }
    /**
     * 选择最佳索引
     */
    chooseIndex(predicates, availableIndexes) {
        if (predicates.length === 0)
            return null;
        // 优先选择匹配最多的索引
        let bestIndex = null;
        let bestScore = -1;
        for (const idx of availableIndexes) {
            let score = 0;
            for (const pred of predicates) {
                if (pred.field === idx) {
                    score += pred.op === 'eq' ? 3 : pred.op === 'prefix' ? 2 : 1;
                }
            }
            if (score > bestScore) {
                bestScore = score;
                bestIndex = idx;
            }
        }
        return bestIndex;
    }
    /**
     * 完整优化——应用所有规则
     */
    optimize(query) {
        let plan = this.plan(query);
        plan = this.pushDownFilter(plan);
        if (query.predicates && query.predicates.length > 0) {
            const availableIndexes = ['id', 'name', 'type', 'createdAt'];
            const chosen = this.chooseIndex(query.predicates, availableIndexes);
            if (chosen) {
                plan.details['chosenIndex'] = chosen;
            }
        }
        return plan;
    }
    // ──────────────────────────────────────────
    // 统计收集
    // ──────────────────────────────────────────
    /**
     * 收集统计信息
     */
    async collectStats() {
        const status = this.shardManager.getShardStatus();
        let totalNodes = 0;
        for (const s of status) {
            totalNodes += s.nodeCount;
        }
        const colStats = new Map();
        colStats.set('id', { columnName: 'id', distinctCount: totalNodes, nullCount: 0, minValue: 1, maxValue: totalNodes });
        colStats.set('type', { columnName: 'type', distinctCount: Math.min(10, totalNodes), nullCount: 0 });
        colStats.set('name', { columnName: 'name', distinctCount: totalNodes, nullCount: 0 });
        this.stats.set('nodes', {
            rowCount: totalNodes,
            columnStats: colStats,
        });
    }
    getStats() {
        return this.stats;
    }
    // ──────────────────────────────────────────
    // 内部方法
    // ──────────────────────────────────────────
    buildPlanTree(query) {
        let child = null;
        // 扫描阶段
        if (query.useIndex) {
            child = {
                type: PlanNodeType.INDEX_LOOKUP,
                estimatedCost: 10,
                estimatedRows: 100,
                children: [],
                details: { indexName: query.useIndex, typeId: query.typeId },
            };
        }
        else {
            child = {
                type: PlanNodeType.SCAN,
                estimatedCost: 100,
                estimatedRows: 1000,
                children: [],
                details: { typeId: query.typeId },
            };
        }
        // 过滤阶段
        if (query.predicates && query.predicates.length > 0) {
            child = {
                type: PlanNodeType.FILTER,
                estimatedCost: 50,
                estimatedRows: child.estimatedRows * 0.5,
                children: [child],
                details: { predicates: query.predicates },
            };
        }
        // 邻居遍历阶段
        if (query.neighbors) {
            child = {
                type: PlanNodeType.NEIGHBORS,
                estimatedCost: 200,
                estimatedRows: child.estimatedRows * 3,
                children: [child],
                details: { depth: query.neighbors.depth, edgeFilter: query.neighbors.edgeFilter },
            };
        }
        // 排序阶段
        if (query.orderBy) {
            child = {
                type: PlanNodeType.SORT,
                estimatedCost: 30,
                estimatedRows: child.estimatedRows,
                children: [child],
                details: { field: query.orderBy.field, dir: query.orderBy.dir },
            };
        }
        // 限制阶段
        if (query.limit) {
            child = {
                type: PlanNodeType.LIMIT,
                estimatedCost: 5,
                estimatedRows: Math.min(child.estimatedRows, query.limit),
                children: [child],
                details: { limit: query.limit },
            };
        }
        // 投影阶段
        if (query.project && query.project.length > 0) {
            child = {
                type: PlanNodeType.PROJECT,
                estimatedCost: 5,
                estimatedRows: child.estimatedRows,
                children: [child],
                details: { fields: query.project },
            };
        }
        return child;
    }
    assignCosts(node) {
        for (const child of node.children) {
            this.assignCosts(child);
        }
        node.estimatedCost = this.calculateNodeCost(node);
    }
    calculateNodeCost(node) {
        const childCost = node.children.reduce((sum, c) => sum + c.estimatedCost, 0);
        switch (node.type) {
            case PlanNodeType.SCAN:
                return 100 + childCost;
            case PlanNodeType.INDEX_LOOKUP:
                return 10 + childCost;
            case PlanNodeType.FILTER:
                return 5 + childCost;
            case PlanNodeType.NEIGHBORS:
                return 200 + childCost;
            case PlanNodeType.SORT:
                return 30 + childCost;
            case PlanNodeType.LIMIT:
                return 1 + childCost;
            case PlanNodeType.PROJECT:
                return 2 + childCost;
            default:
                return 10 + childCost;
        }
    }
    formatExplain(node, depth) {
        const indent = '  '.repeat(depth);
        const rows = node.estimatedRows;
        const cost = node.estimatedCost;
        let details = '';
        for (const [key, val] of Object.entries(node.details)) {
            details += ` ${key}=${JSON.stringify(val)}`;
        }
        let result = `${indent}-> ${node.type.toUpperCase()} (rows=${rows}, cost=${cost}${details})\n`;
        for (const child of node.children) {
            result += this.formatExplain(child, depth + 1);
        }
        return result;
    }
    estimateEqualitySelectivity(colStats) {
        return 1 / Math.max(colStats.distinctCount, 1);
    }
    estimateRangeSelectivity(colStats) {
        return 0.33; // 默认假设 1/3 的数据在范围内
    }
    estimatePrefixSelectivity(colStats) {
        const ndv = Math.max(colStats.distinctCount, 1);
        // 前缀匹配假设匹配 1/sqrt(ndv) 的数据
        return Math.min(1, 1 / Math.sqrt(ndv));
    }
}
exports.QueryPlanner = QueryPlanner;
/**
 * Flatten a PlanNode tree into an array of nodes in execution order (leaf-first).
 * Used for pushdown analysis like limit-pushdown: we walk bottom-up to find
 * the best SCAN to absorb a LIMIT.
 */
function flattenPlanLeafFirst(plan) {
    const result = [];
    function walk(node) {
        for (const child of node.children) {
            walk(child);
        }
        result.push(node);
    }
    walk(plan);
    return result;
}
/**
 * buildIRFromSpec — 将 Fluent API 的 QuerySpec 转换为 Planner 可优化的计划树
 *
 * 转换规则：
 * - match → SCAN（带 typeId）
 * - where → FILTER（带 predicates，或转换为 Record 过滤）
 * - neighbors → NEIGHBORS
 * - orderBy → SORT
 * - limit / skip → LIMIT（skip 合并到 limit 节点中）
 * - return → PROJECT（字段投影）
 * - vectorSearch → VECTOR_SEARCH
 */
function buildIRFromSpec(spec) {
    let child = null;
    // 1. 扫描阶段
    if (spec.vectorSearch) {
        child = {
            type: PlanNodeType.VECTOR_SEARCH,
            estimatedCost: 200,
            estimatedRows: spec.vectorSearch.topK,
            children: [],
            details: { vector: spec.vectorSearch.vector, topK: spec.vectorSearch.topK },
        };
    }
    else {
        child = {
            type: PlanNodeType.SCAN,
            estimatedCost: 100,
            estimatedRows: 1000,
            children: [],
            details: { typeId: spec.match?.typeId ?? null, name: spec.match?.name ?? null },
        };
    }
    // 2. 邻居遍历阶段（在过滤之前，因为 neighbors 在 Fluent 中通常比 where 更早链式调用）
    if (spec.neighbors) {
        child = {
            type: PlanNodeType.NEIGHBORS,
            estimatedCost: 200,
            estimatedRows: child.estimatedRows * 3,
            children: [child],
            details: {
                id: spec.neighbors.id,
                edgeType: spec.neighbors.edgeType ?? null,
                maxDepth: spec.neighbors.maxDepth ?? 1,
            },
        };
    }
    // 3. 过滤阶段
    const predicates = [];
    if (spec.where && Object.keys(spec.where).length > 0) {
        for (const [field, value] of Object.entries(spec.where)) {
            predicates.push({ field, op: 'eq', value });
        }
    }
    if (predicates.length > 0) {
        child = {
            type: PlanNodeType.FILTER,
            estimatedCost: 50,
            estimatedRows: child ? child.estimatedRows * 0.5 : 500,
            children: child ? [child] : [],
            details: { predicates },
        };
    }
    else if (spec.predicates && spec.predicates.length > 0) {
        // 函数式 predicates（来自 Fluent 的 where(predicateFn)）
        child = {
            type: PlanNodeType.FILTER,
            estimatedCost: 50,
            estimatedRows: child ? child.estimatedRows * 0.5 : 500,
            children: child ? [child] : [],
            details: { functionPredicates: true, predicateCount: spec.predicates.length },
        };
    }
    // 4. 排序阶段
    if (spec.orderBy) {
        child = {
            type: PlanNodeType.SORT,
            estimatedCost: 30,
            estimatedRows: child.estimatedRows,
            children: [child],
            details: { field: spec.orderBy.field, dir: spec.orderBy.direction },
        };
    }
    // 5. 限制阶段（含 skip）
    if (spec.limit !== undefined || spec.skip !== undefined && spec.skip > 0) {
        child = {
            type: PlanNodeType.LIMIT,
            estimatedCost: 5,
            estimatedRows: Math.min(child.estimatedRows, spec.limit ?? 1000),
            children: [child],
            details: { limit: spec.limit ?? 1000, skip: spec.skip ?? 0 },
        };
    }
    // 6. 投影阶段
    if (spec.return && spec.return.length > 0) {
        child = {
            type: PlanNodeType.PROJECT,
            estimatedCost: 5,
            estimatedRows: child.estimatedRows,
            children: [child],
            details: { fields: spec.return },
        };
    }
    return child;
}
/**
 * limitPushdown — 如果 LIMIT 节点的下级是 SCAN 或 NEIGHBORS，
 * 将 limit 值推入 SCAN/NEIGHBORS 的 details 中。
 * 对 LIMIT → SORT → SCAN 链同样有效：会将 limit 下推到 SCAN。
 */
function limitPushdown(plan) {
    if (plan.type === PlanNodeType.LIMIT && plan.children.length === 1) {
        const limitValue = plan.details['limit'];
        if (limitValue === undefined)
            return plan;
        // Walk down through SORT, FILTER to find SCAN/NEIGHBORS
        const walkDown = (node) => {
            if (node.type === PlanNodeType.SCAN || node.type === PlanNodeType.NEIGHBORS) {
                node.details['pushedLimit'] = limitValue;
                return true;
            }
            // Recurse through single-child intermediate nodes
            if (node.children.length === 1) {
                return walkDown(node.children[0]);
            }
            return false;
        };
        walkDown(plan.children[0]);
    }
    // Recurse on children
    plan.children = plan.children.map(c => limitPushdown(c));
    return plan;
}
/**
 * optimizeIR — 应用已知的优化规则
 *
 * 优化流程：
 * 1. pushDownFilter — 将 FILTER 推入 SCAN/NEIGHBORS
 * 2. limitPushdown — 将 LIMIT 推入 SCAN/NEIGHBORS 作为早期截断
 * 3. predicatePushdown — 将 WHERE 条件压入扫描层
 * 4. eliminateDeadBranches — 消除不可能产生结果的节点
 */
function optimizeIR(plan) {
    let optimized = plan;
    // 1. Predicate pushdown — 将 predicates 转换为 filter-details 形式
    // 如果 FILTER 节点有 function predicates（来自 Fluent where），无法静态优化，跳过
    // 2. 过滤下推
    if (optimized.type === PlanNodeType.FILTER && optimized.children.length === 1) {
        const child = optimized.children[0];
        // 函数式 predicates（来自 Fluent where 的回调）无法下推到 SCAN，
        // 因为它们需要在运行时调用闭包，而不是静态比较字段值
        const hasFunctionPreds = optimized.details['functionPredicates'] === true;
        if (!hasFunctionPreds && (child.type === PlanNodeType.SCAN || child.type === PlanNodeType.NEIGHBORS)) {
            child.details['pushedFilters'] = optimized.details['predicates'];
            optimized = child;
        }
    }
    // 3. Limit 下推
    optimized = limitPushdown(optimized);
    // 4. 递归优化子节点
    optimized.children = optimized.children.map(c => optimizeIR(c));
    // 5. 消除死分支 — 如果某个节点 estimatedRows = 0，可以移除
    optimized = eliminateDeadBranches(optimized);
    return optimized;
}
/**
 * eliminateDeadBranches — 消除 estimatedRows 为 0 的节点及其子树
 */
function eliminateDeadBranches(plan) {
    // Filter children first
    plan.children = plan.children.filter(c => c.estimatedRows > 0);
    plan.children = plan.children.map(c => eliminateDeadBranches(c));
    return plan;
}
/**
 * executeIR — 执行优化后的计划树
 *
 * 按照计划树从叶子到根的顺序执行各个节点。
 * 通过 ShardManager 与图存储交互。
 *
 * 支持的节点类型：
 * - SCAN: 按 typeId 扫描节点
 * - NEIGHBORS: 获取邻居节点
 * - FILTER: 对已加载的结果应用谓词过滤
 * - SORT: 按字段排序
 * - LIMIT: 截断结果（含 skip）
 * - PROJECT: 字段投影
 * - VECTOR_SEARCH: 向量相似度搜索
 */
async function executeIR(plan, shardManager, fnPredicates) {
    // 递归执行 — 先收集子节点的数据
    let data = await executeChildren(plan, shardManager, fnPredicates);
    // 执行当前节点
    data = await executeNode(plan, data, shardManager, fnPredicates);
    return data;
}
/**
 * executeChildren — 递归执行子节点，收集结果
 */
async function executeChildren(plan, shardManager, fnPredicates) {
    // 如果有下属节点，递归执行
    if (plan.children.length > 0) {
        // 对于多子节点场景（如 JOIN），后续可扩展
        return executeIR(plan.children[0], shardManager, fnPredicates);
    }
    return [];
}
/**
 * executeNode — 执行单个计划节点
 */
async function executeNode(plan, inputData, shardManager, fnPredicates) {
    const { details } = plan;
    switch (plan.type) {
        case PlanNodeType.SCAN: {
            const typeId = details['typeId'];
            const pushedFilters = details['pushedFilters'];
            const pushedLimit = details['pushedLimit'];
            // 扫描所有节点
            let nodes = await scanAllNodes(shardManager);
            // 按 typeId 过滤
            if (typeId !== null && typeId !== undefined) {
                nodes = nodes.filter(n => n.type === typeId);
            }
            // 应用下推的过滤条件（等价 predicates）
            if (pushedFilters && pushedFilters.length > 0) {
                for (const filter of pushedFilters) {
                    nodes = nodes.filter(n => {
                        const val = resolveNodeField(n, filter.field);
                        return applyPredicate(val, filter.op, filter.value);
                    });
                }
            }
            // 应用下推的 limit（早期截断）
            if (pushedLimit !== undefined && pushedLimit > 0) {
                nodes = nodes.slice(0, pushedLimit);
            }
            return nodes;
        }
        case PlanNodeType.NEIGHBORS: {
            const maxDepth = details['maxDepth'] ?? 1;
            const edgeType = details['edgeType'];
            const pushedFilters = details['pushedFilters'];
            const pushedLimit = details['pushedLimit'];
            const result = [];
            const seen = new Set();
            for (const node of inputData) {
                await collectNeighborsIR(node.id, maxDepth, seen, result, shardManager, edgeType ?? undefined);
            }
            // 应用下推的过滤
            if (pushedFilters && pushedFilters.length > 0) {
                let filtered = [...result];
                for (const filter of pushedFilters) {
                    filtered = filtered.filter(n => {
                        const val = resolveNodeField(n, filter.field);
                        return applyPredicate(val, filter.op, filter.value);
                    });
                }
                return filtered;
            }
            // 下推的 limit
            if (pushedLimit !== undefined && pushedLimit > 0) {
                return result.slice(0, pushedLimit);
            }
            return result;
        }
        case PlanNodeType.FILTER: {
            const predicates = details['predicates'];
            const hasFunctionPredicates = details['functionPredicates'] === true;
            let result = [...inputData];
            if (predicates && predicates.length > 0) {
                for (const pred of predicates) {
                    result = result.filter(n => {
                        const val = resolveNodeField(n, pred.field);
                        return applyPredicate(val, pred.op, pred.value);
                    });
                }
            }
            // 函数式 predicates（来自 Fluent where 回调）
            if (hasFunctionPredicates && fnPredicates && fnPredicates.length > 0) {
                for (const fn of fnPredicates) {
                    result = result.filter(fn);
                }
            }
            return result;
        }
        case PlanNodeType.PROJECT: {
            const fields = details['fields'];
            if (!fields || fields.length === 0)
                return inputData;
            return inputData.map(node => {
                const projected = { id: node.id };
                for (const field of fields) {
                    const val = resolveNodeField(node, field);
                    if (val !== undefined) {
                        projected[field] = val;
                    }
                }
                // Preserve type and props to satisfy NodeRecord interface
                projected['type'] = node.type;
                projected['name'] = node.name ?? '';
                projected['props'] = {};
                return projected;
            });
        }
        case PlanNodeType.SORT: {
            const field = details['field'];
            const dir = details['dir'];
            return [...inputData].sort((a, b) => {
                const valA = resolveNodeField(a, field);
                const valB = resolveNodeField(b, field);
                if (valA == null && valB == null)
                    return 0;
                if (valA == null)
                    return 1;
                if (valB == null)
                    return -1;
                if (typeof valA === 'string' && typeof valB === 'string') {
                    return dir === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
                }
                return dir === 'asc'
                    ? Number(valA) - Number(valB)
                    : Number(valB) - Number(valA);
            });
        }
        case PlanNodeType.LIMIT: {
            const limit = details['limit'];
            const skip = details['skip'];
            let result = [...inputData];
            if (skip && skip > 0) {
                result = result.slice(skip);
            }
            if (limit !== undefined) {
                // 如果已经有 pushedLimit，避免二次截断（pushedLimit 已经在 SCAN 层截断）
                result = result.slice(0, limit);
            }
            return result;
        }
        case PlanNodeType.VECTOR_SEARCH: {
            const vector = details['vector'];
            const topK = details['topK'];
            const results = await shardManager.vectorSearch({
                denseQuery: vector,
                k: topK,
            });
            return results.map(r => r.node);
        }
        case PlanNodeType.INDEX_LOOKUP:
            // 委托给 scan，实际生产环境应使用索引
            return inputData;
        case PlanNodeType.JOIN:
        case PlanNodeType.AGGREGATE:
        case PlanNodeType.SHORTEST_PATH:
        case PlanNodeType.PERSONALIZED_PAGE_RANK:
        case PlanNodeType.CONNECTED_COMPONENTS:
        case PlanNodeType.PARALLEL_UNION:
        default:
            // 暂未实现的节点类型，返回输入数据
            return inputData;
    }
}
// ──────────────────────────────────────────
// QueryIR 辅助函数
// ──────────────────────────────────────────
/**
 * scanAllNodes — 通过 ShardManager 获取所有节点
 */
async function scanAllNodes(shardManager) {
    // 利用 getShardStatus 获取分片列表
    // 实际项目应使用专门的 getNodesByType API
    const status = shardManager.getShardStatus();
    // 通过 getAllRanges （如果存在）获取节点数据
    const mgr = shardManager;
    if (typeof mgr.getAllNodes === 'function') {
        return mgr.getAllNodes();
    }
    return [];
}
/**
 * collectNeighborsIR — 递归收集邻居节点（IR 版本）
 */
async function collectNeighborsIR(nodeId, remainingDepth, seen, result, shardManager, edgeType) {
    if (remainingDepth <= 0)
        return;
    if (seen.has(nodeId))
        return;
    seen.add(nodeId);
    const { nodes } = await shardManager.neighbors(nodeId, {
        maxDepth: 1,
        edgeTypeFilter: edgeType !== undefined ? [edgeType] : undefined,
    });
    for (const n of nodes) {
        if (!seen.has(n.id)) {
            result.push(n);
            await collectNeighborsIR(n.id, remainingDepth - 1, seen, result, shardManager, edgeType);
        }
    }
}
/**
 * resolveNodeField — 从 NodeRecord 中解析字段值
 */
function resolveNodeField(node, field) {
    const key = field;
    if (key in node) {
        return node[key];
    }
    return node.props?.[field];
}
/**
 * applyPredicate — 应用过滤条件
 */
function applyPredicate(value, op, target) {
    switch (op) {
        case 'eq':
            return value === target;
        case 'neq':
            return value !== target;
        case 'gt':
            return typeof value === 'number' && typeof target === 'number' && value > target;
        case 'gte':
            return typeof value === 'number' && typeof target === 'number' && value >= target;
        case 'lt':
            return typeof value === 'number' && typeof target === 'number' && value < target;
        case 'lte':
            return typeof value === 'number' && typeof target === 'number' && value <= target;
        case 'prefix':
            return typeof value === 'string' && typeof target === 'string' && value.startsWith(target);
        case 'in':
            return Array.isArray(target) && target.includes(value);
        default:
            return true;
    }
}
/**
 * formatPlanExplain — 将 PlanNode 树格式化为可读的 EXPLAIN 字符串
 * 供 Fluent API 的 plan() 方法使用
 */
function formatPlanExplain(node, depth = 0) {
    const indent = '  '.repeat(depth);
    const rows = node.estimatedRows;
    const cost = node.estimatedCost;
    let details = '';
    for (const [key, val] of Object.entries(node.details)) {
        // 跳过大型数据结构
        if (key === 'vector')
            continue;
        if (Array.isArray(val) && val.length > 10) {
            details += ` ${key}=[${val.length} items]`;
        }
        else {
            details += ` ${key}=${JSON.stringify(val)}`;
        }
    }
    let result = `${indent}-> ${node.type.toUpperCase()} (rows=${rows}, cost=${cost}${details})\n`;
    for (const child of node.children) {
        result += formatPlanExplain(child, depth + 1);
    }
    return result;
}
//# sourceMappingURL=query-planner.js.map