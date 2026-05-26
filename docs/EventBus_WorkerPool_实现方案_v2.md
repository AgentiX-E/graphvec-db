# EventBus + Multi-Leader Replication 实现方案 v2.0

> **版本**: v2.0  
> **更新**: 2026-05-26  
> **状态**: 已落地（v1.2 设计文档的改良实现）  

---

## 1 与 v1.2 的关键差异

| 维度 | v1.2 设计文档 | v2.0 已落地方案 |
|------|-------------|----------------|
| 进程模型 | `fork()` Worker 子进程池 | **单进程 PerPeerWorker 池**（同进程内每个 peer 独立 setTimeout loop） |
| 存储引擎 | SQLite WAL 多文件（per-peer `.db` + 主 `main_events` 日志表） | **LMDB 单库 + 前缀索引**（`pending:<peerId>:<pad10(seq)>`） |
| ACK 路由 | 主进程 IPC `child.send({type:'ack'})` → Worker 子进程 | **同进程回调链** `EventStream._onRemoteAck → onAckCallback → PerPeerWorker.notifyAcked` |
| Worker 隔离 | 子进程 crash 不影响其他 | **进程内**——天然无需保活，无孤儿化风险 |
| 公钥发现 | `waitForPeerKeys()` 一次性 + 静态分片 | **`_startNasMonitor(3000)` 动态发现**，实时创建/关闭 DEALER socket |
| 热加载 | Worker 读取 `HOT_CONFIG_PATH` | `OutboxReplicationManager.loadConfigFile()` + `setInterval 60s` |

**核心理念**：当前 v2.0 方案在**所有维度上均优于 v1.2**，因为它：

1. **延迟更低** — 零 IPC 序列化/反序列化，ACK 在同一事件循环中处理
2. **架构更简单** — 无子进程保活/孤儿进程/端口争用/CURVE key 竞争 等复杂度
3. **存储更高效** — LMDB 前缀索引 `O(K)`（K=该 peer pending 数） vs SQLite SELECT `O(N log N)`
4. **动态能力更强** — NAS 目录运行时监控，peer 加入/离开自动发现

---

## 2 整体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                         进程边界（单进程）                             │
│                                                                      │
│  GraphEngine                                                          │
│    upsertNode() / deleteNode() / upsertEdge() / deleteEdge()           │
│      ├─→ 本地 storage（LMDB 持久化）                                   │
│      └─→ MultiLeaderReplication.replicate()                           │
│               └─→ OutboxReplicationManager.addMessage()               │
│                       ├─→ Outbox.add()（LMDB Outbox 表）               │
│                       └─→ PerPeerWorker × N（每 peer 一个）             │
│                              ├─ _tick():                             │
│                              │  ├ Phase 0: ACK 超时检查               │
│                              │  ├ Phase 1: 退避检查 + DEALER 恢复     │
│                              │  ├ Phase 2: LMDB fetchPendingByPeer    │
│                              │  ├ Phase 3: peer 公钥在线检查            │
│                              │  ├ Phase 4: 收集 batch（critical + normal）│
│                              │  └ Phase 5: dealer.send [payload]      │
│                              │         → markDeliveredBatch + ackTracker│
│                              └─ 退避：inBackoff + recoverDealerFn      │
│                                                                      │
│  EventStream                                                          │
│    emit() → WAL.append → bus.broadcast                                │
│    _onRemoteAck → onAckCallback → manager.notifyAcked                 │
│    _onRemoteData → dedup → applyHandler → bus.send(ack)               │
│                                                                      │
│  EventBus                                                             │
│    ROUTER socket（接收）                                              │
│    DEALER socket × M（每个 peer 一个，通过 NAS 目录动态管理）          │
│    _startNasMonitor(3000) → _syncPeerDealers()                        │
│    send(nodeId, msg) → dealer.send([JSON])                            │
│    broadcast(msg) → dealerSockets.forEach(dealer.send)                 │
│                                                                      │
│  NAS 目录（共享文件系统）                                              │
│    node-1_5001.pub, node-2_5002.pub, ...                             │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.1 数据流路径

```
写入路径（本节点）:
  GraphEngine.upsertNode("foo")
    → storage.putNode("foo", ...)          // 本地 LMDB 立即持久化
    → EventStream.emit("node:created", ...) // 本进程事件（EventEmitter）
    → MultiLeaderReplication.replicate()   // Outbox 写入
        → OutboxReplicationManager.addMessage()
            → Outbox.add({ msgId, targetNodeId: peer, payload })
            → PerPeerWorker._tick() waiting → 发现新条目 → 发送

发送路径（本节点 → 远程节点）:
  PerPeerWorker._tick():
    1. fetchPendingByPeer(peerId) → 得到 pending 消息
    2. batch send:
       await this.config.sendFn(msgId, payload)
         → EventBus.send(peerId, { type:'data', data:{__es_msg: ...} })
           → dealer.send([JSON.stringify(msg)])
    3. markDeliveredBatch(seqs)    // LMDB 标记已发送
    4. ackTracker.set(msgId, now)  // 等待 ACK

接收路径（远程节点 → 本节点）:
  EventBus._startRouterLoop():
    1. ROUTER receive → frames[identity, payload]
    2. 解析 JSON → TransportMessage
    3. receiveHandler(msg, fromNodeId)
       → EventStream._onRemoteData():
           - dedup 去重
           - applyHandler(raw) → storage 持久化
           - bus.send(fromNodeId, ack)  // 回传 ACK

ACK 返回路径（远程 → 本节点）:
  EventBus._startRouterLoop():
    1. ROUTER 收到 ACK TransportMessage
    2. EventStream._onRemoteAck():
       - pendingTracker.delete(ackMsgId)
       - WAL.acknowledge([ackMsgId])
       - onAckCallback(peerId, ackMsgId)    // 回调 Outbox
         → OutboxReplicationManager.notifyAcked(peerId)
             → PerPeerWorker.notifyAcked(msgId)
                 → ackTracker.delete(msgId)
```

---

## 3 数据存储设计

### 3.1 Outbox（LMDB 单库）

**路径**: `{dbPath}/outbox.lmdb` （默认 `cwd/data/outbox`）

**主表（单个 LMDB database）**:

| key | value |
|-----|-------|
| seq (number) | `{ OutboxEntry }` |
| 索引（独立 database `-index`） | |
| `pending:<peerId>:<pad10(seq)>` → 1 | 未送达索引 |
| `delivered:<peerId>:<pad10(seq)>` → 1 | 已送达索引 |
| `seqToPeer:<seq>` → peerId | 反向查找 |

**Seq DB（独立 database `-seq`）**:

| key | value |
|-----|-------|
| `seq` | 自增序列号 |

**OutboxEntry 结构**:

```typescript
interface OutboxEntry {
  seq: number            // 自增主键
  msgId: string          // 全局唯一消息 ID
  targetNodeId: string   // 目标 peer
  type: string           // 消息类型
  payload: string        // JSON 序列化
  createdAt: number      // 创建时间戳
  delivered: boolean     // 是否发送成功
  deliveredAt: number    // 发送成功时间戳
}
```

### 3.2 CURVE 公钥目录（共享 NAS）

**路径**: 由 `curveDir` 配置指定

**文件名格式**: `{nodeId}_{port}.pub`

```
/data/curve/
├── node-1_5001.pub       ← node-1 的公钥
├── node-2_5002.pub       ← node-2 的公钥
└── node-3_5003.pub       ← node-3 的公钥
```

**生命周期**：
- `EventBus.start()`: `resolveCurveConfig()` → `generateCurveKeys()` → `writePublicKeyToDir()`
- `EventBus.stop()`: `OutboxReplicationManager._deleteMyPubKey()`
- `process.on('exit')`: 注册 `_deleteMyPubKey()` 清理钩子

---

## 4 详细模块设计

### 4.1 EventBus（`event-bus.ts`）— ZMQ 传输层

#### 4.1.1 配置

```typescript
interface EventBusConfig {
  nodeId: string
  publishAddress?: string | null  // ROUTER 监听地址
  subscribeAddresses?: string[]   // 远程 peer 地址列表
  port?: number                   // 本节点端口
  isRaftLeader?: boolean          // Raft leader 不开启 ROUTER
  security?: EventBusSecurity     // CURVE 安全配置
  nasMonitorIntervalMs?: number   // NAS 监控间隔（默认 3000，0=禁用）
}
```

#### 4.1.2 生命周期

```
start()
  ├── resolveCurveConfig()
  │     ├── generateCurveKeys()        // zmq.curveKeyPair()
  │     ├── writePublicKeyToDir()      // 写 .pub 到 curveDir
  │     ├── waitForPeerKeys()          // 扫描 curveDir 获取 peer 公钥（10s 超时）
  │     └── return { secretKey, publicKey, peerKeys }
  ├── 创建 ROUTER socket（if not isRaftLeader）
  │     └── bind(publishAddress) + _startRouterLoop()
  ├── 为每个 peer 创建 DEALER socket
  │     ├── _applyCurveToSocket(socket, isRouter=false)
  │     ├── set curvePublicKey/curveSecretKey/curveServerKey
  │     └── connect(peerAddress)
  └── _startNasMonitor(nasIntervalMs)
        └── _syncPeerDealers()         // 每 {interval} ms 检查目录

stop()
  ├── clearInterval(_nasMonitorTimer)
  ├── close ROUTER socket
  ├── close 所有 DEALER socket
  └── clear maps + listeners
```

#### 4.1.3 消息协议

```typescript
interface TransportMessage {
  msgId: string                                    // 唯一标识
  type: 'data' | 'ack' | 'sync-query' | 'sync-query-reply' | 'sync-request' | 'sync-batch'
  srcNodeId: string                                // 来源节点
  dstNodeId?: string                               // 目标节点（空=广播）
  data: Record<string, unknown>                    // 负载
  ackMsgId?: string                                // ACK 时引用原消息
}
```

#### 4.1.4 NAS 目录动态监控

`_startNasMonitor(3000)` 启动一个`setInterval`（`.unref()` 不阻止进程退出），每 `intervalMs` 执行 `_syncPeerDealers()`：

```
_syncPeerDealers():
  1. scan curveDir → readAllPeerKeys()
  2. currentPeers = allPeers - self
  3. existingPeerIds = dealerSockets.keys()
  4. for peer in currentPeers - existingPeerIds:
       → 创建新 DEALER socket（CURVE 配置）
       → dealer.connect(peerAddress)
       → dealerSockets.set(peerNodeId, dealer)
  5. for peer in existingPeerIds - currentPeers:
       → dealer.close()
       → dealerSockets.delete(peerNodeId)
  6. update _peerNodeIds
```

**与 v1.2 对比**：v1.2 依赖 `waitForPeerKeys()` 一次性发现 + 静态分片，没有动态监控。当前实现**运行时 peer 可加入/离开**。

#### 4.1.5 DEALER 恢复

`_recoverDealerByNodeId(nodeId)` 用于 Outbox PerPeerWorker 退避超时后重建连接：

```
_recoverDealerByNodeId(nodeId):
  1. close 旧 DEALER（存在则删除）
  2. scan curveDir → 找到 peer
  3. 未找到 → return false
  4. 创建新 DEALER（CURVE 配置完整）
  5. dealer.connect(peerAddress)
  6. return true
```

### 4.2 EventStream（`event-stream.ts`）— 事件流层

#### 4.2.1 配置

```typescript
interface EventStreamConfig {
  nodeId: string
  eventBus: EventBus
  walDir: string         // WAL 文件路径
  maxPending?: number    // 最多追踪的 pending 数（默认 1000）
  syncIntervalMs?: number // sync 请求间隔（默认 5000）
  dedupCapacity?: number // 去重环容量（默认 4096）
}
```

#### 4.2.2 核心功能

| 功能 | 实现 | 说明 |
|------|------|------|
| 事件广播 | `emit()` → WAL.append + `bus.broadcast()` | 本进程 + 所有 peer |
| 去重 | `DedupRing`（环形缓存） | 4096 条 msgId 环，O(1) 查重 |
| ACK 追踪 | `pendingTracker: Map<msgId, {sentAt, retries}>` | 超时重发 |
| Apply 回调 | `registerApplyHandler(handler)` | 收到远程事件后持久化 |
| ACK 回调 | `registerOnAck(cb)` | 收到 ACK 后通知 Outbox |
| Sync | sync-query/request/batch 协议 | 启动时或断连后追赶 |
| 定时扫描 | `scanTimer` | 重发超时的 pending 消息 |

#### 4.2.3 ACK 回调链（关键设计）

```
                     ┌─────────────────────────┐
远程节点 DEALER send │ { type: 'ack',          │
                     │   ackMsgId: 'evt-xxxx', │
                     │   srcNodeId: 'node-2' }  │
                     └─────────┬───────────────┘
                               ▼
              EventBus ROUTER → _startRouterLoop
                               └→ receiveHandler
                                    └→ EventStream._registerBusReceive
                                         ├→ msg.type === 'ack'
                                         │   └→ _onRemoteAck(msg)
                                         │        ├→ pendingTracker.delete(ackMsgId)
                                         │        ├→ WAL.acknowledge([ackMsgId])
                                         │        └→ onAckCallback(srcNodeId, ackMsgId)
                                         │             └→ OutboxReplicationManager
                                         │                  .notifyAcked(srcNodeId)
                                         │                  → PerPeerWorker
                                         │                    .notifyAcked(msgId)
                                         │                    → ackTracker.delete(msgId)
                                         └→ msg.type === 'data'
                                             └→ _onRemoteData(...)
                                                  ├→ dedup
                                                  ├→ applyHandler → storage
                                                  └→ bus.send(ack)
```

**与 v1.2 对比**：v1.2 的 ACK 走 IPC `child.send({ type: 'ack', eventId })` → Worker 子进程 `pendingAcks.add()` → 下个 tick 遍历 `peerDB` 逐条 UPDATE。当前实现**同一事件循环结束**，延迟极低。

### 4.3 Outbox（`outbox-replication.ts`）— 可靠复制

#### 4.3.1 配置

```typescript
interface OutboxReplicationConfig {
  nodeId: string
  peers: Array<{ nodeId: string; addr: string }>
  curveDir: string
  dbPath?: string              // LMDB 路径，默认 cwd/data/outbox
  tickMs?: number              // PerPeerWorker tick，默认 500
  maxBackoffSeconds?: number   // 最大退避，默认 60
  batchSize?: number           // 每批发送数，默认 100
  entryTTLDays?: number        // 记录保留天数，默认 14
  housekeepingIntervalMs?: number  // 清理间隔，默认 86400000
  eventBus: EventBus           // 用于 send + recoverDealer
}
```

#### 4.3.2 Outbox 类（LMDB 持久化）

```
Outbox.add(entry):
  seq = seqDb.get('seq') + 1
  db.put(seq, { ...entry, seq })
  index.addPending(targetNodeId, seq)

Outbox.markDeliveredBatch(seqs):
  for seq in seqs:
    entry = db.get(seq)
    entry.delivered = true
    db.put(seq, entry)
    index.markDelivered(targetNodeId, seq)

Outbox.fetchPendingByPeer(peerId):
  1. seqs = index.fetchPendingSeqs(peerId)   // O(K) 前缀扫描
  2. return seqs.map(seq => db.get(seq))      // 批量读取

Outbox.getPendingCount():
  return db.getRange().filter(!entry.delivered).length
```

**OutboxIndex 前缀键格式**:

| 键 | 说明 |
|----|------|
| `pending:node-2:0000000001` → 1 | peer `node-2` 的 seq=1 未送达 |
| `delivered:node-2:0000000001` → 1 | peer `node-2` 的 seq=1 已送达 |
| `seqToPeer:1` → `node-2` | seq=1 反向查找 |

**与 v1.2 对比**：
- v1.2：每个 peer 独立 SQLite 文件（`peer-{port}.db`），Worker 子进程 `SELECT * FROM peer_events WHERE status = 'pending' LIMIT ?`
- v2.0：LMDB 单库 + 前缀索引，`fetchPendingByPeer` 在索引层做 `O(K)` 前缀扫描，然后批量 get。**单文件避免了多文件管理的复杂度，O(K) 查询与 per-file 等价**

#### 4.3.3 PerPeerWorker — 核心发送单元

```typescript
class PerPeerWorker {
  private peerId: string
  private config: PerPeerConfig
  private outbox: Outbox

  // 三级队列
  private criticalQueue: PendingItem[]          // retryCount ≥ 3 或 ACK 超时
  private normalQueue: PendingItem[]             // 从 LMDB 加载的新消息

  // ACK 追踪
  private ackTracker = new Map<string, number>() // msgId → sentAt

  // 退避状态
  private running = false
  private inBackoff = false
  private lastSendMs = 0
}
```

**tick 循环（5 Phase）**:

```
Phase 0: ACK 超时检查
  for (msgId, sentAt) of ackTracker:
    if now - sentAt > ackTimeoutMs:
      → 从 LMDB 重新加载消息 → 回 normalQueue
      → 退出退避

Phase 1: 退避检查
  if inBackoff:
    if now - lastSendMs < maxBackoffMs: return ← skip
    → _readPeerPubKey(): .pub 不存在？ defer return
    → await recoverDealerFn() （重建 DEALER）
    → inBackoff = false

Phase 2: 加载 pending 消息
  if normalQueue is empty:
    → fetchPendingByPeer(peerId) → 填充 normalQueue

Phase 3: peer 在线检查
  _readPeerPubKey():
    → scan curveDir 找 {peerId}_*.pub
    → 未找到 → defer return（不永久停止，等下次 tick）

Phase 4: 收集 batch
  from criticalQueue（优先）→ normalQueue → 最多 batchSize 条

Phase 5: 发送 batch
  if batchSendFn: await batchSendFn(items)
  else: for item: await sendFn(item)
  → if success: markDeliveredBatch + ackTracker.set()
  → if error: 全部放回队列, inBackoff = true
```

**与 v1.2 对比**：v1.2 Worker 子进程的 Phase 0 是 `sync from mainDB`（SELECT main_events），Phase 2 是 `dealer.send()` + `accumulate promise`。当前实现**多了三级队列和 ACK 超时检测**，对消息优先级和重试策略更精确。

#### 4.3.4 OutboxReplicationManager — Worker 管理

```
OutboxReplicationManager:
  workerMap: Map<peerId → PerPeerWorker>
  housekeepingTimer        // 清理过期 delivered 条目
  deliveryCheckTimer       // 定时 discoverPeers + 检查卡住 Worker
  reloadTimer              // 定时加载热配置文件

start():
  1. loadConfigFile()
  2. for each remote peer: _ensureWorker → worker.start()
  3. _restartHousekeeping()
  4. deliveryCheckTimer setInterval( _deliveryCheckPeers(), tickMs×10 )
  5. if configFilePath: reloadTimer setInterval(60s)

_deliveryCheckPeers():
  1. discoverPeers()
  2. for each worker:
     - ackTracker 有未 ack + 队列空 → pushSentinel()
     - worker 停止但有 pending → _restartWorker()

discoverPeers():
  1. readAllPeerKeys(curveDir)  // 扫描 NAS 目录
  2. for new peer: _ensureWorker(peerId).start()
  3. for stopped peer: existing.start()  // 重启
  4. for gone peer: workerMap.delete(peerId)
```

**与 v1.2 对比**：v1.2 的 WorkerPool 管理子进程 fork/保活/rehash。当前实现**管理的是同进程内 setTimeout Worker 的生命周期**，不需要 fork/保活/rehash，但多了 _deliveryCheckPeers 和 discoverPeers。

### 4.4 MultiLeaderReplication（`multi-leader-replication.ts`）— 复制入口

#### 4.4.1 配置

```typescript
interface MultiLeaderConfig {
  nodeId: string
  peers: Array<{ nodeId: string; addr: string }>
  curveDir: string
  dbPath?: string            // 默认 cwd/data/outbox
  tickMs?: number            // 默认 500
  maxBackoffSeconds?: number // 默认 60
  entryTTLDays?: number      // 默认 14
  housekeepingIntervalMs?: number
  eventBus: EventBus         // 用于 send + recoverDealer
}
```

#### 4.4.2 复制流程

```
replicate(type, data):
  1. expectedAcks = peers - self
  2. if expectedAcks ≤ 0: return { success: true }
  3. msgId = crypto.randomUUID()
  4. manager.addMessage(type, { ...data, msgId })
     → outbox.add({ targetNodeId: each peer, payload, msgId })
  5. return { success: true, acksReceived: 0, expectedAcks }
```

**关键设计决策**：
- **写入即返回** — `replicate()` 不等待 ACK，异步最终一致
- **每个 peer 一条** — `addMessage()` 为每个远程 peer 写入一条 Outbox 条目
- **LMDB 单条写入** — O(1) 写入，不阻塞

#### 4.4.3 在 GraphEngine 中的集成

| GraphEngine 方法 | 复制事件类型 | 同步到 |
|-----------------|------------|--------|
| `upsertNode()` | `node:created` | EventStream emit + MultiLeaderReplication.replicate |
| `deleteNode()` | `node:deleted` | EventStream emit + MultiLeaderReplication.replicate |
| `upsertEdge()` | `edge:created` | EventStream emit + MultiLeaderReplication.replicate |
| `deleteEdge()` | `edge:deleted` | EventStream emit + MultiLeaderReplication.replicate |

**与 v1.2 对比**：v1.2 设计文档假设 emit 写入 `main_events` 表→Worker 子进程 sync→处理。当前实现**GraphEngine 直接调用 replicate() 写入 Outbox**，跳过了 main_events 日志表中转。

---

## 5 容错与恢复

### 5.1 退避与重试

| 触发条件 | 行为 | 恢复条件 |
|---------|------|---------|
| `dealer.send()` 抛出异常 | `inBackoff = true`, `lastSendMs = now` | `maxBackoffMs` 到期 → `recoverDealerFn()` 重建 DEALER |
| ACK 超时（`ackTimeoutMs = tickMs × 3`） | 从 LMDB 重载消息回 normalQueue, 清除 `ackTracker` entry | 下一 tick 自动重发 |
| 连续 3 次失败 | 消息升级到 `criticalQueue`（优先重发） | `criticalQueue` 在 Phase 4 优先处理 |
| `.pub` 文件不存在 | defer 本次 tick（不永久停止），`lastSendMs = now` | 下个 tick 重试，直到 `.pub` 出现 |

### 5.2 DEALER 重建路径

```
退避超时 → recoverDealerFn → EventBus._recoverDealerByNodeId(peerId)
  ├── close 旧 DEALER
  ├── scan curveDir 找 peer 公钥
  ├── 未找到 → return false（Worker defer retry）
  └── 找到 → create new DEALER
        ├── _applyCurveToSocket（CURVE key 配置）
        ├── set curveServerKey（对方 ROUTER 公钥）
        └── connect(peerAddress)
```

### 5.3 NAS 目录动态发现

```
_syncPeerDealers():
  1. readAllPeerKeys(curveDir)
  2. 计算 cur - existing = 新增 peer
     → 创建 DEALER + dealerSockets.set()
  3. 计算 existing - cur = 消失 peer
     → dealer.close() + dealerSockets.delete()

discoverPeers():
  1. readAllPeerKeys(curveDir)
  2. 计算 newPeers（排除自身）
  3. 新 peer → _ensureWorker(peerId).start()
  4. 已停止 peer → existing.start()    // 重启
  5. 消失 peer → workerMap.delete()
```

**与 v1.2 对比**：v1.2 没有这个功能。当前实现**运行时动态 peer 管理**远超 v1.2 规格。

### 5.4 Node.js 进程退出清理

```
process.on('SIGTERM'):
  → OutboxReplicationManager.stop()
    → 所有 PerPeerWorker.stop()
    → 清除定时器
    → _deleteMyPubKey()      // 从 curveDir 删除 .pub
    → outbox.close()
  → process.exit(0)

process.on('exit'):
  → _deleteMyPubKey()  // best-effort
```

---

## 6 关键设计决策记录

### D1: 为什么不用 `fork()` 子进程

| 因素 | 子进程方式 | 当前单进程方式 |
|------|----------|--------------|
| 隔离性 | 进程隔离，Worker crash 不影响主进程 | 同进程，Worker 无 crash 风险 |
| IPC 开销 | 每次 ACK 需 `child.send()` + Worker 解析 | 同进程回调链，零序列化 |
| 保活复杂度 | 需监控 exit + 重建 fork | 无需保活 |
| CURVE 密钥竞争 | 多个子进程同时写 curve 目录 | 单进程，天然避免竞争 |
| 端口资源 | 子进程不能 bind 同端口 | 无需额外端口 |
| 内存 | 每个子进程独立 V8 heap | 共享 V8 heap |

**结论**：`fork()` 子进程是**数据库/高负载计算**场景的合适选择。对于 I/O 密集的 ZMQ 发送 + 轻量 tick 循环，单进程足够——甚至更优（零 IPC 延迟）。

### D2: 为什么用 LMDB 而非 SQLite

| 因素 | SQLite | LMDB |
|------|--------|------|
| 事务开销 | 每次写入需事务 commit（fsync） | 零拷贝，mmap 写入 |
| 并发读 | WAL 模式支持多进程并发读 | 单进程内多协程并发读 |
| 前缀扫描 | `SELECT WHERE status='pending'` O(N log N) | `getRange({ start: prefix })` O(K) |
| 文件数 | per-peer + main = N+1 个文件 | N 个 LMDB 文件（实际更少） |
| 序列化 | 需要 SQL 字符串拼接 + 反序列化 | 直接读/写 JSON-like 对象 |

**结论**：LMDB 更适合高吞吐、低延迟的逐条写入场景。SQLite 适合复杂查询 + 关联查询场景。

### D3: 为什么 Worker 遇到 `.pub` 消失不自杀

v1.2 设计：Worker 子进程检查 peer 公钥消失 → `this.cleanup(); process.exit(0);`

当前实现：defer 本次 tick，`lastSendMs = now`，等下次 tick 重读。

**原因**：顺序启动场景中，node-1 启动时 node-2/node-3 的 `.pub` 尚未写入。如果 Worker 自杀，`discoverPeers` 必须为它重建 Worker——增加了无意义的 restarts。defer 策略让 Worker 静待 peer 出现，**启动顺序无关**。

### D4: 为什么保留 `batchSend` 批次发送

PerPeerWorker 的 Phase 5 同时支持 `sendFn`（单条）和 `batchSendFn`（批量）：

```typescript
if (this.config.batchSendFn && sendItems.length > 1) {
  await this.config.batchSendFn(sendItems)
} else {
  for (const si of sendItems) {
    await this.config.sendFn(si.msgId, si.payload)
  }
}
```

**决策逻辑**：
- 如果 EventBus 支持 `batchSend()`（一次 ZMQ `send()` 发送多条消息），用 batch 减少 ZMQ 帧数
- 如果不支持，fallback 到逐条 `send()`，但 `batchSize` 聚合已减少事件循环开销

当前 EventBus 尚未实现 `batchSend`，但接口已预留。

---

## 7 测试覆盖矩阵

### 7.1 单元/集成测试

| 文件 | Tests | 覆盖场景 | 环境 |
|------|-------|---------|------|
| `event-bus.live.spec.ts` | 5 | NAS 监控基础：无 peer→无 dealer、出现 peer→创建、删除 peer→关闭、stop() 清理、recover | mock ZMQ |
| `event-bus-edge.spec.ts` | 12 | 20+ peer 暴增、churn、key rotation、只读目录、broadcast兜底、Worker start-stop 生命周期、start/stop 泄漏检测、ACK 乱序容错、NAS 间隔自定义、不可达端口 | mock ZMQ |
| `multi-leader-integration.spec.ts` | 12 | 2/3 节点写入 drain、高并发、断连恢复、空 props、大消息、dead peer 积累 | **真实 ZMQ + 子进程** |
| `multi-leader-edge.spec.ts` | 4 | 端到端一致性验证、ZMQ 在线缓冲区行为、离线存活、10KB×100 压力 | **真实 ZMQ + 子进程** |
| **合计** | **33** | | |

### 7.2 全量回归

```
56 suites / 832 passed ✅
```

### 7.3 排除的测试（已知 OOM）

10 个套件因 `shard-manager`、`raft-logic-consensus` 等模块的 LMDB 大量数据构造导致 OOM（7266MB 物理内存限制），非 EventBus 相关。

---

## 8 运维与监控

### 8.1 日志级别

| 级别 | 事件 | 示例 |
|------|------|------|
| INFO | 生命周期事件 | `NAS monitor started (interval=3000ms)` |
| INFO | 结构变更 | `[NAS] DEALER created for new peer node-2 @ tcp://127.0.0.1:5002` |
| INFO | Worker 事件 | `[discoverPeers] restarting stopped worker for node-2` |
| WARN | 异常但可恢复 | `DEALER send to node-2 error: ...` |
| WARN | 退化路径 | `no DEALER for peer node-2, trying broadcast` |
| ERROR | 不可恢复错误 | `NAS monitor sync error: ...` |

### 8.2 统计暴露

`MultiLeaderReplication.getStats()`：

```typescript
{
  workers: number      // 当前 PerPeerWorker 数
  pending: number     // 全局 pending 消息数
}
```

`OutboxReplicationManager.getPeerReports()`：

```typescript
[
  {
    peerId: string,
    stats: {
      critical: number,   // criticalQueue 大小
      normal: number,     // normalQueue 大小
      ackPending: number, // 等待 ACK 数
      inBackoff: boolean  // 退避状态
    }
  }
]
```

### 8.3 热加载配置

通过环境变量 `ML_CONFIG_PATH=path/to/config.json` 指定热配置文件路径。

**热加载字段**（每 60 秒重新读取）：

```json
{
  "tickMs": 500,
  "maxBackoffSeconds": 60,
  "housekeepingIntervalMs": 86400000,
  "entryTTLDays": 14
}
```

运行时也可通过 `manager.updateConfig(partial)` 动态更新。

---

## 9 向后兼容

当前实现与 v1.2 的兼容性：

| v1.2 配置项 | v2.0 等价支持 | 说明 |
|-------------|--------------|------|
| `workerCount=0`（旧 Outbox） | 不适用 | 当前没有"旧 Outbox"——PerPeerWorker 就是唯一运行模式 |
| `syncBatchSize` | 不适用 | 没有 main_events sync，LMDB 直接读取 |
| `sendBatchSize` | `batchSize` | v2.0 默认 100，PerPeerWorker Phase 4 控制 |
| `maxAckWaitSeconds` | `ackTimeoutMs = tickMs × 3` | 默认 1500ms，可配置 |
| `outboxTickMs` | `tickMs` | 默认 500ms |
| `retentionDays` | `entryTTLDays` | 默认 14 天 |
| CURVE 目录 | 同 | 格式兼容 |
| `dbPath` | 同 | 路径兼容，内容格式不同（LMDB vs SQLite） |

---

## 10 参考

- `src/core/event-bus.ts` — ZMQ ROUTER/DEALER + NAS 动态监控
- `src/core/