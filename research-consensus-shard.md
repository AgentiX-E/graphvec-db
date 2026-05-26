# Consensus & Shard Layer — Deep Code Research Report

**Project**: AgentiX GraphVec  
**Analysis date**: 2026-05-26  
**Researcher**: Subagent (consensus-shard)

---

## Table of Contents

1. [InstallSnapshot (R04)](#1-installsnapshot-r04)
2. [成员变更 (R05)](#2-成员变更-r05)
3. [readIndex Safety (R08)](#3-readindex-safety-r08)
4. [Reshard 分片迁移 (SH01-SH04)](#4-reshard-分片迁移-sh01-sh04)
5. [LMDB WAL 迁移 (S04/R01/R02/R07)](#5-lmdb-wal-迁移-s04r01r02r07)
6. [总结与优先级](#6-总结与优先级)

---

## 1. InstallSnapshot (R04)

### 问题描述

raft-logic WASM 的 InstallSnapshot RPC 回调未实现。当 Follower 日志落后 leader 太多时，leader 会发送快照而非日志条目。当前不存在 `_onSnapshot()` 回调处理。

### 代码缺口分析

#### 1.1 raft-logic WASM 类型声明（`optional-deps.d.ts`）

`RaftNode` 类型在第 54-74 行定义：

- **`triggerSnapshot()`** (L73): `triggerSnapshot(opts?: { compact?: boolean }): Promise<void>` — 只有主动触发 compact 的能力
- **`clientRequest()`** (L68): 支持 `waitFor: 'apply' | 'commit'` 等待策略
- **`readIndex()`** (L69): 只读索引等待
- **`transport.apply` callback** (L63): `apply: (entry: { index: number; term: number; data: Uint8Array }) => Promise<void>` — 仅处理日志条目 apply

**关键发现**: raft-logic 类型声明中**没有 InstallSnapshot 相关的回调接口**。类型声明中没有 `onSnapshot`、`InstallSnapshot` 或 `snapshotCallback` 等字段。

#### 1.2 raft-logic-consensus.ts 中的使用

- **L28**: `_snapshotTimer` — 只用于**主动触发 snapshot compact**，不是接收 InstallSnapshot
- **L143-158**: `start()` 中的 `apply` 回调 — 只处理日志条目，无 InstallSnapshot 处理
  ```
  apply: async (entry: any) => {
    this._entryCount++
    if (this.applyFn) {
      await this.applyFn(Buffer.from(entry.data))
    }
  }
  ```
- **L151-158**: `_snapshotTimer` 定时器 — 每 60 秒检查 entryCount ≥ 10000，调用 `_triggerSnapshotOnce()` (L307-318)
- **L307-318**: `_triggerSnapshotOnce()` — 只做 `_node.triggerSnapshot({ compact: true })`，不涉及 InstallSnapshot 的接收

#### 1.3 Transport 接口（`transport.ts`）

- **L18-19**: `RaftMessageType` 已定义 `InstallSnapshot` / `InstallSnapshotResponse`
- **L65-72**: `InstallSnapshotRequest` 接口已定义
- **L73-76**: `InstallSnapshotResponse` 接口已定义
- **L86-89**: `Transport` 接口已包含 `installSnapshot?()` 方法（可选）
- **L220-221**: `MockTransport.installSnapshot()` 有**空实现** — 直接返回 success，不做任何数据处理
  ```typescript
  async installSnapshot(to: string, snapshot: InstallSnapshotRequest): Promise<InstallSnapshotResponse> {
    return { term: snapshot.term, success: true }
  }
  ```

**结论**: Transport 层定义了 InstallSnapshot 的消息类型和接口，但 raft-logic WASM 的 RaftNode 初始化选项中**没有**自动触发 InstallSnapshot 的机制。整个 InstallSnapshot 数据接收 + 引用的流程是**空白**。

#### 1.4 现有 snapshot 能力

- **`GraphEngine.exportSnapshot()`** (L960-963): 将图引擎当前状态导出为 Buffer
- **`GraphEngine.importSnapshot()`** (L971-974): 从 Buffer 恢复图引擎状态
- **`OverGraphStorage.exportSnapshot()`** (L190-194): 底层 overgraph 存储的 snapshot 导出
- **`OverGraphStorage.importSnapshot()`** (L197-198): 底层 overgraph 存储的 snapshot 导入

基础能力存在，但未集成到共识层的 InstallSnapshot 流程中。

### 实现方案

#### 方案 A（推荐）：自研 InstallSnapshot 流程集成

由于 raft-logic WASM 的 `RaftNode` 类型声明中没有 `onSnapshot` 回调，需要在传输层实现 InstallSnapshot 逻辑。

**实现步骤**:

**A1. 在 `raft-logic-consensus.ts` 中新增 InstallSnapshot 处理**:

```typescript
// 新增配置：快照传输超时（ms）
private _installSnapshotTimeout = 60000

// 新增 InstallSnapshot 回调处理
private async _handleInstallSnapshot(
  term: number,
  leaderId: string,
  lastIncludedIndex: number,
  lastIncludedTerm: number,
  snapshotData: Uint8Array
): Promise<void> {
  // 1. 导出当前图引擎状态为 snapshot
  // 2. 验证 snapshot 完整性
  // 3. 应用到图引擎
  // 4. 截断 WAL（truncateBefore lastIncludedIndex）
  // 5. 更新 raft-logic 的存储
}
```

**A2. 扩展 TcpTransport 支持 InstallSnapshot 分块传输**:

使用 `transport.ts` 中已有的 `InstallSnapshotRequest` / `InstallSnapshotResponse` 消息类型。

**A3. 适配 raft-logic RaftNode 初始化参数**：

raft-logic 的 `RaftNode` 初始化参数中（L54-66 of `optional-deps.d.ts`），目前有 `apply` 回调。需要确认 raft-logic WASM 实际实现中是否支持：
- `onSnapshot` 回调字段 — 如果有，直接使用
- 如果没有，需要在自定义 TcpTransport 层面响应 InstallSnapshot 消息

**优先做法**: 先检查 raft-logic npm 包的**实际源码**（非类型声明），看 `RaftNode` 是否暴露 InstallSnapshot 回调。如果未暴露，通过 TcpTransport 的消息处理层拦截 `InstallSnapshot` 类型消息并在应用层处理。

**A4. 集成到 `range-instance.ts`**:

在 `_applyToStateMachine` 中新增 `install_snapshot` 操作类型:
```typescript
case 'install_snapshot': {
  const p = this._validatePayload(op.payload)
  this.engine.importSnapshot(Buffer.from(p.snapshotData as string, 'base64'))
  break
}
```

#### 方案 B（备选）：消息队列方式

如果 protocol buffer 传输不适合，可以用 Node.js Stream 分块传输 snapshot 数据，避免大对象阻塞。

### 可行性评估

| 维度 | 评估 |
|------|------|
| 现有代码复用度 | 高 — `transport.ts` 已有消息类型和接口；`GraphEngine` 已有 snapshot 导出/导入 |
| 新代码量 | 约 200-300 行（主要在 `raft-logic-consensus.ts` + TcpTransport 扩展） |
| npm 包需求 | 不需要新 npm 包 — `GraphEngine.exportSnapshot/importSnapshot` 已提供基础能力 |
| 风险 | 中 — raft-logic WASM 包的实际能力可能与类型声明不一致，需验证 |

---

## 2. 成员变更 (R05)

### 问题描述

不支持运行时加/删 Raft 节点。raft-logic 通过 `raft.log.proposeConfChange()` 提供成员变更支持，但当前未使用。

### 代码缺口分析

#### 2.1 关键词搜索结果

```
$ grep -rn "proposeConfChange\|ConfChange\|addPeer\|removePeer\|MemberChange\|member_change\|membership" src/ --include="*.ts"
→ 无输出
```

**结论**: 项目代码中完全没有任何与成员变更/ConfChange 相关的实现。

#### 2.2 `transport.ts` 已有但未使用的定义

- **L20**: `'MembershipChange'` 已在 `RaftMessageType` 中定义
- **`Transport` 接口 (L80-92)**: 没有任何 `confChange` 或 `proposeConfChange` 相关方法
- **`RaftMessage` 类型 (L22-27)**: 包含 `from`/`to` 字段，但无 `proposeConfChange` 回调

#### 2.3 raft-logic WASM 类型声明

`optional-deps.d.ts` 的 `RaftNode` (L57-74):
- 无 `proposeConfChange` 方法
- 无 `applyConfChange` 方法
- 无成员变更相关的任何回调

**关键疑问**: raft-logic npm 包的实际实现是否比类型声明提供更多 API？类型声明是简化版。

#### 2.4 `shard-manager.ts` 节点管理接口

- **`addRange()` (L361-363)**: 仅做 `Map.set()` — 用于 resharding 场景，无 Raft 集群成员变更
- **`removeRange()` (L367-369)**: 仅做 `Map.delete()` — 无 Raft 集群成员变更
- **`shard-manager.ts` 没有任何 addPeer/removePeer/confChange 方法**

### 实现方案

#### 方案 A: 通过 raft-logic 原生 API

1. 检查 raft-logic npm 包的实际 `RaftNode` API，确认是否有 `proposeConfChange` 或类似方法
2. 若有，在 `RaftLogicConsensus` 中新增 `proposeConfChange()` 方法
3. 在 `ShardManager` 和 `ReshardManager` 中调用

#### 方案 B: 自研成员变更（如果 raft-logic 不支持）

在应用层实现类似 Raft 成员变更的协议：

1. **新增 `RaftNodeConfig` 的 `peers` 支持热更新**
   - 在 `range-instance.ts` 的 `_applyToStateMachine` 中新增 `conf_change` 操作类型
   - 写入当前 raft 配置到 GraphEngine

2. **transport 层面支持 MembershipChange 消息**
   - `transport.ts` 的 `MembershipChange` 消息类型已定义（L20）
   - 需要实现具体处理逻辑

3. **共识层接口扩展**:
   在 `ConsensusProvider` 中新增：
   ```typescript
   // 新增到 ConsensusProvider 接口
   proposeConfChange?(newPeers: string[]): Promise<void>
   ```

#### 方案 C（推荐）: 两阶段切换

1. 协议层面使用一致性哈希实现数据再分布（非 Raft 成员变更）
2. Raft 组内节点保持不变
3. 通过 ReshardManager 添加新 Range + 清洗旧 Range 来实现"伪成员变更"

### 可行性评估

| 维度 | 评估 |
|------|------|
| 现有代码复用度 | 低 — 几乎无复用代码，但 `MembershipChange` 消息类型已定义 |
| 新代码量 | 约 400-500 行（共识层 + shard-manager + transport + 测试） |
| npm 包需求 | 不需要新 npm 包 |
| 风险 | 中高 — raft-logic 的实际 API 不确定；成员变更的正确性极难保证（联合共识/单步变更） |

---

## 3. readIndex Safety (R08)

### 问题描述

当前 `readIndex()` 在 `standalone-consensus.ts` 中为空实现（`return`），在 `raft-logic-consensus.ts` 中可能未正确等待 commit index 超过 applied index。

### 代码缺口分析

#### 3.1 `range-instance.ts` 中的 `read()` 方法 (L217)

```typescript
async read<T>(reader: (engine: GraphEngine) => T): Promise<T> {
  this._touch()
  return this.telemetry.traceAsync('raft.read', async () => {
    await this.consensus.readIndex()  // <-- 第220行: 调用 readIndex()
    const result = reader(this.engine)
    this.metrics.incrementCounter('graph.ops.reads')
    return result
  })
}
```

**问题**: `range-instance.ts:220` 调用 `consensus.readIndex()` 但未检查返回值。如果 `readIndex()` 不等待（返回 void），则无法提供任何线性一致保证。

#### 3.2 `standalone-consensus.ts` 的 `readIndex()` (L44-45)

```typescript
async readIndex(_timeoutMs?: number): Promise<void> {
  return  // <-- 空实现，直接返回
}
```

对于 standalone 模式，单节点无需 readIndex 等待。**合理**，用户无需修复。

#### 3.3 `raft-logic-consensus.ts` 的 `readIndex()` (L265-267)

```typescript
async readIndex(timeoutMs?: number): Promise<void> {
  if (!this._node) return
  await this._node.readIndex({ timeout: timeoutMs ?? 3000 })
}
```

- **L265-267**: 委托给 raft-logic WASM 的 `readIndex()` API
- raft-logic WASM 的 `readIndex()` 类型签名 (optional-deps.d.ts:69):
  ```typescript
  readIndex(opts?: { timeout?: number }): Promise<void>
  ```
  返回 `Promise<void>`，**不返回是否读到安全位置的指示**。

**关键问题**: raft-logic WASM 的 `readIndex()` 语义不确定：
1. 如果 WASM 内部 `readIndex` 等 Leader 回复后返回 —— 则当前代码正确
2. 如果 WASM 内部只是发送了一个 readIndex 请求但不等完成就返回 —— 则当前代码有竞态

**当前代码的表现**:
- 正常情况：`await this._node.readIndex()` 返回 → proceed to read (语义正确)
- 竞态情况：如果在 readIndex() 返回后、`reader(this.engine)` 执行前，Leader commit 了新数据，读的结果仍然是"合法"的（因为是之前某个时间点的快照）
- 真正的线性一致读保证是：**读到的结果不能早于 readIndex 请求发出后的任何写入**

**现有 SafeReader (safe-reader.ts) 的封装**:

`safe-reader.ts:47` 实际上做了 `await this._provider.readIndex(this._timeoutMs)`，然后执行读操作。这是一个典型的 Raft 线性一致读模式。问题在于：

1. 没有**读等待的可见确认**（确认 readIndex 已完成）
2. `standalone` 模式直接 return 跳过（合理）

#### 3.4 `ShardManager` 中的 fan-out 读

`shard-manager.ts` 中的多个方法（如 `findNodesByType`, `vectorSearch`）调用 `range.read()` 进行 fan-out 读。每个 read 内部调用 readIndex，这会带来 **N 倍 readIndex 开销**（N = Range 数量）。例如：
- `findNodesByType` (L276-287): 对每个 range 执行 `range.read(engine => engine.findNodesByType(typeId))`
- `vectorSearch` (L310-318): 对每个 range 执行 `range.read(engine => engine.vectorSearch(query))`

每个 `range.read()` 内部都会调用 `consensus.readIndex()`。

### 修复方案

#### 1. 确认 raft-logic WASM 的 readIndex 语义

需要检查 raft-logic npm 包的**实际实现**。理论上 Raft 线性一致读（§8）在接收 readIndex 响应后确保：
> "In raft, a ReadIndex request means: the leader determines its commit index and sends it back to the node that requested it. The node then waits for its own applied index to reach that commit index, before serving the read."

**如果 raft-logic 实现了上述语义**，当前代码正确。
**如果 raft-logic 的 readIndex 是空操作**，需要自建机制。

#### 2. 如果 raft-logic readIndex 语义不足，自定义实现

在 `raft-logic-consensus.ts` 中重写 `readIndex()`:

```typescript
async readIndex(timeoutMs?: number): Promise<void> {
  if (!this._node) return
  
  // 使用 barrier() 确认 commit index
  // raft-logic optional-deps.d.ts:71 定义了 barrier() API
  const tm = timeoutMs ?? 3000
  try {
    await this._node.barrier({ timeout: tm })
  } catch {
    // barrier 失败时回退到 readIndex
    await this._node.readIndex({ timeout: tm })
  }
}
```

`barrier()`（Raft 论文 §6.4）确保所有在 barrier 请求之前的提案都已 apply。如果 raft-logic 实现了 barrier，这能保证线性一致。

#### 3. Fan-out 读优化

对于 `ShardManager` 的 fan-out 读，可以在**一个 readIndex 全局等待后**并行执行所有 range 的读，而不是每个 range 单独 readIndex：

```typescript
// 优化前：每个 range 单独 readIndex
for (const range of this.ranges) {
  promises.push(range.read(engine => engine.findNodesByType(typeId)))
}

// 优化后：先 readIndex 一次，再并行读
// 需要 ShardManager 持有一个全局 "最新 readIndex" 时间戳
const lastReadIndex = await this._globalReadIndex()
for (const [_, range] of this.ranges) {
  promises.push(range.readWithKnownIndex(engine => ...))
}
```

### 可行性评估

| 维度 | 评估 |
|------|------|
| 当前代码风险 | **中** — raft-logic 的 readIndex 语义不明确，但常见 WASM 实现通常正确 |
| 修复难度 | 低 — 利用 raft-logic 的 `barrier()` API（如果可用） |
| 新增代码量 | 约 50-100 行 |
| npm 包需求 | 不需要新 npm 包 |
| 优化建议 | fan-out 读的 readIndex 去重 — 减少 N 倍调用 |

---

## 4. Reshard 分片迁移 (SH01-SH04)

### 问题描述

`reshard-manager.ts` 中的 `execute()` 未真正实现高效数据复制。`rebalancer.ts` 的校验逻辑缺失。`auto-splitter.ts` 未触发实际 split。

### 4.1 `reshard-manager.ts` 分析

#### `_startDualWrite()` (L138-162)

- **L138**: `this._status!.state = 'dual_write'` — 设置状态
- **L141-155**: 为每个 split 创建新的 `RangeInstance`（带新的 `RangeConfig`）
- **L156**: `await targetInstance.start()` — 启动目标 Range（无数据）
- **L158**: `this.shardManager.addRange(split.targetRangeId, targetInstance)` — 注册到 ShardManager
- **L160**: 创建 `ReshardWorker`

**问题**: **`_startDualWrite()` 没有真正启用"双写"**。双写意味着 ShardManager 的所有写入操作应同时写入源和目标 Range。当前实现仅仅在 ShardManager 的 `ranges` Map 中注册了目标 Range，但 ShardManager 的写入方法（如 `upsertNode`, `upsertEdge`, `batchUpsertNodes`）都使用 `this.router.getRangeForKey()` 路由（L175-193）。**如果 hash ring 尚未更新，写入不会自动"双写"到目标 Range**。

缺少的机制：
- 写入拦截器：当处于 `dual_write` 状态时，每个写请求应写入源 Range + 目标 Range
- 或修改 router 在 dual_write 阶段使目标 Range 也接收写入

#### `_migrateData()` (L164-167)

```typescript
private async _migrateData(plan: ReshardingPlan): Promise<void> {
  this._status!.state = 'migrating'
  for (const worker of this.workers) {
    await worker.execute()
  }
}
```

**问题**: 逐 worker 串行执行。当 splits 数量大时效率低。

#### `_atomicSwitch()` (L178-225)

- **L188-199**: Prepare 阶段 — 调用 `worker.prepare()` 只检查节点数（`reshard-worker.ts:135-149`）
- **L209-225**: Commit 阶段 — 重建 `ShardMap` 并调用 `shardManager.rebuildRouter(newMap)`

**问题**:
- `worker.prepare()` (reshard-worker.ts:135-149): 校验极其简单——只检查 `targetStats.storage?.nodeCount >= sourceCount * 0.9`，允许 10% 误差。**无数据 checksum 校验**，无逐节点对账。

#### `_scheduleCleanup()` (L227-237)

```typescript
private _scheduleCleanup(plan: ReshardingPlan, delayMs: number): void {
  this.cleanTimer = setTimeout(() => {
    for (const split of plan.splits) {
      try {
        this.shardManager.removeRange(split.targetRangeId)  // <-- BUG: 应该删除 SOURCE，不是 TARGET
      } catch { }
    }
  }, delayMs)
}
```

**L233**: **严重 Bug** — 48 小时后清理的是 `targetRangeId`，但语义应该是保留目标 Range、删除源 Range。

### 4.2 `reshard-worker.ts` 分析

#### `execute()` (L39-126)

**阶段 1: 全量扫描节点 (L46-79)**

```typescript
const sourceNodes = await scanAllNodes(this.sourceRange)
for (let i = 0; i < sourceNodes.length; i += batchSize) {
  const batch = sourceNodes.slice(i, i + batchSize)
  for (const node of batch) {
    await this.targetRange.write({ type: 'upsert_node', payload: ... })
  }
}
```

**问题**:
- **性能**: 逐节点写入（甚至不是批量写入），每个节点都需要一次完整 Raft propose。batchUpsertNodes 未使用。
- **scanAllNodes 函数** (L51-68): 使用 `engine.queryPattern({ depth: 1, limit: pageSize })` 扫描，返回值类型不确定。`queryPattern` 返回 `NodeRecord[]` 吗？如果是，直接分页扫描可用。但**没有使用 `exportSnapshot()`**——更高效的 snapshot 方式被忽略了。
- **数据一致性**: 扫描过程中源 Range 可能有写入，未使用 snapshot 或 barrier 保证一致性视图。

**阶段 2: 迁移边 (L82-116)**

- 只迁移前 10000 个节点的边（`edgeLimit = Math.min(sourceNodes.length, 10000)`）
- 每个解边权重读 + 写入，性能极差
- **无批量写入**

**阶段 3: 校验 (L118-125)**

```typescript
if (sourceStats.storage.nodeCount !== targetStats.storage.nodeCount) {
  this.logger.warn(`Node count mismatch`)
}
```

- **只对比 count，不做内容校验**。count 相同也可能数据不同。

### 4.3 `rebalancer.ts` 分析

#### `_doRebalance()` (L199-234)

- **找到热节点** (`_findHotNodes`, L239-264): 用 `findNodesByType(0..19)` 收集节点 ID，按 ID 降序取"热节点"。**方法有严重问题**:
  - 遍历 20 个 typeId，O(20N) 查询
  - "热节点"只是 ID 最大的节点，与实际负载无关
  - 没有真正的热节点检测算法

#### `_doRebalanceNodes()` (L280-328)

- 逻辑结构正确：setup draining → migrate → cleanup
- `_migrateCleanup` (L349-379): 删除源数据，流程正确
- **但 `_migrateNode` (L328-347) 无 batch 操作**

#### `getStats()` (L133-159)

- 统计正确，但 `needsRebalancing` 判定逻辑缺少**历史趋势判断**——仅在单个检查点看瞬时值

### 4.4 `auto-splitter.ts` 分析

#### `_check()` (L80-105)

```typescript
if (nodeCount > this._config.maxNodesPerRange) {
  this._onReshard()  // 触发外部 Reshard
}
```

- **L93**: 触发 `_onReshard()`，但自动 split 只触发重分片，**没有向 split 中的 range 传递任何 split 建议**
- AutoSplitter 发现超标就触发，由外部决定 split 方案，两者信息未沟通

### 4.5 现有数据迁移能力

**已有的 `GraphEngine` snapshot 能力** (graph-engine.ts):
- **`exportSnapshot()`** (L960-963): 全量导出图引擎状态为 Buffer
- **`importSnapshot()`** (L971-974): 从 Buffer 恢复图引擎状态

**OverGraph NVMD (overgraph-storage.ts)**:
- **`exportSnapshot()`** (L190-194): 相同的 snapshot 能力

**但这些方法在 reshard-worker.ts 和 rebalancer.ts 中完全未被使用**。

### 实现方案

#### SH01: 重写 `reshard-worker.ts` 的 `execute()`

```typescript
async execute(): Promise<void> {
  await this.targetRange.start()
  
  // 1. 使用 Consensus barrier 或 readIndex 获取一致性快照点
  await this.sourceRange.waitForConsistentSnapshot()
  
  // 2. 使用 GraphEngine 的 exportSnapshot 批量导出数据
  const snapshotData = await this.sourceRange.read(engine => engine.exportSnapshot())
  
  // 3. 使用 GraphEngine 的 importSnapshot 批量导入数据
  await this.targetRange.write({
    type: 'install_snapshot',
    payload: { snapshotData: snapshotData.toString('base64') }
  })
  
  // 4. 增量同步：迁移 barrier 后的新写入
  // (需要 WAL 的 tailer 机制)
  
  // 5. 校验：checksum 比较
  const sourceCheck = await this.sourceRange.read(engine => engine.checksum())
  const targetCheck = await this.targetRange.read(engine => engine.checksum())
  if (sourceCheck !== targetCheck) { throw new Error('Checksum mismatch') }
}
```

#### SH02: 实现真正的双写

在 `ShardManager` 中新增双写机制：

```typescript
// 新增到 ShardManager
private _dualWriteTargets: Map<string, RangeInstance> = new Map()

enableDualWrite(splits: ReshardSplit[]): void {
  for (const split of splits) {
    const target = this.ranges.get(split.targetRangeId)
    if (target) this._dualWriteTargets.set(split.sourceRangeId, target)
  }
}

// 在 write 方法中增加双写
private async _write(sourceRangeId: string, op: ...): Promise<void> {
  const source = this.getRange(sourceRangeId)
  // 如果存在双写目标，同时写入
  const target = this._dualWriteTargets.get(sourceRangeId)
  if (target) {
    await Promise.all([source.write(op), target.write(op)])
  } else {
    await source.write(op)
  }
}
```

#### SH03: 修复 rebalancer 的热节点检测

使用真实的 operation 计数而不是 ID 排序：

```typescript
// 方法签名改为接收 operationMetrics → 找真正的热节点
private async _findHotNodes(range: RangeInstance, count: number): Promise<NodeId[]> {
  // 按 typeId 收集所有节点
  const allNodes = await range.read(engine => {
    // 使用 GraphEngine 已有的 queryPattern 或节点遍历
    // 按 operation count 排序
  })
  // 返回 top N 热节点
}
```

#### SH04: AutoSplitter 传递 split 建议

```typescript
private async _check(): Promise<number> {
  // ...
  if (nodeCount > this._config.maxNodesPerRange) {
    // 传递 split 建议信息
    this._onReshard({ 
      triggerBy: rangeId, 
      suggestedSplitKey: this._computeSplitKey(range),
      targetNodeCount: nodeCount
    })
  }
}
```

### npm 包对比

| 方案 | npm 包 | 复杂度 | 适用性 |
|------|--------|--------|--------|
| 使用现有 `exportSnapshot/importSnapshot` | ❌ 不需要新包 | 低 | ✅ 最佳路径 |
| 使用 streaming 分块传输 | `through2`, `stream-buffers` | 中 | 可选，大 snapshot 可用 |
| 实时增量同步 | ❌ 不需要新包 | 高 | 必须实现（增量追 catch-up） |

**核心方案**: 使用已有的 `exportSnapshot/importSnapshot` 实现全量 base 迁移，加上 WAL tailer 实现增量 catch-up。**不需要新 npm 包**。

### 路线图

| 子项 | 优先级 | 代码位置 | 工作量 |
|------|--------|----------|--------|
| SH01: Worker 使用 snapshot API | **P0** | `reshard-worker.ts` execute() | 2d |
| SH02: 双写机制 | **P0** | `shard-manager.ts` + `reshard-manager.ts` | 1-2d |
| SH03: _scheduleCleanup bug 修复 | **P0** | `reshard-manager.ts:233` | 0.5d |
| SH04: Worker data validation | **P1** | `reshard-worker.ts prepare()` | 1d |
| SH05: 热节点检测修复 | **P1** | `rebalancer.ts _findHotNodes()` | 1d |
| SH06: AutoSplitter 通讯 | **P2** | `auto-splitter.ts` | 0.5d |

---

## 5. LMDB WAL 迁移 (S04/R01/R02/R07)

### 问题描述

当前 `lmdb-wal.ts` 已存在但未作为默认 WAL 接入。`wal.ts` 仍然是内存数组实现。

### 代码缺口分析

#### 5.1 `wal.ts` vs `lmdb-wal.ts` 接口对比

**`wal.ts` (LogEntry)**:

| 方法 | 状态 | 备注 |
|------|------|------|
| `open()` | ✅ | 实现 |
| `append(term, data)` | ✅ | 实现 |
| `truncate(lastIndex)` | ✅ | 实现 |
| `truncateBefore(index)` | ✅ | 实现 |
| `readAll()` | ✅ | **全量加载到内存** → OOM 风险 |
| `getEntry(index)` | ✅ | **O(n) 数组遍历** |
| `getEntriesFrom(startIndex)` | ✅ | **O(n) 数组遍历** |
| `close()` | ✅ | 实现 |
| `sync()` | ✅ | `fs.fsyncSync` |
| `destroy()` | ✅ | 实现 |
| `persistMeta(key, value)` | ✅ | 实现 |
| `loadMeta(key)` | ✅ | 实现 |

**关键问题**: `wal.ts:24` — `private entries: LogEntry[] = []` — 所有日志条目存在内存数组。当 WAL 有数百万条记录时会导致 OOM。

**`lmdb-wal.ts` (LmdbWal)**:

| 方法 | 实现 | 优势 |
|------|------|------|
| `open()` | ✅ LMDB `open()` | ✅ 磁盘存储，不占内存 |
| `append(term, data)` | ✅ `entriesDb.put(index, encode(...))` | ✅ 直接写 LMDB |
| `truncate(lastIndex)` | ✅ 逐条删除 | ✅ 磁盘操作 |
| `truncateBefore(index)` | ✅ `_deleteBefore` | ✅ 磁盘操作 |
| `readAll()` | ✅ 从 LMDB 读取 | ✅ 按需加载 |
| `getEntry(index)` | ✅ LMDB `get()` (O(log n)) | ✅ O(log n) 而不是 O(n) |
| `getEntriesFrom(startIndex)` | ✅ LMDB 范围查询 | ✅ O(log n + m) |
| `close()` | ✅ `db.close()` | ✅ |
| `sync()` | ✅ `transactionSync` | ✅ |
| `destroy()` | ✅ `fs.rmSync` | ✅ |
| `persistMeta(key, value)` | ✅ `metaDb.put()` | ✅ LMDB 事务安全 |
| `loadMeta(key)` | ✅ `metaDb.get()` | ✅ |

**结论**: `LmdbWal` 是 `WAL` 的超集——功能上完全兼容且性能更好。

#### 5.2 现有调用链

`consensus-factory.ts` 中:
- 创建 `RaftLogicConsensus` (L18-37) → 内部无 WAL 使用
- `raft-logic` 使用 `SqliteStorage` 管理自己的日志（logs are managed by raft-rs internally）

`range-instance.ts` 中:
- **完全不使用 WAL** — Raft 共识引擎内部自己管理日志

**目前 WAL 类在整个共识层的使用**: 未在任何共识实现中直接使用。`wal.ts` 和 `lmdb-wal.ts` 是**未被引用的独立模块**。

#### 5.3 搜索 `new Wal(` 调用

```
$ grep -rn "new Wal(" src/ --include="*.ts"
→ 无输出
```

**WAL 未被实例化**。

`SegmentStreamWal` (`src/core/event-stream.ts:118`) 是一个不同的 WAL 实现，用于事件流，不与 Raft 共识层的 WAL 共享。

#### 5.4 Raft 日志存储现状

raft-logic 使用自己的 `SqliteStorage` (optional-deps.d.ts:48-52): `new SqliteStorage({ file: './data/raft-${nodeId}.db' })`。

**所以 lmdb-wal.ts 的迁移路径不是替换当前 raft-logic 的存储——raft-logic 已经有自己的 SQLite 持久化。** `WAL` 类的定位应当是为应用程序提供 raft-logic 之外的可追溯日志，或者作为跨 DC 复制、备份的 log tailer。

### 迁移方案

#### 方案 A: 保留 wal.ts 作为 raft-logic 覆盖层

**场景**: raft-logic 的 SQLite 存储可能不适合高吞吐场景。

1. 在 `raft-logic-consensus.ts` 中新增配置选项，允许替换为 LMDB 存储
2. 扩展 `LmdbWal` 实现 raft-logic 的 `Storage` 接口：

```typescript
// lmdb-wal.ts 新增适配层
export class LmdbRaftStorage {
  private wal: LmdbWal
  
  async open(): Promise<void> { await this.wal.open() }
  async append(entry: LogEntry): Promise<void> { await this.wal.append(entry.term, entry.data) }
  async entriesFrom(start: number): Promise<LogEntry[]> { return this.wal.getEntriesFrom(start) }
  async lastIndex(): Promise<number> { return this.wal.getLastIndex() }
  async truncateTo(index: number): Promise<void> { await this.wal.truncateBefore(index) }
}
```

#### 方案 B: LMDB WAL 作为 raft-logic 外部备份日志

**推荐路径**, 利用 lmdb-wal 作为 raft-logic 的增量日志备份：

1. 在 `raft-logic-consensus.ts` 的 `apply`
1. 在 `raft-logic-consensus.ts` 的 `apply` 回调中，同时写入 LMDB WAL：
```typescript
apply: async (entry: any) => {
  this._entryCount++
  if (this.applyFn) {
    await this.applyFn(Buffer.from(entry.data))
  }
  // 可选：同时写入 LmdbWal 作为审计/备份日志
  if (this._lmdbWal) {
    await this._lmdbWal.append(entry.term, entry.data)
  }
}
```

2. 使用 LMDB WAL 作为跨 DC 同步的日志供应源
3. `persistMeta/loadMeta` 用于跨 DC 同步的 LSN checkpoint

#### 方案 C: 删除 wal.ts，统一为 lmdb-wal.ts

1. 删除 `wal.ts`（含内存数组，有 OOM 风险）
2. 所有的 WAL 引用改为 `LmdbWal`
3. 新增 `LmdbWal` 的测试套件（目前 `src/consensus/wal.spec.ts` 测试的仍是 `WAL` 类）

### 现有缺陷

**LmdbWal 实现本身的问题**:

| 行号 | 代码 | 问题 |
|------|------|------|
| L108 | `entriesCount()` | `(this.entriesDb as any).getCount()` — `any` 类型断言，无类型安全 |
| L126-134 | `readAll()` | 全量读取到内存，放弃 LMDB 按需加载优势 |
| L161-171 | `_lastEntry()` | 使用 `any` 类型断言访问 `getRange` API |
| L173-179 | `_entries()` | 同上 |
| L181-185 | `_deleteRange()` | 逐条删除，非事务批量删除 |
| L187-191 | `_deleteBefore()` | 同上，逐条删除 |

**性能缺陷**: `_deleteRange()` 和 `_deleteBefore()` 使用 `for...of` 循环逐条删除，当需要删除数万条记录时性能很差。LMDB 支持事务内的批量 `remove`，但不暴露为 Node API。可选方案：
- 用 LMDB 事务包装批量删除
- 直接删除整个 `entries` 子数据库并重建

### 调用点分析

```
$ grep -rn "new Wal(" src/ --include="*.ts" | grep -v ".spec.ts"
→ 无输出
$ grep -rn "new LmdbWal(" src/ --include="*.ts" | grep -v ".spec.ts"
→ 无输出
```

**Wal 和 LmdbWal 都未被实际实例化。** 当前共识层使用 raft-logic 的 `SqliteStorage` 做日志存储。

### 推荐行动计划

1. **短期 (P0)**: 保留现状。raft-logic 的 SqliteStorage 已经够用
2. **中期 (P1)**: 将 `lmdb-wal.ts` 接入为 raft-logic 的**备份/审计日志**
   - 新增 `RaftLogicConsensus` 选项 `backupWalPath`
   - 在 `apply` 回调中同步/异步写入 LMDB
3. **长期 (P2)**: 如果性能基准显示 SQLite 是瓶颈，实现 `LmdbRaftStorage` 适配层替换 raft-logic 的 SqliteStorage

### 可行性评估

| 维度 | 评估 |
|------|------|
| 当前代码风险 | 低 — 现有 wal.ts 和 lmdb-wal.ts 都未被使用 |
| 改造难度 | 低 — `LmdbWal` 已具备完整功能，仅需接入 |
| 新增代码量 | 约 50-100 行（接入代码） |
| npm 依赖 | `lmdb` 和 `msgpackr` 已在 `package.json` 中 |
| 测试覆盖 | `wal.spec.ts` 测试 WAL 类，`lmdb-wal.spec.ts` 应创建 |

---

## 6. 总结与优先级

### 优先级矩阵

| 项 | 严重度 | 影响范围 | 紧急度 | 优先级 | 工作量 |
|----|--------|----------|--------|--------|--------|
| **SH01**: reshard-worker 使用 snapshot | C | 安全 | 高 | **P0** | 2d |
| **SH02**: 双写机制缺失 | C | 崩溃 | 高 | **P0** | 1-2d |
| **SH03**: reshard-manager L233 cleanup bug | C | 崩溃 | 高 | **P0** | 0.5d |
| **SH04**: 校验逻辑缺失 | C | 安全 | 高 | **P1** | 1d |
| **SH05**: Hot node 检测错误 | C | 功能 | 高 | **P1** | 1d |
| **R04**: InstallSnapshot 缺失 | B | 稳定性 | 中 | **P1** | 2-3d |
| **SH06**: AutoSplitter 通讯 | C | 功能 | 中 | **P2** | 0.5d |
| **R05**: 成员变更 | B | 功能 | 低 | **P2** | 4-5d |
| **R08**: readIndex 确认 | B | 正确性 | 低 | **P2** | 0.5d |
| **LMDB WAL**: 接入 | A | 性能 | 低 | **P3** | 1-2d |

### 关键优先级: P0 项

1. **reshard-manager.ts L233 的 cleanup bug** — 0.5d fix，删除对象错误导致目标数据丢失
2. **双写机制** — reshard 期间写入自动复制到目标 Range
3. **Worker 使用 snapshot API** — 从逐节点改为 `exportSnapshot/importSnapshot`

### 不需要引入新 npm 包的判断

所有项都可以用现有依赖完成。关键资产：
- `GraphEngine.exportSnapshot()` / `importSnapshot()` — 用于 InstallSnapshot 和 Reshard
- `transport.ts` 的 `InstallSnapshotRequest/Response` — 消息类型已定义
- `lmdb` + `msgpackr` — 已存在于依赖中，直接使用
- raft-logic WASM 的 `readIndex()` / `barrier()` — readIndex safety 依赖此 API

### 最推荐的开始路径

1. 修复 `reshard-manager.ts:233` cleanup bug（最小改动，高影响）
2. 实现双写机制：`ShardManager.enableDualWrite()`
3. 重写 `reshard-worker.ts` 使用 `exportSnapshot/importSnapshot`
4. 验证 raft-logic `readIndex` 语义后完善 R08 安全层
5. InstallSnapshot 实现（需要确认 raft-logic 实际 API）
6. 成员变更（可推迟到需要动态扩缩容时）
