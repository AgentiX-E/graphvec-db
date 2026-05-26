# AgentiX GraphVec — 查询层 + API 深度研究报告

**日期**: 2026-05-26
**研究员**: Subagent research-query-api
**研究代码基**: `/home/admin/openclaw/workspace/agentiX-graphvec/`

---

## 目录

1. [项 1: 查询聚合函数 (Q01)](#项-1-查询聚合函数-q01)
2. [项 2: UNION/集合运算 (Q02)](#项-2-union集合运算-q02)
3. [项 3: 优化器驱动执行器 (Q03)](#项-3-优化器驱动执行器-q03)
4. [项 4: REST API 补齐 (Q04)](#项-4-rest-api-补齐-q04)

---

## 项 1: 查询聚合函数 (Q01)

### 1.1 当前 QueryPlan 类型定义位置

**文件**: `src/query/query-engine.ts`

| 类型/接口 | 行号 | 说明 |
|---|---|---|
| `QueryPlan` | 第104-119行 | 包含 scanLabel, steps, filters, returnColumns, orderBy, limit, skip |
| `FilterClause` | 第126-133行 | 过滤条件类型 (source, property, operator, value) |
| `ReturnClauseAST` | 第81-84行 | RETURN 子句 AST（column 数组） |
| `ColumnAST` | 第86-90行 | 单列定义（expression + alias） |
| `PrimaryAST` | 第65-78行 | 基础表达式类型（PROP_REF, STRING, NUMBER, BOOLEAN, IDENTIFIER） |

### 1.2 执行流程

`parseQuery()`（第143行）的完整调用链：

```
parseQuery(queryString)   →   parser.parse(query)     → QueryAST
   ↓
planFromAST(ast)          → 构建 QueryPlan
   ↓
（在 GraphEngine.query() 中调用，src/core/graph-engine.ts 第664-670行）
_executeQueryPlan(plan)   → 见第683-740行：
   Step 1: _scanAll() / _scanNodesByLabel() — 扫描起始节点
   Step 2: 遍历 steps（多跳展开，当前仅支持单跳）
   Step 3: 应用 WHERE 过滤器 (_matchFilter, 第747-757行)
   Step 4: SKIP / LIMIT
   Step 5: 返回 NodeRecord[]
```

### 1.3 现存聚合能力（底层已有）

`GraphEngine` 已实现基本聚合方法（`src/core/graph-engine.ts` 第880-937行）：

| 方法 | 行号 | 功能 |
|---|---|---|
| `countNodes(typeFilter?)` | 第880行 | 按 typeId 过滤计数 |
| `sumNodeProperty(field, typeFilter?)` | 第902行 | 属性值求和 |
| `avgNodeProperty(field, typeFilter?)` | 第923行 | 属性值求平均值 |

**但在 `query-engine.ts` 的 QueryPlan 和 _executeQueryPlan 中完全没有接入这些方法。**

此外，`PlanNodeType` 枚举中已有 `AGGREGATE = 'aggregate'`（`src/api/query-planner.ts` 第23行），但 `executeIR()` 中对 `PlanNodeType.AGGREGATE` 的处理仅为 `return inputData`（第837行），是空实现。

`GraphQuery` 类已在 `fluent.ts` 实现了一个 `count()` 方法（第143行），但实现方式是全量加载后取 `.length`，没有下沉到存储层。

### 1.4 缺失功能

- **max/min**: 不存在于 GraphEngine 层，也不存在于 query-engine 的 AST 解析中
- **Cypher-lite 不支持聚合 RETURN**: 不支持 `RETURN count(n)`, `RETURN sum(n.age)`, `RETURN avg(n.age)`
- **GROUP BY**: 完全不支持
- **Fluent API 缺少聚合语义**: 没有 `sum()`, `avg()`, `max()`, `min()` 方法

### 1.5 实现方案

#### 方案 A: npm 包方案 ⭐ 推荐

**datasift / data-forge / arquero** 这类 npm 包可以用于在内存中对 NodeRecord[] 做聚合运算。

| 包名 | 优势 | 劣势 |
|---|---|---|
| **arquero** (uwdata) | 每紧缩, Tree-shakeable, 支持 groupby + 5种聚合函数, 无外部HTTP依赖 | 0依赖需要额外包大小~50KB |
| **data-forge** | 类 pandas API, 熟悉 | 依赖较多 |
| **lodash** (_.groupBy + _.mean) | 已广泛存在 | 不是查询引擎级的聚合 |

**推荐: 直接实现轻量聚合函数（自研）**，不使用额外 npm 包。原因：
- 聚合逻辑简单（sum/avg/count/max/min 都是 O(n) 遍历）
- 项目本身已经实现了 GraphEngine 层的 countNodes/sumNodeProperty/avgNodeProperty
- 引入包会增加构建体积和依赖维护成本

#### 实施步骤

**Step 1**: 在 `query-engine.ts` 中扩展 QueryPlan 和 AST（约60行代码）

```typescript
// 新增接口（query-engine.ts）
export interface AggregateClause {
  type: 'COUNT' | 'SUM' | 'AVG' | 'MAX' | 'MIN'
  field?: string          // sum/avg/max/min 需要的属性字段
  alias?: string           // 返回列的别名（默认 func_field）
  distinct?: boolean      // 是否去重
}

// 扩展 QueryPlan
export interface QueryPlan {
  // ... 现有字段不变
  aggregate?: AggregateClause
}

// 扩展 ReturnClauseAST
// 允许: RETURN count(n), RETURN sum(n.age), RETURN avg(n.age), RETURN n.name
export interface AggregateColumnAST {
  type: 'AGGREGATE_COLUMN'
  func: 'count' | 'sum' | 'avg' | 'max' | 'min'
  expression: PrimaryAST  // 如 n.age
  alias: string | null
}

// 修改 planFromAST() 解析 RETURN 中的聚合函数
// 如果 return.columns[0] 是 AggregateColumnAST，则设置 plan.aggregate
```

**Step 2**: 修改 `_executeQueryPlan()` 在 Step 4 (LIMIT/SKIP) 之后、Step 5 之前插入聚合步骤

```typescript
// graph-engine.ts, _executeQueryPlan 中
// Step 5: 聚合（在 SKIP/LIMIT 之后）
if (plan.aggregate) {
  return applyAggregate(results, plan.aggregate, ...);
}
```

**Step 3**: 为 Fluent API 添加聚合方法（`src/api/fluent.ts`）

```typescript
class GraphQuery {
  private aggregate_: { type: string; field?: string } | null = null

  count(): Promise<number> { ... }  // 已存在（第143行）
  sum(field: string): GraphQuery { this.aggregate_ = { type: 'SUM', field }; return this }
  avg(field: string): GraphQuery { this.aggregate_ = { type: 'AVG', field }; return this }
  max(field: string): GraphQuery { this.aggregate_ = { type: 'MAX', field }; return this }
  min(field: string): GraphQuery { this.aggregate_ = { type: 'MIN', field }; return this }
}
```

**Step 4**: 接入 GraphEngine 现有的 countNodes/sumNodeProperty/avgNodeProperty 方法

```typescript
// execute() 中，当 aggregate_ 不为 null 时
if (this.aggregate_) {
  switch (this.aggregate_.type) {
    case 'COUNT': return this.manager.countNodes(); // 或从 shard 层 merge
    case 'SUM': return this.manager.sumNodeProperty(this.aggregate_.field);
    // ...
  }
}
```

### 1.6 自研 vs npm 包对比

| 维度 | 自研（推荐） | npm 包 (arquero) |
|---|---|---|
| 代码量 | ~80行（含测试） | 引入 ~50KB |
| 性能 | O(n), 内存级 | O(n), 类似 |
| 与存储层集成 | 可直接调用 GraphEngine 聚合 API | 需要中转数据后再聚合 |
| 维护成本 | 低（逻辑极其简单） | 第三方升级风险 |

**结论**: 自研更优。聚合函数是经典 O(n) 算法，实现成本极低，且能直接集成 GraphEngine 存储层聚合。不建议引入外部 npm 包。

---

## 项 2: UNION/集合运算 (Q02)

### 2.1 当前状态

**Fluent API 已有集合运算实现**（`src/api/fluent.ts`）：

| 类 | 行号 | 功能 |
|---|---|---|
| `UnionQuery` | 第360-413行 | 并集：并行执行多个查询后去重合并 |
| `IntersectQuery` | 第416-468行 | 交集：并行执行后取 node.id 交集 |
| `SubtractQuery` | 第471-511行 | 差集：A - B |

**静态工厂函数**（第514-521行）：

```typescript
export function union(...queries: GraphQuery[]): UnionQuery
export function intersect(...queries: GraphQuery[]): IntersectQuery
export function subtract(a: GraphQuery, b: GraphQuery): SubtractQuery
```

**QueryIR 层面** (`src/api/query-planner.ts`)：

| PlanNodeType | 行号 | 空实现 |
|---|---|---|
| `UNION` | 第55行（枚举值） | `executeIR` 第802-814行：已实现合并去重 |
| `INTERSECT` | 第56行 | `executeIR` 第817-823行：已实现交集 |
| `SUBTRACT` | 第57行 | `executeIR` 第826-834行：已实现差集 |

### 2.2 缺口

- **Cypher-lite 不支持 UNION**: `src/query/query-engine.ts` 的 AST 不支持 `MATCH (a) RETURN a UNION MATCH (b) RETURN b`
- **GraphEngine.query() 不支持集合运算**: `src/core/graph-engine.ts` 第664行 `query()` 方法只执行 `_executeQueryPlan()`，不提供 UNION 包装
- **Rest API 没有集合运算端点**: 无 `/api/graph/union` 等

### 2.3 实现方案

#### Step 1: Cypher-lite AST 扩展（query-engine.ts，约40行）

```typescript
// 扩展 QueryAST
export interface QueryAST {
  type: 'QUERY' | 'UNION' | 'INTERSECT' | 'SUBTRACT'
  // ...
  union?: {
    op: 'UNION' | 'INTERSECT' | 'SUBTRACT'
    all?: boolean       // UNION ALL
    subqueries: QueryAST[]
  }
}

// 在 parseQuery() 中检测 UNION/INTERSECT/SUBTRACT 关键字
// 如果检测到，递归解析子查询并设置 union 字段
```

#### Step 2: GraphEngine 层添加 union 方法（graph-engine.ts）

```typescript
queryUnion(queryStrings: string[]): NodeRecord[] {
  const plans = queryStrings.map(qs => parseQuery(qs))
  // 如何执行多计划并合并？_executeQueryPlan 是私有方法
  // 方案：公开 _executeQueryPlan 或将集合运算移到外部
  const all = plans.map(p => this._executeQueryPlan(p))
  // 去重
  const seen = new Set<number>()
  return all.flat().filter(n => {
    if (seen.has(n.id)) return false
    seen.add(n.id)
    return true
  })
}
```

#### Step 3: 集合运算可以复用现有 Fluent API

用户可直接使用：

```typescript
const q1 = new GraphQuery(manager).match(1).where(n => n.name.startsWith('A'))
const q2 = new GraphQuery(manager).match(2).where(n => n.name.startsWith('B'))
const result = await union(q1, q2).limit(10).return()
```

Cypher-lite 的 UNION 解析只是在 query-engine 层加一层语法糖。

### 2.4 结论

**不需要 npm 包**。Fluent API 的 UnionQuery/IntersectQuery/SubtractQuery 已经实现了完整的集合运算，QueryIR 层的 UNION/INTERSECT/SUBTRACT PlanNode 类型也已有 executeIR 实现。缺口仅在于：

1. Cypher-lite 解析器不支持 `UNION` 关键字
2. `GraphEngine` 没有暴露集合运算方法
3. `query-planner.ts` 中 `buildIRFromSpec` 只处理单查询，不产生多子树的 UNION 计划

---

## 项 3: 优化器驱动执行器 (Q03)

### 3.1 关键发现

**`GraphEngine.query()` 完全不使用 `query-planner.ts`。**

调用链：
```
GraphEngine.query(queryString)       (graph-engine.ts:664)
  → parseQuery(queryString)          (query-engine.ts → 纯解析，无优化)
  → _executeQueryPlan(plan)          (graph-engine.ts:683 → 直接执行，没有经过 optimizer)
```

**`query-planner.ts` 的两个调用者**：
1. `GraphQuery.plan()`（fluent.ts 第162行）— 仅在调试时输出 EXPLAIN 计划，不执行
2. `GraphQuery.execute()`（fluent.ts 第241行）— **仅当 `useOptimizer_ = true` 时**才走 QueryIR

查看 `src/api/fluent.ts` 第241-245行：
```typescript
if (this.useOptimizer_) {
  const spec = this.buildQuerySpec()
  const plan = buildIRFromSpec(spec)
  const optimized = optimizeIR(plan)
  const fnPreds = this.predicates.length > 0 ? [...this.predicates] : undefined
  return executeIR(optimized, this.manager, fnPreds)
}
```

但 `useOptimizer_` 默认为 false（第32行），需要通过 `.enableOptimizer(true)` 手动开启。

### 3.2 缺口位置

| 位置 | 行号 | 问题 |
|---|---|---|
| `GraphQuery.useOptimizer_` | fluent.ts:32 | 默认 false |
| `GraphQuery.execute()` | fluent.ts:241 | 仅当 useOptimizer_=true 时走 IR |
| `GraphEngine.query()` | graph-engine.ts:664 | 完全不使用 query-planner |
| `_executeQueryPlan()` | graph-engine.ts:683 | 纯顺序执行，无优化 |
| `QueryPlanner.optimize()` | query-planner.ts 第181-201行 | 返回 PlanNode 但从未被 `_executeQueryPlan` 消费 |
| `executeIR()` | query-planner.ts 第646行 | 需要 `ShardManager` 参数，但 GraphEngine 不使用 ShardManager |

### 3.3 原因分析

`executeIR()`（query-planner.ts 第646行）需要 `ShardManager` 作为执行器，而 `GraphEngine._executeQueryPlan()` 直接操作内部 `StorageProvider`。这两个执行路径是两套独立的引擎：

- **路径 A**（GraphEngine.query）: 使用 `StorageProvider` 直接读取存储（同步 API）
- **路径 B**（GraphQuery + QueryIR）: 使用 `ShardManager` 跨 Range fan-out（异步 API）

这两条路径不能简单桥接，因为 `GraphEngine` 内部不使用 `ShardManager`。

### 3.4 打通方案

#### 方案: 将 `_executeQueryPlan` 重构为接受 `QueryPlanner` 参数（推荐）

```typescript
// graph-engine.ts

// 1. 在 GraphEngine 构造函数中接收可选的 planner
private planner: QueryPlanner | null = null

constructor(..., planner?: QueryPlanner) {
  this.planner = planner ?? null
}

// 2. query() 方法增加可选的 usePlanner 参数
query(queryString: string, usePlanner: boolean = false): NodeRecord[] {
  this._ensureOpen()
  const plan = parseQuery(queryString)
  
  if (usePlanner && this.planner) {
    // 将 QueryPlan 转换为 QueryPlanner 可理解的格式
    const spec = planToQuerySpec(plan)
    const optimized = this.planner.optimize(spec)
    // 但 executeIR 需要一个 ShardManager
    // 需要新增一个桥接层: PlanNode → GraphEngine._executeQueryPlan
    return this._executeOptimizedPlan(optimized)
  }
  
  return this._executeQueryPlan(plan)
}

// 3. 新增 bridge: PlanNode → 内部执行
private _executeOptimizedPlan(node: PlanNode): NodeRecord[] {
  // 从 PlanNode 树中提取优化后的参数
  // 利用推入的 filter/limit 信息加速
  // ...
}
```

**关键桥接逻辑（约80行代码）**：

```typescript
// graph-engine.ts
/**
 * 将优化后的 PlanNode 树转回执行指令。
 * 利用下推的 filter/limit 在扫描层做早期剪枝。
 */
private _executeOptimizedPlan(node: PlanNode): NodeRecord[] {
  switch (node.type) {
    case 'SCAN': {
      const pushedFilters = node.details['pushedFilters']
      const pushedLimit = node.details['pushedLimit']
      const typeId = node.details['typeId']
      
      let candidates = typeId 
        ? this._scanNodesByLabel(String(typeId))
        : this._scanAll()
      
      // 应用下推的 filter（在扫描层做早期过滤）
      if (pushedFilters) { ... }
      // 应用下推的 limit（早期截断）
      if (pushedLimit) { candidates = candidates.slice(0, pushedLimit as number) }
      
      return candidates
    }
    // ... 递归执行子节点
  }
}
```

### 3.5 结论

打通方案需要约 100-150 行代码，本质上是新增一个 `PlanNode → GraphEngine._executeQueryPlan` 的桥接层。不需要 npm 包。

核心改动文件：
- `src/core/graph-engine.ts` — 新增 `_executeOptimizedPlan()` + 修改 `query()` 和构造函数
- `src/api/query-planner.ts` — 新增 `planToQuerySpec()` 转换函数

---

## 项 4: REST API 补齐 (Q04)

### 4.1 当前已实现的端点

**文件**: `src/api/rest.ts`

| 方法 | 路径 | 行号 | 功能 | 认证 |
|---|---|---|---|---|
| GET | `/api/status` | 第151-158行 | 系统状态和分片信息 | 无 |
| GET | `/api/health` | 第220-224行 | 健康检查 | 无 |
| POST | `/api/graph/nodes` | 第168-178行 | 创建节点 | 需要, write |
| GET | `/api/graph/node` | 第181-193行 | 读取节点（通过 body.id） | 需要, read |
| DELETE | `/api/graph/node` | 第209-218行 | 删除节点 | 需要, delete |
| GET | `/api/admin/replication` | 第244-258行 | 复制状态（条件） | 需要, admin |
| PUT | `/api/admin/replication/config` | 第262-282行 | 复制配置热加载 | 需要, admin |

### 4.2 与竞品对比缺口

**竞品**: Neo4j HTTP API

| Neo4j API | AgentiX 有无 | 说明 |
|---|---|---|
| `POST /db/{db}/tx` (事务/查询) | ❌ | 无事务执行端点 |
| `POST /db/{db}/node` | ✅ | 已有 `POST /api/graph/nodes` |
| `GET /db/{db}/node/{id}` | ✅ | 已有 `GET /api/graph/node` |
| `DELETE /db/{db}/node/{id}` | ✅ | 已有 `DELETE /api/graph/node` |
| `POST /db/{db}/relationship` | ❌ | 无边的操作端点 |
| `GET /db/{db}/relationship/{id}` | ❌ | 无边读取端点 |
| `DELETE /db/{db}/relationship/{id}` | ❌ | 无边删除端点 |
| 批量操作 | ❌ | 无批量 upsert 端点 |
| 批量边操作 | ❌ | 无批量边 upsert 端点 |
| 查询（Cypher） | ❌ | 无 `POST /api/query` 端点 |
| 流式查询 (Chunked) | ❌ | 无流式支持 |
| WebSocket 订阅 | ❌ | 无订阅模式 |

### 4.3 路由匹配模式的问题

当前路由匹配（第327-331行）是**精确字符串匹配**，不支持路径参数：

```typescript
const method = req.method?.toUpperCase() ?? 'GET'
const path = parsed.pathname
const matched = routes.find(r => r.method === method && r.path === path)
```

这意味着不能实现 `/api/graph/node/42`，必须用 body 传入 id。这是 REST 设计的大缺陷。

### 4.4 缺失端点实现方案

#### 4.4.1 改造路由为路径模式匹配（基础改动，约40行）

```typescript
// rest.ts
interface Route {
  method: string
  path: string          // 支持 /api/graph/node/:id
  pattern?: RegExp
  paramNames?: string[]
  handler: RouteHandler
  requireAuth?: boolean
  requiredPermission?: string
}

// 路由注册时编译正则
function compileRoute(path: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = []
  const regexStr = path.replace(/:([^/]+)/g, (_, name) => {
    paramNames.push(name)
    return '([^/]+)'
  })
  return { pattern: new RegExp(`^${regexStr}$`), paramNames }
}

// 匹配时
const matched = routes.find(r => {
  if (r.method !== method) return false
  if (r.pattern) {
    const m = path.match(r.pattern)
    if (m) {
      // 参数赋值
      r.paramNames!.forEach((name, i) => ...)
      return true
    }
    return false
  }
  return r.path === path
})
```

#### 4.4.2 边操作端点（约60行）

```typescript
// 以下路由插入到 routes 数组

// POST /api/graph/edges — 创建边
{
  method: 'POST', path: '/api/graph/edges',
  requireAuth: true, requiredPermission: 'write',
  handler: async (req, res, _parsed, _auth) => {
    const body = await parseBody(req) as any
    if (!body.src || !body.dst || !body.type) {
      jsonResponse(res, 400, { error: 'src, dst, and type are required' })
      return
    }
    await shardManager.upsertEdge(body.src, body.dst, body.type, body.opts)
    jsonResponse(res, 200, { message: 'ok' })
  }
}

// GET /api/graph/edges/:nodeId — 读取某节点的邻边
{
  method: 'GET', path: '/api/graph/edges/:nodeId',
  requireAuth: true, requiredPermission: 'read',
  handler: async (req, res, parsed, _auth) => {
    const nodeId = Number(...)
    const result = await shardManager.neighbors(nodeId, { maxDepth: 1 })
    jsonResponse(res, 200, result)
  }
}

// DELETE /api/graph/edge — 删除边
{
  method: 'DELETE', path: '/api/graph/edge',
  requireAuth: true, requiredPermission: 'delete',
  handler: async (req, res, _parsed, _auth) => {
    const body = await parseBody(req) as any
    // shardManager.deleteEdge 当前不存在
    // 需要先在 shard-manager.ts 中添加
  }
}
```

注：`shardManager.deleteEdge()` 目前不存在（`shard-manager.ts`），需要先添加。边删除先通过 `range.write({ type: 'delete_edge', payload: { src, dst } })` 实现。

#### 4.4.3 批量操作端点（约40行）

ShardManager 已有 `batchUpsertNodes()`（第302行）和 `batchUpsertEdges()`（第340行），只需暴露 REST 端点：

```typescript
// POST /api/graph/nodes/batch — 批量创建节点
{
  method: 'POST', path: '/api/graph/nodes/batch',
  requireAuth: true, requiredPermission: 'write',
  handler: async (req, res, _parsed, _auth) => {
    const body = await parseBody(req) as any
    if (!Array.isArray(body.nodes)) {
      jsonResponse(res, 400, { error: 'nodes array is required' })
      return
    }
    const ids = await shardManager.batchUpsertNodes(body.nodes)
    jsonResponse(res, 200, { ids })
  }
}

// POST /api/graph/edges/batch — 批量创建边
{
  method: 'POST', path: '/api/graph/edges/batch',
  requireAuth: true, requiredPermission: 'write',
  handler: async (req, res, _parsed, _auth) => {
    const body = await parseBody(req) as any
    if (!Array.isArray(body.edges)) {
      jsonResponse(res, 400, { error: 'edges array is required' })
      return
    }
    await shardManager.batchUpsertEdges(body.edges)
    jsonResponse(res, 200, { message: 'ok' })
  }
}
```

#### 4.4.4 查询端点（约30行）

```typescript
// POST /api/query — Cypher-lite 查询
{
  method: 'POST', path: '/api/query',
  requireAuth: true, requiredPermission: 'read',
  handler: async (req, res, _parsed, _auth) => {
    const body = await parseBody(req) as any
    if (!body.query) {
      jsonResponse(res, 400, { error: 'query string is required' })
      return
    }
    // 注意：当前 GraphEngine.query() 是同步的且需要 GraphEngine 实例
    // ShardManager 不直接暴露 query 方法
    // 需要在 ShardManager 层添加 query 方法（fan-out 到各 range）
    const results = await shardManager.query(body.query)
    jsonResponse(res, 200, { results })
  }
}
```

需要先在 `ShardManager` 添加 `query(queryString)` 方法。

#### 4.4.5 流式查询（SSE）

使用 `Transfer-Encoding: chunked` 实现：

```typescript
// GET /api/query/stream?query=... — 流式查询（SSE）
{
  method: 'GET', path: '/api/query/stream',
  requireAuth: true, requiredPermission: 'read',
  handler: async (req, res, _parsed, _auth) => {
    const url = new URL(req.url!, `http://${req.headers.host!}`)
    const queryStr = url.searchParams.get('query')!
    
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })
    
    // 分页发送结果
    const batchSize = 100
    let offset = 0
    while (true) {
      // 实际场景：从存储层分批拉取
      const batch = await fetchBatch(queryStr, batchSize, offset)
      if (batch.length === 0) break
      res.write(`data: ${JSON.stringify(batch)}\n\n`)
      offset += batch.length
    }
    res.write('event: complete\ndata: {}\n\n')
    res.end()
  }
}
```

### 4.5 是否需要 express/koa？

**不需要。** 当前使用 Node.js 内置 `http.createServer` + `https.createServer`，已经支持：
- 路由分发（需要改造支持路径参数）
- JSON body 解析
- mTLS 认证
- CORS
- Rate Limit
- 响应格式化

**完全不需要 express、koa、fastify 等第三方框架的理由**：
1. 当前路由只有 ~10 个端点，手动路由管理复杂度低
2. 内置 http/https 模块支持所有需要的功能
3. 引入 express/koa 会增加包大小 (~500KB+) 和依赖风险
4. 安全层（mTLS）已经用原生 API 实现，引入框架不会简化

**唯一需要改的**：路由匹配引擎从精确字符串匹配改为路径参数匹配（约40行），如 4.4.1 所述。

### 4.6 每个缺失端点的实现优先级和工作量

| 端点 | 优先级 | 依赖 | 预估代码量 |
|---|---|---|---|
| 路由改造（路径参数） | **P0** | 无 | 40行 |
| `POST /api/graph/edges` | **P0** | 无 | 20行 |
| `GET /api/graph/edges/:nodeId` | **P0** | 路由改造 | 20行 |
| `DELETE /api/graph/edge` | **P1** | 需先加 `shardManager.deleteEdge()` | 30行 |
| `POST /api/graph/nodes/batch` | **P1** | 现有 `batchUpsertNodes` | 20行 |
| `POST /api/graph/edges/batch` | **P1** | 现有 `batchUpsertEdges` | 20行 |
| `POST /api/query` | **P1** | 需 `ShardManager.query()` 方法 | 50行 |
| `GET /api/query/stream` | **P2** | SSE 实现 | 60行 |
| WebSocket 订阅 | **P3** | ws 库（外部依赖） | 100行 |
| `POST /api/graph/nodes-by-property` | **P2** | 现有 `findNodesByProperty` | 15行 |

**总计**: P0 ~80行, P1 ~120行, P2+P3 ~175行

---

## 总结

| 项目 | 当前状态 | 核心缺口 | 推荐方案 | 预估代码量 | 需要 npm 包? |
|---|---|---|---|---|---|
| **Q01 聚合函数** | GraphEngine 层有 API, query-engine 未暴露 | 缺乏聚合 AST 解析和执行 | 自研 ~80行, 扩展 QueryPlan + Fluent API | ~80行 + 测试 | ❌ 不需要 |
| **Q02 UNION/集合运算** | Fluent API 已实现, Cypher-lite 不支持 | AST 解析器和 GraphEngine 未接入 | 扩展 AST + GraphEngine 方法 | ~40行 | ❌ 不需要 |
| **Q03 优化器-执行器桥接** | 优化器和执行器完全独立 | 缺少 PlanNode→GraphEngine 桥接 | 新增桥接层 | ~100-150行 | ❌ 不需要 |
| **Q04 REST API 补齐** | ~7个基本端点, 缺失边/批量/查询/流式 | 路由不支持路径参数 + 端点缺失 | 自实现路由改进 + 新增端点 | ~240-375行 | ❌ 不需要 express/koa |

**总预估代码量**: ~460-645行
