# AgentiX GraphVec 深度研究编译 v1.0

> 整合自：consensus-shard / query-api / security-ops 三层子 Agent 研究报告 + 运维/安全/复制全面审查
> 编译日期：2026-05-28  
> Round 8b 更新：2026-05-29 — 9 个新模块已新增至文件映射

---

## 1. Consensus & Shard 层研究结论

来源：`research-consensus-shard.md`

### 1.1 共识层架构评价

```
3 层可切换共识:
├── StandaloneConsensus  — 单节点/开发模式
├── SimulatedRaft        — 高频测试用（mock 选举）
└── RaftLogicConsensus   — WASM raft-logic 封装（可选）
    └── RaftCore         — 日志复制 + commit + 选举
```

**关键发现**：
- **RaftCore 事件驱动**：使用 EventEmitter 而非 polling
- **epoch 机制**：每次 leader 变更递增 epoch，避免旧 leader 残留写入
- **preVote**：已实现 pre-vote 防脑裂（`config.preVote`）
- **join 后校验**：新节点 join 后校验 `matchIndex[]` 直到追平
- **StandaloneConsensus**：最小化实现（`_readIndex: 0`）
- **RaftLogicConsensus**：依赖 `raft-logic` npm 包的 WASM 编译，`addPeer`/`removePeer` 使用 ConfChange API

**设计评价**：架构合理，共识层对上层（RangeInstance）接口清晰。RaftCore 在纯 JS 场景下表现稳定。

### 1.2 分片层架构评价

```
Shard Manager ──→ 多 RangeInstances
├── AutoSplitter  — range 大小/操作数监控，触发 split
├── Rebalancer    — LRU + 负载评估，触发迁移
├── ScatterGather — 跨 range 并行查询 + 聚合
├── EdgeAffinity  — 边亲和性路由（减少跨 shard 查询）
└── ShardRouter   — key → shard 映射
```

**关键发现**：
- **Rebalancer** 已实现完整 flow（`pickTarget`→`reassignRange`→`notifyMembers`）
- **AutoSplitter** 基于 `getRangeSizes()` 热路径检测
- **ScatterGather** 用 Promise.all + 错误容忍 + 可选 `timeoutMs` 超时兜底 ✅ (Round 7 已修复)
- **EdgeAffinity** 使用 `lookupSrcNodeId` 结合 DHT 或缓存路由

### 1.3 审计发现的代码质量问题

| 严重度 | 问题 | 位置 | 状态 | 说明 |
|:------:|:-----|:------|:----:|------|
| 🔴 高 | `join-consensus-timeout` 参数未暴露 | raft-core.ts | ✅ 已修复 | `waitForLeader(timeoutMs?)` 已接受可配置参数 |
| 🔴 高 | `watchTimeout` 未暴露 | app-heartbeat-manager.ts | ✅ 已修复 | `pingIntervalMs/suspectThreshold/recoveryThreshold` 全部可配置 |
| 🟡 中 | ScatterGather 无超时兜底 | scatter-gather.ts | ✅ 已修复 | Round 7 Step 4 添加 `promiseWithTimeout()` helper |
| ✅ 已修复 | Rebalancer tests 挂起 | rebalancer.spec.ts | ✅ | 已通过全量测试 |
| 🔵 低 | RaftNode epoch 检查重复 | raft-node.ts | ✅ 已修复 | Round 8b 重构 `ensureEpoch` 方法 |

---

## 2. 查询层 + API 层研究结论

来源：`research-query-api.md`

### 2.1 查询引擎架构

```
Client → REST API (Fluent) → QueryEngine → GraphEngine
├── Fluent API  — 链式 Builder（.inV()/.outV()/.label()）
├── QueryEngine — Cypher-lite 解析器（支持 MATCH/RETURN/WHERE/LIMIT）
└── GraphEngine — 底层存储执行（节点/边 CRUD + 标签索引）
```

### 2.2 相关文件映射

| 文件 | 行数 | 职责 |
|------|:----:|------|
| `api/rest.ts` | ~600 | HTTP REST 路由（~1630 行含 Ops 路由） |
| `api/fluent.ts` | ~350 | 流式查询 Builder（含 `updateEdge`/`deleteEdge`） |
| `api/query-planner.ts` | ~350 | 查询计划器（含 CBO + `planCache` 单例，lru-cache v11） |
| `query/query-engine.ts` | ~330 | Cypher-lite 解析器 + 执行器（含 `parseQueryCached()`） |
| `query/optional-match.ts` | ~150 | OPTIONAL MATCH / WITH 子句执行器 (Round 8b F38) |
| `query/aggregate.ts` | ~300 | 聚合函数 COUNT/SUM/AVG/GROUP BY (Round 8b F39) |
| `core/graph-engine.ts` | ~700 | 核心图存储引擎（含数据压缩、13 种图算法、LRU缓存F35） |
| `core/overgraph-storage.ts` | ~300 | OverGraph 存储适配层（含 msgpackr 透明压缩） |
| `core/lru-cache.ts` | ~80 | 增强逐边粒度失效+写穿缓存 (Round 8b F37) |
| `index/composite-index.ts` | ~200 | 组合索引 (Round 8b F31) |
| `index/geo-index.ts` | ~250 | 地理空间索引 (Round 8b F32) |
| `algorithms/streaming-engine.ts` | ~350 | 流式算法引擎+图投影 (Round 8b F33) |
| `shard/2pc-coordinator.ts` | ~400 | 跨分片2PC事务协调器 (Round 8b F34) |
| `ops/ldbc-benchmark.ts` | ~300 | LDBC SNB 基准测试套件 (Round 8b F35) |
| `security/security-audit.ts` | ~200 | 安全基线+威胁检测 (Round 8b F36) |

### 2.3 审计发现

| 严重度 | 问题 | 位置 | 状态 | 说明 |
|:------:|:-----|:------|:----:|------|
| 🟡 中 | Cypher-lite 无类型校验 | query-engine.ts | ✅ 已解决 | Round 8b 通过 Schema Validation (F28) + Aggregate 解析集成实现类型感知 |
| 🟡 中 | Fluent API `updateEdge()` / `deleteEdge()` | fluent.ts | ✅ 已修复 | Round 7 Step 4 添加 |
| 🔵 低 | REST API `listDatabases()` / `getShardInfo` | rest.ts | ✅ 已修复 | Round 7 Step 4 添加 |
| 🔵 低 | `QueryEngine` 无缓存 | query-engine.ts | ✅ 已修复 | Round 8 添加 `planCache` (lru-cache v11) |
| ✅ | Cypher-lite 解析器支持：MATCH/RETURN/WHERE/ORDER/LIMIT/SKIP | — | ✅ | 基础查询完备 |
| ✅ | OPTIONAL MATCH / WITH 子句 | — | ✅ | Round 8b 新增 (F38) |
| ✅ | 聚合函数 (COUNT/SUM/AVG/GROUP BY) | — | ✅ | Round 8b 新增 (F39) |

---

## 3. 安全层 + 运维层研究结论

来源：`research-security-ops.md`、`REVIEW-OPS-SECURITY-REPLICATION.md`

### 3.1 安全模块

| 文件 | 行数 | 职责 | 状态 |
|------|:----:|------|:----:|
| `security/auth.ts` | ~476 | 节点认证（mTLS + chokidar 热加载） | ✅ 完整 |
| `security/tls.ts` | ~361 | TLS 配置（cert/key/CA + mTLS） | ✅ 完整 |
| `security/rls.ts` | ~100 | 行级安全策略引擎 | 🟡 基础 |
| `security/audit.ts` | ~80 | 审计日志触发 | 🟡 基础 |
| `security/security-audit.ts` | ~200 | 安全基线检查+入侵检测+CIS报告 (Round 8b F36) | ✅ 新增 |

### 3.2 运维模块

| 文件 | 行数 | 职责 | 状态 |
|------|:----:|------|:----:|
| `ops/audit-log.ts` | ~200 | 结构化审计日志（pino） | ✅ 完整 |
| `ops/backup.ts` | ~150 | 备份管理 | 🟡 基础 |
| `ops/backup-helpers.ts` | ~80 | 备份工具函数 | 🟡 基础 |
| `ops/backup-scheduler.ts` | ~100 | cron 调度备份 | 🟡 基础 |
| `ops/backup-checksum.ts` | ~60 | 校验和验证 | 🟡 基础 |

### 3.3 复制模块

| 文件 | 行数 | 职责 | 状态 |
|------|:----:|------|:----:|
| `replication/cdc-consumer.ts` | ~150 | 变更数据捕获 | ✅ 完整 |
| `replication/dc-sync.ts` | ~120 | 数据中心同步管理器 | ✅ 完整 |
| `replication/delta-sync.ts` | ~100 | HLC 增量同步 | ✅ 完整 |
| `replication/hlc-clock.ts` | ~150 | 混合逻辑时钟 | ✅ 完整（1 个预存失败） |
| `replication/membership.ts` | ~80 | 复制层成员管理 | 🟡 基础 |

### 3.4 审计发现

| 严重度 | 问题 | 位置 | 说明 |
|:------:|:-----|:------|------|
| 🟡 中 | 无安全基线文档 | — | ✅ 已解决 — Round 8b F36 安全基线+威胁检测+合规检查已实现 |
| 🟡 中 | 备份一致性未验证 | backup.ts | 🟡 基础 — 快照一致性已在 F34 2PC 中改进 |
| 🟡 中 | 无证书热加载 | tls.ts | ✅ 已解决 — chokidar 监视 cert/key/ca 变更 |
| 🔵 低 | RLS 未对接 REST API | rls.ts | 🟡 基础 — 策略存在，REST API 层需手动集成 |
| 🔵 低 | 审计日志裁剪缺失 | audit-log.ts | 🟡 基础 — 基础日志功能存在，轮替待配置 |

---

## 4. npm 第三方库替代方案调研结论

来源：`npm-第三方库替代方案调研.md`

| 替代方向 | 推荐 npm 包 | 当前状态 | 替换优先级 |
|----------|:-----------|:--------:|:----------:|
| 全文搜索 | minisearch (已安装) | ✅ 已集成 — 全文索引 WAL 持久化 (Round 7) | P0 ✅ |
| 图算法 | graphology (已安装) | ✅ 已全部集成 — WCC/SCC 等 6 算法 (Round 8) | ✅ |
| 备份压缩 | archiver (已安装) | ✅ 已集成 | ✅ |
| 文本解析 | csv-parse (已安装) | 🟡 基础 — 导入器使用基本 CSV 解析 | P2 🟡 |
| 元数据 KV | lmdb (已安装) | ✅ 已集成 — 全部存储路径使用 LMDB | ✅ |
| 对象哈希 | xxhash-wasm (已安装) | ✅ 已集成 | ✅ |
| 调度 | node-cron (已安装) | ✅ 已集成 | ✅ |
| 空间索引 | rbush (新增 Round 8b) | ✅ 已集成 — 地理空间 R-tree (F32) | ✅ |

**关键结论**：只有 minisearch 和 lmdb 两个已安装包未被完全集成，其余依赖均已就位。
