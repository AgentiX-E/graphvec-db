# AgentiX GraphVec 技术设计 v1.0

## §1 本文件变更追踪

| 日期 | 变更内容 |
|------|----------|
| 2026-05-29 | Round 8 新增：Query Plan Cache（§8.8）、Graph Algorithms Expansion（§8.9）、Data Compression（§8.10） |
| 2026-05-29 | Round 8b 新增：Composite Index（§8.11）、Geo-Spatial Index（§8.12）、Streaming Algorithm Engine（§8.13）、Cross-Shard 2PC Transactions（§8.14）、LDBC Benchmark Suite（§8.15）、Security Audit & Threat Detection（§8.16）、Node/Edge LRU Cache（§8.17）、OPTIONAL MATCH / WITH Clause（§8.18）、Aggregate Functions（§8.19） |

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
