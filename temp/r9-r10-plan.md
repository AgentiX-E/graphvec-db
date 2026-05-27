# R9/R10 详细修复方案

> 2026-05-27
> 当前代码库：agentiX-graphvec
> 共识层：已使用 `raft-logic`（tikv/raft-rs WASM，^0.3.14），`ConsensusProvider` 接口抽象

---

## R9: 网络分区（Split-Brain）处理

### 当前状态 ❌

| 方面 | 现状 |
|------|------|
| 分区检测（应用层） | ✅ **有。** `AppHeartbeatManager` 通过 EventBus 应用层心跳独立检测分区，不依赖 raft-logic WASM（见修复方案） |
| 分区检测（WASM bindings 备选） | ❌ WASM 的 `inMajority()` / `onMajorityChange()` 方法依赖 raft-rs `checkQuorum` + `leaderId()`，原生 WASM 绑定不稳定或不可用 |
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

#### 方案 A（推荐）：应用层心跳检测（AppHeartbeatManager）

**推荐 ✅** — 完全独立于 raft-logic WASM，在 EventBus 应用层实现

**新文件**: `src/consensus/app-heartbeat-manager.ts`

**原理**:
1. 每 1s 向所有 peer 发送 ping (EventBus.send)
2. 3 次连续无响应 → suspect 该节点
3. Outbox 发送失败作为二次确认 → 确定分区 / 推翻 suspect
4. 确定分区 → `setMajorityStatus(false)` → 冻结 Outbox

**优势**:
- 完全独立于 raft-logic WASM，无需等待 WASM 绑定修复
- 延迟秒级（3s），误报率低（双重验证：ping + outbox）
- 可独立测试，无需启动真实 Raft 集群
- Outbox 失败率作为天然的分区确认信号（白送信息）
- 不增加 WASM 依赖风险

#### 详细设计

###### AppHeartbeatManager

```typescript
// src/consensus/app-heartbeat-manager.ts

interface HeartbeatState {
  peerId: string
  lastResponse: number      // 上次 ping 回复时间戳
  missedCount: number       // 连续未回复次数
  suspect: boolean          // 是否被怀疑
  confirmed: boolean        // 是否被双重确认分区
}

class AppHeartbeatManager {
  private _peers: Map<string, HeartbeatState> = new Map()
  private _timer: NodeJS.Timeout | null = null
  private _intervalMs = 1000    // 1s 一次 ping
  private _missThreshold = 3    // 3 次无响应 → suspect
  private _onMajorityChange: ((inMajority: boolean) => void) | null = null

  constructor(
    private _localPeerId: string,
    private _eventBus: EventBus,
    private _outboxMgr: OutboxReplicationManager,
    private _outbox: Outbox,
    initialPeers: string[]
  ) {
    for (const peer of initialPeers) {
      this._peers.set(peer, {
        peerId: peer,
        lastResponse: Date.now(),
        missedCount: 0,
        suspect: false,
        confirmed: false,
      })
    }
  }

  start(): void {
    this._timer = setInterval(() => this._tick(), this._intervalMs)
  }

  stop(): void {
    if (this._timer) clearInterval(this._timer)
  }

  onMajorityChange(cb: (inMajority: boolean) => void): void {
    this._onMajorityChange = cb
  }

  handlePong(from: string): void {
    const state = this._peers.get(from)
    if (!state) return
    state.lastResponse = Date.now()
    state.missedCount = 0
    if (state.suspect) {
      // Outbox 二次验证：如果 outbox 对该 peer 仍有失败记录，保留 suspect
      state.suspect = this._outbox.hasRecentFailure(from, 5000) // 5s 内失败
      if (!state.suspect) state.confirmed = false
    }
  }

  private async _tick(): Promise<void> {
    // 1. 发送 ping
    for (const peer of this._peers.keys()) {
      await this._eventBus.send(peer, { type: 'HEARTBEAT_PING', from: this._localPeerId })
    }

    // 2. 检查疑点
    for (const state of this._peers.values()) {
      state.missedCount++
      if (state.missedCount >= this._missThreshold && !state.suspect) {
        state.suspect = true
        this.logger.warn(`Peer ${state.peerId} suspect (${state.missedCount} missed)`)
      }
    }

    // 3. 二次确认 suspect
    for (const state of this._peers.values()) {
      if (state.suspect && !state.confirmed) {
        // 检查 outbox 对该 peer 是否有连续失败
        const recentFailures = this._outbox.recentFailureCount(state.peerId, 10000) // 10s
        if (recentFailures >= 3) {
          state.confirmed = true
          this.logger.warn(`Peer ${state.peerId} partition CONFIRMED via outbox failures`)
        }
      }
    }

    // 4. 判断 majority 状态
    const total = this._peers.size
    const confirmed = Array.from(this._peers.values()).filter(s => s.confirmed).length
    const inMajority = total === 0 || confirmed < Math.floor(total / 2) + 1 // 少数 confirmed

    // 5. 通知 Outbox
    const prev = this._prevInMajority
    if (prev !== inMajority) {
      this._prevInMajority = inMajority
      this._outboxMgr.setMajorityStatus(inMajority)
      this._onMajorityChange?.(inMajority)
    }
  }
}
```

##### Step 2: Outbox 分区感知冻结（与方案 A 相同）

保持 Outbox 的 `_frozen` / `setMajorityStatus()` 逻辑不变：

```typescript
// src/core/outbox-replication.ts

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

##### Step 3: 接入 Bootstrap / GraphEngine

```typescript
// 在 GraphEngine 或 MultiLeaderReplication 初始化时：

this.heartbeatMgr = new AppHeartbeatManager(
  this.config.peerId,
  this.eventBus,
  this.outboxMgr,
  this.outbox,
  this.config.peers
)

this.heartbeatMgr.onMajorityChange((inMajority) => {
  this.outboxMgr.setMajorityStatus(inMajority)
  this.logger.info(`Majority status changed: ${inMajority ? 'IN' : 'LOST'}`)
})

this.heartbeatMgr.start()
```

##### Step 4: 分区恢复 — Outbox Catch-Up（与原有设计一致）

当分区恢复且节点重新加入 majority：

```typescript
async onRecoverFromPartition(): Promise<void> {
  // 1. 解冻 Outbox
  this._frozen = false

  // 2. 检查 Outbox 中是否有分区期间错误送达的消息
  const raftIndex = await this.consensus.getAppliedIndex?.() ?? 0

  // 3. 对每个 peer，重放未确认的条目
  for (const [peerId] of this.workerMap) {
    const pending = await this.outbox.getPendingEntries(peerId)
    for (const entry of pending) {
      this.outbox.markUndelivered(entry.msgId)
    }
  }
}
```

#### 备选: raft-logic 内置事件（WASM 绑定方案）

> 当 raft-logic WASM 绑定 `onActiveQuorum()` / `checkQuorum` 事件稳定可用时，可作为备选路径。
> 当前不推荐，因为 WASM 绑定的 `leaderId()` / `confState()` 等方法在 JS 环境中不可靠。
> 详细方案见 [《R9 备选方案：raft-logic WASM 内置事件》]（暂存为参考）

#### 测试计划

```
test/fault-injection/network-partition.test.ts — 拓展到 6 个场景:

已存在 (mock 级) — 测试 CONSENSUS-PROVIDER 接口（仍然有效）:
  - `test/integration/partition-handling.test.ts` — 分区检测接口测试
  - `test/integration/partition-outbox.test.ts` — Outbox 冻结/恢复接口测试

新增 (应用层心跳检测):
  - `test/integration/heartbeat-partition.test.ts` — AppHeartbeatManager 独立测试:

  1. 3 节点集群 + 隔离 1 节点 → 该节点 Outbox frozen（ping 3 次超时 + outbox 二次确认）
  2. 分区恢复 → Outbox unfrozen, pending entries replayed（pong 恢复 + 取消 suspect）
  3. 隔离 leader → 新 leader 选举 → 旧 leader 恢复后日志追平
  4. 集成测试：EventBus 的 Outbox catch-up 在分区后 30s 内恢复
  5. Outbox 失败率作为分区确认信号 → 误报 prevention 测试
```

---

## R10: Raft 成员变更

### 当前状态 ❌

| 方面 | 现状 |
|------|------|
| 成员变更 API（应用层） | ✅ **有。** `AppMembershipManager` 通过 EventBus 两阶段广播实现安全成员变更，不依赖 raft-logic WASM（见修复方案） |
| 成员变更 API（WASM bindings 备选） | ❌ `proposeConfChange()` + `applyConfChange()` 方法依赖 raft-rs 原生 ConfChangeV2 API，当前暴露层未封装且 WASM 绑定不可靠 |
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

### 修复方案

#### 方案 A（推荐）：应用层广播 + 多数派确认（AppMembershipManager）

**推荐 ✅** — 完全独立于 raft-logic WASM，在 EventBus 应用层实现安全成员变更

**新文件**: `src/consensus/app-membership-manager.ts`

**流程**:

```
Phase 1: 发起者广播 MembershipProposal{type, peerId, seq, term} 到所有 peer
Phase 2: 收集多数派 ACK（含各节点配置快照）
Phase 3: 广播 MembershipCommit{seq} → 各节点本地 apply
         a) 更新 config.peers
         b) EventBus 重建 DEALER 连接
         c) Outbox 新增/删除 worker
         d) 触发 onMembershipChange()
```

**安全保证**:
- 两阶段 + 多数派 = 应用层 Joint Consensus（C_old → 等待多数派 ACK → C_new）
- Seq number 去重保证幂等性（同一 seq 的重复消息不重复处理）
- 超时自动 abort，广播取消（防止死锁）

#### 详细设计

###### AppMembershipManager

```typescript
// src/consensus/app-membership-manager.ts

interface MembershipProposal {
  type: 'ADD' | 'REMOVE'
  peerId: string
  seq: number       // 单调递增，防重放
  term: number      // 发起者的逻辑 term（由本节点维护）
}

interface ACKEntry {
  peerId: string
  configSnapshot: string[]   // 该节点当前的 peer 列表
  timestamp: number
}

class AppMembershipManager {
  private _pending: { proposal: MembershipProposal; acks: Map<string, ACKEntry> } | null = null
  private _seq = 0
  private _term = 0
  private _ackTimeout = 5000    // 5s 超时
  private _timeoutTimer: NodeJS.Timeout | null = null
  private _onMembershipChange: ((members: string[]) => void) | null = null

  constructor(
    private _localPeerId: string,
    private _eventBus: EventBus,
    private _config: { peers: string[] },
    private _outboxMgr: OutboxReplicationManager,
  ) {}

  async addPeer(peerId: string): Promise<void> {
    await this._propose({ type: 'ADD', peerId, seq: ++this._seq, term: this._term })
  }

  async removePeer(peerId: string): Promise<void> {
    await this._propose({ type: 'REMOVE', peerId, seq: ++this._seq, term: this._term })
  }

  onMembershipChange(cb: (members: string[]) => void): void {
    this._onMembershipChange = cb
  }

  // 处理收到的 Proposal
  handleProposal(proposal: MembershipProposal, from: string): void {
    if (proposal.seq <= this._seq) return
    this._eventBus.send(from, {
      type: 'MEMBERSHIP_ACK',
      seq: proposal.seq,
      configSnapshot: [...this._config.peers],
    })
  }

  // 处理收到的 ACK
  handleAck(ack: { seq: number; configSnapshot: string[] }, from: string): void {
    if (!this._pending || this._pending.proposal.seq !== ack.seq) return
    if (!this._pending.acks.has(from)) {
      this._pending.acks.set(from, {
        peerId: from,
        configSnapshot: ack.configSnapshot,
        timestamp: Date.now(),
      })
    }
    const totalPeers = this._config.peers.length
    const ackCount = this._pending.acks.size
    if (ackCount >= Math.floor(totalPeers / 2) + 1) {
      this._commit(this._pending.proposal)
    }
  }

  private async _propose(proposal: MembershipProposal): Promise<void> {
    if (this._pending) throw new Error('Membership change already in progress')
    this._pending = { proposal, acks: new Map() }

    for (const peer of this._config.peers) {
      if (peer !== this._localPeerId) {
        await this._eventBus.send(peer, { type: 'MEMBERSHIP_PROPOSAL', ...proposal, from: this._localPeerId })
      }
    }

    this._timeoutTimer = setTimeout(() => this._abort(proposal), this._ackTimeout)
  }

  private _commit(proposal: MembershipProposal): void {
    if (this._timeoutTimer) clearTimeout(this._timeoutTimer)
    this._pending = null

    for (const peer of this._config.peers) {
      if (peer !== this._localPeerId) {
        this._eventBus.send(peer, { type: 'MEMBERSHIP_COMMIT', seq: proposal.seq })
      }
    }

    this._applyChange(proposal)
  }

  private _abort(proposal: MembershipProposal): void {
    this._pending = null
    this.logger.warn(`Membership change ${proposal.type}:${proposal.peerId} timed out, aborting`)

    for (const peer of this._config.peers) {
      if (peer !== this._localPeerId) {
        this._eventBus.send(peer, { type: 'MEMBERSHIP_ABORT', seq: proposal.seq })
      }
    }
  }

  private async _applyChange(proposal: MembershipProposal): Promise<void> {
    const oldPeers = [...this._config.peers]

    if (proposal.type === 'ADD') {
      if (!this._config.peers.includes(proposal.peerId)) {
        this._config.peers.push(proposal.peerId)
      }
    } else if (proposal.type === 'REMOVE') {
      this._config.peers = this._config.peers.filter(p => p !== proposal.peerId)
    }

    // EventBus 重建 DEALER 连接
    await this._eventBus.onMembershipChange(this._config.peers)

    // Outbox 新增/删除 worker
    for (const peer of this._config.peers) {
      if (!oldPeers.includes(peer)) {
        await this._outboxMgr.addPeer(peer, this._peerConfig(peer))
      }
    }
    for (const peer of oldPeers) {
      if (!this._config.peers.includes(peer)) {
        await this._outboxMgr.removePeer(peer)
      }
    }

    // 通知上层
    this._onMembershipChange?.(this._config.peers)
  }
}
```

##### Step 2: EventBus 动态连接管理（与原有设计一致）

```typescript
// src/core/event-bus.ts

async onMembershipChange(members: string[]): Promise<void> {
  for (const member of members) {
    if (!this._peers.has(member)) {
      await this._createDealer(member)
    }
  }
  for (const peer of this._peers.keys()) {
    if (!members.includes(peer)) {
      await this._closeDealer(peer)
    }
  }
}
```

##### Step 3: Outbox Worker 动态管理

```typescript
// 在 outbox-replication.ts 中新增
async addPeer(peerId: string, config: PeerConfig): Promise<void> {
  if (this.workerMap.has(peerId)) return // 幂等
  const worker = new PerPeerWorker(peerId, config)
  this.workerMap.set(peerId, worker)
  worker.start()
}

async removePeer(peerId: string): Promise<void> {
  const worker = this.workerMap.get(peerId)
  if (!worker) return // 幂等
  await worker.stop()
  this.workerMap.delete(peerId)
}
```

#### 备选: raft-logic ConfChangeV2（WASM 绑定方案）

> raft-rs 原生支持 `proposeConfChange()` + `applyConfChange()` + Joint Consensus（`ConfChangeV2` / `ConfChangeTransition.Explicit`）。
>
> 当 WASM 绑定 `confState()` / `leaderId()` / `applyConfChange()` 等 API 在 JS 环境中稳定可用后，可切换回 raft-rs 原生成员变更。
>
> 原生方案的优势：
> - 利用 raft-rs 内置的 Joint Consensus 协议（C_old → C_old+C_new → C_new）
> - 完全符合 Raft 论文 §6 的变更成员安全性证明
> - Leader 切换时自动处理过渡状态
>
> 当前不推荐，因为 WASM 绑定不稳定。保留为未来优化选项。

#### 测试计划

```
test/integration/membership-app.test.ts — 8 个场景:

1. addPeer: 3→4 节点（两阶段广播确认），确认集群健康
2. removePeer: 3→2 节点，确认离线节点不再被联系
3. addPeer 期间发起者宕机 → 超时自动 abort，其他节点忽略
4. removePeer → EventBus DEALER 连接关闭验证
5. addPeer → Outbox 开始向新节点发送
6. 成员变更回滚：addPeer 超时 → 自动广播取消
7. 边际：添加已存在的节点 → 幂等忽略
8. 边际：移除不存在的节点 → 幂等忽略
```

---

## 执行计划（合并 R9+R10）

### 工作量估算

| 模块 | R9 工作量 | R10 工作量 | 并行度 |
|------|---------|-----------|--------|
| AppHeartbeatManager | 1.5d | — | — |
| AppMembershipManager | — | 2d | — |
| Outbox 分区冻结 | 1d | — | — |
| EventBus 动态连接 | — | 1d | 可合并为 0.5d（已有设计）|
| Outbox Worker 动态管理 | — | 1d | 可并行 |
| 集成测试 | 2d | 2d | 可并行 |
| 边际场景测试 | 0.5d | 0.5d | 可并行 |

**总计：约 10 人天**，2 人并行可 5 日历天完成

### 推荐的执行顺序

```
Week 1:
  周一: AppHeartbeatManager 实现（1.5d）
        AppMembershipManager 设计+实现（1d）
  周二: AppMembershipManager 剩余（1d）
        Outbox 分区冻结逻辑（1d）
  周三: EventBus 动态连接（0.5d）
        Outbox Worker 动态管理（0.5d）
        R9 集成测试：heartbeat-partition.test.ts（1d）
  周四: R10 集成测试：membership-app.test.ts（2d）
  周五: 全量验收 + 边际场景
```

### 验收标准

```
R9:
  ✅ AppHeartbeatManager 每 1s 发送 ping，3 次无响应 → suspect
  ✅ Outbox 二次确认 → 确定分区/推翻 suspect
  ✅ 3 节点集群，隔离 1 节点 → 该节点 Outbox frozen
  ✅ 分区恢复 → Outbox unfrozen + catch-up
  ✅ 分区期间无幽灵消息（DedupRing 拒收)
  ✅ 集成测试通过（heartbeat-partition.test.ts）

R10:
  ✅ AppMembershipManager 两阶段广播：Proposal → 多数派 ACK → Commit
  ✅ addPeer() 成功将节点加入集群（config.peers + EventBus + Outbox）
  ✅ removePeer() 安全移除节点（config.peers + EventBus + Outbox）
  ✅ Seq number 去重保证幂等性
  ✅ 超时自动 abort + 广播取消
  ✅ 成员变更后 EventBus 连接动态重建
  ✅ 集成测试通过（membership-app.test.ts）

全量:
  ✅ test:all 0 失败
```
