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
> 状态: 全部 ⬜ 计划中

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
