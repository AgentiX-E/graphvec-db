# 设计方案比较分析与优化建议

## 对比三份外部设计文档 + 当前项目实现

> 分析日期: 2026-05-28
> 对比范围: WorkerPool v2/v3, Raft tcp transport 设计, 当前 EventBus + 共识层实现

---

## 1. 总体对比矩阵

### 1.1 WorkerPool 架构

| 维度 | v2 (外部) | v3 (外部，v2 修正版) | 当前项目实现 |
|------|-----------|----------------------|-------------|
| Worker-Peer 映射 | **1:1** — 一个 Worker 一个 peer | **1:1** — 同上 | **M:N** — 一致性 hash 分片 |
| Worker 启动方式 | fork 子进程 + `REMOTE_PUB_PATH` 传参 | fork 子进程 + `REMOTE_PUB_PATH` 传参 | fork(workerScript, peerIds) |
| Worker 自驱动 | 5-phase tick 完全自主（独立子进程） | 5-phase tick + 退避重试 + 密钥轮换 | PerPeerWorker setTimeout loop (主进程内) |
| 分库策略 | per-peer 独立 LMDB | per-peer 独立 LMDB | 当前也支持 per-peer 分库 (`outboxV2: true`) |
| 私钥管理 | 持久化私钥 ❌ | 每次重建 DEALER 时重新生成 ✅ | 持久化私钥（NAS 模式持久化 .pub） |
| 公钥分发 | curveDir `fs.watch` + re-scan | 同 v2 | NAS 目录 `fs.watch` + 定期 re-scan (3s) |
| 空载放慢 | ackTracker + confirmedIds 双条件 | ackTracker + pendingCount 双条件 | 始终 500ms tick，无空载放慢 |
| 退避重建 | 30s ACK 沉默 → 指数退避 | 30s → 3 tick → 1s-60s 指数退避 | linearBackoff（当前 PerPeerWorker 实现） |
| 服务发现 | DNS hostname 解析 | DNS 带退避重试 | 配置驱动（publishAddress + subscribeAddresses）|
| 密钥轮换策略 | 无明确定义 | 60s 固定间隔轮换 | 只在进程启动时生成，运行期间不轮换 |

### 1.2 Raft 传输层 (TcpTransport)

| 维度 | Raft tcp transport (外部) | 当前 EventBus |
|------|--------------------------|---------------|
| 传输协议 | node:net TCP + mTLS | ZMQ ROUTER/DEALER + CURVE |
| 认证 | X.509 CA 签名证书链 | Curve25519 密钥对 + ZAP |
| 消息编码 | JSON (4-byte length prefix 帧) | ZMQ 多帧 JSON |
| 重连策略 | 指数退避 (100ms→30s) + 30% 抖动 | 退避重建 DEALER (linearBackoff) |
| 健康检查 | 空帧心跳 (5s 间隔) | ZMQ OS-level TCP keepalive |
| 证书轮换 | CertRotator 24h 定时轮换 ❌ | 启动时生成，运行期间不轮换 ✅ |
| 多进程能力 | 原生支持（TCP 跨进程通信） | ZMQ 原生跨进程（ROUTER/DEALER TCP）|
| 分片 Raft 实例隔离 | 共享 ConnectionPool | 当前 consensus 实例独立（per-group）|

### 1.3 R9/R10: 分区检测 & 成员变更

| 维度 | 外部设计 | 当前项目实现 |
|------|----------|-------------|
| 分区检测 | **无**（外部设计集中在传输层和 WorkerPool 架构） | **AppHeartbeatManager** — 1s ping + Outbox 失败交叉确认 ✅ |
| 成员变更 | **无** | **AppMembershipManager** — 两阶段提交 ✅ |
| Outbox 冻结 | 无对应（.pub 文件消失时 Worker exit，不区分分区） | PerPeerWorker.setFrozen() + 冰结期间 ACK cleanup 持续 ✅ |
| 三层检测 | 无 | raft-logic WASM: onQuorumActive + onRoleChange + 2s polling ✅ |

---

## 2. 关键决策判断

### 2.1 ✅ 采纳: Worker-Peer 1:1 映射

**判断: 完全同意。当前的一致性 hash M:N 映射应当改为 1:1。**

#### 当前实现的问题

`src/core/event-bus-worker-pool.ts` 使用一致性 hash 将 peer 分配到固定数量的 Worker 子进程：

```
Worker[0] → peer-A, peer-B, peer-C  (同一进程中 3 个 DEALER)
Worker[1] → peer-D, peer-E          (同一进程中 2 个 DEALER)
```

这在扩容/缩容时的问题是：
1. Worker 数变化 → 重新 compute hash ring → 部分 peer 分配到不同 Worker → 重建 DEALER、重启 tick 循环、丢失 pending 状态
2. 一个有退避状态的 peer（连续失败 30s）拖累同 Worker 内其他健康的 peer
3. M:N 情况下，`_forkWorker(index, peerIds)` 需要为每个 Worker 单独计算分片，增加复杂度

#### 1:1 的优势

```
Worker[node-b__43001] → peer-B (一个 DEALER)  ← 新 peer 加入 = fork 新 Worker
Worker[node-c__43001] → peer-C (一个 DEALER)  ← peer 离开 = Worker exit(0)
Worker[node-d__43002] → peer-D (一个 DEALER)  ← 退避只影响该 peer
```

| 场景 | M:N (当前) | 1:1 (建议) |
|------|-----------|------------|
| 新节点加入集群 | rehash，可能迁移 peer 到不同 Worker | fork 一个新 Worker |
| 节点离开（.pub 消失） | Worker 退出，其余 worker 重新分配 | 该 Worker exit(0)，无影响 |
| 扩容 Worker 进程数 | 必须重新计算 hash ring + 迁移 | 无需操作（Worker 数 = peer 数） |
| 一个 peer 退避中 | 影响同 Worker 内所有其他 peer | 只影响该 peer |
| 一个 peer LMDB 损坏 | 影响同 Worker 的多个 peer 的写入 | 只影响该 peer |
| 理解/调试 | 需要理解一致性 hash 分配逻辑 | "一个 Worker = 一个 peer" 直观 |

#### 规模合理性论证

集群大小通常在 3-7 节点之间（Raft 的典型规模）。即使到 20 节点，每个节点也只需要维护最多 19 个 Worker 子进程。每个 Worker 的资源开销：

| 资源 | 单个 Worker |
|------|-------------|
| 内存 | ~10-20MB（LMDB + ZMQ DEALER + TCP buffer） |
| CPU | 空闲时接近 0（空载放慢到 1s tick） |
| 文件描述符 | 2-3（DEALER socket + LMDB）|
| LMDB 文件 | 1 个独立文件（`outbox-{peer}.lmdb`）|

20 个 Worker 总计 <400MB，在服务器上完全可接受。

#### 建议的实施变更

**第一步**: `EventBusWorkerPool.start()` 去掉一致性 hash，改为 peer 到 Worker 1:1 创建：

```typescript
// 当前实现 (M:N)
class EventBusWorkerPool {
  async start(peerIds: string[], workerCount: number): Promise<void> {
    const hash = new ConsistentHash()
    hash.updateWorkers(workerCount)
    
    for (let i = 0; i < workerCount; i++) {
      const assignedPeers = peerIds.filter(p => hash.getWorkerIndex(p) === i)
      await this._forkWorker(i, assignedPeers)
    }
  }
}

// 改为 1:1
class EventBusWorkerPool {
  private workers = new Map<string, WorkerInstance>()  // peerId → Worker
  
  async start(peerIds: string[]): Promise<void> {
    for (const peerId of peerIds) {
      await this._forkWorker(peerId)
    }
  }
  
  // R10 集成：新节点加入
  async onPeerJoined(peerId: string): Promise<void> {
    if (!this.workers.has(peerId)) {
      await this._forkWorker(peerId)
    }
  }
  
  // R10 集成：节点离开
  onPeerLeft(peerId: string): void {
    const worker = this.workers.get(peerId)
    if (worker) {
      worker.process.send({ type: 'shutdown' })
      this.workers.delete(peerId)
    }
  }
}
```

**第二步**: 保留 `_forkWorker` 的多进程能力，但每个 Worker 只管理一个 DEALER。

**第三步**: PerPeerWorker 当前在主进程内（`outbox-replication.ts` 中的 setTimeout loop）。短期可以保持，后续随 1:1 改为 fork 模式。

### 2.2 ❌ 不采纳: 固定周期密钥轮换

**判断: 固定 24h 或 60s 的密钥轮换不应该采纳。**

#### 分析

外部设计中存在两种轮换策略：
- **Raft tcp transport**: `certRotationMs: 24h` — 每隔 24h 重新生成 TLS 证书并广播
- **WorkerPool v3**: `MY_KEY_REFRESH_INTERVAL_MS = 60_000` — 每 60s 重新生成 CURVE 密钥对

两者都有根本问题：

| 维度 | 当前项目（启动时生成） | 固定周期轮换 |
|------|----------------------|-------------|
| 轮换频率 | 进程启动时 | 每 60s / 24h 一次 |
| 重建次数 | **0 次额外重建** | 每 60s / 24h 一次全链路重建 |
| 安全价值 | 启动时生成本身就是一次密钥初始化 | 无增量安全增益（见下方论证） |
| 调试复杂度 | 低 — 重建只发生在故障时 | 高 — 重建原因模糊：轮换还是故障？ |
| 风险 | 无 | 重建期间队列堆积 + 对端检测变更的响应延迟 |

#### 安全论证

CURVE 协议的安全性来自 **每个 TCP 连接独立协商 ephemeral session key**（CurveCP 协议本身的特性），而不是长期密钥对的频繁轮换。即使在长期密钥不变的情况下，每条连接都有自己的短期会话密钥，保证：

- 前向安全性（forward secrecy）：即使长期私钥泄露，过去的会话无法解密
- 每条连接加密独立

**固定周期轮换不增加任何实质安全性**，但成本真实：
1. DEALER 重建：close() + 生成新密钥对 + 写 `.pub` + connect 握手（1-2 RTT）
2. 对端检测：`phaseKeyDiscovery` 读取新 `.pub` → 内容变更 → 重建对方的 DEALER
3. 每 60s 全链路抖动一次，集群规模越大抖动越明显

#### 正确的策略

```
只在以下时机生成/轮换密钥:
  1. 进程启动时（初始化密钥对）
  2. DEALER 重建时（因退避/连接断开触发，v3 的 tryCreateDealer 已正确实现此逻辑）
  
不在以下时机轮换:
  1. 固定定时器
  2. 消息量低时
  3. 任何没有检测到故障的时间点
```

**对当前项目的建议**: 当前 `EventBus._initCurve()` 在 `start()` 中生成密钥对——保持此行为即可。不需要增加定时轮换。

### 2.3 ✅ 确认: Worker 自主驱动

**判断: 当前 PerPeerWorker 的设计已经具备部分自驱动能力，但未达到 v3 文档中完全的 "5-phase self-driven" 程度。**

#### 当前实现的自驱动能力

`src/core/outbox-replication.ts` 中 `PerPeerWorker`:

```typescript
class PerPeerWorker {
  start(): void {
    const loop = async () => {
      await this._tick()
      this.workerTimer = setTimeout(loop, this._tickMs)
    }
    this.workerTimer = setTimeout(loop, this._tickMs)
  }
  
  private async _tick(): Promise<void> {
    // R9: 分区冻结检查
    if (this._frozen) {
      // ACK cleanup (不发送)
      return
    }
    
    // 1. fetchPending + filter delivered
    // 2. send fn (通过 eventBus.send)
    // 3. ackTracker / backoff
  }
}
```

对比 v3 的 5-phase tick:

| Phase | v3 定义 | 当前实现 | 差距 |
|-------|---------|----------|------|
| 1. refreshAcks | 从 ackDB 扫描已确认事件 | 当前通过 ackTracker 检查超时 | 当前缺少从 LMDB 扫描已确认事件的循环 |
| 2. fillAndSend | 取 pending 事件 → DEALER.send() | ✅ 有 fetchPending + batchSendSerializedFn | 当前实现相当成熟，含批量和序列化缓存 |
| 3. backoff | ACK 沉默 30s → 重建 DEALER | ✅ 有 linearBackoff + recoverDealerFn | 当前使用线性退避而非指数退避 |
| 4. keyDiscovery | 检测 .pub 变化、对端存在性 | 当前在 EventBus 侧的 curveWatcher 中 | 当前是主进程扫描，Worker 不感知 |
| 5. housekeeping | LMDB 清理 | ✅ 有 OutboxReplicationManager 的 housekeepingTimer | |

#### 主要差距

1. **Phase 1 (refreshAcks)**: 当前 `_tick()` 检查 `ackTracker` 超时但不主动从 LMDB 扫描已确认事件。如果 ACK 消息到达 ROUTER 并写入 LMDB，Worker 的 tick 不会主动读取。这可能导致 `ackTracker` 在超时前一直保留已确认事件的条目，影响空载放慢的判断。

2. **Phase 4 (keyDiscovery)**: 当前 `.pub` 变更检测在 `EventBus.start()` 的 `startCurveWatcher()` 中，是主进程职责。Worker 被动接收通知。v3 的方案是 Worker 自主检测。这取决于架构偏好——如果 Worker 是子进程，适合自主检测；如果 Worker 在主进程内（当前），由主进程通知更高效。

3. **Phase 3 (backoff)**: 当前使用 `linearBackoff`（线性增量），v3 使用指数退避 + 抖动。线性退避在连续失败时增长太慢（短场景）或太快（长场景）。指数退避 + 30% 抖动更优。

#### 建议

**短期改进（当前架构下）**:

```typescript
// 1. 在 PerPeerWorker._tick() 中加 refreshAcks 阶段
private async _refreshAcks(): Promise<void> {
  // 定期（每 5 tick）从 LMDB 扫描已 ack 的事件
  if (tickCount % 5 !== 0) return
  const prefix = 'acked:'
  this.outbox.getRange({ start: prefix }).forEach((entry: any) => {
    const key = entry.key as string
    const parsed = key.replace('acked:', '')
    if (this.ackTracker.has(parsed)) {
      this.ackTracker.delete(parsed)
    }
  })
}

// 2. 退避策略改为指数退避 + 抖动
private _backoffDelay(): number {
  const base = this._ackTimeoutMs * Math.pow(2, this.backoffCount)
  const jitter = base * 0.3 * Math.random()
  return Math.min(base + jitter, this._maxBackoffMs)
}
```

**中长期改进（fork 子进程 + 1:1 映射）**:
当 PerPeerWorker 改为子进程后，自主驱动的 5-phase tick 自然就位——Worker 不需要主进程通知任何事件。这使得 R10 动态连接管理（添加/移除 peer）更加简洁：主进程写 `.pub` / 删 `.pub`，Worker 自主检测并处理。

### 2.4 ✅ 确认: per-peer 级别分库路由

**判断: 当前已经实现 per-peer 分库路由，且实现方式与 v2/v3 一致。**

#### 当前实现

```typescript
// src/core/outbox-replication.ts

// OutboxReplicationManager.addMessage():
outbox.add({
  msgId: data['msgId'] as string,
  targetNodeId: peer.nodeId,    // 指定目标 peer
  type,
  payload: JSON.stringify({ type, data }),
  createdAt,
  delivered: false,
  deliveredAt: 0,
})

// 写入时根据 peerId 选库
private _getOrOpenPeerDb(peerId: string): RootDatabase {
  // 打开 outbox-{peerId}.lmdb
  const dbPath = path.join(this.dbDir, `outbox-${peerId}.lmdb`)
  return open({ path: dbPath })
}

// 写入 peer 分库
async add(entry: OutboxEntry): Promise<void> {
  const peerDb = this._getOrOpenPeerDb(entry.targetNodeId)
  // ...
}
```

这与 v2/v3 的设计是一致的：
- v2: `outbox-node-b__43001.lmdb`
- v3: 同上
- 当前: `outbox-{peerId}.lmdb`（peerId 做 key，等价）

遍历当前实现中所有 peer 的写入：

```typescript
// addMessage:
const remotePeers = this.config.peers.filter(p => p.nodeId !== this.config.nodeId)
for (const peer of remotePeers) {
  this.outbox.add({ targetNodeId: peer.nodeId, ... })
}
```

当 `targetNodes='*'`（广播）时，主进程循环写所有分库。这与 v2 的 `EventBusOutbox.insert()` 逻辑一致。

**建议**: 分库路由已经正确实现，无需改动。当前的路由策略：

| targetNodes | 写入方式 |
|-------------|----------|
| `'*'`（广播） | 循环写入所有 per-peer 分库 |
| `'node-b'`（定向） | 写入对应 peer 的分库（当前 `addMessage` 只支持广播，R10 后需支持定向写入） |

### 2.5 补充判断: v3 的设计质量评估

v3 相对于 v2 是显著的改进，以下判断供参考：

| v3 改进 | 判断 | 理由 |
|---------|------|------|
| 私钥不应持久化 ✅ | 采纳 | 与当前实现一致 — 进程启动时生成新密钥，不持久化私钥文件 |
| 公钥获取退避重试 ✅ | 采纳 | 对端 `.pub` 可能延迟出现（写入未完成），退避重试是合理的 defensive 策略 |
| phaseKeyDiscovery 频率调整 ✅ | 参考采纳 | 独立间隔 (500ms-5s) 比 "每 N tick" 更合理。当前 3s 定期检查，可接受 |
| 空载放慢判断优化 ✅ | 采纳 | `ackTracker.size === 0 && pendingCount === 0` 是正确判断条件 |
| ackDB 写入路径明确化 ✅ | 采纳 | 当前实现已有 ACK 写入路径，需要确认是否被 Worker 读取 |
| Worker 崩溃重建增强 ✅ | 采纳 | 当前 `_ensureWorker` 已覆盖此场景 |

---

## 3. 综合优化建议

### 3.1 优先级排序

| 优先级 | 优化项 | 影响范围 | 工作量估计 |
|--------|--------|----------|-----------|
| **P0** | 1:1 Worker-Peer 映射 | `event-bus-worker-pool.ts` | 2-3 天 |
| **P1** | PerPeerWorker 增加 refreshAcks 阶段 | `outbox-replication.ts` | 0.5 天 |
| **P1** | linearBackoff → 指数退避 + 抖动 | `outbox-replication.ts` | 0.5 天 |
| **P2** | 空载放慢策略实现 | `outbox-replication.ts` | 0.5 天 |
| **P3** | PerPeerWorker fork 为子进程 | `event-bus-worker-pool.ts` + `outbox-replication.ts` | 3-5 天 |
| **—** | 固定周期密钥轮换 | — | **不实施** |
| **—** | 一致性 hash | — | **移除** |

### 3.2 P0: 1:1 映射实施方案

```typescript
// 1. 移除 ConsistentHash 类（或保留但不再使用）

// 2. EventBusWorkerPool 改为 1:1
interface WorkerEntry {
  process: child_process.ChildProcess
  peerId: string
  startedAt: number
  sentCount: number
  running: boolean
}

class EventBusWorkerPool {
  private workers = new Map<string, WorkerEntry>()  // peerId → Worker
  
  async start(): Promise<void> {
    // 扫描 curveDir，为每个对端 .pub fork 一个 Worker
    const peerIds = this._discoverPeers()
    for (const peerId of peerIds) {
      await this._forkWorker(peerId)
    }
    
    // 启动 curveDir 监视器
    this._startCurveWatcher()
  }
  
  // curveDir 发现新 .pub
  private async _onNewPeerDetected(peerIdentity: string): Promise<void> {
    if (!this.workers.has(peerIdentity)) {
      await this._forkWorker(peerIdentity)
    }
  }
  
  // curveDir 检测 .pub 消失
  private _onPeerRemoved(peerIdentity: string): void {
    this._shutdownWorker(peerIdentity)
  }
  
  // fork 单个 Worker
  private async _forkWorker(peerIdentity: string): Promise<void> {
    const workerScript = this._getWorkerScriptPath()
    const child = child_process.fork(workerScript, [], {
      env: {
        ...process.env,
        REMOTE_PUB_PATH: path.join(this.curveDir, `${peerIdentity}.pub`),
        CURVE_DIR: this.curveDir,
        OUTBOX_DIR: this.outboxDir,
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    })
    
    // 等待 ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Worker init timeout')), 10000)
      child.on('message', (msg: any) => {
        if (msg.type === 'ready') {
          clearTimeout(timeout)
          resolve()
        }
      })
      child.on('error', reject)
    })
    
    this.workers.set(peerIdentity, {
      process: child,
      peerId: peerIdentity,
      startedAt: Date.now(),
      sentCount: 0,
      running: true,
    })
  }
}

// 3. R10 集成 — 添加新 peer
async onMembershipChange(members: string[]): Promise<void> {
  const memberSet = new Set(members)
  
  // 移除的不再是成员的 Worker
  for (const [peerId, worker] of this.workers) {
    if (!memberSet.has(peerId)) {
      this._shutdownWorker(peerId)
    }
  }
  
  // 新加入的成员创建 Worker
  for (const member of members) {
    if (member === this.nodeId) continue
    if (!this.workers.has(member)) {
      await this._forkWorker(member)
    }
  }
}
```

### 3.3 P1: 指数退避 + 空载放慢

`PerPeerWorker._tick()` 中新增/修改:

```typescript
private tickCount = 0

private async _tick(): Promise<void> {
  this.tickCount++
  
  // Phase 1: Refresh ACKs (每 5 tick)
  if (this.tickCount % 5 === 0) {
    await this._refreshAcks()
  }
  
  // R9: Partition freeze
  if (this._frozen) {
    return
  }
  
  // Phase 2: Fill and send
  await this._fillAndSend()
  
  // Phase 3: Backoff detection
  await this._checkBackoff()
  
  // Phase 4 + 5 handled by main process (curveWatcher + housekeepingTimer)
  
  // Empty load slowdown
  const nextMs = this._getNextTickMs()
  this.workerTimer = setTimeout(() => this._tick(), nextMs)
}

private _refreshAcks(): void {
  if (this.ackTracker.size === 0) return
  const prefix = `acked:${this.peerId}:`
  this.outbox.getRange({ start: prefix }).forEach((entry: any) => {
    const key = entry.key as string
    const msgId = key.replace(prefix, '')
    if (this.ackTracker.has(msgId)) {
      this.ackTracker.delete(msgId)
    }
  })
}

private _checkBackoff(): void {
  if (this.ackTracker.size === 0) {
    this.backoffCount = 0  // Reset backoff when no pending ACKs
    return
  }
  
  const oldest = Math.min(...Array.from(this.ackTracker.values()))
  const silentMs = Date.now() - oldest
  if (silentMs > 30000) {
    this.backoffCount++
    // 指数退避：在 backoffCount > 0 时放慢 tick
  }
}

// 空载放慢 + 退避放慢
private _getNextTickMs(): number {
  if (this.backoffCount > 0) {
    // 指数退避：1000ms × 2^backoffCount，上限 60s
    const delay = 1000 * Math.pow(2, this.backoffCount)
    const jitter = delay * 0.3 * Math.random()
    return Math.min(delay + jitter, 60000)
  }
  if (this.ackTracker.size === 0 && this.getPendingCount() === 0) {
    return 1000  // 空载放慢到 1s
  }
  return this._tickMs  // 正常 500ms
}
```

### 3.4 当前项目与外部设计的关键差异总表

| 功能点 | 当前项目 | v3 设计 | 建议 |
|--------|---------|---------|------|
| **Worker-Peer 映射** | 一致性 hash M:N | 1:1 | 改为 1:1 ✅ |
| **密钥生成时机** | 进程启动时 | DEALER 重建时重新生成 | 保持当前 + DEALER 重建时重新生成 ✅ |
| **固定轮换** | 无 | 60s | 不采纳 ❌ |
| **Worker 自驱动** | setTimeout loop + tick | 5-phase tick | 增加 refreshAcks + 指数退避 |
| **分库路由** | per-peer LMDB ✅ | per-peer LMDB ✅ | 保持 |
| **空载放慢** | 无 | ackTracker + pendingCount | 采纳 |
| **公钥获取退避** | 读取不存在则返回 null | 10 次退避重试 (500ms→5s) | 采纳 |
| **一致性 hash 类** | `ConsistentHash` (CRC32) | 无 | 移除 |
| **DNS 服务发现** | 配置驱动 | DNS + 退避重试 | 可加分阶段实施 |
| **R9 分区检测** | AppHeartbeatManager ✅ | 无 | 保持 ✅ |
| **R10 成员变更** | AppMembershipManager ✅ | 无 | 保持 + 集成 WorkerPool dynamic |

---

## 4. 总结

| 决策 | 选择 | 理由 |
|------|------|------|
| Worker-Peer 映射 | **1:1** | 简化扩容/缩容，每个 peer 独立退避，与 R10 动态成员变更自然契合 |
| 密钥轮换策略 | **启动时/重建时** | 固定周期轮换不增加安全价值，但引入全链路抖动 |
| Worker 自驱动 | **吸收 v3 的 5-phase 设计** | refreshAcks + 指数退避 + 空载放慢是目前主要缺失 |
| per-peer 分库 | **保持当前实现** | 已经正确实现，符合 v2/v3 设计目标 |
| R9/R10 | **保持当前实现** | AppHeartbeatManager + AppMembershipManager 是当前项目独有的成熟实现，外部设计未覆盖此需求 |

**最终建议的短期实施计划**:
1. **P0**: `EventBusWorkerPool` 1:1 映射 + 移除 `ConsistentHash`
2. **P1**: `PerPeerWorker` 增加 refreshAcks 阶段 + 指数退避 + 空载放慢
3. **P2**: Worker 子进程 fork 时传 `REMOTE_PUB_PATH`（为后续 R10 动态连接做准备）
4. **P3**: R10 集成 — `AppMembershipManager.onMembershipChange` → `EventBusWorkerPool.onPeerJoined/onPeerLeft`

**不实施的项**:
- 固定周期密钥轮换（无安全增益，有稳定性成本）
