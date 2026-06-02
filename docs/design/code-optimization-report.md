# 分布式架构代码优化报告

> 基于 OverGraph 代码库 `v3 — Outbox: Peer 独立退避方案` 版本的代码审查结果。
> 涵盖 EventBus、EventStream、Outbox、MultiLeader、Raft 相关核心模块。
> 
> 版本: v1.1 (更新于 2026-05-27) — 新增同 DC 双通道兜底场景的优化分析

---

## 1. 类型安全缺失（高优先级）

### 1.1 `as any` 滥用 — EventBus

**问题**: `event-bus.ts` 中大量使用 `as any` 绕过类型检查。当前统计：13 处。

```typescript
// event-bus.ts:30-31 — 类型定义已弱化
type Router = any
type Dealer = any

// event-bus.ts:373-375 — 运行时注入类型
(this.config as any)._resolvedCurve = { ... }
(this.config as any)._peerNodeIds = peerNodeIds
(this.config as any)._peerNodeIds

// event-bus.ts:402-404 — 运行时类型转换
const s = dealer as any
```

**影响**: `as any` 意味着任何运行时错误不会被 TypeScript 编译器捕获。当 ZMQ 版本升级或配置格式变化时，错误在运行时才暴露。

**修复建议**:
```typescript
// 方案：定义显式接口替代 any
interface DealerSocket {
  send: (frames: Buffer[]) => Promise<void>
  close: () => void
  // zeromq types
}

// 使用 Partial<EventBusConfig> 替代运行时注入
interface InternalEventBusConfig extends EventBusConfig {
  _resolvedCurve?: ResolvedCurveConfig
  _peerNodeIds?: string[]
}
```

**波及范围**: `event-bus.ts` 中 15+ 处 `as any`。

---

### 1.2 `as any` 滥用 — outbox-replication.ts

**问题**: LMDB 查询结果被大量 `as any` 处理。

```typescript
// outbox-replication.ts:143
.forEach((entry: any) => {
// outbox-replication.ts:186
mainDb.getRange({ start: 1 }).forEach((entry: any) => {
// outbox-replication.ts:346
this.db.getRange({ start: 1 }).forEach((entry: any) => {
```

**影响**: LMDB 的 `getRange` 返回类型完全丢失，迭代时的类型推断能力为 0。

**修复建议**:
```typescript
interface DbEntry<T> {
  seq: number
  value: T
}
// 封装 getRangeTyped<T>(start, end): DbEntry<T>[]
```

---

### 1.3 `as any` 滥用 — multi-leader-test-node.ts

```typescript
eventBus: bus as any,   // 本应声明 EventBus 的完整类型
(replication as any).manager?.getPeerReports?.()
(replication as any).manager?.updateConfig?.(partial)
(bus as EventBus as any).getPeerNodeIds?.()?.length ?? 0
```

**影响**: 测试代码是架构的"活文档"，满篇 `as any` 让测试难以反映真实接口契约。

---

## 2. Raft 与 EventBus 架构隔离问题（高优先级）

### 2.1 Raft 路径与 EventBus 路径无隔离边界

**问题**: 当前设计中，`GraphEngine.upsertNode()` 同时触发了 **Raft 提交**（如果通过 RangeInstance）和 **EventBus 广播**（通过 `_emit()` + `_mlReplication()`），但两者没有事务边界。

```typescript
// graph-engine.ts:387-394
// upsertNode 中 mlReplication 和 _emit 之间没有事务——
// 如果 mlReplication 失败，本地存储已经写入
if (this._mlReplication && !opts?.skipReplication) {
  const result = await this._mlReplication.replicate(...)
  if (!result.success) {
    // 只打了日志，没有回滚本地写入
    this.logger.error(`Multi-Leader replication: ...`)
  }
}
```

**影响**:
- Raft 写入成功后 Outbox 写入失败 → 数据已在本地但未广播到 peer
- 发生节点故障时，这个节点恢复后，其他节点可能不知道这个变更
- 没有 **Outbox 事务性保证**（Raft commit 和 Outbox enqueue 不是原子的）

**修复建议**:
- 引入 **Outbox 优先写入**: 先写入 Outbox → 再 Raft propose
- 或使用 **Raft 日志驱动的 Outbox**: Raft 的 apply 回调中写入 Outbox，确保原子性

---

### 2.2 StandaloneConsensus 掩盖了 Raft 必选的设计意图

**问题**: `RangeInstance` 默认用 `StandaloneConsensus`（单节点），这意味着不显式传入 ConsensusProvider 时，Raft 共识根本不存在。

```typescript
// range-instance.ts:49-50
const cp = consensus ?? new StandaloneConsensus({
  nodeId: config.raftConfig.nodeId,
  mode: 'standalone',
})
```

**影响**: 生产中如果忘记配置 raft-logic，多个节点各自独立写入，数据完全不一致。

**修复建议**:
- 构造函数强制要求 ConsensusProvider 参数（删除 `??` fallback）
- 或将 `standalone` 模式改为显式"单节点开发模式"配置项

---

## 3. 幂等与去重窗口（中优先级）

### 3.1 DedupRing 容量固定

```typescript
// event-stream.ts:71-84
class DedupRing {
  private set = new Set<string>()
  private buf: (string | undefined)[]  // 固定 10000 容量
```

**问题**:
- 容量硬编码为 10000（构造函数默认值）
- 当吞吐非常高时（> 10000 msg/s），1 秒内就填满环
- 填满后最早的消息被逐出 → 同一消息在 1 秒后再次到达，被重复消费

**修复建议**:
- 根据节点配置动态计算容量（如 `maxThroughput × maxLatency × 1.5`）
- 或使用持久化去重（LMDB 存储 msgId-TTL）

### 3.2 `_applyingRemote` 是进程级标志，不跨进程

**问题**: `_applyingRemote` 是 GraphEngine 实例的私有 `boolean` 字段，仅在单个进程中生效。

```typescript
// graph-engine.ts:221
private _applyingRemote = false
```

**影响**: 在 WorkerPool 多进程模式下，每个子进程有独立的 GraphEngine 实例，各自维护 `_applyingRemote`。这意味着当 EventBusWorker 从子进程发送 ACK，主进程的 `_applyingRemote` 不感知。

**修复建议**:
- 添加 `msgId` 级别的去重持久化（在整个进程生命周期 + LMDB 范围内）
- `_applyingRemote` 只作为额外安全检查，不依赖它做业务去重

---

## 4. 错误处理与恢复（中优先级）

### 4.1 Outbox 的 ACK 超时无指数退避

```typescript
// outbox-replication.ts:810-830
if (now - sentAt > this._ackTimeoutMs) {
  // 固定 timeout 后立即重试
}
```

**问题**: 当前超时策略是固定的 `_ackTimeoutMs` + 线性退避 `maxBackoffSeconds`。没有指数退避 + 抖动（jitter），可能出现以下问题：
- 多个 OutboxWorker 同时退避并同时重试 → 突发的 dealer 重建风暴
- 弱网下频繁重建 dealer → 越重建越连不上

**修复建议**:
```typescript
const retryDelay = Math.min(
  backoff * Math.pow(2, retryCount),  // 指数
  maxBackoffMs                         // 上限
) * (0.5 + Math.random() * 0.5)        // 抖动
```

### 4.2 ZMQ 连接建立不在 Promise 中

**问题**: `_recoverDealerByNodeId` 中 dealer 连接是异步建立（ZMQ connect 是 lazy connect），调用后立即返回，无法确定连接何时就绪。

```typescript
// event-bus.ts 中 dealer 重建
dealer.connect(addr)  // ZMQ 异步连接
// 立即返回，不等待连接完成
```

**影响**: `notifyConnected` 在 dealer 实际可用之前就被触发，OutboxWorker 开始发送后可能立即失败。

**修复建议**:
- 引入 dealer 连接超时检测（发送 probe 消息）
- 或使用 `ZMQ_CONNECT_TIMEOUT` 设置连接超时
- 在 probe 完成后才触发 `notifyConnected`

### 4.3 全局 catch 空的错误处理

```typescript
// multi-leader-test-node.ts:237-239
} catch {
  // ignore malformed JSON
}
```

**影响**: 测试代码的错误被静默吞掉，故障排查困难。

---

## 5. 性能优化（中优先级）

### 5.1 ZMQ ROUTER 接收循环无背压控制

```typescript
// event-bus.ts:808
while (this.running && this.routerSocket) {
  const frames = await (this.routerSocket as any).receive()
  // 无缓冲/背压，收到后立即处理
}
```

**影响**: 高并发时 ROUTER 接收会耗尽所有可用 CPU 时间。没有背压意味着 ROUTER 可能被压垮。

**修复建议**: 引入生产者-消费者模式：
```
ROUTER receive → 缓冲区 (Array + 水位线)
  ├── 缓冲区 < watermark → 继续接收
  └── 缓冲区 > watermark → 延迟 recv()，给消费侧喘息空间
```

### 5.2 EventStream 的 `_onSyncQuery` 使用 `for...of` 全表扫描

```typescript
// event-stream.ts:386
private _onSyncQuery(msg: TransportMessage): void {
  // 遍历全部 seq 来同步... 如果有大量 WAL 条目会阻塞
}
```

**修复建议**: 对 WAL 使用索引（seq → 时间戳 → 范围查询），替代全表迭代。

### 5.3 事件序列化/反序列化开销

**问题**: 每条 EventBus 消息经过 `JSON.stringify` + `JSON.parse` 两次序列化（应用层 + ZMQ frame 解码）。

**影响**: 大型 graph 操作（如批量 upsert）的对象有 10KB+ payload，序列化开销显著。

**修复建议**:
- 使用 `msgpackr`（已在依赖中）做二进制序列化替代 JSON
- 对高频小消息（ACK、ping）使用固定二进制格式

### 5.4 LMDB getRange({ start: 1 }).forEach

```typescript
// outbox-replication.ts:186, 346, 363
mainDb.getRange({ start: 1 }).forEach((entry: any) => { ... })
```

**问题**: 从 seq=1 开始遍历整个数据范围获取所有条目。当 Outbox 有 100 万条目时，每次遍历 O(n)。

**修复建议**: 使用分页查询 + 游标，或维护单独索引。

---

## 6. 配置与文档（低优先级）

### 6.1 缺少 Raft 配置时的生产最佳实践文档

**问题**: 仓库中有 `reliable-replication-设计.md` 和 `EventBus_WorkerPool_实现方案_v2.md`，但缺少：
- 生产部署配置模板（3 节点、5 节点、多 DC）
- Raft 参数调优建议（electionTimeout / heartbeatInterval）
- EventBus HWM / sendHighWaterMark 的推荐值
- LMDB mapSize 的计算公式

### 6.2 测试覆盖缺口

**问题**: 以下关键路径缺乏测试覆盖：
- Outbox 超时重传 + 去重组合场景
- Raft propose 失败 + Outbox 回滚
- WorkerPool + EventBus 的多进程 ACK 超时恢复
- CURVE 加密配置错误的各种故障模式
- Raft Leader 切换期间的写入行为

---

## 7. 建议优先级排序

| 优先级 | 问题 | 影响 | 预估工时 |
|--------|------|------|---------|
| 🔴 P0 | Raft + Outbox 无事务边界 (§2.1) | 数据丢失风险 | 2-3d |
| 🔴 P0 | StandaloneConsensus 默认掩盖 Raft 必选 (§2.2) | 数据不一致 | 0.5d |
| 🟠 P1 | `as any` 类型安全缺失 (§1) | 运行时错误暴露晚 | 3-5d 分批 |
| 🟠 P1 | DedupRing 容量固定 + 不跨进程 (§3) | 重复消息 | 1d |
| 🟠 P1 | ZMQ 连接没有就绪检测 (§4.2) | 首次发送失败 | 1d |
| 🟡 P2 | 指数退避 + 抖动缺失 (§4.1) | dealer 重建风暴 | 0.5d |
| 🟡 P2 | ROUTER 背压控制 (§5.1) | 高并发压垮节点 | 1-2d |
| 🟡 P2 | msgpackr 二进制序列化 (§5.3) | 序列化开销 | 0.5d |
| 🟢 P3 | WAL 全表扫描 (§5.2) | 同步瓶颈 | 0.5d |
| 🟢 P3 | 生产配置文档 (§6) | 运维困难 | 1d |
| 🟢 P3 | 测试覆盖缺口 (§6.2) | 回归风险 | 3-5d |

---

## 8. 追踪

| 项目 | 状态 | 负责人 | 预计完成 |
|------|------|--------|---------|
| 性能优化 | ⏳ 待排期 | — | — |
| Raft + Outbox 事务边界 | ⏳ 待讨论 | — | — |
| 类型安全分批重构 | ⏳ 待排期 | — | — |

---

*审查日期: 2026-05-27 · 代码版本: 基于 OverGraph (agentiX-graphvec)*

---

## 9. 新增发现（v1.1 更新）

### 9.1 `isRaftLeader` 字段定义不当

**问题**: `EventBusConfig` 中包含 `isRaftLeader?: boolean` 字段（第129行），但 EventBus 是传输层，不应感知 Raft 角色。当前该字段控制：
- ROUTER server 是否绑定端口（非 Leader 时不启动 ROUTER）
- **风险**: 非 Leader 节点的 EventBus 不绑定端口 → 无法接收 Outbox 事件 → 同 DC 兜底失效

```typescript
// event-bus.ts:383 — isRaftLeader 影响 ROUTER 绑定
if (!this.config.isRaftLeader && this.config.publishAddress) {
  // 非 Raft Leader 节点不启动 ROUTER server
}
```

**影响**: 如果 Raft follower 节点不启动 ROUTER，OutboxWorker 无法向该节点发送事件。Raft Leader 切换后，新 Leader 可能有短暂的路由中断。

**修复建议**:
- EventBus 配置中移除 `isRaftLeader`
- 所有节点都应绑定 ROUTER server，即使不是 Raft Leader
- Raft 角色决策在共识层处理，不在传输层

### 9.2 Outbox 退避按拓扑分档缺失

**问题**: 当前 `maxBackoffSeconds` 是全局配置，不区分同 DC / 跨 DC / 边缘节点。
同 DC 和跨 DC 使用相同的退避上限，违背了"同 DC 快速恢复"的兜底设计意图。

**影响**: 同 DC 节点之间的 Raft 兜底可能被长退避削弱时效性。

**修复建议**:
```
Outbox 配置增加 per-topology backoff:
  maxBackoffSeconds: {
    intraDc: 3,     // 同 DC 短退避
    crossDc: 60,    // 跨 DC 长退避
    edge: 300,      // 边缘最大容忍
  }
```
可通过 Outbox 节点列表配置中的 `topology` 标签区分。

### 9.3 Outbox 写入与 Raft commit 的时序未约定

**问题**: 当前代码中 Outbox 在 Raft commit 后写入，但没有显式的时序保证契约。
这是跨函数顺序依赖（`graph-engine.ts` upsertNode → `_mlReplication.replicate`），容易在后续重构中被破坏。

**修复建议**: 在 Outbox 增加 `replicateAfterRaftCommit` 标志位或抽象 `Txn` 上下文：
```typescript
interface TxnContext {
  raftCommitted: boolean
  outboxEnqueued: boolean
  // 任何一个失败 → 整体失败
}
```

### 9.4 EventStream 的 `_emitLocal` 在 `_applyingRemote` 时被跳过

**问题**: 当 `_applyingRemote = true` 时，`GraphEngine` 跳过 `_emit()`（第395行），但 `_emitLocal`（EventStream 的本地回调）也被跳过。

```typescript
// graph-engine.ts:395
if (!this._applyingRemote) {
  this._emit({ type: 'node:created', ... })
  // _emitLocal 在本进程中触发的本地回调也被跳过了
}
```

**影响**: 如果某个节点依赖 EventStream 的本地事件回调来做缓存失效、索引更新等，远程应用时这些回调不会被触发。

**修复建议**: 分离 `_emit` 为 `_emitRemote`（广播）和 `_emitLocal`（本地），远程应用时只跳过广播部分。

### 9.5 zmq require 而非 import

**问题**: `event-bus.ts` 使用 `require('zeromq')`（第30行），而非 ESM import。

```typescript
// eslint-disable-next-line @typescript-eslint/no-var-requires
const zmq = require('zeromq')
```

**影响**: 项目已在向 ESM/MJS 迁移（存在 `event-bus.curvespec.mjs`），`require` 方式妨碍迁移。

**修复建议**: 升级到支持 ESM 的 zeromq 版本，改为 `import * as zmq from 'zeromq'`。

### 9.6 新增优先级更新

| 优先级 | 新发现 | 影响 | 预估 |
|--------|--------|------|------|
| 🟠 P1 | `isRaftLeader` 在传输层定义不当 (§9.1) | 非 Raft Leader 节点无 ROUTER → 同 DC 兜底失效 | 0.5d |
| 🟠 P1 | Outbox 缺少拓扑感知退避 (§9.2) | 同 DC 兜底时效性不足 | 0.5d |
| 🟡 P2 | Outbox 与 Raft commit 时序无契约 (§9.3) | 重构风险 | 0.5d |
| 🟡 P2 | `_emitLocal` 在远程应用时被跳过 (§9.4) | 本地回调丢失 | 0.5d |
| 🟢 P3 | zmq `require` 而非 ESM `import` (§9.5) | 妨碍 ESM 迁移 | 0.5d |

---

## 10. V10 新方向展望（⬜ 计划中）

> 根据 V10 深度调研（`temp/v10-gap-research.md`）汇总 8 个新方向，覆盖 API 完善、查询体验、运维可观测性三大板块。

| 方向 | GAP | 优先级 | 状态 | 概览 |
|------|:---:|:------:|:----:|------|
| OpenAPI/Swagger 文档 | GAP-43 | P3 | ⬜ 计划中 | Route 定义与 OpenAPI 元数据绑定，`openapi-bridge.ts` 自动聚合 |
| 健康检查增强 | GAP-44 | P3 | ⬜ 计划中 | K8s 风格 liveness/readiness 探针，组件级状态报告 |
| 查询超时/取消 | GAP-45 | **P2** | ⬜ 计划中 | QueryTimeoutManager 集成层，AbortSignal 引擎注入 |
| 审计日志导出 | GAP-46 | P3 | ⬜ 计划中 | AuditLogExporter 结构化导出 + 定时归档 |
| 自定义聚合函数 | GAP-47 | P3 | ⬜ 计划中 | AggregationRegistry 用户注册聚合函数（类似 ProcedureRegistry） |
| 多语言 SDK | GAP-48 | P3 | ⬜ 计划中 | Python/Go SDK 生产级增强 + Java SDK 骨架 |
| 压缩传输 | GAP-49 | P3 | ⬜ 计划中 | CompressionMiddleware gzip/brotli + gRPC 压缩 |
| 配置热加载 | GAP-50 | P3 | ⬜ 计划中 | ConfigWatcher 通用热加载（复用 chokidar） |

**详细设计**参见 `docs/design/execution-plan.md` 的 Phase 10 章节。

> 推荐执行顺序：GAP-45 → GAP-44 → GAP-47 → GAP-43 → GAP-50 → GAP-49 → GAP-46 → GAP-48

