# AgentiX GraphVec 竞品深度对比报告 v2.0

> 审计日期: 2026-05-29
> 代码基: git HEAD `5dd9cb16`, 173 源文件, ~50K 总行
> 审计人: Senior Distributed Systems Architect

---

## 目录

1. [图存储引擎](#1-图存储引擎)
2. [查询语言 & 查询执行](#2-查询语言--查询执行)
3. [分布式共识 & 复制](#3-分布式共识--复制)
4. [存储引擎](#4-存储引擎)
5. [分片 & 弹性](#5-分片--弹性)
6. [运维 & 安全](#6-运维--安全)
7. [API & 集成](#7-api--集成)
8. [综合差距清单与优先级排序](#8-综合差距清单与优先级排序)

---

## 1. 图存储引擎

### 1.1 存储模型

| 维度 | GraphVec | Neo4j v5 | Dgraph | ArangoDB | JanusGraph |
|------|----------|----------|--------|----------|------------|
| **模型** | Labeled Property Graph | Labeled Property Graph | RDF-like (三元组) + GraphQL± | 多模型 (文档/图/KV) | Property Graph |
| **原生图** | 🟡 半原生 — OverGraph 内存图 + LMDB 持久化 | ✅ 原生 Bolt 固定大小 record store | ❌ Badger LSM-tree KV 之上 | ❌ 文档后端之上 | ❌ 外部存储后端之上 |
| **邻接表** | ✅ 默认邻接表 (OverGraph) | ✅ 双向邻接 (skip list) | ❌ 谓词索引 | ❌ 边缘集合索引 | ✅ Gremlin 遍历机 |

**关键发现**:

GraphVec 通过 OverGraph 实现了**半原生图存储**，底层仍依赖 OverGraph 的内存图引擎 + LMDB 持久化。这比 Neo4j 的 Bolt 原生存储（固定大小记录 + 直接文件 I/O）的磁盘效率低。

OverGraph 使用邻接表，对关系型遍历友好，但缺乏 Neo4j 的压缩位图位索引（Compressed Bitmap）。

### 1.2 图遍历性能 — 代码级分析

**文件**: `src/core/graph-engine.ts`
- `neighbors()` 方法已有 LRU Cache（graph-engine.ts L57-143），支持 per-entry TTL
- 但不支持批量邻居预取（batchNeighbors）
- BFS/DFS 无专用实现 — 仅通过 OverGraph 的邻接遍历隐式实现

**文件**: `src/algorithms/`
- Louvain: ✅ 实现完整（`louvain.ts` ~140 行），O(E log V)
- Betweenness Centrality: ✅ 实现完整（`betweenness.ts`）
- MST: ✅ 实现完整（`mst.ts`）
- Dinic Max-Flow: ✅ 实现完整（`dinic-flow.ts`）
- **缺失**: PageRank, BFS, DFS, Dijkstra, A*, Triangle Counting, Clustering Coefficient

**对比 JanusGraph**：
JanusGraph 通过 Gremlin OLTP/OLAP 遍历机支持几乎所有图算法 GraphVec 在此维度有显著差距。

### 1.3 ACID vs BASE

| 维度 | GraphVec | Neo4j | Dgraph | ArangoDB | JanusGraph |
|------|----------|-------|--------|----------|------------|
| **模型** | ACID (单节点) + 最终一致 (跨 DC) | ACID (因果集群) | ACID (单 alpha) + 最终一致 (集群) | ACID (单节点/集群) | ACID (依赖后端) |
| **MVCC** | ❌ 无 — 简单事务管理器 `src/core/transaction.ts` | ✅ 完整 MVCC | ✅ Snapshot Isolation | ✅ WAL + MVCC | ✅ 后端决定 |
| **隔离级别** | 🟡 仅乐观锁 | SERIALIZABLE | SNAPSHOT ISOLATION | SERIALIZABLE | READ_COMMITTED |

**文件**: `src/core/transaction.ts` (146 行)
- 实现非常轻量：内存写集缓存 + commit 时 flush 到 engine
- 冲突检测：基于节点 ID 的写集碰撞（L117-128），极其简化
- 无 MVCC、无 WAL 写入事务记录、无回滚复杂逻辑
- 最大活跃事务 100 的硬限制

**差距**: Neo4j 的完整 WAL + page cache MVCC 架构、Dgraph 的 Snapshot Isolation、ArangoDB 的 SERIALIZABLE 与 GraphVec 的简单乐观锁不在同一量级。GraphVec 的 Transaction 层本质是一个"批处理写入辅助类"，不是真正的事务系统。

---

## 2. 查询语言 & 查询执行

### 2.1 查询语言支持

| 维度 | GraphVec | Neo4j | Dgraph | ArangoDB | JanusGraph |
|------|----------|-------|--------|----------|------------|
| **Cypher** | 🟡 Cypher-lite (子集) | ✅ 完整 Cypher 9 | ❌ | ❌ | ❌ (Gremlin) |
| **Gremlin** | ❌ | ✅ (embedded) | ❌ | ✅ (EE) | ✅ |
| **GraphQL** | ❌ | ✅ | ✅ GraphQL± | ✅ | ❌ |
| **AQL** | ❌ | ❌ | ❌ | ✅ | ❌ |
| **SPARQL** | ❌ | 🟡 (Neosemantics) | ❌ | ✅ | ❌ |

**文件**: `src/query/cypher-lite.peggy` (14K — Peggy 语法定义)
- 支持: `MATCH WHERE RETURN`, `CREATE`, `DELETE`, `SET`, `MERGE`
- 聚合: `COUNT`, `SUM`, `AVG`, `MAX`, `MIN`
- UNION: 已定义 `UNION`, `UNION ALL`, `INTERSECT`, `SUBTRACT`
- ORDER BY + LIMIT + SKIP: ✅
- 参数化查询 ($1, $2, ...): ✅

**不支持**：
- 嵌套子查询 (Subquery)
- 路径变量: `MATCH p=(a)-[*]->(b)`
- 递归/变长路径: `[:KNOWS*1..5]`
- OPTIONAL MATCH
- CASE/WHEN
- FOREACH/UNWIND
- 算法内联: `algo.pageRank()`

**文件**: `src/query/cypher-lite-parser.ts` (10 行)
- 只是一个语法重新导出封装
- 解析器生成代码 `cypher-lite-parser-gen.js` (109K) 是 peggy 编译产物

### 2.2 查询优化器 — 关键差距

**文件**: `src/api/query-planner.ts` (1026 行) — QueryPlanner
- 实现了 PlanNode 类型系统（SCAN, FILTER, NEIGHBORS, INDEX_LOOKUP, LIMIT, SORT, PROJECT, JOIN, AGGREGATE 等）
- 选择性估算: estimateSelectivity() 支持 eq/gt/lt/gte/lte/prefix/in/neq
- 谓词下推: pushDownFilter()
- 索引选择: chooseIndex()
- 统计收集: collectStats() — 但只收集节点总数，不维护详细统计
- EXPLAIN 输出: 支持

**文件**: `src/query/planner-bridge.ts` (344 行) — OptimizerBridge
- 桥接 QueryPlanner 的 PlanNode 到 GraphEngine 存储操作
- 支持 SCAN→FILTER→LIMIT→SORT→PROJECT 流水线
- LIMIT early cutoff: ✅
- 但不支持 JOIN 的优化，NEIGHBORS 步骤不走成本优化

**对比 Neo4j Cypher 优化器 (CBO + RBO)**:
| 优化特性 | Neo4j | GraphVec |
|---------|-------|----------|
| 成本模型 (CBO) | ✅ 基于规则 + 统计 | 🟡 仅有基数估算 |
| 统计直方图 | ✅ | ❌ |
| 连接顺序优化 | ✅ Join enumeration | ❌ 单 Scanner |
| Label 索引选择 | ✅ Label Scan + Index Seek | 🟡 typeId 索引 |
| 缓存计划 | ✅ | ❌ |
| 运行时重新优化 | ✅ | ❌ |

### 2.3 图算法内联执行

| 算法 | GraphVec | Neo4j GDS | Dgraph | ArangoDB |
|------|----------|-----------|--------|----------|
| PageRank | ❌ | ✅ | 🟡 手动实现 | ✅ |
| Louvain | ✅ (`src/algorithms/louvain.ts`) | ✅ | ❌ | ✅ |
| Shortest Path | ❌ 无 Dijkstra/BFS | ✅ | 🟡 DgraphQL path | ✅ |
| Betweenness | ✅ | ✅ | ❌ | 🟡 扩展 |
| Max-Flow | ✅ (Dinic) | ✅ | ❌ | ❌ |
| MST | ✅ | ✅ | ❌ | ❌ |
| Connected Components | 🟡 定义在 StorageProvider 层 | ✅ | ❌ | ✅ |

**关键发现**: 算法代码约 5 个文件 (*.ts)，规模较小。图算法未集成到查询执行器 — 用户必须手动调用算法 API，不能通过 Cypher `algo.pageRank()` 语法。

---

## 3. 分布式共识 & 复制

### 3.1 Raft 实现完整性

**文件**: `src/consensus/raft-core.ts` (1016 行)

| Raft 特性 | GraphVec | 参考标准 (TiKV/etcd Raft) |
|-----------|----------|---------------------------|
| **Leader 选举** | ✅ 完整实现 | ✅ |
| **PreVote** | ✅ `_handlePreVote()`, `_startPreVote()` | ✅ |
| **日志复制** | ✅ AppendEntries RPC | ✅ |
| **线性一致读 (ReadIndex)** | ✅ `readIndex()` — 心跳确认 | ✅ |
| **Stale/Follower Read** | ✅ `canServeStaleRead()` | ✅ |
| **Snapshot** | 🟡 `_doSnapshot()` + InstallSnapshot 接口 — **但 InstallSnapshot 回调未实现** | ✅ |
| **成员变更 (Membership)** | ✅ `app-membership-manager.ts` (两阶段) | ✅ |
| **CheckQuorum** | ✅ `checkQuorum` 配置选项 | ✅ |
| **流水线复制** | ❌ 无专门 pipelining | ✅ |
| **批量提案** | ❌ 每个 propose() 独立 AppendEntries | ✅ |
| **Leader Transfer** | ❌ | ✅ |
| **日志压缩** | 🟡 通过 snapshot + truncate | ✅ |

**关键差距**:

1. **InstallSnapshot WASM 回调未实现** (raft-logic-consensus.ts L525):
   ```typescript
   this._node.onSnapshot(() => {
     // TODO: handle snapshot data from raft-logic
   })
   ```
   文件 `test/consensus/raft-install-snapshot.spec.ts` (13940 行) 存在但仅测试 RaftCore.js，不测试 raft-logic WASM。

2. **无批处理流水线**：raft-core.ts `propose()` 对每个提案发送一个 AppendEntries — 对高吞吐场景（10K+ ops/sec）不利。etcd Raft 的批处理流水线多请求发送。

3. **replication 模块与 raft-core 重叠**：raft-core 有独立的日志复制逻辑，而 outbox-replication 也有 PerPeerWorker 消息投递。两个系统独立运作，可能产生数据流冗余。

### 3.2 一致性模型

| 模型 | GraphVec | Neo4j (因果集群) | Dgraph | ArangoDB |
|------|----------|-----------------|--------|----------|
| **线性一致** | ✅ Leader readIndex | ✅ | ✅ (alpha) | ✅ |
| **因果一致** | ❌ | ✅ | ✅ | ❌ |
| **最终一致** | ✅ (LWW CRDT) | ❌ | ✅ (follower) | ❌ |
| **Stale Read** | ✅ `canServeStaleRead()` | ❌ | ✅ | ❌ |

**GraphVec 的一致性模型设计**：
- 同 DC: 通过 Raft 实现强一致（Leader 写入 + readIndex 读）
- 跨 DC: 通过 CRDT + LWW + HLC 实现最终一致
- Follower read: Raft-core 支持，但 **没有在查询引擎层暴露** — 需要应用层通过 API 显式调用

### 3.3 事务隔离级别

GraphVec 的事务能力非常有限：

- 无 MVCC 读视图 — Transaction 只是写批处理
- 乐观锁基于节点 ID 写集碰撞（非时间戳/版本号）
- 不支持读事务（Read transaction）— 无 Snapshot Read
- 提交时写操作的 Engine 路径是顺序执行，非原子提交

**对比**:
- Neo4j: SERIALIZABLE with MVCC, fine-grained locking
- Dgraph: SNAPSHOT ISOLATION, nowait transactions
- ArangoDB: SERIALIZABLE with optimistic locking

### 3.4 跨 DC 同步

**文件**: `src/replication/delta-sync.ts` (218 行), `src/replication/hlc-clock.ts`

| 特性 | GraphVec | 竞品参考 |
|------|----------|---------|
| **CRDT** | ✅ graph-crdt | Neo4j 无，Dgraph 无 |
| **HLC** | ✅ `@consento/hlc` | CockroachDB HLC |
| **CDC EventStream** | ✅ | MongoDB change streams |
| **Delta Sync** | ✅ (变更集 ~100B/op) | 100x 压缩 |
| **LWW 冲突解决** | ✅ | Dynamo/Cassandra |
| **Active-Active** | ✅ Outbox + PerPeerWorker | DynamoDB Global Tables |

**优势**：多活写入能力是 GraphVec 最强差异化。Neo4j 仅支持因果集群单活，Dgraph alpha 多活有限。

---

## 4. 存储引擎

### 4.1 底层存储

| 维度 | GraphVec | Neo4j | Dgraph | ArangoDB | JanusGraph |
|------|----------|-------|--------|----------|------------|
| **引擎** | OverGraph (内存) + LMDB (持久化) | 自研 Bolt (固定大小 record) | Badger (LSM-tree) | RocksDB (LSM-tree) | 后端可插拔 |
| **数据模型** | LSM-like (memtable → SST) | 直接文件 I/O | LSM-tree | LSM-tree | 后端决定 |
| **B-tree vs LSM** | **OverGraph 用 LSM** (memtable + SST) | Bolt 类 B-tree | LSM-tree | LSM-tree | 后端决定 |

### 4.2 WAL 架构

| WAL 特性 | GraphVec (SegmentStreamWal) | Neo4j | CockroachDB |
|----------|---------------------------|-------|-------------|
| **分段文件** | ✅ 64MB segment | ✅ 固定大小 | ✅ |
| **fsync** | 🟡 `fsync()` 但非每次写入 | ✅ WAL sync on write | ✅ |
| **压缩** | ❌ 无 | ❌ 无 | ✅ Snappy |
| **归档** | 🟡 `backup-wal.ts` 存在 | ✅ | ✅ |
| **recovery** | ✅ segment replay | ✅ | ✅ |
| **Truncate** | ✅ `_truncate()` | ✅ | ✅ |

**文件**: `src/core/segment-stream-wal.ts` (642 行)
- 设计质量高：64MB segments, manifest.json, segment migration from old format
- 但 fsync 策略是宽松的 — 无强制每次写入 sync（性能与安全权衡）
- 无 WAL 压缩

**对比 Neo4j WAL**:
Neo4j 使用逻辑日志 + 物理日志双写，GraphVec 只有逻辑日志（StreamMessage）。这意味着崩溃恢复时必须从 WAL 重放完整操作，比 Neo4j 的 physical-to-page 恢复慢。

### 4.3 缓存系统

| 缓存 | GraphVec | Neo4j | Dgraph (Badger) |
|------|----------|-------|----------------|
| **Buffer Pool** | ❌ 无 — OverGraph 管理 | ✅ Page cache (细粒度) | ✅ Block cache |
| **LRU Cache** | ✅ `LRUCache<NodeId>` (graph-engine.ts L57-143) — 邻居缓存 | ✅ | ✅ |
| **邻居缓存** | ✅ 但容量 1024 默认，per-entry TTL 60s | ✅ Bolt 原生 | ❌ 无 |

**关键差距**:
- GraphVec 在 OverGraph 之上有自己的 LRU 缓存，但容量限制为 1024 条目
- 应用级缓存与 OverGraph 内部缓存双缓存可能导致一致性复杂度
- 无 Neo4j 的 page cache (mmap-based, 细粒度 LRU-K)

### 4.4 数据压缩 & I/O

- 序列化: `msgpackr` — 比 JSON 紧凑，但非专门的压缩算法
- 无 Snappy/Zstd 压缩
- 默认为 Node.js fs 的 POSIX I/O，无 Direct I/O / O_DIRECT
- OverGraph 使用 LMDB 的 mmap 访问（仅 OverGraph 数据，不是全部数据）

---

## 5. 分片 & 弹性

### 5.1 分片策略

| 维度 | GraphVec | CockroachDB | ArangoDB SmartGraph | JanusGraph |
|------|----------|-------------|--------------------|------------|
| **分片键** | ✅ Range-based (key hash → range) | ✅ Range (粗细化) | ✅ SmartGraph | ✅ Partition |
| **一致性哈希** | ❌ 使用范围路由表 | ❌ 使用 Meta range | ❌ | ❌ |
| **自动分裂** | ✅ `auto-splitter.ts` (触发: 节点数/操作数超阈值) | ✅ | ✅ | ✅ |
| **rebalance** | ✅ `rebalancer.ts` (LRU + 负载评估) | ✅ Leaseholder rebalance | ✅ SmartGraph | ❌ 手动 |
| **双写** | ✅ `enableDualWrite()` — Reshard 期间双写 | ✅ | ✅ | ❌ |
| **Edge Affinity** | ✅ `edge-affinity.ts` | ❌ | ✅ SmartGraph | ❌ |

**文件**: `src/shard/rebalancer.ts` (1217 行)
- 实现质量高：checksum 验证 (`computeChecksums` + `verifyConsistency`)
- 负载评估: 节点数 + 边数 + 磁盘大小 + 操作频率
- range 分裂: `_splitRange()` 在 rebalancer.ts 中
- scatter-gather: `scatter-gather.ts` (77 行) — 极简但完整

### 5.2 关键差距 — Reshard 数据迁移

**文件**: `src/reshard/reshard-worker.ts`

| Reshard | GraphVec | CockroachDB |
|---------|----------|-------------|
| **fence + flush + drain** | ✅ 已实现 | ✅ |
| **快照 + 增量** | 🟡 有双写，但无完整快照轮子 | ✅ |
| **重试 + 幂等** | ✅ | ✅ |
| **并行迁移** | 🟡 顺序的 PerRange | ✅ 并发 |
| **用户可见影响** | 🟡 最小（双写期间） | ✅ 零停机 |

**自动分裂配置**：
- `maxNodesPerRange`: 10万（默认）— 对中型图合理
- `checkIntervalMs`: 30s — 合理
- `minSplitIntervalMs`: 60s — 防止 split 风暴

### 5.3 Hot-Spot 处理

GraphVec **缺乏**热分片检测与处理：
- 无请求计数器 per range
- 无自动重新分片热 key
- 无 Write Amplification 检测

对比: CockroachDB 有 lease rebalance + load-based splitting，ArangoDB SmartGraph 有 shard distribution

---

## 6. 运维 & 安全

### 6.1 备份/恢复

**文件**: `src/ops/backup.ts`

| Feature | GraphVec | Neo4j | Dgraph |
|---------|----------|-------|--------|
| **文件级备份** | ✅ cpSync + fsync | ✅ | ✅ |
| **增量备份** | 🟡 WAL archiver (backup-wal.ts) | ✅ | ✅ |
| **PITR** | 🟡 接口存在 (PITRConfig) 但未实现 | ✅ | ✅ |
| **一致性检查点** | ✅ consistency-marker (HLC) | ✅ | ✅ |
| **压缩** | ❌ tar 但无 gzip（仅在 backup-wal.ts 有） | ✅ | ✅ |
| **校验和** | ✅ `BackupChecksum` | ✅ | ✅ |
| **热备份** | ✅ 复制后 fsync | ✅ | ✅ |

**备份架构问题**：
- `backup()` 同步：`fs.cpSync()` + `fsyncDirectory()` — 阻塞事件循环
- 对大图（>10GB 数据目录），备份可能会导致显著的 Event Loop 阻塞
- 恢复时先备份当前数据作为回滚点（双倍磁盘空间）

### 6.2 监控

| 监控 | GraphVec | Neo4j | Dgraph |
|------|----------|-------|--------|
| **OTel Metrics** | ✅ OTLP gRPC | ✅ | ✅ |
| **OTel Traces** | ✅ SDK Node | ✅ | ✅ |
| **Prometheus** | ✅ prom-client 注册 | ✅ | ✅ |
| **慢查询日志** | ✅ `query-slow-log.ts` (pino) | ✅ | ✅ |
| **结构化日志** | ✅ pino 9.0 | ✅ | ✅ |
| **Health 检查** | ✅ RestApi /health | ✅ | ✅ |
| **审计日志** | ✅ audit-log.ts (结构化) | ✅ | ✅ |

### 6.3 安全性

| 安全特性 | GraphVec | Neo4j | Dgraph | ArangoDB |
|----------|----------|-------|--------|----------|
| **mTLS** | ✅ `auth.ts` (440 行) | ✅ | ✅ | ✅ |
| **TLS** | ✅ `tls.ts` (460 行) | ✅ | ✅ | ✅ |
| **RLS (行级)** | ✅ `rls.ts` (70 行) | ❌ | ❌ | ✅ |
| **RBAC** | ✅ `rbac.ts` (角色: admin/writer/reader) | ✅ | ✅ | ✅ |
| **CURVE (ZMQ)** | ✅ 8 项边界测试通过 | ❌ | ❌ | ❌ |
| **chokidar 热加载** | ✅ 身份文件变更热加载 | ❌ | ❌ | ❌ |
| **审计日志** | ✅ 结构化 JSON logs | ✅ | ✅ | ✅ |

**对比优势**:
- ZMQ CURVE 安全认证是独特优势
- RLS（行级安全）在主流图数据库中罕见
- 身份文件热加载实现生产级

**差距**:
- 无 HTTPS（仅纯 HTTP + mTLS）
- RBAC 颗粒度不够（角色仅 3 级，无资源级 ACL）
- 无速率限制（有接口 `maxRatelimitPerMin` 但未完整实现）

---

## 7. API & 集成

### 7.1 API 层

| API | GraphVec | Neo4j | Dgraph | ArangoDB | JanusGraph |
|-----|----------|-------|--------|----------|------------|
| **REST** | ✅ `rest.ts` (1340 行) — 节点/边 CRUD + 查询 + 批量 + 健康 | ✅ | ✅ | ✅ | ✅ |
| **GraphQL** | ❌ | 🟡 | ✅ | ✅ | ❌ |
| **gRPC** | ❌ | ❌ | ✅ | ✅ | ❌ |
| **Bolt 协议** | ❌ | ✅ | ❌ | ❌ | ❌ |
| **Fluent API** | ✅ `fluent.ts` — 查询构建器 | ❌ (有 Cypher) | ❌ | ❌ | ❌ |
| **多语言驱动** | ❌ 仅 TypeScript | ✅ Java/JS/Python/Go/.NET/C | ✅ Go/JS/Java/Python | ✅ JS/Java/Python/Go | ✅ Java/.NET/Python |

**REST API 细节 (`src/api/rest.ts`)**:
- 路由: CRUD for nodes + edges, query, status, admin, streaming JSON
- 认证: mTLS，支持 `?skipAuth=true`
- 跨域: 可选 CORS
- 速率限制: 可选（但实现为简单内存计数器）
- 体限制: 10MB 默认
- 需要补 `multi-db` 路由（`/api/v1/:db/...`）— E02 未实现

### 7.2 CDC & Change Streams

| CDC | GraphVec | Neo4j | MongoDB | Debezium |
|-----|----------|-------|---------|----------|
| **EventStream** | ✅ `event-stream.ts` | ❌ 无原生 CDC | ✅ Change Streams | ✅ |
| **Consumer** | ✅ CDC consumer | ✅ 通过插件 | ✅ | ✅ |
| **Outbox** | ✅ outbox-replication | ❌ 无内置 | ❌ | ✅ |
| **CDC 过滤** | 🟡 粗粒度 | 🟡 | ✅ | ✅ |
| **Schema 变更** | ❌ | ❌ | 🟡 | ✅ |

### 7.3 物化视图

**文件**: `src/materialized-view/materialized-view.ts` — 已实现

| 特性 | GraphVec | Neo4j (APOC) | PostgreSQL |
|------|----------|-------------|------------|
| **物化视图引擎** | ✅ 单文件 ~150 行 | ✅ APOC | ✅ |
| **增量刷新** | 🟡 实现为 onChange 回调 | 🟡 | ✅ |
| **周期性刷新** | ✅ 可配置 | ✅ | ✅ |
| **查询引擎对接** | ✅ | ✅ | ✅ |

---

## 8. 综合差距清单与优先级排序

### P0（Blocking — 必须立即修复）

| # | 差距 | 代码证据 | 影响 | 竞品参考 |
|---|------|---------|------|---------|
| P0.1 | **InstallSnapshot WASM 回调缺失** | `raft-logic-consensus.ts` L525 TODO 注释；`raft-install-snapshot.spec.ts` 仅测试 RaftCore.js | Raft 集群中 follower 追赶 leader 时无法通过快照来缩短追赶时间 | TiKV/etcd Raft InstallSnapshot |
| P0.2 | **事务系统能力严重不足** | `src/core/transaction.ts` — 仅 146 行，无 MVCC，无真正的隔离级别 | 多节点并发写入存在幻读、不可重复读风险 | Neo4j SERIALIZABLE MVCC |
| P0.3 | **fsync 策略过于宽松** | `segment-stream-wal.ts` — `open()` 后 fsync，写入无强制 sync | 崩溃场景下可能丢失最近写入 | Neo4j WAL sync-on-write |

### P1（High — 本轮应完成）

| # | 差距 | 代码证据 | 影响 | 竞品参考 |
|---|------|---------|------|---------|
| P1.1 | **查询优化器无详细统计维护** | `query-planner.ts` `collectStats()` — 仅收集节点总数，无直方图/分位数 | 成本估算不准确，Join 排序退化 | Neo4j CBO + 统计 |
| P1.2 | **聚合函数/UNION/子查询未实现** | `query-engine.ts` planFromAST() — 聚合类型定义存在但执行层未实现；`cypher-lite.peggy` UNION 语法有但无执行 | 查询能力严重受限 | Neo4j Cypher 完整实现 |
| P1.3 | **BFS/DFS/PageRank 缺失** | `src/algorithms/` — 无 BFS, DFS, Dijkstra, PageRank | 图分析能力对比 JanusGraph/Neo4j GDS 显著不足 | Neo4j GDS, JanusGraph Gremlin OLTP |
| P1.4 | **多数据库 REST 路由未实现** | `rest.ts` — `databaseManager` 参数存在但 `/api/v1/:db/...` 路由未实现 | 多 DB 实例只能通过代码 API 管理 | ArangoDB 多 DB REST API |

### P2（Medium — 增强竞争力）

| # | 差距 | 代码证据 | 影响 |
|---|------|---------|------|
| P2.1 | **批量邻居预取 + LRU 增强** | `graph-engine.ts` neighbors() — 已缓存但无批量预取 | 多跳遍历性能受限于单次邻居查询 |
| P2.2 | **备份压缩** | `backup.ts` — tar 但无 gzip/Snappy | 备份文件体积大 |
| P2.3 | **导入流式 + CSV/NDJSON** | `ops/importer.ts` — 已实现基础 CSV/NDJSON 读取和批量 | 数据导入性能受限于 Node.js 单线程解析 |
| P2.4 | **WAL fsync 增强** | `segment-stream-wal.ts` — 无强制 sync | 性能可调但安全需保证 |
| P2.5 | **Hot-spot 处理** | `src/shard/` — 无热分片检测 | 负载不均衡场景性能下降 |

### P3（Low — 锦上添花）

| # | 差距 | 代码证据 | 影响 |
|---|------|---------|------|
| P3.1 | **HTTPS/mTLS 认证扩展** | `rest.ts` — HTTP-only | 生产环境需 HTTPS |
| P3.2 | **RBAC 细粒度 ACL** | `src/security/rbac.ts` — 仅角色级 | 企业级多租户 |
| P3.3 | **速率限制完整实现** | `rest.ts` — 有接口但未完整 | 防 DDoS |
| P3.4 | **gRPC 支持** | 无 | 高性能客户端 |
| P3.5 | **更多图算法 (PageRank, Triangle Counting, Closeness)** | `src/algorithms/` — 仅 4 个算法 | 图分析广度 |

---

## 对比差距矩阵 — 汇总

```
                     Neo4j v5   Dgraph   ArangoDB   JanusGraph   GraphVec
                     ───────    ──────    ───────    ─────────     ───────
Cypher 完整度          █████     ██░░░     ██░░░      ██░░░        ██░░░
查询优化器             █████     ██░░░     ███░░      ███░░        ██░░░
图算法库               █████     ██░░░     ███░░      █████        ██░░░
原生图存储             █████     ██░░░     ██░░░      ██░░░        ███░░
ACID 事务              █████     ███░░     █████      ██░░░        █░░░░
Raft 共识              ███░░     █████     █████      ███░░        ███░░
分片/弹性              ██░░░     ███░░     █████      ███░░        █████
多活写入               ░░░░░     ██░░░     ░░░░░      ░░░░░        █████
零依赖嵌入             ░░░░░     ░░░░░     ░░░░░      ░░░░░        █████
运维工具               █████     ███░░     ████░      ███░░        ███░░
安全 (mTLS/RLS)       ███░░     ███░░     ████░      ██░░░        █████
API 丰富度             █████     ████░     █████      ██░░░        ███░░

LEGEND: █████=全功能  ████░=几乎全  ███░░=中等  ██░░░=基础  █░░░░=不足
```

### 差异化优势总结

1. **多活写入**: Outbox + PerPeerWorker + CRDT — 唯一实现的生产级多活图 DB
2. **零依赖嵌入**: 纯 npm install，无需外部进程/数据库
3. **分层共识**: Standalone/Raft/raft-logic 可切换 — 部署灵活
4. **ZMQ CURVE 安全**: 独特的传输层加密
5. **RLS 行级安全**: 图数据库中罕见功能
6. **动态分片 + 自动分裂**: 达到 CockroachDB 级

### 应优先弥补的差距

按性价比排序（投入产出比最高）：

1. **事务系统升级**: ~2 天 → 填补最大功能空白
2. **InstallSnapshot**: ~1 天 → Raft 集群可靠性的核心缺口
3. **BFS/DFS/PageRank**: ~2 天 → 补齐核心图算法
4. **查询聚合/UNION 执行**: ~1.5 天 → 查询语言完整度
5. **统计收集增强**: ~1 天 → 优化器质量提升
6. **多 DB REST 路由**: ~1 天 → 运维便利性
7. **fsync 策略增强**: ~0.5 天 → 数据安全性

---

## 详细改进方案

### P0.2: 事务系统升级方案

**问题**: 当前事务系统是"批处理写入辅助类"，无 MVCC、无真正的隔离级别。

**方案**: 引入 MVCC 读快照 + 写-写冲突检测

```typescript
// 伪代码 — 升级后的事务系统

interface MVCCSnapshot {
  id: number       // 全局递增
  createdAt: number // hlc timestamp
  // 读视图: 只能看到 snapshot.id 之前提交的写入
}

class Transaction {
  snapshot: MVCCSnapshot
  writeSet: Map<NodeId, TxnWrite>
  readSet: Set<NodeId>
  
  async commit(engine: TransactionalEngine) {
    // Phase 1: 锁检查 — check writeSet 中的每个 key
    for (const [nodeId] of this.writeSet) {
      if (engine.isLocked(nodeId, this.snapshot.id)) {
        throw new ConflictError(`node ${nodeId} conflict`)
      }
    }
    // Phase 2: 写 WAL
    const walEntry = await engine.wal.append(this.serialize())
    // Phase 3: 应用写入
    for (const [nodeId, write] of this.writeSet) {
      engine.applyWrite(nodeId, write, this.snapshot.id)
    }
    // Phase 4: 释放锁
  }
}

class TransactionManager {
  private nextSnapshotId = 1
  private locks = new Map<NodeId, number>() // nodeId → snapshotId
  
  begin(): Transaction {
    const snapshot: MVCCSnapshot = {
      id: this.nextSnapshotId++,
      createdAt: Date.now(),
    }
    return new Transaction(snapshot)
  }
}
```

**验收测试条款**:
1. 并发写入同一节点 → 第二个事务检测到冲突并抛出
2. 非冲突并发写入（不同节点
---

## 附录 A: Raft 实现校验清单

从 `src/consensus/raft-core.ts` (1016 行) 逐条检查 Raft 论文 §5.1-5.7 实现：

### §5.1 Leader 选举 ✅
- `_startElection()` -> `_doRealElection()` — 完整选举流程
- 选举超时随机化 — `_resetElectionTimeout()` 使用 Math.random() * electionTimeoutMs
- 日志安全性检查 — `_handleRequestVote()` 检查 lastLogTerm / lastLogIndex

### §5.2 PreVote ✅
- `_startPreVote()` -> `_handlePreVote()` -> `_handlePreVoteResponse()`
- PreVote 使用 nextTerm (currentTerm+1) 但不递增
- 通过后调用 `_doRealElection()` 正式选举

### §5.3 日志复制 ✅
- `propose()` -> WAL append -> `_sendAppendEntries()` -> `_advanceCommitIndex()`
- 冲突处理: `_handleAppendEntries()` 检查 prevLogTerm, truncate 冲突条目
- **缺失优化**: 批量 AppendEntries proposal，论文 §5.3 推荐的 conflict optimization

### §5.4 安全性 ✅
- Leader 完整性保证: `_handleRequestVote()` 日志比较
- 已提交条目不重写
- Leaders 只追加不覆盖

### §5.5 Follower/Candidate 崩溃 ✅
- 超时后重新选举
- WAL 持久化保证

### §5.6 定时器与可用性 ✅
- 选举超时: 150ms base + random(0, 150)ms
- 心跳间隔: 50ms
- CheckQuorum 支持

### §5.7 成员变更 ✅
- `app-membership-manager.ts` 实现两阶段成员变更 (joint consensus)

### §7: 日志压缩 / 快照 🟡
- `_doSnapshot()` 实现存在
- `_loadSnapshotState()` 恢复快照索引
- InstallSnapshot handler 已传输定义 (`InstallSnapshotRequest/Response`)
- **关键缺失**: raft-logic WASM 的 onSnapshot 回调和 InstallSnapshot 完整流程

---

## 附录 B: OverGraph 存储引擎代码级分析

`src/core/overgraph-storage.ts` 是 StorageProvider 接口的唯一生产实现。

### 接口实现完整性

| 方法 | 实现状态 | 行数 |
|------|---------|:----:|
| `open()` | ✅ | ~30 |
| `close()` | ✅ | ~10 |
| `upsertNode()` | ✅ | ~15 |
| `getNode()` | ✅ | ~15 |
| `deleteNode()` | ✅ | ~5 |
| `batchUpsertNodes()` | ✅ | ~8 |
| `degrees()` | ✅ | ~5 |
| `upsertEdge()` | ✅ | ~15 |
| `getEdge()` | ✅ | ~15 |
| `deleteEdge()` | ✅ | ~5 |
| `neighbors()` | ✅ | ~10 |
| `vectorSearch()` | ✅ | ~8 |
| `personalizedPageRank()` | ⚠️ 委托 OverGraph | ~5 |
| `allShortestPaths()` | ⚠️ 委托 OverGraph | ~5 |
| `connectedComponents()` | ⚠️ 委托 OverGraph | ~5 |
| `queryPattern()` | ⚠️ 委托 OverGraph | ~5 |
| `exportSnapshot()` | ❌ 不存在 | 0 |
| `importSnapshot()` | ❌ 不存在 | 0 |

### 关键问题

**Snapshot 缺失**: StorageProvider 接口定义了 `exportSnapshot?()` 和 `importSnapshot?()` (可选方法)，但 OverGraphStorage 未实现。这是 raft-core InstallSnapshot 流程的阻塞依赖。

**memory 泄漏风险**: `OverGraphStorage.close()` 调用 `this._db!.close()`，但未验证 OverGraph 是否正确释放所有资源 (mmap, file handles)。

---

## 附录 C: npm 包依赖分析

### 生产依赖

| 包 | 版本 | 用途 | 替代方案评估 |
|---|:----:|------|------------|
| `overgraph` | ^0.7.0 | 图引擎 | **不可替代** — 核心图存储 |
| `lmdb` | ^3.5.0 | KV 持久化 | 可选: `level` (LevelDB), `rocksdb`, `better-sqlite3` |
| `zeromq` | ^6.5.0 | P2P 消息 | 可选: `nat-mq` (原生 JS), `bullmq` (需 Redis) |
| `msgpackr` | ^2.0.0 | 序列化 | 可选: `msgpack5`, `@msgpack/msgpack` |
| `minisearch` | ^7.2.0 | 全文搜索 | 可选: `lunr`, `flexsearch` |
| `graph-crdt` | 最新 | CRDT 同步 | 可选: `automerge`, `yjs` |
| `@consento/hlc` | 最新 | 混合逻辑时钟 | 可选: 自研 (~50 行) |
| `pino` | ^9.0.0 | 结构化日志 | 可选: `winston`, `bunyan` |
| `csv-parse` | 最新 | CSV 解析 | 可选: `papaparse`, `csv-parser` |

### 可嵌入性校验

所有依赖 (除 `zeromq` 需要原生编译) 都是纯 JS/TS 包，可通过 `npm install` 直接嵌入。无依赖需要外部服务进程。

---

## 附录 D: 与竞品的代码行数级对比 (粗略估计)

| 模块 | GraphVec | Neo4j (Java) | Dgraph (Go) | 备注 |
|------|:--------:|:------------:|:-----------:|:----|
| 图引擎 | ~2K | ~50K | ~20K | OverGraph 封装 |
| 查询解析 | ~3K | ~100K | ~30K | Peggy 生成 |
| 查询优化 | ~2K | ~80K | ~20K | 简化成本模型 |
| Raft 共识 | ~4K | ~30K | ~40K | 全 TS 实现 |
| 复制 | ~3K | ~20K | ~25K | Outbox + CRDT |
| 分片 | ~3K | N/A | ~30K | CockroachDB 级 |
| 安全 | ~3K | ~15K | ~10K | mTLS + RLS |
| 运维 | ~5K | ~20K | ~15K | 含备份/监控 |
| REST API | ~2K | ~10K | ~5K |
| **总计** | **~27K** | **~325K** | **~195K** |

GraphVec 以 ~27K 生产代码覆盖了竞品 200K-300K 的功能。但这意味着 **每行代码** 的密度很高，复杂度集中在关键路径。

---

*本报告 v2.0 完成于 2026-05-29*
*基于 git HEAD `5dd9cb16`, 173 源文件, ~50K 总行*
