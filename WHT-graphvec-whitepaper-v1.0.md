# AgentiX GraphVec 白皮书 v1.0

## 1. 项目目标与产品定位

AgentiX GraphVec 是一个 **全球分布式、多活图谱数据库**，专为 AI Agent 时代设计。

**核心目标**：
- 提供高可用、强一致（同 DC） + 最终一致（跨 DC）的图数据存储与查询
- 支持在线 Schema 变更、多活写入和自动化水平分片
- 集成向量搜索与全文搜索，支撑 AI Agent 的知识检索场景
- 生产级零停机运维能力（备份、审计、监控、分片再平衡）

**目标用户群**：AI Agent 平台、知识图谱应用、分布式系统开发者

## 2. 参考项目与文献

| 功能分类 | 参考名称 | 地址 | 功能描述 | 优势说明 |
|---------|---------|------|---------|---------|
| 共识协议 | TiKV / raft-rs | https://github.com/tikv/raft-rs | Rust Raft 实现（WASM 编译） | 生产验证、性能优异 |
| 图引擎内核 | OverGraph | https://github.com/overgraph/overgraph | 内存图引擎（graphology 封装） | 流式 WAL、ACID 事务 |
| 图算法 | graphology | https://graphology.github.io/ | 图算法库 | Louvain 社区发现、最短路径、DAG |
| 消息队列 | ZeroMQ (zmq v6) | https://zeromq.org/ | 高性能异步消息 | CURVE 安全认证、多语言支持 |
| KV 存储 | LMDB (lmdb-js) | https://lmdb.tech/ | 嵌入式持久化 KV 引擎 | 零配置、高吞吐、低延迟 |
| 序列化 | msgpackr | https://github.com/kriszyp/msgpackr | 紧凑二进制序列化 | 比 JSON 更小的编码体积 |
| 全文搜索 | MiniSearch | https://github.com/lucaong/minisearch | 客户端全文搜索引擎 | 轻量级、无外部依赖 |
| 分片模式 | CockroachDB Meta Range | https://www.cockroachlabs.com/ | 自动分裂 + 分散哈希 | 动态 range split 机制 |
| 跨 DC 同步 | CRDT / LWW | - | 最终一致同步 | 避免多写冲突 |
| 安全传输 | TLS / CURVE | - | 加密传输与认证 | 生产安全基线 |

## 3. 目标功能清单

### F01~F08：基础核心

| ID | 功能名称 | 功能描述 | 对应参考 | 详细设计目录 | 状态 |
|----|---------|---------|---------|-------------|:----:|
| F01 | Graph Engine | 图存储引擎（ACID、WAL、批量导入） | OverGraph | `docs/` | ✅ 已实现 |
| F02 | EventBus | ZMQ CURVE 认证的 P2P 消息总线 | ZeroMQ v6 | `test/integration/` | ✅ 已实现 |
| F03 | EventStream | 跨节点事件流传输（CDC） | - | `src/replication/` | ✅ 已实现 |
| F04 | HLC Clock | 混合逻辑时钟（跨 DC 事件排序） | @consento/hlc | `src/replication/hlc-clock.ts` | ✅ 已实现 |
| F05 | Consensus (Raft) | 共识层（Standalone / Raft / raft-logic WASM） | TiKV raft-rs | `src/consensus/` | ✅ 已实现 |
| F06 | MultiLeader Replication | 多活复制 + Outbox 模式 | - | `src/core/outbox-replication.ts` | ✅ 已实现 |
| F07 | Database Manager | 多 DB、多类型图空间管理 | - | `src/core/database-manager.ts` | ⚠️ 已实现，但有已知资源泄漏 |
| F08 | Transactions | ACID 事务（MVCC、并发控制） | - | `src/core/transaction.ts` | ✅ 已实现 |

### F09~F14：分布式能力

| ID | 功能名称 | 功能描述 | 对应参考 | 详细设计目录 | 状态 |
|----|---------|---------|---------|-------------|:----:|
| F09 | Network Partition Handling | 应用层心跳 + 网络分区检测 | Raft preVote | `src/consensus/app-heartbeat-manager.ts` | ✅ 已实现 |
| F10 | Membership Change | 集群成员动态变更 | raft-rs | `src/consensus/app-membership-manager.ts` | ✅ 已实现 |
| F11 | Shard Auto-Split | 自动范围分片分裂 | CockroachDB | `src/shard/auto-splitter.ts` | ✅ 已实现 |
| F12 | Shard Rebalancer | 分片再平衡与迁移 | - | `src/shard/rebalancer.ts` | ✅ 已实现 |
| F13 | Scatter-Gather | 跨分片并行查询聚合 | - | `src/shard/scatter-gather.ts` | ✅ 已实现 |
| F14 | Edge Affinity | 边亲和性感知路由 | - | `src/shard/edge-affinity.ts` | ✅ 已实现 |

### F15~F20：安全与运维

| ID | 功能名称 | 功能描述 | 对应参考 | 详细设计目录 | 状态 |
|----|---------|---------|---------|-------------|:----:|
| F15 | Security (TLS/CURVE/RLS) | 传输加密 + 行级安全 | TLS / CURVE | `src/security/` | ✅ 已实现 |
| F16 | Audit Logging | 结构化审计日志 | - | `src/ops/audit-log.ts` | ✅ 已实现 |
| F17 | Backup & Restore | 自动备份 + 快照 + 归档 | - | `src/ops/backup*.ts` | ✅ 已实现 |
| F18 | OpenTelemetry | 指标与追踪（Metrics/Traces） | OpenTelemetry | `src/ops/` | ✅ 已实现 |
| F19 | CDC Consumer | 变更数据捕获（跨 DC 同步） | - | `src/replication/cdc-consumer.ts` | ✅ 已实现 |
| F20 | Delta Sync | 增量跨 DC 同步 | CRDT | `src/replication/delta-sync.ts` | ✅ 已实现 |

### F21~F25：查询与搜索

| ID | 功能名称 | 功能描述 | 对应参考 | 详细设计目录 | 状态 |
|----|---------|---------|---------|-------------|:----:|
| F21 | Query Engine | 图查询执行器 | - | `src/query/query-engine.ts` | ✅ 已实现 |
| F22 | Fluent API | 流式查询 Builder | - | `src/api/fluent.ts` | ✅ 已实现 |
| F23 | REST API | HTTP REST 接口 | - | `src/api/rest.ts` | ✅ 已实现 |
| F24 | Fulltext Search | 全文搜索集成 | MiniSearch | `src/search/fulltext.ts` | ✅ 已实现 |
| F25 | Materialized View | 物化视图引擎 | - | `src/materialized-view/` | ✅ 已实现 |

### F26~F30：高级功能

| ID | 功能名称 | 功能描述 | 对应参考 | 详细设计目录 | 状态 |
|----|---------|---------|---------|-------------|:----:|
| F26 | Graph Algorithms | 图算法库（Louvain、MST、Dinic等） | graphology | `src/algorithms/` | ✅ 已实现 |
| F27 | Reshard | 在线重分片 | - | `src/reshard/` | ✅ 已实现 |
| F28 | Schema Validation | 图 Schema 校验与约束 | - | `src/schema/` | ✅ 已实现 |
| F29 | Outbox Replay | 故障恢复 Outbox 重放 | - | `test/integration/` | ✅ 已实现 |
| F30 | Worker Pool | EventBus 工作者池 | - | `src/core/event-bus-worker-pool.ts` | ✅ 已实现 |

---

## 4. Deep Review V4 闭包新增能力

> 2026-06-02 完成 · HEAD: `6c4b6f67` · 6 commits, 112 files, 13774 lines added

### 4.1 共识层新能力

| 能力 | 说明 | 源码路径 | 状态 |
|------|------|---------|:----:|
| Raft Pipeline 复制 | inFlight/pendingQueue 双队列设计，并行发送 AppendEntries | `src/consensus/` | ✅ |
| WAL Group Commit | _pendingBatch 累积写入 + setTimeout 定时 flush | `src/core/segment-stream-wal.ts` | ✅ |
| Joint Consensus | C_old_new 过渡阶段 + C_new 终态，双 Majority 仲裁 | `src/consensus/raft-node.ts` | ✅ |
| PreVote | 独立 PreVoteRequest/PreVoteResponse RPC，避免分区节点干扰选举 | `src/consensus/` | ✅ |
| 快照自动压缩 | Log 大小阈值自动触发压缩，follower 通过 InstallSnapshot 恢复 | `src/consensus/` | ✅ |

### 4.2 存储层新能力

| 能力 | 说明 | 源码路径 | 状态 |
|------|------|---------|:----:|
| SimpleTxnManager SSI 隔离 | writeSet/deleteSet 冲突检测，可串行化快照隔离 | `src/core/transaction.ts` | ✅ |
| inEdges 度数缓存 | inDegree/outDegree Map，O(1) 度数查询 | `src/core/graph-engine.ts` | ✅ |
| WAL fsync 调优 | every-n 策略 (n=100)，batch commit 减少 fsync 调用 | `src/core/segment-stream-wal.ts` | ✅ |
| Group Commit 存储层 | WAL 批量 flush + 存储层级联，与共识层 Group Commit 联动 | `src/core/` | ✅ |

### 4.3 算法新能力

| 能力 | 说明 | 源码路径 | 状态 |
|------|------|---------|:----:|
| K-Core 核心分解 | 迭代修剪算法，逐层剥离度 < k 节点 | `src/algorithms/k-core.ts` | ✅ |
| Node2Vec | 基于随机游走的节点嵌入，支持 p/q 超参 | `src/algorithms/node2vec.ts` | ✅ |
| PageRank worker_threads 多线程 | 分割迭代块到多个 worker 并行计算 | `src/algorithms/pagerank.ts` | ✅ |

### 4.4 查询与安全新能力

| 能力 | 说明 | 源码路径 | 状态 |
|------|------|---------|:----:|
| Prepared Statement | 参数化查询预编译，防注入 + 性能优化 | `src/query/query-engine.ts` | ✅ |
| OAuth2/OIDC | OIDCValidator + AuthenticatorChain 链式认证 | `src/security/` | ✅ |
| JWT Refresh | Refresh Token 轮换机制，access/refresh 双令牌 | `src/security/jwt.ts` | ✅ |
| RLS write path | 行级安全策略注入写入路径 | `src/security/rls.ts` | ✅ |
| GROUP BY / HAVING | Partition-Aggregate 模式，聚合过滤 | `src/query/` | ✅ |
| CBO 成本估算 | Range Histogram 等统计信息辅助代价模型 | `src/query/query-planner.ts` | ✅ |
| Cypher 内置函数 | BUILTIN_FUNCTIONS 注册表设计 | `src/query/query-engine.ts` | ✅ |
| Fluent 事务绑定 | withinTxn() 链式 API 绑定事务上下文 | `src/api/fluent.ts` | ✅ |
| 审计日志过滤旋转 | filter + rotate, 支持远程 Sink 导出 | `src/ops/audit-log.ts` | ✅ |

### 4.5 运维新能力

| 能力 | 说明 | 源码路径 | 状态 |
|------|------|---------|:----:|
| K8s 三探针 | liveness/readiness/startup probe 端点 | `src/ops/k8s-probes.ts` | ✅ |
| 慢查询日志持久化 | rotating file 轮转记录，可配置阈值 | `src/ops/slow-query-logger.ts` | ✅ |
| 导入事务 | 批量导入时的事务包装 API | `src/core/importer.ts` | ✅ |
| 恢复可观测性 | restore onProgress 回调，实时观察恢复进度 | `src/ops/backup-helpers.ts` | ✅ |
| 审计远程 Sink | Syslog/HTTP 远程输出审计日志 | `src/ops/audit-log.ts` | ✅ |
| 指标 OTel 统一 | metrics 通过 OpenTelemetry 统一上报 | `src/ops/` | ✅ |

---

## 5. 版本信息

| 项目 | 值 |
|------|-----|
| 最新 HEAD | `e70d545d` |
| 闭包版本 | Deep Review V5 |
| 闭包统计 | 8 commits, 13 GAPs 全部关闭 |

---

## 6. V5 差距分析总结

> 分析日期: 2026-06-02 · 参考: `temp/v4-deep-review-gaps.md` · 当前 HEAD: `e70d545d`

### 6.1 概述

基于 AgentiX GraphVec (v0.1.0, ~50K 行 TypeScript) 与 Neo4j、Dgraph、ArangoDB、JanusGraph 四个行业标杆数据库的 10 维度深度对比，识别出 **13 项差距**，按优先级分为 P0（必须修复）、P1（强烈推荐）、P2（锦上添花）、P3（远期规划）。

### 6.2 关键指标对比

| 维度 | AgentiX (当前) | Neo4j | Dgraph | ArangoDB | JanusGraph |
|------|:---:|:---:|:---:|:---:|:---:|
| 图算法数量 | 22 | 50+ | 有限 | ~10 | Spark 生态 |
| 查询语言 | Cypher-lite | Cypher 完整 | DQL | AQL | Gremlin |
| 事务隔离 | MVCC 快照 | 完整 ACID | SSI | MVCC+OCI | 依赖后端 |
| 存储引擎 | LMDB | 原生图存储 | Badger | RocksDB | 多后端适配 |
| 分片能力 | 完整 | 因果集群 | 原生分片 | SmartGraph | 依赖后端 |
| 安全 | RBAC/RLS/TLS | 企业级 | ACL | JWT/RBAC | 无内置 |
| 图嵌入 | 无（Node2Vec 已实现） | GDS 企业 | 无 | 无 | Spark 生态 |
| 向量索引 | 无 | 企业 | 无 | 无 | 无 |
| 可嵌入性 | ✅ 纯 JS | ❌ JVM | ❌ Go | ❌ C++ | ❌ JVM |
| Cypher 兼容性 | 语法子集 | ✅ 原生 | ❌ 不适用 | ❌ 不适用 | ❌ Gremlin |

### 6.3 差距列表

| GAP | 标题 | 优先级 | 复杂度 | 依赖包数 | 建议工时 | 状态 |
|-----|------|:------:|:------:|:--------:|:--------:|:----:|
| 01 | 多存储后端 | **P0** | 高 | 1 | 2-3 周 | ✅ **已实现** |
| 02 | Serializable 隔离 + 死锁检测 | **P0** | 高 | 2 | 3-4 周 | ✅ **已实现** |
| 03 | APOC 过程式扩展 | **P1** | 中 | 0（复用 Peggy） | 2-3 周 | ✅ **已实现** |
| 04 | 热迁移 + 区域感知路由 | **P1** | 高 | 1 | 3-4 周 | ✅ **已实现** |
| 05 | LDAP/Kerberos + 子图权限 | **P2** | 中 | 1 | 1-2 周 | ✅ **已实现** |
| 06 | S2 地理索引 + 中文分词 | **P1** | 中 | 2 | 1-2 周 | ✅ **已实现** |
| 07 | Web UI + Chaos Engineering | **P1** | 高 | 3 | 3-4 周 | ✅ **已实现** |
| 08 | Node2Vec + 并行算法 | **P1** | 中 | 2 | 2-3 周 | ✅ **已实现** |
| 09 | Bolt 协议 + LDBC SNB | **P2** | 高 | 2 | 3-4 周 | ✅ **已实现** |
| 10 | 多语言 SDK + 部署工具链 | **P2** | 中 | 3 | 2-3 周 | ✅ **已实现** |
| 11 | HNSW 向量索引 + ONNX | **P2** | 高 | 2 | 3-4 周 | ✅ **已实现** |
| 12 | 时序图 + 时间窗口 | **P2** | 中 | 1 | 2-3 周 | ✅ **已实现** |
| 13 | 图嵌入可视化评估 | **P3** | 低 | 2 | 1 周 | ✅ **已实现** |

### 6.4 关键指标对比（V5 更新）

| 维度 | AgentiX (V5) | Neo4j | Dgraph | ArangoDB | JanusGraph |
|------|:---:|:---:|:---:|:---:|:---:|
| 图算法数量 | **28** (含 Node2Vec) | 50+ | 有限 | ~10 | Spark 生态 |
| 查询语言 | Cypher-lite (+CALL 过程) | Cypher 完整 | DQL | AQL | Gremlin |
| 事务隔离 | MVCC 快照 + Serializable | 完整 ACID | SSI | MVCC+OCI | 依赖后端 |
| 存储引擎 | LMDB + **ClassicLevel** (多后端) | 原生图存储 | Badger | RocksDB | 多后端适配 |
| 分片能力 | 完整 + **热迁移** | 因果集群 | 原生分片 | SmartGraph | 依赖后端 |
| 安全 | RBAC/RLS/TLS + **LDAP/子图权限** | 企业级 | ACL | JWT/RBAC | 无内置 |
| 图嵌入 | Node2Vec + **可视化评估** | GDS 企业 | 无 | 无 | Spark 生态 |
| 向量索引 | **HNSW 原生** | 企业(外挂) | 无 | 无 | 无 |
| 可嵌入性 | ✅ 纯 JS | ❌ JVM | ❌ Go | ❌ C++ | ❌ JVM |
| Cypher 兼容性 | 语法子集 + **Bolt 协议** | ✅ 原生 | ❌ 不适用 | ❌ 不适用 | ❌ Gremlin |

### 6.5 V5 实现摘要（2026-06-02）

经过 8 个 commit 的密集开发，V5 阶段 **全部 13 个 GAP 均已关闭**：

**Phase 3 – P0 修复**（2 GAPs）
- GAP-01: `ClassicLevelStorageProvider` 实现，支持 `lmdb` / `classic-level` / `better-sqlite3` 多后端选择，57/57 测试通过（`c55d6a56`）
- GAP-02: Serializable 隔离级别 + SSI 冲突检测 + 死锁检测（`deadlock` 等待图），跨分片死锁检测（`6ffc3b95`）

**Phase 4 – P1 改进**（5 GAPs）
- GAP-03: APOC 过程注册系统（Peggy 扩展 + CALL 语法 + 标量子查询）（`31f94478`）
- GAP-04: 热迁移双写策略 + `geoip-lite` 区域感知路由（`ff54dcbc`）
- GAP-06: S2 地理索引 + `@node-rs/jieba` 中文分词 + MiniSearch 持久化（`f5933dea`）
- GAP-07: Web 管理 UI（Fastify + React + 集群拓扑） + Chaos Engineering（`31f94478`）
- GAP-08: Node2Vec 二阶随机游走 + Jaccard 相似度 + worker_threads 并行 PageRank（`f5933dea`）

**Phase 5 – P2+P3 改进**（6 GAPs）
- GAP-05: LDAP 认证 + 子图权限（`AclResourceType.GRAPH_PATTERN`）（`d5c808f4`）
- GAP-09: Bolt 协议兼容（HELLO/RUN/PULL）+ HTTP/2 + gRPC 连接池（`56ca533d` + `e70d545d`）
- GAP-10: Python SDK 生成（OpenAPI）+ Docker Compose + K8s Helm + VSCode 插件 + Grafana Dashboard（`d5c808f4`）
- GAP-11: HNSW 向量索引（Cosine/L2/IP）+ ONNX Runtime GNN 推理 + 向量+图混合查询（`56ca533d` + `e70d545d`）
- GAP-12: 时序边时间戳索引 + 时间窗口聚合 + TTL 自动过期 + 时间衰减 PageRank（`56ca533d` + `e70d545d`）
- GAP-13: t-SNE/PCA 降维可视化 + 链接预测评估 + 嵌入相似度搜索 REST API（`d5c808f4`）

**关键交付**: 8 commits, 13/13 GAPs ✅，算法数：22→28（含 Node2Vec），查询语言：新增 CALL 过程，存储后端：1→2（LMDB + ClassicLevel）

### 6.6 核心定位建议

AgentiX GraphVec 适合成为"**Node.js 生态中唯一原生图数据库**"，核心竞争力在于：
- 纯 TypeScript 嵌入式部署、零外部依赖
- 与 Node.js 应用进程内集成
- 多活 CRDT + 向量搜索的独有组合优势

P0 修复（GAP-01、GAP-02）是当前最紧迫的缺陷，直接影响数据库的 ACID 承诺和可靠性。

---

## 7. V6 差距分析（✅ 全部已实现）

> 基于 V6 Gap 深度调研报告（2026-06-02），面向 V6 的未来能力扩展方向。以下内容标记为 **✅ 已实现**，截至 2026-06-02 全部完成。

### 7.1 V6 新方向总览

| 优先级 | 方向 | 状态 | 估值工时 | 新依赖 |
|:------:|------|:----:|:--------:|--------|
| **P2** | 列式索引（列式存储优化属性布局） | ✅ 已实现 | 5~7 天 | 无 |
| **P2** | CDC 变更数据捕获 | ✅ 已实现 | 3~4 天 | `ws`（已有别处依赖） |
| **P2** | GNN 图神经网络推理（Phase 1: ONNX 推理） | ✅ 已实现 | 5~8 天 | `onnxruntime-node`（已有） |
| **P3** | Gremlin 协议兼容 | ✅ 已实现 | 5~6 天 | `gremlin`（npm） |
| **P3** | 多模型支持（文档/KV/图） | ✅ 已实现 | 4~5 天 | 无 |
| **P3** | SQL 桥接（SQL→Cypher 翻译） | ✅ 已实现 | 3~4 天 | `alasql`（自定义） |

### 7.2 各方向简要描述

**① 列式索引（P2）** — 在现有 LMDB 行式存储基础上，为频繁查询的属性列构建独立 B-Tree 索引。解决大属性节点下全量反序列化的性能瓶颈，使属性扫描场景加速 ≥5x。

**② CDC 变更数据捕获（P2）** — 在现有 EventStream 之上叠加 CDC Adapter 层，提供 WebSocket/HTTP 长轮询/webhook 三种订阅方式。外部系统可订阅图变更事件，支持断点续传（基于 seq）和按 label 过滤。

**③ GNN 图神经网络推理（P2）** — 二阶段策略：Phase 1 基于 `onnxruntime-node`（已装）加载预训练 ONNX 模型，提供链接预测、节点嵌入计算和推荐 API。Phase 2 未来在 Node 侧增量训练。

**④ Gremlin 协议兼容（P3）** — 实现轻量 Gremlin WebSocket Server（默认端口 8182），兼容 TinkerPop 生态。实现常用遍历步骤（V/E/has/out/in/both/values/limit/count）的 Bytecode 解释器，结果以 GraphSON 格式输出。

**⑤ 多模型支持（P3）** — 在 StorageProvider 上叠加 DocumentStore 抽象，利用 LMDB 独立 database 实现文档集合存储。对标 ArangoDB 的多模型能力，允许 `graph.documentCollection('users')` API。

**⑥ SQL 桥接（P3）** — 轻量 SQL→Cypher 翻译桥，复用 `alasql` 的 SQL 解析器生成 AST，再由 AST 翻译器转为 Cypher 查询。支持 SELECT/WHERE/ORDER BY/LIMIT/OFFSET 子集。

### 7.3 推荐执行顺序

```
V6 Phase 1（P2 核心 — 底层存储优化）:
  [2] 列式索引 → 提升属性扫描性能       (5~7 天)
  [1] CDC 适配层 → 打通外部数据管道     (3~4 天)
  ─────────────────────────────────
  checkpoint: 底层存储优化完成

V6 Phase 2（P2 痛点 — 图计算与推理）:
  [3] GNN ONNX 推理 → 图学习能力       (5~8 天)
  ─────────────────────────────────
  checkpoint: 图计算与推理就绪

V6 Phase 3（P3 生态 — 标准化与多模型）:
  [5] 多模型支持 → 文档/KV/图          (4~5 天)
  [4] Gremlin 协议 → TinkerPop 生态    (5~6 天)
  [6] SQL 桥接 → 降低使用门槛          (3~4 天)
```

**总估值工时**: 25~34 天 | **新依赖**: 2 个 (`gremlin`, `alasql` + 复用 `ws`/`onnxruntime-node`)

### 7.4 关键竞品对比（V6 扩展后）

| 维度 | AgentiX (V5+V6) | Neo4j | Dgraph | ArangoDB | JanusGraph |
|------|:---:|:---:|:---:|:---:|:---:|
| 列式索引 | ✅ **已实现** | 行式+属性索引 | 行式 | 行式 | 行式 |
| CDC | ✅ **已实现** | CDC 企业 | 无 | Foxx | 无 |
| GNN 推理 | ✅ **已实现** | GDS 企业 | 无 | 无 | Spark 生态 |
| 多模型（图+文档+KV） | ✅ **已实现** | 纯图 | 纯图 | 多模型 | 纯图 |
| SQL 桥接 | ✅ **已实现** | 无 | 无 | 无 | 无 |
| Gremlin 协议 | ✅ **已实现** | 无 | 无 | 无 | 原生 |
| 图算法数量 | **28** (含 Node2Vec) | 50+ | 有限 | ~10 | Spark 生态 |
| 查询语言 | Cypher-lite (+CALL +SQL桥接) | Cypher 完整 | DQL | AQL | Gremlin |
| 事务隔离 | MVCC 快照 + Serializable | 完整 ACID | SSI | MVCC+OCI | 依赖后端 |
| 向量索引 | **HNSW 原生** | 企业(外挂) | 无 | 无 | 无 |
| 可嵌入性 | ✅ 纯 JS | ❌ JVM | ❌ Go | ❌ C++ | ❌ JVM |

### 7.5 落地建议（已全部完成）

> 以下 6 个方向已于 2026-06-02 全部实现，详见各 V6 设计文档和 commit 记录。

### 7.6 V6 实现摘要（2026-06-02）

| 指标 | 数值 |
|------|:----:|
| V6 方向总数 | **6**（列式索引 / CDC / GNN 推理 / Gremlin / 多模型 / SQL 桥接） |
| 关闭情况 | **6/6 GAPs ✅ 全部关闭** |
| 涉及设计文档 | 5 份（白皮书 / 技术设计 / 执行计划 / Deep Review 报告 / 进度追踪） |
| 合并 commit | `b37e717a` — v6-closure: sync 6/6 GAPs ✅ to all design docs |
