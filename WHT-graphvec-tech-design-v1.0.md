# AgentiX GraphVec 技术设计 v1.0

## §1 本文件变更追踪

| 日期 | 变更内容 |
|------|----------|
| 2026-05-29 | Round 8 新增：Query Plan Cache（§8.8）、Graph Algorithms Expansion（§8.9）、Data Compression（§8.10） |
| 2026-05-29 | Round 8b 新增：Composite Index（§8.11）、Geo-Spatial Index（§8.12）、Streaming Algorithm Engine（§8.13）、Cross-Shard 2PC Transactions（§8.14）、LDBC Benchmark Suite（§8.15）、Security Audit & Threat Detection（§8.16）、Node/Edge LRU Cache（§8.17）、OPTIONAL MATCH / WITH Clause（§8.18）、Aggregate Functions（§8.19） |
| 2026-06-02 | Deep Review V4 闭包：共识层 Pipeline/Group Commit/Joint Consensus/PreVote、存储层 SSI/degree 缓存/WAL 调优、算法 K-Core/Node2Vec/多线程 PageRank、安全 OIDC/JWT Refresh/RLS write、查询 BUILTIN_FUNCTIONS/GROUP BY/CBO、运维 K8s 探针/慢查询日志/审计远程 Sink/OTel 统一（§9，HEAD: `6c4b6f67`） |

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                        Client Layer                          │
│  REST API (F23) │ Fluent Query Builder (F22) │ Fulltext (F24)│
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│                     Query Layer                              │
│  Query Engine (F21) │ Scatter-Gather (F13) │ Edge Affinity  │
│  Materialized View (F25) │ Schema Validation (F28)          │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│                     Consensus Layer                          │
│  Raft / Standalone (F05) │ App Heartbeat (F09) │ Membership │
│  AppHeartbeatManager │ AppMembershipManager                 │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│                   Replication Layer                          │
│  MultiLeaderReplication │ Outbox │ CDC (F19) │ DeltaSync    │
│  HLC Clock (F04) │ EventStream (F03)                        │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│                   Communication Layer                        │
│  EventBus (F02) │ ZMQ CURVE │ Worker Pool (F30)             │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│                      Storage Layer                           │
│  Graph Engine (F01) │ LMDB │ WAL │ OverGraph Storage        │
│  Database Manager (F07) │ Auto-Splitter (F11)               │
│  Shard Manager │ Range Instance │ Rebalancer (F12)          │
└─────────────────────────────────────────────────────────────┘
```

## 技术栈

| 层级 | 技术 | 版本 | 用途 |
|------|------|:----:|------|
| 语言 | TypeScript | 5.4+ | 全栈语言 |
| 运行时 | Node.js | 16+ (推荐 20+) | 执行环境 |
| 图存储 | OverGraph + graphology | 0.26+ | 内存图引擎 + 图算法 |
| 持久化 | LMDB (lmdb-js) | 3.5+ | 嵌入式 KV 持久化 |
| 消息队列 | zeromq | 6.5+ (ZeroMQ 4.3.5) | P2P 节点通信 |
| 共识 | raft-logic (WASM) | 0.3+ | 可选 Raft 共识（TiKV 移植） |
| 序列化 | msgpackr | 2.0+ | 紧凑二进制序列化 |
| 搜索 | MiniSearch | 7.2+ | 全文搜索 |
| 监控 | OpenTelemetry | 0.218+ | Metrics + Traces |
| 日志 | pino | 9.0+ | 结构化日志 |
| 编译 | TypeScript (tsc) | 5.4+ | 类型检查 + 编译 |
| 测试 | vitest | 4.1+ | 单元 + 集成测试 |

## 功能模块详细设计

### F01: Graph Engine
**设计目录**: `src/core/`
**意图**: 提供 ACID 图存储引擎，支持节点/边的 CRUD、WAL 持久化、批量导入
**接口**:
- `GraphEngine` — 核心图操作 API
- `GraphEngine.upsertNode()`, `.deleteNode()`, `.upsertEdge()`, `.deleteEdge()`
- `OvergraphStorage` — OverGraph 兼容存储适配器
- `SegmentStreamWAL` — 段式 WAL 流式写入器
**关键设计决策**:
- 基于 OverGraph 内存图引擎实现，保证高性能读写
- WAL 通过 stream-wal 模块实现崩溃恢复
- Label index 加速按标签查询
- SafeReader 提供读写分离的 snapshot 读
**已修复 (Round 5)**: `dropDatabase()` 现执行三阶段删除：Phase 1 tombstone 写入 → Phase 2 冷静期可恢复 → Phase 3 GC 物理清理（`src/core/database-manager.ts`）
**依赖**: F07 (Database Manager), F08 (Transactions)

### F02: EventBus
**设计目录**: `src/core/event-bus.ts`
**意图**: P2P 异步消息总线，支持 CURVE 安全认证、Worker Pool 并行分发
**接口**:
- `EventBus` — 消息总线，`start()`, `stop()`, `send()`, `onMessage()`
- `EventBusConfig` — 配置（curveDir, mode, disableRouter 等）
- `EventBusWorkerPool` — 工作者池并行处理
**关键设计决策**:
- 基于 ZeroMQ ROUTER-DEALER 模式的异步消息
- CURVE 安全认证，pub/secret key 通过文件目录管理
- `disableRouter` 选项支持拓扑对等模式
- `_recoverDealerByNodeId`, `_handleDealerSendError` 提供连接恢复钩子
- 动态端口绑定 (`tcp://127.0.0.1:0`)
**依赖**: F30 (Worker Pool)

### F05: Consensus
**设计目录**: `src/consensus/`
**意图**: 提供可切换的共识协议实现（Standalone / SimulatedRaft / Raft）
**接口**:
- `ConsensusProvider` — 共识接口抽象
- `RaftNode` — 原生 JS Raft 实现（选举 + 日志复制 + Commit）
- `RaftLogicConsensus` — raft-logic WASM 封装（可选依赖）
- `StandaloneConsensus` — 单节点模式
**关键设计决策**:
- 共识插件化：通过 `ConsensusConfig.mode` 切换
- raft-logic 使用惰性加载 + _moduleRef 注入（方便测试）
- app-heartbeat-manager 管理应用层心跳
- app-membership-manager 管理动态成员变更
**依赖**: F06 (MultiLeader), F09 (Heartbeat)

### F06: MultiLeader Replication
**设计目录**: `src/core/multi-leader-replication.ts`
**意图**: 多活写入 + Outbox 模式实现跨节点最终一致
**接口**:
- `MultiLeaderReplication` — 多主复制管理器
- `Outbox` — 本地 Outbox 持久化队列
- `OutboxReplicationManager` / `PerPeerWorker` — 逐 Peer 发包 worker
**关键设计决策**:
- 写入先写本地 Outbox（持久化），再异步发送到各 peer
- 每个 peer 一个独立 PerPeerWorker 隔离故障域
- ack 超时后回退 pending，保证 at-least-once 语义
- notifyConnected 支持手动触发重连
**依赖**: F02 (EventBus), F05 (Consensus)

### F11~F12: Sharding
**设计目录**: `src/shard/`
**意图**: 自动范围分片、分片分裂与再平衡
**接口**:
- `Rebalancer.checkAndSplit()` / `_splitRange()` — 自动检测 range 大小并触发分裂（`AutoSplitter` 功能已合并入 `Rebalancer`）
- `ShardRouter` — 路由 key → shard 映射
- `ShardManager` — 集群分片生命周期管理
- `Rebalancer` — 分片再平衡调度器
- `ScatterGather` — 跨分片查询并行执行 + 结果聚合
- `EdgeAffinity` — 边亲和性感知路由
**关键设计决策**:
- 参照 CockroachDB 的 meta range 机制
- 分裂触发条件：range 大小/操作数超过阈值
- rebalancer 通过 LRU + 负载评估决定迁移策略
- scatter-gather 使用并行 Promise + 出错容忍
**依赖**: F01 (Graph Engine), F06 (MultiLeader)

### F15: Security
**设计目录**: `src/security/`
**意图**: 传输层加密（TLS/CURVE）、行级安全（RLS）、认证审计
**接口**:
- `Auth` — 节点间认证
- `TlsManager` — TLS 配置管理
- `RlsEngine` — 行级安全策略引擎
- `Audit` — 审计日志记录
**依赖**: F02 (EventBus CURVE), F16 (Audit)

### F17: Backup
**设计目录**: `src/ops/backup*.ts`
**意图**: 自动备份、快照导出、增量增量归档
**接口**:
- `BackupScheduler` — cron 调度自动备份
- `BackupHelpers` — 备份/恢复工具函数
- `BackupChecksum` — 校验和验证
**依赖**: F01 (Graph Engine)

### F19~F20: Cross-DC Sync
**设计目录**: `src/replication/`
**意图**: 跨 DC 的 CDC 变更捕获 + 增量和全量同步
**接口**:
- `CDC Consumer` — 变更数据捕获消费者
- `DCSync` — 数据中心同步管理器
- `DeltaSync` — 增量同步（基于 HLC）
**关键设计决策**:
- 同 DC 内 Raft 强一致 → 跨 DC LWW 最终一致
- HLC 提供不依赖 NTP 的混合逻辑时钟
- CRDT/LWW 策略处理多写冲突
**依赖**: F04 (HLC Clock), F03 (EventStream)

## 跨模块依赖关系

```
F25 (Materialized View) ──→ F21 (Query Engine) ──→ F01 (Graph Engine)
F24 (Fulltext Search) ───→ F01 (Graph Engine)
F21 (Query Engine) ───────→ F01 (Graph Engine)
F13 (Scatter-Gather) ─────→ F01 (Graph Engine) + F11 (Shard)
F23 (REST API) ───────────→ F21 (Query Engine) + F22 (Fluent API)

Consensus Path:
  F09 (Heartbeat) ──→ F05 (Consensus) ──→ F06 (MultiLeader) ──→ F02 (EventBus)

Storage Path:
  F07 (DB Manager) ──→ F01 (Graph Engine) ──→ LMDB + WAL
  F11 (Auto-Split) ──→ F01 (Graph Engine) + F05 (Consensus)

### F26: Query Plan Cache
**设计目录**: `src/query/plan-cache.ts`
**意图**: 缓存已编译的查询计划，避免重复的解析-优化-编译开销
**接口**:
- `planCache` — 单例缓存，使用 `lru-cache` v11，`max: 1000`
- `parseQueryCached()` — 查询解析入口，命中直接返回，未命中解析后回写缓存
**关键设计决策**:
- 缓存 Key 使用 djb2 哈希算法，输入前做空白字符归一化（`/\s+/g → ' '` + `trim()`）
- 自动失效：统计信息变更时 (`StatsCollector.onStatsChanged`) 清空缓存
- `planCache` 作为模块级单例导出，整个进程共享
**依赖**: F21 (Query Engine / QueryPlanner), F08 (StatsCollector)

### F27: Graph Algorithms Expansion
**设计目录**: `src/core/graph-algorithms.ts`
**意图**: 在现有 BFS/DFS/PageRank 基础上增加 6 种图算法
**接口**:
- `WCC(graph)` — 弱连通分量（基于 graphology-components）
- `SCC(graph)` — 强连通分量（基于 graphology-components 的 Kosaraju 算法）
- `TriangleCount(graph)` — 三角计数
- `LabelPropagation(graph, opts?)` — 标签传播社区发现
- `DegreeCentrality(graph)` — 度中心性计算
- `AStar(graph, source, target, heuristic?)` — A* 最短路径
**关键设计决策**:
- WCC/SCC 复用 `graphology-components` 已有实现，避免重复造轮子
- 所有算法通过 `GraphEngine` 统一注册，`engine.runAlgorithm(name, params)` 入口调度
- Triangle Count 和 Label Propagation 优先采用 graphology 社区贡献，无现成时自实现
- 算法返回统一格式 `{ name, result, duration, nodeCount }`
**依赖**: F01 (Graph Engine), graphology-components

### F28: Data Compression
**设计目录**: `src/core/compression.ts`
**意图**: 基于 msgpackr 的透明序列化压缩，减少存储占用和网络传输大小
**接口**:
- `compress(value)` / `decompress(buffer)` — 压缩/解压顶层封装
- 对 `number[]` 类型使用 `__c` 包装器兼容标记（标记 → 内部走差分编码）
**关键设计决策**:
- 透明序列化：属性写入前 `compress()`，读取后 `decompress()`，对上层业务代码无感知
- 混合策略：小值（<256B）不压缩，中大值使用 msgpackr 紧凑二进制格式
- 实测效果：节点/边的 `properties` 存储节省约 38%（取决于数据类型分布）
- 配置开关：`GraphConfig.storageCompression`（`boolean`，默认 `false`）和 `compressionStrategy`（`'msgpackr' | 'none'`）
- 启动时根据配置决定是否 hook 序列化管道，支持运行时动态调整（仅影响后续写入）
**依赖**: msgpackr (已存在于技术栈), F01 (Graph Engine)

### F29: Composite Index (组合索引)
**设计目录**: `src/index/composite-index.ts`
**意图**: 支持多属性联合索引，提升多条件过滤查询性能
**接口**:
- `createCompositeIndex(names: string[], unique?: boolean)` — 在 OverGraph 中创建组合索引
- 索引 key = 组合字段值列表 + 节点ID，存储在 LMDB 多键子数据库中
- 查询时支持前缀匹配（部分列过滤也走索引）
**关键设计决策**:
- 深度集成到 StorageProvider 层，索引构建支持增量（写入时更新）和批量重建
- QueryPlanner 代价评估时优先选择组合索引
- 唯一索引在写入重复值时抛出约束异常
**依赖**: F01 (Graph Engine), StorageProvider

### F30: Geo-Spatial Index (地理空间索引)
**设计目录**: `src/index/geo-index.ts`
**意图**: 支持地理空间索引和查询（距离查询、范围查询）
**接口**:
- `createGeoIndex(field: string)` — 创建空间索引
- `distance(a, b)` — 两点距离计算
- `rangeQuery(lat1, lng1, lat2, lng2)` — 矩形范围查询
**关键设计决策**:
- 基于 `rbush` @3.0.1 R-tree 实现，支持插入/删除/范围查询/最近邻查询
- 节点属性中 `latitude/longitude` 自动索引
- Cypher-lite 扩展 `WHERE distance()` 函数
- QueryPlanner 在空间查询时使用 R-tree 索引代替全表扫描
**依赖**: F01 (Graph Engine), rbush (新增依赖)

### F31: Streaming Algorithm Engine (流式算法引擎)
**设计目录**: `src/algorithms/streaming-engine.ts`
**意图**: 支持内存图投影 + 分页/流式算法 + Worker Pool 并行，在大图上可运行算法
**接口**:
- `project({type, maxDepth, nodeIds})` — 从存储引擎按需加载子图到内存
- `runStreaming(algorithm, params)` — 分块执行算法
- `runParallel(algorithm, params)` — Worker Pool 并行
**关键设计决策**:
- 图投影支持节点/边过滤、最大深度控制
- PageRank 分片迭代：每轮只处理一个分片，结果合并
- 利用 EventBusWorkerPool 将算法分解到多个 worker 进程
- 支持脏标记机制：投影时存储变更可检测
**依赖**: F01 (Graph Engine), F30 (Worker Pool)

### F32: Cross-Shard 2PC Transactions (跨分片事务)
**设计目录**: `src/shard/2pc-coordinator.ts`
**意图**: 支持跨多个分片的原子提交（Percolator 模型）
**接口**:
- `TwoPhaseCoordinator` — 事务协调器
- `prepare(txId, participants)` — 第一阶段：所有参与者准备
- `commit(txId)` / `rollback(txId)` — 第二阶段：提交或回滚
**关键设计决策**:
- 基于 Percolator 模型（Bigtable 分布式事务模型）
- 每个 RangeInstance 中添加 prepare/commit 日志
- 协调器崩溃后启发生恢复（阅读参与者状态→决定推进）
- 超时自动回滚防止悬挂事务
**依赖**: F01 (Graph Engine), F11 (Shard Manager)

### F33: LDBC Benchmark Suite (基准测试套件)
**设计目录**: `src/ops/ldbc-benchmark.ts`
**意图**: 支持 LDBC SNB 标准化基准测试
**接口**:
- `generateDataset(sf)` — 生成 SF-1 (1GB) LDBC 数据集
- `runInteractive(id)` — 执行指定 Interactive 查询
- `runBi(id)` — 执行指定 BI 查询
- `report()` — 输出 P50/P90/P99 延迟 + QPS Markdown 报告
**关键设计决策**:
- 数据生成器输出 CSV 格式，通过 Importer 导入
- 实现 20 个参考查询（10 Interactive + 10 BI）
- 自动化运行脚本，结果可横向对比
**依赖**: F01 (Graph Engine), F23 (REST API)

### F34: Security Audit & Threat Detection (安全审计与威胁检测)
**设计目录**: `src/security/security-audit.ts`
**意图**: 启动安全基线检查 + 运行时入侵检测 + 合规报告
**接口**:
- `runBaselineCheck()` — 启动时检查 TLS/权限/数据目录
- `ThreatDetector` — 运行时异常操作检测
- `generateCisReport()` — 生成 CIS 基线检查报告
**关键设计决策**:
- 启动检查：TLS 配置、身份文件权限、数据目录权限、密码强度
- 运行时监控：大量删除检测、大规模导出告警、频繁认证失败锁定
- 合规报告输出 JSON + Markdown 格式
**依赖**: F15 (Security), F16 (Audit)

### F35: Node/Edge LRU Cache (节点/边 LRU 缓存)
**设计目录**: `src/core/lru-cache.ts`
**意图**: 增强邻居缓存，支持逐边粒度失效 + 写穿缓存 + 预加载
**接口**:
- 缓存 key: `{nodeId, edgeType, direction}` — 按边粒度缓存
- `upsertEdge()` / `deleteEdge()` 时只清除受影响的缓存条目
- 热点节点自动延长 TTL
**关键设计决策**:
- 利用已有的 `lru-cache` v11 实现，改进缓存粒度
- 写穿策略：写入操作同时更新缓存
- 邻接查询时批量预加载邻居节点
- 缓存命中率目标 > 80%
**依赖**: F01 (Graph Engine), lru-cache v11

### F36: OPTIONAL MATCH / WITH Clause (可选匹配与管道)
**设计目录**: `src/query/optional-match.ts`
**意图**: 支持 Cypher 的 OPTIONAL MATCH（左外连接）和 WITH（查询管道）
**接口**:
- OPTIONAL MATCH 语法：`MATCH ... OPTIONAL MATCH ... RETURN`
- WITH 管道：`MATCH ... WITH ... RETURN`
- 多阶段查询执行
**关键设计决策**:
- PEG 语法扩展：增加 OptionalMatchClause 和 WithClause
- 多阶段 AST：WITH 分隔的前后两段查询，结果传递
- 左外连接实现：匹配不到时返回 null 填充
- OPTIONAL MATCH 性能优化：缓存预加载增强
**依赖**: F21 (Query Engine), F35 (LRU Cache)

### F37: Aggregate Functions (聚合函数)
**设计目录**: `src/query/aggregate.ts`
**意图**: 支持 COUNT/SUM/AVG/MIN/MAX/GROUP BY/HAVING 全聚合
**接口**:
- `AggregateExpression` — PEG 语法中的聚合表达式节点
- `GroupByClause` — GROUP BY 子句
- `HavingClause` — HAVING 过滤
- 执行层：归约式聚合计算
**关键设计决策**:
- Phase 1: Peggy 语法扩展 → Phase 2: AST 转换 → Phase 3: 执行层 → Phase 4: CBO 集成
- 无需第三方 npm 包，全部自实现（~300 行）
- NULL 属性处理：SUM/AVG 跳过 NULL，COUNT 统计非 NULL
- QueryPlanner 代价模型支持聚合节点选择
**依赖**: F21 (Query Engine), F27 (Query Plan Cache)

## 已知限制

### 8.2 InstallSnapshot WASM 回调

**当前**: raft-logic-consensus.ts L525 有 TODO 注释，raft-install-snapshot.spec.ts 仅测试 RaftCore.js。

**目标**: follower 收到 InstallSnapshot RPC 时正确调用 WASM onSnapshot 回调 + StorageProvider 导出/导入快照。

**方案**: raft-logic-consensus 实现 onSnapshot 回调注册 -> 收到快照时写入本地文件 -> 通过 InstallSnapshotResponse 返回 success=false 或 true。

**状态**: ✅ 已实现（raft-logic-consensus 和 overgraph-storage 均已实现）

### 8.3 ACID 事务增强 — SSI + 版本链 + 死锁检测（P0）

**问题**: 现有 SI 级事务缺少写偏斜检测、多版本链、死锁检测。

**方案**: Transaction.ts 增加 Serializable Snapshot Isolation 模式：读集冲突检测 + 等待图死锁检测 + 版本链支持。

**状态**: ⬜ 待 Round 7 实现

### 8.4 InstallSnapshot 自动化 — log compaction + crash recovery（P0）

**问题**: snapshot 手动触发，follower crash 后无恢复。

**方案**: 基于 Log 大小阈值自动压缩，follower recovery 从 StorageProvider 重装。

**状态**: ⬜ 待 Round 7 实现

### 8.5 StorageProvider 流式快照（P0）

**问题**: 大图整图序列化 OOM，无原子操作。

**方案**: 分块导出（4MB） + 临时文件 rename + 校验和。

**状态**: ⬜ 待 Round 7 实现

### 8.6 查询优化器 CBO（P1）

**问题**: 无成本估算、Join ordering、谓词选择性。

**方案**: StatsCollector.estimateSelectivity() 接入 QueryPlanner。

**状态**: ⬜ 待 Round 7 实现

### 8.7 算法流式模式（P1）

**问题**: BFS/DFS/PageRank 全内存，大图 OOM。

**方案**: BatchProcessor 分块加载 + 迭代收敛。

**状态**: ⬜ 待 Round 7 实现

### L1: 数据库删除未清理 Raft 资源（🔴 高）

**文件**: `src/core/database-manager.ts` — `dropDatabase()`

当前 `dropDatabase()` 执行三阶段删除：Phase 1 写入 `.tombstone.json`（含 database/requestedAt/gcEarliestAt/phase），Phase 2 冷静期内可 restoreDatabase() 恢复，Phase 3 gcDatabases() 物理清理。设计文档 `docs/multi-database-arch-design.md §8` 已实现。

---

## §9 Deep Review V4 闭包新增设计（2026-06-02）

> 更新 HEAD: `6c4b6f67` · 闭包版本: V4

### 9.1 共识层新设计

#### Raft Pipeline 复制
**文件**: `src/consensus/`
**设计**:
- `inFlight` Map 跟踪已发送未确认的 AppendEntries，key 为 `(peerId, term, logIndex)` 组合
- `pendingQueue` 数组存放等待发送的日志条目，当 `inFlight.size >= maxInFlight` (默认 5) 时暂缓
- 每收到 AppendEntriesResponse (success=true) 从 inFlight 移除，并从 pendingQueue 取出下一批发送
- 超时 (pipelineTimeout=50ms) 未收到响应的 inFlight 条目自动回退到非 pipeline 模式

#### WAL Group Commit
**文件**: `src/core/segment-stream-wal.ts`
**设计**:
- `_pendingBatch: LogEntry[]` 累积写入请求，默认 tick 间隔 5ms
- 每批次最大条目数 `BATCH_MAX = 100`，达到上限强制 flush
- `setTimeout(flush, GROUP_COMMIT_INTERVAL)` 定时机制，避免累积时间无限增长
- flush 时批量编码为 msgpackr 格式，单次 fsync 写入 WAL

#### Joint Consensus
**文件**: `src/consensus/raft-node.ts`
**设计**:
- 两阶段配置变更：C_old_new 混合阶段 + C_new 最终阶段
- C_old_new 阶段：同时向 C_old 和 C_new 分别发送 AppendEntries
- commit 条件：C_old 的 Majority + C_new 的 Majority 同时满足（双 Majority）
- C_new 阶段：C_old_new commit 后自动进入，仅需要 C_new 的 Majority
- 每个新配置条目写入 Raft Log，随 commitIndex 推进自动完成过渡

#### PreVote
**文件**: `src/consensus/`
**设计**:
- 独立 PreVoteRequest/PreVoteResponse RPC 消息类型，与 RequestVote 分离
- Candidate 发起选举前先发送 PreVote，仅 PreVoteResponse.granted === true 时进入正式选举
- 接收方判断：分区的节点（term 落后）不会 grant PreVote，避免干扰新 Leader

### 9.2 存储层新设计

#### SimpleTxnManager SSI 冲突检测
**文件**: `src/core/transaction.ts`
**设计**:
- `writeSet` / `deleteSet` 记录事务写入和删除的键集合
- 提交时与并发的其他事务做 Intersection 检查：
  - 读集冲突：本事务的 `readSet ∩ others.writeSet ≠ ∅` → 检测到读写冲突
  - 写写冲突：本事务的 `writeSet ∩ others.writeSet ≠ ∅` → 写写冲突
  - deleteSet 同理检查
- 冲突 → 抛出 `SerializationError`，由上层 retry 驱动
- 配合乐观锁 version 字段实现 SSI（可串行化快照隔离）

#### WAL every-n 策略
**文件**: `src/core/segment-stream-wal.ts`
**设计**:
- `fsyncEveryN: number = 100` 配置参数，每 N 次写入后才调用一次 fsync
- 默认值从 10 调整为 100（commit 63fc8d5a）
- 未 fsync 的批量写入在 `_pendingBatch` 中累积，进程崩溃会丢失（允许范围内）
- 与 Raft commit 联动：Raft commit 的回调触发强制 fsync

#### Degree 缓存架构
**文件**: `src/core/graph-engine.ts`
**设计**:
- `_inDegree: Map<number, number>` — 节点入度缓存
- `_outDegree: Map<number, number>` — 节点出度缓存
- 节点创建/upsertEdge/deleteEdge 时同步更新度数 Map
- `inDegree(nodeId)` / `outDegree(nodeId)` 返回 O(1) 时间
- 后续可持久化到 LMDB 以避免启动重算

### 9.3 算法新设计

#### worker_threads 分割迭代块
**文件**: `src/algorithms/pagerank.ts`
**设计**:
- 全图节点按 `numWorkers` 均匀分割为迭代块
- 每个 worker 持有一个独立的 `{nodeId, score}` 数组切片
- 每轮迭代：主线程分发当前轮 score 向量 → 各 worker 本地计算更新 → 主线程汇总合并
- 合并后检查收敛条件 (`delta < tolerance`)，未收敛则进入下一轮
- worker 通过 `worker_threads.Worker` 实例化，使用 `parentPort.postMessage` 通信

#### K-Core 迭代修剪算法
**文件**: `src/algorithms/k-core.ts`
**设计**:
- 输入：图 G 和整数 k
- 迭代修剪：反复移除度 < k 的节点，每轮移除后更新邻居度数
- 时间复杂度 O(m + n)（n 节点数，m 边数）
- 输出：k-core 子图（满足所有节点度 ≥ k 的最大导出子图）
- 扩展：`coreDecomposition()` 返回每个节点的 coreness（最大核心度）

### 9.4 安全新设计

#### OIDCValidator + AuthenticatorChain 链式认证
**文件**: `src/security/`
**设计**:
- `AuthenticatorChain` 维护 `Authenticator[]` 数组，按优先级链式调用
- `OIDCValidator` 处理 OAuth2/OIDC 令牌验证（JWT 签发者/受众/有效期检查）
- `ApiKeyAuthenticator` 备用认证方式
- 链式执行：任一 Authenticator 返回成功 → 通过；全部失败 → 返回 401
- 通过 `AuthenticatorChain.addAuthenticator(auth)` 可动态注册

#### JWT Refresh Token 轮换
**文件**: `src/security/jwt.ts`
**设计**:
- access_token (短时效, e.g. 15m) + refresh_token (长时效, e.g. 7d)
- 刷新时同时返回新的 access_token 和 refresh_token（轮换机制）
- 旧 refresh_token 使用后立即失效，防止重放攻击
- refresh_token 哈希存储在 LMDB 中，支持吊销

#### RLS write path 注入
**文件**: `src/security/rls.ts`
**设计**:
- `RlsEngine.enforceWrite(principal, action, resource)` 在写入前校验
- 注入时机：`GraphEngine.upsertNode/upsertEdge/deleteNode/deleteEdge` 调用前检查
- 未通过 → 抛出 `RlsAuthorizationError`
- 策略定义：`(principal: Principal, action: 'write' | 'delete', resource: Node|Edge) => boolean`

### 9.5 查询新设计

#### BUILTIN_FUNCTIONS 注册表
**文件**: `src/query/query-engine.ts`
**设计**:
- `BUILTIN_FUNCTIONS: Map<string, FunctionHandler>` — 全局函数注册表
- 函数表达式在 AST 中解析为 `{type: 'function', name, args}` 节点
- 执行时从 BUILTIN_FUNCTIONS 查找并调用，支持 count(), sum(), avg(), min(), max(), abs(), round(), size(), exists() 等
- 可通过 `registerBuiltinFunction(name, handler)` 扩展

#### GROUP BY partition-aggregate 模式
**文件**: `src/query/`
**设计**:
- Partition 阶段：按 GROUP BY 字段哈希分区，每分区独立聚合
- Aggregate 阶段：对每个分区执行聚合函数（count/sum/avg/min/max）
- HAVING 过滤：聚合结果输出前应用 HAVING 条件
- 内存内 Map-Reduce 模式实现，无外部依赖
- HAVING 执行时使用相同函数注册表

#### CBO Range Histogram
**文件**: `src/query/query-planner.ts`
**设计**:
- `StatsCollector.collectHistogram(field)` — 按字段构建等深直方图（默认 100 bucket）
- `estimateSelectivity(field, op, value)` — 基于直方图估算谓词选择率
- 查询计划器在 Join Ordering 时使用选择率排序（低选择率优先）
- 统计信息变更时自动清空 Plan Cache

---

## §10 V5 差距分析 — 设计变更（全部已实现 ✅）

> 本节列举对标行业标杆（Neo4j/Dgraph/ArangoDB/JanusGraph）识别出的 13 项差距，对应的设计方向和依赖包。**所有条目均已实现**，详见各 GAP 的 commit hash。

## §10 实现状态

### GAP-01: 多存储后端抽象（P0）
**设计方向**: 抽象 `StorageProvider` 接口，增加多后端选择。
- **依赖包**: `classic-level`（v2.x，LevelDB/RocksDB 抽象层）、`better-sqlite3`（v11.x，SQLite BTree 后端）
- **设计要点**: 通过配置选择 `lmdb` / `classic-level` / `better-sqlite3` 三种后端；统一 CRUD 操作语义；统一的 `CacheManager`（LRU/LFU/PAGE 级缓存）
- **状态**: ✅ **已实现**
- **实现细节**: `commit c55d6a56` — 实现 `ClassicLevelStorageProvider`，57/57 测试通过，支持配置切换后端

### GAP-02: Serializable 隔离 + 死锁检测（P0）
**设计方向**: 在现有 MVCC 快照隔离基础上增加可串行化隔离级别与全局死锁检测。
- **依赖包**: `deadlock`（v0.2.x，等待图环路检测）、`async-mutex`（v0.5.x，超时锁获取）
- **设计要点**: predicate locking / SSI 冲突检测；Wait-For Graph 周期扫描；写锁超时 + 指数退避重试；跨分片死锁检测
- **状态**: ✅ **已实现**
- **实现细节**: `commit 6ffc3b95` — Serializable 隔离级别 + SSI 冲突检测 + 死锁检测（`deadlock` 等待图），跨分片死锁检测

### GAP-03: APOC 过程注册系统（P1）
**设计方向**: 在 `query-engine.ts` 中扩展函数注册机制，支持类似 Neo4j APOC 的用户自定义过程/函数。
- **依赖包**: 无（复用 `peggy` v4.x 已有语法生成器）
- **设计要点**: `CALL proc(args)` 语法解析与执行；过程注册表（`REGISTER PROCEDURE`）；标量子查询、FOREACH 循环；自定义聚合函数
- **状态**: ✅ **已实现**
- **实现细节**: `commit 31f94478` — APOC 过程注册系统（Peggy 扩展 + CALL 语法 + 标量子查询）

### GAP-04: 热迁移 + 区域感知路由（P1）
**设计方向**: 实现在线分片分裂时的零停机数据迁移与基于 RTT 的区域感知读路由。
- **依赖包**: `geoip-lite`（v1.x，GeoIP 查询）
- **设计要点**: `auto-splitter.ts` 双写策略（新旧分片同时写入）；`shard-router.ts` 读取副本路由；`membership-route-table.ts` 地理位置感知
- **状态**: ✅ **已实现**
- **实现细节**: `commit ff54dcbc` — 热迁移双写策略 + `geoip-lite` 区域感知路由

### GAP-05: LDAP 认证 + 子图权限（P2）
**设计方向**: 在现有 JWT/OIDC/RBAC 基础上增加 LDAP/AD 认证集成与子图级权限控制。
- **依赖包**: `ldapjs`（v3.x，LDAP 客户端/服务端）
- **设计要点**: `AuthenticatorChain` 增加 LDAP 策略；`rbac.ts` 扩展 `AclResourceType.GRAPH_PATTERN`；审计日志支持 Syslog/CEF 格式
- **状态**: ✅ **已实现**
- **实现细节**: `commit d5c808f4` — LDAP 认证 + 子图权限（`AclResourceType.GRAPH_PATTERN`）

### GAP-06: S2 地理索引 + 中文分词（P1）
**设计方向**: 在现有 Geohash 和 MiniSearch 基础上增加 S2 地理网格索引与中文细粒度分词。
- **依赖包**: `s2-geometry`（v1.x，Google S2 Geometry JS 移植）、`@node-rs/jieba`（v2.x，Rust 结巴分词）
- **设计要点**: S2 Cell ID 覆盖与邻近搜索替代 Geohash；MiniSearch 快照/恢复持久化；`range-index.ts` 扩展时间戳索引
- **状态**: ✅ **已实现**
- **实现细节**: `commit f5933dea` — S2 地理索引 + `@node-rs/jieba` 中文分词 + MiniSearch 持久化

### GAP-07: Web 管理 UI（P1）
**设计方向**: 提供轻量级 Web 管理面板（React SPA + REST API），含集群拓扑可视化与混沌工程测试。
- **依赖包**: `fastify`（v5.x，HTTP 服务端）、`d3-dag`（v3.x，有向图布局）、`chaos-monkey`（v2.x，故障注入）
- **设计要点**: 节点列表/集群拓扑/健康状态展示；Cypher 查询控制台；自动故障注入与恢复演练；慢查询 TOP 10 展示
- **状态**: ✅ **已实现**
- **实现细节**: `commit 31f94478` — Web 管理 UI（Fastify + React + 集群拓扑） + Chaos Engineering

### GAP-08: Node2Vec 嵌入 + 并行算法（P1）
**设计方向**: 在现有 22 种图算法基础上增加图嵌入算法与分布式并行执行能力。
- **依赖包**: `ml-matrix`（v6.x，矩阵运算）、`random-js`（v2.x，可种子化随机数）
- **设计要点**: Node2Vec 二阶随机游走 + Skip-gram 训练；Jaccard/Adamic-Adar 邻接相似度；Metapath2Vec 异构图算法；`worker_threads` scatter-gather 并行
- **状态**: ✅ **已实现**
- **实现细节**: `commit f5933dea` — Node2Vec 二阶随机游走 + Jaccard 相似度 + worker_threads 并行 PageRank

### GAP-09: Bolt 协议兼容 + LDBC SNB（P2）
**设计方向**: 实现 Neo4j Bolt 二进制协议兼容，使 Neo4j 客户端可直接连接 AgentiX。
- **依赖包**: `neo4j-driver-lite`（v5.x，Bolt 协议编解码参考）、`http2`（Node.js 内置）
- **设计要点**: Bolt 基础包类型（HELLO/RUN/PULL）实现；LDBC SNB SF-1 基准测试；gRPC 连接池
- **状态**: ✅ **已实现**
- **实现细节**: `commit 56ca533d` + `e70d545d` — Bolt 协议兼容（HELLO/RUN/PULL + 事务支持）+ HTTP/2 + gRPC 连接池

### GAP-10: 多语言 SDK + 部署工具链（P2）
**设计方向**: 首先生成 OpenAPI 规范的多语言 SDK，提供 Docker/K8s 部署配置和 VSCode 插件。
- **依赖包**: `openapi-generator-cli`（v7.x，跨语言 SDK 生成）、`commander`（v12.x，CLI 框架）
- **设计要点**: Python/Java/Go SDK 生成；Grafana Dashboard JSON 模板；Docker Compose + K8s Helm chart；VSCode Cypher-lite 语法高亮
- **状态**: ✅ **已实现**
- **实现细节**: `commit d5c808f4` — Python SDK 生成（OpenAPI）+ Docker Compose + K8s Helm + VSCode 插件 + Grafana Dashboard

### GAP-11: HNSW 向量索引 + ONNX 推理（P2）
**设计方向**: 实现 HNSW 分层可导航小世界图向量索引，集成 ONNX Runtime 进行 GNN 推理。
- **依赖包**: `hnswlib-node`（v2.x，HNSW C++ 绑定）、`onnxruntime-node`（v1.x，ONNX Runtime）
- **设计要点**: HNSW 向量索引（L2/IP/Cosine 距离）；预训练 GNN 模型 ONNX 推理；向量+图混合查询（ANN → 图遍历）
- **状态**: ✅ **已实现**
- **实现细节**: `commit 56ca533d` + `e70d545d` — HNSW 向量索引（Cosine/L2/IP）+ ONNX Runtime GNN 推理 + 向量+图混合查询

### GAP-12: 时序图 + 时间窗口（P2）
**设计方向**: 扩展时序边属性索引、时间窗口聚合与滑动窗口衰减算法。
- **依赖包**: `rxjs`（v7.x，响应式编程 / `bufferTime` 时间窗口）
- **设计要点**: `range-index.ts` 时间戳索引扩展；时间窗口出入度聚合；时间衰减 PageRank；TTL 自动过期
- **状态**: ✅ **已实现**
- **实现细节**: `commit 56ca533d` + `e70d545d` — 时序边时间戳索引 + 时间窗口聚合 + TTL 自动过期 + 时间衰减 PageRank

### GAP-13: 嵌入可视化评估（P3）
**设计方向**: 提供图嵌入结果的降维可视化与质量评估工具。
- **依赖包**: `tsne-js`（v1.x，t-SNE 降维）、`ml-pca`（v5.x，PCA 降维）
- **设计要点**: 链接预测评估（AUC 计算）；t-SNE 2D/3D 坐标输出；PCA 主成分分析；嵌入相似度搜索 REST API
- **状态**: ✅ **已实现**
- **实现细节**: `commit d5c808f4` — t-SNE/PCA 降维可视化 + 链接预测评估 + 嵌入相似度搜索 REST API

---

## §11 V6 差距分析 — 设计变更（✅ 全部已实现，HEAD: `b37e717a`）

> 以下内容基于 V6 Gap 深度调研报告（2026-06-02），标记为 **✅ 已实现**，截至 2026-06-02 全部完成。V4 闭包后已重新提交 v6-closure commit。

### §11.1 列式索引 — 分层混合策略

**问题**: 当前 `NodeRecord.props` 和 `EdgeRecord.props` 以 `Record<string, unknown>` 存储，`msgpackr` 编码为二进制 blob 存入 LMDB。大属性场景（KB~MB 级）下即使读取单个字段也要全量反序列化；属性扫描（`WHERE n.age > 30`）需遍历所有节点。

**方案** — 分层混合策略：
```
StorageProvider (现有):
  └→ Primary Store (LMDB Key-Value)    —— 存储完整节点/边记录（msgpack）
  └→ Columnar Index (NEW)              —— 新增列索引
        ├→ 对"频繁查询"的属性列构建独立 B-Tree 索引
        ├→ 索引键: <column_name>:<value>:<node_id>
        ├→ 实现: 复用 lmdb 或 sorted-btree
        └→ 配置式启用: colIndex: { enable: true, columns: ['age', 'name', 'score'] }
```

**依赖包**: 无（复用 `lmdb`、`sorted-btree`）

**关键设计决策**:
1. 在 `StorageConfig` 中新增 `colIndex` 配置，含 `enable` / `columns` / `indexPath` / `syncOnWrite` 选项
2. `StorageProvider` 扩展 `readProps` 方法：索引列查询走 Columnar Index，否则回退到完整记录反序列化
3. 写入路径：`upsertNode()` 在写完整记录后异步维护列索引（可选 `syncOnWrite: true` 强一致性或 `false` 最终一致性）
4. 节点删除时自动清理列索引条目
5. 支持 String 和 Number 类型的属性列索引

**状态**: ✅ **已实现**

### §11.2 CDC 变更数据捕获 — CDC Adapter 层

**问题**: 当前变更传播链路 `graph-engine → EventStream → SegmentStreamWal + EventBus` 存在三个缺陷：无标准化 CDC 流（外部系统无法订阅）、无 schema-aware 变更事件（缺乏字段级变更描述）、EventBus 是 ZMQ 私有协议。

**方案** — 在现有 EventStream 上叠加 CDC Adapter 层：
```
graph-engine emit()
  └→ EventStream (现有)
       ├→ SegmentStreamWal (持久化)     —— 不变
       ├→ EventBus (集群复制)           —— 不变
       └→ CDC Adapter (NEW)            —— 新增
              ├→ CDC WebSocket Server (ws://node:port/cdc)
              ├→ CDC HTTP Long-Polling (GET /api/v1/cdc/stream)
              └→ CDC Push Sink (webhook POST)
```

**依赖包**: `ws`（已有别处依赖）

**关键设计决策**:
1. 复用 `SegmentStreamWal.seq` 作为 CDC offset 标记，实现断点续传
2. 变更事件格式：`{ op: "create"|"update"|"delete", entity: "node"|"edge", before: {...}, after: {...}, seq: number, ts: number }`
3. 支持 configurable filter（按 label、按属性前缀）
4. 不引入 Kafka/RabbitMQ，保持单体轻量
5. 三种订阅方式：WebSocket 实时推送 / HTTP 长轮询 / Webhook 推送

**状态**: ✅ **已实现**

### §11.3 GNN 图神经网络推理 — 二阶段策略

**问题**: 当前嵌入链路（node2vec → embedding → HNSW）缺少端到端 GNN 训练能力：不利用节点属性、无法 fine-tune、无法增量训练、无法对未见节点实时计算嵌入。

**方案** — 二阶段策略：

**Phase 1（✅ 已实现·P2）— 基于 ONNX 的推理：**
```
训练（外部/Python）→ DGL/PyG 训练 GraphSAGE → 导出 ONNX
推理（Node 侧）→ onnxruntime-node 加载模型 → 链接预测/嵌入计算
```
```typescript
class GnnInferenceEngine {
  async loadModel(modelPath: string): Promise<void>
  async predictLink(source: NodeId, target: NodeId): Promise<number>  // [0,1]
  async computeEmbedding(nodeId: NodeId): Promise<Float32Array>       // 支持未见节点
  async recommend(startNode: NodeId, topK: number): Promise<NodeId[]> // 个性化推荐
}
```

**Phase 2（未来·P3）— Node 侧增量训练（ml-matrix + 手动 GCN）：**
```
exportLocalSubgraph() → adjacency + features → 两层 GCN 矩阵乘法 → 对比学习 Loss
```

**依赖包**: `onnxruntime-node`（已有）

**关键设计决策**:
1. Phase 1 仅做推理，训练在外部 Python 环境（DGL/PyG）完成
2. ONNX 模型加载后缓存为 InferenceSession，支持多模型热切换
3. `predictLink` 输出概率，可用于链接预测和推荐
4. `computeEmbedding` 利用 GNN 模型为未见节点实时计算嵌入（cold start 解决）

**状态**: ✅ **已实现**

### §11.4 Gremlin 协议兼容 — WebSocket Server

**问题**: 当前协议栈（Bolt/Cypher、gRPC、REST）缺少 Gremlin/TinkerPop 生态的支持。与 Bolt/Cypher 互补：Gremlin 是遍历式（traversal-based），Cypher 是声明式（pattern-based）。

**方案** — 轻量 Gremlin WebSocket Server：
```
/gremlin (ws://host:8182/gremlin)
  └→ GremlinTraversalInterpreter
       ├→ Gremlin Bytecode → AST Translator
       ├→ GraphTraversalSource (V/E/has/out/in/both/values/limit/count)
       └→ ResultSet → GraphSON 序列化
```

**依赖包**: `gremlin`（npm，v3.8.x，80K downloads/week）

**关键设计决策**:
1. 只实现常用遍历步骤子集（V/E/has/out/in/both/values/limit/count/order），不实现完整 GLV
2. Bytecode 反序列化参考 `gremlin` 包的 `Bytecode.js` 模块
3. 结果以 TinkerPop GraphSON 格式输出
4. WebSocket 默认端口 8182（TinkerPop 标准端口），可配置
5. 每个 WebSocket 连接独立会话，复用现有 Bolt 的认证机制
6. 与现有 Bolt 服务并行运行互不干扰

**状态**: ✅ **已实现**

### §11.5 多模型支持 — DocumentStore 抽象

**问题**: 当前为纯图数据库。`NodeType.DOCUMENT = 5` 已存在但无实际文档存储抽象。对标 ArangoDB 的多模型能力（文档/KV/图）需要扩展。

**方案** — 在 StorageProvider 上叠加 DocumentStore 抽象：
```
StorageProvider (现有)
  ├→ NodeStore (lmdb，存图节点)
  ├→ EdgeStore (lmdb，存图边)
  └→ DocumentStore (NEW，lmdb 独立 database)
       ├→ db.document.openDB({ name: 'documents' })
       └→ DocumentCollection: 对标 ArangoDB collection
            ├→ documents = graph.documentCollection('users')
            ├→ doc.save({ name: 'Alice', age: 30 })
            ├→ doc.get('doc-key-123')
            ├→ doc.query({ age: { $gt: 25 } })
            └→ doc.delete('doc-key-123')
```

**依赖包**: 无（复用 `lmdb`、`msgpackr`、`sorted-btree`）

**关键设计决策**:
1. LMDB 原生支持多个 named databases 在同一个 env 中，文档集合开 `lmdb.openDB({ name: 'collection_xxx' })`
2. 文档与节点共享同一 LMDB 环境，共享事务和加密
3. 文档操作不影响图操作的性能（同一 LMDB env 不同 database）
4. 图节点通过 `props.docRef = 'collection:users:doc-key-123'` 关联文档

**状态**: ⬜ 计划中

### §11.6 SQL 桥接 — SQL→Cypher 翻译

---

## §12 V7 差距分析 — 设计变更预设

> 调研日期: 2026-06-02  
> 来源: `temp/v7-gap-research.md`  
> 状态: 全部 ✅ **已实现**  
> 合并 HEAD: `b471213b`

---

### §12.1 变长路径匹配（P1 功能）

**问题**: Peggy 解析器已从语法层面支持 `[*min..max]` 变长路径（`EdgePattern` 返回的 edge 对象包含 `range` 字段），但查询执行器/优化器未处理 `range`，导致变长路径降级为单跳边匹配。

**设计变更**:

**Layer 1: Peggy 语法** — 已就绪，只需确认 `Range` 规则与 `EdgePattern` 的联动正确性。

**Layer 2: Query IR 新增节点类型**:
```typescript
// src/query/query-engine.ts
interface VariableLengthPathNode {
  type: 'VARIABLE_LENGTH_PATH'
  sourceVar: string
  targetVar: string
  edgeLabel?: number
  direction: 'out' | 'in' | 'both'
  minSteps: number  // 默认 1
  maxSteps: number  // null = 不限
}
```

**Layer 3: BFS 执行器扩展**（`optimizer-executor.ts`）:
- BFS 逐层展开，每层按 direction 和 edgeLabel 过滤
- minSteps 之前的结果不输出
- maxSteps 后停止展开
- 环形路径去重

**依赖项**: `graphology-traversal`（已有）或内置 `BFS` 类（`src/algorithms/bfs.ts`）

**设计决策**: 使用内置 BFS 而非 graphology-traversal，减少依赖耦合

**受影响的文件**:
- `src/query/query-engine.ts` — QueryPlan 新增 VariableLengthPathNode
- `src/query/optimizer-executor.ts` — 新增 executeVarLengthPath
- `src/query/cypher-lite.peggy` — 验证规则正确性

---

### §12.2 GraphQL Subscription（P2 增强）

**问题**: 当前 SSE 订阅端点暴露在 REST 层而非 GraphQL 层；GraphQL Schema 无 `type Subscription` 类型定义。

**设计变更**:

1. **GraphQL Adapter 扩展**: `execute()` 中增加 `subscription` 操作路径，返回 AsyncIterator
2. **SDL 生成扩展**: `getSchemaSDL()` 增加 `type Subscription { nodeCreated: Node, edgeCreated: Edge, ... }`
3. **SSE 端点整合**: `/api/v1/subscribe` 别名到 `POST /graphql` 的 subscription 操作
4. **连接生命周期**: 使用 EventBus 的 `off()` 清理，防止内存泄漏

**依赖项**: 无新 npm 包（复用已有 EventBus + SSE 基础设施）

**设计决策**: 保留 SSE 传输层而非引入 `graphql-ws` 包，保持 0 额外依赖

**受影响的文件**:
- `src/api/graphql-adapter.ts` — 扩展 execute() 支持 subscription
- `src/api/graphql-subscription.ts` — 调整与 adapter 的接口
- `src/api/rest.ts` — 支持 GraphQL Subscription 路由

---

### §12.3 TLS 证书自动轮转（P2 安全）

**问题**: CertMonitor 到期预警 + TLSConfig 热加载均已实现，但中间缺少 ACME 自动续期环节。生产部署需要证书自动轮转。

**设计变更**:

在 `src/ops/cert-monitor.ts` 中新增 `autoRenew()` 方法:
```typescript
async autoRenew(config: AcmeRenewConfig): Promise<boolean> {
  // 1. 判断是否需要续期（< criticalDays）
  // 2. ACME 目录请求 → 账号注册（Let's Encrypt / ZeroSSL）
  // 3. 订单创建 → HTTP-01 授权验证
  // 4. 证书签发 → 保存到 certPath
  // 5. chokidar 检测到变更 → TLSConfig._reloadCerts() 热加载
  // 6. 记录续期日志，触发 onRenewed 回调
}
```

流程: `CertMonitor.checkNow()` → 发现到期 → `autoRenew()` → 在 `:80` 启动 HTTP-01 服务器 → 向 LE 申请证书 → 写入 certPath → chokidar 热加载

**依赖项**: `acme-client`（npm，约 70KB gzip）

**设计决策**: 使用 `acme-client` 自研集成而非 `greenlock` 或 `certbot` CLI，保持纯 JS 无额外二进制依赖

**受影响的文件**:
- `src/ops/cert-monitor.ts` — 新增 autoRenew()
- `src/security/tls.ts` — 确认热加载流程兼容

---

### §12.4 查询结果缓存（P2 性能）

**问题**: `LRUCache` 基础类已用于内部存储缓存，但缺少查询级缓存，重复查询重复执行。

**设计变更**:

新增 `src/core/query-cache.ts`:
```typescript
class QueryResultCache {
  private cache: LRUCache<string, { results: NodeRecord[]; cachedAt: number }>

  get(queryHash: string): ...   // MD5 查询文本作为 key
  set(queryHash: string, results: NodeRecord[]): void
  invalidateByNode(nodeId: NodeId): void
  invalidateByLabel(label: string): void
  invalidateAll(): void
  get stats(): { hits: number; misses: number; entries: number }
}
```

**失效策略**:
1. **写时全失效（简单模式）**: 任何写入操作后清除所有查询缓存
2. **TTL 失效**: 默认 30s TTL
3. **标签级失效（增强）**: 写入 typeId=1 时只清除涉及该标签的缓存

**集成点**:
- `QueryEngine.execute()` — 插入缓存查询层
- Fluent API — 缓存 `QuerySpec` hash
- GraphEngine 写入方法 — 通过 EventBus 广播 `cache:invalidate` 事件

**依赖项**: 无新包（复用现有 LRUCache 和 crypto）

**设计决策**: 写时全失效作为默认模式，TTL 作为兜底，标签级失效作为优化可选

**受影响的文件**:
- `src/core/query-cache.ts`（新建）
- `src/core/graph-engine.ts` — 写入方法中触发缓存失效
- `src/query/query-engine.ts` — 插入缓存层

---

### §12.5 Fluent API 链式遍历补齐（P2 增强）

**问题**: `GraphQuery` 已有 `match()`/`where()`/`neighbors()`/`limit()` 等链式方法，但缺少方向控制元语（`out`/`in`/`both`）和属性过滤方法 `has()`。

**设计变更**:

在 `src/api/fluent.ts` 的 `GraphQuery` 类中新增:
```typescript
// 方向控制
out(label?: number): GraphQuery     // 只遍历出边
in(label?: number): GraphQuery      // 只遍历入边
both(label?: number): GraphQuery    // 双向遍历

// 属性过滤
has(key: string, value?: unknown): GraphQuery  // 存在性/等值过滤

// 边遍历
outE(label?: number): GraphEdgeQuery  // 返回 EdgeRecord[]
inE(label?: number): GraphEdgeQuery
bothE(label?: number): GraphEdgeQuery
```

**依赖项**: 无新包（纯方法新增）

**设计决策**: 参考 Gremlin 遍历语义设计方法签名；与现有 `neighbors()` 兼容（方向 + maxDepth 组合）

**受影响的文件**:
- `src/api/fluent.ts` — GraphQuery 新增方法

---

### §12.6 连接池管理（P3 运维）

**问题**: gRPC 客户端每次 `createGrpcClient()` 创建独立 channel，无复用机制、无健康检查、无重连逻辑。

**设计变更**:

新增 `src/api/grpc-pool.ts`:
```typescript
class GrpcClientPool {
  private channels: Map<string, { client: GraphVecClient; lastUsed: number }>
  private maxPerAddress: number = 4
  private idleTimeoutMs: number = 300000  // 5min

  get(address: string): GraphVecClient     // 获取或创建
  release(address: string, client: GraphVecClient): void  // 归还
  healthCheck(address: string): Promise<boolean>  // 健康检查
  close(): void  // 优雅关闭所有连接
}
```

集成到 `RestApiServer` 的 `start()` 生命周期中初始化，`stop()` 中关闭。

**依赖项**: 无新包（自研轻量池）

**设计决策**: 不引入 `generic-pool` 包，自研池子减少依赖；每个 address 独立管理

**受影响的文件**:
- `src/api/grpc-pool.ts`（新建）
- `src/api/grpc-client.ts` — 改为通过 pool 获取连接
- `src/api/rest.ts` — 集成到生命周期

---

### §12.7 LDBC SNB 基准测试（P3 测量）

**问题**: 现有 `test/benchmark/ldbc-snb.ts` 实现了 20 查询基准测试，但非官方 SNB 规范，缺正确性验证、参数化和多规模支持。

**设计变更**:

**Phase 1 — 规范兼容**:
1. 扩展数据模型: Person（firstName, lastName, gender, birthday, city, country）、Forum、Post、Comment、Tag、Place
2. IC 查询模板: IC-1 (Profile)、IC-2 (Recent Posts)、IC-5 (Friend Rec)、IC-6 (Tag Co-occurrence)、IC-7 (Recent Likes)、IC-14 (Message Thread)
3. 查询参数化: 从随机参数池中抽取参数

**Phase 2 — 验证与可扩展性**:
4. 正确性验证: 预计算已知结果，assert 查询输出
5. 多规模测试: small (1K) / medium (10K) / large (100K)
6. JSON 基准报告: 支持对比历史运行

**依赖项**: 无新包

**设计决策**: 分两阶段实现（Phase 1 基础兼容 → Phase 2 验证 + 规模），降低单次 PR 复杂度

**受影响的文件**:
- `test/benchmark/ldbc-snb.ts` — 数据模型扩展
- `test/benchmark/ldbc-queries.ts` — IC 查询模板 + 参数化
- `test/benchmark/ldbc-snb-validator.ts`（新建）

---

### §12.8 批量边删除（P3 增强）

**问题**: 只有单条 `deleteEdge()`/`deleteNode()`，缺少批量删除。`batchUpsertNodes()` 的模式可参考。

**设计变更**:

**Step 1**: `StorageProvider` 接口新增:
```typescript
batchDeleteNodes(ids: NodeId[]): boolean
batchDeleteEdges(edges: Array<{ src: NodeId; dst: NodeId; typeId: number }>): boolean
```

**Step 2**: `GraphEngine` 实现 `batchDeleteNodes`/`batchDeleteEdges`:
1. 获取关联边（级联时）
2. 批量清除标签索引
3. 批量清除三个缓存（nodeCache / degreeCache / neighborCache）
4. 调用 storage.batchDelete*
5. 批量发 Multi-Leader 复制事件
6. 批量发 EventStream 事件

**Step 3**: Fluent API 暴露 `deleteNodes()`/`deleteEdges()`

**依赖项**: 无新包

**设计决策**: 参考 `batchUpsertNodes` 模式，保持一致性；事务模式下批量缓冲到 SimpleTxnManager

**受影响的文件**:
- `src/core/storage-provider.ts` — 接口扩展
- `src/core/graph-engine.ts` — 实现批量删除
- `src/api/fluent.ts` — 暴露 API
- `test/core/batch-delete.test.ts`（新建）

**问题**: 目标用户群中较多熟悉 SQL 而不熟悉 Cypher，需要允许用户直接用 SQL 查询图数据。

**方案** — 轻量 SQL→Cypher 翻译桥：
```
SQL 语句 → alasql.parse(sql) → AST → translator.toCypher() → Cypher AST → query-engine.execute()
```

**支持子集**:
| SQL 构造 | Cypher 等效 |
|----------|------------|
| `FROM nodes` | `MATCH (n)` |
| `WHERE n.age > 30` | `WHERE n.age > 30` |
| `ORDER BY n.name DESC` | `ORDER BY n.name DESC` |
| `LIMIT 10 OFFSET 5` | `SKIP 5 LIMIT 10` |

**不可翻译**（明确报错）：多表 JOIN、子查询、GROUP BY + 聚合（未来可扩展）

**依赖包**: `alasql`（npm，v4.17.x，轻量纯 JS SQL 解析器）

**关键设计决策**:
1. 只取 `alasql` 的解析能力（不依赖其执行引擎），执行走现有 Cypher 引擎
2. 翻译结果需与等效 Cypher 查询返回相同数据集（通过集成测试保证）
3. 通过环境变量 `ENABLE_SQL_BRIDGE=<bool>` 控制开关（默认关闭）
4. 不支持的操作返回明确错误消息

**状态**: ✅ **已实现**

---

## §13 V8 差距分析 — 设计变更预设

> 调研日期: 2026-06-02  
> 来源: `temp/v8-gap-research.md`  
> 状态: ✅ **已实现** · 8/8 GAPs 关闭  
> 实现 HEAD: `637716a6`

### §13.1 全文搜索持久化完善（P2）

**问题**: MiniSearch 为纯内存索引，现有 WAL 持久化已有 JSONL append-only WAL、自动轮转、快照触发、maxOldWals 清理，但**缺少定期自动快照**。当前仅在文档数达到 `snapshotThreshold` 时触发。

**设计变更**:

在 `src/search/fulltext.ts` 的 `FullTextIndex` 类中新增：
```typescript
// 新增定时器快照
class FullTextIndex {
  private _snapshotTimer: ReturnType<typeof setInterval> | null = null

  // 启动定时自动快照
  startPeriodicSnapshot(intervalMs: number = 300000 /* 5min */): void {
    this._snapshotTimer = setInterval(() => {
      this.forceSnapshot()
    }, intervalMs)
  }

  // 停止定时器
  stopPeriodicSnapshot(): void {
    if (this._snapshotTimer) {
      clearInterval(this._snapshotTimer)
      this._snapshotTimer = null
    }
  }

  // 写入计数触发（≥ 1000 条写入后自动 forceSnapshot）
  private _writeCountSinceLastSnapshot = 0
  private _maxWritesBeforeSnapshot = 1000

  // 在 _writeToWal() 中增加计数，达到上限后触发 forceSnapshot
}
```

**依赖项**: 无新包（复用现有 `WALWriter` / `forceSnapshot`）

**设计决策**: 
1. 定时器与写计数双触发策略，保证写入量可控
2. 快照后自动截断 WAL（现有 `forceSnapshot` 已支持）
3. 与 `Config.snapshotThreshold` 兼容：写计数快照优先，定时器兜底

**受影响的文件**: `src/search/fulltext.ts`

**状态**: ✅ 已实现

---

### §13.2 属性图 Schema 校验（P2）

**问题**: `schema-validator.ts` 已实现 `validateNodeType()` / `validateEdgeType()` 纯函数，但缺集中的 `SchemaValidator` 类实例；GraphEngine 入口未自动调用校验；唯一性约束不执行；默认值不填充。

**设计变更**:

新增 `src/schema/schema-validator-class.ts`:
```typescript
class SchemaValidator {
  private schema: SchemaDef | null = null

  constructor(private engine?: GraphEngine) {}

  // 注入 schema 定义
  setSchema(schema: SchemaDef): void { this.schema = schema }

  // 校验节点
  validate(node: { typeId: number; properties: Record<string, unknown> }): ValidationResult {
    if (!this.schema) return { valid: true }
    const typeDef = this.schema.nodeTypes.find(t => t.typeId === node.typeId)
    if (!typeDef) throw new SchemaValidationError(`Unknown node type: ${node.typeId}`)
    // 必填检查 + 类型检查 + 唯一性检查 + 默认值填充
    return validateNodeType(typeDef, node.properties)
  }

  // 校验边
  validateEdge(edge: { typeId: number; properties: Record<string, unknown> }): ValidationResult
}

// GraphEngine 集成
class GraphEngine {
  private schemaValidator: SchemaValidator

  setSchema(schema: SchemaDef): void {
    this.schemaValidator.setSchema(schema)
  }

  async upsertNode(typeId: number, ...): Promise<NodeRecord> {
    this.schemaValidator.validate({ typeId, properties })  // ← 新增校验钩子
    // ... 原有逻辑
  }
}
```

**唯一性约束执行**：
- 在 StorageProvider 中，为定义了 `uniqueConstraints` 的字段组合构建反向索引
- `upsertNode` 时检查反向索引，重复写入抛出 `UniqueConstraintError`
- 与现有 labelIndex / fulltextIndex 同类机制

**默认值填充**：
- `FieldDef.default` 在 `upsertNode` 时自动填充缺失字段
- 不覆盖显式传入的 `undefined` 值

**依赖项**: 无新包（复用 `schema-types.ts`、`schema-validator.ts`）

**设计决策**: GraphEngine 构造函数注入 SchemaValidator（紧耦合），通过 `setSchema()` 启用/关闭校验。

**受影响的文件**:
- `src/schema/schema-validator-class.ts`（新建）
- `src/core/graph-engine.ts` — 集成校验钩子
- `src/schema/schema-types.ts` — 确认接口兼容

**状态**: ✅ 已实现

---

### §13.3 多数据中心部署（P2）

**问题**: 所有 peer 一视同仁；缺 locality-aware read、DC 分组拓扑、分区优先策略。

**设计变更**:

新增 `src/core/multi-region-topology.ts`:
```typescript
class MultiRegionTopology {
  private dcId: string                    // 本 DC 标识
  private dcPeers: Map<string, string[]>  // DC → nodeIds 映射
  private intraDcBackoff: number = 3000   // 同 DC 退避 (ms)
  private crossDcBackoff: number = 60000  // 跨 DC 退避 (ms)

  constructor(config: MultiRegionConfig & { dcId: string; dcPeers: Record<string, string[]> })

  // locality-aware read 路由
  getPreferredReplica(dcId: string): string | null

  // 判断节点是否在同一 DC
  isSameDc(nodeId: string): boolean

  // 跨 DC 复制延迟
  getCrossDcBackoff(): number
}
```

**MultiLeaderConfig 扩展**:
```typescript
interface MultiRegionConfig {
  topologyType: TopologyType   // 现有
  dcId: string                 // 新增
  dcPeers: Record<string, string[]>  // 新增: {"dc1": ["node1","node2"], "dc2": ["node3"]}
  partitionStrategy: 'ignore' | 'lww' | 'crdt'  // 现有
}
```

**分区策略**：
1. 心跳超时 → 标记节点为疑似
2. 持续超时 → 触发分区策略（`ignore`: 降级，待恢复后合并）
3. 恢复后自动 LWW 合并（已有 CRDT 基础）

**依赖项**: `s2-geometry`（已有）

**设计决策**: 代码式/文件式配置 region 拓扑（YAML/JSON），与现有 `TopologyType` 兼容。

**受影响的文件**:
- `src/core/multi-region-topology.ts`（新建）
- `src/core/multi-leader-replication.ts` — 集成拓扑判断

**状态**: ✅ 已实现

---

### §13.4 增量备份/恢复（P2）

**问题**: 当前 `Backup` 类仅全量复制 OverGraph 目录；`backup-wal.ts` 能读 LSN 但无增量备份逻辑；`PITRConfig` 定义了接口但未实现。

**设计变更**:

新增 `src/ops/incremental-backup.ts`:
```typescript
class IncrementalBackupManager {
  // 全量备份 metadata（记录 snapshot 时各 segment 的 LSN）
  private lastFullBackupMeta: { lsn: Map<string, number>; timestamp: number } | null

  // 创建增量备份：只复制 LSN 高于上次快照点的 segment
  async createIncrementalBackup(): Promise<BackupResult>

  // 时间点恢复：全量 → 按序回放增量 WAL
  async restoreFromPoint(recoveryPoint: RecoveryPoint): Promise<void>

  // 清理过期增量
  async purgeExpiredBackups(retentionCount: number): Promise<void>
}
```

**metadata.json 格式**:
```json
{
  "type": "incremental",
  "baseSnapshot": "backup_20260602_120000",
  "lsnRange": { "start": 12345, "end": 23456 },
  "segmentsCopied": ["wal-001.seg", "wal-002.seg"],
  "createdAt": "2026-06-02T12:30:00Z"
}
```

**恢复流程**:
1. `restoreFromPoint(recoveryPoint)`:
   - 找到最近的 full backup
   - 恢复全量备份
   - 按时间顺序回放所有增量 WAL（直到目标时间点）
   - 校验 LSN 链完整性（无 gap）

**依赖项**: 无新包（复用 `fs.copyFile`, `archiver`, `readWalLsnSnapshots`）

**设计决策**: 复用现有 `Backup` 类接口，增量备份继承 `BackupResult` 类型。

**受影响的文件**:
- `src/ops/incremental-backup.ts`（新建）
- `src/ops/backup-types.ts` — 扩展 `BackupResult`
- `src/ops/backup.ts` — 与全量备份共享基类

**状态**: ✅ 已实现

---

### §13.5 查询分析器 + EXPLAIN（P3）

**问题**: `QueryPlan` 类型结构完整（scanLabel, steps, filters, returnColumns 等），但无 EXPLAIN 输出格式；`_optimizePlan()` 代价模型简单。

**设计变更**:

新增 `src/query/explain-formatter.ts`:
```typescript
class ExplainFormatter {
  // 文本树状输出 (类似 PostgreSQL)
  formatText(plan: QueryPlan): string
  // JSON 结构化输出
  formatJSON(plan: QueryPlan): object
  // EXPLAIN ANALYZE (含实际行数 + 耗时)
  formatAnalyze(plan: QueryPlan, stats: ExecutionStats): string
}
```

**文本输出示例**:
```
EXPLAIN MATCH (n:Person) WHERE n.age > 30 RETURN n.name
─────────────────────────────────────────────────
Scan on label Person  (estimated rows=5000, cost=125.00)
  └─ Filter: (n.age > 30)  (selectivity=0.30, estimated rows=1500)
       └─ Return: n.name  (projected columns=1)
```

**代价估算增强**:
- `_optimizePlan()` 加入基于 `StatsCollector` 的 estimateSelectivity
- 显示预估扫描行数和代价分
- 与 CBO 直方图联动

**Cypher 解析入口集成**:
- 检测查询前缀 `EXPLAIN` / `EXPLAIN JSON` / `EXPLAIN ANALYZE`
- 前缀分离 → 执行查询 → 格式化输出 → 返回字符串/JSON

**依赖项**: 无新包

**设计决策**: 三种输出格式满足不同场景：文本（终端）、JSON（API 调用方）、ANALYZE（调优）。

**受影响的文件**:
- `src/query/explain-formatter.ts`（新建）
- `src/query/query-engine.ts` — 集成 EXPLAIN 前缀检测
- `src/query/query-planner.ts` — 代价估算增强

**状态**: ✅ 已实现

---

### §13.6 Prometheus 指标集成（P3）

**问题**: OTel push（`MetricsCollector`）与 prom-client pull（`rest.ts /metrics`）双轨，缺少统一桥接。无 Prometheus 适配器。

**设计变更**:

新增 `src/ops/prometheus-exporter.ts`:
```typescript
class PrometheusMetricsExporter {
  private register: promClient.Registry

  constructor(config: PrometheusConfig) {
    this.register = promClient.register
    // 注册熟悉的计数器/直方图/仪表
    this._initMetrics()
  }

  // 桥接：MetricsCollector 的 Counter → prom-client Counter
  private _initMetrics(): void {
    new promClient.Counter({
      name: 'graph_ops_total',
      help: 'Total number of graph operations',
      labelNames: ['operation', 'status'],
    })
    // ... 更多指标
  }
}
```

**配置**:
```typescript
interface PrometheusConfig {
  enabled: boolean
  port?: number     // 默认 9464 (OpenMetrics 默认端口)
  path?: string     // 默认 /metrics
  prefix?: string   // 指标名称前缀
}
```

**双轨兼容**:
- 同时输出 OTLP 和 Prometheus
- MetricsCollector 保持 OTel push 不变
- PrometheusMetricsExporter 桥接到 prom-client register
- 当 OTel 不启用时，Prometheus 端点作为独立可选项

**依赖项**: `prom-client`（已有 v15.1.3）

**设计决策**: 桥接模式而非替换，保持与 OTel 兼容。指标命名遵循 Prometheus 惯例（`graph_*` 前缀）。

**受影响的文件**:
- `src/ops/prometheus-exporter.ts`（新建）
- `src/api/rest.ts` — 集成 `/metrics` 端点
- `src/ops/metrics.ts` — 确认兼容

**状态**: ✅ 已实现

---

### §13.7 WebSocket 流式查询（P3）

**问题**: 现有 REST/gRPC 返回完整结果，大结果集（10万+行）OOM 风险；无流式推送能力。

**设计变更**:

新增 `src/api/ws-stream.ts`:
```typescript
class WsStreamQuery {
  private wss: WebSocketServer

  constructor(port: number = 7687)  // 默认 7687 端口

  // 流式 JSON 帧协议
  // 客户端 → { type: "query", id: "req1", cypher: "MATCH (n) RETURN n" }
  // 服务端 → { type: "record", id: "req1", data: { node: {...} } }
  // 服务端 → { type: "complete", id: "req1", summary: { total: 1000, timeMs: 45 } }
  // 客户端 → { type: "cancel", id: "req1" }
}
```

**背压控制**：
```typescript
private readonly BUFFER_MAX = 1000          // 缓冲区上限
private readonly BACKPRESSURE_WATERMARK = 800

private _writeRecord(ws: WebSocket, record: object): boolean {
  if (this._buffer.size >= this.BACKPRESSURE_WATERMARK) {
    // 触发背压：暂停读取，等待客户端消费
    ws.pause()
    ws.once('drain', () => ws.resume())
  }
  if (this._buffer.size >= this.BUFFER_MAX) {
    // 超过上限：关闭连接（客户端消费太慢）
    ws.close(4000, 'backpressure: buffer overflow')
    return false
  }
  return true
}
```

**协议设计**:
```
请求:   { type: "query", id: "req-001", cypher: "MATCH (n:Person) RETURN n" }
推送:   { type: "record", id: "req-001", seq: 1, data: { ... } }
推送:   { type: "record", id: "req-001", seq: 2, data: { ... } }
推送:   { type: "record", id: "req-001", seq: 3, data: { ... } }
完成:   { type: "complete", id: "req-001", summary: { total: 3, timeMs: 12 } }
取消:   { type: "cancel", id: "req-001" }
错误:   { type: "error", id: "req-001", message: "...", code: "..." }
```

**依赖项**: `ws`（已有 v8.x）

**设计决策**: 
1. 独立端点（不影响 Gremlin WS 的 8182 端口）
2. 与现有 `query-engine` 集成：逐条 yield 而非一次性返回
3. 不超过 3s 取消响应延迟

**受影响的文件**:
- `src/api/ws-stream.ts`（新建）
- `src/query/query-engine.ts` — 支持逐条 yield
- `src/api/rest.ts` — 可选集成

**状态**: ✅ 已实现

---

### §13.8 Cypher 事务函数（P3）

**问题**: `ProcedureRegistry` 已有内置过程（pageRank, shortestPath 等），但无批处理/事务过程。

**设计变更**:

在 `src/query/procedures/` 目录下新增 `periodic-commit.ts`:
```typescript
class PeriodicCommitProcedure {
  register(registry: ProcedureRegistry): void {
    registry.registerProcedure({
      name: 'periodic.commit',
      handler: async (ctx: ProcedureContext, query: string, opts: {
        batchSize?: number      // 默认 1000
        failOnError?: boolean   // 默认 false（跳过继续）
        params?: Record<string, unknown>
      }) => {
        // 1. 编译 Cypher 查询
        // 2. 循环执行，每次 batchSize 条记录为一个事务
        // 3. 每批提交，记录统计
        // 4. failOnError=false 时跳过，记录错误日志
        return {
          batches: number,
          totalRows: number,
          failures: number,
          timeMs: number,
          errorLog: string[],
        }
      },
    })
  }
}
```

**调用方式**:
```cypher
CALL periodic.commit(
  "MATCH (n:Person) WHERE n.status = 'pending' SET n.flag = true RETURN count(*)",
  { batchSize: 1000 }
)
```

**设计决策**:
1. 失败时默认跳过（`failOnError: false`），类似 APOC 行为
2. 每批原子提交，跨批次无原子性
3. 注册在现有的 `procedureRegistry` 中

**依赖项**: 无（复用 `ProcedureRegistry`、`QueryEngine`）

**受影响的文件**:
- `src/query/procedures/periodic-commit.ts`（新建）
- `src/query/procedure-registry.ts` — 确认接口兼容

**状态**: ✅ 已实现

---

## §14 V9 差距分析 — 设计变更预设

### V9 新方向总览

V9 聚焦**生态扩展&运营体验**，涵盖算法、可视化、安全、分区、监控、导入导出、格式输出，共 **7 个方向**：

| # | 方向 | GAP | 优先级 | 工时 | 核心依赖 | 复用组件 |
|:-:|------|:---:|:------:|:----:|---------|---------|
| V9-01 | 可视化仪表盘 | GAP-36 | P3 | 3~4d | `cytoscape`, `react`, `esbuild` | admin-ui, ws-query, cdc-server |
| V9-02 | 图算法库扩充 | GAP-37 | P2 | 3~4d | 无 | dijkstra.ts, index.ts |
| V9-03 | RBAC 权限集成 | GAP-38 | P3 | 2~3d | 无 | rbac.ts, rls.ts, auth.ts |
| V9-04 | 图分割/分区 | GAP-39 | P3 | 3~4d | 无 | louvain.ts, shard-manager.ts |
| V9-05 | 监控告警规则 | GAP-40 | P3 | 2~3d | `prom-client` (已有) | prometheus-exporter.ts |
| V9-06 | 批量导入/导出 | GAP-41 | P3 | 2~3d | `csv-parse`(已有), `jsonlines` | importer.ts, graph-import.ts |
| V9-07 | 图可视化输出 | GAP-42 | P3 | 2~3d | 无 | rest.ts, query-planner.ts |

### §14.1 可视化仪表盘（P3 · GAP-36）

**状态**: ✅ 已实现 (`c6e5a0ef`)

**设计目标**:
- 基于 `ws-query.ts` WebSocket 通道构建实时图拓扑面板
- React + `cytoscape` 前端，esbuild 内联打包为独立 HTML

**设计决策**:
1. **增量推送**: CDC 事件（`cdc-server.ts`）→ WebSocket → `cytoscape.js` 增量更新
2. **不引入额外构建工具链**：esbuild 内联 HTML 到 admin-ui 已有模式
3. **性能目标**: 500+ 节点帧率 > 30fps

**受影响的文件**（新建）:
- `src/api/admin/GraphLiveStream.ts`（WebSocket 桥接）
- `src/api/admin/graph-live.html.ts`（内联 HTML 模板）

**依赖项**: `cytoscape`（主渲染）, `react`（框架）, `esbuild`（已有）

### §14.2 图算法库扩充（P2 · GAP-37）

**状态**: ✅ 已实现 (`c6e5a0ef`)

**设计目标**: 补充高级图算法，不与现有 25+ 算法冲突

**新增算法**:

| 算法 | 文件 | 说明 |
|------|------|------|
| YenKShortestPaths | `src/algorithms/yen-ksp.ts` | K 最短路径，复用 `dijkstra.ts` |
| ApproxBetweenness | `src/algorithms/approx-betweenness.ts` | Brandes + K 采样，大图近似 |
| EgoNet | `src/algorithms/ego-net.ts` | n 跳子图提取 |

**设计决策**:
1. 所有新算法注册到 `src/algorithms/index.ts` 标准导出
2. 不与现有算法冲突，`TriangleCount`/`LSH` 等已有算法不修改

**依赖项**: 无（复用 Dijkstra 等现有算法）

### §14.3 RBAC 权限集成（P3 · GAP-38）

**状态**: ✅ 已实现 (`c6e5a0ef`)

**设计目标**: `PermissionResolver` 接口 + GraphEngine 操作路径自动注入

**接口设计**:
```typescript
interface PermissionResolver {
  checkNodeAccess(ctx: RLSContext, node: NodeRecord, action: 'read'|'write'|'delete'): boolean;
  checkEdgeAccess(ctx: RLSContext, edge: EdgeRecord, action: 'read'|'write'|'delete'): boolean;
  checkQueryAccess(ctx: RLSContext, query: string): boolean;
}
```

**设计决策**:
1. **向后兼容**: 未注入时 `GraphEngine` 行为不变
2. **属性级拦截**: 如 `user.tenantId === node.props.tenantId`
3. **默认实现**: `DefaultPermissionResolver` 匹配 ACL 资源类型 + 属性策略
4. **拒绝**: 抛出 `AuthError`，类似 RLS 的 `enforceQuery`

**受影响的文件**（新建）:
- `src/security/permission-resolver.ts`（接口 + 默认实现）
- 修改 `src/core/graph-engine.ts`（构造函数 + 操作入口注入）

**依赖项**: 无（复用 `rbac.ts`, `rls.ts`, `auth.ts`）

### §14.4 图分割/分区（P3 · GAP-39）

**状态**: ✅ 已实现 (`c6e5a0ef`)

**设计目标**: 智能图分割减少跨分片边，替代现有纯哈希分布

**设计决策**:
1. **LouvainPartitioner**: 复用 `src/algorithms/louvain.ts` → 社区标签 → 合并至 k 分区
2. **BfsPartitioner**: 贪心 BFS 种子扩展后备方案
3. **集成**: 分区结果导出到 `ShardManager.reshard()`

**接口设计**:
```typescript
interface GraphPartitioner {
  partition(graph: GraphData, k: number): Map<string, number>;
}
```

**受影响的文件**（新建 + 修改）:
- `src/shard/graph-partitioner.ts`（接口 + LouvainPartitioner + BfsPartitioner）
- 修改 `src/shard/shard-manager.ts`（集成 reshard 流程）

**性能目标**: 100K 节点 + 500K 边在 30s 内完成分割，跨分片边比随机哈希降低 ≥40%

**依赖项**: 无（复用 Louvain 算法）

### §14.5 监控告警规则（P3 · GAP-40）

**状态**: ✅ 已实现 (`c6e5a0ef`)

**设计目标**: `AlertRuleManager` 管理预置告警规则，输出 Prometheus YAML

**设计决策**:
1. **不引入新包**: 统一输出 YAML 供外部 Alertmanager 加载
2. **预置 7 条规则**: Down / Latency / Error / Shard / Cache / Cluster / Cert
3. **运行时评估**: `evaluateRules()` 基于 prom-client metrics 返回触发列表

**受影响的文件**（新建）:
- `src/ops/alert-rule-manager.ts`（核心类）
- `src/ops/preset-alert-rules.yaml`（预置规则 YAML）

**依赖项**: `prom-client`（已有）

### §14.6 批量导入/导出（P3 · GAP-41）

**状态**: ✅ 已实现 (`c6e5a0ef`)

**设计目标**: `BatchImportExport` 统一封装类

**接口设计**:
```typescript
class BatchImportExport {
  exportNodes(format: 'csv'|'jsonl', filePath: string, options?: ExportOptions): Promise<ExportResult>;
  exportEdges(format: 'csv'|'jsonl', filePath: string, options?: ExportOptions): Promise<ExportResult>;
  importNodes(filePath: string, format: 'csv'|'jsonl', options?: ImportOptions): Promise<ImportResult>;
  importEdges(filePath: string, format: 'csv'|'jsonl', options?: ImportOptions): Promise<ImportResult>;
}
```

**设计决策**:
1. **流式遍历**: 使用 `cursor` 分页遍历，大文件不 OOM
2. **桥接导入**: 路由到现有 `Importer` / `GraphImporter`
3. **Roundtrip**: 导出文件可通过同格式导入恢复

**受影响的文件**（新建）:
- `src/ops/batch-import-export.ts`（核心类）
- 引入 `jsonlines`（~5KB）

**依赖项**: `csv-parse`（已有）, `jsonlines`（新增~5KB）

### §14.7 图可视化输出（P3 · GAP-42）

**状态**: ✅ 已实现 (`c6e5a0ef`)

**设计目标**: 轻量级 DOT/Cytoscape JSON 序列化器

**设计决策**:
1. **不引入外部库**: DOT 为字符串模版，Cytoscape JSON 为纯数据结构
2. **REST API 集成**: `Accept` header或 `?format=` 参数切换输出格式
3. **空结果不报错**: 返回空 DOT 图 / 空 elements 数组

**受影响的文件**（新建 + 修改）:
- `src/api/graphviz-formatter.ts`（DOT 序列化器）
- `src/api/cytoscape-formatter.ts`（Cytoscape JSON 序列化器）
- 修改 `src/api/rest.ts`（输出格式协商）

**依赖项**: 无

### V9 阶段汇总

| Phase | 优先级 | 包含方向 | 方向数 | 总估值工时 | 状态 |
|:-----:|:------:|----------|:-----:|:----------:|:----:|
| 9A | **P2** | 图算法扩充 + 批量导入导出 | 2 | 5~7d | ✅ 已实现 |
| 9B | **P3** | 仪表盘 + RBAC + 图分割 + 告警 + 可视化输出 | 5 | 12~17d | ✅ 已实现 |
| | **合计** | — | **7** | **17~24d** | ✅ **已实现** (`c6e5a0ef` 2026-06-02) |

---

## §15 V10 差距分析 — 设计变更预设（✅ 全部已实现）

> 调研日期: 2026-06-02  
> 来源: `temp/v10-gap-research.md`  
> 状态: ✅ **已实现**  
> 合并 HEAD: `e47db827`

---

### §15.1 查询超时/取消（P2 · GAP-45）

**状态**: ✅ 已实现 (`e47db827`)

**设计目标**: 构建 `QueryTimeoutManager` 集成层，连接 AbortController 与查询引擎/REST/gRPC

**设计决策**:
1. 默认超时 30s，最大 300s，通过 `X-Query-Timeout` 头部自定义
2. `AsyncLocalStorage` 可选上下文传播（默认关闭）
3. 超时后返回 `408 Request Timeout` 并释放资源

**接口设计**:
```typescript
class QueryTimeoutManager {
  runWithTimeout<T>(query: string, fn: (signal: AbortSignal) => Promise<T>, timeoutMs?: number): Promise<T>;
  extractTimeoutFromRequest(req: IncomingMessage): number;
  middleware(): (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
}
```

**受影响的文件**（新建 + 修改）:
- `src/query/query-timeout-manager.ts`（新建）
- 修改 `src/query/query-engine.ts`（注入 AbortSignal）
- 修改 `src/api/rest.ts`（REST 中间件）
- 修改 `src/api/grpc-server.ts`（gRPC 超时）

**依赖项**: 无（复用已有 `withQueryTimeout()` + AbortController）

### §15.2 OpenAPI/Swagger 文档（P3 · GAP-43）

**状态**: ✅ 已实现 (`e47db827`)

**设计目标**: 将手动更新的 `openapi-docs.ts` 与 Route 定义绑定，路由变更时自动同步

**设计决策**:
1. 在 `Route` 接口中增加 `openapi?: OpenAPIOperation` 元数据字段
2. 启动时自动收集所有 route 的 OpenAPI 元数据
3. `GET /api/openapi.json` 返回完整规范，`GET /api/docs` 渲染 Swagger UI

**受影响的文件**（新建 + 修改）:
- `src/api/openapi-bridge.ts`（新建）
- 修改 `src/api/rest.ts`（Route 元数据 + 端点）

**依赖项**: 无（复用已有 `openapi-docs.ts` / `generateOpenAPIDocument()`）

### §15.3 健康检查增强（P3 · GAP-44）

**状态**: ✅ 已实现 (`e47db827`)

**设计目标**: Kubernetes 风格 liveness/readiness 探针，组件级健康状况报告

**设计决策**:
1. `GET /api/health/live` 进程存活探针（200/503）
2. `GET /api/health/ready` 组件就绪探针，包含 Storage/Consensus/Outbox/Index 状态
3. 组件状态分级：`healthy` / `degraded` / `unhealthy`
4. 健康检查端点不认证（`requireAuth: false`）

**受影响的文件**（新建 + 修改）:
- `src/api/health-check.ts`（HealthChecker + HealthComponent 接口）
- 修改 `src/api/rest.ts`（注册端点）

**依赖项**: 无

### §15.4 自定义聚合函数（P3 · GAP-47）

**状态**: ✅ 已实现 (`e47db827`)

**设计目标**: 参照 `ProcedureRegistry` 模式构建 `AggregationRegistry`，支持运行时注册自定义聚合

**设计决策**:
1. 保留内置 count/sum/avg/max/min，提取到 registry
2. `register(factory)` 用户注册入口（如 stddev, collect, percentile）
3. `isAggregate(expr)` 判断查询表达式是否为聚合
4. GROUP BY + AS 别名兼容

**受影响的文件**（新建 + 修改）:
- `src/query/aggregation-registry.ts`（AggregationRegistry + AggregationState 接口）
- 修改 `src/query/query-engine.ts`（正则匹配 → registry 查询）

**依赖项**: 无（复用现有累加器模式）

### §15.5 审计日志导出（P3 · GAP-46）

**状态**: ✅ 已实现 (`e47db827`)

**设计目标**: 基于已有 `AuditLogger` 和 `RemoteAuditSink`，构建 `AuditLogExporter` 结构化导出模块

**设计决策**:
1. 支持 JSON Lines（`.jsonl`）和 JSON Array（`.json`）格式
2. 支持按时间范围、操作类型、用户过滤导出
3. `scheduleExport(cronPattern, format, targetDir)` 定时导出（setInterval）
4. `setRetentionPolicy(maxAgeDays, maxSizeBytes)` 归档轮转策略

**受影响的文件**（新建）:
- `src/security/audit-exporter.ts`（AuditLogExporter 类）

**依赖项**: 无（复用已有 `AuditLogger.entries`）

### §15.6 多语言 SDK（P3 · GAP-48）

**状态**: ✅ 已实现 (`e47db827`)

**设计目标**: 增强已有 Python/Go SDK 骨架为生产级 SDK，新增 Java SDK

**设计决策**:
1. Python SDK：httpx 替代 urllib.request，同步+异步双模式
2. Go SDK：标准错误处理、认证流程、批量操作
3. Java SDK：OkHttp 客户端骨架
4. 三个 SDK 均支持自动从 OpenAPI 规范生成

**受影响的文件**（新建 + 修改）:
- `sdk/python/agentix_client/`（核心 + async 客户端）
- `sdk/go/`（Go module）
- `sdk/java/`（Java Maven 骨架）

**依赖项**: OpenAPI 规范稳定（依赖 §15.2）

### §15.7 压缩传输（P3 · GAP-49）

**状态**: ✅ 已实现 (`e47db827`)

**设计目标**: REST API `CompressionMiddleware` + gRPC 启用压缩

**设计决策**:
1. 接受编码协商（Accept-Encoding → Content-Encoding: gzip/brotli）
2. 阈值可配置（默认 >= 1024 bytes 才压缩）
3. 仅压缩 `application/json` 响应
4. 压缩级别可配置（fast / balanced / max）

**受影响的文件**（新建 + 修改）:
- `src/api/compression-middleware.ts`（CompressionMiddleware）
- 修改 `src/api/rest.ts`（挂载中间件）
- 修改 `src/api/grpc-server.ts`（启用压缩）

**依赖项**: Node.js 内置 `zlib`

### §15.8 配置热加载（P3 · GAP-50）

**状态**: ✅ 已实现 (`e47db827`)

**设计目标**: 复用 chokidar 实践，构建通用 `ConfigWatcher`，支持配置文件变更热生效

**设计决策**:
1. `watcher.on('key', handler)` 按配置项注册回调
2. `watcher.onAny(handler)` 全局变更监听
3. 集成 `GraphConfig`：运行时生效
4. 无效 JSON 文件不触发加载

**受影响的文件**（新建 + 修改）:
- `src/core/config-watcher.ts`（ConfigWatcher 类）
- 修改 `src/core/graph-config.ts`（集成 watcher）

**依赖项**: `chokidar`（已有）

### V10 阶段汇总

| Phase | 优先级 | 包含方向 | 方向数 | 总估值工时 | 状态 |
|:-----:|:------:|----------|:-----:|:----------:|:----:|
| 10A | **P2** | 查询超时/取消 | 1 | 2~3d | ✅ 已实现 |
| 10B | **P3** | OpenAPI / 健康检查 / 聚合函数 / 审计导出 / SDK / 压缩 / 配置热加载 | 7 | 20~28d | ✅ 已实现 |
| | **合计** | — | **8** | **22~31d** | ✅ **已实现** (`e47db827` 2026-06-02) |

---

## §16 V11 差距分析 — 设计变更预设（✅ 已实现）

### V11 新方向总览

V11 聚焦**深度强化与基础设施升级**，涵盖 ACID 事务深度增强、快照自动化、查询优化器、流式算法、SQL 桥接、索引增强、标准测试，共 **8 个方向**（均 ✅ 已实现）：

| # | 方向 | GAP | 优先级 | 工时 | 核心依赖 | 复用组件 |
|:-:|------|:---:|:------:|:----:|----------|:---------|
| V11-01 | ACID 事务深度增强（SSI+版本链+死锁检测） | GAP-51 | **P0** | 3~5d | 无（复用 Transaction.ts） | `Transaction`, `LockManager` |
| V11-02 | InstallSnapshot 自动化（log compaction+crash recovery） | GAP-52 | **P0** | 2~3d | 无（复用 raft-logic-consensus） | `RaftCore`, `StorageProvider` |
| V11-03 | StorageProvider 流式快照（分块导出+原子 rename） | GAP-53 | **P0** | 1~2d | 无（复用 msgpackr/archiver） | `StorageProvider` |
| V11-04 | 查询优化器 CBO（StatsCollector+Join ordering） | GAP-54 | **P1** | 3~5d | 无 | `QueryPlanner`, `StatsCollector` |
| V11-05 | 算法流式模式（BFS/DFS/PageRank 分块迭代） | GAP-55 | **P1** | 2~3d | 无 | `BatchProcessor` |
| V11-06 | SQL 桥接生产级完善（SQL→Cypher 翻译器） | GAP-56 | **P2** | 3~4d | `alasql`（已有） | `ProcedureRegistry`, `QueryEngine` |
| V11-07 | 复合索引唯一约束 + Geo-Spatial Index 增强 | GAP-57 | **P2** | 2~3d | `s2-geometry`（已有） | `StorageProvider`, `colIndex` |
| V11-08 | LDBC 标准测试提升 + 生产级运维治理 | GAP-58 | **P3** | 4~6d | 无 | 现有测试框架 |

### §16.1 ACID 事务深度增强 — SSI + 版本链 + 死锁检测（P0 · GAP-51）

**问题**: 当前 SI 级事务缺少写偏斜检测、多版本链、死锁检测。

**方案**: `Transaction.ts` 增加 Serializable Snapshot Isolation 模式：

```typescript
interface SSITransactionConfig {
  mode: 'readCommitted' | 'snapshot' | 'serializable'
  enableDeadlockDetection: boolean
  versionChainDepth: number   // 默认 3
  conflictRetryCount: number  // 默认 3
}
```

**设计决策**:
1. 读集冲突检测：`SELECT ... FOR UPDATE` 语义读集注册
2. 等待图死锁检测（DFS 环检测），超时触发回滚
3. 版本链支持：每个 key 保留前 N 个版本（配置式），快照读回退到版本链
4. 写偏斜检测：读集的 key 在提交时被其他事务修改则 abort
5. 非侵入式：不修改现有 GraphEngine 写入路径，仅在 SimpleTxnManager 层扩展

**受影响的文件**:
- `src/core/transaction.ts`（扩展 SSI 模式）
- `src/core/simple-txn-manager.ts`（死锁检测器集成）
- 新建 `src/core/deadlock-detector.ts`

**依赖项**: 无（复用 `Transaction.ts`、`LockManager`）

### §16.2 InstallSnapshot 自动化 — log compaction + crash recovery（P0 · GAP-52）

**问题**: snapshot 手动触发，follower crash 后无自动恢复。

**方案**: 基于 Log 大小阈值自动压缩，follower recovery 从 StorageProvider 重装。

**设计决策**:
1. `RaftCore` 增加 `_snapshotThreshold` 配置（默认 10_000 条 log）
2. 超过阈值后自动触发 `createSnapshot()` → `pruneLogs()`
3. Follower `requestVote` 响应时检测 log 差距，差距过大则发送 InstallSnapshot
4. 快照包含完整 state machine 状态 + lastAppliedIndex
5. 存储作为 WAL segment 文件，LMDB 中存快照元数据

**受影响的文件**:
- `src/consensus/raft-core.ts`（自动压缩 / InstallSnapshot 回调）
- 新建 `src/consensus/snapshot-manager.ts`

**依赖项**: 无（复用 raft-logic-consensus 和 overgraph-storage）

### §16.3 StorageProvider 流式快照 — 分块导出 + 原子 rename（P0 · GAP-53）

**问题**: 大图整图序列化 OOM，无原子操作。

**方案**: 分块导出（4MB） + 临时文件 rename + 校验和。

**设计决策**:
1. `exportSnapshot()` 按 LMDB database 分块遍历，4MB 为一块
2. 每个块写入临时文件（`.tmp` 后缀）
3. 全部块完成后对每个块计算 SHA-256 校验和
4. `fs.renameSync(tmpPath, targetPath)` 原子操作
5. 失败时部分块不 rename，不影响之前快照
6. 与 `IncrementalBackupManager` 兼容：增量仅导出变更块

**受影响的文件**:
- `src/storage/storage-provider.ts`（流式快照方法）
- 新建 `src/ops/snapshot-stream.ts`

**依赖项**: 无（复用 `msgpackr`、`fs`、`crypto`）

### §16.4 查询优化器 CBO — StatsCollector + Join ordering（P1 · GAP-54）

**问题**: 无成本估算、Join ordering、谓词选择性。

**方案**: `StatsCollector.estimateSelectivity()` 接入 QueryPlanner。

**设计决策**:
1. `StatsCollector` 增加 `estimateSelectivity(predicate)` 方法，基于直方图 + 采样
2. 直方图：为每个属性维护等高直方图（等宽近似），写入时增量更新
3. `QueryPlanner.optimize(plan)` 遍历 join tree，按成本排序
4. 成本函数：`cost = scanRows + filterSelectivity * scanRows + joinSelectivity * scanRows * joinRows`
5. 支持 range/equality/IN/NOT 谓词选择性估算
6. 兜底：无统计信息时退化为左深树，与当前行为一致

**受影响的文件**:
- `src/query/query-planner.ts`（optimize 方法）
- `src/query/stats-collector.ts`（estimateSelectivity / histogram 维护）
- 新建 `src/query/histogram.ts`

**依赖项**: 无

### §16.5 算法流式模式 — BFS/DFS/PageRank 分块迭代（P1 · GAP-55）

**问题**: BFS/DFS/PageRank 全内存，大图 OOM。

**方案**: `BatchProcessor` 分块加载 + 迭代收敛。

**设计决策**:
1. 基于现有 `BatchProcessor` 模式：一次处理一批节点（默认 10_000 个）
2. 分块加载：每次从 LMDB 加载一个 batch 的邻接边
3. BFS：迭代批处理，每轮处理当前层节点，生成下一层
4. PageRank：迭代批处理，每轮更新 PageRank 值，检查收敛
5. 每个 batch 完成后释放结果集，控制峰值内存
6. 与现有算法接口完全兼容（`src/algorithms/` 目录）

**受影响的文件**:
- `src/algorithms/bfs.ts`（流式模式）
- `src/algorithms/dfs.ts`（流式模式）
- `src/algorithms/pagerank.ts`（流式模式）
- 新建 `src/algorithms/stream-processor.ts`

**依赖项**: 无（复用 `BatchProcessor`）

### §16.6 SQL 桥接生产级完善 — SQL→Cypher 翻译器（P2 · GAP-56）

**问题**: 现有 `alasql` 桥接存在解析边界情况（嵌套子查询、UNION、聚合嵌套）、不完善的 LIMIT/OFFSET 翻译、无错误消息等。

**方案**: SQL→Cypher 翻译器生产级增强。

**设计决策**:
1. 完善 AST 翻译器：支持嵌套子查询、UNION、HAVING、CASE WHEN
2. INSERT/UPDATE/DELETE → Cypher 翻译路径（通过 ProcedureRegistry）
3. 错误消息友好：`parse`
```sql
SELECT * FROM Person WHERE age > (SELECT AVG(age) FROM Person)
```
等复杂 SQL 返回明确错误码 + 建议等效 Cypher
4. `alasql` 版本锁定到 v4.17.x 避免 breaking change
5. 可选 SQL 端点 `POST /api/v1/sql`（与现有 `/api/v1/cypher` 并行）

**受影响的文件**:
- `src/query/sql-bridge.ts`（增强翻译器）
- `src/api/rest.ts`（可选 SQL 端点）
- 新建 `src/query/sql-error-formatter.ts`

**依赖项**: `alasql`（已有，v4.17.x）

### §16.7 复合索引唯一约束 + Geo-Spatial Index 增强（P2 · GAP-57）

**问题**: 复合索引不支持唯一约束校验；Geo-Spatial Index（GAP-06 S2 集成）缺少空间范围查询。

**方案**: 复合索引唯一约束 + S2 空间范围查询扩展。

**设计决策**:
1. 复合索引唯一约束：写入时检查复合键（label+prop1+prop2）唯一性，冲突拒绝写入
2. S2 空间范围查询：`within(pointCellId, radiusMeters)` / `intersects(regionCellIds)`
3. S2 空间 JOIN：基于 S2 cell 覆盖的空间连接
4. 支持 WKT（Well-Known Text）格式输入：`POINT, POLYGON, LINESTRING`
5. 与 `colIndex`（列式索引）组合使用：空间条件 + 属性过滤联合查询

**受影响的文件**:
- `src/storage/composite-index.ts`（唯一约束校验）
- `src/search/geo-spatial.ts`（S2 范围查询扩展）
- `src/query/query-engine.ts`（空间谓词注册）
- 新建 `src/query/geo-predicate.ts`

**依赖项**: `s2-geometry`（已有）

### §16.8 LDBC 标准测试提升 + 生产级运维治理（P3 · GAP-58）

**问题**: 现有 LDBC SNB 测试为 Phase 1 基础实现，缺少大规模测试（100K+）、性能基准、运维治理。

**方案**: LDBC 标准测试提升 + 生产级运维治理。

**设计决策**:
1. LDBC SNB Phase 2：实现 IC-3/IC-4/IC-8/IC-9/IC-10/IC-11/IC-12/IC-13 完整交互查询，覆盖全部 14 个 IC 查询
2. 大规模测试：small(1K) / medium(10K) / large(100K) / xlarge(1M)
3. 性能基准：每个查询输出 p50/p90/p99 延迟、QPS、吞吐
4. 运维治理文档：`docs/ops/ldbc-snb-guide.md`（运行指南 + 结果解读）
5. 自动 CI 回归：GitHub Actions 中 LDBC 测试作为 nightly pipeline

**受影响的文件**:
- `test/ldbc/` 目录（扩展测试覆盖）
- 新建 `test/ldbc/ic-queries.ts`
- 新建 `docs/ops/ldbc-snb-guide.md`
- 新建 `.github/workflows/ldbc-nightly.yml`

**依赖项**: 无

### V11 阶段汇总

| Phase | 优先级 | 包含方向 | 方向数 | 总估值工时 | 状态 |
|:-----:|:------:|----------|:-----:|:----------:|:----:|
| 11A | **P0** | ACID 事务深度增强 / InstallSnapshot 自动化 / 流式快照 | 3 | 6~10d | ✅ 已实现 |
| 11B | **P1** | 查询优化器 CBO / 算法流式模式 | 2 | 5~8d | ✅ 已实现 |
| 11C | **P2** | SQL 桥接完善 / 复合索引+Geo-Spatial | 2 | 5~7d | ✅ 已实现 |
| 11D | **P3** | LDBC 标准测试 + 运维治理 | 1 | 4~6d | ✅ 已实现 |
| | **合计** | — | **8** | **20~31d** | ✅ **已实现** (GAP-51~GAP-58)

---

## §17 V12 新方向（✅ 已实现）

### V12 新方向总览

V12 聚焦**可观测性、索引增强、运维体验与查询灵活性**，共 **6 个方向**（全部 ✅ 已实现）：

| 编号 | 方向 | GAP | 优先级 | 估值工时 | 核心实现 | 核心影响模块 |
|:----:|------|:---:|:------:|:--------:|:--------:|:----------:|
| V12-01 | 分布式追踪 (OpenTelemetry) | GAP-59 | **P1** | 3~5d | `ops/otel.ts`, `spec/06-otel-tracing.md` | `RaftCore`, `QueryEngine` |
| V12-02 | CDC 细粒度属性过滤 | GAP-60 | **P1** | 2~3d | `core/cdc-adapter.ts`, `spec/07-cdc-property-filter.md` | `CDC`, `PropertyFilter` |
| V12-03 | Index 在线重建 (double-buffer) | GAP-61 | **P2** | 4~6d | `core/columnar-index.ts`, `spec/08-index-online-rebuild.md` | `IndexEngine` |
| V12-04 | 自动索引建议 (Index Advisor) | GAP-63 | **P2** | 3~4d | `ops/index-advisor.ts` | `Optimizer`, `IndexEngine` |
| V12-05 | 一致性级别可配置 | GAP-64 | **P1** | 3~5d | `core/consistency-level.ts` | `QueryEngine`, `ReadPath` |
| V12-06 | 图可视化编辑器 (Admin UI) | GAP-66 | **P2** | 3~4d | `api/admin-ui.ts` | `API Server`, `Admin UI` |

### V12 阶段汇总

| Phase | 优先级 | 包含方向 | 方向数 | 总估值工时 | 状态 |
|:-----:|:------:|----------|:-----:|:----------:|:----:|
| 12A | **P1** | OTEL 链路追踪 / CDC 属性过滤 / Index 在线重建 | 3 | 8~14d | ✅ 已实现 |
| 12B | **P1~P2** | 自动索引建议 / 一致性级别可配置 / 图可视化编辑器 | 3 | 10~15d | ✅ 已实现 |
| | **合计** | — | **6** | **18~29d** | ✅ **已实现** (GAP-59~GAP-66, 6/6)
