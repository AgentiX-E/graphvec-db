# AgentiX GraphVec — 横切关注点审查报告

**审查日期**: 2026-05-26  
**审查范围**: 安全、性能、架构、测试覆盖盲区  
**审查深度**: 横切关注点（跨文件跨模块）

---

## 发现概览

| 严重程度 | 数量 | 说明 |
|---------|------|------|
| P0 | 1 | 数据丢失 / RCE 风险 |
| P1 | 4 | 严重影响安全或正确性 |
| P2 | 7 | 中等影响，应在发布前修复 |
| P3 | 6 | 建议性改进 |
| **合计** | **18** | |

---

## P0 — 紧急

### F01. `bodySizeLimit` 实现不生效 — 超过限制的请求仍会被 parseBody 完整接收
- **Severity**: P0
- **Domain**: security
- **File**: `src/api/rest.ts` (L895-L902)
- **Title**: bodySizeLimit 不阻止实际内存分配
- **Detail**: bodySizeLimit 只在解析前检查 `Content-Length` header 并返回 413，但后续的 **parseBody() 在同一代码路径中并未被跳过**。攻击者可以发送略小于限制的 header 但实际 body 远大于 Limit，或者利用 transfer-encoding: chunked 绕过 Content-Length 检查，导致服务 OOM。
- **Suggested Fix**: 经过 bodySizeLimit 检查后，在 parseBody 中再实现流式读取 + 断流控制。要么检查后直接 return 避免后续 parseBody，要么在 parseBody 内实现 `req.on('data')` 累计计数 + 到达上限时 destroy socket + reject。

### F02. 缺少锁文件验证 — package-lock.json 存在但 npm install 不保证锁定
- **Severity**: P0
- **Domain**: security
- **File**: `package.json`
- **Title**: 供应安全 — 锁文件无 CI/CD 强制校验
- **Detail**: `package-lock.json` 存在，但 `package.json` 中所有依赖使用 `^` range（如 `"overgraph": "^0.7.0"`, `"zeromq": "^6.5.0"`），无 `package-lock.json` 校验、无 `integrity` 检查、无 `engines` 校验锁定。攻击者可以通过篡改 registry 或中间人替换轻量级依赖（如 `pino-pretty`、`rotating-file-stream`）进行 typosquatting 攻击。更关键的是 `"raft-logic": "^0.3.14"` 被声明为 `optionalDependencies`，其 WASM 二进制执行路径无签名验证。
- **Suggested Fix**: 在 CI/CD 中运行 `npm ci`，在 `preinstall` 增加 `lockfile-lint` 或 `npm audit`。对 raft-logic 增加 WASM 校验和与完整性哈希验证。考虑使用 `--omit=optional` 在生产环境排除可选依赖。

---

## P1 — 高

### F03. GraphEngine `query()` 注入风险 — 用户输入直接传入 parseQuery() 无转义
- **Severity**: P1
- **Domain**: security
- **File**: `src/core/graph-engine.ts` (L178: `_executeQueryPlan` → `neighbors()` → ZMQ 网络传输)
- **Title**: Cypher-lite 查询注入
- **Detail**: `GraphEngine.query(queryString: string)` 将用户输入的查询字符串直接传给 `parseQuery()`。查询中的 filter value 通过 property 匹配传到 `_matchFilter()` 和 `_executeQueryPlan()`。如果用户构造恶意查询（如 `MATCH (a:1) WHERE a.prop=true UNION ...` 绕过 RLS 或越权读数据），可能 **在 RLS 执行之前** 就扫描了全量节点。
- **Suggested Fix**: 
  1. 在 `parseQuery()` 层增加查询深度限制（`maxDepth`）、`maxUnionDepth`
  2. 对返回结果二次 RLS enforce，不能只依赖 `_executeQueryPlan` 中的 RLS
  3. 增加查询语法的白名单校验

### F04. `event-bus.ts` 中 ROUTER socket bind `0.0.0.0` — 生产环境可能暴露到外网
- **Severity**: P1
- **Domain**: security
- **File**: `src/core/event-bus.ts` (L346)
- **Title**: ZMQ ROUTER 默认 bind `0.0.0.0` 全接口
- **Detail**: `this.config.publishAddress = \`tcp://0.0.0.0:${nasConfig.port}\`` — 当使用 NAS 模式时，ROUTER socket 默认监听所有网络接口。如果 NAS 公钥分发机制被绕过或 CURVE 配置不当，外部攻击者可直接连接 ZMQ 端口进行操作。代码中 CURVE 在 `_applyCurveToSocket()` 只在 `mode === 'explicit'` 时应用，NAS 模式下 `_applyCurveToSocket` 因 `curve.mode !== 'explicit'` 直接 return — **NAS 模式下 CURVE 并未实际应用到 socket 上**。
- **Suggested Fix**: 生产环境应强制检查模式并 bind 到具体内网地址。对 NAS 模式也实现 CURVE 密钥应用（从 NAS 分发的密钥应当能被 socket 识别）。

### F05. `console.log/warn/error` 散落 37 处 — 关键错误路径未使用 Logger 或 AuditLogger
- **Severity**: P1
- **Domain**: performance / security
- **File**: 多个文件（auth.ts, tls.ts, event-bus.ts, graph-engine.ts, cdc-consumer.ts, backup-scheduler.ts 等）
- **Title**: 结构化日志缺失 — 大量关键路径使用 console API
- **Detail**: 37 处错误/告警使用 `console.log/warn/error` 而非项目自带的 `Logger` 类。这意味着：
  - 审计日志（AuditLogger）记录的操作日志与运行时日志分离
  - `console.log` 在 `event-bus.ts` 的 ROUTER/DEALER 连接关键路径中大量使用（约 20 处），无结构化元数据（traceId、spanId）
  - `console.error` 在 `graph-engine.ts` 中 Multi-Leader 复制失败时使用 — 这种关键路径应该走 pino 结构化日志和 metrics 采集
- **Suggested Fix**: 批量替换所有 `console.*` 为 `this.logger.info/warn/error()`，并确保传递 `traceId` 和结构化数据。

### F06. `auth.ts` `require()` 不在模块顶层 — 动态 require 可能触发 unhandled rejection
- **Severity**: P1
- **Domain**: performance / architecture
- **File**: `src/security/auth.ts` (L56, L86, L116)
- **Title**: auth.ts 运行时动态 require 造成不可预期的行为
- **Detail**: `auth.ts` 使用 `require('fs')`、`require('chokidar')` 在方法体内而非顶层 import。这意味着：
  - `chokidar` 加载失败时只在 `catch` 中打印 warning 后降级到 stat polling
  - 但如果 `fs` 在运行时 require 失败（极低概率但存在），身份文件加载将静默失败
  - `require()` 冷加载 300ms+ 会增加第一次 `_loadIdentities()` 的延迟
  - TypeScript 编译无法检查这些运行时 require 的类型安全
- **Suggested Fix**: 将 `import * as fs from 'fs'` 放到文件顶层。chokidar 改为顶层 `import` + optional 检查（`if (typeof chokidar === 'undefined') { fallback }`）。

---

## P2 — 中

### F07. `vectorSearch` 中 JSON.stringify 序列化开销 — 每次搜索触发一次大 JSON 序列化
- **Severity**: P2
- **Domain**: performance
- **File**: `src/core/graph-engine.ts` (L630-645)
- **Title**: vectorSearch 在 hot path 使用 JSON.stringify 传递搜索参数
- **Detail**: `vectorSearch()` 先将整个查询对象（含 denseQuery 向量、sparseQuery、scope 等）用 `JSON.stringify` 序列化为字符串，然后传给 `this.storage.vectorSearch(searchQuery)`。对于每个搜索请求，denseQuery 是 Float32Array(n) → Array(n) 的全量转换。对于 768 维向量 + sparse 索引，每次搜索产生 10KB+ JSON，在高 QPS 场景造成不必要的 GC 压力和反序列化开销。
- **Suggested Fix**: 改用 msgpack 序列化（项目中已依赖 `msgpackr`），或将 StorageProvider.vectorSearch 接口改为直接接收结构化对象而非 string。

### F08. `TcpTransport._getLocalIp()` 返回第一个非内网 IP — 多网卡场景不确定
- **Severity**: P2
- **Domain**: performance / architecture
- **File**: `src/consensus/transport.ts` (L786-796)
- **Title**: TcpTransport listen address 自动选择可能通信失败
- **Detail**: `_getLocalIp()` 遍历 `os.networkInterfaces()` 返回第一个 `family === 'IPv4' && !internal` 的 IP。在多网卡场景下（Docker、K8s、多 VPC），第一个非内部 IP 可能**不是**节点间通信应使用的地址，导致其他节点无法连接。且该 IP 会被记录为 `listenAddress` 用于广播。
- **Suggested Fix**: 支持通过环境变量或构造函数参数显式指定 listen address。在未指定时应 pick 绑定到 `0.0.0.0`（但不暴露到外网）或按 `interface name` 白名单选择。

### F09. `LmdbWal` write 路径使用 `async` `put()` — 日志 append 在异步路径中弱化 fsync 保证
- **Severity**: P2
- **Domain**: performance / security
- **File**: `src/consensus/lmdb-wal.ts` (L85-89)
- **Title**: LMDB WAL append 使用 `await entriesDb.put()` 而非同步写
- **Detail**: `LmdbWal.append()` 是 `async` 方法，调用 `await this.entriesDb.put()`. LMDB 的 `put()` 返回 Promise 时，**数据的 fsync 保证取决于 `noSync: false` 配置**。但在 mapSize=1GB 配置下，put() 返回的 Promise 可能在 OS page cache 写入后 resolve，不等底层 fsync 完成。这意味着 Leader commit 后 data 可能在 crash 中丢失（Raft 协议的正确性依赖于 WAL fsync 的**线性一致性**）。
- **Suggested Fix**: 在 `append()` 后显式调用 `this.db.transactionSync()` 或将 noSync 和 mapSize 调整为业务需要的严格级别。添加 `appendSync()` 方法供 Raft 核心在关键写路径上使用。

### F10. `backup.ts` 中 `process.env.DATA_DIR || './data'` 散落四处，环境变量覆盖路径存在竞争
- **Severity**: P2
- **Domain**: security
- **File**: `src/ops/backup.ts` (L66, L179, L289, L390)
- **Title**: 备份路径未通过统一配置管理
- **Detail**: `backup.ts` 在四个不同方法中均独立读取 `process.env.DATA_DIR || './data'`，且未与 `GraphConfig` 的配置管理集成。如果在备份过程中环境变量被修改（某些 CI/CD 环境），可能导致数据备份到错误的目标甚至覆盖生产数据。备份删除逻辑也直接使用 `fs.rmSync()` 未校验路径安全性。
- **Suggested Fix**: `Backup` 应通过 constructor 参数接收明确的 dataDir 路径（来自 `GraphConfig`），而非环境变量。备份删除前校验路径是否在预期备份目录下。

### F11. `GraphEngine.vectorSearch` 中 `JSON.parse(JSON.stringify(denseQuery))` 导致额外浮点精度损失
- **Severity**: P2
- **Domain**: performance
- **File**: `src/core/graph-engine.ts` (L630-645)
- **Title**: Float32Array → JSON.stringify 导致浮点精度截断
- **Detail**: `JSON.stringify` 会将 Float32Array 的每个元素转为 Number（double），然后序列化为十进制字符串。当 `Array.from(query.denseQuery)` 被反序列化回 float32 时，可能出现 ±0.000001 的精度偏差。对于 ANN 向量搜索，微小浮点偏差可能在 768 维空间中累积出非预期的距离排序。
- **Suggested Fix**: 直接传递 `Float32Array` 给 StorageProvider（或在 serialize 时将 Float32Array 转为 base64 encoded bytes），避免 JSON 中间层的精度损失。

### F12. `rateLimiter.isAllowed()` 使用套接字 `remoteAddress` 做限流 key — 代理/反向代理下失效
- **Severity**: P2
- **Domain**: security
- **File**: `src/api/rest.ts` (L906-909)
- **Title**: 限流基于 socket remoteAddress 而非真实客户端 IP
- **Detail**: `const clientIp = req.socket.remoteAddress ?? 'unknown'` — 在反向代理（Nginx、Kong、ALB）后面，所有流量都来自代理 IP，限流 key 变为同一个 IP。攻击者可通过单 IP 绕过限流，或导致所有用户共享同一个限流桶（互相拖累）。
- **Suggested Fix**: 优先读取 `X-Forwarded-For`、`X-Real-IP` header。支持配置 trusted proxy CIDR 列表来提取真实客户端 IP。

### F13. `memory: rateLimiter entries` Map 无过期清理 — 长时间运行内存泄漏
- **Severity**: P2
- **Domain**: performance
- **File**: `src/api/rest.ts` (L168-185)
- **Title**: MemoryRateLimiter entries Map 无 TTL 清理
- **Detail**: `MemoryRateLimiter` 的 `entries: Map<string, RateLimitEntry>` 无定期清理机制。每个不同的客户端 key 会被永久保留在 Map 中。在大量不同客户端访问的场景下（尤其是 DDoS 或大量低 QPS 调用），这个 Map 会不断增长，最终导致 OOM。
- **Suggested Fix**: 添加定时清理任务（如每 5 分钟清理已过期的 entry），或改用支持 TTL 的缓存实现（如 `lru-cache`，项目已依赖 `"lru-cache": "^11.0.0"`）。

---

## P3 — 低（建议性）

### F14. `GraphEngine.v4()` `_nodeIds` 和 `_edgeKeys` 使用 `Set` 主内存索引 — 节点数 1000 万级 OOM
- **Severity**: P3
- **Domain**: performance
- **File**: `src/core/graph-engine.ts` (L216-217)
- **Title**: 内存索引不适用于大规模图
- **Detail**: `GraphEngine` 在构造函数中通过 `Set<number>()` / `Set<string>()` 维护全量 `_nodeIds` 和 `_edgeKeys` 索引。对于 1000 万节点 + 5000 万边的图，这些 Set 需要约 0.5-1GB RAM。而底层 `OverGraph` 存储本身就有其内部索引，这种双重索引代价高昂。`_scanAll()` 遍历所有 **Set ID** 再通过 `getNode` 加载数据 — 对于百万级节点每次扫描触发全量随机 I/O。
- **Suggested Fix**: 利用底层 StorageProvider 的迭代能力替代内存索引，或为 `_nodeIds` 添加 lazy loading + LRU 策略。

### F15. `startWatch()` `setInterval` 30s 轮询 — 即使 chokidar 可用也启用
- **Severity**: P3
- **Domain**: performance
- **File**: `src/security/auth.ts` (L113-130)
- **Title**: stat polling 在 chokidar 可用时未清理
- **Detail**: `_startStatPolling()` 只在 chokidar 不可用时调用。但 `startWatch()` 的 catch 分支会调用 `_startStatPolling()`，即使后续 watcher 可能在异常后恢复。另外 stat polling 每 30s 检查一次，在数千节点集群中为每个节点 create 的 Authenticator 实例都会注册一个 polling timer。
- **Suggested Fix**: 使用类级别的单例 StatChecker 或移除 polling 降级逻辑（chokidar 在主流 Node 版本中基本可用）。

### F16. `row-level-secuity.ts` enforceQuery 对所有匹配策略使用 `every()` — 无短路索引优化
- **Severity**: P3
- **Domain**: performance
- **File**: `src/security/rls.ts` (L93-97)
- **Title**: RLS enforceQuery 在大量记录下无索引优化
- **Detail**: `enforceQuery` 对每条记录执行 `matched.every(p => p.filter(ctx, record))`，没有对 filter 函数做类型推断或预检查。在多策略场景下（如多租户 + 资源类型 + 地域），每次 filter 调用都是完整的 JS 函数执行，无编译期优化。对于 100K+ 结果集，会显著拖慢查询。
- **Suggested Fix**: 在 `addPolicy` 时对 filter 函数进行编译/预分析，或支持声明式谓词（declarative predicate DSL）以便批量下推到存储层（push-down）。

### F17. `SegmentStreamWal` 使用 `fs.readFileSync` 在 close() 中读取 manifest — 大文件场景阻塞
- **Severity**: P3
- **Domain**: performance
- **File**: `src/core/segment-stream-wal.ts`
- **Title**: 同步 I/O 在 WAL 关闭路径上
- **Detail**: `close()` 方法中会同步读取 manifest.json。对于有大量 segment 的 WAL（如 64MB*100 = 6.4GB），同步读取 manifest 可能阻塞事件循环数十毫秒。虽然 close 不是 hot path，但在重启或 K8s 滚动更新时，所有节点同时 close 可能造成 coordinator 状态不一致。
- **Suggested Fix**: `close()` 使用 `fs.readFile` 回调版或 `import { promises as fsp } from 'fs'` 的 `fsp.readFile`。

### F18. 测试覆盖盲区 — 缺少安全测试（注入、越权、DoS）和内存泄漏测试
- **Severity**: P3
- **Domain**: testCoverage
- **File**: 测试整体
- **Title**: 测试未覆盖注入攻击、越权绕过、DDoS 路径
- **Detail**: 现有 12 个测试文件覆盖了集成场景（搜索+RLS、Raft cluster、分片备份等），但：
  - 无 SQL/NoSQL 注入测试 → 无 `parseQuery('MATCH ... DROP TABLE')` 类测试
  - 无 RLS 绕过测试 → 无 `deleteNode` 跳过 RLS 的场景
  - 无 body size 超限 → 无 `413` 响应测试
  - 无并发写冲突的 race condition 测试（虽然有一组测试名为 'Q03-10 concurrent queries'，但未使用 `-race` 检测器）
  - 无长稳测试（1000+ 连续操作的内存泄漏检查）
  - `fault-injection/` 目录的 6 个测试虽覆盖了故障场景，但无对应日志/错误恢复行为的断言
- **Suggested Fix**: 
  1. 添加安全注入测试套件
  2. 使用 `--detectOpenHandles` 或 `--forceExit` 以外的更早泄漏检测
  3. 添加内存泄漏基线测试（1000 ops + `global.gc()` 比较 heapUsed）
  4. 添加 RLS 权限提升/越权攻击场景

---

## 分类汇总

### 安全（9 项）
| ID | Severity | 问题 |
|----|----------|------|
| F01 | P0 | bodySizeLimit bypass → OOM |
| F02 | P0 | lockfile 无验证 → supply chain |
| F03 | P1 | Cypher-lite 注入 → RLS bypass |
| F04 | P1 | ZMQ 0.0.0.0 + NAS 模式 CURVE 未生效 |
| F05 | P1 | 37 处 console API 代替结构化日志 |
| F06 | P1 | auth.ts 动态 require |
| F10 | P2 | 备份路径环境变量散落 |
| F12 | P2 | rate limiter remoteAddress key |
| F18 | P3 | 缺少安全攻击测试 |

### 性能（7 项）
| ID | Severity | 问题 |
|----|----------|------|
| F05 | P1 | console API 代替 pino 日志（重复归类） |
| F06 | P1 | 动态 require 冷加载耗时 |
| F07 | P2 | vectorSearch JSON.stringify 开销 |
| F09 | P2 | LMDB WAL 异步 put 弱 fsync |
| F11 | P2 | vectorSearch 浮点精度损失 |
| F13 | P2 | MemoryRateLimiter OOM |
| F14 | P3 | 全量 Set 内存索引 |
| F15 | P3 | stat polling 冗余 |
| F17 | P3 | 同步 I/O 在 close 路径 |

### 架构（6 项）
| ID | Severity | 问题 |
|----|----------|------|
| F04 | P1 | ZMQ bind 0.0.0.0 |
| F08 | P2 | TcpTransport IP 自动选择 |
| F09 | P2 | LMDB WAL fsync 隐式依赖 |
| F10 | P2 | backup 路径未统一管理 |
| F14 | P3 | 内存索引无法扩展 |
| F16 | P3 | RLS enforceQuery 无索引优化 |

### 测试覆盖（1 项）
| ID | Severity | 问题 |
|----|----------|------|
| F18 | P3 | 整体测试覆盖盲区（注入、越权、内存泄漏、长稳） |

---

## 优先级修复建议

### 立即修复（P0 — 发布前）
1. **F01**: Fix bodySizeLimit → 超过限制后跳过 parseBody
2. **F02**: 在 CI 中增加 `npm ci` + `npm audit`

### 本轮迭代（P1）
3. **F03**: 增加 query 注入校验 + RLS 二次 enforce
4. **F04**: ZMQ 0.0.0.0 → 配置化内网地址 + NAS 模式 CURVE 实现
5. **F05**: 替换所有 console API 为结构化日志
6. **F06**: auth.ts require 替换为顶层 import

### 下轮迭代（P2）
7. **F07/F11**: vectorSearch 使用 msgpack 替代 JSON
8. **F09**: LMDB WAL 增加显式 fsync
9. **F10**: Backup 统一配置管理
10. **F12**: rate limiter 支持 X-Forwarded-For
11. **F13**: MemoryRateLimiter 使用 lru-cache
