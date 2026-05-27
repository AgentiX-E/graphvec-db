# 分布式系统中网络分区处理与动态成员变更：通用设计模式

> 通用设计文档，不绑定特定代码库或项目
> 本模式适用于任何基于 Raft 共识的分布式系统（数据库、消息队列、分布式存储）

---

## 概述

本设计模式解决分布式系统中的两大核心问题：

1. **网络分区（Split-Brain）**：当集群被网络故障分割为多个分区时的安全处理
2. **动态成员变更（Membership Change）**：在不中断服务的情况下添加/移除集群节点

这两个问题紧密关联——分区期间的成员变更决策需要分区感知，而成员变更本身就是一种潜在的"分区原因"（新节点初期的不可达）。

### 适用场景

| 场景 | 示例 |
|------|------|
| 分布式数据库 | CockroachDB、TiDB、YugabyteDB 的 Region/Tablet 迁移 |
| 消息队列 | Kafka、Pulsar 的 Broker 上下线 |
| 分布式存储 | Ceph、MinIO 的 OSD 替换 |
| 配置管理 | etcd、Consul 的集群扩缩容 |
| 分布式共识层 | 任何基于 Raft/Paxos 的自研共识实现 |

---

## 核心抽象：共识提供者接口

无论底层使用哪种共识算法（Raft、Multi-Paxos、Zab），建议先抽象一个共识提供者接口：

```typescript
interface ConsensusProvider {
  // ── 基本操作 ──
  start(): Promise<void>
  stop(): Promise<void>
  propose(data: Uint8Array, timeoutMs?: number): Promise<{ ok: boolean }>
  readIndex(timeoutMs?: number): Promise<void>

  // ── 角色查询 ──
  getRole(): 'leader' | 'follower' | 'candidate' | 'standalone'
  getLeaderId(): string | null

  // ── 安全保证 ──
  barrier(timeoutMs?: number): Promise<void>

  // ── 网络分区处理（R9） ──
  inMajority(): boolean
  onMajorityChange(cb: (inMajority: boolean) => void): void

  // ── 动态成员变更（R10） ──
  addPeer(peerId: string): Promise<void>
  removePeer(peerId: string): Promise<void>
  getClusterMembers(): string[]
  onMembershipChange(cb: (members: string[]) => void): void
}
```

---

# 模式一：网络分区（Split-Brain）处理

## 问题

当网络分区发生时，Raft 集群被分为 majority 分区（多数派）和 minority 分区（少数派）：

```
+-------+         +-------+
| NodeA |  <--->  | NodeB |
+-------+         +-------+
    ^                 ^
    |   ✂️ PARTITION   |
    v                 v
+-------+         +-------+
| NodeC |  ✂️      | NodeD |
+-------+         +-------+
```

**阶段分析**：

| 分区阶段 | Majority 侧 | Minority 侧 |
|---------|-------------|-------------|
| 分区中 | 新 Leader 选出，继续服务 | Leader 降级，写入超时 |
| 分区恢复 | 拥有最新已提交日志 | 落后，需重新同步 |
| 核心风险 | — | **少数派若接受了写入（窗口期内），恢复后会产生幽灵消息** |

## 核心模式

### 模式元素

| 元素 | 职责 |
|------|------|
| **Majority Detector** | 监控 Raft 心跳和 quorum 状态，感知 majority 变化 |
| **Outbox Freeze** | 当不在 majority 时冻结出站消息发送 |
| **Outbox Catch-Up** | 分区恢复后重放未送达的消息 |
| **Dedup Guard** | 接收端的幂等去重，确保至少一次语义 |

### 完整数据流

```
  写入请求
      │
      ▼
  ┌─────────────────────────────┐
  │ Raft Layer                  │
  │  propose() → commit → apply │
  └──────────┬──────────────────┘
             │
             ▼
  ┌─────────────────────────────┐
  │ Outbox Layer                │
  │  ┌─────────┐  ┌──────────┐ │
  │  │ 正常操作 │  │分区时冻结 │ │
  │  │ enqueue │→ │ defer    │ │
  │  │ send    │  │ (no-op)  │ │
  │  └─────────┘  └────┬─────┘ │
  └────────────────────┼───────┘
                       │
                       ▼
  ┌─────────────────────────────┐
  │ Majority Detector           │
  │  onMajorityChange(cb)      │
  │  ├ false → freeze Outbox   │
  │  └ true  → unfreeze + pull │
  └─────────────────────────────┘
```

### Majority Detector 实现策略

#### 方案 A: Leader 存在检测（推荐）

```typescript
// 通用实现，不绑定特定 Raft 库
private _inMajority = true
private _majorityCallbacks: Array<(inMajority: boolean) => void> = []

_checkMajority(): void {
  const leader = this.getLeaderId()
  const wasInMajority = this._inMajority
  
  // 策略：如果已知 leader 且不是 0（无效值），
  // 且最大 commit index 在增长（存在 Raft 活动）
  const leaderAlive = leader !== null && leader !== '0'
  const commitIndexAdvancing = this._maxCommitIndex > this._lastCommitIndex
  
  this._inMajority = leaderAlive && commitIndexAdvancing
  
  if (wasInMajority !== this._inMajority) {
    for (const cb of this._majorityCallbacks) {
      cb(this._inMajority)
    }
  }
  this._lastCommitIndex = this._maxCommitIndex
}
```

#### 方案 B: 对等节点 Ping（fallback）

当 Raft 层无法提供 leader 状态时，使用应用层心跳：

```typescript
private _pingPeers(): void {
  let aliveCount = 0
  for (const peer of this.peers) {
    if (this._ping(peer)) aliveCount++
  }
  // majority = alive > peers.length / 2
  const inMajority = aliveCount > this.peers.length / 2
  // ... fire callbacks ...
}
```

### Outbox Freeze 模式

```typescript
class OutboxReplicationManager {
  private _frozen = false

  setMajorityStatus(inMajority: boolean): void {
    if (!inMajority && !this._frozen) {
      logger.warn('Not in majority! Freezing outgoing replication')
      this._frozen = true
    } else if (inMajority && this._frozen) {
      logger.info('Back in majority! Resuming replication')
      this._frozen = false
    }
  }

  private async _tick(): Promise<void> {
    if (this._frozen) {
      // 冻结：不发送任何消息，只保持连接活性
      return this._keepAlivePing()
    }
    // 正常发送逻辑
  }
}
```

### Outbox Catch-Up 模式

分区恢复后的三步恢复：

```typescript
async onPartitionRecovered(): Promise<void> {
  // 1. 解冻
  this._frozen = false

  // 2. 对比 Raft commit index 与 Outbox send index
  const raftIndex = await this.consensus.getAppliedIndex?.() ?? 0
  const outboxIndex = await this.outbox.getLastSentIndex()

  // 3. 重放分区期间积压但未确认的条目
  if (outboxIndex > raftIndex) {
    // 少数派在此期间有写入但未进入 Raft 日志 → 标记为回滚
    await this.outbox.rollbackTo(raftIndex)
  } else if (raftIndex > outboxIndex) {
    // Raft 在前进了但 Outbox 未发送 → 重新发送
    const pending = await this.outbox.getPendingEntries()
    for (const entry of pending) {
      await this._resend(entry)
    }
  }
}
```

### 幂等保护（必要前提）

Outbox Freeze 模式依赖"至少一次"语义——即接收端必须能够去重：

```typescript
class DedupRing {
  private ring: Set<string>
  private fifo: string[]
  private capacity: number

  constructor(capacity: number = 10000) {
    this.ring = new Set()
    this.fifo = []
    this.capacity = capacity
  }

  isDuplicate(msgId: string): boolean {
    return this.ring.has(msgId)
  }

  markSeen(msgId: string): void {
    if (this.ring.size >= this.capacity) {
      // FIFO 驱逐
      const oldest = this.fifo.shift()!
      this.ring.delete(oldest)
    }
    this.ring.add(msgId)
    this.fifo.push(msgId)
  }
}
```

---

# 模式二：动态成员变更

## 问题

静态 peer 列表在以下场景无法支持：

| 场景 | 静态列表行为 | 理想行为 |
|------|-------------|---------|
| 扩缩容 | 停机修改配置 → 重启集群 | 动态增减节点，零停机 |
| 硬件替换 | 移除旧节点，加入新节点 | 先 add 新节点（数据同步完），再 remove 旧节点 |
| 滚动升级 | 无法单独摘除 | 逐个 remove → upgrade → add |
| 自动弹性伸缩 | 不支持 | 根据负载自动增减节点 |

## 核心模式

### Joint Consensus（两阶段过渡）

Raft 协议 §6 定义的成员变更安全模型：

```
阶段 1 (C_old + C_new):
  ┌─────────────────────┐
  │  多数派条件变为：    │
  │  (majority of C_old)│
  │  AND                │
  │  (majority of C_new)│
  └─────────────────────┘

阶段 2 (C_new):
  ┌─────────────────────┐
  │  正常多数派条件      │
  │  majority of C_new  │
  └─────────────────────┘
```

这一设计保证了安全性的核心定理：
- **任何在两个配置中都被 commit 的条目，不可能在任一配置的多数派中被覆盖**

### 实现模式

```typescript
class ConsensusManager {
  // ── 公共 API ──

  async addPeer(peerId: string): Promise<void> {
    this._assertIsLeader()
    // 阶段 1: propose C_old + C_new
    await this._proposeConfChange({
      type: 'AddNode',
      nodeId: peerId,
      transition: 'Explicit'
    })
    // apply 回调中自动进入 C_old+C_new
    // 无需显式等待，Joint Consensus 自动过渡
  }

  async removePeer(peerId: string): Promise<void> {
    this._assertIsLeader()
    await this._proposeConfChange({
      type: 'RemoveNode',
      nodeId: peerId,
      transition: 'Explicit'
    })
  }

  // ── 内部实现 ──

  private async _proposeConfChange(cc: ConfChange): Promise<void> {
    const data = this._marshalConfChange(cc)
    const result = await this.propose(data)
    if (!result.ok) throw new Error('ConfChange rejected')
  }

  // 在 apply 回调中：
  private _onApply(entry: RaftEntry): void {
    if (entry.type === 'ConfChangeV2') {
      const cc = this._unmarshalConfChange(entry.data)
      this._raftNode.applyConfChange(cc)
      this._notifyMembershipChange()
      return
    }
    // ... 常规条目 apply ...
  }

  private _notifyMembershipChange(): void {
    const confState = this._raftNode.getConfState()
    const members = [...confState.voters].map(String)
    for (const cb of this._membershipCallbacks) {
      cb(members)
    }
  }
}
```

### 成员变更副作用处理

成员变更不只是共识层的事——它影响整个系统的所有连接和状态：

```
成员变更事件
    │
    ├─→ 更新 peer 列表 (config)
    │
    ├─→ 重建消息队列连接:
    │   ├ addPeer  → 新建 Outbox Worker + EventBus DEALER
    │   └ removePeer → 关闭 Outbox Worker + DEALER
    │
    ├─→ 重建网络连接:
    │   ├ addPeer  → TCP 连接 + TLS 握手 + CURVE 密钥交换
    │   └ removePeer → 优雅关闭 + 资源清理
    │
    └─→ 更新健康检查/监控:
        ├ 新节点 → 加入健康检查轮询
        └ 移除节点 → 从健康检查摘除
```

```typescript
class SideEffectManager {
  private outboxWorkers: Map<string, OutboxWorker>
  private dealerSockets: Map<string, DealerSocket>

  onMembershipChange(members: string[]): void {
    const current = new Set(this.outboxWorkers.keys())
    const target = new Set(members)

    // 新增节点
    for (const member of members) {
      if (!current.has(member)) {
        await this.outboxWorkers.add(member, configFor(member))
        await this.dealerSockets.connect(member, addrFor(member))
      }
    }

    // 移除节点
    for (const existing of current) {
      if (!target.has(existing)) {
        await this.outboxWorkers.remove(existing)
        await this.dealerSockets.close(existing)
      }
    }
  }
}
```

### 安全保证矩阵

| 风险 | 缓解措施 | 覆盖范围 |
|------|---------|---------|
| 同时多成员变更 | Joint Consensus 保证 C_old+C_new 过渡安全 | Raft 协议层 |
| 变更中 Leader 切换 | raft-rs ConfChangeTransition.Explicit 确保过渡完成为止 | 共识层 |
| 移除节点重新加入 | 重新 addPeer()，正常 Joint Consensus | 共识层 |
| 变更期间数据不一致 | Outbox Freeze （见模式一）在成员变更期间保护 | 应用层 |
| 新旧连接混用 | SideEffectManager 原子更新 peer 列表 | 应用层 |

---

# 测试策略

## 单元测试

```typescript
// Outbox Freeze 测试框架
describe('OutboxFreeze', () => {
  it('stops sending when out of majority')
  it('resumes sending when back in majority')
  it('does not lose pending entries while frozen')
  it('catch-up replays only non-delivered entries')
})

// Membership Change 测试框架
describe('MembershipChange', () => {
  it('addPeer transitions C_old → C_old+C_new → C_new')
  it('removePeer removes from conf state')
  it('addPeer during leader switch completes joint consensus')
  it('addPeer creates new outbox worker')
  it('removePeer closes dealer socket')
  it('add existing peer is idempotent')
  it('remove non-existent peer is idempotent')
})
```

## 集成测试（混沌工程）

构建一个 3-5 节点集群，对以下场景做混沌测试：

| 场景 | 验证点 |
|------|--------|
| 隔离 1 节点（丢包 100% 持续 10s） | 被隔离节点 Outbox frozen |
| 恢复网络 | 分区节点 catch-up 后 unfrozen |
| 隔离 Leader | 新 Leader 选举，旧 Leader frozen |
| 3→4 节点扩容 | 新节点接收完整快照 + 日志追平 |
| 4→3 节点缩容 | 移除节点不再被联系 |
| MemberChange + Partition 并发 | 变更期间突然分区 → 安全回退 |
| MemberChange + LeaderSwitch 并发 | 变更未完成时 Leader 挂了 → 新 Leader 继续 |

---

# 选择指南

## 何时使用

| 条件 | 适用模式 | 理由 |
|------|---------|------|
| 数据需要强一致性 | 两者都需要 | Raft + Outbox Freeze 保证无幽灵消息 |
| 允许最终一致性 | 优先只做成员变更 | Outbox Freeze 带来的复杂度 > 收益 |
| 3 节点以上集群 | 两者都需要 | 分区概率随节点数增加 |
| 2 节点集群 | 不需要成员变更 | Joint Consensus 需要 3 节点以上 |
| 无自动扩缩容需求 | 只做分区感知 | 成员变更是操作开销 |

## 复杂度评估

| 模式 | 代码行数估计 | 引入的复杂度 | 风险 |
|------|------------|------------|------|
| Majority Detector | ~80 行 | 低 | 低（只读检测，不改数据） |
| Outbox Freeze | ~100 行 | 低 | 低（冻结不影响已写入） |
| Outbox Catch-Up | ~150 行 | 中 | 中（需要正确处理 index 对比） |
| Joint Consensus API | ~200 行 | 中 | 低（raft-rs 原生支持） |
| Side Effect Manager | ~200 行 | 高 | 中（连接状态管理复杂） |
| 混沌测试 | ~500 行 | 高 | 低（不改变生产代码） |

## 推荐路径

```
Phase 1: Majority Detector + Outbox Freeze (最低成本防幽灵消息)
Phase 2: Joint Consensus + SideEffectManager (安全成员变更)
Phase 3: Outbox Catch-Up (分区恢复优化)
Phase 4: 混沌测试 (验证所有 edge case)
Phase 5: 监控 + 告警 (partition/membership 事件可视化)
```
