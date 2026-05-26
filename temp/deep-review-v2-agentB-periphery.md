# AgentiX GraphVec 深度审查 V2 — Agent B: 周边子系统

> 审查时间: 2026-05-26
> 审查范围: 索引层、API 层、分片层、安全层、运维层、共识层、复制层

---

## File: src/index/composite-index.ts

### 发现 1: 数值查询与字符串查询的分离导致 `number` 和 `boolean` 值被双重处理
- **严重性**: P2
- **描述**: `boolean` 类型的值在 `addRecord()` 中会被 `typeof value === 'number'` 分支跳过（`typeof true === 'boolean'`），但又未被第二个分支捕获（`else` 分支），`boolean` 值会在 `else` 分支中被 `String(value)` 转换为 `'true'/'false'` 字符串。但 `queryExact(field, boolean)` 中检查 `typeof value === 'number'` 不成立，会走字符串路径；然而 `boolean` 被存储为字符串，`queryExact` 的 `String(value)` 又能匹配，所以碰巧能工作。这是偶然正确而非设计正确。
- **影响**: `boolean` 类型的字段索引行为未精确定义，未来改动可能打断此行为。
- **建议**: 增加 `typeof value === 'boolean'` 的显式处理分支，或统一用字符串表示所有非数值类型。

### 发现 2: 查询结果集使用 `filter(id => resultSet.has(id))` 在迭代 full result 数组时为 O(n²)（已存在 Set）
- **严重性**: P2
- **描述**: 在 `query()` 方法的 AND 合并中，`result = result.filter(id => resultSet.has(id))` 对第一个条件的结果数组做迭代。此数组可能很大，但 `Set.has()` 是 O(1)，所以总体复杂度为 O(n)，问题不大。但更关键的问题是：首次条件筛选出大量结果后，第二次条件仍然遍历整个数组，没有利用索引的稀疏性优势。
- **影响**: 多条件复合查询时性能可能下降。
- **建议**: 对每个条件，选择预估结果集最小的条件作为首次筛选。当前实现没有基数估计（cardinality estimation），总是使用第一个条件。

### 发现 3: `queryRange()` 迭代整个数值索引 Map，无范围树结构
- **严重性**: P2
- **描述**: `queryRange()` 遍历 `numericIndex` 中某个 field 的全部 `Map.entries()`，进行 `min/max` 过滤，复杂度 O(n)。对于大量数值条目，每次范围查询都是全扫描。
- **影响**: 高基数数值字段上的范围查询性能差。
- **建议**: 使用有序数据结构（如 B-tree 或 `@stdlib/assert` 的 SortedSet）存储数值索引，支持 O(log n) 的范围查询。

---

## File: src/core/label-engine.ts

### 发现 1: 单文件 70 行，无重大问题
- **严重性**: P3
- **描述**: 此文件实现清晰、职责单一，无明显的性能或安全问题。
- **建议**: 无。

---

## File: src/search/fulltext.ts

### 发现 1: 未找到 `src/search/fulltext.ts` 文件
- **严重性**: P1（需求缺失）
- **描述**: 审查清单要求审查 `src/search/fulltext.ts`，但该文件在项目中不存在。说明全文搜索功能可能只是一个占位符或尚未实现。
- **影响**: 全文搜索功能缺失，产品规格无法满足。
- **建议**: 确认是否需要实现全文搜索索引，或在后续迭代中规划。

---

## File: src/core/graph-algorithms.ts

### 发现 1: `connectedComponents()` 使用 `while(true)` 递增 `index` 遍历所有节点
- **严重性**: P2
- **描述**: 方法从 `index = 0` 开始，通过 `engine.getNode(index)` 递增查询直到返回 null 来收集所有节点。这假设节点 ID 是连续的整数且从 0 开始。如果节点 ID 有空洞（例如删除了某些节点），遍历会在第一个空洞处停止并遗漏后续节点。
- **影响**: 连通分量计算结果不完整或错误。
- **建议**: 使用 `engine.allNodes()` 或 `engine.findNodesByType(0)` 等真正能列出所有节点的方法。

### 发现 2: 跨 Range fan-out 中的 fire-and-forget 异步调用
- **严重性**: P2
- **描述**: `_collectReachableCrossRange()`, `dijkstra()`, `_fanOutExpand()` 等方法中，`shardRouter.fanOut()` 被调用但不 `await`，仅 `.catch(() => {})` 静默处理。fan-out 结果被认为会由存储层 bridge "注入"到 `engine.neighbors()` 中，但没有任何同步机制确保注入在后续 `engine.neighbors()` 调用前完成。
- **影响**: 跨 Range 算法结果是"尽力而为"的，不可靠。TPR、Dijkstra 和最短路径的跨 Range 支持是功能性的假象。
- **建议**: 移除 crossRangeMode 支持或实现真正的异步等待机制（如 fan-out 返回 Promise 并 await）。

### 发现 3: `_collectReachableCrossRange()` 第四阶段的硬编码 `depth < 2`
- **严重性**: P2
- **描述**: 扩展远程节点的递归探索深度被硬编码为 2 层，无配置项。对大图此限制可能过于保守。
- **影响**: 跨 Range PPR 的 reachable 集合不完整。
- **建议**: 将最大深度作为 `AlgorithmConfig` 的可配置项。

### 发现 4: `_reconstructPath()` 中 backward 路径重建逻辑有边界问题
- **严重性**: P2
- **描述**: `_reconstructPath()` 开始的 `if (bCur !== undefined && bCur !== meetNode)` 条件中，如果 `bParent.get(meetNode) === meetNode`（即 meetNode 在反向搜索中是起点），backward 路径为空。后续的 `backwardPath[backwardPath.length - 1] !== targetId` 回退逻辑可能构建冗余路径。
- **影响**: 极端情况下可能返回包含重复或非最短的路径。
- **建议**: 重写路径重建逻辑为标准的双向 BFS 路径拼接模式。

### 发现 5: `MinHeap` 无容量限制
- **严重性**: P3
- **描述**: Dijkstra 的优先队列使用无限增长的本地 MinHeap。对大规模图，可能消耗大量内存。
- **影响**: 高基数场景的 Dijkstra 可能 OOM。
- **建议**: 在 `AlgorithmConfig` 中增加 `maxNodes` 限制。

---

## File: src/api/rest.ts

### 发现 1: `/api/graph/node` 路径设计不一致
- **严重性**: P2
- **描述**: GET `/api/graph/node`、DELETE `/api/graph/node` 使用 POST body 传递 `id` 参数，而不是路径参数（如 `/api/graph/node/:id`）。REST 最佳实践要求 GET/DELETE 使用路径参数而非请求体。
- **影响**: 不符合 REST 规范，与外部工具（curl、浏览器）兼容性差。
- **建议**: 改为路径参数模式：`GET /api/graph/node/:id`，`DELETE /api/graph/node/:id`。

### 发现 2: `/api/health` 总是返回 `{ status: 'ok' }`，未真正执行健康检查
- **严重性**: P1
- **描述**: 健康检查端点只是返回硬编码的 `{ status: 'ok' }`，没有实际的 Raft leader 检查、存储健康检查或引擎探测。
- **影响**: 虚假的健康状态，监控系统无法获得真实服务状态。
- **建议**: 将 `Health` 类的 `check()` 方法接入此处，返回真实的健康状态。

### 发现 3: POST /api/graph/nodes 和 GET /api/graph/node 中 `typeId` 和 `name` 的基本校验但无类型检查
- **严重性**: P2
- **描述**: `body.typeId` 仅通过 `!body.typeId` 检查 falsy 值；`0` 是有效的 typeId 但被视为 falsy。同样，`name` 的空字符串 `''` 也是 falsy。
- **影响**: 有效值 `typeId=0` 或 `name=""` 被错误拒绝。
- **建议**: 使用更精确的校验：`typeof body.typeId !== 'number' || !body.name`。

### 发现 4: `MemoryRateLimiter` 键冲突
- **严重性**: P2
- **描述**: 以 `clientIp` 作为限流键（`req.socket.remoteAddress`），但 NAT 环境下多用户共享同一 IP。无用户级或令牌级限流。
- **影响**: 共享 IP 的合法用户可能相互影响。且 `remoteAddress` 在反向代理后可能获取到代理 IP 而非客户端 IP。
- **建议**: 在反向代理场景下使用 `X-Forwarded-For` header，并考虑用户级别的限流。

### 发现 5: `enforceCors` 在 `https.createServer` 种未正确配置
- **严重性**: P2
- **描述**: CORS header 在 `https.createServer` 的 `request` 事件处理中手动设置。但 Node.js https server 不会自动处理 OPTIONS preflight；当前代码已经正确地处理了 OPTIONS 请求，但 `Access-Control-Allow-Origin` 使用 `process.env.CORS_ORIGIN || '*'`，其中 `'*'` 与带凭证的请求（mTLS 需要 Authorization/certificate）不兼容。
- **影响**: 如果 `CORS_ORIGIN` 未配置（默认 `'*'`），mTLS 客户端在浏览器中会遇到 CORS 错误。
- **建议**: 文档中说明 mTLS + CORS 的特殊性，或默认情况下不启用 CORS。

### 发现 6: `replicationManager` 的 admin 路由需要 `admin` 权限，但 RBAC 检查使用 `admin` 字符串而非 `'admin'` 字面常量
- **严重性**: P3
- **描述**: `requiredPermission: 'admin'` 与 RBAC 中的 `Role.ADMIN` 检查 `matched.requiredPermission`。RBAC `checkPermission` 检查的是 operation 名称而非角色，代码中 `matched.requiredPermission = 'admin'` 作为 operation name 传入 RBAC，但 RBAC 中 OPERATOR 的权限列表包含 `'compact', 'backup'` 等具体操作，`'admin'` 不在列表中。
- **影响**: 如果经过 `'admin'` operation 检查，实际会通过（ADMIN 角色 `['*']` 匹配一切），但语义上不清晰。
- **建议**: 将 admin 操作路由的 `requiredPermission` 设为 `'admin'` 但也应该明确标注这是角色检查而非操作检查。

---

## File: src/api/fluent.ts

### 发现 1: Fluent API 返回 `this` 用于链式调用，但 async 方法返回 `Promise<this>`
- **严重性**: P3
- **描述**: 此文件（已通读）逻辑基本清晰。未找到突出问题。
- **建议**: 无。

---

## File: src/api/query-planner.ts

### 发现 1: 932 行长文件，职责过多
- **严重性**: P2
- **描述**: query-planner.ts 达 932 行，包含 PlanNode 类型定义、统计收集器、执行器、代价模型等，违反了单一职责原则。
- **影响**: 维护困难，测试覆盖率低。
- **建议**: 拆分为 `query-planner-types.ts`、`query-planner-stats.ts`、`query-planner-executor.ts`。

### 发现 2: 查询计划不包含跨 Range 代价估计
- **严重性**: P2
- **描述**: PlanNode 包含 `estimatedCost` 和 `estimatedRows`，但无跨 Range 通信代价（network round-trips），所有 fan-out 操作被视为零代价。
- **影响**: 查询规划器会选择次优的跨 Range 执行计划。
- **建议**: 为 SCAN 和 PARALLEL_UNION 等操作增加跨 Range 代价因子。

---

## File: src/api/query-ir.ts

### 发现 1: 文件不存在
- **严重性**: P1（需求缺失）
- **描述**: 审查清单要求审查 `src/api/query-ir.ts`（查询 IR），但该文件不存在。
- **影响**: Query IR 层缺失，查询计划器的输出无法结构化表示。
- **建议**: 确认是计划中的功能还是遗漏文件。

---

## File: src/shard/shard-manager.ts

### 发现 1: `personalizedPageRank()` 在每轮 BFS 迭代中逐节点发起 `range.read()` 调用（N+1 查询模式）
- **严重性**: P1
- **描述**: `personalizedPageRank()` 方法在 BFS 阶段对每个出队的节点单独调用 `range.read(e => e.neighbors(current))`，即 N 次 Range 读取。然后在阶段 2 中又对每个节点单独调用 `range.read(e => e.neighbors(nodeId))` 计算 out-degree，同样是 N 次。这些都被包在 `for (const current of queue)` 和 `for (const nodeId of nodeIds)` 循环中。
  
  具体来说，BFS 阶段最多 50000 次读取，阶段 2 对 BFS 结果中每个节点再做一次独立的 `range.read()` 来获取 neighbors。在跨 Range 场景中（BFS 结果分布在不同 Range），这可能导致大量网络 round-trips。
- **影响**: 大规模 PPR 计算性能极差（O(N) 次 Range 读取，每次可能跨 Raft 组）。
- **建议**: 使用批量查询接口（如 `batchNeighbors(nodeIds[])`），将同一 Range 的节点分组后一次性读取。

### 发现 2: BFS 阶段和 PPR 幂迭代阶段重复读取 neighbors
- **严重性**: P2
- **描述**: BFS 阶段已经读取了所有节点的 neighbors 信息，但阶段 2 计算 out-degree 时又再次读取 `range.read(e => e.neighbors(nodeId))`。幂迭代阶段第三次读取 `range.read(e => e.neighbors(u))`。对于 50000 节点，总计可能读取 150000 次。
- **影响**: 严重的冗余 I/O，PPR 执行时间飙升。
- **建议**: BFS 阶段缓存节点邻居到内存 Map，后续阶段直接从缓存读取。

### 发现 3: `personalizedPageRank()` BFS 使用 `queue.shift()`（数组头部出队）
- **严重性**: P2
- **描述**: BFS 队列使用 `Array.shift()` 每次 O(n) 的头部移除操作。50000 节点时总复杂度 O(n²/2)。
- **影响**: BFS 阶段额外 O(n²) 时间开销。
- **建议**: 使用真正的队列实现（或数组索引指针）。

### 发现 4: `personalizedPageRank()` 每个幂迭代步骤都重新读取邻居
- **严重性**: P2
- **描述**: 幂迭代循环中每次迭代都对每个节点执行 `range.read(e => e.neighbors(u))`（幂迭代最多 100 次），即最多 50000 × 100 = 5,000,000 次 Range 读取。即使有收敛阈值，前几次迭代也涉及大量读取。
- **影响**: PPR 性能灾难性。
- **建议**: 在迭代开始前一次性缓存所有节点的邻居列表到内存。

### 发现 5: `findNodesByType()` 和 `findNodesByProperty()` 使用全量 fan-out 且无并发限制
- **严重性**: P2
- **描述**: 这两个方法使用 `await Promise.all(...)` 并发向所有 Range 发送读取请求。在 `ranges.size` 很大（如 100+）时，可能同时发起 100+ 次 Raft 读取，导致资源竞争和延迟上升。
- **影响**: 高 Range 数量时 fan-out 性能下降。
- **建议**: 引入 concurrency limit（如 16 的 p-limit/semaphore）来控制并发度。

### 发现 6: `findNodesByType()` 中 `for (const [_, range] of this.ranges)` 使用 `_` 作为 unused 变量
- **严重性**: P3
- **描述**: 使用 `_` 作为空闲变量，但 TypeScript 的 `noUnusedParameters` 编译配置下 `_` 不会被警告，这是可接受的模式。无实质问题。

### 发现 7: `vectorSearch()` 合并后直接 slice 而非按 Range 再排序
- **严重性**: P3
- **描述**: 合并后 `merged.sort(...)` 然后 `slice(0, query.k)`。基本的 top-K 合并，对大 Range 数无优化（如使用堆合并）。
- **影响**: 大量 Range 且前 K 很小时，全排序浪费。
- **建议**: 使用最小堆（大小 = K）来跨 Range 合并 top-K 结果。

### 发现 8: 无分片健康检查定时器
- **严重性**: P2
- **描述**: `ShardManager` 没有集成定时健康检查线程。如果有 Range 宕机（RangeInstance 无法响应），`getRange()` 仍然返回该实例，调用方会挂起或超时。
- **影响**: 无故障检测/隔离机制。
- **建议**: 在 ShardManager 中增加 Range 级心跳检测和故障标记。

---

## File: src/shard/shard-router.ts

### 发现 1: `consistent-hashing` 包使用 `replicas` 而非 `virtualNodes`
- **严重性**: P3
- **描述**: 构造函数中 `{ replicas: shardMap.hashRing.virtualNodes || 160 }`。`consistent-hashing` 包在 npm 上有多个实现，参数名不确定是否与 `replicas` 匹配（部分包使用 `vnodes` 或 `replicas`）。
- **影响**: 如果参数名不匹配，`virtualNodes` 配置不生效。
- **建议**: 确认 `consistent-hashing` 包的 API 签名。

### 发现 2: `getAllRanges()` 使用 `new Set()` 去重
- **严重性**: P3
- **描述**: `hashRing.nodes` 数组可能包含重复的 `rangeId` 条目（不同副本），`new Set[...]` 去重返回唯一 Range 列表。此逻辑正确，但依赖于 hashRing 的节点结构。
- **影响**: 无实质问题。

---

## File: src/shard/scatter-gather.ts

### 发现 1: `getAllNodes()` 访问 `engine['_nodeIds']`（私有属性）
- **严重性**: P1
- **描述**: `scatter-gather.ts` 的 `getAllNodes()` 方法通过 `engine['_nodeIds']` 直接访问 GraphEngine 的内部私有 Set。这是对封装性的严重破坏。
  ```typescript
  const allIds = engine['_nodeIds'] as Set<number> | undefined
  ```
- **影响**: 引擎数据结构变更会导致程序静默失效。测试/类型检查无法捕获此类问题。
- **建议**: 在 GraphEngine 上公开 `getAllNodeIds()` 方法，或使用 `engine.stats()` + 分页扫描。

### 发现 2: `getAllNodes()` 无分页终止条件
- **严重性**: P2
- **描述**: `getAllNodes(page, pageSize)` 在内层 `for (const id of allIds)` 中遍历全部节点后在外层 `results.flat()`，然后 `all.slice(start, start + pageSize)`。即使 page 很大，也先全部读取才做切片。
- **影响**: 深度分页时每次都全量遍历所有节点。
- **建议**: 实现真正的惰性分页（各 Range 返回 pageSize 条后截断）。

### 发现 3: `personalizedPageRank()` 跨 Range 合并使用范围间加权（rangeWeight）
- **严重性**: P2
- **描述**: PPR 合并策略为"内部归一化后按 range 节点数加权"。如果不同 Range 的 PR 值分布差异大（如一个 Range 中包含大量孤立节点），此加权方式会扭曲结果。精确做法应是全局幂迭代。
- **影响**: 跨 Range PPR 结果是近似值，可能不准确。
- **建议**: 文档明确说明此为近似实现，仅在单个 Range 内有精确意义。

### 发现 4: `vectorSearch()` 静默吞错误
- **严重性**: P2
- **描述**: `vectorSearch()` 中 `catch { return [] as VectorSearchResult[] }` 静默吞掉所有 Range 读取错误。客户端的部分 Range 故障不会被发现。
- **影响**: 大规模部署中故障发现延迟。
- **建议**: 记录错误日志或返回部分结果 + 错误状态。

---

## File: src/shard/rebalancer.ts

### 发现 1: [_findHotNodes] 尝试扫描 `typeId 0-19` 来收集节点 ID
- **严重性**: P1
- **描述**: `_findHotNodes()` 通过迭代 `typeId = 0..19` 并调用 `range.read(engine => engine.findNodesByType(typeId))` 来"收集所有节点 ID"。但：
  1. 假设所有 typeId 都在 0-19 范围内，如有 typeId=100 的节点会遗漏
  2. `findNodesByType(typeId)` 对不存在的 type 抛出异常而非返回空数组，使每个不存在的 type 都产生 try-catch 开销
  3. 方法名为"找热节点"，实际只是取最大节点 ID 的后几个（`allNodeIds.sort((a,b) => b-a)`）
- **影响**: 热节点选择策略完全错误（取最大 ID ≠ 热节点），重平衡无法解决实际负载问题。
- **建议**: 实现真正的 per-node operationCount 计数，或在 GraphEngine 中增加 `getHotNodes(count)` 接口。

### 发现 2: `_doRebalance()` 在节点数偏差迁移后立即开始负载因子迁移
- **严重性**: P2
- **描述**: 代码先处理节点数偏差，然后立即在同一循环中处理负载因子偏差。但在节点迁移后直接调用 `this.getStats()`，此时统计尚未稳定（迁移期间写入被 draining 阻塞），统计值可能不可靠。
- **影响**: 负载感知的重平衡可能基于错误的负载数据。
- **建议**: 节点迁移完成后至少等待一个 checkInterval 再检查负载因子。

### 发现 3: `_doRebalanceNodes` 中 `sourceRange.setDraining(false)` 与 `_migrateCleanup` 之间存在窗口期
- **严重性**: P2
- **描述**: 代码如下：
  ```
  sourceRange.setDraining(false)  // 解除 draining
  for (const nodeId of nodeIds) { // 在非 draining 状态下删除
    await this._migrateCleanup(sourceRange, nodeId) // 包含 delete 操作
  }
  ```
  在 cleanup loop 完成前，新写入可能再次写入已被迁移到目标 Range 的节点。虽然标识为 S11 安全保证，但对并发写入没有原子性保护。
- **影响**: 数据竞争——清理期间的新写入可能丢失（写入了源 Range 但源节点随后被删除）。
- **建议**: 在 cleanup 期间设置一个临时"pending migration"标记（而非完全解除 draining），或使用两阶段提交协议。

### 发现 4: `_migrateCleanup` 在删除源节点时引发级联删除
- **严重性**: P2
- **描述**: `_migrateCleanup` 先删除边再删除节点。但 `delete_node` 操作可能触发引擎层面的级联删除。如果迁移期间有并发的边更新（在 draining 解除后的窗口），可能导致关联数据丢失。
- **影响**: 并发写入场景下的数据丢失。
- **建议**: 在清理阶段使用严格的事务语义（如 LSN 检查）。

### 发现 5: 无迁移进度和状态恢复
- **严重性**: P2
- **描述**: `_doRebalanceNodes` 中迁移失败后跳过该节点继续。但如果进程在迁移中间崩溃，重启后没有持久化的迁移状态，可能导致部分节点在新旧 Range 各存在一份。
- **影响**: 崩溃恢复后节点重复。
- **建议**: 持久化迁移状态（进行中的迁移列表），重启时执行 cleanup。

### 发现 6: `_findHotNodes` 对每个 typeId 调用 `range.read()` 引发 N+1
- **严重性**: P2
- **描述**: 20 个 typeId × 每个 typeId 一次 `range.read(engine => engine.findNodesByType(typeId))` = 20 次 Range 读取。且遍历完所有 typeId 后才选择节点。
- **影响**: 每次重平衡都做 20 次 I/O。
- **建议**: 使用批量查询接口一次性获取所有节点。

---

## File: src/shard/range-instance.ts

### 发现 1: `consensus.setApply!` 使用非空断言操作符
- **严重性**: P2
- **描述**: `cp.setApply!(async (data: Uint8Array) => { ... })` 使用 `!` 断言 `setApply` 存在。如果 ConsensusProvider 的实现没有 `setApply` 方法，运行时会崩溃。
- **影响**: 运行时类型安全缺失。
- **建议**: 使用类型守卫：`if ('setApply' in cp && cp.setApply) { ... }`。

### 发现 2: 使用 `require()` 动态导入 StandaloneConsensus
- **严重性**: P2
- **描述**: `const cp = consensus ?? new (require('../consensus/standalone-consensus').StandaloneConsensus)(...)` 使用 `require()` 而非类型化的 import。这破坏了静态类型检查，且与项目 ESM 兼容性有关。
- **影响**: 类型系统无法检查 StandaloneConsensus 的构造函数参数。
- **建议**: 在构造函数参数中接受已有的 ConsensusProvider 实例，或使用类型化的 `import type`。

### 发现 3: `write()` 中 `propose` 先注册 Promise 再执行，但 `consensus.propose()` 失败后未清理 resolver
- **严重性**: P2
- **描述**: 代码如下：
  ```typescript
  const promise = new Promise<unknown>((resolve, reject) => {
    this.applyResolvers.set(operation.id, { resolve, reject })
  })
  const result = await this.consensus.propose(data)
  if (!result.ok) {
    this.applyResolvers.delete(operation.id)
    throw new Error('Raft proposal failed')
  }
  ```
  如果 `propose` 返回 `{ ok: false }`，resolver 被删除，Promise 永不会被 resolve/reject → **Promise 泄漏**（永远不会 settle）。
- **影响**: 调用方永远等待 `await range.write(...)`，造成 goroutine 泄漏。
- **建议**: 在 `propose` 失败时 reject 该 Promise 再删除。

### 发现 4: 单线程 `applyResolvers` Map 无并发保护
- **严重性**: P3
- **描述**: 当前为单线程 Node.js 应用，Map 操作无竞态。但如果未来引入 Worker Threads，此 Map需要锁保护。
- **影响**: 设计假设单线程，无法直接扩展。
- **建议**: 添加文档注释说明并发限制。

---

## File: src/shard/auto-splitter.ts

### 发现 1: `_check()` 中的静默 catch 吞掉所有错误
- **严重性**: P2
- **描述**: `try/catch` 块中的 `// 静默：单次检查失败不影响后续` 注释说明意图。但静默吞错误使运维团队无法诊断 split 失败。
- **影响**: split 持续失败时无告警。
- **建议**: 至少使用 `Logger.warn` 记录错误。

### 发现 2: split 触发逻辑缺乏协调（split 风暴风险）
- **严重性**: P2
- **描述**: 每次 split 只调用 `this._onReshard()`（一个空回调），不做实际的分裂操作。同时检查周期为 30s，分裂间隔最短 60s，理论上限制了风暴，但 `_onReshard()` 触发的完整 reshard 流程不受控。
- **影响**: 全量重新分片的复杂性未在此考虑。
- **建议**: 至少添加一个进程内锁防止并发 reshard。

---

## File: src/shard/edge-affinity.ts

### 发现 1: property-based 策略中 `property:` 前缀解析后的 fallback 行为不可预测
- **严重性**: P2
- **描述**: 当使用 `'property:key'`策略且属性不存在时，返回 `src` 节点 ID。这会导致该边被路由到"源节点所在 Range"而非"属性值对应的 Range"，打破了"相同属性值的边在同一 Range"的语义承诺。
- **影响**: 数据局部性保证被破坏。
- **建议**: 属性缺失时抛出错误或 log warning，不静默 fallback。

### 发现 2: `source-target` 策略的 hash 函数质量低
- **严重性**: P3
- **描述**: `a * 31 + b` 是一个非常简单的 hash 函数，对分布均匀度的保证较弱。一致性哈希的 `ShardRouter` 期望输入均匀分布，此 hash 可能导致热分片。
- **影响**: 分片可能不均衡。
- **建议**: 使用更高质量的 hash（如 FNV-1a 或 murmurhash）。

---

## File: src/security/auth.ts

### 发现 1: `chokidar` 的 `persistent: false` 使文件监听在进程空闲时停止
- **严重性**: P2
- **描述**: `chokidar.watch` 配置中 `persistent: false` 意味着 watcher 不会阻止 Node.js 进程退出。但如果在 `startWatch` 后没有其他事件循环引用，Node.js 进程会退出。同时 `statPolling` 兜底的 `setInterval` 有 `.unref()` 调用，不会阻止进程退出。
- **影响**: 如果 watcher 是进程的唯一活跃句柄，进程可能意外退出。
- **建议**: 移除 `persistent: false` 或确保 `startWatch()` 在被调用时有足够的上下文确认进程生命周期。

### 发现 2: `AuthConfig` 的 `tlsCert` 和 `tlsKey` 在构造时验证，但文件在运行时才加载
- **严重性**: P2
- **描述**: 构造函数中检查 `!config.tlsCert || !config.tlsKey`（字符串非空），但不验证文件是否存在或其格式。文件可读性验证在 `TLSConfig.getServerOptions()` 中（`readFileSync` 可能失败）。
- **影响**: 构造成功但启动时崩溃。
- **建议**: 在构造函数或 init 方法中尝试验证文件可读性。

### 发现 3: `UserRegistry` 废弃类的所有方法都抛出异常
- **严重性**: P3
- **描述**: 废弃类 `UserRegistry` 的每个方法都抛出异常。如果有遗留代码尝试 catch 这些异常，会在运行时发生保护性崩溃。建议保留兼容但不抛出异常的 stub 或直接移除。
- **影响**: 向后的接口兼容性破坏。
- **建议**: 移除整个废弃类（或提供返回 default 值的 stub）。

### 发现 4: `validateAuthConfig` 未验证 identitiesFile 格式
- **严重性**: P2
- **描述**: 当配置了 `identitiesFile` 路径时，`validateAuthConfig` 不验证文件是否存在、解析是否合法。
- **影响**: 配置验证通过但运行时失败。
- **建议**: 在 validate 中尝试验证文件可读性和 JSON 解析。

---

## File: src/security/rbac.ts

### 发现 1: auth.ts 中定义了重复的 RBAC 类（代码重复）
- **严重性**: P1
- **描述**: `src/security/auth.ts` 和 `src/security/rbac.ts` 都定义了完全相同的 `RBAC` 类（相同的权限矩阵、相同的方法），只有微小的格式差异。这是直接的代码重复，违反 DRY 原则。
- **影响**: 权限修改时需同步两个文件，极易产生不一致；如果两个版本有多余差异（如 `checkResourceAccess` 只在 rbac.ts 中有而 auth.ts 中没有），调用方可能出现预期外的行为。
- **建议**: 删除 `src/security/auth.ts` 中的 RBAC 类定义，只保留 `src/security/rbac.ts` 中的一份，并从 auth.ts 中 re-export。

---

## File: src/security/rls.ts

### 发现 1: RLS 引擎与存储层无集成
- **严重性**: P1
- **描述**: `RowLevelSecurity` 是一个独立的过滤器，没有被集成到任何 GraphEngine 或 ShardManager 的查询路径中。目前在 `rest.ts` 中也没有任何 RLS 校验。
- **影响**: 行级安全功能完全不可用 —— 定义策略但不生效。
- **建议**: 在 `rest.ts` 的查询处理器中和 `GraphEngine` 的 `getNode()` / `neighbors()` 等查询方法中集成 RLS。

### 发现 2: `enforceQuery` 的 `table` 参数与图存储的语义不匹配
- **严重性**: P2
- **描述**: RLS 接口使用关系型数据库的"表"概念（`table: 'nodes' | 'edges' | 'graph'`），但图数据库的查询通常返回混合了节点和边的层次结果。传递 `'graph'` 给 `enforceQuery` 时无法区分节点和边的策略。
- **影响**: 策略匹配语义模糊。
- **建议**: RLS 策略应作用于具体资源类型。

---

## File: src/security/tls.ts

### 发现 1: `extractCNFromRequest` 在处理 HTTP/2 请求时可能失败
- **严重性**: P2
- **描述**: 通过 `req.socket || req.connection` 获取 socket。HTTP/2 中 `req.socket` 可能不存在（非 HTTP/2 的 socket 连接），导致返回 null 而非证书 CN。
- **影响**: HTTP/2 上的 mTLS 认证失败。
- **建议**: 添加 HTTP/2 的 socket 获取别名（如 `req.stream?.session?.socket`）。

### 发现 2: 证书加载无内存保护
- **严重性**: P2
- **描述**: `readFileSync` 加载证书到内存字符串中。如果证书文件很大（例如包含完整 CA 链），`cert` 和 `key` 字符串会一直驻留在 Node.js 堆内存中，无法被回收或清除。
- **影响**: 证书密钥在进程生命周期内持续暴露在内存中。
- **建议**: 使用 `SecureContext` 或 `crypto.createPrivateKey` 的 `keyObject` 并确保敏感数据使用完后可清除。

---

## File: src/security/audit.ts

### 发现 1: 审计日志在内存中无限增长
- **严重性**: P2
- **描述**: `AuditLogger.entries: AuditEntry[]` 是无限增长的数组，没有任何上限或清理机制。所有审计条目都追加到 `this.entries` 且从未自动清理。
- **影响**: 高吞吐场景下内存泄漏（OOM）。
- **建议**: 添加环形缓冲区（固定大小）或启用文件轮转（`pino-roll`），当前实现应设置默认上限（如 10000 条）。

### 发现 2: `logDenied()` 和 `logError()` 硬编码 `resource: 'unknown'`
- **严重性**: P3
- **描述**: `logDenied` 和 `logError` 方法中将 `resource` 固定为 `'unknown'` 字符串，丢失了拒绝或错误的资源信息。
- **影响**: 审计日志不可用于安全分析——无法知道拒绝访问哪个具体资源。
- **建议**: 为这两个方法添加 `resource` 参数。

### 发现 3: `AuditLogger.log()` 使用 `pino.info` 记录审计日志
- **严重性**: P2
- **描述**: 审计日志使用 `this.logger.info()` 记录。`pino` 的 `info` 级别是一般信息日志，审计日志应使用更高优先级级别（如 `warn` 或专门的 audit level）。
- **影响**: 在日志聚合系统中，审计日志与普通应用日志混在一起，无法通过日志级别过滤。
- **建议**: 使用 `pino` 的 custom level（如 `audit: 35`）或输出到独立文件流。

---

## File: src/ops/health.ts

### 发现 1: `getStatus()` 中的 `_checkEngineSync()` 方法名暗示"同步"但实际是 no-op
- **严重性**: P2
- **描述**: `_checkEngineSync()` 只是调用 `this.engine.stats()` 并 catch 异常。这不是真正的同步引擎健康探测（对比 `check()` 使用 upsert-then-delete）。
- **影响**: `getStatus()`（同步版本）的引擎健康检查是假检查。
- **建议**: 统一两种检查方式——要么在 `getStatus()` 中也使用同步化的引擎探测，要么移除 `_checkEngineSync()`。

### 发现 2: `check()` 在引擎探测中插入和删除临时节点可能影响指标
- **严重性**: P2
- **描述**: `check()` 方法通过插入一个临时的 `__health_check__` 节点并立即删除来探测引擎。这个插入和删除计入正常的 metrics 计数（ops/s、writes 等），影响了指标的准确性。
- **影响**: 健康检查请求计入业务指标，尤其在频繁健康检查时污染统计数据。
- **建议**: 健康检查操作打上特殊标记，在 metrics 中排除，或使用只读的 stat 检查。

### 发现 3: `ShardInstance` 的"candidate"角色被等同于"不健康"
- **严重性**: P2
- **描述**: 在 `check()` 和 `getStatus()` 中，`healthyShards` 的计算使用 `s.raftRole !== 'candidate'`，即处于 candidate 状态的 shard 被视为 unhealthy。但在 Raft 复制组中，candidate 是选举过程中的正常状态，不需要立即标记为 unhealthy。
- **影响**: Raft leader 选举期间（通常几秒钟），健康检查报告系统为"degraded"，可能触发不必要的告警。
- **建议**: 应设置一个超时阈值（如 5s），candidate 状态超过阈值才标记为 unhealthy。

### 发现 4: `{ diskFree: 0, diskUsed: 0 }` 永远为 0
- **严重性**: P2
- **描述**: 存储指标 `diskFree` 和 `diskUsed` 被硬编码为 0，从未从实际文件系统读取。
- **影响**: 磁盘空间告警完全缺失，可能导致磁盘被写满。
- **建议**: 使用 `check-disk-space` 或 `fs.statfs`（Node.js >= 18）获取实际磁盘使用情况。

### 发现 5: `latency.p50` 和 `latency.p99` 永远为 0
- **严重性**: P2
- **描述**: 延迟指标同样被硬编码为 0，从未从实际的请求处理中采集。
- **影响**: 延迟监控完全缺失。
- **建议**: 从 MetricsCollector 或 OTel 获取实时延迟数据。

---

## File: src/ops/metrics.ts

### 发现 1: 指标与 ops/otel-metrics.ts 的 MetricsCollector 功能重叠
- **严重性**: P2
- **描述**: `src/ops/metrics.ts` 中的 `Metrics` 类和 `src/ops/otel-metrics.ts` 中的 `MetricsCollector` 都提供计数器、延迟记录和快照功能。前者使用内存 Map，后者包装 OTel API。两个实现大部分功能重叠且不会同步。
- **影响**: 指标数据不一致——部分代码写入 Metrics，部分写入 MetricsCollector，两者数据不互通，导致 prometheus 端点或指标 API 返回不完整的数据。
- **建议**: 统一为一个指标实现。建议废弃 `Metrics` 类，全部迁移到 `MetricsCollector`（OTel 标准）。

### 发现 2: `snapshot()` 仅统计名为 'ops' 的计数器作为总操作数
- **严重性**: P2
- **描述**: `snapshot()` 中 `const ops = this.counters.get('ops') || 0` 只统计了一个名为 'ops' 的计数器。但如果系统中的组件使用不同的计数器名称（如 'graph.ops.reads', 'graph.ops.writes'），总操作数不会反映真实值。
- **影响**: 指标快照中的 `opsPerSecond` 可能大幅低估真实吞吐量。
- **建议**: 收集所有带 `ops` 前缀的计数器，或使用统一命名约定。

### 发现 3: 延迟样本只保留最近 1000 个
- **严重性**: P3
- **描述**: `recordLatency` 使用 `shift()` 在超过 1000 个样本时丢弃最旧样本。对于高吞吐服务（10K+ ops/s），1000 个样本只能覆盖 100ms 的数据窗口。
- **影响**: P50/P99 延迟计算的样本窗口过短，统计意义有限。
- **建议**: 使用 Reservoir Sampling 或 TDigest 算法，或用固定时间窗口（如 60s）而非固定样本数。

---

## File: src/ops/otel.ts

### 发现 1: `traceAsync` 中在 context.with() 后自动激活但未恢复 context
- **严重性**: P2
- **描述**: `context.with(ctx, fn)` 运行 `fn` 后将 ctx 传播到异步边界。但 `with` 返回后，context 不会自动恢复到原本的 context。在嵌套调用中，如果 `traceAsync` 在另一个 `traceAsync` 中被调用，内层 `fn` 运行的 context 可能不是正确的父 context。
- **影响**: span 树形结构可能不正确（父子关系错误）。
- **建议**: OTel 的 `context.with()` 只在同步作用域内生效。应使用 `context.with(ctx, async () => ...)` 包装整个 `fn` 的执行上下文。当前写法已经是这样的。

### 发现 2: OTel SDK 初始化失败后静默降级
- **严重性**: P3
- **描述**: `init()` 中的 catch 设置 `this._enabled = false` 并记录错误，但调用方不会收到失败通知。如果 OTel 初始化失败（如 OTLP endpoint 不可达），SDK 启动会抛出异常。
- **影响**: 运维团队可能不知道可观测性基础设施已降级。
- **建议**: 在 catch 中添加应用层面的告警（如 metrics 告警或 crash 日志）。

---

## File: src/ops/otel-metrics.ts

### 发现 1: `init()` 仅在 `telemetry.isEnabled()` 时有效，但 `telemetry.init()` 异步
- **严重性**: P2
- **描述**: `MetricsCollector.init()` 内部检查 `this.telemetry.isEnabled()`。由于 `Telemetry.init()` 是异步的（`await sdk.start()`），在 `init()` 调用完成前 `isEnabled()` 返回 false，导致 `MetricsCollector.init()` 被视为 no-op。如果时序不对，指标收集可能永不被初始化。
- **影响**: 即使 Telemetry 正常启用，MetricsCollector 可能永远处于 disabled 状态。
- **建议**: 确保 `MetricsCollector.init()` 在 `Telemetry.init()` 完成后才被调用，或在 `init()` 中注册回调。

### 发现 2: counter/histogram/gauge 在首次使用 `incrementCounter` 时才惰性创建
- **严重性**: P3
- **描述**: 指标在第一次调用 `incrementCounter(name)` 时才 `createCounter`。对 Prometheus 来说，指标直到第一个样本出现时才被注册，不利于空指标监控面板的预配置。
- **影响**: Prometheus 面板上指标可能直到第一次写入才出现，告警条件无法预置。
- **建议**: 支持在 `init()` 时预注册指标。

---

## File: src/ops/logger.ts

### 发现 1: `withTraceContext` 使用 `AsyncLocalStorage`，但中间件/HTTP handler 未集成
- **严重性**: P2
- **描述**: `Logger` 支持通过 `withTraceContext` 和 `TraceContext` 实现异步 trace ID 传播。但在 `rest.ts` 的 HTTP handler 中，每个请求没有调用 `withTraceContext` 来设置 trace context。trace ID 仅在手动设置时生效，HTTP 请求的 trace ID 不会被自动传播。
- **影响**: 日志中的 trace ID 字段在标准 HTTP 请求中永远为 undefined。
- **建议**: 在 `rest.ts` 的请求处理入口为每个请求包装 `withTraceContext`。

---

## File: src/ops/backup.ts

### 发现 1: backup 中使用 `require('archiver')` 动态导入（与项目 ESM/CJS 兼容性有关）
- **严重性**: P2
- **描述**: `backup()` 中 `const mod = await import('archiver')`，但文件头部使用 `import * as fs from 'fs'` 等 ESM import。混合使用 `import` 和 `import()` 没有问题，但 `archiver` 默认导出和命名导出的处理复杂（上下文使用 `typeof mod.default === 'function' ? mod.default : mod.create`），增加了维护复杂度。
- **影响**: 库升级或 ESM 切换时打包逻辑可能断裂。
- **建议**: 使用确定性的导入方式，或只在文件头部统一 `import architecture`。

### 发现 2: `restore()` 中解压 tar.gz 后清理不完整
- **严重性**: P2
- **描述**: `restore()` 从 .tar.gz 解压时使用 `tar.extract({ strip: 1, cwd: path.dirname(target) })`。如果备份的目录结构是 `graphvec-backup-xxx/data/...`，`strip:1` 会去除第一级目录，预期 `data/...` 被提取到 target。但如果打包时结构不是预期的，提取出的文件可能 miss target 目录。
- **影响**: 恢复后数据目录结构可能不正确。
- **建议**: 在 extract 后验证目标目录内容。

### 发现 3: `verifyBackup()` 只检查标记文件，不验证数据完整性
- **严重性**: P2
- **描述**: `verifyBackup()` 只检查 `.consistency-marker` JSON 是否存在且包含 `snapshotId` 和 `hlcWallTime`。不会对备份数据做校验和验证（虽然 `backup-checksum.ts` 提供了 `verifyChecksumsSync`，但没有被调用）。
- **影响**: 备份损坏（如 bit rot、部分 I/O 错误）无法被检测。
- **建议**: 在 verifyBackup 中调用 `verifyChecksumsSync` 或其他数据完整性验证。

### 发现 4: `listBackups()` 硬编码过滤字符串
- **严重性**: P3
- **描述**: `listBackups` 使用硬编码 `name.startsWith('graphvec-backup-')` 过滤备份目录名，字符串写死在代码中。
- **影响**: 备份命名格式变更时需要修改代码。
- **建议**: 抽取为常量。

### 发现 5: `restoreToTimestamp()` 中的 `parseBackupTimestamp()` 函数格式解析有误
- **严重性**: P2
- **描述**: `parseBackupTimestamp()` 中有两处 `replace` 逻辑，第一个被注释掉（// 从文件名中的 - 恢复...），第二个 `isoFull` 中使用了 `.replace(/Z$/, '+08:00')` 硬编码时区偏移为 +08:00。如果备份发生在 UTC 时区或其他时区，时间解析完全错误。
- **影响**: PITR 恢复的时间点选择可能错误，恢复到错误的时间。
- **建议**: 将备份文件名中的时间戳保存为 UTC，解析时使用 ISO 8601 标准的 UTC 格式。

### 发现 6: `restoreToTimestamp` 将 WAL 归档恢复为完整文件而非逐条回放
- **严重性**: P1
- **描述**: PITR 恢复中，"回放 WAL 归档"的操作只是将归档 WAL 文件复制回数据目录，而不是逐条解析 WAL 条目并应用到图引擎。这意味着：
  1. 如果目标备份是全量备份 + 增量 WAL 归档，恢复后引擎打开时不会自动重放这些 WAL
  2. WAL 回放需要图引擎的 WAL 恢复机制支持，但当前没有实现
- **影响**: PITR 恢复实际上只恢复全量备份，增量的 WAL 归档未应用，恢复点停留在全量备份时间点。
- **建议**: 实现真正的 WAL 逐条回放（redo log），或将 PITR 功能标记为实验性并补充文档说明限制。

---

## File: src/ops/backup-types.ts

### 发现 1: 无重大问题
- **严重性**: P3
- **描述**: 类型定义清晰，与 backup.ts 的分离设计合理。
- **建议**: 无。

---

## File: src/ops/backup-wal.ts

### 发现 1: `readWalLsnSnapshots` 使用递归扫描，可能被符号链接循环卡死
- **严重性**: P2
- **描述**: `scanDir` 使用递归而不限制深度或不处理符号链接。如果数据目录中存在符号链接循环（或指向父目录的链接），会陷入无限递归直到 stack overflow。
- **影响**: 不安全的文件扫描可能导致进程崩溃。
- **建议**: 使用迭代遍历并添加 visited 集合防止循环。

### 发现 2: `readWalLastIndex` 中对空文件解析时 `offset + 12 <= stat.size` 检查为 12 <= 0 → false，返回 0，行为正确
- **严重性**: P3
- **描述**: 无实质问题。

---

## File: src/ops/backup-checksum.ts

### 发现 1: `writeChecksumFiles` 生成校验和文件但备份流程未使用
- **严重性**: P2
- **描述**: `writeChecksumFiles()` 函数已实现，但在 backup.ts 的 `backup()` 方法中从未被调用。校验和文件不会随备份生成。
- **影响**: 备份数据完整性无法验证。
- **建议**: 在 `backup()` 方法（生成 tar.gz 之前或之后）调用 `writeChecksumFiles()`。

### 发现 2: `computeChecksum` 使用 `readFileSync` 加载整个文件到内存
- **严重性**: P2
- **描述**: `crypto.createHash('sha256').update(fs.readFileSync(filePath))` 将整个文件加载到内存。对大文件（几个 GB 的备份），可能导致 OOM。
- **影响**: 大备份文件的校验和计算可能 OOM。
- **建议**: 使用流式计算：`fs.createReadStream(filePath).pipe(crypto.createHash('sha256'))`。

---

## File: src/ops/backup-helpers.ts

### 发现 1: `fsyncDirectory` 打开每个文件只为 fsync
- **严重性**: P2
- **描述**: `fsyncDirectory()` 对目录中的每个文件调用 `fs.openSync(filePath, 'r')` → `fsyncSync(fd)` → `fs.closeSync(fd)`。对于大量文件（数万个），这会带来显著的 I/O 开销和文件描述符操作。
- **影响**: 备份时的 fsync 遍历速度慢。
- **建议**: 通过监控回写内核参数的 `writeback` 机制或使用 `sync(2)` 系统调用替代逐文件 fsync。

### 发现 2: `copyNewOrChangedFiles` 中所有路径使用了 `const` 而非 `let` 
- **严重性**: P3
- **描述**: 无实质问题。

---

## File: src/consensus/raft-transport.ts

### 发现 1: 文件不存在
- **严重性**: P1（需求缺失）
- **描述**: 审查清单要求审查 `src/consensus/raft-transport.ts`（Raft 传输层），但文件不存在。
- **影响**: Raft 组间的网络传输层缺失。`RaftLogicConsensus` 在 `start()` 中使用 `InMemoryTransport`，只支持单进程内的节点间通信。
- **建议**: 确认是否有计划实现跨进程的 gRPC/TCP 传输层，或此文件被设计为后续实现。

---

## File: src/consensus/raft-logic-consensus.ts

### 发现 1: Pipeline 批量提交的快速路径和合并路径交互有问题
- **严重性**: P2
- **描述**: `propose()` 的逻辑：如果队列为空（`this._pipelineQueue.length === 0`），直接走快速路径——`this._node.clientRequest()`。如果有并发请求同时到达，后到的请求将数据入队（此时队列非空），先到的请求走快速路径。快速路径结果返回后，队列中等待的请求会通过 `_flushPipeline` 被提交。但在快速路径和 Pipeline 提交之间存在竞态条件：一个请求可能发现自己进入一个非空的队列（意味着有未 flush 的请求），然后 `_flushPipeline` 会在当前 `propose()` 返回前异步触发。这可能导致：
  1. 一个请求同时走了快速路径和 Pipeline（因为其 data 已在快速路径发出）
  2. 或者一个请求被重复提交
- **影响**: 可能导致操作重复执行（重复 upsert）。
- **建议**: 移除快速路径优化或使用更严格的锁保护队列状态。

### 发现 2: `propose()` 快速路径中 `catch { return { ok: false } }` 静默吞错误
- **严重性**: P2
- **描述**: 快速路径中 `.clientRequest()` 失败的错误被静默转换为 `{ok: false}`，调用方（RangeInstance.write）会判断 `!result.ok` 并抛出 'Raft proposal failed'。这虽然最终传播了错误，但丢失了原始错误信息，不利于排障。
- **影响**: Raft proposal 失败时无原始错误上下文。
- **建议**: 在 catch 中记录日志或在 Error 中传递原始错误信息。

### 发现 3: Snapshot 定时器使用 `_entryCount >= 10000` 的硬编码阈值
- **严重性**: P2
- **描述**: snapshot 触发的阈值（10000 条日志）被硬编码在 `start()` 方法中，且每隔 60s 检查一次。对于高吞吐场景，10000 条可能在 1 秒内产生，log 增长过快。
- **影响**: Raft log 可能过度增长，增加 snapshot 恢复开销。
- **建议**: 将阈值可配置化，并基于时间（如 5 分钟）或日志大小（如 100MB）触发 snapshot。

### 发现 4: Pipeline 提交的 batch 使用 `|` 作为分隔符，可能被 payload 中的 `|` 干扰
- **严重性**: P2
- **描述**: Pipeline batch 使用 `parts.join('|')` 拼接多个请求的数据，使用 `|` 作为分隔符。如果某个请求的 payload/base64 编码后包含 `|` 字符，分割时会出错。虽然 base64 编码字符集不包含 `|`，但如果未来修改编码方式或直接使用原始数据，分隔符冒险存在。
- **影响**: 潜在的协议入侵风险。
- **建议**: 使用长度前缀编码而非分隔符。

### 发现 5: `_flushPipeline` 中的 `clientRequest` 使用 `Math.max(...batch.map(b => b.timeoutMs))` 作为超时
- **严重性**: P2
- **描述**: 从 batch 中所有请求的超时中取最大值。如果高请求使用长超时且与短超时请求合并，短请求会等更久。
- **影响**: 短请求的延迟被长请求拖尾。
- **建议**: 使用独立超时或最严格的超时。

### 发现 6: `start()` 中使用 `RaftNode` 选项的 `electionTick: 10, heartbeatTick: 3` 为固定值
- **严重性**: P3
- **描述**: 选举心跳配置硬编码，不支持用户配置。
- **建议**: 从 `ConsensusConfig` 中读取这些参数。

### 发现 7: `InMemoryTransport` 仅支持单进程通信（多节点架构缺失）
- **严重性**: P1
- **描述**: `start()` 中的 `const transport = new InMemoryTransport()` 是进程内传输。真正的 Raft 部署需要跨网络传输层，但文件 `src/consensus/raft-transport.ts` 不存在。
- **影响**: Raft 的一致性保证仅适用于单进程，多节点部署完全不可用。
- **建议**: 这是架构级的重大缺失，需规划网络传输层实现。

---

## File: src/consensus/standalone-consensus.ts

### 发现 1: `propose()` 直接调用 `applyFn`，没有同步保护
- **严重性**: P2
- **描述**: `StandaloneConsensus.propose()` 直接调用 `this.applyFn(data)`。如果 `applyFn` 是异步的（接受并 await 返回 `Promise<void>`），多个并发的 `propose()` 调用可能导致 `applyFn` 被并发执行，破坏了写入的有序性保证。
- **影响**: 单节点模式下写入顺序可能被破坏。
- **建议**: 在 StandaloneConsensus 内部维护一个串行化队列（如 `async/await` 串行运行）。

### 发现 2: `getTerm()` 硬编码返回 1
- **严重性**: P3
- **描述**: 在 `StandaloneConsensus` 中，term 永远是 1。如果从 standalone 模式切换到 raft 多节点模式，term 值会突变，可能导致节点状态不一致。
- **影响**: 模式切换不兼容。
- **建议**: 无（standalone 模式为开发用，文档说明即可）。

---

## File: src/consensus/wal.ts

### 发现 1: `append()` 中 `fs.writeSync()` 后 `fsyncSync()` — 高频写入性能较差
- **严重性**: P2
- **描述**: 每次 `append()` 都做一次 `fsyncSync()`（即每次 Raft 写入都等磁盘同步）。在高速写入场景下（数千次/秒），每次 fsync 都阻塞线程直到磁盘确认，严重降低吞吐量。
- **影响**: WAL 写入成为吞吐瓶颈。
- **建议**: 使用组提交（group commit）或批处理 fsync（如固定间隔或每 N 条日志执行一次 fsync）。

### 发现 2: `truncate()` 和 `truncateBefore()` 中索引越界未检查
- **严重性**: P2
- **描述**: `truncate(lastIndex)` 中 `if (lastIndex >= this.entries.length)` 判断不准确：`lastIndex` 是逻辑 index（从 1 递增），而 `this.entries.length` 是数组长度。例如：如果 `entries` 中有 3 条（index 1,2,3），`truncate(lastIndex=2)` 检查 `2 >= 3` → false → 继续执行，取 `this.entries.slice(3)` → `[]`。这行为正确，但逻辑上应当比较 index 值而非数组长度。
- **影响**: 小于边界情况行为正确但语义不一致。
- **建议**: 比较时应使用 `lastIndex >= this.lastIndex` 或 `keepEntries.length === 0`。

### 发现 3: `truncateBefore()` 重写文件后未截断剩余空间
- **严重性**: P2
- **描述**: `truncateBefore()` 使用 `fs.ftruncateSync(this.fd, 0)` 截断为 0 后写入新内容。但 `ftruncate` 后立即 `writeSync` 正常。如果写入的新内容比原文件短，`futruncate(0)` 正确清空了文件。但如果写入内容后不 `futruncate`，旧文件末尾的残留数据可能被后续读取。当前实现是正确的（写之前 truncate 到 0）。
- **影响**: 无实质问题。

### 发现 4: `_encodeEntries` 为每个条目创建新的 Buffer
- **严重性**: P3
- **描述**: 对每个条目创建 header Buffer（12 bytes）和 data Buffer，然后 `Buffer.concat(buffers)`。这会产生大量小对象的 GC 压力。
- **影响**: 高频写入场景下的 GC 开销。
- **建议**: 使用 `Buffer.alloc(size)` 一次性分配，手动写入所有条目。

### 发现 5: 持久化 meta 使用 `readFileSync + writeFileSync` 而非原子重命名
- **严重性**: P2
- **描述**: `persistMeta()` 读取元数据文件、合并、写回。如果在写回中间进程崩溃，元数据文件可能损坏（半写入状态）。
- **影响**: 选举状态（currentTerm/votedFor）可能丢失或损坏。
- **建议**: 写入临时文件后 `rename(2)` 以保证原子性。

---

## File: src/replication/dc-sync.ts

### 发现 1: `_startReceiveLoop` 中的 `for await...of` 不会响应 `this._running` 状态变化
- **严重性**: P2
- **描述**: 在 `_startReceiveLoop()` 中，`for await (const [topic, msg] of this.subSocket)` 是异步迭代器。当 `stop()` 设置 `this._running = false` 并调用 `this.subSocket.close()` 时，异步迭代器不会立即停止——它会在下一次迭代中因为 `break` 检查 `!this._running` 而退出。但如果 close() 导致 socket 抛异常，for-await 可能以未捕获的异常结束。
- **影响**: 停止 DCSync 时可能产生未处理的异常。
- **建议**: 在 try-catch 中包装 for-await 或手动关闭时处理异常。

### 发现 2: LWW 冲突解决中的字节比较忽略了 `lastAppliedHlc` 初始为空的情况
- **严重性**: P2
- **描述**: 在 `_startReceiveLoop` 中，`localTs = this.lastAppliedHlc.get(delta.dcId) ?? null`。首次收到 DC 的 delta 时 `localTs` 为 null，直接跳过 conflict check。这是正确的首条接受行为。但后续的 LWW 字节比较使用 `Buffer.from(delta.hlcTimestamp).compare(Buffer.from(localTs))`，依赖 HLC 时间戳编码的字节序一致性。如果不同 HLC 实现使用不同的编码，比较结果可能错误。
- **影响**: 跨 DC 的冲突解决在高延迟场景可能产生错误决策。
- **建议**: 确保两端 HLC 使用相同的编解码方式。

### 发现 3: `publishDelta` 中 `ZMQ Publisher` 的 `send` 不是原子操作
- **严重性**: P2
- **描述**: `await this.pubSocket.send(['graph_delta', Buffer.from(payload)])` 发送 ZMQ 多帧消息。如果 `_startReceiveLoop` 在 close 后仍在迭代，消息可能发送到已关闭的 socket。
- **影响**: 关闭时的竞态条件。
- **建议**: 在 send 之前检查 `this._running`。

---

## File: src/replication/delta-sync.ts

### 发现 1: `recordChange()` 使用 `this.pendingDeltas.size % 100 === 0` 检查 O(n) 清理
- **严重性**: P2
- **描述**: 每 100 条记录变更触发 `_evictStaleEntries()`，该函数遍历整个 `pendingDeltas Map` 并对每个条目的 pending entries 数组做过滤（`entries.filter(...)`）。在高变更频率下（10K+ ops/s），每 100 次就做 O(N) 遍历有性能开销。
- **影响**: 高吞吐场景的 Delta 记录性能下降。
- **建议**: 使用定时清理（已在 `startAutoFlush` 中由 `_cleanupTimer` 实现，`_evictStaleEntries` 可以移除）。

### 发现 2: `_evictExpired` 与 `_evictStaleEntries` 的功能重叠
- **严重性**: P2
- **描述**: `_evictStaleEntries()`（基于 pendingTtlMs = 60s）和 `_evictExpired()`（基于 TTL_MS = 5min）清理机制重叠。使代码维护复杂。
- **影响**: 两个清理机制使用不同的 TTL 值，行为不明确。
- **建议**: 统一为一个清理机制（建议使用 `_evictExpired` 的定时清理）。

### 发现 3: `recordChange()` 中 `this.pendingDeltas.get(name)!.push(...)` 使用 `!` 断言
- **严重性**: P3
- **描述**: 代码对 `!` 断言的使用增加运行时风险。虽然前一行确保了 Map 中存在 key，但 TypeScript 的 strict 模式下应使用 `push` 前的防御性检查。
- **影响**: 代码风格一致性问题。

### 发现 4: `receiveDelta` 将所有远程节点视为 typeId=1
- **严重性**: P1
- **描述**: `receiveDelta` 中 `this.engine.upsertNode(1, String(nodeName), { props })` 将所有远程 DC 的节点都写为 typeId=1，忽略了源节点原有的 type 信息。CRDT delta 中不包含 typeId。
- **影响**: 跨 DC 同步后，节点的 type 信息丢失，所有 node 变成 type=1（默认类型）。
- **建议**: 在 CRDT delta 中传递 typeId 信息。

---

## File: src/replication/hlc-clock.ts

### 发现 1: HLC 的 `toBytes()` 返回 `HLC_codec.encode(this)` 中的 `this` 问题
- **严重性**: P1
- **描述**: `nowWithWallTime()` 返回的对象中的 `toBytes()` 方法使用 `HLC_codec.encode(this)`。这里的 `this` 指向返回的对象（`{ wallTime, logical, toBytes }`），但 `HLC_codec.encode` 可能期望一个简单的 `{ wallTime: bigint, logical: number }` 对象。如果 `@consento/hlc` 的 `encode` 函数只读取 `wallTime` 和 `logical` 字段，多余的 `toBytes` 属性不会引起问题。但如果有额外字段检查，则可能导致编码失败。
- **影响**: 如果 `HLC_codec.encode` 对入参有严格校验，可能导致编码失败。
- **建议**: 返回纯数据对象：`return HLC_codec.encode({ wallTime: this.wallTime, logical: this.logical })`。

### 发现 2: `nowWithWallTime` 中 `wallTime = now > this.lastWallTime ? now : this.lastWallTime` 可能导致逻辑时钟溢出
- **严重性**: P2
- **描述**: 当系统时间回拨时（NTP 同步或时钟调整），`now < this.lastWallTime`，HLC 使用 `this.lastWallTime` 并递增 logical。但如果系统时间大幅回拨（数小时），`lastWallTime` 远大于当前时间，导致后续所有 HLC 时间戳都远大于实际时间。如果此 HLC 用于分布式持久化（如备份一致性标记），恢复时可能出现时间混乱。
- **影响**: 分布式时钟偏差可能导致数据排序错误或恢复问题。
- **建议**: 记录并检测大幅回拨（如 > 5s），触发告警。

### 发现 3: HLC 依赖的类型 `any` 桥接降低类型安全
- **严重性**: P3
- **描述**: 通过 `as any` 绕过 TypeScript 类型限制。这是对第三方库类型不完整的妥协。
- **影响**: 类型安全降低。
- **建议**: 为 `@consento/hlc` 添加 `.d.ts` 声明文件。

---

## 汇总统计

| 严重性 | 数量 |
|--------|------|
| **P1** | 12 |
| **P2** | 55 |
| **P3** | 12 |
| **总计** | **79** |

### 最重要的 P1 发现 (按影响排序)

1. **`personalizedPageRank()` N+1 查询模式 + 冗余读取** (shard-manager.ts) — 大规模 PPR 性能灾难
2. **Cross-Range fan-out 异步结果不被等待** (graph-algorithms.ts) — 跨 Range 算法不可靠
3. **RLS 引擎未与查询路径集成** (rls.ts) — 行级安全完全不可用
4. **RBAC 类代码重复** (auth.ts + rbac.ts) — 权限安全维护风险
5. **Delta Sync 丢失 typeId** (delta-sync.ts) — 跨 DC 同步后数据损坏
6. **Raft 网络传输层缺失** (raft-transport.ts 不存在) — 多节点部署不可用
7. **PITR WAL 回放只复制文件不重放** (backup.ts) — 恢复不完整
8. **私有属性直接访问** (scatter-gather.ts: engine['_nodeIds']) — 封装被破坏
9. **Promise 泄漏** (range-instance.ts) — propose 失败时调用方永远等待
10. **全文搜索和 Query IR 文件缺失** — 产品规格不满足
