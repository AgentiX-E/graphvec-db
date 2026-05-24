# 深度审查 B：分片+共识层

> 审查日期: 2026-05-23
> 审查范围: `src/shard/`, `src/consensus/`, `src/reshard/`
> 项目: agentiX-graphvec

---

## 总览

| 维度 | 模块 | 代码量 |
|------|------|--------|
| 分片 | shard-manager.ts | 559 行 |
| | range-instance.ts | 56 行 |
| | shard-router.ts | 51 行 |
| | rebalancer.ts | 262 行 |
| 共识 | raft-core.ts | 986 行 |
| | raft-node.ts | 232 行 |
| | transport.ts | 332 行 |
| | raft-transport.ts | 360 行 |
| | wal.ts | 280 行 |
| 重平衡 | reshard-manager.ts | 244 行 |
| | reshard-plan.ts | 70 行 |
| | reshard-worker.ts | 100 行 |

---

## 1. 分片策略 vs 竞品

### [S-01] 一致性哈希分片层无智能路由优化
- **模块**: `src/shard/shard-router.ts`
- **严重度**: 🟡
- **对比**: Dgraph（按谓词分组）+ ArangoDB（SmartGraph 感知拓扑）均支持智能路由，AgentiX 仅使用基本的一致性哈希（vnodes=160）。
- **描述**: `ShardRouter` 基于 `consistent-hashing` 库做纯 hash 路由，无谓词感知、无访问模式热区检测、无局部性优化。邻居查询时，跨 range 的遍历仍需 fan-out，无法通过路由优化减少网络开销。`shard-router.ts` 仅 51 行，功能高度简化。
- **方案**: 引入谓词感知分片（类似 Dgraph 的 Predicate Group）或在路由层缓存热 key 的 range 映射。对图遍历场景，可添加节点 locality 提示（将高频共访问节点分配到同一 range）。
- **工作量**: 中

### [S-02] 边写入跟随源节点路由引发跨分片读放大
- **模块**: `src/shard/shard-manager.ts`
- **严重度**: 🟡
- **对比**: Neo4j 企业版通过因果集群实现数据复制组；JanusGraph 支持按边 ID 分片。AgentiX 的边写入路由策略（`getRange(src)`）使得边存储可能和 dst 节点在不同 range。
- **描述**: `upsertEdge` 和 `batchUpsertEdges` 均使用 src 节点的 range 路由。当查询需要根据 dst 节点查找入边（incoming edges）时，必须 fan-out 所有 range。图数据库中双向边遍历是核心场景，此设计会导致严重读放大。
- **方案**: 可选择：(1) 边按 (src, dst) 联合路由（一致性哈希需支持复合 key），(2) 在写入时显式写入两个 range（src range 和 dst range 各一份，写入成本翻倍但读性能提升），(3) 构建全局倒排边索引。
- **工作量**: 大

### [S-03] 向量搜索 fan-out 线性开销无剪枝
- **模块**: `src/shard/shard-manager.ts:vectorSearch`
- **严重度**: 🟡
- **对比**: Dgraph 的 Alpha Group 可以在不扫描所有分片的情况下执行向量搜索；AgentiX 必须 fan-out 到所有 range 并合并排序。
- **描述**: `vectorSearch()` 每次都对所有 range 执行并行的 `range.read(engine => engine.vectorSearch(query))`，随 range 数量线性增长延迟。无任何剪枝策略（如基于 range 的向量分布统计快速跳过不相关 range）。
- **方案**: 在 range 级别维护近似向量分布摘要（如聚类中心点或 min/max 向量统计），查询时先过滤掉确定不相关的 range。参考 Faiss 的 IVF 索引思路——全局 IVF 索引分配到各 range 后可做剪枝。
- **工作量**: 中

### [S-04] 单节点 Raft 启动时的 Leader 选举等待成本
- **模块**: `src/shard/shard-manager.ts:start`
- **严重度**: 🔵
- **对比**: Neo4j 单实例无此问题；Dgraph Zero 会自动配置。AgentiX 启动时需等待每个 range 的 Raft 选举完成。
- **描述**: `start()` 方法中，每个 range 启动后调用 `waitForLeader(leaderTimeoutMs)`，默认超时 10s。单节点 Raft（peers=空）在 `raft-core.ts:start()` 中直接 `_becomeLeader()` 即刻成为 leader，因此实际等待极短。但代码中仍设置了 10s 超时和 try-catch 忽略，形成隐含的软超时。如果有 100 个 range，本阶段是 O(1)（并行等待），但文档/注释未明确。
- **方案**: 将 `waitForLeader` 的 timeout 与 range 数解耦，单节点 peers 为空时跳过等待。添加注释明确在多节点集群场景下的等待行为。
- **工作量**: 小

---

## 2. Raft 实现健壮性

### [R-01] 成员变更：只支持全量重建启动，不支持运行时变更
- **模块**: `src/consensus/raft-core.ts`
- **严重度**: 🔴
- **对比**: Dgraph/Neo4j/ArangoDB 均支持集群运行时成员变更。JanusGraph 依赖底层存储层（BigTable/Cassandra）提供弹性。
- **描述**: `peers` 参数在 `RaftCoreConfig` 中仅启动时传入，`raft-core.ts` 中没有 `addPeer()` / `removePeer()` 方法。`RaftCore` 内部使用 `this.config.peers` 只读引用，所有 AppendEntries 和 RequestVote 的目标列表在此处固定。这意味着集群扩容/缩容必须重启所有节点——生产环境不可接受。
- **方案**: 实现 Raft 论文 §6 的安全成员变更（Joint Consensus 或单步变更）。需要：(1) 在 WAL 中增加 `ConfigurationEntry` 类型，(2) 新增 `proposeConfigChange()` API，(3) 变更期间使用旧/新配置联合仲裁。
- **工作量**: 大

### [R-02] 快照实现不完整：仅元数据快照，未包含状态机状态
- **模块**: `src/consensus/raft-core.ts:_doSnapshot`
- **严重度**: 🔴
- **对比**: 竞品（如 etcd Raft/etcd 本身）的快照包含完整的键值状态。AgentiX 的快照只记录 `lastIncludedIndex`/`lastIncludedTerm` 和一个 `state: 'snapshot-complete'` 字符串，不包含 GraphEngine 数据。
- **描述**: `_doSnapshot()` 流程：向 stateMachine 发空标记 → 写 snapshot 文件（只记录 meta）→ truncate WAL。**但 `GraphEngine`/`OverGraph` 的数据无法从空标记恢复。** 截断 WAL 后，如果节点崩溃重启，WAL 中的日志条目已丢失，但 snapshot 不包含状态机快照，导致数据丢失。另外，`_loadSnapshotState()` 加载后只更新 `lastApplied`/`commitIndex`，不恢复 GraphEngine 状态。
- **方案**: 快照时必须序列化 `GraphEngine` 的完整状态（所有节点/边数据）到 snapshot 文件。参考 etcd 的 `snapshot.Save()`，在 `_doSnapshot()` 中调用 `engine.serializeSnapshot()` 并将结果写入 snapshot 文件。`_loadSnapshotState()` 恢复时调用 `engine.restoreFromSnapshot()`。
- **工作量**: 大

### [R-03] InstallSnapshot RPC 未实现：落后 follower 无法追赶
- **模块**: `src/consensus/raft-core.ts` + `src/consensus/transport.ts`
- **严重度**: 🔴
- **对比**: Raft 论文强制要求实现 InstallSnapshot RPC。所有生产级 Raft 实现（etcd/Consul/Neo4j Raft）都支持。
- **描述**: `transport.ts` 定义了 `InstallSnapshotRequest`/`InstallSnapshotResponse` 接口（含 `lastIncludedIndex`, `lastIncludedTerm`, `data`, `done`），且 `Transport` 接口有 `installSnapshot()` 方法。但 `RaftCore` 中**从未调用**此方法。当某个 follower 落后超过 `snapshotThreshold` 条日志时，Leader 的 AppendEntries 无法再分阶段同步（因为 prevLog 已在 WAL 中被截断），follower 将永久落后无法恢复。`AppendEntries` handler 中的 `req.prevLogIndex > 0` 检查在 prevLog 不在 WAL 时返回 false，但没有触发 InstallSnapshot 的 fallback。
- **方案**: 在 `_sendAppendEntries` / `_handleAppendEntries` 中，当 prevLog 不存在且 Leader 拥有最新 snapshot 时，调用 `installSnapshot` 将 snapshot 发送给 follower。需要实现完整的 streaming 传输（`data` + `done` 分块发送）。
- **工作量**: 中

### [R-04] Pipeline 复制未实现：串行 AppendEntries
- **模块**: `src/consensus/raft-core.ts:propose`
- **严重度**: 🟡
- **对比**: etcd Raft 支持 pipeline 复制（持续发送未确认的条目），AgentiX 每次 propose 都等所有 peer 的 AppendEntries 响应返回后才接受下一个提案。
- **描述**: `propose()` 方法内部用 `await Promise.all()` 并行发送 AppendEntries 给所有 peers，但整体流程是串行的——一个新提案必须等待上一个提案的 AppendEntries 完成。重试逻辑（RAFTPROPOSERETRIES=3）也是同步的。没有维护 `inflight` 请求队列，`_nextIndex` 只在前一个提案的响应中更新。高吞吐场景下，Leader 的日志复制带宽受到 RTT 的严格限制。
- **方案**: 引入 pipeline 复制：Leader 可以连续接收 propose，对每个 propose 的条目立即写入本地 WAL，然后统一在心跳/批量 tick 中发送所有待确认的条目。参考 Raft 论文 §5.3（优化流水线）和 etcd raft 的 `MsgProp` 批处理机制。
- **工作量**: 中

### [R-05] 选举超时使用固定 jitter 范围可能多重选举
- **模块**: `src/consensus/raft-core.ts:_resetElectionTimeout`
- **严重度**: 🔵
- **对比**: 标准实践使用 `[T, 2T]`（如 etcd 用 1x electionTimeout ~ 2x electionTimeout），AgentiX 使用 `[T, 2T) = jitter = timeout + random(0, timeout)` 即 1-2 倍。
- **描述**: `_resetElectionTimeout` 的 `jitter = Math.floor(Math.random() * timeout) + timeout` 实际产生 `[timeout, 2*timeout)` 区间。这符合 Raft 论文建议。但文档中对 `electionTimeoutMs` 的默认值说明是 150ms，实际超时范围为 150-300ms。默认配置下心跳间隔 50ms，Leader 至少需要 3 次心跳才能维持领导权。在 200ms+ 网络延迟时可能触发不必要的选举。
- **方案**: 这是中等风险——在快速网络上工作良好，但在高延迟/丢包环境下可能需要调优。建议添加网络自适应超时或暴露可配置的 `electionTimeoutMaxMs`。
- **工作量**: 小

### [R-06] OTel 可观测性：Telemetry 和 Metrics 在每个公共方法中硬编码
- **模块**: `src/consensus/raft-core.ts`（全文件）
- **严重度**: 🔵
- **对比**: Neo4j/Dgraph 使用独立的可观测性框架（Prometheus/Grafana 集成），而非在核心共识代码中硬编码 Telemetry 调用。
- **描述**: `telemetry.traceAsync()` 和 `metrics.incrementCounter()` 在 RaftCore 的 `propose()`, `_handleAppendEntries`, `_startElection`, `_becomeLeader`, `_stepDown` 等方法中硬编码。虽然方便了可观测性，但对性能有影响（每次 propose 都要创建 trace span）。`Telemetry.getInstance()` 已是单例，但每次调用都构造 tracing 上下文有 overhead。
- **方案**: 不影响正确性。可考虑使用异步采样（概率采样 trace）减少性能开销，或将 metrics 更新改为批量提交而非单点上报。
- **工作量**: 小

---

## 3. WAL 性能

### [W-01] 全内存 WAL：所有日志条目常驻内存
- **模块**: `src/consensus/wal.ts`
- **严重度**: 🔴
- **对比**: 所有生产级 Raft（etcd/Neo4j/Dgraph）的 WAL 都是基于文件操作流式读取，不 all-in-memory。AgentiX 的 WAL 将所有日志条目加载到 `this.entries: LogEntry[]` + `this.entryMap: Map<number, LogEntry>`。
- **描述**: `open()` 时将整个文件读入 Buffer 并解析到 `this.entries` 数组。在有快照的情况下，WAL 仍然会保留快照截断后的所有日志。当 `snapshotThreshold=10000` 时，最多保留 10000 条日志 × 平均每条日志 ~1KB = ~10MB 常驻内存。但如果配置较大 threshold 或 snapshot 未及时触发，会持续增长。对于高吞吐图写入场景（百万级节点），WAL 内存占用可能达到 GB 级。另外，`readAll()` 返回完整数组拷贝，`getEntriesFrom()` 使用线性过滤。
- **方案**: 改为基于 mmap 或纯文件读取的惰性加载方式：(1) `this.entries` 只缓存最近 N 条条目，(2) 读取历史条目直接从文件 seek + read（Raft 不需要随机读取历史条目），(3) `entryMap` 可移除或改为稀疏索引（只存 offset 映射）。
- **工作量**: 中

### [W-02] 每次 append 都直接 write() + 无批量提交
- **模块**: `src/consensus/wal.ts:append`
- **严重度**: 🟡
- **对比**: etcd WAL 使用 page-aligned buffer + 批量 flush。Dgraph 的 WAL 也有 batch group commit。AgentiX 每次 append 都调用 `fs.writeSync()`。
- **描述**: `append()` 每次构造 12+ 字节头 + 数据后立即 `fs.writeSync(this.fd, buf, 0, buf.length, null)`。同步 I/O 且无批处理。每个 Raft propose 可能多次触发（Leader 写一次 + follower 在 AppendEntries handler 中也写一次）。`sync()` 方法虽存在但不被自动调用（以 `fsyncSync` 确保持久化...但 `append` 内部只 `writeSync` 不 `fsync`）。`truncateBefore()` 和 `truncate()` 内部调用 `fsyncSync`，但 `append()` 没有。
    > **关键问题**: `append()` 不调用 `fsyncSync()`，写入的数据可能在 OS 缓存中。当节点崩溃时，`append()` 声称已写入的数据可能丢失。Raft 要求日志在 Leader 对客户端返回前持久化（`propose()` 调 `append()` → 再广播 → 再 commit），但 `append()` 不落盘就不满足 Raft 安全性。
- **方案**: (1) 在 propose 的 `append()` 后立即 `fsyncSync`（或采用 group commit 批量 fsync），(2) 引入 WriteBuffer 在内存中累积 N 条后批量写入 + fsync，减少 syscall 次数，(3) 或将 sync 由 RaftCore 控制（Leader 在 commit 前确保 flush）。
- **工作量**: 中

### [W-03] 截断操作效率低：全量重写文件
- **模块**: `src/consensus/wal.ts:truncate / truncateBefore`
- **严重度**: 🟡
- **对比**: etcd WAL 使用多文件轮转（wal-0, wal-1...）+ 快照时切新文件；Kafka 的日志分段也是 append-only 配合分段删除。AgentiX 使用 ftruncate + 重写整个文件。
- **描述**: `truncate()` 和 `truncateBefore()` 的实现方式相同：将所有「保留的条目」编码为 buffer，`ftruncateSync(fd, 0)` 清空文件，再写入。这意味着每次快照或截断都是 O(N) 的完整重写（N = 保留条目数）。在 10000 条日志时 ~10MB 重写尚可接受，但如果 snapshot 表覆盖大量日志则代价高。此外，`truncateBefore` 在当前快照实现中有 bug（见 [R-02]）。
- **方案**: 改为分段 WAL 文件策略：每个 WAL 片段固定大小或时间窗口。Snapshot 后删除旧片段，新日志写入新文件。避免全量重写。
- **工作量**: 中

### [W-04] 无 CRC 校验
- **模块**: `src/consensus/wal.ts`
- **严重度**: 🟡
- **对比**: 所有生产级 WAL（etcd/Neo4j/Dgraph/PostgreSQL）都有 CRC 校验。etcd WAL 每条日志包含 CRC + 类型 + 数据 + CRC of prev entry。
- **描述**: WAL 二进制格式是 `[4B index][4B term][4B length][data]`，无校验和。文件损坏（例如部分写入后崩溃）时检测不到。`_parseBuffer` 只能通过 `if (offset + dataLen > buf.length)` 检测截断损坏，但对数据内容破坏无法感知。
- **方案**: 在 WAL 条目字段中增加 4 字节 CRC32。写入时计算并写入头部或尾部；读取时校验。也支持 `truncateBefore` 后的数据完整性验证。
- **工作量**: 小

### [W-05] File descriptor 在 `truncate` 后未被重置
- **模块**: `src/consensus/wal.ts:truncate / truncateBefore`
- **严重度**: 🔵
- **对比**: N/A
- **描述**: `truncate` 和 `truncateBefore` 在重建文件内容后使用相同的 `this.fd` 文件描述符。`ftruncateSync` 后 `writeSync` 从 offset 0 开始写入，由于 `a+` 模式打开，写入位置已在文件末尾（虽然 `ftruncateSync` 后位置应重置为 0？POSIX 中 `ftruncate` 不会改变文件偏移）。`fs.ftruncateSync` 后 `fs.writeSync(fd, buf, 0, buf.length, 0)` 显式指定 offset=0 是安全的。但 `fs.ftruncateSync` 在文件被其他进程共享时可能有竞争。
- **方案**: 属于低风险。`truncateBefore` 中使用 `a+` 模式打开，写入了新内容后 `fd` 文件偏移仍在写入末尾是正确的。确保 `ftruncate` + `write` 间无竞争（单线程使用）。
- **工作量**: 小

---

## 4. 重平衡

### [RH-01] 没有 WAL 重放，数据迁移非一致性保证
- **模块**: `src/reshard/reshard-worker.ts`
- **严重度**: 🔴
- **对比**: Dgraph 使用 Raft snapshot + WAL replay 做零停机分片迁移；JanusGraph 依赖底层 BigTable/Cassandra 的原子性保证。AgentiX 的 reshard 使用引擎 stat 对比不做数据完整性校验。
- **描述**: `reshard-worker.ts:execute()` 虽然有双写流程，但**实际不执行数据迁移**: 代码中 `execute()` 调用 `targetRange.start()`，更新进度到 10%，扫描统计信息后跳转到校验步骤。`migrated` 变量从未更新，没有从 source range 读取并写入 target range 的实际循环。校验步骤只比较 `nodeCount`，允许 ±10% 误差——这**不保证数据一致性**。更糟糕的是 `prepare()` 方法也只比较 `nodeCount`。所有实际数据复制逻辑缺失。
- **方案**: (1) 实现完整的数据扫描+迁移循环：从 source range 读取所有节点/边数据，写入 target range，(2) 迁移完成后做 checksum 比较（逐条校验或 Merkle 树），(3) 在迁移期间维护 WAL 变更日志（capture 迁移开始后发生的变更），(4) 迁移完成后重放这些变更到 target range。这本质上是 Dgraph 的 snapshot + WAL replay 模式。
- **工作量**: 大

### [RH-02] Rebalancer 使用引擎 hack 方式枚举所有节点
- **模块**: `src/shard/rebalancer.ts:collectNodesFromEngine`
- **严重度**: 🟡
- **对比**: JanusGraph 通过 ID block 管理节点（可以高效扫描 ID 范围）。AgentiX 通过 `(engine as any).db` 访问私有成员，并使用 1..N 的盲查询枚举节点。
- **描述**: `collectNodesFromEngine()` 滥用 `(engine as any).db` 访问内部 `OverGraph` 数据库实例，采用假设的 auto-increment ID 1..stats.nodeCount 的盲扫描策略。如果实际 ID 不连续（因删除或碎片导致），查询结果不完整，rebalance 计算偏差时错过节点。
- **方案**: 在 `GraphEngine` 上公开正式的枚举 API（如 `listNodeIds(page, pageSize)` 或迭代器模式），或维护全局节点计数+ID 统计。Rebalancer 应通过合法接口而非 `(engine as any).db` 访问数据。
- **工作量**: 中

### [RH-03] ReshardPlan 拆分策略过于简单
- **模块**: `src/reshard/reshard-plan.ts`
- **严重度**: 🟡
- **对比**: Dgraph Zero 基于底层分组大小和吞吐量自适应调整；ArangoDB Enterprise 支持基于负载的重平衡策略。
- **描述**: `generatePlan()` 只检查两个硬阈值（`maxNodes=10000`, `maxOpsPerSec=10000`），超出则按固定公式分配 `hashRangeEnd`。没有考虑数据分布的热区（某些 key 范围数据量远大于其他）、节点间负载差异、或网络拓扑。`hashRangeStart` 总是 0，意味着 split 没有基于实际一致性哈希环的分界点。
- **方案**: 改进分片策略：(1) 使用一致性哈希环上的实际热点分布决定 split 位置（而非固定 0-2147483647），(2) 考虑 CPU/内存/IO 多维负载，(3) 支持 merge（小 range 合并），(4) 可配置最小/最大分片大小。
- **工作量**: 中

### [RH-04] cleanup 使用 48h 固定延迟的 setTimeout
- **模块**: `src/reshard/reshard-manager.ts:_scheduleCleanup`
- **严重度**: 🔵
- **对比**: 竞品通常在 switch 完成后立即或短延迟（验证后）清理旧数据。
- **描述**: 清理计时器硬编码为 48h（`48 * 60 * 60 * 1000`），无持久化。若 ReshardManager 在这 48h 内崩溃重启，`cleanTimer` 丢失，旧 range 永久无法清理。另外，`rollback()` 在 state === 'completed' 时清理 target range 而非 source range——逻辑应该是回滚到旧配置，而非已经清理 target。
- **方案**: (1) 持久化清理计划到 WAL 或独立文件，(2) 启动时检查是否有未完成的清理任务，(3) cleanup 改为可配置策略（立即清理 / 延迟清理 / 手动确认），(4) 修复 rollback 逻辑——completed 状态回滚时应删除新 range 而非旧 range。
- **工作量**: 中

### [RH-05] Dual write 使用 `require()` 动态引用
- **模块**: `src/reshard/reshard-manager.ts:_startDualWrite`
- **严重度**: 🔵
- **对比**: 生产级系统使用编译时引用。
- **描述**: `_startDualWrite()` 中使用 `const { RangeInstance } = require('../shard/range-instance')` 动态 `require()`（运行时加载）。这在 TypeScript 有类型安全时是可以编译的，但绕过了 ES module 的静态分析。与文件开头的 `import { ShardManager } from '../shard/shard-manager'`（静态 import）不一致。
- **方案**: 改为文件顶层的静态 `import { RangeInstance } from '../shard/range-instance'`（已在 `_startDualWrite` 中被引用，当前仅用于动态 require）。
- **工作量**: 小

---

## 竞品对照总表

| 能力 | AgentIX | Neo4j(EE) | Dgraph | ArangoDB(EE) | JanusGraph |
|------|---------|-----------|--------|-------------|------------|
| 分片策略 | 一致性哈希 | 不支持分片(因果集群) | 谓词分组 | SmartGraph 哈希 | BigTable 行分片 |
| 智能路由 | ❌ 纯 hash | ✅ 复制组 | ✅ Alpha Group | ✅ 拓扑感知 | ❌ 依赖底层 |
| 快照完整性 | ❌ 仅 meta | ✅ | ✅ | ✅ | ✅ |
| InstallSnapshot | ❌ | ✅ | ✅ | ✅ | N/A |
| Pipeline 复制 | ❌ | ✅ | ✅ | ✅ | N/A |
| 运行时成员变更 | ❌ | ✅ Raft 扩展 | ✅ | ✅ | ✅ |
| WAL 批处理 | ❌ 单条 write | ✅ group commit | ✅ | ✅ | ✅ |
| WAL CRC | ❌ | ✅ | ✅ | ✅ | ✅ |
| 在线 Reshard | ⚠️ 架构存在 | ❌ 不支持 | ✅ | ✅ | ✅ |
| 数据迁移完整性 | ❌ 未实现 | N/A | ✅ WAL replay | ✅ | ✅ 底层保证 |

## 建议修复优先级

| 优先级 | ID | 描述 | 工作量 |
|--------|-----|------|--------|
| P0 | [RH-01] | Reshard 数据迁移未实现 | 大 |
| P0 | [R-02] | 快照不包含状态机数据 → 数据丢失风险 | 大 |
| P0 | [R-03] | InstallSnapshot 未实现 → follower 无法追赶 | 中 |
| P1 | [R-01] | 不支持运行时成员变更 | 大 |
| P1 | [W-02] | WAL append 不 fsync → 不满足 Raft 安全性 | 中 |
| P1 | [W-01] | WAL 全内存 → 可扩展性瓶颈 | 中 |
| P1 | [RH-02] | Rebalancer 使用 hack 方式访问引擎 | 中 |
| P2 | [S-01] | 无智能路由优化 | 中 |
| P2 | [R-04] | Pipeline 复制未实现 | 中 |
| P2 | [RH-03] | ReshardPlan 拆分策略简化 | 中 |
| P2 | [W-03] | WAL 截断全量重写 | 中 |
| P3 | [S-03] | 向量搜索 fan-out 无剪枝 | 中 |
| P3 | [W-04] | 无 CRC 校验 | 小 |
| P3 | [RH-05] | 动态 require | 小 |
