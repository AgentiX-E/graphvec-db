# AgentiX GraphVec 技术设计 v1.0

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
**已知问题**: `dropDatabase()` 不释放底层资源（Raft、GraphEngine、文件句柄），见"已知限制"章节
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
- `AutoSplitter` — 自动检测 range 大小并触发分裂
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

## 已知限制

### L1: 数据库删除未清理 Raft 资源（🔴 高）

**文件**: `src/core/database-manager.ts` — `dropDatabase()`

当前 `dropDatabase()` 只从内存 Map 中删除记录，不释放以下资源：

| 残留资源 | 影响 | 严重度 |
|----------|------|:------:|
| `ShardManager.ranges` 中的 RangeInstance 引用 | fan-out 遍历残留 range，调用已关闭的 GraphEngine | 🔴 高 |
| RangeInstance 内部 Consensus 引擎（选举定时器 + WAL 句柄） | 内存泄漏，真实 RaftCore 有存活线程 | 🔴 高 |
| GraphEngine / OverGraph / LMDB mmap / WAL stream | 文件句柄泄漏，LMDB 保持文件锁 | 🔴 高 |
| 未通知集群其他节点 | Outbox 继续发送失效消息 | 🟡 中 |
| 文件系统数据残留 | 重启后重读残留数据 | 🟡 中 |

**设计文档**: `docs/multi-database-arch-design.md §8` 定义的三阶段删除方案（Phase 0 proposeDelete → Phase 1 commit → 冷静期 → Phase 3 GC）未在生产代码中实现。集成测试 `test/integration/database-deletion.test.ts` (18/18 ✅) 已验证设计行为，但生产代码未同步。

**当前可用但未被调用的方法**:
- `ShardManager.stop()` — 停止所有 RangeInstance（consensus + graphEngine）
- `ShardManager.removeRange()` — 移除单个 range
- `RangeInstance.stop()` — 停止 consensus + 关闭 engine
