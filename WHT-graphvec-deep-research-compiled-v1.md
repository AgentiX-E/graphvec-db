# AgentiX GraphVec 深度研究编译 v1.0

> 整合自：consensus-shard / query-api / security-ops 三层子 Agent 研究报告 + 运维/安全/复制全面审查
> 编译日期：2026-05-28

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
- **ScatterGather** 用 Promise.all + 错误容忍，但无超时兜底
- **EdgeAffinity** 使用 `lookupSrcNodeId` 结合 DHT 或缓存路由

### 1.3 审计发现的代码质量问题

| 严重度 | 问题 | 位置 | 说明 |
|:------:|:-----|:------|------|
| 🔴 高 | `join-consensus-timeout` 参数未暴露 | raft-core.ts | 硬编码 `leaderTimeout` |
| 🔴 高 | `watchTimeout` 未暴露 | app-heartbeat-manager.ts | 硬编码 10s |
| 🟡 中 | ScatterGather 无超时兜底 | scatter-gather.ts | 单向等待可能导致挂起 |
| ✅ 已修复 | Rebalancer tests 挂起 | rebalancer.spec.ts | 已通过全量测试 |
| 🔵 低 | RaftNode epoch 检查重复 | raft-node.ts | `ensureEpoch` 多处 > 1 处 |

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
| `api/rest.ts` | ~200 | HTTP REST 路由（Express 风格） |
| `api/fluent.ts` | ~150 | 流式查询 Builder |
| `api/query-planner.ts` | ~120 | 查询计划器 |
| `query/query-engine.ts` | ~280 | Cypher-lite 解析器 + 执行器 |
| `core/graph-engine.ts` | ~600 | 核心图存储引擎 |
| `core/label-engine.ts` | ~150 | 标签索引引擎 |

### 2.3 审计发现

| 严重度 | 问题 | 位置 | 说明 |
|:------:|:-----|:------|------|
| 🟡 中 | Cypher-lite 无类型校验 | query-engine.ts | 运行时才暴露类型错误 |
| 🟡 中 | Fluent API 缺少 `updateEdge()` / `deleteEdge()` | fluent.ts | 边操作不完备 |
| 🔵 低 | REST API 缺少 `listDatabases()` / `getShardInfo` | rest.ts | Ops API 不足 |
| 🔵 低 | `QueryEngine` 无缓存 | query-engine.ts | 无查询缓存层 |
| ✅ | Cypher-lite 解析器支持：MATCH/RETURN/WHERE/ORDER/LIMIT/SKIP | — | 基础查询完备 |

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
| 🟡 中 | 无安全基线文档 | — | 合规文档缺失 |
| 🟡 中 | 备份一致性未验证 | backup.ts | 无一致性校验 |
| 🟡 中 | 无证书热加载 | tls.ts | 需重启进程 |
| 🔵 低 | RLS 未对接 REST API | rls.ts | 策略存在未使能 |
| 🔵 低 | 审计日志裁剪缺失 | audit-log.ts | 无日志轮替 |

---

## 4. npm 第三方库替代方案调研结论

来源：`npm-第三方库替代方案调研.md`

| 替代方向 | 推荐 npm 包 | 当前状态 | 替换优先级 |
|----------|:-----------|:--------:|:----------:|
| 全文搜索 | minisearch (已安装) | 未集成 | P0 |
| 图算法 | graphology (已安装) | 部分集成 | P2 |
| 备份压缩 | archiver (已安装) | 已集成 | ✅ |
| 文本解析 | csv-parse (已安装) | 未集成 | P2 |
| 元数据 KV | lmdb (已安装) | 未集成 WAL | P1 |
| 对象哈希 | xxhash-wasm (已安装) | 已集成 | ✅ |
| 调度 | node-cron (已安装) | 已集成 | ✅ |

**关键结论**：只有 minisearch 和 lmdb 两个已安装包未被完全集成，其余依赖均已就位。
