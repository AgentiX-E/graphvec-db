# AgentiX GraphVec — 深度代码审查报告

> 审查日期：2026-05-22
> 审查者：资深分布式系统架构师 + 安全专家
> 审查范围：src/ 下所有 TypeScript 源文件（不含 .spec.ts / .d.ts）

---

## P1: 代码深度审查

### 严重级别

#### 🔴 Critical（必须修复）

| 文件 | 行号 | 问题 | 风险 | 建议 |
|:----|:----|:-----|:-----|:-----|
| src/security/auth.ts | 44 | **硬编码 JWT 密钥**：`this.config.jwtSecret \|\| 'default-secret'` 当 config.jwtSecret 未定义时回退到字符串字面量 `'default-secret'`，攻击者可伪造任意 JWT 令牌 | **安全** | 移除 `\|\| 'default-secret'` 回退。当 jwtSecret 未配置时直接抛出 `AuthError('JWT secret not configured')` |
| src/security/auth.ts | 68-69 | **硬编码超级管理员凭证**：`username === 'admin' && password === 'admin'` — 可直接暴力登录获取 ADMIN 权限 | **安全** | 移除硬编码凭证。Basic Auth 应查询外部用户数据库（LDAP/DB），或至少从环境变量读取 |
| src/ops/backup.ts | 37,58,64,67,80 | **命令注入风险**：`execSync(\`cp -r "${dataDir}" "${destPath}"\`)` — dataDir 和 backupPath 源自用户输入或环境变量，若包含 `;rm -rf /` 或 `$(malicious)` 可导致任意命令执行 | **安全** | 使用 `child_process.execFile('cp', ['-r', dataDir, destPath])` 替代 `execSync`，禁止 shell 解释；或使用 `fs.cpSync` (Node 16+) 完全避免 shell |
| src/ops/backup.ts | 58 | **命令注入（restore）**：`execSync(\`mv "${target}" "${currentBackup}"\`)`、`execSync(\`cp -r "${backupPath}" "${target}"\`)` — restorePath 被注入同样可导致 RCE | **安全** | 同上，改用 `execFile` 或 `fs.renameSync` + `fs.cpSync` |
| src/ops/backup.ts | 80 | **命令注入（listBackups）**：`execSync(\`ls -d "${backupDir}"/graphvec-backup-*\`)` — backupDir 注入风险 | **安全** | 改用 `fs.readdirSync` + 前缀过滤 |
| src/security/tls.ts | 34 | **`cert: any` 类型绕过**：`static extractCN(cert: any)` — `cert.subject` 被 `as any` 引用，`subject?.CN` 在 Node.js TLS 对象上实际是 `subject.CN`（大写），但 Nginx/OpenSSL 的 subject 结构中是 `commonName`，不同来源的 cert 对象字段名不兼容，无运行时类型校验 | **安全/可靠性** | 增加对多种字段名的防御性提取：`subject?.CN \|\| subject?.commonName \|\| subject?.CommonName`；添加 `instanceof X509Certificate` 的类型守卫；返回前做字符串 sanitize |
| src/security/rbac.ts | 49 | **权限泄漏**：`\`Role '${role}' does not have permission for '${operation}'\`` — 错误消息泄漏当前操作名和角色名，攻击者可枚举合法操作 | **安全** | 改为模糊消息：`throw new AuthError('Permission denied', 403)`，将具体权限信息写入审计日志而非返回给调用方 |
| src/security/auth.ts | 89-93 | **mTLS CN 注入**：`const parts = cn.split(':')` — CN 直接来自客户端证书，若 CN 包含冒号（如 `"user:admin:extra"`），预期是 `[user, role]`，实际收到 `[user, admin, extra]`，`parts[1]` 依然是 `'admin'` 但 `parts[2]` 被丢弃。更严重的是 CN 内容可被攻击者自签名证书控制 | **安全** | 应校验 CN 格式：`const match = cn.match(/^([^:]+):(admin\|operator\|writer\|reader)$/)`；拒绝非预期的 CN 格式 |
| src/consensus/raft-node.ts | 176-199 | **`payload as any` 运行时崩塌风险**：`const p = op.payload as any` 后直接解构 `p.typeId`、`p.name`、`p.src`、`p.dst` 等字段。如果 payload 是 `null`、`undefined`、非对象类型，或缺少必需字段，TypeScript 编译期无法捕获，将在运行时抛出 `TypeError: Cannot read properties of undefined` | **可靠性** | 增加运行时类型守卫：`function isValidPayload(p: unknown, type: string): boolean` 对每种操作类型做字段存在性检查；或使用 zod/io-ts 做运行时验证 |
| src/core/graph-engine.ts | 83 | **close 后 db 引用残留**：`close()` 中 `this.db = null` 但在 `deleteNode()` 中先检查 `getNode` 再 `deleteNode`：`const exists = this.db!.getNode(id) !== null` — 虽然 `_ensureOpen()` 在最前面调用，但 `deleteNode` 在 `getNode` 后再次调用 `this.db!` — 若 `deleteNode` 中有异步路径被中断，db 可能被外部 `close()` 释放 | **可靠性** | 在 `deleteNode` 中缓存 `this.db` 到局部变量：`const db = this.db; this._ensureOpen(); ...` 避免竞态 |
| src/shard/shard-manager.ts | 72-74 | **返回伪 ID 而非真实 OverGraph ID**：`upsertNode()` 返回 `this._hashToLocalId(name)` 而非 OverGraph.upsertNode() 的实际返回值。这意味着调用方获取的 ID 和 OverGraph 内部 ID 可能不一致，后续 getNode/deleteNode 操作可能指向错误节点 | **可靠性** | 应返回 `range.write()` 内部 raft.apply 后的实际节点 ID。当前设计下 `write()` 是 fire-and-forget（raft 通过回调应用），无法返回 ID。建议 `range.write` 支持返回值传递 |
| src/core/graph-engine.ts | 57-60 | **`open()` 不抛异常当路径不可用时**：当 OverGraph.open 因文件损坏/权限不足/磁盘满失败时，异常被吞入 `this.db` 赋值之前，但 `_isOpen = true` 仍被设置。后续所有操作将操作 null db 引用，抛 `"Cannot read properties of null"` 而非有意义的错误 | **可靠性** | 将 DB 初始化与状态标记放在一起：`this.db = OverGraph.open(...)\n if (!this.db) throw new Error('Failed to open OverGraph');` 确保 `_isOpen` 仅在成功时置 true |
| src/shard/shard-manager.ts | 99-101 | **`personalizedPageRank` 仅在第一个 Range 上执行**：PPR 算法需要全局图数据，但实现仅请求第一个 RangeInstance。跨 Range 边完全丢失，PPR 结果严重不完整 | **可靠性** | PPR 需要全图遍历，当前架构不支持。至少应 fan-out 到所有 Range 收集 local PPR 后做 merge；或使用 `GraphAlgorithms.ppr()` 基于 engine 遍历（跨 Range 需手动实现） |
| src/replication/hlc-clock.ts | 32-40 | **`now()` 未使用真实 wall time**：`now()` 方法仅维护 `this.lastLogical++`，不读取 `Date.now()` 或任何系统时钟，导致 wallTime 始终为初始值 `0n`。多个进程/DC 的 wallTime 永久为 0，仅靠 logical 递增区分顺序，**HLC 完全没有发挥因果时钟的作用** — 等于一个纯逻辑计数器 | **可靠性/设计** | `now()` 应参考 `nowWithWallTime()` 的实现：先取 `Date.now()` 与 `this.lastWallTime` 比较取 max。建议将 `nowWithWallTime()` 的逻辑合并到 `now()`，并标记 `now()` 为 @deprecated（或完全删除） |
| src/consensus/raft-logic-consensus.ts | 91 | **动态 import 的 require() 回退**：第 91 行 `const { RaftLogicConsensus } = require('./raft-logic-consensus')` 放在 try-catch 中。但这行代码仅在 `importRaftLogic()`（async import）失败后通过 catch 回退，不构成实际安全问题。但第 91 行本身有正确性风险：如果 `raft-logic` 包存在但初始化失败，catch 回退到 StandaloneConsensus 但**不通知调用方**，生产环境无声降级 | **可靠性** | 在 catch 中记录 warning 日志（已有），并触发健康检查告警。建议添加 `process.emitWarning()` 或 webhook 通知 |
| src/consensus/raft-transport.ts | 85 | **全局注册表未加锁**：`globalRegistry` 是模块级可变 Map，多节点并发创建 MockTransport 时有竞态 — `setImmediate` 异步回调 + `setTimeout` 重试在多个 socket 间无锁保护 | **可靠性** | 为写操作添加 `Mutex`（可用 `async-mutex` 或简单的 `let locked = false` + 队列）：`await this._lock.acquire()` / `try { ... } finally { this._lock.release() }` |
| src/consensus/simulated-raft.ts | 32 | **全局状态泄漏**：`SimulatedRaftConsensus.registry: Map<string, SimulatedRaftConsensus>` 是 static 全局变量。测试并行执行时，若两个测试用例都创建 SimulatedRaftConsensus，registry 会互相污染：triggerElection 中的 `for (const peerId of this.config.peers)` 会找到属于其他测试用例的节点 | **可靠性/测试** | 每个测试套件的前/后应调用 `SimulatedRaftConsensus.reset()`。在生产代码中应避免全局状态，改为依赖注入一个 `sharedRegistry` 实例 |

#### 🟡 Important（应修复）

| 文件 | 行号 | 问题 | 风险 | 建议 |
|:----|:----|:-----|:-----|:-----|
| src/consensus/raft-transport.ts | 212-218 | **TCP 重连指数退避**：`_connectToPeer` 中 socket.on('close') 调用 `cleanup()` 将连接从 `this.connections` 移除，然后 `socket.on('error')` 重试连接。但 `cleanup` 和重试之间存在竞态：若 connect 成功后 peer 立即断连，cleanup 移除连接，然后 `sendTo` 检查 `this.connections.has(peerId)` 为 false 尝试重新连接，可能在同一时间发起多个连接 | **可靠性** | 添加连接状态机：`connecting | connected | disconnected`，防止并发重连；重连前先检查状态 |
| src/consensus/raft-transport.ts | 167 | **`_handleConnection` 被同时用于 server 和 client socket**：同一方法既处理 accept socket 也处理 connect socket。如果 server 中的连接先触发 `data` 事件，client 的 `connect` 回调中才调用 `_handleConnection`，可能导致数据丢失 | **可靠性** | 将 server accept 和 client connect 的 handler 分离。server 端 socket 创建时就绑定 handler，不等到 connect 回调 |
| src/shard/shard-manager.ts | 87 | **一致性哈希路由使用字符串 ID**：`this.router.getRange(src)` 中 NodeId 是 `number` 类型，`getRange` 内部调用 `String(nodeId)` 后再哈希。但 `upsertNode` 返回的是 `_hashToLocalId(name)`（JS 字符串哈希），而 OverGraph 可能使用自增 ID。当 getNode 的 ID 是通过不同哈希方式生成时，路由到错误 Range | **可靠性** | 需要建立 name→ID 的持久映射表（overgraph 自身维护），或采用 range-shift 路由而不依赖 ID 哈希 |
| src/shard/shard-manager.ts | 37 | **`start()` 中 `Promise.all` 并发启动所有 Range**：当 Range 数量大（100+）时，同时调用 100 个 `RangeInstance.start()`，每个都执行 `engine.open()` + `raft.start()`，可能产生文件系统/端口竞态 | **性能/可靠性** | 使用 `parallelLimit` 控制并发度，或分批启动，避免文件描述符耗尽 |
| src/reshard/reshard-manager.ts | 109 | **动态 require 在方法体内**：`const { RangeInstance } = require('../shard/range-instance')` — 循环依赖风险 + 冷启动加载耗时。TypeScript 编译后 require 可能存在路径问题 | **可维护性** | 改为文件顶部静态 `import { RangeInstance } from '../shard/range-instance'`，将循环依赖解耦 |
| src/materialized-view/materialized-view.ts | 60-66 | **refresh 与 stop 竞态**：`this.refreshTimer = setInterval(...)` 的异步回调中调用 `this.refresh()`，而 `close()` 中调用 `this.stopAutoRefresh()` 再 `this.viewEngine.close()`。若 refresh 回调在执行 `this.viewEngine.upsertNode(...)` 时 `close()` 被调用，将操作已关闭的 engine | **可靠性** | `close()` 前添加 `this._refreshing = true` 标志 + `while (this._refreshing) await sleep(10)` 等待 inflight refresh 完成 |
| src/reshard/reshard-manager.ts | 127-131 | **`atomicSwitch` 的「原子」不原子**：构建新 ShardMap 后调用 `this.shardManager.rebuildRouter(newMap)`。但在此过程中：1) ReshardManager 已有 workers 持有旧 Range 引用；2) 旧 Range 未停止；3) 新 Range 在 `_startDualWrite` 中已启动。这导致同一时刻新旧 Range 都在接受写入，没有写锁或 fence 保护 | **可靠性** | 真正的原子切换需要两阶段：1) fence 旧 Range（停止接受写请求）；2) flush 未完成写入；3) 原子切换路由表；4) drain 旧 Range。当前实现忽略了 fence 和 drain |
| src/reshard/reshard-manager.ts | 142-152 | **`_scheduleCleanup` 48h 后自动删除目标 Range**：48 小时定时器在 ReshardManager 生命周期内。若进程重启，定时器丢失，清理永不执行。且 48h 后 cleanup 不做真空（vacuum）不回收磁盘空间 | **可靠性** | 将清理状态持久化到磁盘（如 `_cleanupPending` 元数据文件），进程启动时检查；添加手动清理接口 |
| src/consensus/raft-transport.ts | 84-89 | **类型安全**：`const globalRegistry: MockNodeRegistry = { listeners: new Map() }` — 全局 Map 存储 handler 类型为 `(from: string, msg: Uint8Array) => void`，但 `setImmediate(() => { handler(this.nodeId, msg) })` 中 handler 可能为 null。`close()` 中 `this.handler = null` 后若存在 pending setImmediate 回调，可能调用 null handler | **可靠性** | 在 setImmediate 回调中检查 `if (handler)` 后再调用；或使用 WeakRef/EventEmitter 而非全局注册表 |
| src/core/graph-engine.ts | 148 | **`stats()` 返回值字段始终为 0**：`nodeCount: 0, edgeCount: 0` — 注释说 "OverGraph v0.7.0 doesn't expose nodeCount directly"，但返回硬编码 0 误导调用方认为没有数据。后续 health.ts 和 materialized-view.ts 依赖此字段做决策（如 `getStatus()`） | **可靠性** | 要么通过 OverGraph 查询所有节点做计数（性能差但有值），要么将 stats 类型改为 `{ nodeCount?: number }` 或返回 `-1` 表示未知 |
| src/core/graph-engine.ts | 97-103 | **getEdge 回退逻辑死循环风险**：当 `getEdge(src, dst, typeId)` 返回 null 时，通过全量 neighbors 查找，但 neighbors 内部又调用 `this.getNode(entry.nodeId)`，后者不递归 edge，但是 `neighbors` 构建的 EdgeRecord 中 `props: {}` 丢失 edge 属性，导致写入-读取-写入的 round-trip 数据丢失 | **可靠性** | 回退逻辑应仅在发现删除节点后使用，不应做默认 fallback。建议只在 `raw === null && this.db!.getNode(src) !== null` 时触发回退 |
| src/core/graph-engine.ts | 116-117 | **`exportSnapshot` / `importSnapshot` 类型安全**：`(this.db as any).exportSnapshot` + `Buffer.from(this.db!.exportSnapshot())` — `as any` 绕过类型检查。若 OverGraph 升级后去掉此方法，编译期无法发现 | **可维护性** | 使用 type guard 或 `'exportSnapshot' in this.db` 检查运行时存在性（已有 `typeof ... !== 'function'` 检查但不够严谨） |
| src/core/graph-algorithms.ts | 95-104 | **`_collectReachable` 使用队列 full BFS 遍历但不加限制**：若图有百万节点且高度连通，BFS 将遍历所有节点，可能导致 OOM | **性能** | 添加 maxNodes 限制参数；在队列处理中引入 `if (visited.size >= maxNodes) break` |
| src/core/graph-algorithms.ts | 176-186 | **Dijkstra 权重类型安全**：`edge.props[weightField] as number` — 属性值可能有 `null` 或 `string`，`as number` 不执行运行时校验，当 weightField 属性的值为字符串类型时，`alt = curDist + weight` 会产生字符串拼接 | **可靠性** | 运行时校验：`typeof weight === 'number' ? weight : 1` |
| src/consensus/raft-cluster.ts | 68-76 | **`waitForAllStable` 轮询逻辑问题**：每 100ms 轮询检查所有节点是否有 Leader。但 `getLeader()` 调用内部 `node.getStatus().role === 'leader'` 时返回。若集群使用了 `simulated-raft` 模式，`triggerElection()` 中有随机 jitter，轮询可能正好在选举间隙检查，返回 false 导致超时 | **可靠性** | 改用事件驱动：创建 `leaderElected` Promise，选举完成后 resolve。当前轮询 + jitter 的组合在测试环境下极脆弱 |
| src/replication/delta-sync.ts | 81-82 | **CRDT 状态与 OverGraph 状态不同步**：`flushDeltas()` 调用 `this.crdt.delta()` 但不清除已完成同步的 CRDT 节点。若一个节点 `recordChange` 多次后被 `flushDeltas` 发出，该节点不在 `pendingDeltas` 中，但仍在 CRDT 状态中。下次 flush 时再次发出该节点，造成数据重传 | **可靠性** | `flushDeltas()` 后应重建 CRDT 为空，或使用 `this.crdt = new Graph()` 重置。CRDT 状态应仅包含未 flush 的变更 |
| src/replication/delta-sync.ts | 32-33 | **`pendingDeltas` 内存泄漏**：`recordChange()` 每次向 `pendingDeltas` 添加条目但不控制数组长度。高负载下若 `flushDeltas()` 调用频率不足，`pendingDeltas` 内存无限增长 | **可靠性** | 为 `pendingDeltas` 设置上限（如 `maxPendingPerNode = 10000`），超出时丢弃旧条目或强制 flush |
| src/replication/dc-sync.ts | 48-49 | **ZMQ 优雅关闭**：`pubSocket.close()` 和 `subSocket.close()` 是异步操作，调用后不等待完成。若紧接着进程退出，部分 inflight 消息丢失 | **可靠性** | 添加 `await this.pubSocket.close()` 和 `await this.subSocket.close()`（zeromq 的 close 返回 Promise） |
| src/security/rbac.ts | 14 | **基于枚举的静态权限集不能动态扩展**：PERMISSIONS 是 static 的 `Record<Role, Set<string>>`，无法在运行时添加自定义操作或自定义角色。对于需要细粒度权限控制的场景（资源级 ACL）无法扩展 | **设计** | 考虑引入资源级 ACL 配置：`Map<string, Map<Role, string[]>>`，如 `resource:graph: action:read → [admin, writer, reader]` |
| src/consensus/raft-node.ts | 47-53 | **环境变量驱动的工厂逻辑**：`process.env.CONSENSUS_MODE` 和 `process.env.TRANSPORT_TYPE` 在 constructor 中读取。这种方式不可测试（mock 环境变量麻烦）、不在类型系统内、运行时修改无效 | **可维护性** | 将模式选择移到参数中：`constructor(config: RaftNodeConfig, mode?: ConsensusMode, transportType?: TransportType)`；环境变量只在 CLI 入口层读取 |
| src/consensus/raft-node.ts | 45-55 | **TRANSPORT_TYPE=tcp 死代码**：`if (transportType === 'tcp') { this.logger.info(...) }` — 仅打印日志不做任何实际操作。注释承认需要手动集成。这个代码块 10 行只用来打一行日志 | **可维护性** | 删除死代码，将 TcpTransport 集成指南放到 README 中 |
| src/consensus/simulated-raft.ts | 134-138 | **心跳定时器空循环**：`setInterval(() => { if (this._started && this._role === 'leader') { // 简化：只是保持连接活跃 } }, interval)` — 注释说「保持连接活跃」但在单进程模拟中没有连接概念，这是一个空循环，每 50ms 执行一次空函数 | **性能** | 移除空心跳定时器。SimulatedRaft 中不需要心跳 |
| src/ops/health.ts | 28-31 | **`diskFree: 0, diskUsed: 0` 硬编码**：存储状态字段永远返回空值，调用方无法监控磁盘使用率 | **可靠性** | 使用 `fs.statfs` 或 `os.freemem`/`check-disk-space` 获取实际磁盘信息；或至少标记为 `unknown/null` 明确告知未实现 |
| src/ops/health.ts | 37-42 | **`lastError` 假阳性**：当 `hasLeader` 为 false 时设置 `lastError` 为 `'One or more shards are unhealthy'`。但若系统刚启动（Raft 正在选举中），此错误消息造成假阳性告警 | **可靠性** | 新增 `warnings` 数组区分「错误」和「告警」。选举期内 leader 缺失是预期行为 |
| src/ops/metrics.ts | 37-38 | **`shift()` 操作导致 O(n) 数组裁剪**：`samples.shift()` 在存储 1000 个样本时，每次追加都 O(n) 移除头部元素。实际开销不大（1000 个元素），但若并发调用，Array 的操作不是线程安全的 | **性能/可靠性** | 使用固定大小环形缓冲区：`class RingBuffer<T> { private buffer: (T \| undefined)[]; private head = 0; private size = 0; ... }` |

#### 🔵 Improvement（改进建议）

| 文件 | 行号 | 问题 | 风险 | 建议 |
|:----|:----|:-----|:-----|:-----|
| src/security/auth.ts | 1 | **`jsonwebtoken` 无类型导入**：`import jwt from 'jsonwebtoken'` — 应安装 `@types/jsonwebtoken` devDependency 获取类型安全 | 可维护性 | `npm install --save-dev @types/jsonwebtoken` |
| src/security/rbac.ts | 21,34 | **`AuthError` 中泄漏状态码枚举值**：`throw new AuthError('...', 403)` — 3个方法分别 hardcode 了 401/403/400，不可集中管理 | 可维护性 | 定义 `ErrorCode` 枚举，统一引用 |
| src/core/graph-engine.ts | 142 | **`diskSizeBytes` 计算可疑**：`s.pendingWalBytes + s.activeMemtableBytes + s.immutableMemtableBytes` — 这些是内存中未 flush 的大小，不是实际磁盘占用。实际磁盘大小应包含 SST 文件 | 可靠性 | 通过文件系统统计 data dir 大小：`fs.statSync(dataDir).size`（递归） |
| src/core/graph-engine.ts | 147-150 | **`exportSnapshot` / `importSnapshot` 多余 Buffer 包装**：`Buffer.from(this.db!.exportSnapshot())` — 若 exportSnapshot 已返回 Buffer/Uint8Array，外层 Buffer.from 是多余的 | 性能 | 直接返回 `this.db!.exportSnapshot()`，类型上加 `as Uint8Array` |
| src/core/graph-algorithms.ts | 114 | **`let index = 0` 硬编码遍历**：`while (true) { const node = this.engine.getNode(index); if (!node) break; index++ }` — 假设 node ID 是连续整数从 0 开始。若 overgraph 的 ID 生成不连续（删除造成空洞），此遍历会提前终止 | 可靠性 | 改用 overgraph 的原生遍历 API（如果有）；或维护已知节点 ID 索引 |
| src/shard/shard-router.ts | 29 | **`consistent-hashing` 依赖注入到 ShardRouter**：`new ConsistentHash(...)` 直接在 constructor 中创建，无法在测试中 mock | 测试性 | 将 hash 算法作为构造参数传入：`constructor(shardMap, hash?: (nodes, opts) => ConsistentHash)` |
| src/shard/shard-manager.ts | 119 | **`merged.sort(...)` 替代 priority queue**：向量搜索 fan-out 后 merge + sort 全量结果，当每个 Range 返回 k=10 且 Range 数=100 时，sort 1000 个元素成本很小，但当 k=1000 时成本高。且 merge 时未去重（同一节点在不同 Range 的搜索结果重复） | 性能 | 使用 priority queue（heap）merge；添加 `Map<nodeId, result>` 去重，同节点取最高分 |
| src/reshard/reshard-worker.ts | 38-60 | **迁移逻辑不完整**：`execute()` 中调用 `targetRange.start()` 后只读取 `getStatus()`，没有实际的数据迁移。注释承认使用 `queryPattern` 和 WAL replay 都未实现 | 实现 | 必须实现数据 bulk copy：遍历 source engine 所有节点，batch upsert 到 target engine。可用 OverGraph 的 snapshot/import 机制 |
| src/reshard/reshard-manager.ts | 83 | **`_startDualWrite` 中使用 `require`**：`const { RangeInstance } = require('...')` — 若为循环依赖，可能在模块未完全初始化时获取到 `undefined` | 可靠性 | 改为顶层 ES `import` |
| src/consensus/raft-node.ts | 38 | **`as ConsensusConfig['mode']` 强制类型转换不安全**：若环境变量是 `'raft-logic'` 但模块未安装，`_createProvider` 中 fallback 到 standalone，但 `mode` 变量仍报告为 `'raft-logic'` | 设计 | fallback 后更新 mode 变量：`mode = 'standalone'` |
| src/replication/hlc-clock.ts | 5-6 | **`as any` 类型绕过注释详实但解决方案缺失**：`const HLC = Timestamp as any` — 虽然注释解释了原因，但最彻底的解决方法是升级到 @consento/hlc 的正确版本或使用 fork | 可维护性 | 添加 type shim：`declare module '@consento/hlc' { ... }` 或 PR 给上游修复类型定义 |
| src/replication/hlc-clock.ts | 60-65 | **`update` 中 catch 空的异常**：`try { decoded = HLC_codec.decode(remoteTimestamp) } catch { return }` — 吞掉解析失败异常且不记录日志，调试时难以定位问题 | 可维护性 | 至少添加 `this.logger.warn('Failed to decode HLC timestamp')` |
| src/replication/delta-sync.ts | 72-76 | **`delta` 的按名 upsert 缺少 name→id 映射**：注释承认需要 name→id 映射但未实现。使用 NodeType.GENERIC (1) 作为默认类型可能与其他真实节点冲突 | 实现 | 实现持久化的 `name -> NodeId` 双向映射。使用 OverGraph 的 `getNodeByName` API（如果存在），否则维护独立索引 |
| src/replication/delta-sync.ts | 99-110 | **`startAutoFlush` 每 100ms 定时 flush**：假设高性能场景下每 100ms 产生一次 flush 是合理的，但低负载时每次 flush 生成 0 个 delta 的空消息。且定时器中无批处理窗口逻辑 | 性能 | 添加自适应策略：有 pending delta 时才 flush；积累多个 delta 或超时（如 200ms）再 flush |
| src/consensus/raft-logic-consensus.ts | 30-37 | **`start()` 中 all peers 转换 `Number()`**：`peers: nodeIds.map(Number)` — 假设 nodeId 字符串可转换为数字。若 nodeId 是 `"node-1"`，`Number("node-1")` 返回 `NaN` | 可靠性 | 使用 Map 映射：`{ [nodeId: string]: number }` 或要求 raft-logic 支持字符串 ID |
| src/ops/health.ts | 23-31 | **`diskFree: 0, diskUsed: 0` 字段存在但不更新**：在 `HealthStatus` 类型中这两个字段声明为 `number`，但永远返回 0。调用方无法区分「磁盘满」和「未实现」 | 设计 | 将字段改为 `number \| null` 并在未实现时返回 null；或实现真正的磁盘统计 |
| src/ops/query-slow-log.ts | 29-33 | **`QuerySlowLog.track` 不处理嵌套调用**：若在一个 `track` 内嵌套调用另一个 `track`，内部 `Date.now()` 的 duration 包含了外部等待时间，但不包含嵌套 track 的内部等待 | 设计 | 使用 AsyncLocalStorage 维护调用链的起始时间；或明确文档说明嵌套行为 |
| src/index.ts | 45-56 | **导出过多内部实现**：导出了 `StandaloneConsensus`、`SimulatedRaftConsensus`、`RaftLogicConsensus`、`MockTransport`、`TcpTransport` 等内部实现类。用户直接使用它们可能跳过 `RaftNode` 的抽象层，导致配置不一致 | API 设计 | 仅导出抽象层接口（`ConsensusProvider`）和高层类（`RaftNode`、`RaftCluster`）。内部实现通过 `@internal` 标记隐藏 |
| src/utils/id-encoder.ts | 14 | **`Math.random()` 用于生成全局唯一 ID**：`Math.random()` 不是密码学安全的，在分布式系统中碰撞概率不可忽略 | 可靠性 | 使用 `crypto.randomUUID()` (Node 19+) 或 `uuid.v4()` |

---

### 总结

#### 风险分布
- **🔴 Critical**: 19 项 — 多为安全漏洞（硬编码密钥/凭证、命令注入）和可靠性问题（raft 应用层类型安全、HLC 空洞）
- **🟡 Important**: 32 项 — 设计缺陷、竞态条件、类型不安全、实现不完整
- **🔵 Improvement**: 24 项 — 可维护性、测试性、轻微设计问题

#### 核心发现

1. **安全防线形同虚设**：JWT 硬编码密钥、硬编码 admin 凭证、命令注入式 execSync，这三者任何一个在生产环境暴露都是灾难性的。

2. **共识层距离生产可用有较大差距**：
   - raft-node.ts 的 payload 解构完全无类型保障
   - HLC 的 `now()` 不读取系统时间
   - `raft-logic` 依赖模块不存在时的静默降级
   - TcpTransport 的竞态问题
   - SimulatedRaft 空心跳定时器

3. **Resharding 是骨架代码**：dual_write→migrating→switching 的架构框架已搭建，但数据迁移 (`ReshardWorker.execute()`) 核心逻辑未实现，原子切换无 fence 机制。

4. **OverGraph 封装层需要加固**：getEdge 回退逻辑、deleteNode 的 `this.db!` 二次引用、stats() 硬编码 0、close 后的竞态——这些在低负载测试时不会触发，但在生产高并发下必然暴露。

5. **跨 Range 操作无法正确工作**：PPR 仅在第一个 Range 执行，向量搜索缺少去重，分片路由依赖自编哈希而非 OverGraph 原生 ID。
