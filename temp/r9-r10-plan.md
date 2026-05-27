# R9/R10 详细修复方案

> 2026-05-27
> 当前代码库：agentiX-graphvec
> 共识层：已使用 `raft-logic`（tikv/raft-rs WASM，^0.3.14），`ConsensusProvider` 接口抽象

---

## R9: 网络分区（Split-Brain）处理

### 当前状态 ❌

| 方面 | 现状 |
|------|------|
| 分区检测 | **无**。ConsensusProvider 无 `handlePartition()` 或 `onMajorityChange()` 方法 |
| Outbox 分区恢复 | Outbox 有重试/超时重传（R5），但**无分区专用的 catch-up 策略** |
| 现有测试 | `test/fault-injection/network-partition.test.ts` 3 个测试，但**仅 mock 级别**，不涉及真实 Raft 层 |
| 事件总线兜底 | EventBus 已配置为所有节点绑定 ROUTER + DEALER，支持分区恢复后的 Outbox 广播，但**无分区感知逻辑** |

### 问题分析

当网络分区发生时，Raft 的行为由 raft-rs WASM 引擎决定：

| 分区阶段 | Raft 行为 | Outbox 行为 | 问题 |
|---------|----------|------------|------|
| 分区中（少数派） | Leader 降级、`checkQuorum` 触发新选举 | Outbox 累积但发送超时 | 少数派对 Raft 写入超时，但 Outbox 继续堆积 |
| 分区中（多数派） | 新 Leader 选出，继续服务 | 新 Leader 的 Outbox 正常发送 | 旧 Leader 的 Outbox 到旧多数派可能错误完成 |
| 分区恢复 | Leader 从 snapshots + WAL 追日志 | Outbox 需要重新同步 | 旧 Leader（少数派）的 Outbox 需要回滚/同步 |

**核心风险**：分区期间少数派 leader 可能继续接受写入（如果 Raft 选举在超时窗口内）。Outbox 若在这些写入上生成消息，分区恢复后会出现幽灵消息。

### 修复方案

#### 方案 A: 自研 Raft-aware Partition Handler

**推荐 ✅** — 与当前 `ConsensusProvider` + `raft-logic` 架构一致

**为什么自研而不是用 npm 包**：
- `raft-logic`（tikv/raft-rs）是底层 Raft 引擎，不提供高层分区处理 API
- 需要的分区感知是一个**应用层概念**：检测 majority loss → 冻结少数派 Outbox → 恢复后 catch-up
- 没有 npm 包能直接集成到 `event-bus.ts` / `outbox-replication.ts` 的现有架构中

#### 详细设计

##### Step 1: 扩展 ConsensusProvider 接口

在 `src/consensus/consensus-provider.ts` 中新增：

```typescript
export interface ConsensusProvider {
  // ... 现有方法 ...

  /** 当前节点是否在 majority 仲裁中（Raft 集群健康） */
  inMajority(): boolean

  /** 获取当前已知的集群节点列表（raft-rs 的 ConfState） */
  getClusterMembers(): string[]

  /** 注册 majority-change 回调（true=进入 majority, false=失去 majority） */
  onMajorityChange(cb: (inMajority: boolean) => void): void
}
```

在 `RaftLogicConsensus` 中实现：

```typescript
// src/consensus/raft-logic-consensus.ts

private _inMajority = true  // 初始假定在 majority
private _majorityCallbacks: Array<(inMajority: boolean) => void> = []

inMajority(): boolean {
  return this._inMajority
}

getClusterMembers(): string[] {
  // 从 raft-rs RaftNode.confState 获取
  if (!this._node) return this.config.peers
  const confState = this._node.confState()
  // confState.learners, voters 等
  const voters: string[] = []
  for (const id of confState.voters) {
    voters.push(String(id))
  }
  return voters
}

onMajorityChange(cb: (inMajority: boolean) => void): void {
  this._majorityCallbacks.push(cb)
}

// 在 tick() 中检测：
private _checkMajority(): void {
  const leader = this._node.leaderId()
  const wasInMajority = this._inMajority
  // 策略：如果 leader == null 或无响应，认为失去 majority
  this._inMajority = leader !== null && leader !== 0
  if (wasInMajority !== this._inMajority) {
    for (const cb of this._majorityCallbacks) {
      cb(this._inMajority)
    }
  }
}
```

##### Step 2: Outbox 分区感知冻结

在 `src/core/outbox-replication.ts` 中：

```typescript
// PerPeerWorker 或 OutboxReplicationManager

/** 当不在 majority 时暂停出站 Outbox 发送，防止幽灵消息 */
private _frozen = false

setMajorityStatus(inMajority: boolean): void {
  if (!inMajority && !this._frozen) {
    this.logger.warn(`Not in majority! Freezing Outbox outgoing to prevent ghost messages`)
    this._frozen = true
  } else if (inMajority && this._frozen) {
    this.logger.info(`Back in majority! Unfreezing Outbox`)
    this._frozen = false
  }
}

// _tick() 中：
private async _tick(): Promise<void> {
  if (this._frozen) {
    this.logger.info('Outbox frozen (not in majority), deferring all sends')
    return
  }
  // ... 正常发送逻辑 ...
}
```

##### Step 3: 接入 EventBus

在 `GraphEngine` 或 `MultiLeaderReplication` 中：

```typescript
// 注册 majority 变化回调
this.consensus.onMajorityChange((inMajority) => {
  this.outboxMgr.setMajorityStatus(inMajority)
})
```

##### Step 4: 分区恢复 — Outbox Catch-Up

当分区恢复且节点重新加入 majority：

```typescript
async onRecoverFromPartition(): Promise<void> {
  // 1. 解冻 Outbox
  this._frozen = false

  // 2. 检查 Outbox 中是否有分区期间错误送达的消息
  //    通过 Outbox seq 与 Raft applied index 对比
  const raftIndex = await this.consensus.getAppliedIndex?.() ?? 0

  // 3. 对每个 peer，重放未确认的条目
  for (const [peerId] of this.workerMap) {
    const pending = await this.outbox.getPendingEntries(peerId)
    // 重新发送，DedupRing 确保幂等
    for (const entry of pending) {
      this.outbox.markUndelivered(entry.msgId)
    }
  }
}
```

#### 测试计划

```
test/fault-injection/network-partition.test.ts — 拓展到 6 个场景:

已存在 (mock 级):
  1. Partition → majority loss detected
  2. Recovery → Outbox unfrozen
  3. Ghost messages prevented during partition

新增 (真实 Raft 级):
  4. 3 节点集群 + 隔离 1 节点 → 该节点 Outbox frozen
  5. 分区恢复 → Outbox unfrozen, pending entries replayed
  6. 隔离 leader → 新 leader 选举 → 旧 leader 恢复后日志追平
  7. 集成测试：EventBus 的 Outbox catch-up 在分区后 30s 内恢复
```

---

## R10: Raft 成员变更

### 当前状态 ❌

| 方面 | 现状 |
|------|------|
| 成员变更 API | **无**。无 `addPeer()` / `removePeer()` / `changeMembership()` |
| Peer 列表 | **静态**，在 `MultiLeaderConfig` 构造时设定，永不变化 |
| raft-rs 能力 | raft-rs 原生支持 `proposeConfChange()` + `applyConfChange()`，但**当前暴露层未封装** |
| 现有测试 | **无** |
| EventBus 影响 | EventBus 的 DEALER/ROUTER 连接在构造时建立，成员变更需要动态重建 |

### 问题分析

缺乏成员变更能力的实际影响：

| 场景 | 当前行为 | 理想行为 |
|------|---------|---------|
| 新节点上线 | 手动修改配置、重启整个集群 | 动态 `addPeer()`，自动加入仲裁 |
| 节点下线 | 节点停止后仍被其他节点尝试连接 | `removePeer()`，自动移除 |
| 节点替换 | 停机替换，全集群重启 | 先 add 新节点，同步完成后 remove 旧节点 |
| 滚动升级 | 无法单独摘除节点 | 逐个 remove → upgrade → add |

### npm 包方案比较

我们已经在使用 `raft-logic`（tikv/raft-rs WASM），底层支持 `proposeConfChange`。问题是如何在应用层暴露安全的成员变更 API。

#### 方案比较

| 方案 | 原理 | 优点 | 缺点 | 结论 |
|------|------|------|------|------|
| **A. 自研（基于 raft-rs）** | 在 `RaftLogicConsensus` 上封装 `proposeConfChange` + `applyConfChange` | 与现有架构匹配；无新依赖；raft-rs 就是生产级 | 需要处理 joint consensus、回滚等边缘情况 | ✅ **推荐** |
| B. `@digitalbazaar/raft` | 纯 JS Raft 实现，全功能成员变更 | 开箱即用；JS 生态 | 无 WASM 加速；未在生产中使用；与现有 `raft-logic` 架构冲突 | ❌ |
| C. `swarmlib` | 分布式共识+成员管理 | 成员变更是内置特性 | 强耦合的框架级方案；与 EventBus 架构不兼容 | ❌ |
| D. `etcd3` / `node-etcd` | etcd gRPC 客户端 | 生产已验证 | 引入外部 etcd 依赖；不再是嵌入式共识 | ❌ |

**最终选择：自研（方案 A）**

理由：
1. **一致性**：当前共识层已经是 `raft-logic`（tikv/raft-rs），它原生支持 ConfChange（Raft 协议 §6 Change membership）
2. **零依赖增量**：无需安装新 npm 包
3. **架构匹配**：成员变更的副作用（EventBus 重建 DEALER 连接、Outbox 重路由）与应用层强相关，npm 包无法覆盖
4. **安全**：raft-rs 的 Joint Consensus 实现（两阶段成员变更）已生产验证（TiKV）

### 详细设计

##### Step 1: 扩展 ConsensusProvider

```typescript
export interface ConsensusProvider {
  // ... 现有方法 ...

  /** 安全添加新节点（joint consensus，两阶段） */
  addPeer(peerId: string): Promise<void>

  /** 安全移除节点（joint consensus，两阶段） */
  removePeer(peerId: string): Promise<void>

  /** 获取当前 conf state 中的节点 */
  getClusterMembers(): string[]

  /** 注册成员变更回调 */
  onMembershipChange(cb: (members: string[]) => void): void
}
```

##### Step 2: RaftLogicConsensus 实现

```typescript
// src/consensus/raft-logic-consensus.ts

async addPeer(peerId: string): Promise<void> {
  // 1. 检查是否为 Leader（只有 Leader 能提议成员变更）
  if (!this._node || this._node.leaderId() !== this._nodeIdNum()) {
    throw new Error('Only leader can propose membership change')
  }

  // 2. 生成 ConfChangeV2（使用 Joint Consensus 两阶段过渡）
  const { ConfChangeV2, ConfChangeTransition } = this._raftModule
  const cc = new ConfChangeV2()
  cc.transition = ConfChangeTransition.Explicit // 显式过渡

  const ccAdd = new ConfChangeSingle()
  ccAdd.change_type = ConfChangeType.AddNode
  ccAdd.node_id = Number(peerId)
  cc.changes = [ccAdd]

  // 3. propose 到 raft-rs
  const data = cc.marshal()
  await this.propose(data)

  // 4. 等待 applied（applyConfChange 在 apply 回调中处理）
  //    注：Joint Consensus 会在上一步中自动过渡到新的 C_new
}

async removePeer(peerId: string): Promise<void> {
  // 类似 addPeer，但 ChangeType 为 RemoveNode
  if (!this._node || this._node.leaderId() !== this._nodeIdNum()) {
    throw new Error('Only leader can propose membership change')
  }

  const { ConfChangeV2, ConfChangeSingle } = this._raftModule
  const cc = new ConfChangeV2()
  cc.transition = ConfChangeTransition.Explicit

  const ccRemove = new ConfChangeSingle()
  ccRemove.change_type = ConfChangeType.RemoveNode
  ccRemove.node_id = Number(peerId)
  cc.changes = [ccRemove]

  const data = cc.marshal()
  await this.propose(data)
}

// 在 apply() 回调中处理 conf change entry：
private _onApply(entry: RaftEntry): void {
  if (entry.entry_type === EntryType.EntryConfChangeV2) {
    const cc = ConfChangeV2.unmarshal(entry.data)
    this._node.applyConfChange(cc)
    // 通知上层成员变更
    const currentConf = this._node.confState()
    const members = [...currentConf.voters, ...currentConf.learners].map(String)
    for (const cb of this._membershipCallbacks) {
      cb(members)
    }
    return
  }
  // ... 常规 entry 的 apply ...
}
```

##### Step 3: 接入 MultiLeaderReplication

成员变更后需要：

```typescript
// 在 GraphEngine 或 MultiLeaderReplication 中注册回调
this.consensus.onMembershipChange(async (members) => {
  // 1. 更新 MultiLeaderConfig
  this.config.peers = members

  // 2. 新建/删除 Outbox Peer Workers
  for (const peer of members) {
    if (!this.outboxMgr.hasPeer(peer)) {
      await this.outboxMgr.addPeer(peer, peerConfig(peer))
    }
  }
  for (const peer of this.outboxMgr.currentPeers()) {
    if (!members.includes(peer)) {
      await this.outboxMgr.removePeer(peer)
    }
  }

  // 3. 通知 EventBus 重建 DEALER/ROUTER 连接
  if (this.eventBus) {
    await this.eventBus.onMembershipChange(members)
  }
})
```

##### Step 4: EventBus 动态连接管理

```typescript
// src/core/event-bus.ts

async onMembershipChange(members: string[]): Promise<void> {
  // 新增 peer → 创建 DEALER 连接
  for (const member of members) {
    if (!this._peers.has(member)) {
      await this._createDealer(member)
    }
  }
  // 移除 peer → 关闭 DEALER 连接
  for (const peer of this._peers.keys()) {
    if (!members.includes(peer)) {
      await this._closeDealer(peer)
    }
  }
}
```

#### 安全保证

| 风险 | 缓解措施 |
|------|---------|
| 同时多成员变更 | Joint Consensus 保证了 C_old+C_new 过渡期安全 |
| 成员变更中 Leader 切换 | raft-rs 的 ConfChangeTransition.Explicit 确保过渡完成为止 |
| 移除的节点重新加入 | 重新 addPeer() 即可，goes through normal joint consensus |
| 成员变更不匹配 | 所有成员必须在 `ConsensusConfig.peers` 列表内 |

#### 测试计划

```
test/integration/membership-change.test.ts — 6 个场景:

1. addPeer: 3→4 节点（C_old → C_old+C_new → C_new），确认集群健康
2. removePeer: 3→2 节点，确认离线节点不再被联系
3. addPeer 期间 Leader 切换 → 新 Leader 继续完成 Joint Consensus
4. removePeer → EventBus DEALER 连接关闭验证
5. addPeer → Outbox 开始向新节点发送
6. 成员变更回滚：addPeer 超时 → 自动回退到 C_old
7. 边际：添加已存在的节点 → 幂等忽略
8. 边际：移除不存在的节点 → 幂等忽略
```

---

## 执行计划（合并 R9+R10）

### 工作量估算

| 模块 | R9 工作量 | R10 工作量 | 并行度 |
|------|---------|-----------|--------|
| ConsensusProvider 扩展 | 0.5d | 0.5d | 可合并为 0.5d |
| RaftLogicConsensus 实现 | 1.5d | 2d | 不同 tick 方法可并行 |
| Outbox 分区冻结 | 1d | — | — |
| MultiLeaderReplication 接入 | 0.5d | 1d | 可并行 |
| EventBus 动态连接 | — | 1d | — |
| 集成测试 | 2d | 2d | 可并行 |
| 边际场景测试 | 0.5d | 0.5d | 可并行 |

**总计：约 8 人天**，2 人并行可 4 日历天完成

### 推荐的执行顺序

```
Week 1:
  周一: ConsensusProvider 扩展（0.5d）
        RaftLogicConsensus: inMajority() + clusterMembers()（0.5d）
        RaftLogicConsensus: proposeConfChange + applyConfChange（1d）
  周二: Outbox 分区冻结逻辑（1d）
        EventBus 动态连接管理（1d）
  周三: MultiLeaderReplication 回调接入（1d）
        集成测试：R9 分区场景（1d）
  周四: 集成测试：R10 成员变更场景（2d）
  周五: 全量验收 + 边际场景
```

### 验收标准

```
R9:
  ✅ 3 节点集群，隔离 1 节点 → 该节点 Outbox frozen
  ✅ 分区恢复 → Outbox unfrozen + catch-up
  ✅ 分区期间无幽灵消息（DedupRing 拒收)
  ✅ 集成测试 5+ 场景通过

R10:
  ✅ addPeer() 成功将节点加入集群
  ✅ removePeer() 安全移除节点
  ✅ 成员变更后 EventBus 连接重建
  ✅ Joint Consensus 保证过渡安全
  ✅ 集成测试 6+ 场景通过

全量:
  ✅ test:all 0 失败
```
