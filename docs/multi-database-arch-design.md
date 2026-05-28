# 多数据库架构设计

> 综合 WorkerPool v2/v3、Raft TcpTransport（mTLS）、R9/R10 三份设计 + 当前项目代码
> 日期: 2026-05-28

---

## 1. 问题定义

### 1.1 当前架构

```
单数据库 (agentiX-graphvec):
  /data/agentiX/
    range-0/       ← RangeInstance(Raft group + OverGraph)
    range-1/
    ...

  一个 EventBus (ROUTER/DEALER + CURVE)
  一个 WorkerPool
  一个 TcpTransport (或 InMemoryTransport)
  一个 RaftCore (raft-core.ts)
```

**当前限制**:
- `ConsensusConfig` 是单实例的 — 一个节点只能有一个 `nodeId`、一个 `peers[]`、一个 `transportPort`
- `RaftCore` 只接受一个 `peers[]` 和一套选举/心跳定时器 — **一个 Raft Group**
- `DatabaseManager` 创建虚拟数据库时仅创建 `ShardManager` + `RangeInstance`，但这些 `RangeInstance` 的 consensus 层没有真正的跨节点通信（都 fallback 到 `StandaloneConsensus`）
- 无 mTLS 支持

### 1.2 目标架构

```
多数据库 (agentiX-graphvec):
  /data/orders/
    range-0/       ← RangeInstance(Raft group orders-0)
    range-1/       ← RangeInstance(Raft group orders-1)
  /data/inventory/
    range-0/       ← RangeInstance(Raft group inventory-0)

  一个全局 EventBus (ROUTER/DEALER + CURVE) — 应用层心跳/成员变更/事件同步
  一个全局 WorkerPool (1:1 Worker-Peer) — 应用层消息发送
  一个全局 TcpServer (mTLS) — Raft 协议消息的共享服务器
  N 个 Raft Group (每个 group 独立 RaftCore/RaftNode)
  一组共享的 TCP 连接 (连接池，按 peer 复用)
```

### 1.3 两层传输的关系（澄清）

```
应用层 (最终一致)                        共识层 (强一致)
┌──────────────────────────┐           ┌──────────────────────────┐
│ EventBus (ZMQ)           │           │ Raft 协议消息             │
│ ├─ Heartbeat (R9)        │           │ ├─ AppendEntries          │
│ ├─ 成员变更 (R10)        │           │ ├─ RequestVote           │
│ ├─ EventStream 同步       │           │ ├─ InstallSnapshot       │
│ └─ GraphEvent 分发         │           │ └─ PreVote               │
│                          │           │                          │
│ 加密: CURVE25519         │           │ 加密: TLS 1.3 (mTLS)     │
│ 传输: ZMQ ROUTER/DEALER  │           │ 传输: node:tls TCP       │
│ 持久化: Outbox LMDB      │           │ 可靠: Raft 协议自身      │
└──────────────────────────┘           └──────────────────────────┘
         ↑                                        ↑
    共享 WorkerPool                    共享 TcpServer + ConnectionPool
    (1:1 Worker-Peer)                  (所有 RaftGroup 共享 TCP 连接)
```

**关键原则**: 这两个传输层完全独立，服务于不同的数据路径。未来当 raft-logic WASM 就位后，Raft 协议消息通过 mTLS 传输，应用层事件仍然通过 ZMQ。

---

## 2. 总体架构

```
┌────────────────────────────────────────────────────────────────────────┐
│ 节点 A (hostname=node-a, routerPort=43001)                             │
│                                                                        │
│ ┌────────────────────────────────────────────────────────────────────┐ │
│ │ EndpointManager — 统一端点管理                                      │ │
│ │                                                                     │ │
│ │  1. 启动时生成 CURVE 密钥对 + mTLS 证书                             │ │
│ │  2. 写入 curveDir/:                                                   │ │
│ │     node-a__43001.pub   ← CURVE 公钥                                │ │
│ │     ca.pem              ← mTLS CA 根证书                              │ │
│ │     node-a.crt          ← mTLS 节点证书                              │ │
│ │     node-a.key          ← mTLS 节点私钥                              │ │
│ │  3. 扫描 curveDir/ 发现所有对端                                      │ │
│ │  4. 维护对端连接状态                                                  │ │
│ └────────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│ ┌─────────────────────────────┐  ┌──────────────────────────────────┐ │
│ │ DatabaseManager              │  │ 全局 TcpServer (mTLS)             │ │
│ │                              │  │  (仅一个 server 进程)             │ │
│ │ orders:                      │  │                                  │ │
│ │   range-0: RaftCore + OverGraph│  │  tls.createServer(...)           │ │
│ │   range-1: RaftCore + OverGraph│  │    port 50051                   │ │
│ │ inventory:                   │  │                                  │ │
│ │   range-0: RaftCore + OverGraph│  │ ┌─────────────────────────────┐ │ │
│ │                              │  │ │ ConnectionPool (全局共享)     │ │ │
│ │ 每个 RaftCore 通过           │  │ │  node-b: tls.TLSSocket        │ │ │
│ │ getConnectionPool() 获取     │  │ │  node-c: tls.TLSSocket        │ │ │
│ │ 共享的连接池                 │  │ │  ...                          │ │ │
│ └─────────────────────────────┘  │ └─────────────────────────────┘ │ │
│                                   └──────────────────────────────────┘ │
│                                                                        │
│ ┌────────────────────────────────────────────────────────────────────┐ │
│ │ Mux — 多路复用层                                                     │ │
│ │                                                                     │ │
│ │  发送: RaftCore → appendEntries(to, req)                            │ │
│ │                   → mux.send({ groupId, target, payload: Buffer })  │ │
│ │                   → ConnectionPool.get(target).write(encodedFrame)   │ │
│ │                                                                     │ │
│ │  接收: TcpServer._onConnection → socket.on('data')                  │ │
│ │                   → Mux.decode(frame) → { groupId, from, payload }  │ │
│ │                   → dispatch to RaftGroup[groupId].step(payload)     │ │
│ └────────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│ ┌────────────────────────────────────────────────────────────────────┐ │
│ │ EventBus (ZMQ ROUTER/DEALER) — 全局单例                             │ │
│ │                                                                     │ │
│ │  ROUTER: tcp://0.0.0.0:43001 ← 接收所有 peer 的应用层消息           │ │
│ │  WorkerPool: 1:1 映射                                               │ │
│ │    Worker[node-b__43001] → DEALER → node-b:43001                   │ │
│ │    Worker[node-c__43001] → DEALER → node-c:43001                   │ │
│ │                                                                     │ │
│ │  用于: 应用层心跳 / 成员变更广播 / EventStream 同步                  │ │
│ └────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 核心设计

### 3.1 EndpointManager — 统一端点管理

新文件: `src/consensus/endpoint-manager.ts`

**职责**: 将 CURVE 密钥（ZMQ）和 mTLS 证书（node:tls）的生成与服务发现统一到一个入口。

```typescript
interface EndpointConfig {
  nodeId: string
  curveDir: string                          // 共享公钥/证书目录
  routerPort: number                        // ZMQ ROUTER 端口
  raftPort?: number                         // mTLS TCP 端口（默认 50051）
}

interface DiscoveredPeer {
  nodeId: string
  /** ZMQ CURVE 公钥 */
  pubKey: string
  /** mTLS 证书（PEM） */
  cert?: string
  /** 连接地址 */
  host: string
  raftPort: number
  routerPort: number
}

class EndpointManager {
  // 启动时生成
  private curveKeyPair: { publicKey: string; secretKey: string }
  private tlsCert: { cert: string; key: string }
  
  async start(): Promise<void> {
    // 1. 检查/生成 CA 根证书
    this._ensureCA()
    
    // 2. 生成 CURVE 密钥对
    this.curveKeyPair = zmq.curveKeyPair()
    EventBus.writePublicKeyToDir(this.config.curveDir, ...)
    
    // 3. 生成 mTLS 证书（CA 签名）
    this.tlsCert = await this._generateNodeCert()
    fs.writeFileSync(`${this.config.curveDir}/${this.config.nodeId}.crt`, this.tlsCert.cert)
    fs.writeFileSync(`${this.config.curveDir}/${this.config.nodeId}.key`, this.tlsCert.key)
    
    // 4. 扫描 curveDir 发现所有对端
    this._discoverPeers()
    
    // 5. 启动 curveWatcher（fs.watch + 定期 re-scan）
    this._startWatcher()
  }
  
  onNewPeer(cb: (peer: DiscoveredPeer) => void): void
  onPeerRemoved(cb: (nodeId: string) => void): void
  onPeerCertChanged(cb: (nodeId: string, cert: string) => void): void
  
  getDiscoveredPeers(): DiscoveredPeer[]
  getCACert(): string
  getNodeCert(): { cert: string; key: string }
  getCurveKeyPair(): { publicKey: string; secretKey: string }
}
```

**`curveDir/` 目录内容**:

```
curveDir/
├── ca.pem                  ← CA 根证书（首次启动生成，之后复用）
├── node-a.crt              ← 节点 A mTLS 证书
├── node-a.key              ← 节点 A mTLS 私钥
├── node-a__43001.pub       ← 节点 A CURVE 公钥
├── node-b.crt              ← 节点 B mTLS 证书（自动发现）
├── node-b__43001.pub       ← 节点 B CURVE 公钥
├── node-c.crt              ← 节点 C mTLS 证书
└── node-c__43001.pub       ← 节点 C CURVE 公钥
```

### 3.2 全局 TcpServer + ConnectionPool（多数据库共享）

改造 `src/consensus/transport.ts` 中的 `TcpTransport`：

```
┌────────────────────────────────────────────────────────┐
│ TcpServer (全局单例，mTLS)                               │
│  tls.createServer({                                      │
│    cert, key, ca,                                        │
│    requestCert: true,                                   │
│    rejectUnauthorized: true,                            │
│  })                                                      │
│  port: 50051                                             │
│                                                         │
│  _onConnection(socket):                                  │
│    → 验证对端证书 CN                                 │
│    → 注册到 ConnectionPool                             │
│    → 启动 LenPrefixedReader                             │
│                                                         │
│  ConnectionPool (全局共享):                              │
│    node-b: tls.TLSSocket → { connected, idleSince }     │
│    node-c: tls.TLSSocket → { connected, idleSince }     │
│                                                         │
│    所有 RaftGroup 通过 getConnection(peerId) 获取同一 socket │
│    写入时通过 Mux 编码 layer(groupId + payload)           │
└────────────────────────────────────────────────────────┘
```

**关键变更**: 从 `TcpTransport` 每次构造一个独立 `net.Server`，改为全局共享的 `TcpServer` + `ConnectionPool`。

```typescript
// 单例式
class TcpServer {
  private static instance: TcpServer
  
  static getInstance(config: TcpServerConfig): TcpServer {
    if (!this.instance) {
      this.instance = new TcpServer(config)
    }
    return this.instance
  }
  
  /** 为指定 RaftGroup 创建通信句柄 */
  createHandle(groupId: string): GroupTransportHandle {
    return new GroupTransportHandle(this, groupId)
  }
}

// 每个 RaftGroup 持有轻量句柄
class GroupTransportHandle {
  constructor(private server: TcpServer, private groupId: string) {}
  
  async sendTo(peerId: string, msg: Uint8Array): Promise<boolean> {
    return this.server.sendTo(this.groupId, peerId, msg)
  }
  
  setMessageHandler(handler: (from: string, msg: Uint8Array) => void): void {
    this.server.registerHandler(this.groupId, handler)
  }
}
```

### 3.3 Mux — 多路复用层

新文件: `src/consensus/transport-mux.ts`

**协议帧格式**:

```
TCP Stream (共享连接):

┌─ 4-byte len ─┬─ groupId (UTF-8) ─┬─ from (UTF-8) ─┬─ JSON payload ─┐
│  00 00 XX XX  │   "orders"         │   "node-2"       │{"msgType":8,...}│
└──────────────┴────────────────────┴─────────────────┴────────────────┘

心跳帧:
  ┌─ 4-byte len = 0 ─┐
```

```typescript
interface MuxFrame {
  groupId: string      // RaftGroup 标识，如 "orders-range-0"
  from: string         // 发送方 nodeId
  payload: Buffer      // 序列化的 RaftMessage JSON
}

class MuxCodec {
  /** 编码: MuxFrame → Buffer (TCP 帧) */
  static encode(frame: MuxFrame): Buffer {
    const groupBuf = Buffer.from(frame.groupId, 'utf-8')
    const fromBuf = Buffer.from(frame.from, 'utf-8')
    const payloadBuf = frame.payload
    
    // 4-byte totalLength + groupLength(2) + fromLength(2) + group + from + payload
    const header = Buffer.alloc(8)
    const totalLen = 4 + groupBuf.length + fromBuf.length + payloadBuf.length
    header.writeUInt32BE(totalLen, 0)    // 前 4 字节: total length
    header.writeUInt16BE(groupBuf.length, 4) // 2 字节: groupId 长度
    header.writeUInt16BE(fromBuf.length, 6)  // 2 字节: from 长度
    
    return Buffer.concat([header, groupBuf, fromBuf, payloadBuf])
  }
  
  /** 解码: Buffer → MuxFrame */
  static decode(buffer: Buffer): MuxFrame {
    const groupLen = buffer.readUInt16BE(4)
    const fromLen = buffer.readUInt16BE(6)
    let offset = 8
    const groupId = buffer.toString('utf-8', offset, offset + groupLen)
    offset += groupLen
    const from = buffer.toString('utf-8', offset, offset + fromLen)
    offset += fromLen
    const payload = buffer.subarray(offset)
    return { groupId, from, payload }
  }
}
```

**Mux 分发**:

```typescript
class Mux {
  private handlers = new Map<string, (from: string, msg: Buffer) => void>()
  
  /** RaftGroup 注册消息处理器 */
  registerGroup(groupId: string, handler: (from: string, msg: Buffer) => void): void {
    this.handlers.set(groupId, handler)
  }
  
  unregisterGroup(groupId: string): void {
    this.handlers.delete(groupId)
  }
  
  /** 收到 TCP 帧后的分发入口 */
  onFrameReceived(buffer: Buffer): void {
    const frame = MuxCodec.decode(buffer)
    const handler = this.handlers.get(frame.groupId)
    if (handler) {
      handler(frame.from, frame.payload)
    } else {
      logger.warn(`No handler for group ${frame.groupId}`)
    }
  }
}
```

### 3.4 RaftGroup 管理

新文件: `src/consensus/raft-group-manager.ts`

**关系**: 一个数据库 = N 个 Range = N 个 RaftGroup

```
DatabaseManager
├── database("orders")
│   ├── Range("orders-range-0") → RaftCore(config: nodeId="orders-0", peers=[...])
│   └── Range("orders-range-1") → RaftCore(config: nodeId="orders-1", peers=[...])
│
├── database("inventory")
│   ├── Range("inventory-range-0") → RaftCore(config: nodeId="inventory-0", peers=[...])
│   └── Range("inventory-range-1") → RaftCore(config: nodeId="inventory-1", peers=[...])
│
└── 底层共享资源:
    ├── TcpServer (mTLS) × 1  ← 全局单例
    ├── ConnectionPool × 1   ← 全局单例
    ├── Mux × 1              ← 全局单例
    ├── EndpointManager × 1  ← 全局单例
    ├── EventBus × 1         ← 全局单例
    └── WorkerPool × 1       ← 全局单例
```

```typescript
interface RaftGroupConfig {
  groupId: string              // "orders-range-0"
  nodeId: string               // "orders-0" (Raft 节点唯一标识)
  peers: string[]              // ["orders-1", "orders-2"]
  walPath: string              // 独立 WAL 文件路径
  peerEndpoints: Map<string, PeerEndpoint>  // 对端地址 { host, raftPort }
  transportType: 'mTLS' | 'in-memory'
}

class RaftGroupManager {
  private groups = new Map<string, RaftGroupInstance>()
  private mux: Mux
  private tcpServer: TcpServer
  
  /**
   * 为单个 Range 创建 RaftGroup。
   * 所有 RaftGroup 共享底层 TcpServer + ConnectionPool + Mux。
   */
  async createGroup(config: RaftGroupConfig): Promise<RaftGroupInstance> {
    const groupId = config.groupId
    
    if (this.groups.has(groupId)) {
      return this.groups.get(groupId)!
    }
    
    // 创建共享的连接池句柄
    const handle = this.tcpServer.createHandle(groupId)
    
    // 创建 RaftCore
    const raft = new RaftCore({
      nodeId: config.nodeId,
      peers: config.peers,
      walPath: config.walPath,
      transport: handle,  // 传入轻量句柄而非独立 TcpTransport
    })
    
    // 注册到 Mux（接收来自共享连接的 Raft 消息）
    this.mux.registerGroup(groupId, (from: string, msg: Buffer) => {
      raft.onMessage(from, msg)
    })
    
    const instance: RaftGroupInstance = {
      groupId,
      raft,
      handle,
      started: false,
    }
    
    this.groups.set(groupId, instance)
    return instance
  }
  
  async startGroup(groupId: string): Promise<void> {
    const g = this.groups.get(groupId)
    if (!g || g.started) return
    await g.raft.start()
    g.started = true
  }
  
  async removeGroup(groupId: string): Promise<void> {
    const g = this.groups.get(groupId)
    if (!g) return
    await g.raft.stop()
    this.mux.unregisterGroup(groupId)
    this.groups.delete(groupId)
  }
}
```

### 3.5 RaftCore 的 Transport 适配

当前 `RaftCore` 使用 `Transport` 接口（`appendEntries` / `requestVote` 等 RPC 方法）。`GroupTransportHandle` 需要实现这些 RPC：

```typescript
class GroupTransportHandle implements Transport {
  private mux: Mux
  private connectionPool: ConnectionPool
  private groupId: string
  private nodeId: string
  private handler: ((from: string, msg: RaftMessage) => void) | null = null
  
  /** 保有请求映射：msgId → { resolve, reject, timer } */
  private pendingResponses = new Map<string, PendingResponse>()
  
  // ── RPC 方法实现 ──
  
  async appendEntries(to: string, req: AppendEntriesRequest): Promise<AppendEntriesResponse> {
    const msg: RaftMessage = {
      type: 'AppendEntries',
      term: req.term,
      from: this.nodeId,
      to,
      data: req,
    }
    return this._sendAndWait(to, msg)
  }
  
  async requestVote(to: string, req: RequestVoteRequest): Promise<RequestVoteResponse> {
    const msg: RaftMessage = {
      type: 'RequestVote',
      term: req.term,
      from: this.nodeId,
      to,
      data: req,
    }
    return this._sendAndWait(to, msg)
  }
  
  // ── 底层发送 + ACK 匹配 ──
  
  private async _sendAndWait(to: string, msg: RaftMessage): Promise<any> {
    const msgId = crypto.randomUUID()
    const payload = Buffer.from(MuxCodec.encode({
      groupId: this.groupId,
      from: this.nodeId,
      payload: Buffer.from(JSON.stringify({ ...msg, msgId })),
    }))
    
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(msgId)
        reject(new Error(`RPC timeout to ${to}: ${msg.type}`))
      }, 5000)
      
      this.pendingResponses.set(msgId, { resolve, reject, timer })
      
      const socket = this.connectionPool.get(to)
      if (!socket || socket.destroyed) {
        clearTimeout(timer)
        this.pendingResponses.delete(msgId)
        reject(new Error(`No connection to ${to}`))
        return
      }
      
      socket.write(payload)
    })
  }
  
  /** 收到响应（来自 Mux 分发） */
  onResponse(msgId: string, response: any): void {
    const pending = this.pendingResponses.get(msgId)
    if (pending) {
      clearTimeout(pending.timer)
      this.pendingResponses.delete(msgId)
      pending.resolve(response)
    }
  }
  
  onMessage(handler: (from: string, msg: RaftMessage) => void): void {
    this.handler = handler
    // 注册到 Mux 分发链接
    this.mux.registerGroup(this.groupId, (from: string, payload: Buffer) => {
      const parsed = JSON.parse(payload.toString('utf-8'))
      if (parsed.msgId) {
        // 判断是请求还是响应
        if (parsed.type.endsWith('Response')) {
          this.onResponse(parsed.msgId, parsed)
        } else {
          this.handler?.(from, parsed)
        }
      } else {
        this.handler?.(from, parsed)
      }
    })
  }
}
```

### 3.6 从 DatabaseManager 到 RaftGroup 的连接

```typescript
// database-manager.ts 改造

class DatabaseManager {
  private databases = new Map<string, DatabaseInstance>()
  private raftGroupManager: RaftGroupManager
  
  constructor(options: {
    baseDir: string
    raftGroupManager: RaftGroupManager
  }) {
    this.raftGroupManager = options.raftGroupManager
  }
  
  async createDatabase(name: string, config: DatabaseConfig): Promise<DatabaseInstance> {
    // 1. 创建物理目录和 ShardMap（现有逻辑）
    // ...
    
    // 2. 为每个 Range 创建 RaftGroup
    for (let i = 0; i < shardCount; i++) {
      const groupId = `${name}-range-${i}`
      const nodeId = `${name}-${i}`
      const rangeDir = path.join(dbDir, `range-${i}`)
      
      await this.raftGroupManager.createGroup({
        groupId,
        nodeId,
        peers: config.peers?.map(p => `${name}-${i}`),  // 对应 peer 的 nodeId
        walPath: path.join(rangeDir, 'raft.wal'),
        peerEndpoints: this._buildPeerEndpoints(config.peers, config.raftPort),
        transportType: config.raftPort ? 'mTLS' : 'in-memory',
      })
      
      await this.raftGroupManager.startGroup(groupId)
    }
    
    // 3. 创建 RangeInstance 注入共识提供者
    // ...
  }
}
```

### 3.7 健康检查与 R9/R10 在多数据库下的映射

#### R9 分区检测 — 数据库级别

```typescript
// 每个 RaftGroup 独立判断 inMajority()
class RaftGroupInstance {
  get isHealthy(): boolean {
    return this.raft.inMajority()
  }
}

// 但 Outbox 冻结是全局的（所有 peer 的 Worker 统一行为）
class AppHeartbeatManager {
  private groupHealth = new Map<string, boolean>()
  
  onGroupHealthChange(groupId: string, healthy: boolean): void {
    this.groupHealth.set(groupId, healthy)
    
    // 只要有一个 RaftGroup 不在 majority → 冻结全局 Outbox
    // 因为 Outbox 发送的应用层事件（EventStream）是跨所有数据库的
    const anyDegraded = Array.from(this.groupHealth.values()).some(h => !h)
    if (anyDegraded && !this._frozen) {
      this._freezeAll()
    } else if (!anyDegraded && this._frozen) {
      this._unfreezeAll()
    }
  }
}
```

**设计说明**: 应用层 Outbox 是所有数据库共用的（EventBus 就一个），所以分区的冻结是全局的。Raft 协议层每个 RaftGroup 独立检测 majority 健康，但任意一个 RaftGroup 不健康都可能表明节点整体网络分区。

#### R10 成员变更 — RaftGroup 级别

```typescript
// 每个 RaftGroup 独立进行成员变更
// addPeer / removePeer 需要在对应 RaftGroup 中执行

class RaftGroupManager {
  async addPeerToGroup(groupId: string, newPeerId: string): Promise<void> {
    const group = this.groups.get(groupId)
    if (!group) throw new Error(`Group ${groupId} not found`)
    await group.raft.addPeer(newPeerId)
  }
  
  // 多数据库添加节点 = 在所有 RaftGroup 上执行 addPeer
  async addNodeToCluster(newNodeId: string): Promise<void> {
    for (const [groupId, group] of this.groups) {
      await group.raft.addPeer(newNodeId)
    }
  }
}
```

### 3.8 WorkerPool + EventBus（与多数据库的关系）

WorkerPool 和 EventBus 是**机器级别**的单例，不随数据库数量变化：

```
EventBus (机器级别)
├── ROUTER: tcp://0.0.0.0:43001
├── WorkerPool (1:1 Worker-Peer)
│   ├── Worker[node-b__43001] → peer B
│   └── Worker[node-c__43001] → peer C
│
├── 用于所有数据库的应用层消息:
│   ├── AppHeartbeatManager.sendPings()
│   ├── AppMembershipManager.broadcast()
│   └── EventStream.sync()
│
└── per-peer Outbox (LMDB)
    ├── outbox-node-b__43001.lmdb
    └── outbox-node-c__43001.lmdb
```

多数据库不会影响 WorkerPool 的工作量——Worker 发往 peer 的 ZMQ DEALER 是同一套，EventBus send() 是相同的调用路径。消息负载中携带 `dbName` 字段即可区分。

---

## 4. 启动流程

```
节点 A 启动:

1. EndpointManager.start()
   ├── 检查 curveDir/ca.pem → 不存在则生成
   ├── 生成 CURVE 密钥对 → 写入 node-a__43001.pub
   ├── 生成 mTLS 证书 → 写入 node-a.crt, node-a.key
   ├── 扫描 curveDir/ → 发现 node-b.*, node-c.*
   ├── 通知 onNewPeer: node-b, node-c
   └── 启动 curveWatcher

2. TcpServer.start()
   ├── tls.createServer({ cert, key, ca, requestCert, rejectUnauthorized })
   ├── bind(50051)
   └── _onConnection → ConnectionPool.register(peerId, socket)

3. ConnectionPool (由 TcpServer 构造)
   ├── 待对端 TcpServer 启动后建立连接
   ├── 主动 connectTo(node-b, host, port)
   └── 被动连接从 _onConnection 注册

4. Mux (由 TcpServer 构造)
   ├── onFrameReceived → decode → dispatch by groupId
   └── 初始无 handler，等 RaftGroup 注册

5. EventBus.start()
   ├── initCurve → ROUTER bind(43001)
   ├── DEALER connect → node-b:43001, node-c:43001
   ├── WorkerPool start(1:1)
   ├── AppHeartbeatManager.start()
   └── AppMembershipManager.init()

6. DatabaseManager.createDatabase("orders")
   ├── RaftGroupManager.createGroup("orders-range-0")
   │   ├── 获取 GroupTransportHandle(共享 ConnectionPool)
   │   ├── 创建 RaftCore(config, transport=handle)
   │   └── 注册 handler 到 Mux
   ├── RaftGroupManager.createGroup("orders-range-1")
   ├── RangeInstance(consensus=RaftCore)
   └── ShardManager.addRange("orders-range-0", range)

7. (可选) DatabaseManager.createDatabase("inventory")
   └── 同步骤 6，创建另一组 RaftGroup
```

---

## 5. 当前代码的改造点总表

| 文件 | 当前 | 改后 | 影响范围 |
|------|------|------|---------|
| **新增** `src/consensus/endpoint-manager.ts` | — | CURVE + mTLS 统一生成 + 服务发现 | 新文件 |
| **新增** `src/consensus/transport-mux.ts` | — | MuxCodec + Mux 多路复用 | 新文件 |
| **新增** `src/consensus/raft-group-manager.ts` | — | RaftGroup 生命周期管理 + 共享资源 | 新文件 |
| **改造** `transport.ts` | TcpTransport 独立 | 改为 TcpServer 全局单例 + ConnectionPool | 核心改造 |
| **改造** `raft-core.ts` | Transport 接口通过单个 socket | 接入 GroupTransportHandle（RPC + Mux） | 接口适配 |
| **改造** `raft-logic-consensus.ts` | 每个实例一个 TcpTransport | 用 GroupTransportHandle | 轻量改造 |
| **改造** `database-manager.ts` | 只创建 ShardMap/Range | 同时创建 RaftGroup + 注入共识 | 中等改造 |
| **改造** `range-instance.ts` | StandaloneConsensus fallback | 注入 RaftCore 作为 ConsensusProvider | 构造参数 |
| **改造** `event-bus.ts` | 无变化 | 全局单例，不受多数据库影响 | 无 |
| **改造** `event-bus-worker-pool.ts` | 一致性 hash M:N | 1:1 Worker-Peer | 中等改造 |
| **改造** `outbox-replication.ts` | 主进程内 PerPeerWorker | 5-phase 增强 + 指数退避 | 中等改造 |
| **新增** `scripts/gen-raft-certs.sh` | — | 证书生成脚本（测试/CI） | 新文件 |

---

## 6. 安全架构

```
┌──────────────┐   Raft 协议消息 (node:net TCP)
│ 节点 A        │
│              │─── 加密: TLS 1.3 (mTLS)
│ RaftCore     │─── 认证: X.509 证书 (CN=raft-node-A)
│              │─── 完整性: TLS MAC 验证
│ EventBus     │─── 加密: Curve25519 (ZMQ CURVE)
│ (ZMQ)        │─── 认证: CURVE 密钥对
└──────────────┘   完整性: ZMQ 内置

密钥生命周期:
  1. 节点启动时:
     - 生成 CURVE 密钥对 ← 启动时一次
     - 生成 mTLS 证书 (CA 签名) ← 启动时一次
  2. 运行期间:
     - 不主动轮换
     - 证书有效期 10 年 (3650 天)
     - DEALER 重建时重新生成 CURVE 密钥对 (v3 设计)
  3. 证书检查:
     - mTLS: 每次连接 TLS 握手时由 TLS 协议自动验证
     - CURVE: 每次重建 DEALER 时读取新 .pub 验证
```

**多数据库的安全边界**:
- 所有 RaftGroup 共享相同的 mTLS 证书（同一节点身份）
- 安全边界在节点级别，不在 RaftGroup 级别
- 如果未来需要数据库级别隔离（租户隔离），可以在 Mux 帧中加租户字段，或为特权数据库使用独立的 TcpServer 端口

---

## 7. 测试策略

### 7.1 单元测试

| 测试 | 范围 | 方法 |
|------|------|------|
| MuxCodec 编解码 | `transport-mux.ts` | 编码后再解码验证一致性 |
| Mux 多 group 分发 | `transport-mux.ts` | 注册多个 handler，验证消息路由正确 |
| GroupTransportHandle RPC | `transport.ts` | Mock ConnectionPool，验证请求/响应匹配 |
| EndpointManager 服务发现 | `endpoint-manager.ts` | Mock curveDir，验证 .pub/.crt 扫描逻辑 |
| RaftGroupManager 生命周期 | `raft-group-manager.ts` | 创建/启动/停止/删除组 |

### 7.2 集成测试

| 测试 | 方法 |
|------|------|
| 单机多数据库 | 2 个数据库 × 1 range，验证 TcpServer 单实例共享 |
| 多 group 消息隔离 | A→B 发送 2 group 消息，验证 Mux 分发正确 |
| mTLS 连接 | 3 节点 fork，证书验证，E2E 通信 |
| 数据库+WorkderPool 共存 | 验证 EventBus 和 TcpServer 不互相干扰 |

### 7.3 E2E 测试

```
单机 fork 3 个进程 (node-A, node-B, node-C):

1. 每个进程:
   - EndpointManager.start() → 生成证书
   - TcpServer.start() → bind(50051 + index)
   - EventBus.start() → ROUTER bind(4300X)
   - DatabaseManager.createDatabase("orders", { peers: [B,C], shards: 2 })
