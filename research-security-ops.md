# AgentiX GraphVec — 安全层 + 运维层深度代码研究报告

> 生成时间: 2026-05-26 08:52 GMT+8
> 研究者: subagent (research-security-ops)

---

## 项 1: mTLS-only 认证重构 (E01/E04)

### 现状分析

#### 1.1 `auth.ts` — chokidar 已连接

- **`Authenticator` 构造函数** (`auth.ts:29-36`): 强制 `mode === 'mtls'`，否则抛出错误。符合只支持 mTLS 的要求。
- **身份文件加载** (`auth.ts:42-73`): `_loadIdentities()` 方法同时支持从 `config.identities` 数组和 `config.identitiesFile` 文件加载。文件使用 `fs.readFileSync` 读取。
- **chokidar 热加载** (`auth.ts:89-109`): `startWatch()` 方法中已正确使用 `require('chokidar')` 监听 `identitiesFile`：
  - 使用 `persistent: false` 避免进程挂起
  - 使用 `awaitWriteFinish` 防止文件写入未完成时触发
  - 监听 `change` 事件 → 调用 `_loadIdentities()`
- **兜底轮询** (`auth.ts:117-137`): 当 chokidar 加载失败时，`_startStatPolling()` 使用 `fs.statSync` 每 30 秒轮询文件 mtime。✅ 已实现
- **停止监控** (`auth.ts:141-152`): `stopWatch()` 方法正确清理 watcher 和 timer。

**结论**: chokidar 热加载已完全集成。缺口为零。

#### 1.2 `types.ts` — `AuthConfig` 定义

- (`types.ts:131-173`): `AuthConfig` 定义为 `mode: 'mtls'`（字面量类型，非字符串联合）。
- 所有遗留字段已清理。`mode` 只能是 `'mtls'`，无 `jwt` / `basic` 选项。
- `AuthorizedIdentity` 接口仅包含 `cn`, `role`, `databases`。✅ 干净

#### 1.3 package.json

- `chokidar` ^5.0.0 ✅ 已装
- `selfsigned` **未安装** ❌
- `jsonwebtoken` ^9.0.0 **仍然存在** ❌

#### 1.4 jsonwebtoken 引用检查

- `package.json` 和 `package-lock.json` 仍声明 `jsonwebtoken` 和 `@types/jsonwebtoken`
- **所有 `.ts` 源码文件中无任何 `import` 或 `require('jsonwebtoken')`** 引用
- `auth.ts` 中有 `UserRegistry`、`RateLimiter`、`authenticateBasic`、`authenticateToken`、`requireAuth` 等 **deprecated 导出**，全部抛出 `Deprecated` 错误。这些是为兼容性保留的桩（stub），不依赖 jsonwebtoken。
- `node_modules` 中 `ecdsa-sig-formatter` 在其 `package.json` 中将 `jsonwebtoken` 列为引用的包名（描述性引用，非依赖）。

### 缺口与方案

| 缺口 | 严重程度 | 方案 |
|------|----------|------|
| `jsonwebtoken` 仍为 runtime 依赖 | **中** | 从 `dependencies` 移除 `jsonwebtoken` 和 `devDependencies` 中移除 `@types/jsonwebtoken`，然后 `npm uninstall` |
| `selfsigned` 未安装（dev 模式需要） | **低** | 安装 `selfsigned` 作为 devDependency（用于测试中自签证书生成） |
| 两个 `RBAC` 类冲突 | **中** | 见项 3 分析 |

**实现方案**:
1. `npm uninstall jsonwebtoken @types/jsonwebtoken --save`
2. 保留 `auth.ts` 中的 deprecated stub 导出（它们已经硬编码抛出错误，不依赖 jsonwebtoken）
3. （可选）安装 `npm install --save-dev selfsigned` 用于 dev 场景的证书生成

---

## 项 2: HTTPS/mTLS 支持 (E04)

### 现状分析

#### `rest.ts` — 已使用原生 Node.js `https` 模块

- (`rest.ts:291`): `const server = https.createServer({...})` — **已经使用 `https.createServer`**，不是 `http.createServer`
- (`rest.ts:291-292`): 将 `config.tlsConfig.getServerOptions()` 展开传递给 `https.createServer`，后者提供：
  - `cert`, `key` ✅
  - `requestCert: true` ✅
  - `rejectUnauthorized: true` ✅
  - `ca` (如果配置了 tlsCA) ✅

#### `tls.ts` — TLS 选项生成

- (`tls.ts:31-44`): `TLSConfig.getServerOptions()` 方法通过 `fs.readFileSync` 加载证书/私钥，构建 `https.ServerOptions`。请求客户端证书（`requestCert: true`），拒绝未授权（`rejectUnauthorized: true`）。

#### 证书 CN 提取

- `rest.ts:129-138`: `extractCN()` 函数通过 `req.socket.getPeerCertificate().subject.CN` 提取。与 `tls.ts:48-62` 中的 `TLSConfig.extractCNFromRequest()` 功能重复。

### 缺口与方案

| 缺口 | 严重程度 | 方案 |
|------|----------|------|
| 无 HTTP-to-HTTPS 重定向 | **低** | 可选安装 `http` 服务器的重定向中间件 |
| `extractCN()` 与 `TLSConfig.extractCNFromRequest()` 重复 | **低** | 统一为使用 `TLSConfig.extractCNFromRequest()` |
| 不支持 `SNICallback`（多证书） | **低** | 非必要，mTLS 场景证书通常是统一的 |
| 不支持 `ALPN` 协议协商 | **低** | 非必要，HTTP/1.1 即可 |

**结论**: **基本无缺口**。REST API 服务器已正确配置为 mTLS（`https.createServer` + `requestCert: true` + `rejectUnauthorized: true`）。无需改动。

---

## 项 3: RBAC 数据库级权限 + RLS 查询下推 (E05)

### 现状分析

#### 3.1 RBAC — 存在两个重复实现

`src/security/rbac.ts` 和 `src/security/auth.ts` 中各有一个 `RBAC` 类，功能高度重复。

**`auth.ts` 中的 RBAC** (`auth.ts:210-257`):
- `PERMISSIONS`: ADMIN=全部, OPERATOR=读写+管理操作, WRITER=读写, READER=只读
- `checkPermission()` / `checkDatabaseAccess()` / `getPermissions()`
- `checkDatabaseAccess()` 支持数据库级别的白名单检查

**`rbac.ts` 中的 RBAC** (`rbac.ts:12-62`):
- `PERMISSIONS` 同上
- `checkPermission()` / `checkResourceAccess()` / `getPermissions()`
- `checkResourceAccess()` 只做了简单的 reader 不能写检查，不涉及数据库名

**REST 路由使用情况**:
- `rest.ts:8` 从 `auth.ts` 导入 `RBAC`，不是从 `rbac.ts`
- (`rest.ts:363-366`): 在认证后调用 `RBAC.checkPermission(auth.role, matched.requiredPermission)`
- **未调用** `checkDatabaseAccess()`，因此数据库级权限在 REST 层未强制执行

#### 3.2 RLS — 已实现但未集成到查询引擎

**`rls.ts`** (`rls.ts:42-92`):
- `RowLevelSecurity` 类完整，支持 `addPolicy()` / `removePolicy()` / `enforceQuery()` / `checkRecord()`
- `RLSContext` 包含 `userId`, `role`, `tenantId`, `properties`
- `enforceQuery()` 在内存中对查询结果进行过滤

**集成状态**:
- `grep` 结果显示 `RowLevelSecurity` / `RLS` **没有被任何非测试代码引用**
- RLS 未导入到 `graph-engine.ts`、`query-engine.ts`、`shard-manager.ts` 或 `rest.ts`
- 既不是查询前过滤（谓词下推），也不是查询后过滤

### 缺口与方案

| 缺口 | 严重程度 | 方案 |
|------|----------|------|
| RBAC 重复定义 | **高** | 删除 `src/security/rbac.ts` 的重复类，统一使用 `auth.ts` 中的 RBAC |
| REST 层未调用 `checkDatabaseAccess()` | **高** | 在 `rest.ts` 的路由处理中加入数据库权限检查 |
| RLS 未集成到查询引擎 | **高** | 3 个集成点 (见下方) |

**RLS 集成路径**:

1. **`graph-engine.ts` (查询后过滤)**: `getNode()` / `neighbors()` / `vectorSearch()` 等方法之后调用 `rls.enforceQuery()`
2. **`query-engine.ts` (谓词下推)**: 在 Cypher 查询计划阶段注入 RLS 过滤条件，避免全量返回后再过滤
3. **`rest.ts` (请求级权限)**: 为每个请求创建 `RLSContext`，传入查询引擎

由于 OverGraph 是嵌入式存储（非 SQL 数据库），**真正的 RLS "查询下推"不可行**（底层存储不支持 WHERE 谓词注入）。合适的策略是：
- 在 `graph-engine.ts` 的结果返回层做 `enforceQuery()`
- 在 `rest.ts` 做请求级 RLS 上下文传递

---

## 项 4: DatabaseManager 多数据库路由 (E02)

### 现状分析

#### 4.1 `database-manager.ts`

- (`database-manager.ts:39-110`): 完整实现。支持 `resolve()` / `getDatabase()` / `hasDatabase()` / `listDatabases()` / `createDatabase()` / `dropDatabase()` / `getStats()`
- 每个数据库分配独立的 `ShardManager` 和 `ShardMap`
- 物理存储隔离：`{dataDir}/{dbName}/range-{i}/`

#### 4.2 `rest.ts` — 路由检查

目前 `rest.ts` 的路由表 (`rest.ts:203-271`) 只有以下路径：
- `GET /api/status`
- `POST /api/graph/nodes`
- `GET /api/graph/node`
- `DELETE /api/graph/node`
- `GET /api/health`
- `GET /api/admin/replication`
- `PUT /api/admin/replication/config`

**没有 `/api/v1/:db/...` 格式的多数据库路由** ❌

REST 层直接操作单个 `ShardManager`（通过 `rest.ts:3` 的构造函数参数传入），不支持根据 URL 路径中的 `:db` 选择不同 DatabaseManager 实例。

### 缺口与方案

| 缺口 | 严重程度 | 方案 |
|------|----------|------|
| REST 路由不支持 `/api/v1/:db/...` | **高** | 重构 route 匹配逻辑 |

**实现方案**:

1. 将 `RestApiConfig` 扩展为接受 `DatabaseManager` 替代 `ShardManager`
2. 路由匹配改为支持前缀 `/api/v1/:db/graph/...`
3. 在 route 匹配后通过 `dbm.resolve(dbName)` 获取目标数据库的 `ShardManager`
4. 保留 `/api/status` 和 `/api/health` 为全局路由（无 db 参数）

核心改动:

```typescript
// rest.ts (伪代码)
export interface RestApiConfig {
  port: number
  host: string
  authenticator: Authenticator
  tlsConfig: TLSConfig
  databaseManager: DatabaseManager  // 替换原有的 ShardManager
  // ... 其余字段
}
```

路由表扩展:

```typescript
{ method: 'GET', path: '/api/v1/:db/status', ... }
{ method: 'POST', path: '/api/v1/:db/graph/nodes', ... }
{ method: 'GET', path: '/api/v1/:db/graph/node', ... }
// ...
```

---

## 项 5: 备份一致性 + 压缩 (O01)

### 现状分析

#### 5.1 `backup.ts` — 一致性保障

**当前实现**:
- (`backup.ts:57-135`): `backup()` 方法
  - `inProgress` 标志防止并发备份 (`backup.ts:66-68`) ✅
  - HLC 时间戳记录一致性标记 (`backup.ts:73-74`) ✅
  - `.consistency-marker` 文件写入 (`backup.ts:85-92`) ✅
  - 标记文件 `fsync` 保证落盘 (`backup.ts:94-99`) ✅
  - 使用 `archiver` 打包为 `.tar.gz` (`backup.ts:106-128`) ✅

**但存在严重一致性问题**:
- (`backup.ts:80`): **`fs.cpSync(dataDir, destPath, { recursive: true })` 拷贝期间不阻塞写入**
- 这意味着备份过程中，数据目录可能在变化，导致：
  - **文件系统级不一致**：LMDB/OverGraph 的多个文件可能在拷贝中途被修改
  - **没有数据库级快照**：没有调用 `engine.sync()` 或类似方法确保内存数据 flush
  - `fs.cpSync` 是 Node.js 18+ API，低版本 Node 不兼容

#### 5.2 压缩状态

- `backup.ts:106-128`: 使用 `archiver` 创建 `.tar.gz` ✅
- `backup.ts:159-189`: 恢复时支持 `.tar.gz`（使用 `tar` 包解压）✅
- `archive` 方案完整，gzip level 6 合适

#### 5.3 恢复流程

- (`backup.ts:149-194`): `restore()` 方法有回滚保护（`pre-restore` 备份） ✅
- (`backup.ts:148`): 先验证 `backupPath` 存在再修改目标 ✅
- (`backup.ts:195-220`): `listBackups()` ✅

#### 5.4 PITR 支持

- (`backup.ts:243-339`): `enablePITR()` / `createIncremental()` / `restoreToTimestamp()` / `listRecoveryPoints()` 均已实现 ✅
- (`backup-wal.ts`): `WalArchiver` 支持 WAL 归档、列出、按保留数量清理 ✅

### 缺口与方案

| 缺口 | 严重程度 | 方案 |
|------|----------|------|
| 备份时无数据库级一致性快照 | **高** | 在 `fs.cpSync` 之前调用 `engine.sync()` 或 `engine.flush()` |
| `fs.cpSync` 不支持 Node.js 16 | **中** | 改用 `fs.cp` (Promise 版) 或递归 `fs.cpSync` + `fs.mkdirSync`。但 `engine.sync()` 才是核心问题 |
| 备份中不阻断写入但数据可能不一致 | **高** | 见下方详细方案 |

**一致性保证方案**:

OverGraph 作为嵌入式 KV 存储，备份时最安全的方法是：

1. **读锁 + 快速拷贝**: 先 `engine.sync()` 确保所有 pending write 落盘，然后 `fs.cpSync`。此时 OverGraph 处于一致状态（LMDB 使用 MVCC，打开的读取事务看到的是快照）。
2. **冷备份（停写）**: 在关闭写入（Raft 停止接受新操作）后拷贝。安全但影响在线。
3. **存储层快照**: 利用 LMDB 原生的 `mdb_reader_check` + COW 快照。

**推荐方案**（折衷）:
```typescript
// 在 backup() 方法中添加
// 2. Flush 引擎确保内存数据落盘
if (typeof (this.engine as any).sync === 'function') {
  (this.engine as any).sync()
}
// 然后重建 inProgress 检查和拷贝逻辑
```

当前备份流程中 **没有足够的 fsync 保护**。添加 OverGraph/LMDB flush 后即可。

---

## 项 6: 导入流式+批量 (O01)

### 现状分析

#### `graph-import.ts`

- (`graph-import.ts:43-62`): `importFile()` 支持 CSV / JSON / GraphSON / RDF 四种格式
- (`graph-import.ts:191-242`): **JSON 导入是 `JSON.parse(content)` + 全量加载** ❌ 不支持流式
- (`graph-import.ts:103-170`): **CSV 导入是 `fs.readFileSync` + 全量加载** ❌ 不支持流式
- (`graph-import.ts:249-290`): **GraphSON 导入同 JSON** ❌ 不支持流式
- (`graph-import.ts:296-340`): **RDF/N-Triples 导入同 JSON** ❌ 不支持流式
- **没有使用 `csv-parse` 包** ❌ (虽然 `csv-parse` ^6.2.1 已安装)
- **没有使用 `ndjson` / 行级流式解析** ❌
- **没有批量写入**（每条记录逐一 `await this.engine.upsertNode()`）❌

### `csv-parse` 和 `ndjson` 引用

- `grep` 结果：`src/import/` 下无任何 `csv-parse` 或 `ndjson` 引用
- `package.json` 中 `csv-parse` 已装但未使用

### 缺口与方案

| 缺口 | 严重程度 | 方案 |
|------|----------|------|
| 全量加载无法处理大文件 | **高** | 使用 `csv-parse` 的 stream API + Node.js `fs.createReadStream` |
| 没有批量写入 | **高** | 使用 `engine.batchUpsertNodes()` / `engine.batchUpsertEdges()`（如果支持）或 `shardManager.batchUpsertNodes()` |
| 逐条 `await` 写入 | **中** | 改为固定批次大小（如 500），分批并行写入 |
| RDF 不支持 Turtle/XML | **低** | 当前只支持 N-Triples。可后续添加 |

**实现方案**:

```typescript
// 核心改造：流式 CSV 导入
import { createReadStream } from 'fs'
import { parse } from 'csv-parse'

private async importCSVStream(options: ImportOptions): Promise<ImportResult> {
  const BATCH_SIZE = 500
  let batch: Array<{ type: string; values: string[] }> = []
  const parser = fs.createReadStream(options.filePath)
    .pipe(parse({ delimiter: options.delimiter ?? ',', from_line: options.skipHeader ? 2 : 1 }))

  for await (const record of parser) {
    batch.push({ type: record[0].trim().toLowerCase(), values: record.slice(1) })
    if (batch.length >= BATCH_SIZE) {
      await this._flushBatch(batch)
      batch = []
    }
  }
  if (batch.length > 0) await this._flushBatch(batch)
}
```

同样地，JSON/NDJSON 使用 `JSON.parse` 流（`stream-json` 或手动行解析）进行流式处理。但由于约束要求"无需外部服务"，可以自己实现行级 NDJSON 解析（不依赖 `ndjson` npm 包，因为 `csv-parse` 已装但 `ndjson` 未装）。

**替代方案**: 使用 Node.js 内置 `readline` + 行级 JSON 解析（不需要额外 npm 包）。

---

## 项 7: 运维自动化 (Phase 1/2)

### 7.1 证书轮转 (certificate rotation)

- `grep "cert.*rotate\|rotate.*cert\|cert.*renew\|cert.*expir" -i`: **无匹配** ❌
- `tls.ts`: 证书在 `getServerOptions()` 中启动时读取一次。**无热加载** ❌
- `auth.ts`: 身份文件有热加载，但证书没有。

| 缺口 | 严重程度 | 方案 |
|------|----------|------|
| 无证书热加载/轮转 | **高** | 扩展 `TLSConfig` 支持 chokidar 监听证书文件，变更时重启 https server |
| 无证书过期预警 | **中** | 添加定时检查证书过期时间的逻辑 |

**方案**:
1. 在 `TLSConfig` 中添加类似 `Authenticator.startWatch()` 的方法，使用 chokidar 监听 `tlsCert` 和 `tlsKey`
2. 证书变更时，通过回调让 `rest.ts` 重启 HTTPS server（`server.close()` + `newServer.listen()`）
3. 可选：添加 Prometheus metric `cert_expiry_seconds` 导出证书剩余有效期

### 7.2 过期预警

- **无实现** ❌

### 7.3 审计日志持久化

- (`security/audit.ts`): `AuditLogger` 使用 pino 输出结构化日志，支持 `logPath` 参数写入文件 ✅
- 审计日志在内存中也有缓存 (`entries: AuditEntry[]`) 用于 `getRecent()` / `getAll()`
- **核心持久化已实现** ✅
- 但缺少文件轮转（rolling file appender）

| 缺口 | 严重程度 | 方案 |
|------|----------|------|
| 日志文件轮转 | **中** | 使用 `rotating-file-stream` 包（已装！`^3.2.9`）包装 pino 的写入目标 |
| 审计日志检索 API | **低** | 已通过 `getRecent()` / `getAll()` 实现 |

**`rotating-file-stream` 已在 `package.json` 中**但 `audit.ts` 中未使用！需要集成：
```typescript
import rfs from 'rotating-file-stream'
const stream = rfs.createStream('audit.log', { size: '10M', interval: '1d' })
```

### 7.4 自动备份 (node-cron)

- `grep "node-cron\|node_cron\|cron\|scheduler"`: **无命中** ❌
- `node-cron` ^4.2.1 已装 ❌
- 无任何定时调度逻辑

| 缺口 | 严重程度 | 方案 |
|------|----------|------|
| 无自动备份调度 | **高** | 使用 node-cron 调度定时备份 |

**方案**:
```typescript
import cron from 'node-cron'
import { Backup } from './backup'

export class BackupScheduler {
  constructor(private backup: Backup, private backupDir: string) {}

  start(cronExpression = '0 3 * * *'): void { // 每天凌晨3点
    cron.schedule(cronExpression, async () => {
      await this.backup.backup(this.backupDir)
    })
  }
}
```

### 7.5 Prometheus /metrics

- `prom-client` ^15.1.3 已装 ✅
- `src/ops/metrics.ts`: 使用**自定义 Metrics 类**（内存计算），**不使用 prom-client** ❌
- `src/ops/otel-metrics.ts`: 使用 OTel API ✅，但需 Telemetry 启用才能工作
- 没有 `/metrics` 端点 ❌

| 缺口 | 严重程度 | 方案 |
|------|----------|------|
| 没有 `/metrics` HTTP 端点 | **高** | 在 REST API 中注册 `GET /metrics` 路由 |
| `metrics.ts` 不使用 prom-client | **中** | 重构为使用 prom-client 的 `Counter`, `Histogram`, `Gauge`；或在 REST 路由中添加 prom-client 的输出 |

**最小实现方案**:
```typescript
// rest.ts 中增加
import { register } from 'prom-client'

routes.push({
  method: 'GET',
  path: '/metrics',
  requireAuth: false, // 或 requireAuth: true, permission: 'metrics'
  handler: async (_req, res) => {
    const metrics = await register.metrics()
    res.writeHead(200, { 'Content-Type': register.contentType })
    res.end(metrics)
  },
})
```

### 7.6 CDC ConsumerGroup

- `grep "CDC\|ChangeData\|consumer\|ConsumerGroup" -i`: **无匹配** ❌
- 无 CDC 实现

| 缺口 | 严重程度 | 方案 |
|------|----------|------|
| 无 CDC 基础设施 | **高** | 基于 WAL 或 SegmentStreamWAL 实现 Change Data Capture |

**方案**:
利用现有的 `src/core/segment-stream-wal.ts` 或 `src/consensus/wal.ts` 作为 CDC 数据源：
1. 创建 `CDCStream` 类，订阅 Raft WAL 的写入通知
2. 支持多个 Consumer Group（通过 event-bus 分发）
3. 每个 CDC event 包含操作类型、数据 payload、HLC 时间戳
4. Consumer Group 支持 offset 管理（从 Replication Outbox 读）

### 7.7 Smart Routing 持久化

- `shard-manager.ts:114`: `_smartRoute()` 基于 `_rangeTypeAffinity`（内存 Map）做路由
- (`shard-manager.ts:275-280`): `_incrementAffinity()` 在 `upsertNode` 时递增计数器
- **`_rangeTypeAffinity` 没有持久化** ❌

| 缺口 | 严重程度 | 方案 |
|------|----------|------|
| Smart Routing 数据在重启丢失 | **中** | 持久化到 LMDB/OverGraph |

**方案**:
1. 在 `ShardManager` 中添加 `persistAffinity()` / `loadAffinity()` 方法
2. 定期序列化 `_rangeTypeAffinity` 到 OverGraph 的元数据 key（或独立的 LMDB 数据库）
3. 启动时从存储加载

---

## 总结

### 严重程度汇总

| 项 | 标题 | 缺口数量 | 最高严重程度 |
|----|------|----------|-------------|
| 1 | mTLS-only 认证重构 | 2 | 中 (jsonwebtoken) |
| 2 | HTTPS/mTLS 支持 | 0 | ✅ 无缺口 |
| 3 | RBAC + RLS 查询下推 | 3 | 高 |
| 4 | DatabaseManager 多数据库路由 | 1 | 高 |
| 5 | 备份一致性 + 压缩 | 2 | 高 |
| 6 | 导入流式+批量 | 3 | 高 |
| 7 | 运维自动化 | 6+ | 高 (多项) |

### 需要安装的 npm 包

| 包名 | 状态 | 用途 |
|------|------|------|
| `selfsigned` | **需安装** (dev) | 开发测试自签证书 |
| `jsonwebtoken` | **需移除** | 已废弃，源码无引用 |

其余所需包均已安装（`csv-parse`, `archiver`, `tar`, `chokidar`, `node-cron`, `prom-client`, `rotating-file-stream`, `pino`）。

### 建议优先级

1. **P0 (安全隐患)**: 移除 `jsonwebtoken` + 解决备份一致性
2. **P0 (功能缺陷)**: REST 路由支持多数据库 + 流式导入
3. **P1 (加固)**: 集成 RLS 到查询引擎 + 统一 RBAC
4. **P1 (运维)**: 自动备份调度 + /metrics 端点 + 证书热加载
5. **P2 (增强)**: CDC + Smart Routing 持久化 + 审计日志轮转
