# AgentiX GraphVec 深度审查报告 — 核心引擎层 (Agent A)

> 审查范围: src/core/ 全部 8 个核心文件
> 严重性分级: P0(阻塞/安全) | P1(严重) | P2(一般)

---

## File: src/core/graph-engine.ts

### 发现 1: [P0] `exportSnapshot()` / `importSnapshot()` — 未对部分存储实现做守卫，静默返回空 Buffer
- **严重性**: P0
- **描述**: `exportSnapshot()` 里检查了 `this.storage.exportSnapshot` 是否存在，但方法是可选接口（`StorageProvider` 接口未定义它）；`importSnapshot()` 在方法不存在时什么都不做。问题是 OverGraphStorage 中这两个方法通过 `(this._db as any).exportSnapshot()` 调用，可能抛 `TypeError` 并通过 `!` 的 non-null assertion（`this._db!`）传播未捕获异常。
- **影响**: 如果底层 `.exportSnapshot()` 返回非 function 的 falsy 值，会在 `Buffer.from(falsy)` 处抛异常。
- **建议**: 增加 try-catch 并抛出描述性错误，或在 `StorageProvider` 接口中显式声明，而不是靠运行时 duck-typing。

### 发现 2: [P1] `getEdge()` 后备路径使用了 `neighbors()` 的返回值但丢失了边属性
- **严重性**: P1
- **描述**: `getEdge()` 在 `this.storage.getEdge()` 返回 null 时，走后备路径通过 `neighbors()` 查找匹配边，但返回的 `EdgeRecord` 中 `props` 被硬编码为 `{}`（空对象），时间戳用 `match.validFrom` 代替 `match.createdAt`。这样既丢失了边的属性信息，也使用了不正确的字段。
- **影响**: 查询边属性时可能返回不完整数据，导致上层应用判断错误。
- **建议**: `neighbors()` 返回的 `NeighborEntry` 不应有 `props` 字段（storage-provider 接口），但如果需要完整属性建议只依赖 `storage.getEdge()` 返回的数据，去除 fallback 路径，或改用 `storage.getEdge()` 的二次调用。

### 发现 3: [P1] `upsertNode` / `upsertEdge` 在 schema 校验失败后抛出 Error 但本地状态可能已部分改变
- **严重性**: P1
- **描述**: `upsertNode` 中，`this.storage.upsertNode()` 先于 `_validate` 执行——实际上校验在 storage 调用**之前**执行，所以这个具体问题不存在。但 `upsertEdge` 也是校验在前 storage 在后，所以模式上是对的。但注意 `upsertNode` 中 `this._labelIndex.addNode()` 在 storage 成功之后执行，而 `this._labelIndex.setNode()` 等未在失败时回滚——如果 storage 成功但后面 replication 失败，label index 已经改变。
- **影响**: label index 与 storage 可能不一致。
- **建议**: 对 `_labelIndex` 的修改也应纳入一致性考虑，添加失败回滚机制或延迟到操作完全成功后再更新索引。

### 发现 4: [P1] `close()` 没有清理 LRU 缓存，可能导致内存泄漏
- **严重性**: P1
- **描述**: `close()` 只调用了 `this.storage.close()` 和设置 `_isOpen = false`，但没有调用 `this._neighborCache.clear()`。LRU 缓存在 `close()` → `reopen()` 场景下，旧条目可能残留。
- **影响**: 在热加载/重启环境中，LRU 缓存可能保留过期数据。
- **建议**: 在 `close()` 里添加 `this._neighborCache.clear()`。

### 发现 5: [P2] `batchUpsertNodes()` 构建 `nameToId` 映射时做了多余的后备扫描
- **严重性**: P2
- **描述**: 先通过 `storage.batchUpsertNodes()` 返回 ids，然后遍历 ids 调用 `storage.getNode()` 逐个查询构建 name→id 映射。如果所有节点都是新的，这个循环是必要的。但后备路径又用索引推测映射（`nameToId[inputs[i].name] = ids[i]`），这个后备逻辑**覆盖**了前面的查询结果——当存在同名节点时，后备逻辑写入了错误的映射。
- **影响**: 对同名节点（upsert 语义），返回的 name→id 映射可能指向错误（旧）的 ID。
- **建议**: 后备逻辑应考虑已经存在的映射，只填充缺失的条目：`if (nameToId[...] === undefined)` 再赋值。

### 发现 6: [P2] `vectorSearch` 通过 JSON.stringify 构造存储层查询字符串
- **严重性**: P2
- **描述**: `vectorSearch()` 将查询参数序列化为 JSON 字符串再传给 storage。这是不必要的中间序列化，增加 GC 压力且丢失类型信息（如 Float32Array 在 JSON 中变成数组）。下层最终还需要反序列化。
- **影响**: 每个向量搜索调用都要序列化/反序列化；大向量（高维）场景下 GC 压力大。
- **建议**: 如果 StorageProvider 接口支持结构化参数，直接传对象；如果必须传字符串，建议用更高效的序列化（如 MessagePack）。

### 发现 7: [P2] `_emit` 静默吞掉 EventBus 异常
- **严重性**: P2
- **描述**: `_emit()` 后备路径 `catch { /* bus not initialized */ }` 不输出任何日志。如果开发者预期 EventBus 存在但未能正确初始化，这里会静默丢失关键事件。
- **影响**: 调试困难，事件丢失时没有任何线索。
- **建议**: 至少加一条 debug 级别的日志输出：`catch { console.debug('...') }`。

### 发现 8: [P2] `neighbors()` 中每遍历一条边都对 `entry.nodeId` 查一次 `getNode`
- **严重性**: P2
- **描述**: `neighbors()` 内循环中对每个邻居调用 `this.storage.getNode(entry.nodeId, true)`。在高度数节点（如社交网络中的大 V）下，这导致对存储层的大量单点查询。
- **影响**: 邻居数量大时（>10000）性能显著下降。
- **建议**: 使用 `batchGetNode(ids)` 批量查询（如果 storage 支持）或在循环外构建去重 id 列表后统一查询。

---

## File: src/core/outbox-replication.ts

### 发现 9: [P1] `process.exit(0)` 在 library 代码中的 shutdown hook 里
- **严重性**: P1
- **描述**: `registerShutdownHook()` 在 clean up 后调用了 `process.exit(0)`。这是 library 代码，不应决定进程退出。如果作为库被嵌入更大的 Node.js 应用，收到 SIGTERM/SIGINT 时 kill 了主进程。
- **影响**: 可能导致宿主进程被意外终止。
- **建议**: 移除 `process.exit(0)`，只做清理。由宿主进程自行决定退出策略。

### 发现 10: [P1] `Outbox.fetchOldestPending()` / `fetchPendingByPeer()` / `getPendingCountForPeer()` / `getPendingCount()` / `cleanDeliveredBefore()` — 全量遍历 LMDB 导致 O(n) 扫描
- **严重性**: P1
- **描述**: 所有 Outbox 查询方法都使用 `this.db.getRange({ start: 1 }).forEach(...)` 遍历全部记录。LMDB 在百万级条目下，每次调用都全扫描。
- **影响**: 随着 outbox 增长，性能线性下降。`cleanDeliveredBefore()` 在高 TPS 系统下可能导致扫描耗时数秒。
- **建议**: Outbox 应使用 LMDB 的二级索引（通过 key 设计按 peerId + delivered 字段做范围查询），或在每条记录 key 中包含 targetNodeId 和 sequence。

### 发现 11: [P1] `PerPeerWorker._tick()` 中的 `this.running` 检查存在的竞态条件（Racy `this.running` 守卫模式多次通过）
- **严重性**: P1
- **描述**: `_tick()` 中有 4 处 `if (!this.running) return;` 守卫检查。但这些检查纯粹是内存读写，没有锁保护。在 `stop()` 设置 `this.running = false` 时，多个 `_tick()` 可能已经通过了这些守卫并在执行操作。因为被 setInterval 启动的 async 函数可能重叠（当 tick 中有 await 操作时）。
- **影响**: `stop()` 后仍可能有 pending 操作执行，访问已关闭的资源（如已关闭的 outbox）。
- **建议**: 使用 `if (!this.running) return` 加一个可选的 `this._busy` 标志来阻止重叠执行，或在 async 函数开始时检查 running 并在关键操作前再次检查。

### 发现 12: [P2] `addMessage()` 中 `msgId` 从 data 提取但不为空检查，可能生成重复 msgId
- **严重性**: P2
- **描述**: `addMessage()` 中 `msgId = data['msgId'] as string ?? ...` — 如果 `data.msgId` 是 `undefined`，`as string` 类型断言不改变运行时行为，且 `??` 会触发生成新 ID。但如果 data.msgId 是 `""` 空字符串，`??` 不会触发（空字符串不是 null/undefined），导致多个消息有相同的空字符串 msgId。
- **影响**: 高负载下的消息去重失效。
- **建议**: 改为 `data['msgId'] ? (data['msgId'] as string) : crypto.randomUUID()`。

### 发现 13: [P2] `PerPeerWorker._tick()` ACK 超时处理中 break 导致每次只处理一个超时，长尾延迟
- **严重性**: P2
- **描述**: ACK 超时检测循环中有一个 `break` 语句："一轮最多处理一个 timeout"。如果多个消息同时超时，需要多轮 tick 才能全部回收，增加恢复延迟。
- **影响**: 大规模消息丢失时恢复缓慢。
- **建议**: 去掉 `break`，一次性回收所有超时消息，但要处理 Map 在迭代中删除的问题（用 Array.from + for-of）。

### 发现 14: [P2] `OutboxReplicationManager` 的 config 热加载使用 `Object.assign` 直接覆盖运行时对象
- **严重性**: P2
- **描述**: `loadConfigFile()` 使用 `Object.assign(this.config, partial)` 修改运行时配置。但 `PerPeerWorker` 创建时已捕获了 `config.tickMs` 等参数。热加载后现有 Worker 不更新其内部 `_tickMs` getter 返回值。
- **影响**: 热加载配置对现有 Worker 无效，只有新创建的 Worker 受新配置影响。
- **建议**: 热加载配置后，应通知/重启现有 Worker（通过 `updateConfig()` 方法或 broadcast 事件）。

---

## File: src/core/multi-leader-replication.ts

### 发现 15: [P2] `replicate()` 总是返回 `{ success: true, acksReceived: 0 }`，从未等待 ACK
- **严重性**: P2
- **描述**: `replicate()` 是一个 fire-and-forget 方法，写入 Outbox 后立即返回，声称成功。`WriteResult.acksReceived` 始终为 0，但 `GraphEngine` 在结果 `!success` 时记录日志。这种错误日志永远不会触发，所有 Outbox 复制"看上去永远成功"。
- **影响**: 无法区分真正成功和队列积压后丢失的消息。调用方被虚假的成功反馈欺骗。
- **建议**: 方法签名应改为 fire-and-forget（返回 `void` 或 `Promise<void>`），或在 Outbox 层集成异步 ACK 回调机制追踪真实交付状态。

### 发现 16: [P2] `MultiLeaderReplication.notifyAcked()` 错误地调用了 `notifyConnected()`
- **严重性**: P2
- **描述**: `notifyAcked(peerId)` 的实现是 `this.manager.notifyConnected()`，应调用 `this.manager.notifyAcked(peerId)`。同样，`OutboxReplicationManager.notifyAcked()` 内部也错误地调用了 `worker.notifyConnected()` 而非 `worker.notifyAcked()`。
- **影响**: 收到 ACK 后，Worker 的 ackTracker 不会被清理，acks 永久留存在 Map 中，导致退避状态永不清除。
- **影响**: 收到 ACK 后退避不会解除，该 peer 的后续消息发送延迟增加。
- **建议**: 修复 `OutboxReplicationManager.notifyAcked()` 和 `MultiLeaderReplication.notifyAcked()` 的实现，调用正确的 `worker.notifyAcked()`。

### 发现 17: [P2] `OutboxReplicationManager.registerShutdownHook()` 中重复注册 `process.on('exit', ...)`
- **严重性**: P2
- **描述**: 在 MultiLeaderReplication 内部，`registerShutdownHook()` 被调用一次。但如果多次调用 `start()` / `stop()` / `start()`，会多次注册 `SIGTERM`、`SIGINT` 和 `exit` 处理器。
- **影响**: 多次启动后，进程退出时 `_deleteMyPubKey()` 被多次执行，且第一次执行后已删除文件，后续调用打印 warn 日志。
- **建议**: 使用 flag 确保只注册一次，或在注册前 `process.removeListener` 清理旧的 handler。

---

## File: src/core/event-stream.ts

### 发现 18: [P1] `requestSync()` 使用 `(this as any)` 存储临场状态，强类型被破坏
- **严重性**: P1
- **描述**: `requestSync()` 用 `(this as any)._syncQueryReplies = seqs` 和 `(this as any)._syncQueryTimer = timer` 存储状态，而 `_onSyncQueryReply()` 用 `(this as any)._syncQueryReplies` 读取。这不是类的 part-of 属性声明，TypeScript 无法类型检查。如果有两个并发的 `requestSync()` 调用，会互相覆盖对方的状态。
- **影响**: 多次并发触发 `requestSync()` 导致竞态和错误的选择最优 peer。
- **建议**: 将临时状态声明为类属性（`private _syncQueryReplies: ...`），或使用闭包/Promise 管理。

### 发现 19: [P1] `_scanPending()` 中每次重试都重新广播全量 pending 消息，可能造成网络风暴
- **严重性**: P1
- **描述**: `_scanPending()` 遍历所有 pendingTracker 条目，对每个超时的消息调用 `this.bus.broadcast()`。如果大量消息超时（如网络分区恢复后），单次 tick 会广播数百条消息到所有 peer，导致网络拥塞和 ZMQ 缓冲膨胀。
- **影响**: 恢复场景下，ZMQ socket 的 HWM（高水位）可能触发丢弃消息，形成重试放大循环。
- **建议**: 添加速率限制器（每 tick 最多重试 N 条），或在广播前合并多条消息为单一 batch。

### 发现 20: [P1] `_onRemoteData()` 对无 `__es_msg` 的消息有一个不安全的 guard 分支
- **严重性**: P1
- **描述**: `_onRemoteData()` 中当 `!raw` 时，对 `msg.data` 做了 `as any` 的类型断言取 `msg.data.type` 和 `msg.data.data`。但如果 `msg.data` 不是预期的结构（如来自非 EventStream 的 data 消息），这些强制类型转换可能在运行时产生不符合 `StreamMessage` 格式的对象，导致下游 `applyHandler` 抛出未预期异常。
- **影响**: 外部或恶意的 data 消息可能导致 applyHandler 崩溃。
- **建议**: 增加结构校验或使用显式的字段守卫（`typeof msg.data.type === 'string'`）。

### 发现 21: [P2] `acknowledge()` / `markConsumed()` 重复扫描完整 WAL 文件的低效模式
- **严重性**: P2
- **描述**: 两个方法都打开 WAL 文件从头到尾扫描，查找与 `msgId` 匹配的行并 in-place 修改 flags 字节。如果有 10 万条记录要确认（ack 追赶），需要扫描完整的文件内容。
- **影响**: 追赶恢复阶段，WAL 文件越大，确认操作越慢。
- **建议**: 维护一个 WAL 索引文件（msgId → offset 的 LMDB 映射），或使用 head + tail 的分段 WAL 文件（如 Kafka 的 segment log）。

### 发现 22: [P2] `_onRemoteData()` 中 `applyHandler` 失败后仍通过 `sendAck()`，ACK 在持久化失败后发出
- **严重性**: P2
- **描述**: 在 `_onRemoteData()` 中，如果 `this.applyHandler(raw).then(...).catch(...)` 中 catch 被触发（applyHandler 抛异常），**不会**执行 `sendAck()`，正确。但 catch 内打印了错误日志却没有其他恢复措施，远程节点认为消息未被确认会持续重传，导致死循环。
- **影响**: 持久化失败的场景下，发送方无限重传、接收方无限失败，形成日志洪水和 CPU 浪费。
- **建议**: 持久化失败时，在有限次重试后应发送 NACK（否定确认）或记录死信队列。

### 发现 23: [P2] `close()` 中 `this.bus.setReceiveHandler(() => {})` 设置为空函数但原有引用泄漏
- **严重性**: P2
- **描述**: `close()` 将 receiveHandler 设置为空函数，但 `EventBus` 类没有提供 `clearReceiveHandler()` 或类似的解除方法。空函数仍然占用了 handler 槽位，且 `close()` 后重新 `open()` 会注册一个新的 handler，旧的空函数无法被 GC（被 `EventBus` 的闭包持有）。
- **影响**: 关闭/重开序列中，闭包引用的 EventStream 实例无法被 GC。
- **建议**: 在 EventBus 中添加 `clearReceiveHandler()` 方法，或让 `setReceiveHandler(null)` 时解除引用。

### 发现 24: [P2] `_restoreSeq()` 中调用 `this.wal.replay(0)` 读取全部 WAL 用于 seq 恢复
- **严重性**: P2
- **描述**: 在 `open()` 时 `_restoreSeq()` 调用了 `this.wal.replay(0)` 读取**全部** WAL 条目。这仅在启动时需要找到 `this.seq`（最大 seq）。如果 WAL 有百万条，每次启动都要全量扫描。
- **影响**: 启动时间随 WAL 增长线性增加，大 WAL 场景下启动延迟显著。
- **建议**: 在 WAL 文件头部单独保存 `maxSeq` 元数据，或维护一个 seq→offset 的尾部索引。

### 发现 25: [P2] `emit()` 在构造 `StreamMessage` 后调用 `this._emitLocal(msg)` 和 `this.bus.broadcast(transport)` 之间的时序窗口
- **严重性**: P2
- **描述**: `emit()` 先写入 WAL，然后本地回调，然后广播。但如果广播失败，本地回调已经触发了（`_emitLocal`）。本地订阅者此时已经认为事件已提交，但远程节点未收到。
- **影响**: 本地视图与远程视图可能不一致。
- **建议**: 考虑先广播，本地回调在确认（ACK）后触发，或将本地回调与广播做成原子操作。

---

## File: src/core/event-bus.ts

### 发现 26: [P1] 异步 ROUTER receive 循环未处理 ZMQ 中止/关闭时的优雅退出
- **严重性**: P1
- **描述**: `_startRouterLoop()` 中 `poll()` 是一个 async while 循环，在 `this.running` 为 false 时退出。但 `this.routerSocket.receive()` 可能永久阻塞等待消息。如果调用了 `this.routerSocket.close()`（在 `stop()` 中），`receive()` 可能抛出异常（err.code === 'ETERM'），但在该 catch 块中没有 `break`，只打印了警告后继续循环，但 `receive()` 可能抛出 ETERM，之后再次调用的 `receive()` 抛出类似异常，无限循环打印警告。
- **影响**: `stop()` 后控制台可能持续输出错误日志，直到进程退出。
- **建议**: 在 catch 中检查 `err.code === 'ETERM'` 或其他终止信号时设置 `this.running = false` 并 break。

### 发现 27: [P1] `_startNasWatch()` 中 `fs.watch` 返回的 FSWatcher 被强类型转换为 `any` 后存入 `this.refreshTimer`
- **严重性**: P1
- **描述**: `_startNasWatch()` 将 `fs.watch` 返回的 FSWatcher 赋值给 `this.refreshTimer`，而这个字段的类型是 `ReturnType<typeof setInterval> | null`。类型不匹配被 `as any` 强制转换。`stop()` 中检查 `typeof this.refreshTimer.close === 'function'` 来清理 watcher。这种类型混淆在强类型项目中应避免。
- **影响**: 未来重构时类型系统无法保护此处。
- **建议**: 声明一个新的私有字段 `_nasWatcher: fs.FSWatcher | null` 专门用于 fs.watch，保持 `refreshTimer` 只用于 setInterval。

### 发现 28: [P1] `_dealerFailCounts` 超过 3 后在 `_scanNasDirectory` 中跳过不重试且不走日志
- **严重性**: P1
- **描述**: `_dealerFailCounts` Map 用于跟踪每个 peer 的连续重连失败次数，超过 3 次后在 `_scanNasDirectory` 中被 skip。但是这个 skip 只在 `_scanNasDirectory` 中执行（轮询兜底），而 `_checkNasFileChange`（通过 fs.watch 触发的新文件事件）**不受此限制**。这意味着如果 peer 反复断开连接，fs.watch 事件路径仍然会持续触发重建。
- **影响**: 不稳定 peer 环境下，fs.watch 路由绕过退避机制，导致频繁重建 DEALER。
- **建议**: 将退避/失败计数检查统一到一个入口函数中，确保两个路径都走相同的限制逻辑。

### 发现 29: [P2] `broadcast()` 串行发送但也使用 `Promise.all(promises)` 全部等待
- **严重性**: P2
- **描述**: `broadcast()` 对所有 DEALER 调用了 `_sendWithLock()`，创建一个 Promise 数组，然后 `await Promise.all(promises)`。因为 `_sendWithLock` 为每个 DEALER 维护一个链式队列（`_dealerSendQueues`），广播到 10 个 peer 会串行发送（每个 peer 内部排队），但 Promise.all 会等待所有完成。如果有一个 peer 的 DEALER 已关闭（socket removed by `_handleDealerSendError`），该 peer 的 await 不会 reject 因为 `_sendWithLock` 中的 `if (!this.dealerSockets.has(nodeId)) return` 会静默跳过。
- **影响**: 调试时难以追踪 silent skip 的原因。
- **建议**: 在被跳过的分支处加一句 debug 级别的日志。

### 发现 30: [P2] `send()` 中对缺少 dealer 的情况做了 fallback 到 broadcast
- **严重性**: P2
- **描述**: `send(nodeId, msg)` 在找不到 DEALER 时自动 fallback 到 `this.broadcast(msg)`。这意味着 point-to-point 的 ACK 消息（如 `ack` 类型）被广播给所有 peer。这不是安全/正确的——一个节点不应该收到不是发给自己的 ACK。
- **影响**: 其他 peer 收到不属于自己的 ACK 消息，可能干扰 dedup 或 pendingTracker 状态。
- **建议**: 找不到 DEALER 时应该记录 warn 日志并 throw Error，或尝试重建 DEALER，而不是广播。

### 发现 31: [P2] `_sendWithLock` 的 timeout 设置是 socket 级别的，没有实际超时错误处理
- **严重性**: P2
- **描述**: `_sendWithLock` 设置 `dealer.sndtimeo = timeoutMs`，在超时时 ZMQ 会抛出 `EAGAIN` 错误，被 catch 块调用 `_handleDealerSendError` 清理 socket。但如果没有设置 ZMQ socket 的 `SNDTIMEO` 无限等待（默认行为），send 可能阻塞**事件循环**的 Promise 链。`dealer.sndtimeo` 是一个 ZMQ 选项，但 zeromq.js 的 TypeScript 类型定义可能不包含这个属性，通过 `(dealer as any)` 访问。
- **影响**: 隐式的 `any` 使用和 ZMQ 选项的不一致配置。
- **建议**: 使用 zeromq.js 的命名选项 API（如 `dealer.sndtimeo` 被 JS 绑定支持），但确保这不是一个显式的 `any` 属性赋值。

### 发现 32: [P2] `resolveCurveConfig()` 中 `peerKeys[addr]` 和 `peerKeys[nodeId]` 都指向同一个 key，存在 key 混淆
- **严重性**: P2
- **描述**: `resolveCurveConfig()` 中将 peer 的公钥同时存入 `peerKeys[peer.nodeId]` 和 `peerKeys[peer.address]`。但在 `_connectMissingDealers()` 中查找时，使用 `curve.peerKeys[peerNodeId] || curve.peerKeys[addr] || Object.values(...)`. 第一个 `peerNodeId` 查找即生效所以逻辑可行，但两个 key 使用同一个 map 空间增加了冲突风险（比如有人用 addr 字符串恰好等于另一个 nodeId）。
- **影响**: 不正确的 peer 密钥映射导致 CURVE 认证失败。
- **建议**: 只以 nodeId 为 key，不要额外用 addr 做 key。

### 发现 33: [P2] `receiveHandler` 是接口但无防御，可能被多次 `setReceiveHandler` 覆盖
- **严重性**: P2
- **描述**: `setReceiveHandler()` 允许任意覆盖。在 EventStream 的 `close()` → `open()` 序列中，新的 handler 只是覆盖了旧的，旧 handler 能继续被 GC。但没有机制阻止多个调用者同时注册 handler，最终只有最后一个有效。
- **影响**: 多 EventStream 实例共享一个 EventBus 时，只有一个收到消息。
- **建议**: 如果有多个订阅者的场景，应改用发布-订阅模式（多个 handler 组成链）。

---

## File: src/core/overgraph-storage.ts

### 发现 34: [P0] `exportSnapshot()` / `importSnapshot()` 使用 `(this._db as any)` 绕过类型检查
- **严重性**: P0
- **描述**: `exportSnapshot()` 和 `importSnapshot()` 使用 `(this._db as any)` 来调用可能在 `OverGraphDB` 类型上不存在的方法。如果 `overgraph` 库升级后移除或重命名了这些方法，编译期不会报错，但运行时抛异常。
- **影响**: 库升级后静默的运行时崩溃。
- **建议**: 定义一个 `HasSnapshot` 接口（`{exportSnapshot: () => ...; importSnapshot: (data) => void}`），用类型守卫检查 `this._db` 是否满足接口，而不是无条件的 any 断言。

### 发现 35: [P1] `node!` 的非空断言贯穿所有方法 — 若 `_db` 为 null 则抛出难以调试的 TypeError
- **严重性**: P1
- **描述**: 几乎所有方法都使用 `this._db!` 来绕过 TypeScript 的非空检查。如果 `open()` 没被调用或 `close()` 后被调用，会抛 `TypeError: Cannot read properties of null`。由于方法签名没有 `@throws` 文档，caller 可能不 catch。
- **影响**: 在非预期状态下的调用会抛出模糊的错误。
- **建议**: 在方法入口添加显式的 `if (!this._db) throw new Error('OverGraphStorage not opened')` 而不是非空断言。

### 发现 36: [P2] `deleteNode()` 总是返回 `true`，不符合语义
- **严重性**: P2
- **描述**: `deleteNode()` 调用 `this._db!.deleteNode(id)` 并总是返回 `true`，即使节点不存在。`GraphEngine` 依赖该返回值来判断节点是否存在（在 `deleteNode()` 和 `_nodeCount` 更新中）。
- **影响**: 删除不存在的节点时，`_nodeCount` 被错误地减 1，`_nodeIds` 中不存在的 ID 在 delete 中静默失败（Set.delete 对不存在的 key 返回 false）。
- **建议**: 先检查节点是否存在再删除并返回正确的 boolean。

### 发现 37: [P2] `stats()` 对底层方法没有防御——如果底层 API 换版本抛异常，整个 stats 调用会崩溃
- **严重性**: P2
- **描述**: `stats()` 直接假设 `this._db!.stats()` 返回包含 `activeNodeCount`、`immutableNodeCount` 等字段的对象。如果底层 OverGraph 库的 stats 接口变更，这里会抛 `TypeError: Cannot read properties of undefined`。
- **影响**: `stats()` 的调用者（如管理 API）没有 try-catch，异常传播到上层。
- **建议**: 增加 try-catch 并返回后备值或部分统计数据。

---

## File: src/core/stream-wal.ts

### 发现 38: [P1] 原地的 `acknowledge()` / `markConsumed()` 使用逐个字节的 `fs.readSync` + `fs.writeSync`，极端低效
- **严重性**: P1
- **描述**: 两个方法使用 `fs.readSync(fd, buf, 0, 1, pos)` 逐个字节读取 flags 和长度字段进行扫描，遇到匹配后在文件特定位置做最小 1 字节的写。这是典型的逐字节扫描，每次 read 都是系统调用。
- **影响**: 10 万条记录逐个扫描并确认的时间可能达到数秒到数十秒（取决于文件系统和磁盘 IO）。
- **建议**: 预读大块（如 64KB buffer），解析后在内存中判断；修改时先记录 offset 列表，最后批量写回。

### 发现 39: [P1] `prune()` / `pruneByTimestamp()` 的重写操作（重写全部文件）非原子且存在竞态
- **严重性**: P1
- **描述**: 两个方法都：1) 读全部有效记录；2) 写入 .tmp 文件；3) `fs.renameSync(tmpPath, walPath)`；4) 重新打开 fd。在步骤 3 到步骤 4 之间，如果另一个线程/进程尝试 append，`this.fd` 引用的旧文件已不存在。因为 `a+` 模式打开的 fd 在文件被 rename 后仍有效（Unix 文件句柄语义），但 `fs.writeSync(this.fd, ...)` 实际写入的是已被重命名的旧文件路径。
- **影响**: 执行 prune 期间的 append 操作不会写入新的 WAL 文件，数据丢失。
- **建议**: 使用排他锁（如 `lockfile` 或文件锁）保护全部文件操作，或使用 WAL 轮转模式（写满一个 segment 后创建新文件）。

### 发现 40: [P1] `pruneByTimestamp` 将所有保留消息重新编码为 `FLAG_PENDING`，丢失 ACKED/CONSUMED 元信息
- **严重性**: P1
- **描述**: `pruneByTimestamp` 中将保留的消息全部以 `FLAG_PENDING` 编码重写。原来标记为 `FLAG_ACKED` 或 `FLAG_CONSUMED` 的状态丢失了。`replay()` 依赖 `flags !== FLAG_CONSUMED` 来判断是否回放，因此原来已消费的消息再次被重放。
- **影响**: prune 后，重新打开 WAL 会导致已确认的历史消息被重放给 applyHandler，可能导致重复操作。
- **建议**: prune 时应保持原有的 flags 状态不变，或在 prune 后触发一次 `acknowledge`/`markConsumed` 来恢复状态。

### 发现 41: [P1] `prune()` 和 `pruneByTimestamp()` 共享 `_pruning` 互斥锁但 `acknowledge()/markConsumed()` 没有锁
- **严重性**: P1
- **描述**: `_pruning` 是一个简单的 boolean 守卫，阻止并发 prune。但 `acknowledge()` 和 `markConsumed()` 与 prune 之间没有锁——read-modify-write 序列可能交错。例如，acknowledge 在读 flags 字节时，prune 恰好重写了文件，导致 acknowledge 写入错误的 offset。
- **影响**: 文件重组期间的并发操作导致 flags 状态不一致。
- **建议**: 提供统一的锁机制（如 `async-lock` 或 `read-write-lock`）来保护全部文件写入操作。

### 发现 42: [P2] `_countEntries()` 和所有读取方法都在没有 try-catch 的情况下打开文件描述符
- **严重性**: P2
- **描述**: `_countEntries()`、`readPending()`、`replay()` 和 `_readRecordAt()` 都在没有异常保护的情况下调用 `fs.openSync()`。如果 WAL 文件被删除或损坏，会抛出未捕获的异常。
- **影响**: 文件损坏导致整个 EventStream 崩溃。
- **建议**: 对文件打开操作增加 try-catch，提供有意义的错误上下文。

### 发现 43: [P2] `readPending()` 和 `replay()` 每次调用都打开新的文件描述符但不缓存
- **严重性**: P2
- **描述**: 每个非 append 的读取方法打开自己的 fd 并立即关闭。在 `readPending()` 被 `_scanPending()` 每 tick 调用（默认 3 秒间隔）时，反复打开/关闭文件描述符。
- **影响**: 高频 WAL 扫描产生大量系统调用，增加 CPU 使用和 inode 操作。
- **建议**: 当 `this.fd` 已打开（write fd）时，读取方法可以重用该 fd（使用 `fs.readSync(this.fd, ...)`）。

---

## File: src/types.ts

### 发现 44: [P2] `UpsertNodeOptions.denseVector` 同时允许 `Float32Array | number[]`，但 `OverGraphStorage` 内部只处理 `Float32Array`
- **严重性**: P2
- **描述**: `UpsertNodeOptions.denseVector` 类型为 `Float32Array | number[]`，但在 `OverGraphStorage.upsertNode()` 中，如果传入 `number[]`，编码分支 `new Float32Array(opts.denseVector)` 创建了同值的新数组。而在 `graph-engine.ts` 的 `batchUpsertNodes()` 中有同样的 `instanceof Float32Array` 检查。但如果上层传入了 `number[]` 而不是 `Float32Array`，会创建一个额外的副本。
- **影响**: 内存浪费（O(dim * 4bytes * 2) 的双倍分配）。
- **建议**: 统一接口只接受 `Float32Array`（由调用方转换），或在 StorageProvider 层做标准化。

### 发现 45: [P2] `UpsertEdgeOptions.skipReplication` 和 `UpsertNodeOptions.skipReplication` — 复制跳过选项没有在类型文档中明确其一致性影响
- **严重性**: P2
- **描述**: `skipReplication` 选项允许局部跳过 Multi-Leader 复制。该选项的使用者需要理解它会导致该节点的变更不在集群内传播。如果在一些节点上设置了 `skipReplication: true` 而另一些没有，集群状态会出现分歧且不会自动修复。
- **影响**: 跳过了复制的变更在其他节点上不可见。
- **建议**: 添加文档注释说明 `skipReplication` 的使用场景（批量导入时）以及它在最终一致性下的影响。

### 发现 46: [P2] `PatternMatchOptions.limit` 默认值设为 100，可能导致查询结果截断
- **严重性**: P2
- **描述**: `queryPattern()` 默认 limit=100。如果图中有更多匹配且调用方没有显式设置更大的 limit，结果被静默截断。
- **影响**: 分析任务可能因为 limit 过小而得到不完整的图模式。
- **建议**: 考虑使用分页（cursor + limit）或将其文档化为默认行为，或提供一个 `noLimit` 模式。

### 发现 47: [P2] `VectorSearchOptions.hybrid` 类型过于复杂（`boolean | object`），增加使用成本
- **严重性**: P2
- **描述**: `hybrid` 字段允许 `boolean | { text, strategy?, vectorWeight?, textWeight? }`。当为 `true` 时行为未明确定义，下游（graph-engine.ts 的 `vectorSearch()` 只将其作为 JSON 的一部分透传）。
- **影响**: 调用方困惑，类型安全无法保证实际行为。
- **建议**: 简化 API——使用联合类型或拆分为独立参数。

### 发现 48: [P2] `MaterializedViewConfig.refreshPolicy` 的三个选项(`periodic | on_write | manual`)
- **严重性**: P2
- **描述**: 该类型在 `types.ts` 中定义但 `src/core/` 下没有任何代码消费它。可能是未来功能占位符或死代码。
- **影响**: 无用代码增加维护成本，且它引用了 `PatternMatchOptions` 等类型形成未使用的依赖链。
- **建议**: 确认实际未使用后移除，或移到专门的文件并在使用时再引入。

---

## Summary Statistics

| Metric | Count |
|--------|-------|
| P0 (阻塞/安全) | 2 |
| P1 (严重) | 23 |
| P2 (一般) | 23 |
| **Total** | **48** |

### Key Recurring Patterns

1. **`process.exit(0)` 在 library 代码中** — outbox-replication.ts 的 shutdown hook 有 `process.exit(0)`
2. **死代码/未使用的类型** — MaterializedViewConfig 有定义无消费
3. **错误吞没** — graph-engine.ts 的 `_emit()` 后备路径 `catch {}`
4. **未等待的 promise** — EventStream `_onRemoteData` 中 applyHandler 失败后 catch 块没有恢复机制
5. **资源泄漏** — StreamWal prune 时有 fd 竞态损失数据；EventStream close 后还有 timer 未清理（scanTimer 在 close 中已清理，但 pruneTimer 在 `_startScan` 中没有在 close 中清理）
6. **共享状态无锁** — StreamWal 的 prune 和 acknowledge 之间没有并发保护
7. **类型绕过** — `(this as any)` 和 `as any` 的使用遍布多个文件

### Stale Code / Dead Exports

- `Outbox.fetchOldestPending()` — 定义但从未在 PerPeerWorker 中使用
- `MaterializedViewConfig` 及相关类型 — `src/core/` 中无消费者
- `EventBus` 的 `_reconnectDealer()` 方法 — 有完整实现但从未在任何地方被调用（`_recoverDealerByNodeId` 有独立的实现路径）
- `EventBus` 的 `emit()/on()/off()/clear()` — 基于 EventEmitter 的本地事件接口，在 `src/core/` 内没有使用记录（EventStream 使用了自己的 handlers Map）

### Additional Cross-Cutting Issues

- **EventStream pruneTimer 泄漏**: `_startScan()` 中设置了 `pruneTimer` 但没有在 `close()` 中 `clearInterval(pruneTimer)`，进程挂起时 timer 持续运行
- **onRecordChange 重复触发**: GraphEngine 在本地操作触发 `onRecordChange`，同时远程 applyHandler 也会触发，导致回调被调用两次
- **`countNodes(typeFilter)` 低效**: 遍历 `_nodeIds Set` 并对每个 ID 调用 `getNode()`，没有利用 label index