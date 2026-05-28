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

---

## 8. 删除数据库（三阶段标志位 + 冷静期 + GC）

### 8.1 问题定义

删除一个分布式数据库（含所有 RaftGroup）在单机是 trivial 的（`rm -rf`），但在多节点环境下面临：

- **不一致性**: A 删了数据库，B 不知道，继续发送 AppendEntries → 浪费日志 + WARN
- **残留数据**: 同一批 RaftGroup 中某个节点宕机，恢复后发现 peers 已不承认这个 group
- **误操作风险**: 删了就不可逆

### 8.2 三阶段流程总览

```
                 时间线 ──────────────────────────────────────────────►

  Phase 0               Phase 1               Phase 2               Phase 3
  ╔═══════════════╗    ╔═══════════════╗    ╔══════════════════╗    ╔═══════════════════╗
  ║ proposeDelete  ║    ║ Tombstone     ║    ║ Grace Period     ║    ║ GC Cleanup       ║
  ║ (R10 广播)     ║──►║ 写入本地      ║──►║ 可配置等待       ║──►║ 物理删除         ║
  ║                ║    ║ (标记删除)    ║    ║ (默认 1h)        ║    ║ (不可逆)         ║
  ╚═══════════════╝    ╚═══════════════╝    ╚══════════════════╝    ╚═══════════════════╝
                                                      │
                                                      ├─ 可回滚 (remove tombstone)
                                                      │   → 恢复为活动数据库
                                                      │   → 需通知所有 peer 恢复
                                                      └─ 可观察状态: "deleting"
```

### 8.3 核心数据结构

#### 墓碑文件 `tombstone.json`

位于数据库根目录（如 `/data/orders/.tombstone.json`），是 GC 的判断依据。

```typescript
interface Tombstone {
  /** 数据库名 (group 粒度的 tombstone) */
  database: string
  
  /** 本节点的删除请求发起时间 (ISO-8601) */
  requestedAt: string
  
  /** 冷静期时长 (秒) */
  gracePeriodSeconds: number
  
  /** GC 最早可执行时间 = requestedAt + gracePeriod */
  gcEarliestAt: string
  
  /** 当前状态 */
  phase: 'proposing' | 'tombstone-committed' | 'gc-ready' | 'gc-complete'
  
  /**
   * 已确认 tombstone 的节点列表。
   * 只有 >= 多数派节点确认后，本地才能推进到 gc-ready。
   */
  ackNodes: string[]
  
  /** 数据库所属的所有 RaftGroup ID 列表 */
  groupIds: string[]
  
  /** 如果是误操作回滚，记录恢复时间 */
  restoredAt?: string
}
```

#### 内存状态

```typescript
interface DatabaseInstanceState {
  status: 'active' | 'deleting' | 'deleted'
  tombstone?: Tombstone
  gcTimer?: NodeJS.Timeout          // 冷静期计时器
  activeClients: Set<string>        // 活跃连接引用（阻止 GC）
}
```

### 8.4 Phase 0 — 发起删除（R10 广播）

```typescript
class DatabaseManager {
  /**
   * 发起数据库删除。
   * 重用现有的 AppMembershipManager 广播机制。
   */
  async deleteDatabase(name: string, options?: {
    gracePeriodSeconds?: number  // 默认 3600 (1 小时)
  }): Promise<void> {
    const db = this.databases.get(name)
    if (!db) throw new Error(`Database '${name}' not found`)
    if (db.status !== 'active') throw new Error(`Database '${name}' already deleting`)
    
    const gracePeriod = options?.gracePeriodSeconds ?? 3600
    const now = new Date().toISOString()
    
    // 本地初始化 tombstone
    const tombstone: Tombstone = {
      database: name,
      requestedAt: now,
      gracePeriodSeconds: gracePeriod,
      gcEarliestAt: new Date(Date.now() + gracePeriod * 1000).toISOString(),
      phase: 'proposing',
      ackNodes: [this.nodeId],
      groupIds: db.ranges.map(r => r.groupId),
    }
    
    // 写入本地墓碑目录
    await this._writeTombstone(name, tombstone)
    
    // 切换状态
    db.status = 'deleting'
    
    // 通过 R10 AppMembershipManager 广播删除提案
    await this.membershipManager.proposeChange({
      type: 'delete-database',
      database: name,
      tombstone,  // 完整墓碑信息，各节点写入本地
    })
    
    // !!! 注意: proposeChange 返回时只代表本地提案已发出
    // Phase 1 的回调在 onMembershipChange 中处理
  }
}
```

### 8.5 Phase 1 — Tombstone 提交（R10 commit 回调）

`AppMembershipManager.onMembershipChange()` 收到 commit 回调后，各节点独立写入墓碑并开始计时：

```typescript
class DatabaseManager {
  /**
   * 当 R10 broadcast.commit 返回时由 AppMembershipManager 调用。
   * 此回调在集群的所有节点上执行。
   */
  async onDatabaseDeleteCommit(proposal: DeleteDatabaseProposal): Promise<void> {
    const { database, tombstone } = proposal
    
    // 1. 写入本地墓碑（可能覆盖 Phase 0 已写的临时版本）
    await this._writeTombstone(database, {
      ...tombstone,
      phase: 'tombstone-committed',
    })
    
    // 2. 更新状态
    const db = this.databases.get(database)
    if (db) {
      db.status = 'deleting'
      db.tombstone = tombstone
    }
    
    // 3. 启动冷静期计时器
    this._startGraceTimer(database, tombstone)
  }
}
```

### 8.6 Phase 2 — 冷静期

```typescript
class DatabaseManager {
  private _startGraceTimer(database: string, tombstone: Tombstone): void {
    const db = this.databases.get(database)
    if (!db) return
    
    const graceMs = tombstone.gracePeriodSeconds * 1000
    const elapsed = Date.now() - new Date(tombstone.requestedAt).getTime()
    const remaining = Math.max(0, graceMs - elapsed)
    
    db.gcTimer = setTimeout(() => {
      this._gcDatabase(database)
    }, remaining)
    
    // 冷静期内允许回滚
  }
  
  /**
   * 冷静期内回滚删除（移除墓碑，恢复数据库）。
   * 仅在 status === 'deleting' 时有效。
   */
  async restoreDatabase(name: string): Promise<void> {
    const db = this.databases.get(name)
    if (!db) throw new Error(`Database '${name}' not found`)
    if (db.status !== 'deleting') throw new Error(`Database '${name}' not in deleting state`)
    
    // 1. 清除墓碑
    await this._removeTombstone(name)
    
    // 2. 取消 GC 计时器
    if (db.gcTimer) {
      clearTimeout(db.gcTimer)
      db.gcTimer = undefined
    }
    
    // 3. 恢复状态
    db.status = 'active'
    db.tombstone = undefined
    
    // 4. 恢复 Mux handler（如果之前已注销则重新注册）
    for (const range of db.ranges) {
      this.mux.registerGroup(range.groupId, range.messageHandler)
    }
    
    // 5. 广播回滚通知（通知其他节点也恢复）
    await this.membershipManager.proposeChange({
      type: 'restore-database',
      database: name,
    })
  }
}
```

**冷静期内，已标记删除的数据库对外行为**：

| 操作 | 行为 |
|------|------|
| 客户端查询/写入 | ✅ 正常响应（数据还在）|
| Raft AppendEntries | ✅ 正常处理 |
| 分区检测 (R9) | ✅ 正常工作 |
| Outbox 发送 | ✅ 正常 |
| 重新发起删除 | ❌ 拒绝（已处于 deleting）|
| 列出数据库 | 🟡 标记为 `(deleting)` |
| GC 触发 | ❌ 未触发 |

### 8.7 Phase 3 — GC 物理清除

```typescript
class DatabaseManager {
  private async _gcDatabase(name: string): Promise<void> {
    const db = this.databases.get(name)
    if (!db || db.status !== 'deleting') return
    
    logger.info(`[GC] Starting cleanup for database '${name}'`)
    
    // 0. 检查活跃客户端
    if (db.activeClients.size > 0) {
      logger.warn(`[GC] Database '${name}' has ${db.activeClients.size} active clients, deferring GC`)
      // 重新调度（30 分钟后重试），防止无限重试
      setTimeout(() => this._gcDatabase(name), 30 * 60_000).unref()
      return
    }
    
    // 1. 停止所有 RaftGroup
    for (const range of db.ranges) {
      try {
        await this.raftGroupManager.removeGroup(range.groupId)
        logger.info(`[GC] Group '${range.groupId}' stopped`)
      } catch (err) {
        logger.error(`[GC] Failed to stop group '${range.groupId}': ${err}`)
        // 继续执行，不阻塞 GC
      }
    }
    
    // 2. 注销所有 Mux handler
    for (const range of db.ranges) {
      this.mux.unregisterGroup(range.groupId)
    }
    
    // 3. 物理删除文件
    try {
      const dbDir = this._databaseDir(name)
      await fs.promises.rm(dbDir, { recursive: true, force: true })
      logger.info(`[GC] Database directory '${dbDir}' removed`)
    } catch (err) {
      logger.error(`[GC] Failed to remove directory for '${name}': ${err}`)
      // 允许手动清理
    }
    
    // 4. 更新墓碑阶段
    const tombstonePath = this._tombstonePath(name)
    try {
      const current = JSON.parse(await fs.promises.readFile(tombstonePath, 'utf-8'))
      current.phase = 'gc-complete'
      await fs.promises.writeFile(tombstonePath, JSON.stringify(current, null, 2))
    } catch { /* tombstone 已随目录删除 */ }
    
    // 5. 清除内存状态
    this.databases.delete(name)
    
    logger.info(`[GC] Database '${name}' cleanup complete`)
  }
}
```

### 8.8 启动时恢复

```typescript
class DatabaseManager {
  async loadExistingDatabases(): Promise<void> {
    const entries = await fs.promises.readdir(this.baseDir, { withFileTypes: true })
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dbDir = path.join(this.baseDir, entry.name)
      const tombstonePath = path.join(dbDir, '.tombstone.json')
      
      let tombstone: Tombstone | null = null
      try {
        tombstone = JSON.parse(await fs.promises.readFile(tombstonePath, 'utf-8'))
      } catch { /* 无墓碑文件，正常数据库 */ }
      
      if (tombstone) {
        if (tombstone.phase === 'gc-complete') {
          // 上一个生命周期 GC 已完成但 tombstone 文件残留
          await fs.promises.rm(dbDir, { recursive: true, force: true })
          continue
        }
        
        // 恢复 deleting 状态
        const db = this._createDatabaseInstance(entry.name, dbDir)
        db.status = 'deleting'
        db.tombstone = tombstone
        
        // 重新计算冷静期剩余时间
        this._resumeGraceTimer(entry.name, tombstone)
        this.databases.set(entry.name, db)
        logger.info(`[Start] Database '${entry.name}' resumed in 'deleting' state`)
      } else {
        // 正常数据库
        const db = await this._loadDatabase(entry.name, dbDir)
        db.status = 'active'
        this.databases.set(entry.name, db)
        logger.info(`[Start] Database '${entry.name}' loaded (active)`)
      }
    }
  }
  
  private _resumeGraceTimer(database: string, tombstone: Tombstone): void {
    const now = Date.now()
    const gcTime = new Date(tombstone.gcEarliestAt).getTime()
    const remaining = Math.max(0, gcTime - now)
    
    if (remaining <= 0) {
      // 冷静期已过，立即 GC
      logger.info(`[Start] Grace period already elapsed for '${database}', starting GC`)
      // 在下一个 tick 执行（不阻塞启动流程）
      setImmediate(() => this._gcDatabase(database))
    } else {
      // 继续等待
      const db = this.databases.get(database)
      if (db) {
        db.gcTimer = setTimeout(() => this._gcDatabase(database), remaining)
        logger.info(`[Start] Grace timer for '${database}' resumes in ${Math.round(remaining / 1000)}s`)
      }
    }
  }
}
```

### 8.9 错误场景与容错

| 错误场景 | 行为 | 恢复 |
|----------|------|------|
| **Phase 1 commit 时节点宕机** | 启动时检测 tombstone（phase=proposing），如果已过 GC 时间直接 GC，否则继续等待 | 自动 |
| **冷静期内节点宕机重启** | `_resumeGraceTimer` 重新计算剩余时间 | 自动 |
| **GC 阶段节点宕机** | 启动时检测 tombstone（phase=tombstone-committed 或 gc-ready），重新执行 GC | 自动 |
| **GC 文件删除失败（权限/磁盘坏道）** | log error，继续，不阻塞 | 手动 `rm -rf` 后重启 |
| **冷静期内快照后误回滚** | restoreDatabase() + 广播通知所有 peer | 手动触发 |
| **多数派 tombstone 未达成（部分节点永久宕机）** | 冷静期过期后本地仍可 GC（自保行为） | 自动，但不等同集群状态 |

**majority tombstone vs 本地 GC**: 设计上，Phase 1 的 R10 commit 本身就是 majority 确认。一旦 commit 回调触发，说明集群中的多数派已收到删除通知。此时即使剩余节点永久宕机，存活节点可以安全地各自 GC——因为 R10 commit 是分布式共识，多数派同意的操作视为有效。

### 8.10 删除状态查看

```typescript
class DatabaseManager {
  /**
   * 列出所有数据库，包括正在删除的。
   */
  listDatabases(): DatabaseInfo[] {
    const result: DatabaseInfo[] = []
    
    for (const [name, db] of this.databases) {
      result.push({
        name,
        status: db.status,
        rangeCount: db.ranges.length,
        groupIds: db.ranges.map(r => r.groupId),
        tombstone: db.tombstone
          ? {
              requestedAt: db.tombstone.requestedAt,
              phase: db.tombstone.phase,
              gcEarliestAt: db.tombstone.gcEarliestAt,
              remainingSeconds: db.tombstone.gcEarliestAt
                ? Math.max(0, Math.round(
                    (new Date(db.tombstone.gcEarliestAt).getTime() - Date.now()) / 1000
                  ))
                : undefined,
            }
          : undefined,
      })
    }
    
    return result
  }
}
```

示例输出:

```
> db.list()
[
  { name: "orders",     status: "active",   groups: 2 },
  { name: "inventory",  status: "active",   groups: 1 },
  { name: "archive",    status: "deleting", groups: 4,
    tombstone: { phase: "tombstone-committed",
                 gcEarliestAt: "2026-05-28T10:19:00Z",
                 remainingSeconds: 2347 } }
]
```

---

## 9. 执行计划

### 9.1 阶段划分

#### Phase A — 共享基础设施（预估 4-6 天）

**目标**: 建立 TcpServer 单例 + ConnectionPool + Mux 多路复用

| 步骤 | 文件 | 工作内容 | 测试方法 |
|------|------|---------|---------|
| A1 | `src/consensus/endpoint-manager.ts` (新) | CURVE 密钥 + mTLS 证书统一管理；curveDir 扫描发现；curveWatcher | 单元测试：Mock fs，验证生成/发现/通知 |
| A2 | `src/consensus/transport-mux.ts` (新) | MuxCodec 编解码 + Mux 分发 | 单元测试：编解码一致性，多 group 路由 |
| A3 | `src/consensus/transport.ts` (重构) | TcpServer 全局单例 + ConnectionPool；从 `net.Server` 改为 `tls.createServer` | E2E：3 节点 fork，验证单端口共享 |
| A4 | 集成测试 | 多 group 消息隔离、mTLS 握手、连接池复用 | CI 套件 |

#### Phase B — RaftGroup 管理（预估 3-4 天）

**目标**: 支持创建/启动/停止多个 RaftGroup，共享 ConnectionPool

| 步骤 | 文件 | 工作内容 | 测试方法 |
|------|------|---------|---------|
| B1 | `src/consensus/raft-group-manager.ts` (新) | RaftGroup 生命周期（create/start/remove）；GroupTransportHandle RPC 实现 | 单元测试 + 集成测试 |
| B2 | `src/consensus/raft-core.ts` (适配) | 接入 GroupTransportHandle，从 Transport 接口得到 RPC 响应 | 集成：多 group 单机 |
| B3 | `src/core/database-manager.ts` (重构) | createDatabase() 同时创建 RaftGroup；为每个 Range 注入 RaftCore | 集成：2 数据库 × 2 Range |

#### Phase C — 删除数据库（预估 2-3 天）🚧 NOT YET IMPLEMENTED

**目标**: 三阶段删除实现

> ⚠️ 当前 `src/core/database-manager.ts` 中的 `dropDatabase()` 仅做内存清理（`Map.delete`），**不释放任何底层资源**。本阶段的所有步骤（C1-C5）均未在生产代码中实现。集成测试 `test/integration/database-deletion.test.ts` (18/18 ✅) 已在 mock 环境中验证了正确的行为，但生产代码尚未对应实现。

| 步骤 | 文件 | 工作内容 | 测试方法 |
|------|------|---------|---------|
| C1 | `src/core/database-manager.ts` (新增方法) | `deleteDatabase()` Phase 0 + R10 broadcast 集成 | 单元测试：tombstone 写/读 |
| C2 | `src/core/database-manager.ts` (回调) | `onDatabaseDeleteCommit()` Phase 1 + 冷静期计时器 | 单元：计时器回滚 |
| C3 | `src/core/database-manager.ts` (GC) | `_gcDatabase()` Phase 3：停止 Group + 删文件 + 注销 handler | 单元：Mock fs |
| C4 | `src/core/database-manager.ts` (恢复) | `restoreDatabase()` 回滚 + `loadExistingDatabases()` 启动恢复 | 集成：重启后状态正确 |
| C5 | 集成/E2E 测试 | 全流程：创建 → 标记删除 → 回滚 → 冷静期 → GC → 启动恢复 | CI |

#### Phase D — WorkerPool 增强 + 清理（预估 2-3 天）

**目标**: WorkerPool 1:1 映射 + 指数退避 + 空载放慢

| 步骤 | 文件 | 工作内容 | 测试方法 |
|------|------|---------|---------|
| D1 | `event-bus-worker-pool.ts` (重构) | 从一致性 hash 改为 1:1 Worker-Peer | 集成测试 |
| D2 | `outbox-replication.ts` (增强) | 指数退避 + 抖动 + 空载放慢 | 集成测试 |
| D3 | `event-bus.ts` (清理) | `(this as any)` → 私有字段类型安全 | 无功能变更 |

### 9.2 依赖关系

```
Phase A ──────────────────────────────────────────────────
  A1 EndpointManager ───┐
                        ├──► A3 TcpServer Singleton + ConnectionPool
  A2 MuxCodec ──────────┘             │
                                       ▼
Phase B ───────────────────────────────┴──────────────────
  B1 RaftGroupManager ──► B2 RaftCore 适配 ──► B3 DatabaseManager 改造
                                       │
Phase C ───────────────────────────────┘──────────────────
  C1 deleteDatabase() ──► C2 冷静期 ──► C3 GC ──► C4 恢复 ──► C5 测试
                                       │
Phase D ───────────────────────────────┘──────────────────
  D1 WorkerPool 1:1 ──► D2 退避增强 ──► D3 类型清理
```

**关键路径**: A1→A2→A3→B1→B2→B3→C 各阶段串行，D 与 C 可并行。

### 9.3 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| mTLS 证书生成/验证复杂度超出预估 | 中 | 高 | 先使用自签名测试证书，生产用 CA 签名放在后续迭代 |
| TcpServer 单例改造导致现有 E2E 测试大面积失败 | 高 | 中 | Phase A 在 git branch 独立开发，完成后再 merge |
| GroupTransportHandle 的 RPC 超时/重试逻辑与现有 Transport 接口不兼容 | 中 | 中 | 适配器模式，保持 Transport 接口不变 |
| 删除流程中 R10 broadcast 与 Raft 自身成员变更冲突 | 低 | 高 | 删除作为独立的 R10 proposal type（`type: 'delete-database'`） |
| 高并发 GC 与活跃 Raft 消息竞争 | 低 | 中 | GC 前 stop RaftGroup（内部 drain 队列）|

### 9.4 里程碑

```
M1: Phase A 完成  ─── mTLS 共享连接测试通过（节点 fork + 消息路由）
M2: Phase B 完成  ─── 多数据库创建 + RaftGroup 管理 E2E
M3: Phase C 完成  ─── 三阶段删除 E2E（创建 → 标记 → GC → 启动恢复）
M4: Phase D 完成  ─── WorkerPool 增强 + 全量测试通过
M5: Final         ─── 文档更新 + 全量验收
```

### 9.5 估算工时

| 阶段 | 天数 | 并行度 |
|------|------|--------|
| Phase A | 4-6 | 串行 |
| Phase B | 3-4 | 需 A 完成后 |
| Phase C | 2-3 | 需 B 完成后 |
| Phase D | 2-3 | 可与 C 并行 |
| 集成/E2E 测试 | 2-3 | 贯穿各阶段 |
| 文档 + 全量验收 | 1 | 最后 |
| **总计** | **14-20 天** | |

