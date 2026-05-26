# Outbox PerPeerWorker 池 — 执行计划

创建时间: 2026-05-26 00:10

## 目标

将单一 `Outbox Worker` 重构为 **PerPeerWorker 池**：每个 peer 一个独立 tick loop + 独立退避 + 独立发送队列。解决单一 Worker 串行发时 peer 间互相阻塞的问题。

## 设计方案（基于 Lambert 文档 + 对齐讨论）

### 架构

```
OutboxReplicationManager
  ├─ PerPeerWorker(node-1)   ← peerSendTrack[...]
  │   ├─ tick loop (setTimeout)
  │   ├─ pendingQueue: { Critical / Normal / Stale } 三级队列
  │   └─ ackTracker: Map<seq, sentAt>
  ├─ PerPeerWorker(node-2)   ← ...
  ├─ PerPeerWorker(node-3)   ← ...
  └─ _deliveryCheckPeers → 定时检查所有 peer 的 backlog
```

### PerPeerWorker 设计

- **独立 setTimeout loop**：`_tick()` 循环不依赖其他 peer
- **pendingQueue**（三级优先级）：`Critical`（重试≥3次/超时哨兵）→ `Normal`（普通 pending）→ `Stale`（超过 TTL 的未送达，兜底）
  - 实现：不改变 LMDB 结构，PerPeerWorker 每次 tick 从 Outbox.fetchPendingByPeer() 读取后分级入队
  - 队列用两个 JS Array 表示（Low/High），避免 LMDB 全表扫描
- **ackTracker**：`Map<string, number>`（msgId → sentAt），超时未 ack 的返回 pendingQueue 重发
  - ack 超时：`ackTimeout = tickMs * 3`（可热加载）
- **退避策略**：LinearBackoff(maxBackoffMs)，超时后调 recoverDealerFn 重建 DEALER
- **热加载**：`_tickMs()`、`_maxBackoffMs()`、`_ackTimeoutMs()` getter 每次 tick 读最新 config

### Outbox 改动

- 新增 `fetchPendingByPeer(peerId): OutboxEntry[]` — 取指定 peer 所有 pending 消息
- 保留 `fetchOldestPending`（PerPeerWorker 内部按需使用）
- `getPendingCountForPeer` 保留

### Manager 改动

- `start()` 中为每个 peer 创建 PerPeerWorker 实例
- `_deliveryCheckPeers`：定时扫描所有 PerPeerWorker 的 backlog，对卡住的 peer 推送哨兵消息触发重试
- `updateConfig()`：透传给所有 PerPeerWorker
- 新增 `workerCount` 配置（自动 = peers.length）

### 测试

- 现有 10 个 replication test 需适配
- 新增测试：多 peer 并发、single peer 退避恢复、ack 超时重传
- 集成测试 6 个需保持全绿

## 步骤

- [x] Phase 0: 阅读当前代码，确认架构
- [x] Phase 1: 设计 PerPeerWorker 类（pendingQueue + ackTracker + 退避）
- [ ] Phase 2: 重构 Outbox（新增 fetchPendingByPeer）
- [ ] Phase 3: 重构 OutboxReplicationManager（创建 Worker 池 + deliveryCheck）
- [ ] Phase 4: 适应 heat-load + updateConfig
- [ ] Phase 5: 跑 tsc + 全量测试
- [ ] Phase 6: 集成测试

## 当前进度

- [x] Phase 0: 阅读当前代码，确认架构
- [x] Phase 1: 设计 PerPeerWorker 类（pendingQueue + ackTracker + 退避）
- [x] Phase 2: 重构 Outbox（新增 fetchPendingByPeer）
- [x] Phase 3: 重构 OutboxReplicationManager（创建 Worker 池 + deliveryCheck）
- [x] Phase 4: 热加载 hot-load + updateConfig 适配
- [x] Phase 5: tsc 0 errors ✅
- [x] Phase 6: 全量测试 34/34 ✅ (14s)

## 最终测试结果

```
multi-leader-replication.spec.ts:      10/10 ✅
event-stream.spec.ts:                  15/15 ✅
graph-engine-eventstream.spec.ts:       3/3  ✅
multi-leader-integration.spec.ts:       6/6  ✅ (13.959s)
-----------------------------------------------
总计: 34/34 ✅
```

## 设计回顾

### PerPeerWorker 池（替代单一 OutboxWorker）
- 每个 remote peer 一个独立的 PerPeerWorker（setTimeout loop）
- PerPeerWorker 内部三级 pending 队列：
  - `criticalQueue`: 重试≥3次的消息（优先发送）
  - `normalQueue`: 普通 pending 消息
  - `ackTracker`: Map<msgId, sentAt> 追踪已发未 ack 的消息
- ACK 超时（ackTimeoutMs = tickMs × 3）：未收到 ack 时回归 pending 重发
- 退避策略：send 失败 → inBackoff=true → maxBackoffMs 后调 recoverDealerFn 重建 DEALER
- .pub 文件消失 → worker self-stop

### Manager 改动
- `workerMap: Map<string, PerPeerWorker>` 替代旧的 `worker: OutboxWorker | null`
- `_deliveryCheckPeers`: 定时检查所有 worker 的 ackTracker，对卡住的推送哨兵
- `_ensureWorker(peerId)` / `_restartWorker(peerId)`：Worker 生命周期管理
- `getPeerReports()`：详细报告回调

### Outbox 新增
- `fetchPendingByPeer(peerId)`: 取指定 peer 所有 pending 消息（排序）
- 其余接口不变

### 对外 API 不变
- `OutboxReplicationManager` 的 `addMessage` / `updateConfig` / `getStats` / `getConfig` / `notifyConnected` / `notifyAcked` 接口完全一致
- `MultiLeaderReplication` 不变
- `multi-leader-test-node.ts` 不需要更新（参数相同）
- 配置文件持久化热加载不变
