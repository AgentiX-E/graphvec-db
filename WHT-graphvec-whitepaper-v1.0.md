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
| 最新 HEAD | `6c4b6f67` |
| 闭包版本 | Deep Review V4 |
| 闭包统计 | 6 commits, 112 files, 13774 lines added |
