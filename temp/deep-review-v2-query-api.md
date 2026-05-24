# 深度审查 C：查询+API 层

> **项目**: agentiX-graphvec
> **审查范围**: `src/api/`、`src/graphql/`、`src/search/`
> **审查日期**: 2026-05-23

| 文件 | 行数 |
|------|------|
| `src/api/fluent.ts` | 1456 |
| `src/api/rest.ts` | 619 |
| `src/api/query-planner.ts` | 579 |
| `src/graphql/server.ts` | 435 |
| `src/graphql/client.ts` | 67 |
| `src/search/fulltext.ts` | 896 |

---

## 1. 查询语言能力 (Fluent API) vs 竞品

### Q-01 [🔴] 缺少聚合功能 (COUNT/SUM/AVG/GROUP BY)
- **模块**: `src/api/fluent.ts` — GraphQuery
- **严重度**: 🔴
- **对比**: Neo4j Cypher 支持 `RETURN count(n)`, `avg()`, `sum()`, `group by` 聚合；Dgraph DQL 支持 `count()`, `min()`, `max()`, `sumval()`；ArangoDB AQL 支持 `COLLECT` + 聚合函数；JanusGraph Gremlin 支持 `count()`, `group()`, `fold()` 等聚合操作
- **描述**: AgentiX Fluent API 当前只提供 `match → where → neighbors → return` 的单一链路，没有聚合查询入口。虽然有 `count()` 方法，但它仅对最终结果集做 `.length`，无法实现在图遍历过程中的中间聚合（如按类型分组计数、路径长度统计、属性统计），也没有 `groupBy()`、`aggregate()` 等链式方法。`queryPattern()` 返回原始节点列表，没有聚合层。
- **方案**: 在 `GraphQuery` 上增加 `aggregate(groupBy, aggregates)` 链式方法，构建聚合计划节点；`return()` 时根据聚合配置执行分组 + 汇总计算；示例：`q.match(1).aggregate('type', [{ op: 'count', alias: 'cnt' }]).return()`
- **工作量**: 中

### Q-02 [🔴] 缺少 UNION/DISTINCT/交集/差集操作
- **模块**: `src/api/fluent.ts` — GraphQuery
- **严重度**: 🔴
- **对比**: Cypher 支持 `UNION`, `UNION ALL`, `INTERSECT`, `EXCEPT`；AQL 支持 `UNION()`, `INTERSECTION()`, `OUTER()` 函数；Gremlin 支持 `union()`, `intersect()`, `dedup()`
- **描述**: 当前 Fluent API 不支持将多个查询的结果进行集合运算。查询总是单链执行。虽然有去重逻辑（`dedupMap` 在 `expandNeighbors` 中），但没有暴露 `distinct()` / `union()` / `intersect()` 等链式方法。
- **方案**: 增加 `union(otherQuery)`, `intersect(otherQuery)`, `except(otherQuery)`, `distinct()` 链式方法；内部构建集合运算计划节点；执行时对多个子查询结果进行集合运算。
- **工作量**: 中

### Q-03 [🟡] 递归路径查询能力有限 (repeat/until/emit 性能问题)
- **模块**: `src/api/fluent.ts` — 行 253-348 (repeat/until/emit)
- **严重度**: 🟡
- **对比**: Cypher 的 `MATCH path=(a)-[:KNOWS*1..5]->(b)` 是声明式递归模式匹配，数据库内部高效优化；Gremlin 的 `repeat().until().emit()` 是推拉混合的管道式遍历；AQL 的 `GRAPH_TRAVERSAL()`/`FOR v,e,p IN 1..5 ANY 'start' GRAPH 'g'` 也是声明式
- **描述**: AgentiX 的 `repeat/until/emit` 实现是命令式的逐层 BFS，在 `executeRepeat()` 中每次迭代调用 `manager.neighbors()`（一个异步 RPC 到引擎），产生严重的 `N+1` 问题。缺乏批量展开（batch neighbors）和剪枝优化。最大迭代 `_repeatMax` 固定为 10，不支持路径长度变量的声明（如 `1..5` 全部模式）。
- **方案**: (1) 在 `ShardManager`/`Engine` 层暴露批量 `batchNeighbors(ids[], depth)` 方法，减少 RPC 次数；(2) 支持 `neighbors(1, edgeFilter)` 声明式深度而非命令式逐层；(3) 增加 `pathVariable` 语法支持类似 Cypher 的 `1..N` 可变深度
- **工作量**: 大

### Q-04 [🟡] 缺少路径返回类型 (path/最短路径/路径投影)
- **模块**: `src/api/fluent.ts` — GraphQuery
- **严重度**: 🟡
- **对比**: Cypher 支持 `RETURN path` 和路径函数 `nodes(path)`, `relationships(path)`, `length(path)`；Gremlin 中 `path()` 直接输出遍历路径；AQL 支持 `GRAPH_SHORTEST_PATH()` 和 PATHS 函数
- **描述**: Fluent API 的 `return()` 仅返回节点列表，不返回边信息和路径结构。`neighbors()` 通过 `expandNeighbors()` 展开所有邻居，但丢弃了边的详细信息（哪些边连接了什么节点）。`queryPattern()` 也只返回节点去重后的集合。REST API 的邻居查询 `handleNeighbors` 返回 `{ nodes, edges }` 结构，但 Fluent API 中邻居遍历结果是去重节点列表。
- **方案**: 增加 `returnPaths()` 方法返回 `{ nodes: NodeRecord[], edges: EdgeRecord[] }` 结构；增加 `path()` 方法设置需要返回路径信息；在 PlanNode 中增加 Path 节点类型
- **工作量**: 中

### Q-05 [🔵] 缺少列表推导和过程调用能力
- **模块**: `src/api/fluent.ts` — GraphQuery
- **严重度**: 🔵
- **对比**: Cypher 支持 `[x IN list WHERE x.prop > 5 | x.name]` 列表推导和 `CALL procedure()` 过程调用；Gremlin 支持 `sideEffect`, `lambda`
- **描述**: Fluent API 不支持在查询链中嵌入列表转换或过程调用。复杂转换必须通过 `where()` 传函数 predicate 实现，无法序列化为 JSON 且不支持缓存。
- **方案**: 增加 `transform(fn)` 链式方法和 `call(procName, args)` 过程调用入口；transform 阶段在 `return()` 执行时作为转换层
- **工作量**: 小

### Q-06 [🔵] JSON 序列化缺失 repeat 下 detail/mode 等结构化信息
- **模块**: `src/api/fluent.ts` — `toJSON()` 方法 (行 ~1440) + `src/types.ts` — `QueryJSON` 接口
- **严重度**: 🔵
- **对比**: Cypher 查询是完整字符串可序列化；所有竞品查询语言都是完全可序列化的文本协议
- **描述**: `QueryJSON` 中的 `where` 仅支持 `Array<{key, value}>`，不支持函数类型 predicate；`fullText` 接口缺少 `fields`, `fuzzy`, `weights` 等选项；`repeat` 接口缺少 `until`, `edgeFilters` 等结构化信息；整体上与 Fluent API 的运行时能力存在 gap
- **方案**: 扩展 `QueryJSON` 接口，覆盖完整的序列化语义（包括 repeat 的完整配置、fulltext 选项、复合 where 条件）；在 `toJSON()` 中生成完整结构
- **工作量**: 小

---

## 2. 查询优化器 vs 竞品

### QO-01 [🔴] 缺少基于统计信息的成本优化 (CBO)
- **模块**: `src/api/query-planner.ts` — `StatisticsCollector`, `QueryOptimizer`
- **严重度**: 🔴
- **对比**: Neo4j 有成熟的 CBO（基于统计信息的成本优化器），使用直方图、基数估计和代价模型选择最优计划；AgentiX 的 `StatisticsCollector` 仅收集 `findNodesByType` 返回的 ID 数量，`distinctPropValues` 始终为空 Map，无实际统计信息
- **描述**: `StatisticsCollector.countDistinctFromNodeList()` 虽尝试从 engine 获取 distinct 计数，但依赖 `engine.getDistinctPropCount()` 方法 — 该方法的实现可能为空；`estimateCost()` 中的成本参数是硬编码的魔法数字（`cost=50.0/5.0/0.5` 等），未根据实际数据量动态调整；estimation 结果仅用于 explain 展示，**不真正影响执行路径选择**（Fluent API 的 `execute()` 实际执行路径由 chain 顺序决定，不受优化器影响）
- **方案**: (1) 在底层引擎/索引层增加统计信息收集（NDV、直方图、数据分布）；(2) 将 `ScanAllRanges` 的路径选择与 optimizer 的结论绑定；(3) 动态调整成本参数而非硬编码；(4) 收集持久化统计信息，支持周期性刷新
- **工作量**: 大

### QO-02 [🟡] 谓词下推仅存在于 EXPLAIN 阶段，不影响实际执行
- **模块**: `src/api/query-planner.ts` — `pushDownFilter()`, `src/api/fluent.ts` — `execute()`
- **严重度**: 🟡
- **对比**: ArangoDB 优化器会真正将 filter/limit/sort 下推到 storage 层执行；Neo4j 的 filter 下推到 index scan；JanusGraph 后端过滤下推到 HBase/Cassandra
- **描述**: `QueryOptimizer` 的 `pushDownFilter()` 在优化前后计划树上将 `Filter → Scan` 替换为 `IndexScan`，但这只是 EXPLAIN 树的变换。Fluent API 实际执行 (`execute()`) 中，结构化属性过滤在内存中 (`nodes.filter()`) 完成，优化器结果不驱动执行。`propertyFilters` 虽然被收集，但仅在 `execute()` 的 `canUseComposite` 路径中尝试复合索引，此处的谓词下推逻辑与 optimizer 独立。
- **方案**: (1) 将 optimizer 结果转化为实际执行路径选择（如当 optimizer 判定 IndexScan 优于 Scan 时，实际走 `findNodesByProperty` 路径）；(2) 在 `execute()` 中引入真正的 filter pushdown 决策器，调用 `QueryOptimizer.evaluate` 而非仅用于 explain
- **工作量**: 中

### QO-03 [🟡] 缺少子查询去关联和 Join 优化
- **模块**: `src/api/query-planner.ts` — `reorderOperations()`
- **严重度**: 🟡
- **对比**: ArangoDB 支持子查询去关联（subquery unnesting），将子查询从循环体中提升为 JOIN 以提高性能；Neo4j 使用 Semi-apply/Lazy-apply 策略；AgentiX 完全不支持多查询的组合优化
- **描述**: `reorderOperations()` 仅对同层子节点按 `estimatedRows` 排序，且 `PlanNode` 的 `children` 实际上是**单链**结构（每个节点只有一个子节点，表示执行流水线），不是真正的 join tree。没有子查询去关联逻辑，没有 join ordering（多分支合并）。
- **方案**: (1) 引入真正的 join tree 结构支持多分支；(2) 实现子查询去关联（对于 where 中嵌套的子查询，提升为 JOIN）；(3) 按 selectivity 优化 join order
- **工作量**: 大

### QO-04 [🔵] 缺少查询计划缓存
- **模块**: `src/api/query-planner.ts`
- **严重度**: 🔵
- **对比**: Neo4j 有查询计划缓存（基于 query hash），避免重复优化；PostgreSQL 有计划缓存
- **描述**: 每次查询都从头构建计划树、执行 optimize，没有缓存机制。对于高频重复查询（如固定的 pattern match 模式），产生不必要的开销。
- **方案**: 在 `GraphQuery` 或 `QueryOptimizer` 中增加 LRU 计划缓存，以 `toJSON()` 的 JSON 字符串 hash 为 key；仅在首次或数据变更时优化
- **工作量**: 小

### QO-05 [🔵] 缺少 Top-K 堆优化的实际效果验证
- **模块**: `src/api/fluent.ts` — `applyOrderTopK()`, `heapTopK()`
- **严重度**: 🔵
- **对比**: Gremlin/TinkerPop 的 `order().by().limit()` 有专门的 Top-K 优化路径；所有竞品的 LIMIT+ORDER BY 组合在数据库引擎层面优化
- **描述**: `applyOrderTopK()` 实现了堆排序 Top-K 优化，但该优化仅在 `limit_ !== null` 时触发，且堆大小等于 `effectiveLimit`（不是常数）。当 `nodes.length <= effectiveLimit` 时退回全排序。整体逻辑正确但缺乏 bench 验证和调优（堆使用 `MinHeap` 通用实现，对 limit 较大时的性能可能需要压测）。
- **方案**: 添加性能基准测试，对比 Top-K 堆优化 vs 全排序在不同数据规模和 limit 值下的表现；可视需要引入流式排序（Streaming sort）
- **工作量**: 小

---

## 3. REST API 设计

### REST-01 [🟡] 不支持 OpenAPI/Swagger 文档
- **模块**: `src/api/rest.ts`
- **严重度**: 🟡
- **对比**: 行业最佳实践要求 REST API 附带 OpenAPI 3.0 规范文档（自动生成或手写）；竞品如 Neo4j 的 HTTP API 有完整文档
- **描述**: `RestApiServer` 无任何 OpenAPI 声明生成或内省端点。API 文档需要开发者通读源码的手动注册路由才能使用。没有 `/openapi.json` 或 `/docs` 端点。
- **方案**: (1) 使用 `tsoa`/`zod` 自动从 TypeScript 类型生成 OpenAPI 3.0 规格；(2) 或在 `RestApiServer` 中手动声明 OpenAPI schema 并暴露 `/api/openapi.json`；(3) 配合 Swagger UI/Redoc 提供交互式文档
- **工作量**: 中

### REST-02 [🟡] 缺少请求验证和类型安全
- **模块**: `src/api/rest.ts` — 各 handler
- **严重度**: 🟡
- **对比**: 最佳实践使用 Zod/Joi/AJV 等 schema 验证库进行请求体验证，返回明确错误信息和状态码
- **描述**: 当前验证是手动且不一致的：`handleUpsertNode` 检查 `typeof typeId !== 'number'`，`handleJsonGraphQuery` 没有验证 `QueryJSON` 结构，`handleVectorSearch` 检查数组非空但未校验元素类型。错误码混杂——部分返回 400，部分返回 500，部分返回 501。缺少 deep validation（嵌套 prop 类型检查、边界值检查）。
- **方案**: 引入 `zod` schema 定义各端点的请求体类型，自动验证并返回结构化 400 错误；统一错误响应格式
- **工作量**: 中

### REST-03 [🟡] 缺少速率限制和请求超时
- **模块**: `src/api/rest.ts` — `RestApiServer`
- **严重度**: 🟡
- **对比**: 生产级 REST Gateway 必须有速率限制（防滥用）和请求超时（防 hang）；Neo4j HTTP API 支持 timeout
- **描述**: `handleRequest()` 没有任何限流或超时机制。一个慢查询（如深度 pattern match 或大图全扫描）可能 hang 住请求线程。没有 `AbortController` 超时，没有按 IP/API Key 的 rate limiting。
- **方案**: (1) 增加 `express-rate-limit` 风格中间件（即使使用原生 http 模块也可实现）；(2) 使用 `AbortController` + `setTimeout` 实现单请求超时；(3) 在 `handleRequest` 中注入超时逻辑
- **工作量**: 中

### REST-04 [🔵] 缺少批量查询端点 (batch query)
- **模块**: `src/api/rest.ts` — 路由注册
- **严重度**: 🔵
- **对比**: Neo4j HTTP API 支持 `POST /db/{db}/tx/commit` 批处理；最佳实践中批量查询可减少 N+1 请求
- **描述**: 虽然有 `POST /api/graph/nodes/batch`（批量 upsert 节点），但缺少批量查询端点（一次请求执行多个 Fluent Query 并分别返回结果）。客户端需要为每个查询发起独立 HTTP 请求。
- **方案**: 增加 `POST /api/graph/query/batch`，接收 `{ queries: QueryJSON[] }`，并行执行后返回 `{ results: NodeRecord[][] }`
- **工作量**: 小

### REST-05 [🔵] 缺少健康检查和 readiness probe
- **模块**: `src/api/rest.ts` — `handleStatus`/`handleMetrics`
- **严重度**: 🔵
- **对比**: 最佳实践需要在 Kubernetes 部署中暴露 `/healthz` (liveness) 和 `/readyz` (readiness)
- **描述**: `/api/status` 检查 `shardManager.getShardStatus()` + `process.uptime()`，但缺少 readiness 检查（所有 shard 是否完成 leader election？索引是否 build 完成？）。没有独立的轻量级健康检查端点（不触发 shard 查询）。
- **方案**: 增加 `GET /healthz`（返回 200 空响应，仅验证服务器正在运行）和 `GET /readyz`（验证所有 shard 已就绪、索引已构建）
- **工作量**: 小

---

## 4. GraphQL

### GRAPHQL-01 [🟡] 缺少查询级 DataLoader/N+1 优化
- **模块**: `src/graphql/server.ts` — `NodeDataLoader`
- **严重度**: 🟡
- **对比**: Neo4j GraphQL 库使用 @neo4j/graphql 自动生成查询，支持嵌套查询优化（将多级 GraphQL 查询编译为单条 Cypher）；Dgraph 原生 GraphQL 直接使用 DQL 底层优化
- **描述**: `NodeDataLoader` 实现了一个简单的惰性缓存（Map），但没有真正的批处理。`load()` 对每个 ID 单独调用 `manager.getNode(id)`，每个返回 promise 后立即 resolve，不会等到微任务队列 flush 后合并批量查询。实际效果与无 DataLoader 相同（仍然是 N+1 次 getNode 调用）。
- **方案**: (1) 使用标准 DataLoader 模式（将每个微任务 tick 中的 load 请求暂存，tick 结束时 flush 为 `batchGetNodes(ids[])` 批量查询）；(2) 或直接使用 [dataloader](https://github.com/graphql/dataloader) 库
- **工作量**: 小

### GRAPHQL-02 [🟡] GraphQL Schema 与 Fluent API 能力不匹配
- **模块**: `src/graphql/server.ts` — `typeDefs`
- **严重度**: 🟡
- **对比**: Neo4j GraphQL 可以直接映射到 Cypher 所有能力；AgentiX GraphQL Schema 与 Fluent API gap 很大
- **描述**: GraphQL Schema 缺少以下 Fluent API 已有能力：`fullTextSearch`（全文搜索）、`patternMatch`（模式匹配）、`queryMaterializedView`（物化视图查询）。Schema 中的 `Node` 缺少 `props` 字段的类型定义（仅用 `JSON` 标量），无法在 IDE 中提示。没有 `orderBy`, `limit`, `skip` 参数（Fluent API 都支持）。
- **方案**: 扩展 GraphQL Schema，添加 `fullTextSearch` 查询和 `MaterializedView` 查询，为节点查询添加分页和排序参数，定义更精确的 `NodeProps` 输入类型
- **工作量**: 中

### GRAPHQL-03 [🔵] 缺少 GraphQL 订阅的扩展能力
- **模块**: `src/graphql/server.ts` — Subscription `nodeChanged`
- **严重度**: 🔵
- **对比**: Neo4j GraphQL 支持变更事件、CDC 事件流
- **描述**: 当前只支持 `nodeChanged` 单一订阅事件，缺少 `edgeChanged`、`indexRebuilt`、`shardLeaderChanged` 等事件。订阅过滤器仅支持按 `mutation` 类型（UPSERT/DELETE），不支持按 `typeId` 或 `name` 模式过滤。
- **方案**: 增加 `edgeChanged` 订阅事件，为 `nodeChanged` 增加 `typeId` 过滤器参数，增加 `indexStatus` 事件
- **工作量**: 小

### GRAPHQL-04 [🔵] 缺少 GraphQL 错误处理规范化
- **模块**: `src/graphql/server.ts` — resolvers
- **严重度**: 🔵
- **对比**: 最佳实践要求 GraphQL 错误包含 `extensions.code` 和 `extensions.exception` 结构化错误码
- **描述**: 所有 resolver 错误以 `throw new Error(message)` 形式返回，不包含结构化错误码和分类。客户端难以区分「节点不存在」「权限不足」「内部错误」等场景。
- **方案**: 统一使用 `GraphQLError`（从 `graphql` 包）并设置 `extensions.code` 和 `extensions.http.status`；在中介层捕获错误并标准化
- **工作量**: 小

---

## 5. 全文+向量搜索

### SEARCH-01 [🟡] 缺少拼音/同义词/词干化支持
- **模块**: `src/search/fulltext.ts`
- **严重度**: 🟡
- **对比**: Elasticsearch 支持拼音分词器、同义词过滤器、词干分析器（stemmer）；Meilisearch 有内置容错和前缀搜索；FTS5 支持前缀查询和 Unicode61 分词器
- **描述**: `FullTextIndex` 仅有汉字 bigram/trigram 分词 + 英文空格分割。不支持：同义词扩展（"car"→"automobile"）、中文拼音搜索（"北京" ↔ "beijing"）、英文词干化（"running"→"run"）、英文 prefix search（"goo" 匹配 "google"）。模糊搜索使用 Levenshtein 距离，但未对中文拼音做映射。
- **方案**: (1) 增加词干化（Porter Stemmer 库）；(2) 增加同义词词典接口，支持查询时扩展；(3) 引入拼音映射表支持中文拼音容错搜索；(4) 增加 prefix search 支持（通过前缀索引树）
- **工作量**: 中

### SEARCH-02 [🟡] 缺少增量索引更新
- **模块**: `src/search/fulltext.ts` — `addDocument()`/`removeDocument()`
- **严重度**: 🟡
- **对比**: Elasticsearch 支持近实时索引（1s 内刷新）；FTS5 支持增量 merge
- **描述**: `addDocument()` 和 `removeDocument()` 直接操作 `invertedIndex` Map，没有 WAL（write-ahead log）、没有段合并、没有批量 flush。对于高频更新场景（如实时摄取），Map 操作有竞争风险（未加锁），且每次写操作都立即可见（无缓冲刷新机制）。缺少增量 build 能力（必须从零初始化）。
- **方案**: (1) 引入 segment-based 索引（内存缓冲区 → 定期 flush 到主索引）；(2) 为多线程环境增加读写锁或 copy-on-write；(3) 支持 append-only log 以便崩溃恢复
- **工作量**: 中

### SEARCH-03 [🟡] 缺少 BM25 评分算法
- **模块**: `src/search/fulltext.ts` — `computeTF()`, `computeIDF()`
- **严重度**: 🟡
- **对比**: Elasticsearch 默认使用 BM25（Okapi BM25），比经典 TF-IDF 有更好的调参能力和实际效果；FTS5 默认使用 BM25
- **描述**: 当前 TF 使用对数归一化 `log(1+tf)/log(1+totalTokens)`，IDF 使用 `log(1+(N-df+0.5)/(df+0.5)) + 1` — 类似 BM25 但缺少 BM25 的两个关键参数：`k1`（词频饱和参数, 默认 1.2）和 `b`（文档长度归一化参数, 默认 0.75）。实际公式接近 Okapi BM25 但无调参接口。`autoTune()` 中的 `beta` 参数未实际使用。
- **方案**: (1) 在 `computeTF()` 中增加 `k1` 和 `b` 参数，实现完整 BM25 公式 `log(1+(N-df+0.5)/(df+0.5)) * (tf*(k1+1))/(tf+k1*(1-b+b*len/avgLen))`；(2) 暴露 BM25 参数配置到 `SearchOptions`
- **工作量**: 小

### SEARCH-04 [🟡] 全文搜索未集成到 Fluent API 的 where($text) 路径
- **模块**: `src/api/fluent.ts` — `execute()` 中全文搜索路径, `src/search/fulltext.ts`
- **严重度**: 🟡
- **对比**: Elasticsearch 的 query DSL 与 REST API 深度集成；AgentiX 的 `where({ $text: 'keyword' })` 通过注入的 `fullTextSearchFn` 回调调用，但该回调需要外部注入、非默认集成
- **描述**: `GraphQuery` 支持 `where({ $text: 'keyword' })` 语法，但实际执行依赖外部注入的 `FullTextSearchCallback`。`FullTextIndex` 是独立类，未与 `GraphQuery` 默认绑定。需要用户在构造 `GraphQuery` 时手动传递回调。缺少内置的全文索引与查询引擎的粘合层。
- **方案**: (1) 在 `ShardManager` 或 `RangeEngine` 层集成 `FullTextIndex` 实例；(2) 让 `GraphQuery` 默认从 manager 获取全文索引而非依赖注入；(3) 确保 `where({ $text })` 开箱即用
- **工作量**: 中

### SEARCH-05 [🔵] 全文搜索缺少短语查询和多字段加权排名
- **模块**: `src/search/fulltext.ts` — `search()`
- **严重度**: 🔵
- **对比**: Elasticsearch 支持 `match_phrase` 查询（位置感知）；Meilisearch 默认按字段权重排序
- **描述**: `search()` 将查询字符串分词后做 AND/OR 模式匹配，不考虑词的相对位置（phrase proximity），不计算短语匹配加分。`weights` 配置虽然传入但仅在 TF-IDF 计算中加权字段，没有 position-dependent 的 boost。不支持 `"exact phrase"` 语法。
- **方案**: (1) 在 `invertedIndex` 的 term→doc 条目中，利用 `positions` 数组检测相邻词（phrase match），给予额外得分 boost；(2) 在 tokenize 中识别引号包裹的短语；（3）短语匹配加分
- **工作量**: 中

### SEARCH-06 [🔵] 向量搜索参数未全文集成到 Fluent API
- **模块**: `src/api/fluent.ts` — `vectorSimilarity()`, `src/api/rest.ts` — `handleVectorSearch`
- **严重度**: 🔵
- **对比**: Dgraph DQL 原生支持向量搜索；HNSW 参数通常可在查询级别配置
- **描述**: `vectorSimilarity(k, options)` 支持 `efSearch`, `efConstruction`, `M`, `minScore` 等 HNSW 参数，这些参数通过 `manager.vectorSearch()` 传递。但 REST API 的 `handleVectorSearch` 只在 body 中接受 `{ vector, k }`，未暴露 `efSearch`, `minScore` 等高级选项。GraphQL Schema 的 `search(vector, k)` 同样缺失。
- **方案**: (1) 在 REST `POST /api/graph/search/vector` body 中增加 `efSearch`, `minScore` 等可选参数；(2) 在 GraphQL Schema 中扩展 `search` 查询的 input 参数
- **工作量**: 小

---

## 汇总

| 类别 | 严重度 | 工作量 |
|------|--------|--------|
| **查询语言** | 2🔴 + 2🟡 + 2🔵 | 2大 + 3中 + 2小 |
| **查询优化器** | 1🔴 + 2🟡 + 2🔵 | 2大 + 1中 + 2小 |
| **REST API** | 0🔴 + 3🟡 + 2🔵 | 0大 + 3中 + 2小 |
| **GraphQL** | 0🔴 + 2🟡 + 2🔵 | 0大 + 1中 + 3小 |
| **全文+向量搜索** | 0🔴 + 4🟡 + 2🔵 | 0大 + 4中 + 2小 |
| **合计** | **3🔴 + 13🟡 + 10🔵** | **4大 + 12中 + 10小** |

### 关键发现总结

1. **查询语言能力差距最大**：缺少聚合、UNION、路径返回等核心图查询语义，与 Neo4j Cypher/AQL/Gremlin 的功能完整度差距明显。`repeat/until/emit` 性能存在 N+1 问题。

2. **查询优化器"只说不做"**：优化器规则（谓词下推、索引选择）仅在 EXPLAIN 计划树上生效，**不影响实际执行路径**。优化器与执行器脱节是架构级别问题。

3. **REST/GraphQL API 功能覆盖不足**：REST API 缺少请求验证、速率限制、OpenAPI 文档。GraphQL Schema 能力不足 Fluent API 的 60%，N+1 优化未真正实现。

4. **全文搜索基础扎实但差距明显**：TF-IDF 实现正确、倒排索引结构清晰、支持中文 bigram，但与 ES/Meilisearch 的差距在 BM25、同义词、拼音、增量索引方面。
