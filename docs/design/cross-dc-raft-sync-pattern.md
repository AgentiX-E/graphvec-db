# 跨数据中心 Raft 共识 + 异步数据同步设计模式

## A General-Purpose Architecture for Geo-Distributed, Sharded, Strongly-Consistent Systems

---

## 问题域

### 核心矛盾

| 约束 | 要求 | 现实 |
|------|------|------|
| 同 DC 数据一致性 | 线性一致（强一致） | ✅ Raft 在 LAN 内可达 5-50ms |
| 跨 DC 数据同步 | 最终一致即可 | ❌ Raft over WAN 延迟不可接受（200-500ms+） |
| 跨 DC 可用性 | 分区容忍 | ❌ Raft 跨 DC 时分区会导致多数派不可用 |
| 单点写入吞吐 | 线性扩展 | ❌ Raft 单 Leader 限制写入吞吐 |
| 系统复杂性 | 可运维 | ❌ 分布式系统常被指责过于复杂 |

### 目标

设计一种将 **同 DC 强一致** 与 **跨 DC 最终一致** 融合的架构：
- 每个 DC 内部是一个完整的 Raft 集群
- DC 之间通过异步事件流同步
- 节点可自由加入/离开 DC（动态分片）
- 跨 DC 的数据冲突可预测（LWW / CRDT）

---

## 1. 架构全景

```
                   ┌─────────────────────────────────────┐
                   │          Global View                 │
                   │  Consistency: 最终一致 (LWW / CRDT)  │
                   └─────┬──────────────┬───────────────┘
                         │              │
               ┌─────────▼──┐    ┌──────▼──────────┐
               │   DC-A     │    │     DC-B         │
               │  Consistency│    │  Consistency     │
               │  线性一致   │    │  线性一致        │
               └──────┬─────┘    └───────┬──────────┘
                      │                  │
              ┌───────┼───────┐  ┌───────┼────────┐
              │ Raft  │       │  │ Raft  │        │
              │ 共识   │ Outbox│  │ 共识   │ Outbox │
              ▼       ▼       ▼  ▼       ▼        ▼
           ┌────┐ ┌────┐ ┌────┐  ┌────┐ ┌────┐ ┌────┐
           │N1  │ │N2  │ │N3  │  │N4  │ │N5  │ │N6  │
           │    │ │    │ │    │  │    │ │    │ │    │
           └──┬─┘ └──┬─┘ └──┬─┘  └──┬─┘ └──┬─┘ └──┬─┘
              │      │      │       │      │      │
              └──┬───┴──┬───┘       └──┬───┴──┬───┘
                 │同DC  │              │      │
                 │Event │              │      │
                 │Bus   │  ┌───────────┘      │
                 │      │  │                  │
                 └──┬───┴──┼──────────────────┘
                    │ 跨DC │
                    ▼      ▼
              ┌────────────────────────────┐
              │     EventBus（全域通道）     │
              │  同 DC 实时 + 跨 DC 异步    │
              └────────────────────────────┘
```

注: 同 DC 内，Raft 是主一致性通道（线性一致），Outbox + EventBus
是最终一致性兜底通道。两条路径正交，互不阻塞。

### 层叠结构

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 2b: 同 DC 最终一致性兜底层                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Outbox (持久化队列) ··►  EventBus (同 DC)           │   │
│  │  用途: Raft 故障窗口兜底 · 脑裂恢复 · 成员变更容错     │   │
│  │  一致性: 最终一致 · 异步 · 幂等去重                    │   │
│  └──────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│  Layer 2a: 同 DC 共识层（主路径）                            │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Raft Consensus Group (3N / 5N)                      │   │
│  │  Leader → Follower replication                       │   │
│  │  Linearizable reads with barrier                     │   │
│  └──────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│  Layer 1: 本地状态机层                                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Sharded State Machine (可水平拆分)                   │   │
│  │  Each shard = independent Raft group                 │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. 核心概念

### 2.1 Shard（分片）

一个 shard 是承载一段数据范围的最小单元。每个 shard 由一组副本节点（一个 Raft Group）维护。

```
Shard Allocation:
  Data Key Space [0, 2^64)  ← 一致性哈希环
     ├── Shard 0: hash range [0, 2^63)  → Raft Group A {N1, N2, N3}
     └── Shard 1: hash range [2^63, 2^64) → Raft Group B {N4, N5, N6}
```

每个 shard 的特征：
- **独立 Raft 日志**: 每个 shard 有自己的一套 Append-Only 日志
- **独立 Leader**: 每个 shard 独立选举 Leader
- **独立成员**: 每个 shard 的副本节点可以不同
- **热点隔离**: 一个 shard 的负载不影响其他 shard

### 2.2 Raft Group（同 DC 共识组）

一组在同一 DC 内维护某个 shard 一致性的节点集。典型部署：3 副本（容忍 1 故障）。

```
写入路径（shard 级别）:
  Client → Shard Leader
    ├── 写入 Leader 本地 Raft 日志
    ├── 并行发送 AppendEntries 到 Followers
    ├── 收到多数确认 → commit
    ├── 状态机 apply
    └── 返回客户端

读取路径（shard 级别）:
  Client → Any Shard Member
    ├── Read Index (Leader) / Barrier
    └── 在状态机最新快照上读取
    └── 返回客户端（线性一致）
```

### 2.3 Outbox（跨 DC 异步复制队列）

每个 shard 节点维护一个持久化 Outbox 队列。当 Raft 提交一个写入后，该写入被追加到 Outbox。

```
           Raft commit
               │
               ▼
    ┌─────────────────────┐
    │   State Machine     │ ← 应用写入到本地状态机
    │   (当前节点)         │
    └────────┬────────────┘
             │
             ▼
    ┌─────────────────────┐
    │   Outbox Queue      │ ← 持久化（LMDB / RocksDB / SQLite）
    │   { seq, msgId,     │
    │     targetDC, type, │
    │     payload }       │
    └────────┬────────────┘
             │ (异步后台)
             ▼
    ┌─────────────────────┐
    │   Outbox Worker     │ ← 每个目标 DC 一个 Worker
    │   Per-DC 独立退避    │
    └────────┬────────────┘
             │
             ▼
    ┌─────────────────────┐
    │   EventBus / MQ     │ ← 跨 DC 传输通道
    └─────────────────────┘
```

### 2.4 EventBus（跨 DC 传输通道）

信息通道，提供至少一次投递保证。可以用：
- ZMQ ROUTER/DEALER（低延迟点对点）
- Kafka/Pulsar（高吞吐，持久化）
- gRPC stream（标准 RPC 模式）

```
架构选择指南:
  ┌────────────────┬─────────────────────┬─────────────────────┐
  │                │ 延迟敏感 (1-10ms)    │ 吞吐优先 (10000+ TPS)│
  ├────────────────┼─────────────────────┼─────────────────────┤
  │ 同 DC 节点     │ ZMQ ROUTER/DEALER   │ Kafka/Pulsar        │
  │ 跨 DC          │ gRPC stream         │ Kafka over WAN      │
  │ 边缘节点→DC    │ MQTT                │ Kafka/Pulsar        │
  └────────────────┴─────────────────────┴─────────────────────┘
```

### 2.5 同 DC 内的最终一致性兜底：Raft 的双通道保障

当前架构中，Raft 是**同 DC 内的主一致性通道**。但 Raft 不是万能的——它也有自己的故障窗口和盲区：

| Raft 的盲区 | 描述 | 最终一致性兜底方案 |
|-----------|------|------------------|
| Leader 切换期间写入黑窗口 | 新 Leader 选出前（election timeout ~300ms），旧 Leader 可能已不可用 | Outbox 已持久化未发送的写入 → 新 Leader 上任后从 Outbox 恢复 |
| 网络分区（脑裂） | 少数派节点写入被旧 Leader 接受但未复制到多数 | 这个分区节点上的 Outbox 保持待发送状态 → 分区恢复后重传给新 Leader |
| 操作超时但实际已提交 | Raft propose 超时返回 false，但日志条目在多数节点已提交 | Client 重试时，幂等去重（msgId）防止重复 |
| 成员变更期间的短暂不一致 | 配置变更日志应用前，旧配置的多数派可能不接受新节点 | EventBus 广播持续发送，成员变更完成后按新 Raft 配置复制 |
| 节点长时间宕机恢复 | Raft 日志被截断，需通过快照 + Outbox 回放重建 | Outbox 的 TTL（14天）保证快照后遗漏的变更不丢失 |

#### 兜底数据流

```
                        同 DC 节点 A（Leader）
                        ┌───────────────────────────┐
                        │  Client 写入                 │
                        │     │                       │
                        │     ▼                       │
                        │  Raft State Machine         │
                        │  (主路径)                    │
                        │     │                       │
                        │     ├───────────────────────┤
                        │     │ Outbox（兜底路径）      │
                        │     │ 持久化队列 + 异步广播   │
                        └─────┼───────────────────────┘
                              │ EventBus / ZMQ
                              │
           ┌──────────────────┼──────────────────┐
           │                  │                  │
           ▼                  ▼                  ▼
    ┌────────────┐   ┌────────────┐   ┌────────────┐
    │ 节点 B     │   │ 节点 C     │   │ 节点 D     │
    │ (Follower) │   │ (Follower) │   │ (新加入)   │
    │            │   │            │   │            │
    ├────────────┤   ├────────────┤   ├────────────┤
    │ Raft 日志  │   │ Raft 日志  │   │ Raft 日志  │ ← 主路径
    │ Outbox     │   │ Outbox     │   │ Outbox     │ ← 兜底
    └────────────┘   └────────────┘   └────────────┘
```

**主路径**: Raft 的 AppendEntries → log matching → commit → apply
**兜底路径**: Raft commit 后 → Outbox 入队 → EventBus 广播 → 所有节点接收

兜底路径的特殊职责：

1. **主路径不可用时**: 如果某个 follower 因为网络抖动没收到 AppendEntries，它仍然会从 EventBus 收到 Outbox 广播的变更事件 → apply 到状态机
2. **双通道校验**: 如果 Raft 复制和 Outbox 广播都到达，接收方通过 msgId 去重
3. **恢复引导**: 长时间宕机的节点重启后，先通过 Raft 快照 + 日志追赶，然后通过 Outbox 回放 TTL 窗口内的遗漏变更

#### 双通道写入路径

```
Client 写入请求到达节点 A（当前 shard 的 Leader）

Step 1: Raft 主路径写入
  ├── 写入 A 的 Raft 日志
  ├── 并行发送 AppendEntries 到 B, C
  ├── 收到多数 ACK → commit
  └── apply 到状态机

Step 2: Outbox 兜底写入
  ├── 步骤 1 成功后，将写入 payload 追加到本地 Outbox（LMDB/RocksDB）
  │    └── Outbox 条目: { msgId, seq, type, payload, createdAt }
  ├── OutboxWorker 异步广播到 B, C, D
  │    └── EventBus.send(nodeId, transportMessage)
  └── 返回"写入成功"给客户端（不等待 Outbox 广播完成）

接收方节点 B / C / D:

  收到 EventBus 消息:
    ├── DedupRing 检查: msgId 已处理过？→ 跳过
    ├── 检查本地 Raft 状态: 该变更是否已通过 Raft apply？→ 如果是，跳过
    └── 如果 Raft 还没 apply 该变更 → 直接 apply 到本地状态机
                      │
                      这个情况不常见——通常 Raft 先到。
                      但如果发生（election 等），EventBus
                      扮演了保险角色。
```

#### 双通道的幂等保证

为什么不会产生重复数据或冲突：

| 情况 | 处理方式 |
|------|---------|
| Raft 和 EventBus 都送达同一变更 | msgId 去重，后者被丢弃 |
| Raft 先到，EventBus 后到 | DedupRing 丢弃 |
| EventBus 先到，Raft 后到 | EventBus apply 后，Raft apply 时检查：msgId 入日志但状态机已存在该操作 → 幂等执行（UPSERT 语义） |
| Raft 失败（propose false） | Outbox 不会写入（在 commit 之后才入 Outbox），确保本地和 Outbox 状态一致 |
| 只有 EventBus 到达（Raft 确实失败） | 理论上不应发生（Outbox 在 Raft commit 后才写入）。如果发生，说明 Raft 日志有损坏 → 应报警 + 通过全量快照恢复 |
| 节点重启后 Raft log 被截断 | 通过 Outbox TTL 回放补回 |

#### 兜底场景的具体时序

**场景：Raft Leader 切换（~300ms 黑窗口）**

```
时间 ──────────────────────────────────────────────────────►

时刻 T0: 旧 Leader A 写入 key=X, value=1
         ├── Raft commit 成功
         ├── Outbox 已入队，准备广播
         └── 返回客户端"写入成功"

时刻 T1: 旧 Leader A 宕机（网络/进程故障）
         ├── Outbox 中的条目尚未发送（A 已不可用）
         └── 节点 B, C 开始选举新 Leader

时刻 T2: 节点 B 当选为新 Leader
         ├── B 的 Raft log 包含 key=X, value=1（多数已确认）
         └── B 正常服务

时刻 T3~T4: 旧 Leader A 恢复
         ├── A 的 Raft 日志：已截断（behind leader）→ 通过快照追赶
         ├── A 的 Outbox：未发送的条目 → 作为 follower 无法发送（不是 leader）
         └── 结论：没有数据丢失，A 通过 Raft 日志追赶恢复

风险点:
  T0~T1 之间：如果旧 Leader A 在 Raft commit 后、Outbox 入队前宕机
  → Outbox 没有此条目 → 其他节点通过 Raft 日志复制已获得数据
  → 不丢失
```

**场景：网络分区（脑裂）**

```
时间 ──────────────────────────────────────────────────────►

节点拓扑: A(Leader), B, C (同 DC, 同一机架)

时刻 T0: 网络分区
  ├── 多数派 {B, C} → 选举新 Leader（假设 B 当选）
  └── 少数派 {A} → 旧 Leader 降级，写入被拒绝

时刻 T1~T2: 分区期间
  多数派 {B, C}: 正常 Raft 服务 → Outbox 广播新写入
  少数派 {A}: 写入被 Raft 拒绝，但 EventBus 仍可达
             → A 通过 EventBus 接收 B 的变更并 apply

时刻 T3: 分区恢复
  ├── A 重新加入 Raft group（通过成员变更日志）
  ├── A 的 Raft 状态：落后 Leader B → 快照同步 + 日志追赶
  └── EventBus 兜底：A 在分区期间已通过 EventBus 收到部分变更，
      这些变更在 Raft 日志追赶时通过幂等去重，不重复 apply

结论：
  EventBus 在脑裂期间提供了额外的数据通道，减少了 Raft 恢复后的
  追赶量。但不能替代 Raft 日志追赶（Raft 有严格的状态机一致性检查）。
```

### 2.6 跨 DC 冲突解决

当 DC-A 和 DC-B 在同一个数据 key 上产生并发写入时：

```
时间轴:
  DC-A: 写入 key=X, value=A  (HLC: 100)
  DC-B: 写入 key=X, value=B  (HLC: 99)   ← 并发！
              │
              ▼
        双方 Outbox 将写入广播到对端
              │
         ┌────▼──────────┐
         │ 冲突解决策略    │
         ├────────────────┤
         │ LWW:           │ → DC-A 胜出 (HLC 100 > 99), value=A 保留
         │ CRDT:          │ → merge(A, B), 结果取决于 CRDT 类型
         │ App-Conflict:  │ → 写入冲突事件队列，应用层决定
         │ Reject:        │ → 两败俱伤，写入均被抛弃
         └────────────────┘
```

---

## 3. 应用场景

### 场景 1: 全球分布式图数据库

节点 A（美西）写入一个关系边 → Raft 在美西三个副本中确认 →
Outbox 入队 → EventBus 推送 → 欧洲节点收到并应用。

**为什么 Raft 跨 DC 不行**: 美西到欧洲 RTT 约 200ms，如果跨 DC Raft，
每次写入等 ACK 需要 200ms。而当每个 DC 独立 Raft 时，美西写入 20ms 完成。

### 场景 2: 跨区域用户身份系统

```
US-East (主写入区): Raft 3 副本
EU-West (读取区): Raft 3 副本 (只读 + Outbox 接收)

用户注册:
  1. 用户在 US 注册 → US Raft 写入
  2. Outbox 异步复制到 EU (T+1s)
  3. EU 用户登录时，可能在未同步窗口内
     → 降级提示"检测到账户来自其他区域，数据同步中..."
```

### 场景 3: 实时竞价 (RTB) 广告系统

```
每个广告交易平台 (DSP) 一个 Raft 集群
  ├── 竞价胜出后 Raft 写入
  └── Outbox → EventBus → 其他区域 DSP
      └── 用于流量分配和预算控制
```

### 场景 4: 多活配置/功能开关

```
全局配置中心:
  北京 DC Raft + 异步同步到硅谷 DC
  配置变更后 ~5s 内全球生效
  不要求严格一致性（配置读旧版本 5s 没有问题）
```

### 场景 5: 协作文档编辑 (CRDT)

```
每个区域一个 Raft 组
  本地写入: Raft 确认 → 实时推送其他用户
  跨区域同步: CRDT merge → Raft 再次确认
```

### 场景 6: 金融风控实时同步

```
交易中心（新加坡）: Raft 产出风控事件
  1s 内同步到:
    ├── 纽约合规 (Outbox → EventBus)
    ├── 伦敦清算 (Outbox → EventBus)
    └── 香港业务 (Outbox → EventBus)
```

### 场景 7: 大规模多人在线游戏状态同步

```
每个游戏区服一个 Raft 集群:
  ├── 本地玩家状态变更：Raft 写入 → 实时同步给同区玩家
  ├── 跨服数据（排行榜、交易行）：Outbox → EventBus → 其他服务器
  └── 游戏服务器热迁移：Raft 成员变更 + Outbox 确保不丢消息
```

### 场景 8: 全球分布式锁/租约服务

```
每个区域部署锁服务 Raft 集群:
  本地租约: Raft 确认
  跨区域死锁检测: Outbox 通知其他区域
  租约超期: 本地 Raft 清理 + Outbox 广播事件
```

---

## 4. 关键技术实现

### 4.1 分片自动均衡

```
触发条件:
  - 某个 shard 的 QPS 超过阈值 (如 5000 ops/s)
  - 某个 shard 的数据集超过阈值 (如 100GB)

分片分裂 (Split):
  Shard [0, 2^64)  →  Shard-L [0, 2^63) + Shard-R [2^63, 2^64)
  1. Leader 探测到过载
  2. 创建新 Raft Group
  3. 数据迁移：拷贝范围数据到新 shard（流式）
  4. 元数据更新：hash ring 重新分配
  5. Outbox 拆分：原 shard Outbox 中的事件按 key 分发到新 shard

分片合并 (Merge):
  反向操作：两个相邻 shard 合并为一个
  条件：两个 shard 的负载都低于阈值
```

### 4.2 Outbox 实现细节

```
Outbox 队列（持久化存储）:

┌──────┬─────────┬──────────┬──────────┬───────────┬───────────┐
│ seq  │ msgId   │ originDC │ type     │ payload   │ delivered │
├──────┼─────────┼──────────┼──────────┼───────────┼───────────┤
│ 1    │ uuid-1  │ DC-A     │ upsert   │ {...}     │ false     │
│ 2    │ uuid-2  │ DC-A     │ delete   │ {...}     │ true      │
│ 3    │ uuid-3  │ DC-A     │ upsert   │ {...}     │ false     │
└──────┴─────────┴──────────┴──────────┴───────────┴───────────┘

OutboxWorker（后台发送线程）:
  while running:
    for each peerDC in targetDCs:
      if peerDC is in sendTrack:
        entry = outbox.fetchOldestPending(peerDC)
        if entry:
          send(peerDC, entry)
          ackTracker[entry.msgId] = Date.now()
          backoffTrack[peerDC] = Date.now()
          sendTrack.delete(peerDC)
      if peerDC in backoffTrack:
        if elapsed > maxBackoffSeconds:
          recoverConnection(peerDC)   ← 重建传输通道
          sendTrack.add(peerDC)
          backoffTrack.delete(peerDC)
    sleep(tickMs)

  # 退避超时按拓扑分档（Raft 兜底场景要求同 DC 快速恢复）:
  #   同 DC:   maxBackoffSeconds = 3s
  #   跨 DC:   maxBackoffSeconds = 60s
  #   边缘:    maxBackoffSeconds = 300s
  #
  # 同 DC 短退避的核心原因：
  #   同 DC Outbox 的主要作用是 Raft 兜底——当 Raft 因为网
  #   络抖动、Leader 切换等短暂故障而未及时复制时，Outbox +
  #   EventBus 要在秒级内补上。长退避会削弱兜底的时效性。
  #   而跨 DC 本就可以容忍分钟级延迟，长退避 + 指数抖动更合适。

消��端:
  onReceive(type, payload, originDC):
    msgId = extractMsgId(payload)
    if dedupRing.has(msgId):
      return                               ← 去重
    dedupRing.add(msgId)
    applyToLocalStateMachine(type, payload)
    sendAck(msgId, originDC)               ← ACK 回执
```

### 4.3 幂等消费保障

| 层 | 机制 | 保护范围 |
|----|------|---------|
| 消息去重 | DedupRing (内存循环缓存) | 短时间窗口 (< N 条消息) |
| 持久化去重 | LMDB msgId-TTL 索引 | 长时间窗口 (TTL 内) |
| 操作幂等 | UPSERT 语义 (CREATE OR REPLACE) | 同一操作的多次执行 |
| 递归保护 | `_applyingRemote` 标志 | 防止消息回环 |

### 4.4 节点动态加入/离开

```
节点加入:
  1. 新节点发布身份证明到集群
  2. Raft 成员变更 → 日志复制 → 状态机同步快照
  3. Outbox 初始化：从当前 seq 开始接收
  4. EventBus 连接：创建 ROUTER + DEALER

节点离开:
  1. 优雅退出：删除身份证明
  2. OutboxWorker 检测到 peer 离开 → 停止发送
  3. Raft 成员变更 → 副本数减少
```

### 4.5 跨 DC 同步的 TTL 与 Housekeeping

```
Outbox 条目 TTL: 14 天（可配置）
Housekeeping:
  每 24h 清理 delivered=true 且 deliveredAt < now - TTL 的条目

原因:
  - Outbox 保证"至少一次投递"，不需要无限保留
  - TTL 后如果 DC 还未收到，说明 DC 已宕机 > TTL，
    服务端应接受该 DC 下线
  - 恢复时通过全量快照同步（而不是回放所有 Outbox 条目）
```

---

## 5. 部署与运维

### 5.1 硬件推荐

| 角色 | CPU | 内存 | 存储 | 网络 |
|------|-----|------|------|------|
| Raft 节点 | 8 core+ | 32GB+ | NVMe SSD (Raft log) | 10Gbps+ LAN |
| Outbox Worker | 4 core | 8GB | SSD (LMDB) | 1Gbps |
| EventBus 节点 | 4 core | 16GB | 不重要 | 10Gbps+ |

### 5.2 配置参数速查

```
┌─────────────────────┬─────────────────────┬────────────────────┐
│ 参数                │ 建议值              │ 调节逻辑            │
├─────────────────────┼─────────────────────┼────────────────────┤
│ Raft heartbeat      │ 50-150ms            │ 同 DC LAN 用 50ms   │
│ Raft election       │ 300-1000ms          │ > heartbeat × 3-5  │
│ Outbox tick         │ 100-500ms           │ 越低延迟越小        │
│ Outbox 退避上限      │ 30-60s              │ 弱网环境加大        │
│ DedupRing 容量      │ 10000-100000        │ 吞吐 × 接收窗口     │
│ EventBus HWM        │ 1000-10000          │ 内存 × 网络带宽     │
│ CURVE key 刷新      │ 每次连接重建         │ 无需定期刷新        │
│ Outbox TTL          │ 14天                │ 与快照频率配合      │
└─────────────────────┴─────────────────────┴────────────────────┘
```

### 5.3 监控指标

```
关键指标（需全部可视化）:
  ┌──────────────────┬──────────────────────┬──────────────────┐
  │ 指标              │ 来源                  │ 告警阈值          │
  ├──────────────────┼──────────────────────┼──────────────────┤
  │ Raft term变更     │ Raft 状态机           │ > 5/min           │
  │ Outbox pending 数 │ OutboxStore          │ > 10000           │
  │ ACK 超时率         │ OutboxWorker         │ > 5%              │
  │ EventBus backlog   │ ZMQ 内部             │ > HWM × 0.8      │
  │ 跨 DC 延迟         │ 消息时间戳计算        │ > 10s             │
  │ Outbox 重试次数     │ OutboxWorker         │ > 100/分钟        │
  │ 去重率              │ DedupRing           │ > 1% (正常应 <0.1%)│
  └──────────────────┴──────────────────────┴──────────────────┘
```

### 5.4 灾难恢复

```
场景: DC-A 完全宕机 30 分钟后恢复

恢复步骤:
  1. DC-A 节点重启，Raft 选举（无其他副本，自动成为 Leader）
  2. DC-A 需要从 DC-B 获取 30 分钟内的遗漏变更
     └── 方案 A（推荐）: 从 DC-B 拉取全量快照（更快）
     └── 方案 B: DC-B 的 Outbox 有 14 天 TTL，回放未同步条目
  3. 全量快照应用后，DC-A 恢复服务
  4. DC-B 的 Outbox 检测到 DC-A 恢复 → 继续增量同步
  5. 在快照前已同步的 Outbox 条目 → DedupRing 去重

全量快照切换时机:
  Raft log 累积到阈值（如 10K entries）或时间周期（如 24h）
  → 创建快照 → 截断 Raft log → 通过 EventBus / 对象存储分发
```

### 5.5 性能推演

```
3 节点同 DC + 跨 DC 异步复制:

          ┌─────────────────────────────────────┐
          │        同 DC Raft 写入延迟            │
          ├─────────────────────────────────────┤
          │  3节点, NVMe, 10Gbps                │
          │  P50: 8ms    P99: 25ms    P999: 40ms│
          └─────────────────────────────────────┘
                        │ Outbox 异步
                        ▼
          ┌─────────────────────────────────────┐
          │       跨 DC 同步延迟                  │
          ├─────────────────────────────────────┤
          │ US-EU:      P50  200ms  P99 500ms   │
          │ US-APAC:    P50  150ms  P99 300ms   │
          │ EU-APAC:    P50  250ms  P99 600ms   │
          └─────────────────────────────────────┘
                        │ Outbox 批量发送
                        ▼
          ┌─────────────────────────────────────┐
          │       跨 DC 写入吞吐                  │
          ├─────────────────────────────────────┤
          │  单 Outbox batch=10:  ~5000 ops/s    │
          │  多 shard × 多 Outbox:  ~50000 ops/s │
          └─────────────────────────────────────┘
```

---

## 6. 与替代方案的对比

| 方案 | 同 DC 一致性 | 跨 DC 一致性 | 跨 DC 延迟 | 写入吞吐 | 实现复杂度 |
|------|-------------|-------------|-----------|---------|-----------|
| **本模式（Raft+Outbox）** | 线性一致 | 最终 （LWW/CRDT） | 异步 | 高 | 中 |
| 单个大 Raft 跨 DC | 线性一致 | 线性一致 | 200-500ms | 低 | 低 |
| 全 CRDT 无 Raft | 最终一致 | 最终一致 | 异步 | 极高 | 低 |
| Spanner (TrueTime) | 线性一致 | 线性一致 | 50-100ms | 中 | 极高 |
| Cassandra (Quorum) | 可调 | 可调 | 取决于 Quorum | 极高 | 中 |

### 何时不应使用本模式

- **跨 DC 需要强一致性**: 应使用 TrueTime 类方案或单 Raft 跨 DC
- **单 DC 轻量应用**: 纯 Raft 就够
- **纯事件流场景**: Kafka 更合适

---

## 7. 模式要点归纳

```
"每 DC 内 Raft 做过线一致，同 DC Outbox + EventBus 做最终兜底，跨 DC Outbox + EventBus 做异步同步"

┌─────────────────────────────────────────────────────────────┐
│ 同 DC 主路径: Raft · 线性一致 · 5-50ms · 多数派才成功       │
│ 同 DC 兜底:   Outbox · 最终一致 · 异步 · Raft 故障窗口容错   │
│ 跨 DC:        Outbox · 最终一致 · 异步 · LWW/CRDT 冲突解决  │
│ 隔离:         Raft 路径不经过 EventBus（正交），互不影响      │
│ 幂等:         三层保护（DedupRing + skipReplication + UPSERT）│
│ 拓扑退避:     同 DC 3s · 跨 DC 60s · 边缘 300s              │
│ 冲突:         LWW (HLC) · CRDT · 应用层自定义                │
│ 扩展:         分片 + 自动均衡 + 动态节点加入/离开             │
└─────────────────────────────────────────────────────────────┘
```

---

*本文档从 OverGraph 的实现中提取泛化而成，不依赖任何特定编程语言或库。*
*所有接口规范和配置推荐均为通用建议，可根据实际情况调整。*
