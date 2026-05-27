# OverGraph 分布式共识与数据同步白皮书

> v1.1 · 2026-05-27

---

## 摘要

OverGraph 采用**分层共识 + 双通道保障**架构来同时满足：

1. **同 DC 强一致性** — 通过 Raft 共识做线性一致写入
2. **同 DC 最终一致性兜底** — 通过 Outbox + EventBus 在 Raft 故障窗口（Leader 切换、脑裂、成员变更）提供备份数据通道
3. **跨 DC 数据同步** — 通过 Outbox + EventBus 做异步最终一致复制，通过 LWW/CRDT 解决冲突

核心设计理念：**三层路径正交，Raft 完全不经过 EventBus，两者互不阻塞。**

---

## 1. 设计原则

### 1.1 一致性分层

| 层 | 一致性模型 | 延迟 | 功能 |
|----|-----------|------|------|
| Raft（主路径） | 线性一致 | 5-50ms（同DC LAN） | 同 DC 写入的主共识通道 |
| Outbox（兜底） | 最终一致 | 异步（ms ~ 60s） | Raft 故障窗口容错 + 跨节点/跨 DC 复制 |
| EventBus（传输） | Best-effort | 1-5ms | 实时事件通知，Outbox 的物理传输层 |

### 1.2 路径正交

- **Raft 数据路径**: `GraphEngine → RangeInstance → ConsensusProvider.propose()` — **完全不经过 EventBus**
- **EventBus 事件路径**: `GraphEngine._emit() → EventStream → EventBus.broadcast()` — 独立通道
- **Outbox 兜底路径**: `GraphEngine._mlReplication.replicate() → Outbox LMDB → PerPeerWorker → EventBus.send()` — 异步发送

### 1.3 幂等三层保护

| 层 | 机制 | 保护范围 |
|----|------|---------|
| 内存去重 | `DedupRing`（10,000 条循环 Set） | 短时间窗口 |
| 递归保护 | `_applyingRemote` + `skipReplication` | 阻止消息回环 |
| 操作幂等 | `UPSERT` 语义 + msgId 去重 | 同一操作的多次执行 |

### 1.4 拓扑感知退避

Outbox 退避超时按目标节点拓扑分档：

| 拓扑 | 退避上限 | 原因 |
|------|---------|------|
| 同 DC | 3s | Raft 兜底场景要求秒级恢复 |
| 跨 DC | 60s | 容忍 WAN 不稳定 |
| 边缘 | 300s | 弱网/不可靠连接 |

---

## 2. 架构详情

### 2.1 Raft Consensus Provider

`ConsensusProvider` 抽象接口，统一三种实现：

```typescript
interface ConsensusProvider {
  propose(data: Uint8Array): Promise<{ ok: boolean }>
  barrier(): Promise<void>
  getRole(): ConsensusRole
  waitForLeader(): Promise<void>
  setApply(fn: (data: Uint8Array) => Promise<void>): void
}
```

| 实现 | 用途 | 一致性保证 | 延迟 |
|------|------|-----------|------|
| raft-logic (tikv/raft-rs WASM) | 生产多节点 | 线性一致 | 5-50ms |
| simulated-raft | 多节点测试 | 线性一致（模拟） | 同进程 |
| standalone | 单节点开发 | 不适用（无网络共识） | 本地 |

### 2.2 Outbox（MultiLeader Replication）

```
replicate(eventType, payload):
  1. Outbox LMDB 写入 { seq, msgId, targetNodeId, payload, createdAt, delivered: false }
  2. 立即返回（不阻塞）
  3. PerPeerWorker 后台异步发送
```

关键机制：
- Outbox 在 Raft commit **之后**写入，确保 Raft 主路径优先
- 每个目标节点独立 Worker，互不影响
- 无限重试直到节点下线或数据达到 TTL
- **同 DC 节点走 3s 短退避，跨 DC 走 60s 长退避**

### 2.3 EventBus（ZMQ 传输层）

```
每个节点:
  1 × ROUTER socket (Server) — 接收所有 peer 消息
  N × DEALER socket (Client) — 每个 peer 一个，定向发送
```

- CURVE25519 双向认证 + 传输加密
- NAS 共享目录自动分发公钥
- 支持 WorkerPool 多进程负载分担

### 2.4 双通道一致性保证

同 DC 内的 Raft 盲区及 Outbox 兜底策略：

| Raft 盲区 | 兜底策略 | 是否丢数据 |
|-----------|---------|-----------|
| Leader 切换（~300ms 黑窗口） | Outbox 在 commit 后写入，切换期间条目在 LMDB 安全 | ❌ 不丢失 |
| 网络分区（脑裂） | 少数派节点通过 EventBus 接收多数派变更 | ❌ 不丢失 |
| 操作超时但实际已提交 | Client 重试时 msgId 幂等去重 | ❌ 不重复 |
| 成员变更短暂不一致 | EventBus 持续发送，变更完成后 Raft 配置追赶 | ❌ 不丢失 |
| 节点长时间宕机恢复 | Outbox TTL（14天）回放 + Raft 快照同步 | ❌ 不丢失 |

---

## 3. Raft 必选原则

**Raft 是强制的，不是可选的。**

`RangeInstance` 构造函数中的 `StandaloneConsensus` fallback 是开发/测试妥协，生产环境必须：

1. 使用 `raft-logic`（tikv/raft-rs WASM）或其他真实 Raft 实现
2. `StandaloneConsensus` 只能用于单节点开发

> ⚠️ 当前代码中 `RangeInstance` 默认 fallback 到 `StandaloneConsensus`，这是一个已知的 P0 风险：多个节点各自独立写入时数据完全不一致。

---

## 4. 部署拓扑

### 单节点开发
```
1 × Node: StandaloneConsensus + EventBus + Outbox
```

### 同 DC 3 节点
```
3 × Node:
  Raft:   3 副本, 容忍 1 节点故障
  Outbox: 每个节点 × 2 PerPeerWorker（同 DC 3s 退避）
  EventBus: 3 × ROUTER + 6 × DEALER
```

### 跨 DC 3+3 节点
```
DC-A: 3 × Node Raft + EventBus + Outbox
DC-B: 3 × Node Raft + EventBus + Outbox
DC-A → DC-B: Outbox 异步复制（60s 退避）
```

---

## 5. 优化方向与进度追踪

详见 `docs/design/code-optimization-report.md` 和 `docs/design/execution-plan.md`。

| 优先级 | 问题 | 影响 | 预估 |
|--------|------|------|------|
| 🔴 | Raft + Outbox 无事务边界 | Raft 提交后 Outbox 写入失败 → 变更未广播 | 2-3d |
| 🔴 | StandaloneConsensus 默认 fallback | 掩盖 Raft 必须启用的设计意图 | 0.5d |
| 🟠 | `as any` 类型安全（13+ 处） | event-bus 运行时错误暴露晚 | 3-5d |
| 🟠 | DedupRing 容量固定 10K + 不跨进程 | 高吞吐下去重窗口不足 | 1d |
| 🟠 | ZMQ 连接无就绪检测 | Outbox 首次发送可能失败 | 1d |
| 🟡 | 无指数退避抖动 | dealer 重建风暴 | 0.5d |
| 🟡 | ROUTER 接收循环无背压 | 高并发压垮节点 | 1-2d |
| 🟢 | 序列化开销（JSON → msgpackr） | 可优化但非关键 | 0.5d |
| 🟢 | 测试覆盖缺口（Outbox+EventBus 组合） | 回归风险 | 3-5d |

### 进度矩阵

| 里程碑 | 状态 | 备注 |
|--------|------|------|
| 白皮书 v1.1（当前） | ✅ | 已同步双通道兜底设计 |
| 通用设计模式文档 | ✅ | 已泛化并更新同 DC 兜底 |
| 代码优化报告 | ✅ | P0-P3 共 11 项 |
| 可执行优化计划 | ✅ | 见 `execution-plan.md` |
| P0: Raft+Outbox 事务边界 | ⏳ 待设计评审 | — |
| P0: 移除 StandaloneConsensus fallback | ⏳ 待排期 | — |
| P1: 类型安全重构 event-bus | ⏳ 待排期 | — |
| P2: 指数退避抖动 | ⏳ 待排期 | — |

---

## 6. 术语表

| 术语 | 定义 |
|------|------|
| Raft | 分布式共识算法，同 DC 线性一致写入主路径 |
| ConsensusProvider | Raft 共识引擎抽象接口 |
| StandaloneConsensus | 单节点共识实现（仅限开发） |
| RangeInstance | 单个分片 = Raft 共识组 + 状态机 |
| ShardManager | 分片管理器，管理所有 RangeInstance |
| MultiLeaderReplication | 异步多主复制层，基于 Outbox 模式 |
| Outbox LMDB | 持久化消息队列，Raft commit 后写入，Worker 异步发送 |
| PerPeerWorker | 每个目标节点独立的 Outbox 发送 Worker |
| EventBus | ZMQ ROUTER/DEALER 事件总线 |
| EventStream | 可靠事件流 = WAL + EventBus 广播 + ACK |
| DedupRing | 循环去重缓存（msgId） |
| CURVE | Curve25519 双端认证加密协议 |
| HLC | Hybrid Logical Clock，用于跨 DC 因果序 |
| LWW | Last Writer Wins，基于 HLC 的冲突解决策略 |

---

*本文档与 `docs/design/cross-dc-raft-sync-pattern.md`（通用设计模式）、`docs/design/code-optimization-report.md`（代码优化建议）、`docs/design/execution-plan.md`（可执行优化计划）配套。*
