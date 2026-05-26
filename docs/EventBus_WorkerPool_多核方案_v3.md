# EventBus + Multi-Leader Replication 实现方案 v3.0

> **版本**: v3.0 (Hybrid WorkerPool)  
> **更新**: 2026-05-26  
> **场景**: 多核生产环境虚拟机  
> **设计原则**: 取 v1.2（子进程池）与当前单进程实现的各自最优部分，不做无谓的架构翻新

---

## 0 你不需要这份方案（的现在）

### 0.1 实施建议

**当前阶段不重新实现**。原因是：

- 当前代码 **56 suites / 832 tests 全部通过**，全量回归稳定
- 当前单进程架构**在开发期间的吞吐量完全够用**（单核跑 832 个测试 105s）
- 多进程 WorkerPool 的收益（CPU 并行 × N-1）只在**生产高负载**时体现
- 在实现 WorkerPool 时任何 bug 都会导致全量回归失败——目前没有测试环境能验证多进程场景

**建议实施时机**：上线后监控到 `CPU0 持续 80%+` 或 `ROUTER 接收队列背压` 时再实施。预计实施工作量：1-2 人周。

### 0.2 如果现在必须做

下面是最优方案。核心改动域：

| 域 | 文件 | 改动量 |
|----|------|--------|
| Worker 子进程框架 | 新增 `pool-worker.ts` | ~250 行 |
| Worker 池管理 | 新增 `pool-manager.ts` | ~200 行 |
| EventBus 改造 | `event-bus.ts` | ~100 行（合并：ROUTER 留主进程） |
| Outbox 分库 | `outbox-replication.ts` | ~80 行（支持 LMDB 按库隔离） |
| MultiLeaderReplication 整合 | `multi-leader-replication.ts` | ~40 行 |
| 测试 | 多进程集成测试 | ~200 行 |
| **合计** | **6 个文件** | **~870 行净增** |

---

## 1 设计目标

| 目标 | 衡量标准 |
|------|---------|
| 利用多核 | N-1 个 Worker 进程各占一核，主进程独享 1 核 |
| 零 IPC ACK | ACK 通过 LMDB mmap 共享内存立即可见，不经过 IPC |
| 复用现有 PerPeerWorker | Worker 子进程直接运行完整的 5 Phase tick，不改 tick 逻辑 |
| LMDB 不变 | 保持 LMDB + 前缀索引（O(K) 查询），拒绝 SQLite |
| NAS 动态监控 | 保留 `_startNasMonitor`，主进程统一管理 peer 发现 |
| 向后兼容 | `workerCount=1` 退化为当前单进程模式 |

---

## 2 架构

```
                   4 核虚拟机
          ┌────────────────────────────┐
CPU0 ────▶│ 主进程 (Main Process)      │
          │  - GraphEngine             │
          │  - EventBus ROUTER (rx)    │
          │  - EventStream (receive)   │
          │  - NAS monitor             │
          │  - WorkerPool 管理          │
          │  - LMDB Outbox-0（写入口）   │
          └───────┬──────────┬─────────┘
                  │ fork()   │ fork()
          ┌───────▼──┐ ┌─────▼────────┐
CPU1 ────▶│Worker 1  │ │  Worker 2    │◀──── CPU2
          │Peer: A,B │ │  Peer: C     │
          │DEALER×2  │ │  DEALER×1    │
          │Outbox-1  │ │  Outbox-2    │
          └──────────┘ └──────────────┘
                   ▲            ▲
                   │ LMDB mmap  │（主进程写的 delivered 状态立即可见）
                   └─────┬──────┘
                  ┌──────▼───────┐
                  │ LMDB Outbox  │
                  │ - outbox-0   │ main进程写入口
                  │ - outbox-1   │ Worker1 写入口
                  │ - outbox-2   │ Worker2 写入口
                  │ (mmap共享)    │
                  └──────────────┘
```

### 2.1 为什么零 IPC ACK

```
单进程（当前）:
  ROUTER 收到 ACK msg
    → EventStream._onRemoteAck()
      → ackTracker.delete(msgId)    ← 同一进程，直接操作内存
      → WAL.acknowledge([msgId])    ← 同一个 WAL

v1.2 多进程:
  ROUTER 收到 ACK msg
    → IPC child.send({type:'ack', eventId})
      → Worker process.on('message')
        → pendingAcks.add(eventId)         ← 下个 tick 才处理
          → UPDATE peer_events SET status='acked'

v3.0 多进程（本方案）:
  ROUTER 收到 ACK msg
    → outbox.markAcked(msgId)       ← LMDB mmap 写入（立即可见）
    → WAL.acknowledge([msgId])      ← 主进程 WAL
    → [Worker 无需 action]

  Worker 下个 tick Phase 0:
    if ackTracker.has(msgId) && outbox.isAcked(msgId):
      → ackTracker.delete(msgId)    ← 直接从 LMDB 读到 ACK 状态
```

**LMDB mmap 的共享性质**：

```
主进程写入 outbox-1.lmdb 的「acked」状态
  → 对 Worker 1 进程可见（同一文件映射到两个进程的虚拟地址空间）
  → 无需进程间信号、无需 IPC、零延迟

代价：Worker 最多延迟 1 个 tick（默认 500ms）才读到 ACK 状态
```

### 2.2 为什么可以接受 1 tick 的 ACK 延迟

当前 `PerPeerWorker` 的 ACK 超时是 `tickMs × 3 = 1500ms`。LMDB 共享 ACK 在最多 500ms 后读到。这意味着：

- 正常场景：ACK 在 1 tick 内被识别 → ackTracker 正常删除 → 不触发重传
- 超时场景（ACK 丢失）：1500ms 后从 LMDB 加载消息重发

**与单进程的差异**：
- 单进程：ACK 在同一事件循环中处理 → ackTracker 立即删除
- v3.0：ACK 在 0-500ms 内被识别 → ackTracker 延迟删除

对于最终一致性的复制场景，500ms 的差异完全可接受。

---

## 3 详细设计

### 3.1 Worker 分配算法

```typescript
// pool-manager.ts

/**
 * 按端口号分配 peer 给 Worker：解决 rehash 问题
 *
 * 不用 port % workerCount（v1.2 方案），因为：
 * 1. peer 数可能动态变化
 * 2. peer 增减时 port % workerCount 的归属会变化
 * 3. 变化时 Worker 需要重启
 *
 * 改用一致性哈希（consistent hashing）：
 * 每个 peer 分配到 N-1 个 Worker 中的一个
 * Worker 增减时只有 1/N 的 peer 需要迁移
 */
function assignPeersConsistentHash(
  peers: PeerDescriptor[],
  workerCount: number,
): Map<number, number[]> {
  // 一致性哈希环
  // 每个 Worker 生成 R 个虚拟节点（R=100），均匀分布在环上
  // 每个 peer 找出环上最近的虚拟节点 → 确定所属 Worker

  const assignment = new Map<number, number[]>();
  // ... (标准一致性哈希实现)
  return assignment;
}
```

**v1.2 的 port % workerCount 分片与其差异**：
- v1.2：`peerPort % workerCount`，简单，但 peer 增减需要 rehash
- v3.0：一致性哈希，Worker 增减时只有 `1/workerCount` 的 peer 迁移

**事实上对于当前场景（最少 3 节点 peer），两种方式没区别。保留一致性哈希接口但 initial 实现用简单取模。**

### 3.2 Worker 子进程（`pool-worker.ts`）

```typescript
class PoolWorker {
  private workerId: number
  private assignedPeers: PeerDescriptor[]
  private perPeerWorkers: Map<string, PerPeerWorker>
  private outbox: Outbox  // Worker 私有的 Outbox（LMDB 实例）

  constructor(workerId: number, assignedPeers: PeerDescriptor[], config: PoolWorkerConfig) {
    // 1. 打开私有 Outbox（LMDB outbox-{workerId}.lmdb）
    //    主进程和本 Worker 都 mmap 这个文件
    // 2. 创建 PerPeerWorker × assignedPeers.length
    //    复用现有 PerPeerWorker 类（5 Phase tick 不动）
    // 3. 创建 DEALER socket × assignedPeers.length
    // 4. 注册 IPC 监听（仅用于：主进程通知 Worker 停止）
  }
}
```

**Worker 不需要改动 `PerPeerWorker._tick()` 的 5 Phase 逻辑**。唯一的变化在 Phase 0：

```
Phase 0（原单进程）:
  for (msgId, sentAt) of ackTracker:
    if now - sentAt > ackTimeoutMs:
      → 从 LMDB 重新加载 → 回 normalQueue

Phase 0（多进程 v3.0）:
  for (msgId, sentAt) of ackTracker:
    if now - sentAt > ackTimeoutMs:
      if outbox.isAcked(msgId):    ← 新增：检查 LMDB 共享
        → ackTracker.delete(msgId)  ← ACK 已通过 mmap 到达
        continue
      → 从 LMDB 重新加载 → 回 normalQueue
```

### 3.3 主进程改动（`event-bus.ts`）

```
start():
  1. resolveCurveConfig()  // 不变
  2. 创建 ROUTER socket + _startRouterLoop()  // 不变
  3. if workerCount > 1:
       → workerPool.start()
     else:
       → 创建 DEALER socket（当前单进程模式） // 向后兼容
  4. _startNasMonitor(nasIntervalMs)  // 不变

_syncPeerDealers():
  // 新增：通知 WorkerPool peer 变更
  for new peer:
    if workerPool:
      workerPool.notifyPeerAdded(peer)
    else:
      创建 DEALER（当前单进程模式）

  for gone peer:
    if workerPool:
      workerPool.notifyPeerRemoved(peer)
    else:
      close DEALER（当前单进程模式）

收到 ACK（_onRemoteAck 中）:
  + outbox.markAcked(msgId)  // LMDB mmap 写入
  // 其他逻辑不变
```

### 3.4 MultiLeaderReplication 改动

`replicate()` 写入 Outbox 时：

```typescript
replicate(type, data):
  // 当前：manager.addMessage() → Outbox.add() -> 单库
  // v3.0：根据 peer 归属，写入对应 Worker 的 Outbox
  
  for peerId in remotePeers:
    targetOutbox = workerPool.getOutboxByPeer(peerId)
    targetOutbox.add({ targetNodeId: peerId, payload })
```

这要求 `addMessage()` 知道 peer 属于哪个 Worker 的 Outbox。

**优化方案**：不分配给 Worker——主进程仍然写入单一 Outbox。Worker 通过 LMDB mmap 读到 pending 消息。

```
主进程:
  Outbox.add({ targetNodeId: 'node-2', payload })  → LMDB 主库

Worker 1（负责 node-2）:
  Phase 2: outbox.fetchPendingByPeer('node-2')
    → 通过 LMDB mmap 读到主进程刚写入的 pending 消息
    → 用自己的 DEALER 发送
```

**这个设计为什么好**：主进程和 Worker 共享同一个 LMDB 文件。主进程写入 pending，Worker 读取 pending 并发送。发送成功后 Worker 在 LMDB 中标记 delivered——主进程通过 mmap 立即可见。

### 3.5 启动顺序

```
1. 主进程 start()
   ├── CURVE 密钥生成 → 写 .pub 到 NAS 目录
   ├── 创建 ROUTER socket + bind + _startRouterLoop()
   ├── resolveCurveConfig() → waitForPeerKeys() → 发现所有 peer
   ├── WorkerPool.start()
   │     └── for each worker: fork()
   │           ├── Worker 打开分配的 LMDB Outbox
   │           ├── Worker 创建 PerPeerWorker × 分配的 peer
   │           └── Worker PerPeerWorker.start()  → _tick() 开始
   ├── 如果没有 WorkerPool：创建 DEALER socket（向后兼容）
   └── _startNasMonitor(3000)
       └── WorkerPool 也会同步发现新 peer

2. Worker 子进程启动
   ├── 打开 LMDB（mmap 共享）
   ├── 创建 CRVE 密钥（写 .pub 到 NAS —— 但主进程已经写了，不需要）
   ├── 创建 DEALER socket × 分配的 peer
   ├── 创建 PerPeerWorker × peer
   └── PerPeerWorker.start() → _tick()
```

### 3.6 ROUTER 消息分发

```
ROUTER receive → frames[identity, payload]

msg.type === 'data':
  → EventStream._onRemoteData()
    → dedup + applyHandler + bus.send(ack)
    → 全部在主进程完成（不变）

msg.type === 'ack':
  → EventStream._onRemoteAck()
    → pendingTracker.delete(ackMsgId)
    → WAL.acknowledge([ackMsgId])
    → outbox.markAcked(ackMsgId)      // LMDB mmap 写入
    → 不经过 Worker
```

---

## 4 与 v1.2 设计文档的精确对比

| 特性 | v1.2 | v3.0（本方案） | 选择原因 |
|------|------|----------------|----------|
| 存储 | SQLite WAL 多文件（per-peer .db + main_events） | **LMDB 前缀索引（单库 mmap）** | LMDB O(K) 查询 vs SQLite O(N log N)，LMDB 多进程 mmap 零 IPC |
| 进程模型 | 按 port % workerCount 分片 | **一致性哈希** | 简化实现用取模，接口保一致性哈希 |
| ACK 路由 | IPC child.send → Worker 下个 tick UPDATE | **LMDB mmap markAcked → Worker 下个 tick 读到** | 零序列化，零进程切换 |
| 主进程职责 | 写 main_events + Worker 生命周期管理 | **写 Outbox + Worker 生命周期 + ROUTER 接收** | 去掉了 main_events 中转层 |
| Worker 子进程 | 子进程 fork + tick（sync→send） | **复用 PerPeerWorker 5 Phase tick** | 52 tests 已验证的 tick 逻辑，不改 |
| Worker 自杀 | `.pub` 消失 → `process.exit(0)` | **不自杀，主进程统一管理** | 当前 defer 策略更好 |
| NAS 监控 | 无 | **_startNasMonitor + WorkerPool 同步** | 运行时 peer 动态发现 |
| 向后兼容 | `workerCount=0` 走旧 Outbox | **`workerCount=1` 退化为单进程** | 一条主线，无分支 |
| 热加载 | `HOT_CONFIG_PATH` | **`ML_CONFIG_PATH`（已有）+ Worker 定期 refresh** | 当前已有实现 |

---

## 5 改动总结

### 需要改的文件

| 文件 | 改动 | 说明 |
|------|------|------|
| 新增 `pool-manager.ts` | ~200 行 | Worker 池管理：fork、一致哈希分配、保活、rehash、peer 变更通知 |
| 新增 `pool-worker.ts` | ~250 行 | Worker 子进程入口：LMDB 打开、PerPeerWorker 创建、IPC 监听 |
| `outbox-replication.ts` | +~80 行 | `isAcked(msgId)` 方法、支持多 LMDB 实例路径配置 |
| `event-bus.ts` | +~100 行 | workerCount 配置、WorkerPool 集成、_syncPeerDealers 通知 Worker、send() 的 ACK mmap 写入 |
| `multi-leader-replication.ts` | +~40 行 | 根据 peer 归属选择目标 Outbox |
| `event-stream.ts` | +~10 行 | `_onRemoteAck` 中调用 `outbox.markAcked()` |

### 不改的文件

| 文件 | 不改原因 |
|------|---------|
| `PerPeerWorker` 类 | 5 Phase tick 完全不变（仅 Phase 0 加一行 `isAcked` 检查） |
| `Outbox` 类（前缀索引） | LMDB 存储层完全不变 |
| `multi-leader-test-node.ts` | 测试辅助代码 |
| 测试文件（4 个，33 tests） | 全部应该仍然通过 |

### 实施步骤

```
Phase 0: 新增 pool-worker.ts + pool-manager.ts（~450 行）
Phase 1: 改动 event-bus.ts + outbox-replication.ts（~200 行）
Phase 2: 改动 multi-leader-replication.ts + event-stream.ts（~50 行）
Phase 3: 新增多进程集成测试（~200 行）
Phase 4: 全量回归（~900 tests）
```

---

## 6 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| Worker fork 后 LMDB 多进程写锁 | 写入性能下降 | LMDB 读锁是无阻塞的，写锁是独占但快速（mmap 写入），Worker 的写只有 `markDeliveredBatch`，主进程的写只有 `AddMessage` + `markAcked`，互斥概率极低 |
| ZMQ DEALER socket 跨进程 | Worker 需要独立的 DEALER | 每个 Worker 创建自己的 DEALER socket，connect 到对等节点的 ROUTER。对端 ROUTER 看到的是不同 identity——完全可行 |
| IPC 保活复杂度 | Worker 进程崩溃需重建 | `child.on('exit')` → `forkWorker()` 重建。Peer 的公钥在 NAS 目录中，新 Worker 直接读取 |
| 测试复杂度 | 多进程测试不稳定 | 新增多进程集成测试（类似 multi-leader-edge.spec.ts），但添加 `workerCount > 1` 分支 |

---

## 7 决策理由

### D1: 为什么保留 LMDB，不用 SQLite

参考当前代码的 §D2 表格。核心论证：LMDB 前缀索引 O(K)，SQLite SELECT O(N log N)。对于多进程场景，LMDB 的 **mmap 共享内存**特性让主进程和 Worker 零 IPC 通信成为可能。

### D2: 为什么 ACK 不走 IPC

v1.2 的 IPC ACK 是三条路径中最差的：

```
路径              延迟        序列化      进程切换
当前（单进程）     0 tick      无          无
v1.2（IPC）       1+ tick     JSON(send)  ≥ 1 次
v3.0（LMDB mmap） 0-1 tick    无（二进制）  0 次
```

v1.2 的 IPC + JSON 序列化 + 进程切换对于每个 ACK 来说开销过高。

### D3: 为什么主进程仍然写 Outbox，不交给 Worker 写

v1.2 设计 Worker 从 `main_events` sync 到 peer db。但当前代码的 `replicate()` 直接在 Outbox 写入，没有中间表。中间表引入了：

- 一次额外的 INSERT（主进程）
- 一次额外的 SELECT（Worker sync）
- 时序问题：Worker sync 需要知道从哪一条开始

v3.0 保持主进程直接写 Outbox，Worker 通过 mmap 读 pending——这是零额外开销的路径。

### D4: 为什么不用 goroutine/线程换进程

Node.js 的 Worker Threads 共享 V8 heap，多核利用率有限（JS 代码仍然在同一个线程上跑）。`fork()` 子进程有完整的 V8 隔离，真正利用多核。
