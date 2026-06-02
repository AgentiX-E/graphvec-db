# 分层分布式共识与数据同步设计模式

## Raft + MultiLeaderReplication + EventBus 三层的设计模式

> 基于 OverGraph（图数据库）代码库的实际实现归纳的通用设计模式，
> 适用于任何需要跨数据中心、一致性分层管理的分布式系统。

---

## 1. 核心设计理念：一致性分层

分布式系统要同时满足「同 DC 强一致」和「跨 DC 最终一致」，最有效的策略是 **分层共识**：

```
┌─────────────────────────────────────────────────────────┐
│                  Layer 3: EventBus                       │
│          跨 DC 最终一致性 · 异步 ZMQ P2P · Outbox        │
├─────────────────────────────────────────────────────────┤
│                  Layer 2: MultiLeader                    │
│       Outbox 持久化队列 · Per-Peer 独立退避 · 无限重试    │
├─────────────────────────────────────────────────────────┤
│                  Layer 1: Raft Consensus                 │
│   同 DC 共识 · 线性一致性 · Leader 选举 · 预写日志        │
├─────────────────────────────────────────────────────────┤
│               Layer 0: 本地存储 (LMDB/OverGraph)         │
└─────────────────────────────────────────────────────────┘
```

| 层 | 一致性保证 | 延迟 | 吞吐 | 适合场景 |
|----|-----------|------|------|---------|
| Layer 1: Raft | 线性一致性 | 5-50ms (同DC) | 中 | 同 DC 节点间的强一致写入 |
| Layer 2: Outbox | 最终一致性 | 异步 (500ms+) | 高 | 跨节点异步复制，不阻塞主路径 |
| Layer 3: EventBus | 最终一致/Best-effort | 异步(1ms+) | 极高 | 跨 DC 事件广播，实时通知 |

### 关键原则：路径正交性

**不同层之间复用不同的传输通道，互不依赖。**

```
写入操作
  ├── Raft 路径: 本地存储写入 → ConsensusProvider.propose() → 状态机 apply
  ├── EventStream 路径: WAL 追加 → EventBus.broadcast() → 远程节点应用
  └── Outbox 路径: LMDB 队列 → PerPeerWorker → EventBus.send() → 远程节点应用
```

**Raft 路径完全不经过 EventBus**。这一点必须明确：Raft 和 EventBus 是正交的。

---

## 2. 应用场景

### 场景 1: 同 DC 多节点图数据库集群

```
┌────── DC-A ──────┐
│  Node-1 ───raft── Node-2 │
│     │              │     │
│   EventBus ─── EventBus  │
│     │              │     │
│  │  Node-3 ───raft── Node-4 │
└──────┴──────────────┘
```

- **Raft**: 每个 range/shard 的副本组内做线性一致写入
- **EventBus**: 实时通知其他 range（跨 shard 查询、缓存失效）
- **MultiLeader**: 可选的跨节点异步备份

### 场景 2: 跨数据中心多主复制

```
DC-A (主) ─── EventBus ───→ DC-B (备)
  │                           │
  Raft + MultiLeader         Raft (只读/最终一致)
```

- DC-A 的 Raft 写入后，Outbox 异步推送到 DC-B
- DC-B 接收后写本地 Raft（独立集群，不参与 DC-A 的选举）
- 跨 DC 的冲突通过 HLC + LWW 解决

### 场景 3: 分布式配置/元数据中心

```
Config Manager ─── EventBus ───→ Agent-1
  │                                 Agent-2
  Raft (配置版本管理)                  Agent-3
```

- Raft 保证配置的版本一致性
- EventBus 推送到所有订阅 agent
- Outbox 确保离线 agent 恢复后能收到历史变更

### 场景 4: 物联网/IoT 数据管道

```
Edge Node (弱网)
  └── Outbox (LMDB 持久化)
       └── 恢复连接 → EventBus → DC (Raft + 时效)
```

- Edge 端 Outbox 在离线时积累数据
- EventBus 在恢复时重放
- DC 端 Raft 做全局有序持久化

### 场景 5: 金融交易的双层保证

```
交易写入
  ├── Raft: 多数确认后才返回客户端（强一致）
  └── EventBus: 实时通知风控系统（最终一致）
```

- Raft 保证无法回滚
- EventBus 提供低延迟风控评估
- Outbox 保证消息不丢

### 场景 6: 微服务的 CQRS/Event Sourcing

```
Command Service (Raft)
  └── Outbox → EventBus → Query Service
                            └── 物化视图
```

- Command 端用 Raft 保证命令有序性
- EventBus 发布事件到 Query 端
- Outbox 保证至少一次交付

---

## 3. 技术实现细节

### 3.1 Raft 共识层

#### 接口抽象

```typescript
interface ConsensusProvider {
  start(): Promise<void>
  stop(): Promise<void>
  propose(data: Uint8Array, timeoutMs?: number): Promise<{ ok: boolean }>
  readIndex(timeoutMs?: number): Promise<void>
  barrier?(timeoutMs?: number): Promise<void>
  getRole(): 'leader' | 'follower' | 'candidate' | 'standalone'
  getLeaderId(): string | null
  getTerm(): number
  waitForLeader(timeoutMs?: number): Promise<void>
  setApply?(fn: (data: Uint8Array) => Promise<void>): void
}
```

#### 实现选择

| 实现 | 适用场景 | 注意事项 |
|------|---------|---------|
| raft-rs (WASM) | 生产级多节点 | 需 WASM 运行时，跨语言调用消耗约 1μs |
| 自建 TCP Raft | 低延迟场景 | 需要自行实现 Raft 状态机 + 选举 + 心跳 |
| Simulated Raft | 测试/开发 | 所有节点在同一进程，不适用于生产 |
| Standalone Consensus | 单节点/单进程 | 无网络共识，适用于开发或嵌入式场景 |

#### 共识一致性保证

```
propose(data) → Raft 日志复制
  ├── Leader 写入本地日志
  ├── 并行发送 AppendEntries RPC 到 Followers
  ├── 收到多数（quorum）确认 → commit
  └── 调用 applyFn(data) → 状态机 apply
```

**关键**: Raft 只保证**日志顺序一致性**，不保证**业务唯一性**。
业务层的幂等需要由 applyFn 自行保证（通常通过操作 ID 去重）。

#### 数据通过 Raft 提交的路径

```
写入请求
  │
  ▼
RangeInstance.write(op)
  │
  ├─ 构造 RaftOperation { id: uuid, type, payload, hlcTimestamp }
  ├─ 注册 applyResolver: Promise<unknown>
  ├─ consensus.propose(JSON.stringify(operation))
  │     │
  │     ▼ (多数复制完成)
  ├─ consensus.setApply(data) 回调
  │     │
  │     ▼
  │   applyToStateMachine(data)
  │     ├─ 解析 RaftOperation
  │     ├─ 调用 engine.upsertNode() (带 skipReplication)
  │     └─ resolve(applyResolver)
  │
  └─ 返回结果给客户端
```

#### 线性一致读取

```
读取请求 → barrier() → read()
  ├── barrier(): 等待所有前置 entry 提交到状态机
  │              （raft-rs 原生支持，否则可通过 propose no-op entry 实现）
  └── read(): 在状态机最新状态上执行读取
```

### 3.2 Outbox (MultiLeader) 层

#### 核心架构

```
OutboxReplicationManager
  ├── OutboxStore (LMDB 持久化)
  │     ├── seq: 原子递增序列号
  │     ├── seq → OutboxEntry { seq, msgId, targetNodeId, type, payload, createdAt, delivered, deliveredAt }
  │     ├── pending:<peerId>:<pad10(seq)> → 1
  │     ├── delivered:<peerId>:<pad10(seq)> → 1
  │     └── seqToPeer:<seq> → peerId
  │
  └── PerPeerWorker (每个 peer 独立)
        ├── peerSendTrack: Set<string> — 可发送的 peer
        ├── peerBackoffTrack: Map<peerId, lastSendTimestamp> — 退避中的 peer
        ├── ackTracker: Map<msgId, sentAt> — 等待 ACK
        └── 状态机:
              notifyConnected → peerSendTrack.add(id)
              tick: send oldest → ackTracker.add → backoff
              tick: backoff expired → recoverDealerFn → peerSendTrack.add
```

#### 退避算法

```
maxBackoffSeconds = 60s
recoverDealerFn(peerId)
  ├── EventBus._recoverDealerByNodeId(peerId)
  │     ├── 关闭旧 DEALER socket
  │     ├── 重新创建 DEALER + CURVE 配置
  │     └── 重新连接到 peer 的 ROUTER
  └── peerSendTrack.add(peerId)

backoff 超时策略:
  1) ACK 未收到 → dealer 可能失效
  2) 重建 dealer → 连接新 ROUTER socket
  3) 恢复发送 → 从 LMDB 加载未 delivered 的消息重发
```

#### 节点在线检测

```
每次发送前检查目标节点的 .pub 文件
  ├── 文件存在 → 继续发送
  └── 文件不存在 → 从 peerSendTrack 永久移除
                      ├── 节点真正下线
                      ├── 或节点正在重启（临时）
                      └── 重启后重新发布 .pub → notifyConnected → 恢复发送
```

### 3.3 EventBus 传输层

#### ZMQ 架构

```
每个节点:
  ┌──────────────────────────────┐
  │          EventBus             │
  │                               │
  │   1 × ROUTER Socket (Server)  │←── 接收所有 peer 的消息
  │         ▲                     │
  │         │                     │
  │   receive queue (缓冲区)      │
  │         │                     │
  │   receiveHandler (回调分发)    │
  │         │                     │
  │   ┌─────┴──────┐              │
  │   │ ack队列     │              │
  │   └─────┬──────┘              │
  │         │                     │
  │   N × DEALER Socket           │──→ 发送到每个 peer
  │                               │
  │   CURVE (Curve25519) 加密     │
  └──────────────────────────────┘
```

#### 消息协议

```typescript
interface TransportMessage {
  msgId: string           // 全局唯一，用于去重
  type: 'data' | 'ack' | 'sync-query' | 'sync-query-reply' | 'sync-request' | 'sync-batch'
  srcNodeId: string
  ackMsgId?: string       // 仅 ack 类型
  data: Record<string, unknown>
}

interface StreamMessage {
  msgId: string
  seq: number
  nodeId: string
  timestamp: number
  type: 'node:created' | 'node:deleted' | 'edge:created' | 'edge:deleted'
  data: Record<string, unknown>
}
```

#### 安全通信

```
CURVE (Curve25519):
  ├── 每个节点生成 Curve25519 keypair
  ├── 公钥写入 NAS 共享目录: {nodeId}-{port}.pub
  ├── ROUTER socket 绑定：server 模式
  │     ├── setCurveServer(publicKey, secretKey)
  │     └── setCurveServerKey(allowedPeerPublicKeys)
  └── DEALER socket 连接：client 模式
        ├── setCurveClient(serverPublicKey, clientSecretKey, clientPublicKey)
        └── 双向认证 + 传输加密
```

#### NAS 公钥分发

```
NAS 目录结构:
  /shared/curve-keys/
    ├── node-1-5555.pub
    ├── node-2-5555.pub
    └── node-3-5555.pub

节点启动:
  1. 生成 keypair
  2. 写入 {nodeId}-{port}.pub
  3. 扫描目录，读取所有其他节点的 .pub
  4. 为每个节点创建 ROUTER + DEALER + CURVE 配置

节点下线:
  SHUTDOWN → 删除自己的 .pub 文件
  → 其他节点 OutboxWorker 检测到 peer .pub 不存在 → 停止发送

纳秒级延迟目录监控:
  pollDir(dir, options: { pollIntervalMs: number })
  └── 默认 3s
  └── 支持 fsnotify (Linux: inotify, macOS: FSEvents, Windows: ReadDirectoryChanges)
```

### 3.4 幂等消费三层保障

```
                ┌─ 发起节点 ─┐             ┌─ 消费节点 ─┐
                │            │             │            │
                │ upsertNode │             │   EventBus │
                │  (Client)  │             │ ROUTER recv│
                └─────┬──────┘             └──────┬──────┘
                      │                           │
                ┌─────▼──────┐             ┌──────▼──────┐
                │ Layer 1:   │             │ Layer 1:    │
                │ msgId      │             │ DedupRing   │
                │ 生成(唯一)  │             │ (10K 循环)  │
                └────────────┘             └──────┬──────┘
                      │                           │ (去重通过)
                      │                           ▼
                      │                    ┌──────────────┐
                      │                    │ Layer 2:     │
                      │                    │ _applying    │
                      │                    │ Remote标志   │
                      │                    └──────┬───────┘
                      │                           │
                      │                    ┌──────▼───────┐
                      │                    │ applyHandler │
                      │                    │ skipReplica  │
                      │                    │ tion: true    │
                      └─────────────────►  │              │
                                           │ upsertNode   │
                                           │ (不广播)     │
                                           └──────────────┘
```

### 3.5 递归保护

```
upsertNode()  →  _emit() →  EventBus.broadcast()  →  远程节点
  ▲                                                        │
  │                                                        │
  ├─ _applyingRemote = true  ←─────────────────────────────┘
  ├─ _recursionDepth++
  ├─ upsertNode(typeId, name, { skipReplication: true })
  │     └─ 跳过 _mlReplication.replicate()
  │     └─ 跳过 _emit()  (因为 _applyingRemote === true)
  └─ MAX_RECURSION_DEPTH = 10 (硬上限)
```

---

## 4. 应用技巧与最佳实践

### 4.1 什么时候该用哪一层？

| 需求 | 使用层 | 理由 |
|------|-------|------|
| 同 DC 线性一致写入 | Raft | 多数确认后才返回 |
| 同 DC 实时事件通知 | EventBus | 低延迟，不阻塞写入 |
| 跨 DC 最终一致复制 | Outbox + EventBus | 容忍 WAN 延迟和断连 |
| 跨 DC 强一致（少用） | Raft over WAN (不建议) | 延迟不可接受，建议设计上避免 |
| 离线+上线后同步 | Outbox (LMDB) | 持久化等待，恢复后重放 |
| 批量变更推送 | Outbox batchSend | 聚合多个变更一次发送 |

### 4.2 配置参数指南

```
Raft:
  heartbeatInterval: 50-150ms (同 DC LAN)
  electionTimeout:  300-1000ms (同 DC LAN)
  > 过短的选举超时会增加不必要选举 → False Positive 选主

Outbox:
  tickMs: 100-1000ms (取决于实时性要求)
  maxBackoffSeconds: 30-300 (连接恢复速度)
  batchSize: 1-100 (吞吐 vs 延迟)
  > 高吞吐场景建议 batchSize > 10

EventBus:
  ZMQ ROUTER HWM (High Water Mark): 1000-10000
  > 超过 HWM 的消息被 ZMQ 丢弃，需靠 Outbox 重试保障
  dedupCapacity: 10000-100000 (取决于内存)
  > 容量过小可能导致短时间内的重复消息（时间窗口 = capacity / throughput）
```

### 4.3 冲突处理策略

```
跨 DC 冲突:
  ┌─ LWW (Last Writer Wins): 基于 HLC 时间戳
  │   适用: 大多数场景
  │   风险: 因果一致性需要 HLC 能反映因果关系
  │
  ├─ CRDT: 基于 Operation CRDT
  │   适用: 协作编辑、计数器
  │   依赖: graph-crdt 库
  │
  └─ 应用层合并: 用户自定义冲突解决
      适用: 业务规则复杂的场景
```

### 4.4 分区/脑裂处理

```
Raft 分区:
  多数派 (>= 3 节点) → 继续服务
  少数派 (< 3 节点)  → 写入被拒绝

EventBus 跨分区:
  OutboxWorker 在分区期间持续退避、重试
  分区恢复后，Outbox 恢复发送
  DedupRing 确保消息不重复

MultiLeader 在脑裂后的数据一致性风险:
  不存在"真正的"MultiLeader 脑裂问题
  因为 Raft 才是数据的主要写入路径
  EventBus 广播只是异步通知，不影响数据本身
  脑裂后恢复：新的 Leader 日志通过 Raft 复制到所有节点
```

### 4.5 性能考量

```
Raft:
  瓶颈: 磁盘 I/O (Raft 日志 fsync) + 网络 RTT
  扩容: 分片 (增加 range/shard 数量)

EventBus:
  瓶颈: ZMQ 线程数 + 消息序列化/反序列化
  优化: 使用 WorkerPool (多进程) 分摊 ZMQ 负载
  扩容: 增加 WorkerPool 并发度

Outbox:
  瓶颈: LMDB 写入吞吐 + EventBus 发送带宽
  优化: batchSend 聚合、减少 tick 间隔
  扩容: Per-Peer 独立 Worker，可水平扩展
```

---

## 5. 与其他设计模式的对比

| 模式 | 一致性 | 延迟 | 吞吐 | 复杂度 | 适用场景 |
|------|--------|------|------|--------|---------|
| 纯 Raft 集群 | 线性一致 | 中 | 低-中 | 高 | 单数据中心 |
| Kafka/Pulsar | 分区有序 | 低 | 极高 | 中 | 事件流 |
| CRDT 全同步 | 最终一致 | 高 | 高 | 低 | 协作编辑 |
| **本模式(分层)** | **分层** | **可控** | **高** | **中** | **跨 DC + 同 DC** |
| 2PC/XA | 严格 | 极高 | 低 | 极高 | 不推荐分布式 |

---

## 6. 局限性与未解决问题

1. **Raft + Outbox 事务性**: 本地 Raft 写入和 Outbox 写入不在同个分布式事务中。如果 Raft 写入后进程崩溃但 Outbox 还未写入，变更不会广播。
2. **跨 DC 的因果一致性**: 目前仅依靠 HLC + LWW，如果节点间有严格因果依赖，需要额外的 vector clock 支持。
3. **Raft 成员变更期间的强一致保障**: 当前代码中 Raft 成员变更没有与 EventBus 协作（如：变更期间的写入暂停、变更确认后恢复）。
4. **Outbox 重复消息的安全窗口**: 超时但实际已送达的消息 → 重新发送时可能产生重复。当前靠 DedupRing 兜底，但 DedupRing 容量有限。
5. **全局死锁检测**: 多 shard 事务在当前设计中不支持。
6. **Outbox 的持久化与 Raft WAL 分离**: 同一个进程有两套日志系统（Raft WAL + Outbox LMDB），增加了恢复复杂性。

---

## 7. 部署建议

### 最小部署（单节点，开发/测试）

```
1 × 节点: StandaloneConsensus + EventBus
  └── Outbox: 可选，单节点测试用
```

### 标准部署（3 节点，同 DC）

```
3 × 节点:
  ├── Raft (3 副本，容忍 1 节点故障)
  ├── MultiLeader (3 个 Outbox，异步同步)
  └── EventBus (3 × ROUTER + N × DEALER)
```

### 多 DC 部署（3 节点 × 2 DC）

```
DC-A: 3 节点 Raft + EventBus
DC-B: 3 节点 Raft + EventBus (独立集群)
DC interlink: EventBus P2P + Outbox 异步复制
```

---

## 13. V10 新方向展望（⬜ 计划中）

> 根据 V10 深度调研（`temp/v10-gap-research.md`），以下 8 个方向将在本设计模式框架下逐步实现。

| 方向 | GAP | 优先级 | 与本架构关联 |
|------|:---:|:------:|-------------|
| OpenAPI/Swagger 文档 | GAP-43 | P3 | Route 元数据绑定，自动生成 OpenAPI 规范 |
| 健康检查增强 | GAP-44 | P3 | 健康检查涵盖 Raft/EventBus/Outbox 组件状态 |
| 查询超时/取消 | GAP-45 | **P2** | QueryTimeoutManager 集成查询管道，AbortSignal 中断 |
| 审计日志导出 | GAP-46 | P3 | AuditLogExporter 结构化导出 + 定时归档 |
| 自定义聚合函数 | GAP-47 | P3 | AggregationRegistry 扩展点（类似 ProcedureRegistry） |
| 多语言 SDK | GAP-48 | P3 | Python/Go/Java SDK，OpenAPI 规范驱动生成 |
| 压缩传输 | GAP-49 | P3 | REST/gRPC 压缩，减少网络带宽消耗 |
| 配置热加载 | GAP-50 | P3 | ConfigWatcher 基于 chokidar，热加载配置变更 |

**详细设计**参见 `docs/design/execution-plan.md` Phase 10。

---

*本文档基于 OverGraph 代码库 (agentiX-graphvec) 中的实际实现泛化而来。
核心代码文件: `event-bus.ts`, `event-stream.ts`, `outbox-replication.ts`,
`multi-leader-replication.ts`, `range-instance.ts`, `shard-manager.ts`,
`consensus-provider.ts`, `raft-logic-consensus.ts`, `standalone-consensus.ts`.*
