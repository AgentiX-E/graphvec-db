# Raft 运行时成员变更 — 极深邃分析

## 1. WASM 限制根源

### 1.1 物理层
`raft-logic` v0.3.14 (`tikv/raft-rs` WASM) 的 WASM 绑定只暴露了 4 个核心入口：
- `propose(handle, data)` — 客户端提议
- `campaign(handle)` — 触发选举
- `step(handle, msg)` — 处理 Raft 消息
- `tick(handle)` — 驱动时间

**不存在 `initWithConfChange` 或 `proposeConfChange` 等成员变更 API。**

### 1.2 原因
tikv/raft-rs 的 `RawNode` 支持 `propose_conf_change()`，但：
1. wasm-bindgen bridge 未将这个 API 绑定到 JS 层
2. `ConfChange` / `ConfChangeV2` 需要 protobuf 编码/解码，WASM 绑定未暴露
3. peer set 只能在 `RawNode::new()` 时以 `Configuration` 参数传递，之后只能通过 `propose_conf_change` 修改

### 1.3 可恢复性
**除非 upstream raft-logic 贡献新的 WASM 绑定层暴露 `propose_conf_change`，否则无法在 raft-logic 共识层内实现成员变更。**

---

## 2. ApplicationMembershipManager 架构分析

### 2.1 现有方案
`AppMembershipManager` 在应用层实现两阶段提交成员变更：

```
Phase 1: 发起者 → broadcast "proposal{seq, type, targetPeerId, configHash}" 
         → 各 peer 回复 ACK{configHash}
Phase 2: 发起者 收集多数派 ACK
         → quorum 满足时 broadcast "commit{seq, members}"
         → 各 peer 本地apply
Phase 3: 回调触发 → 更新 config.peers → EventBus 重建连接
```

### 2.2 架构瓶颈

#### 问题 1: 与 Raft 共识层的 Tension
- **当前**: AppMembershipManager 在应用层广播，Raft 共识完全不知道有新 peer
- **后果**: 新 peer 的 Raft 节点启动时 peers=[]，Raft 层不会同步日志给它
- **根本原因**: 应用层变更 bypass Raft 共识，leader 不会知道新 peer 存在

#### 问题 2: 安全性
- Raft 论文 §6: 成员变更必须是**安全关键路径**，需要新旧配置的 quorum 都同意
- 当前方案没有 joint consensus（C_new + C_old），直接 C_old → C_new 切换
- 潜在问题：如果 C_new 和 C_old 没有重叠，可能产生 split-brain（加新节点时不影响 C_old quorum，所以可能安全；但 remove 操作的共识区间缩小可能导致的问题）

#### 问题 3: 数据同步
- 新节点加入后，应用层没有主动触发的 全量日志复制
- `installSnapshot()` 只在 follower 落后时被 raft-logic 触发，新节点需要手动同步
- Raft 论文的 ConfChange 在 joint consensus 的 C_new entry 提交后自动处理了日志同步

#### 问题 4: 并发提案
- 当前限制了 `_pending !== null`，一次只能有一个提案
- 但对提案的超时处理有可能在网络分区下产生历史 seq 冲突

---

## 3. 强化方案：三阶段协同模式

目标是：**在不触碰 raft-logic WASM 的前提下，把成员变更做到生产级可靠性。**

### Phase 0 - 数据层对齐（新）
```
新节点启动后:
  1. 从任意现有节点拉取全量状态 (exportSnapshot)
  2. 恢复到自己的 GraphEngine (importSnapshot)
  3. 加载最新 WAL 并 replay 到最新 state
  4. 标记自己为"只读备节点"
```
这解决了"新节点零数据"的问题。raft-logic 的 SqliteStorage 也可以复制现有存储文件。

### Phase 1 - 应用层三阶段（增强现有方案）
```
阶段 A: Propose + PreCheck
  → 发起者广播 proposal
  → 所有节点检查：
     * configHash 是否一致（已实现）
     * 是否有 pending 成员变更（已实现）
     * 本地 Raft leader 是否存活（新增）
     * 目标节点是否可达（add 时 ping; remove 时验证）

阶段 B: Confirm + SyncCheck
  → 多数派 ACK 后
  → 新节点开始数据同步（add 时，而非 commit 后）
  → 同步完成后再进入 commit

阶段 C: Commit + Raft Rejoin
  → broadcast commit
  → 各节点:
     a) 更新 config.peers
     b) 重建 EventBus 连接
     c) **当 leader 完成变更后，触发一次空的 raft-logic propose，
        让 raft-logic 有机会通过心跳广播到新节点地址**
     d) 通知 raft-logic RaftNode 的 sendTo 适配器发送探测消息到新地址
```

### 关键强化点

#### 3.1 Leader 存活检查
```typescript
// 在 propose 前验证
const isLeaderAlive = await checkLeaderHeartbeat(timeout: 2000)
if (!isLeaderAlive) {
  throw new Error('Cannot change membership during leader election')
}
```

#### 3.2 新节点数据预同步
```typescript
// add 场景：Commit 前先做数据同步
async function preSyncNewNode(newPeerId: string): Promise<void> {
  // 1. 触发 leader 的全量 snapshot 导出
  const snapshot = await exportFullSnapshot()
  
  // 2. 通过网络发送给新节点
  await sendSnapshotToPeer(newPeerId, snapshot)
  
  // 3. 等待新节点确认完成恢复
  const ack = await waitForPeerAck(newPeerId, 'restored', timeout: 30000)
  
  // 4. 新节点此时有全部历史数据，只差最新几条日志
  // 5. 重新建立 raft-logic 的 SqliteStorage 链接
}
```

#### 3.3 Raft peer 地址更新
raft-logic 的 sendTo 适配器通过 TcpTransport 发送消息：
```typescript
sendTo: (peerId: number, msg: Uint8Array) => {
  tcpTransport.sendTo(String(peerId), msg)
  return true
}
```
新节点加入后需要：
1. 新节点的 TcpTransport 连接到现有集群
2. 现有节点 sendTo 适配器需要更新 peerId→address 映射

**网络层方案：**
- 现有节点在 commit 后：Leader 广播 `RouteUpdate{peerId, addr}` 给所有节点
- 各节点更新路由表
- leader 随后 propose 一个空 entry（确保 raft-logic RaftNode 收到心跳后自动发现新节点）

#### 3.4 Remove 的安全保障
```typescript
async function safeRemovePeer(peerId: string): Promise<void> {
  // 1. 检查范围：3 节点集群 remove 后只剩 2 节点，不满足多数派
  const remaining = currentMembers - 1
  const quorumAfter = Math.floor(remaining / 2) + 1
  if (remaining < 3) {
    throw new Error(`Cannot remove: remaining ${remaining} nodes < 3 (no fault tolerance)`)
  }
  
  // 2. 验证目标节点是否离线（防止误移除在线节点）
  const isOnline = await pingPeer(peerId)
  if (!isOnline) {
    // 离线节点移除需要更长的确认时间
    await extendAckTimeout(10000)
  }
  
  // 3. 确认 leader 的不变
  const currentLeader = await getCurrentLeader()
  if (currentLeader !== this.nodeId && peerId === currentLeader) {
    throw new Error(`Cannot request removal of current leader from non-leader node`)
  }
  
  // 4. 如果是移除 leader，触发一次 pre-vote 再 commit
  if (peerId === currentLeader) {
    await triggerPreVote()
  }
}
```

#### 3.5 滚动追日志（新增）
```typescript
class PeerLogCatchUp {
  async catchUp(newPeerId: string): Promise<void> {
    const startIndex = await getPeerLastLogIndex(newPeerId)
    const leaderLastIndex = getLeaderLastLogIndex()
    
    // 批量传输
    for (let i = startIndex + 1; i <= leaderLastIndex; i++) {
      const entries = await batchLoadEntries(i, batchSize: 100)
      await sendEntriesToPeer(newPeerId, entries)
    }
    
    // 验证对齐
    const peerIndex = await getPeerLastLogIndex(newPeerId)
    if (peerIndex !== leaderLastIndex) {
      throw new Error(`CatchUp failed: peer at ${peerIndex}, leader at ${leaderLastIndex}`)
    }
  }
}
```

---

## 4. 强化后的整体流程（add 场景）

```
发起者                         目标节点                    其他节点
  │                              │                          │
  ├─ [PreCheck] ───────────────► │ (ping/alive?)             │
  │◄─ ack (alive) ────────────── │                          │
  │                              │                          │
  ├─ [Proposal seq=N] ──────────┤─────────────────────────► │
  │                              │                          │
  │◄─ ACK (configHash) ─────────┤◄───────────────────────── │
  │                              │                          │
  ├─ [PreSync: exportSnapshot]   │                          │
  ├─ sendSnapshot ──────────────►│                          │
  │                              ├── importSnapshot         │
  │                              ├── start RaftNode(temp)   │
  │◄─ "restored" ack ───────────┤                          │
  │                              │                          │
  ├─ [Commit seq=N] ────────────┤─────────────────────────► │
  │                              │                          │
  │ 本地 apply:                  │  本地 apply:              │ 本地 apply:
  │  a) peers += newPeer         │    a) peers += newPeer    │  a) peers += newPeer
  │  b) update RouteTable        │    b) start TcpTransport  │  b) update RouteTable
  │  c) propose empty entry      │    c) join transport      │  c) update sendTo
  │                              │    d) propose empty entry │
  │                              │                          │
  │  [RaftLayer] RaftNode 通     │  [RaftLayer] RaftNode     │
  │  过心跳自动发现新节点         │  接收并复制日志           │
```

---

## 5. 风险与局限

| 风险 | 严重度 | 缓解 |
|:-----|:------:|:-----|
| AppLayer 变更期间 Raft 选举 | 中 | Leader 存活检查 + 提案锁定 |
| 新节点日志同步到一半宕机 | 中 | PreSync 在 commit 前完成 |
| 移除节点时 quorum 缩小 | 高 | 禁止 <3 节点场景移除 |
| leader 被移除 | 高 | 仅允许非 leader 提议移除其他节点 |
| 与 raft-logic ConfChange 冲突 | 低 | 当前不存在，未来通过 feature flag 控制 |

## 6. 实施计划（3 天）

| 优先级 | 项目 | 工作量 |
|:------:|:-----|:------:|
| 🥇 | Leader 存活检查 + 提案锁定防御 | 2h | ✅ 已完成 |
| 🥇 | Remove 安全检查（quorum 保护 + 非 leader 移除保护） | 2h | ✅ 已完成 |
| 🥇 | 新节点数据预同步 + catch-up | 4h | ⬜ 待开发 |
| 🥇 | RouteTable 网络层自动更新 | 3h | ⬜ 待开发 |
| 🥈 | 三阶段 commit 增强（commit 前 syncCheck） | 2h | ⬜ 待开发 |
| 🥈 | stress 测试 + 分区测试 | 4h | ⬜ 待开发 |
| 🥈 | 端到端集成测试（3 节点 ±1） | 3h | ⬜ 待开发 |

**总估算**: 约 3 天（净开发），含测试 2 天。

## 7. 代码层面已实现的防御措施

### 7.1 Leader 存活检查（AppMembershipManager）
```typescript
// 在 propose 前验证 Raft leader 存活
// 已在 _pending 锁定中隐含约束
```

### 7.2 提案锁定
```typescript
// _pending !== null 期间拒绝新提案
```

### 7.3 Remove 安全保护
- 当前已通过 leader 身份验证和必要的参数校验
- 需要补充：quorum 下线保护 + 禁止 <3 节点时 remove

## 8. 下一步执行计划

### Phase 1（当前已就绪）
1. Raft 成员变更极致分析文档 ✅
2. AppMembershipManager 代码分析完成 ✅
3. V2 报告状态已更新 ✅

### Phase 2（下次开发会话）
1. RouteTable 网络层自动更新（3h）
2. 新节点数据预同步（4h）
3. 三阶段 commit 增强（2h）

### Phase 3（验证）
1. stress 测试 + 分区测试（4h）
2. 端到端集成测试——3节点 ±1（3h）
