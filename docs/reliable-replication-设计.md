# 可靠复制设计文档 (v3 — Outbox: Peer 独立退避方案)

## 架构

### 核心数据结构

两个内存集合，应用层管理每个 peer 的发送状态，完全取代进程级调度：

| 结构 | 类型 | 语义 |
|------|------|------|
| `peerSendTrack` | `Set<string>` | 可发送事件的 peer ID 集合。集合中的 peer 可以在当前 tick 被取出发送 |
| `peerBackoffTrack` | `Map<string, number>` | 退避中的 peer → 上次发送时间戳(ms)。超时后触发 dealer 重建 |

### 状态机

```
                      dealer 连接建立（notifyConnected）
   ┌───────────── peerSendTrack.add(id) ──────────────┐
   │             peerBackoffTrack.delete(id)            │
   │                                                    │
   │  取该 peer 最老的 pending 事件（fetchOldestPending）│
   │  sendFn(peerId)                                    │
   │                                                    │
   │  peerSendTrack.delete(id)                          │
   │  peerBackoffTrack.set(id, Date.now())              │
   │                                                    │
   └←── maxBackoffSeconds 超时 ──←── ACK 回来 ──────────┘
              │                          │
              │                          │
              ▼                          │
     recoverDealerFn(peerId)  ────────────┘
     → peerSendTrack.add(id)
```

### 单一 Worker

- 一个 `setTimeout` 递归循环，等上一个 tick 完全结束后再等 `tickMs` (500ms) 开始下一次
- 最外层 `try/catch` 保护，异常不终止 Worker
- 每个 tick 两个 Phase：
  - **Phase 1**: 遍历 `peerSendTrack`，取 oldest pending → send → 入退避
  - **Phase 2**: 遍历 `peerBackoffTrack`，超时 → `recoverDealerFn` → 恢复发送

## 与 EventBus 的关系

OutboxWorker **不管理 ZMQ**。发送和重建都委托给 EventBus：

```
sendFn(peerId, msgId, payload)
  └─ eventBus.send(peerId, transportMessage)
       └─ dealerSockets.get(peerId) → dealer.send(payload)

recoverDealerFn(peerId)
  └─ eventBus._recoverDealerByNodeId(peerId)
       └─ 重建 DEALER socket + CURVE 配置
```

## 持久化 — LMDB

`event_outbox` (LMDB):

| key | value |
|-----|-------|
| seq (number) | OutboxEntry { seq, msgId, targetNodeId, type, payload, createdAt, delivered, deliveredAt } |

- seq 从 `seqDb` 原子递增
- `delivered = true` 标记后不再重试
- Housekeeping 清理 `deliveredAt < now - 14d`

## 在线检测

每次发送前读 `.pub` 文件。文件不存在 → 从 `peerSendTrack` 永久移除（节点下线）。

## 热加载

构造函数接受 config 引用对象，配置变更通过引用自动生效：

```ts
interface HotConfig {
  outbox?: { maxBackoffSeconds?: number; tickMs?: number }
}
```

## Shutdown Hook

进程退出时删除自己的 `.pub` 文件，其他节点 Worker 检测到后自动停止发送。

## 修改文件

| 文件 | 修改内容 |
|------|----------|
| `outbox-replication.ts` | 核心实现：Outbox（LMDB）+ OutboxWorker（peerSendTrack/peerBackoffTrack）+ OutboxReplicationManager |
| `multi-leader-replication.ts` | 适配新接口，eventBus 传入 |
| `multi-leader-test-node.ts` | 传入 eventBus，移除旧的 removePeer/connectPeer 命令 |
