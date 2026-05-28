# 综合优化方案

> 综合 WorkerPool v2/v3、Raft TcpTransport（mTLS）、R9/R10 三份设计 + 当前项目代码
> 日期: 2026-05-28
> 范围: DC 内节点间消息传输 + WorkerPool 架构 + 安全 + 共识层

---

## 1. 总体架构蓝图

```
┌──────────────────────────────────────────────────────────────────┐
│ 节点 A                                                           │
│                                                                  │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ 一致性层 (Strong Consistency)                                  │ │
│ │                                                              │ │
│ │  RaftCore / raft-logic WASM                                  │ │
│ │     ↓ sendAppendEntries / sendTo(peerId, msg)                │ │
│ │  ┌────────────────────────────────┐                          │ │
│ │  │ mTlsTransport (新增/改造)       │                          │ │
│ │  │  node:tls → TLS 1.3           │  ←── 同 DC Raft 消息      │ │
│ │  │  CA 签名证书双向认证            │                           │ │
│ │  │  4-byte length-prefix JSON     │                           │ │
│ │  │  指数退避 + 30% 抖动重连       │                           │ │
│ │  │  CertManager (启动时轮换)      │                           │ │
│ │  └────────────────────────────────┘                          │ │
│ └──────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ 最终一致性层 (Eventual Consistency)                            │ │
│ │                                                              │ │
│ │  EventStream / AppHeartbeatManager / AppMembershipManager    │ │
│ │     ↓ send(peerId, msg)                                      │ │
│ │  ┌────────────────────────────────┐                          │ │
│ │  │ ZMQ ROUTER/DEALER + CURVE      │  ←── 同 DC + 跨 DC 事件   │ │
│ │  │  2 层:                          │                          │ │
│ │  │  ├── 主进程: ROUTER + Outbox    │                          │ │
│ │  │  └── Worker子进程: DEALER + LMDB│                          │ │
│ │  │  1:1 Worker-Peer (改造后)       │                          │ │
│ │  │  5-phase自驱动 tick             │                          │ │
│ │  └────────────────────────────────┘                          │ │
│ └──────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ 健康检查层 (Health Detection)                                  │ │
│ │                                                              │ │
│ │  AppHeartbeatManager (1s ping)                               │ │
│ │  Outbox 失败率交叉确认                                        │ │
│ │  raft-logic WASM onQuorumActive 辅助                          │ │
│ └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

**关键分层原则**：
- **mTlsTransport** (node:tls)：同 DC 内 Raft 协议消息（强一致、低延迟、严格有序）
- **ZMQ ROUTER/DEALER**：同 DC + 跨 DC EventStream 事件 + 应用层心跳/成员变更（最终一致、长连接、持久化 Outbox）
- **AppHeartbeatManager + AppMembershipManager**：在 ZMQ 层之上，作为 raft-logic WASM 就位前的"伪 Raft"方案，WASM 就位后可降级为备用/辅助路径

---

## 2. 分阶段执行计划

### Phase 0: 当前状态检查（1天）

| 检查项 | 文件 | 状态 |
|--------|------|------|
| TcpTransport 基本实现 | `src/consensus/transport.ts:342-955` | ✅ 已有 |
| mTLS 支持 | `tls.createServer` / `tls.connect` 未接入 | ❌ 缺失 |
| CertManager (启动时生成) | 无 | ❌ 缺失 |
| 启动时密钥生成 | `EventBus._initCurve()` 在 `start()` 中生成 CURVE 密钥 | ✅ EventBus 已有 |
| CURVE 密钥不持久化 | `generateCurveKeys()` 每次新生成 | ✅ 正确 |
| 证书轮换 | `CertRotator` 24h | ❌ 不实现（改用启动时生成） |
| 1:1 Worker-Peer | `event-bus-worker-pool.ts` 一致性 hash | ❌ M:N 需要改 |
| Worker 5-phase 自驱动 | `outbox-replication.ts:PerPeerWorker` | 🟡 部分 |
| per-peer 分库路由 | `outbox-replication.ts` | ✅ 已实现 |
| DNS 服务发现 | 配置驱动（无 DNS） | ❌ 需求驱动 |
| 指数退避 + 抖动 | `inBackoff` 固定延时 | ❌ 需要改 |
| 公钥获取退避重试 | `_readPeerPubKey()` 无重试 | ❌ 需要加 |
| 空载放慢 | 无 | ❌ 需要加 |

### Phase 1: TcpTransport → mTlsTransport（3-4天）

#### 1a: CertManager（启动时证书生成与分发）

新文件: `src/consensus/cert-manager.ts`

```
启动时:
  1. 检查 curveDir 是否存在 CA 根证书
     - 不存在 → 生成自签名 CA（RSA 4096）
     - 存在 → 加载
  2. 为本节点生成新证书（RSA 2048，CN=raft-node-{nodeId}）
     - CA 签名
  3. 写入:
     curveDir/ca.pem            (CA 根证书)
     curveDir/node-{nodeId}.crt (本节点证书)
     curveDir/node-{nodeId}.key (本节点私钥)
     curveDir/node-{nodeId}.pub (公钥 — 供 ZMQ CURVE 共用)
  4. 扫描 curveDir/*.crt → 加载所有对端证书
```

```typescript
// 接口
interface CertManagerConfig {
  curveDir: string
  nodeId: string
  /** 证书有效期（天），默认 3650 */
  validityDays?: number
}

interface ManagedCert {
  ca: { cert: string }
  node: { cert: string; key: string }
  /** 已发现的对端证书: peerNodeId → cert PEM */
  peerCerts: Map<string, string>
}

interface PeerEndpoint {
  nodeId: string
  host: string
  port: number
}
```

**为什么不实现 `CertRotator` 24h 轮换**：
- TLS 1.3 的会话票据（session ticket）+ ECDHE 密钥交换已经保证前向安全性
- 启动时生成新证书 `==` 自然轮换
- 证书有效期 10 年（3650 天），不设轮换定时器
- 与 ZMQ CURVE 策略一致（启动时生成，运行期不轮换）

#### 1b: 改造 TcpTransport → mTlsTransport

改造 `src/consensus/transport.ts` 中 `TcpTransport`：

```typescript
// 当前
class TcpTransport {
  private server: net.Server
  
  constructor(...) {
    this.server = net.createServer(this._onConnection.bind(this))
  }
}

// 改为
class TcpTransport {
  private server: tls.TLSServer
  
  constructor(
    private nodeId: string,
    private port: number,
    private certManager: CertManager,
    private peerEndpoints: Map<string, PeerEndpoint>,
    private config?: { 
      connectTimeoutMs?: number  // default 5000
      initialRetryMs?: number     // default 100
      maxRetryMs?: number         // default 30000
      backoffFactor?: number      // default 2
    }
  ) {
    this.server = tls.createServer({
      cert: certManager.getNodeCert(),
      key: certManager.getNodeKey(),
      ca: certManager.getCACert(),
      requestCert: true,
      rejectUnauthorized: true,
    }, this._onConnection.bind(this))
  }
}
```

**重连策略**（来自 v3 和 Raft tcp design 的整合）：

```typescript
function nextRetryMs(attempt: number): number {
  const base = 100 * Math.pow(2, attempt)
  const jitter = base * 0.3 * Math.random()
  return Math.min(base + jitter, 30000)
}

// attempt 0: 100ms + 0~30ms
// attempt 1: 200ms + 0~60ms
// attempt 6: 6400ms + 0~1920ms
// attempt 8+: 25600ms + 0~7680ms (cap at 30s)
```

**连接生命周期**（来自 Raft tcp design §3.3）：

```
DISCONNECTED
    │ connect() / 对端连接到达
    ▼
CONNECTING
    │ TLS 握手完成 + CN 验证通过
    ▼
CONNECTED
    │ error / close
    ▼
DISCONNECTED → scheduleReconnect(attempt+1) → 退避后 → CONNECTING
```

**健康检查**（来自 Raft tcp design §3.9）：空帧心跳 5s 间隔，30s 无数据判定 stale。

**单机测试**：连接 `127.0.0.1:{port}` + `NODE_VERIFY=skip` 模式（允许跳过 CN 匹配）。

#### 1c: 集成 raft-logic 的 transport 接口

当前 `raft-logic-consensus.ts` 已经有一条 TcpTransport 的集成路径（§104-137）。改造为：

```typescript
// raft-logic-consensus.ts 改造后
if (this.config.transportPort) {
  const tlsTransport = new TlsTransport(
    this.config.nodeId,
    this.config.transportPort,
    certManager,
    peerEndpoints,
  )
  tlsTransport.start()
  this._transport = tlsTransport
} else {
  this._transport = new InMemoryTransport()
}
this._node = new RaftNode({
  sendTo: (peerId: number, msg: Uint8Array) => {
    this._transport.sendTo(String(peerId), msg)
  },
  onMessage: (handler) => {
    this._transport.setMessageHandler(handler)
  },
})
```

对 `RaftCore`（`raft-core.ts`）的集成：
`RaftCore` 使用 `Transport` 接口的 `appendEntries(to, req)` / `requestVote(to, req)` RPC 方法。当前的 TcpTransport 不实现这些方法（只实现了 `sendTo` / `sendToSync`）。所以需要：

- mTlsTransport 实现 `Transport` 接口（`appendEntries` / `requestVote` / `preVote` / `installSnapshot`）
- 底层通过 `sendTo` + 请求/响应匹配实现 RPC 语义

#### 1d: 证书生成脚本（CI/E2E 测试用）

```
scripts/gen-raft-certs.sh:
  └── 生成 CA + N 个节点证书
  └── 输出到 test-certs/ 目录
  └── 支持 --node-count 3
  └── 支持 --output-dir
```

E2E 测试：单机 fork 3 个进程，每个使用不同端口 + 自己证书，测试 Leader 选举、日志复制、节点失效恢复。

---

### Phase 2: WorkerPool 1:1 + 5-phase 自驱动（3-4天）

#### 2a: EventBusWorkerPool 1:1 映射

改造 `src/core/event-bus-worker-pool.ts`：

```typescript
// 移除 ConsistentHash
// 改为 peerId → Worker 的 Map

class EventBusWorkerPool {
  private workers = new Map<string, WorkerEntry>()  // peerId → Worker
  
  async start(peerIds: string[]): Promise<void> {
    for (const peerId of peerIds) {
      await this._forkWorker(peerId)
    }
  }
  
  // 新 peer 加入（R10 集成）
  async onPeerJoined(peerId: string): Promise<void> {
    if (!this.workers.has(peerId)) {
      await this._forkWorker(peerId)
    }
  }
  
  // peer 离开（.pub 消失 / R10 成员变更）
  onPeerLeft(peerId: string): void {
    const worker = this.workers.get(peerId)
    if (worker) {
      worker.process.send({ type: 'shutdown' })
      this.workers.delete(peerId)
    }
  }
  
  // fork 单个 Worker（传入 REMOTE_PUB_PATH）
  private async _forkWorker(peerIdentity: string): Promise<void> {
    const child = child_process.fork(workerScript, [], {
      env: {
        ...process.env,
        REMOTE_PUB_PATH: path.join(this.curveDir, `${peerIdentity}.pub`),
        CURVE_DIR: this.curveDir,
        OUTBOX_DIR: this.outboxDir,
        ROUTER_BIND_PORT: String(this.routerPort),
        NODE_ID: this.nodeId,
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    })
    // ... 等待 ready 消息
  }
}
```

**关键变更点**：
1. `_forkWorker(index: number, peerIds: string[])` → `_forkWorker(peerIdentity: string)`（单个 peer）
2. 移除 `ConsistentHash` 类
3. Worker 启动参数从 peerId 列表变为 `REMOTE_PUB_PATH`（与 v2/v3 设计一致）
4. 增加 `onPeerJoined` / `onPeerLeft` 供 R10 `AppMembershipManager` 调用

#### 2b: PerPeerWorker 5-phase tick 增强

改造 `src/core/outbox-replication.ts`：

```typescript
// PerPeerWorker._tick() 重构为 5-phase

private tickCount = 0

private async _tick(): Promise<void> {
  this.tickCount++
  
  // Phase 1: Refresh ACKs（每 5 tick）
  if (this.tickCount % 5 === 0) {
    await this._refreshAcks()
  }
  
  // R9: Partition freeze
  if (this._frozen) {
    return  // ACK cleanup still ongoing in _refreshAcks
  }
  
  // Phase 2: Fill pending → Send
  await this._fillAndSend()
  
  // Phase 3: Backoff detection
  await this._checkAndApplyBackoff()
  
  // Phase 4: Key discovery（对端 .pub 检查，每 10 tick = ~1s）
  if (this.tickCount % 10 === 0) {
    await this._checkPeerPubKey()
  }
  
  // Phase 5: 空载放慢
  const nextTick = this._nextTickMs()
  this.workerTimer = setTimeout(() => this._tick(), nextTick)
}
```

**各 Phase 细节**：

```typescript
// Phase 1
private async _refreshAcks(): Promise<void> {
  if (this.ackTracker.size === 0) return
  const prefix = `acked:${this.peerId}:`
  this.outbox.getRange({ start: prefix }).forEach((entry: any) => {
    const key = entry.key as string
    const msgId = key.replace(prefix, '')
    if (this.ackTracker.has(msgId)) {
      this.ackTracker.delete(msgId)
      this.lastSuccessfulSend.set(this.peerId, Date.now())
      this.inBackoff = false
    }
  })
}
```

```typescript
// Phase 3 — 指数退避 + 抖动（替代当前固定 maxBackoffMs）
private _checkAndApplyBackoff(): void {
  if (this.ackTracker.size === 0) {
    this.backoffCount = 0
    return
  }
  const oldest = Math.min(...Array.from(this.ackTracker.values()))
  const silentMs = Date.now() - oldest
  if (silentMs > 30000) {
    this.backoffCount++
    this.inBackoff = true
    this.lastSendMs = Date.now()
    
    // 触发 DEALER 重建
    if (this.backoffCount >= 3) {
      this._recoverDealer()
    }
  }
}

// 指数退避延迟计算
private _backoffDelayMs(): number {
  if (this.backoffCount === 0) return 0
  const base = 1000 * Math.pow(2, this.backoffCount - 1)
  const jitter = base * 0.3 * Math.random()
  return Math.min(base + jitter, 60000)
}
```

```typescript
// Phase 4 — 获取对端公钥（带退避重试）
private async _checkPeerPubKey(): Promise<void> {
  const pubPath = path.join(this.config.curveDir, `${this.peerId}.pub`)
  if (!fs.existsSync(pubPath)) {
    // 对端 .pub 消失 → Worker exit(0)
    this.log.warn(`peer .pub deleted, exiting`)
    process.exit(0)
  }
  // 检查公钥变更 → 重建 DEALER
  const current = fs.readFileSync(pubPath, 'utf-8').trim()
  if (current !== this._peerPubKey && this._peerPubKey) {
    this.log.info('peer pubkey changed, triggering reconnect')
    this._peerPubKey = current
    this.config.recoverDealerFn(this.peerId)
  }
}
```

```typescript
// Phase 5 — 空载放慢
private _nextTickMs(): number {
  if (this.inBackoff) {
    return Math.min(1000, this.tickMs) // 退避中仍保持 1s 检测
  }
  if (this.ackTracker.size === 0 && this.normalQueue.length === 0) {
    return Math.min(this.tickMs * 2, 1000) // 空载放慢到 1s
  }
  return this.tickMs
}
```

**公钥获取退避重试（tryCreateDealer 中的增强）**：

```typescript
private async _readPeerPubKeyWithRetry(): Promise<string | null> {
  const pubPath = path.join(this.config.curveDir, `${this.peerId}.pub`)
  let delay = 500
  for (let i = 0; i < 10; i++) {
    try {
      const content = fs.readFileSync(pubPath, 'utf-8').trim()
      if (content.length === 40) return content  // CURVE 公钥固定 40 字节 hex
    } catch { /* .pub 尚不存在 */ }
    await new Promise(r => setTimeout(r, delay))
    delay = Math.min(delay * 2, 5000)
  }
  return null  // 约 27.5s 后放弃
}
```

#### 2c: 当前 PerPeerWorker 主进程模式 vs fork 子进程

**短期**：保持 PerPeerWorker 在主进程内（setTimeout loop），仅改造 5-phase 和退避。
**长期**：当 1:1 Worker-Peer 稳定后，将 PerPeerWorker 搬迁到 fork 子进程中（`EventBusWorkerPool` 中的每个 Worker 子进程内部跑 PerPeerWorker 的 5-phase 逻辑）。

**搬迁后架构**：

```
主进程                          子进程 (Worker[node-b__43001])
┌──────────────────┐           ┌──────────────────────────────┐
│ Outbox LMDB      │  mmap     │ PerPeerWorker._tick()        │
│ └─ outbox-a.lmdb │ ◀──────── │ → Phase 1 refreshAcks        │
│ └─ outbox-b.lmdb │  ← mmap   │ → Phase 2 fillAndSend        │
│ └─ outbox-c.lmdb │           │ → Phase 3 backoff detection  │
│                  │           │ → Phase 4 key discovery       │
│ ROUTER socket    │           │ → Phase 5 housekeeping        │
│ (接收 ACK)       │  IPC ◀── │ → DEALER → tcp://peer:port    │
│                  │  ACK     │                                │
└──────────────────┘           └──────────────────────────────┘
```

搬迁后，主进程 ROUTER 收到 ACK 后写入 LMDB（`ackDB: ack:{eventId}:{peerPort}`），Worker 在 Phase 1 通过 mmap 读到。零 IPC 延迟。

---

### Phase 3: mTlsTransport + WorkerPool 双路径集成（2天）

#### 3a: 双路径路由逻辑

```
消息发送方 → 判断目标:
    如果是 Raft 协议消息（AppendEntries / RequestVote / InstallSnapshot）
        → mTlsTransport.sendTo(peerId, msg)
    如果是 EventStream 事件 / 心跳 / 成员变更
        → EventBus.send(peerId, msg) → WorkerPool → DEALER → ZMQ
```

在 `ConsensusProvider` 层做判断：

```typescript
// consensus-provider.ts
class ConsensusManager {
  private mTlsTransport: mTlsTransport
  private eventBus: EventBus
  private workerPool: EventBusWorkerPool
  
  async sendRaftMessage(peerId: string, msg: RaftMessage): Promise<void> {
    await this.mTlsTransport.sendTo(peerId, encode(msg))
  }
  
  async sendEventStream(peerId: string, msg: TransportMessage): Promise<void> {
    await this.eventBus.send(peerId, msg)
  }
}
```

#### 3b: 健康检查集成（R9 + mTLS + Raft）

```
三层健康检查:

Layer 1: mTlsTransport 空帧心跳 (5s)
  → 检测 TCP 连接是否存活
  → 断开触发指数退避重连

Layer 2: RaftCore 的 AppendEntries 心跳 (50ms)
  → 检测 Raft 层 Leader 是否可用
  → 选举超时触发新 Leader 选举

Layer 3: AppHeartbeatManager (1s ping)
  → 检测应用层分区
  → 冻结 Outbox 发送
  → 与 Outbox 失败率交叉确认
```

mTlsTransport 的健康检查（来自 Raft tcp design §3.9）：

```typescript
class PeerConnection {
  private lastRx = Date.now()
  private healthTimer: NodeJS.Timeout
  
  constructor(socket: tls.TLSSocket, pool: ConnectionPool) {
    this.healthTimer = setInterval(() => this._healthCheck(), 5000)
    socket.on('data', () => { this.lastRx = Date.now() })
  }
  
  private _healthCheck(): void {
    if (Date.now() - this.lastRx > 30000) {
      if (this.socket.writable) {
        this.socket.write(Buffer.alloc(4))  // empty heartbeat frame
      }
    }
  }
}
```

#### 3c: 证书分发集成（与 CURVE 共用公钥目录）

```
curveDir/ 目录内容（复用）:

ca.pem              ← mTLS CA 根证书（CertManager 首次生成）
node-a.crt          ← 节点 A 证书（CertManager 启动时生成）
node-a.key          ← 节点 A 私钥（CertManager 启动时生成）
node-a__43001.pub   ← 节点 A ZMQ CURVE 公钥（EventBus._initCurve 写入）
node-b.crt          ← 节点 B 证书（从 NAS 读取/扫描获得）
node-b__43001.pub   ← 节点 B CURVE 公钥
```

mTLS 和 CURVE 共享 `curveDir`：
- CURVE 使用 `*.pub` 文件
- mTLS 使用 `ca.pem` + `*.crt` + `*.key` 文件
- 两者互不冲突，共用相同的服务发现机制（`fs.readdirSync` + 文件名过滤）

---

### Phase 4: R9/R10 集成（1天）

#### 4a: R10 → WorkerPool 动态连接

```typescript
// AppMembershipManager.commitChange → 调用 WorkerPool
private async _commitChange(change: { add: string[]; remove: string[] }): Promise<void> {
  // 1. 广播 commit 消息
  const commitMsg = { type: 'membership-commit', members: this._proposedMembers }
  const data = { msgId: `membership-${Date.now()}`, ...commitMsg }
  // 使用 Outbox 广播：新成员需要先接收 commit 才能创建 Worker
  this.eventBus.broadcast(data)
  
  // 2. 更新 WorkerPool
  for (const nodeId of change.remove) {
    this.workerPool.onPeerLeft(nodeId)
  }
  for (const nodeId of change.add) {
    this.workerPool.onPeerJoined(nodeId)
  }
  
  // 3. 写入 CA 证书目录（新节点的 .pub 和 .crt）
  for (const nodeId of change.add) {
    // 对端应已在 curveDir 中留下文件和证书
    // 如果不在，需要在 R10 提案中先交换证书
  }
}
```

#### 4b: R9 → WorkerPool 冻结

```typescript
// AppHeartbeatManager.onMajorityChange(inMajority)
private _handleMajorityChange(inMajority: boolean): void {
  if (!inMajority) {
    // 失去 majority → 冻结所有 Outbox
    for (const peerId of this.workerPool.peerIds()) {
      this.workerPool.setFrozen(peerId, true)
    }
  } else {
    // 恢复 majority → 解冻
    for (const peerId of this.workerPool.peerIds()) {
      this.workerPool.setFrozen(peerId, false)
    }
  }
}
```

---

## 3. 时间线估计

| Phase | 内容 | 预计工作 | 总时间 |
|-------|------|---------|--------|
| **P0** | 状态检查 | 代码审查 | 1天 |
| **P1a** | CertManager（启动时证书） | 1天 | 2天 |
| **P1b** | TcpTransport → mTlsTransport | 2天 | 4天 |
| **P1c** | raft-logic / RaftCore 集成 | 1天 | 5天 |
| **P1d** | 证书脚本 + E2E 测试 | 1天 | 6天 |
| **P2a** | WorkerPool 1:1 映射 | 1.5天 | 7.5天 |
| **P2b** | PerPeerWorker 5-phase 增强 | 1.5天 | 9天 |
| **P2c** | fork 子进程搬迁（可选） | 2天 | 11天 |
| **P3a** | 双路径路由 | 0.5天 | 11.5天 |
| **P3b** | 健康检查集成 | 0.5天 | 12天 |
| **P3c** | 证书分发集成 | 0.5天 | 12.5天 |
| **P4a** | R10 → WorkerPool 动态连接 | 0.5天 | 13天 |
| **P4b** | R9 → WorkerPool 冻结 | 0.5天 | 13.5天 |

**建议并行策略**：
- 第 1-6 天：P1 全系列（mTLS）+ P0 并行（独立模块）
- 第 5-9 天：P2 全系列（WorkerPool 改造，与 P1 低耦合）
- 第 10-13.5 天：P3 + P4（集成验证，依赖 P1 和 P2 完成）

---

## 4. 不做的事项（明确排除）

| 事项 | 排除理由 |
|------|----------|
| 24h/timed CertRotator | 启动时生成即轮换，TLS 1.3 ECDHE 保证前向安全 |
| 60s CURVE key refresh (v3设计) | 同一理由 |
| 一致性 hash | 被 1:1 替代 |
| InMemoryTransport | 被 mTlsTransport 替代 |
| DNS 服务发现实现 | 基础设施责任；当前配置驱动即可 |
| 跨 DC mTLS | mTLS 仅用于同 DC Raft 消息；跨 DC 通过 EventBus ZMQ |
| 共享 ConnectionPool 跨 RaftGroup（Raft tcp design §8） | 当前单 group，未来需要时再设计 |
