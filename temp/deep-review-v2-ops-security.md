# 深度审查 V2：运维 + 安全 + 导入 + 可观测性

**审查范围**: `src/ops/`, `src/security/`, `src/import/`, `src/dashboard/`, `src/cli/`
**审查日期**: 2026-05-23
**审查人**: agenitX 内部审查子系统

---

## 1. 安全模型

### S-01 认证机制无用户/角色持久化存储
- **模块**: `src/security/auth.ts`
- **严重度**: 🔴
- **对比**: Neo4j 有完整的 RBAC（用户+角色+图库ACL）+ LDAP 集成；Dgraph 有 Guardian 角色和 ACL；ArangoDB 有集合级别读写执行权限。
- **描述**: `Authenticator` 类支持 JWT、Basic、API Key、mTLS 和 Token 四种认证模式，但**没有用户/角色持久化存储**。角色直接解码自 JWT 或映射自配置中的 apiKeys。缺乏独立的用户管理系统、角色层级、权限矩阵。mTLS 认证只映射为 `READER` 角色，不支持按证书配置不同权限。
- **方案**: 引入独立的 `UserStore` / `RoleStore`，支持用户 CRUD、角色继承（admin > writer > reader）、图/表级别 ACL 控制。配置中的 apiKeys 维护一份运行时映射即可。JWT 解码后应从 store 验证用户当前权限（而非仅依赖 token 中的 role 声明）。
- **工作量**: 大

### S-02 审计日志双系统未整合
- **模块**: `src/security/audit.ts` + `src/ops/audit-log.ts`
- **严重度**: 🟡
- **对比**: Neo4j/Dgraph/ArangoDB 均提供统一的审计日志接口。
- **描述**: 系统内有**两套独立的审计日志类**: `AuditLogger`（`src/security/audit.ts`，pino-based，记录 API 层操作）和 `AuditLogger`（`src/ops/audit-log.ts`，WAL CDC 订阅，记录数据层操作和 Raft 事件）。两者类名完全相同（可能产生模块冲突），且数据格式、持久化策略各不相关。
- **方案**: 合并为一个 `AuditService`：API 层操作提交给 `AuditService.logOperation()`；CDC 订阅通过 `AuditService.onWALCommit()` 回写。统一记录格式 `{ timestamp, operation, user, role, resource, traceId }`，统一持久化（pino 日志文件 + 可选的 JSON 归档）。
- **工作量**: 中

### S-03 API 层无认证中间件
- **模块**: `src/security/auth.ts`
- **严重度**: 🔴
- **对比**: Neo4j 所有 API（HTTP/Bolt）均要求认证；Dgraph 要求 JWT/API Key；ArangoDB 要求 Bearer Token。
- **描述**: `Authenticator` 类定义了认证能力，但**没有任何 Express/Koa 中间件或 HTTP 拦截器**强制要求请求通过认证。REST API 网关 `serveCmd` + `RestApiServer` 的代码中未展示任何认证中间件。`Authentication` 仅作为可选的 CLI 参数存在。
- **方案**: 在 REST API 和 WebSocket 层实现认证中间件：前置 `AuthInterceptor`，从 `Authorization` 头或 mTLS 证书提取凭证，调用 `Authenticator.authenticate()`。禁止未认证请求通过。dashboard 的 CORS `Access-Control-Allow-Origin: *` 也应限制到可信来源。
- **工作量**: 中

### S-04 默认配置存在安全风险
- **模块**: `src/security/auth.ts`
- **严重度**: 🔴
- **对比**: Neo4j 要求首次启动修改默认密码；Dgraph 默认启用 ACL；ArangoDB 要求设置 root 密码。
- **描述**: `Authenticator` 构造函数检查 `jwtSecret === 'default-secret'` 抛出异常，但系统**默认没有强制要求配置 jwtSecret 的启动流程**。如果用户跳过自定义配置直接启动，系统可能报错退出或退化为不安全状态。同时 `validateAuthConfig()` 是手动调用的，不在启动链路中自动执行。
- **方案**: 将 `validateAuthConfig()` 集成到应用启动（`node start`）的必经路径，不通过验证则拒绝启动。添加更严格的秘密策略：jwtSecret 长度 >= 32 字符、apiKeys 必须至少包含 1 个密钥。
- **工作量**: 小

### S-05 加密缺失
- **模块**: `src/security/`
- **严重度**: 🔴
- **对比**: Neo4j 支持数据加密（transparent encryption at rest）；Dgraph 支持 TLS/mTLS 传输加密；ArangoDB 支持加密卷存储和 SSL/TLS。
- **描述**: 系统**没有任何传输层（TLS）或存储层（加密）支持**。mTLS 认证的 CN 可用作身份验证，但没有 TLS listener 的实际实现。Dashboard server 为纯 HTTP。数据文件以明文存储。
- **方案**: 实现 TLS listener 包装（`https.createServer`），支持证书链配置；OverGraph 数据目录支持 AES-256-GCM 加密（写入时加密、读取时解密）。Dashboard 应支持 HTTPS。
- **工作量**: 大

---

## 2. 备份与恢复

### B-01 备份无一致性快照保障
- **模块**: `src/ops/backup.ts`
- **严重度**: 🔴
- **对比**: Neo4j 在线备份使用事务日志确保一致性（类似 WAL checkpoint）；Dgraph Live Backup 使用 MDB 的事务快照；ArangoDB Arangobackup 在引擎层支持 MVCC 快照。
- **描述**: `Backup.backup()` 仅通过 `fsp.cp()` 递归复制数据目录，**不要求 OverGraph 引擎先执行 checkpoint/flush**。虽然没有阻止同时写入（注释明确说"不阻塞同时写入"），但在复制过程中写入的数据可能导致部分写入的文件副本，从而产生不一致的快照。`.consistency-marker` 文件只记录了备份开始时的 HLC 时间戳，无法保证备份内所有文件都在同一状态。
- **方案**: 备份前先对 OverGraph 引擎调用 `checkpoint()` 或 `sync()` 方法确保磁盘数据一致；复制过程中使用 OverGraph 提供的快照能力（而非裸文件复制）；恢复时应配合 WAL 回放至一致性标记的时间点。
- **工作量**: 大

### B-02 恢复流程缺乏数据校验
- **模块**: `src/ops/backup.ts`
- **严重度**: 🟡
- **对比**: Neo4j 恢复时校验备份完整性；Dgraph 的 Bulk Loader 会校验数据格式。
- **描述**: `Backup.restore()` 直接用 `fsp.cp()` 复制备份目录到目标。恢复前虽然检查备份源存在和 `.consistency-marker`，但**没有进行数据完整性校验**（checksum、图结构校验、节点/边计数匹配）。恢复过程中若备份源损坏，直接复制会造成数据丢失。
- **方案**: 恢复前置校验：计算备份目录的 `sha256sum` 清单（备份时生成），恢复前验证；恢复完成后做图结构完整性扫描（节点边匹配、引用完整性）。
- **工作量**: 中

### B-03 缺少增量备份和备份策略
- **模块**: `src/ops/backup.ts`
- **严重度**: 🟡
- **对比**: Neo4j 支持增量备份（变化事务日志）；Dgraph Live Backup 支持连续导出；ArangoDB 的 arangodump 支持增量。
- **描述**: 当前备份实现为**全量文件复制**，不支持增量备份。对于大图（GB/TB 级），全量复制时间窗口太长、磁盘占用过高。无备份策略配置（保留周期、自动清理、远程存储）。
- **方案**: 实现增量备份机制：利用 WAL/CDC 的 commit 序列，备份上次全量备份后的变更日志（类似 MySQL binlog）。全量 + 增量备份的组合策略，可配置保留版本数和存储目标。
- **工作量**: 大

---

## 3. 导入性能

### I-01 导入完全串行，无批处理/并发控制
- **模块**: `src/import/graph-import.ts`
- **严重度**: 🔴
- **对比**: Neo4j `neo4j-admin import` 支持多线程批量写入（数千节点/秒）；Dgraph Bulk Loader 支持 GOMAXPROCS 并行批量加载；ArangoDB arangoimport 支持批大小和并发。
- **描述**: `GraphImporter` 的 CSV 和 GraphSON 导入**完全串行**：逐行读取 → 逐行 `engine.upsertNode()` / `engine.upsertEdge()`。没有 `Promise.all`、没有 `batchSize` 控制、没有并发配置。630 行的导入器没有使用任何并发原语。RDF 解析也是逐个三元组处理。
- **方案**: 实现批处理导入器：支持可配置的 `batchSize`（如 1000 条/批），使用 `Promise.all` + concurrency limit 批量提交。对 `engine.upsertNode` 增加批量 upsert 接口。CSV 解析流式处理 + 批量写入管道。
- **工作量**: 中

### I-02 缺乏对大文件的支持（流式/内存控制）
- **模块**: `src/import/graph-import.ts`
- **严重度**: 🟡
- **对比**: Neo4j LOAD CSV 支持流式读取；Dgraph Bulk Loader 支持分块处理；ArangoDB arangoimport 支持文件流。
- **描述**: CSV 导入使用 `fs.readFileSync()` 一次性读入内存（`content = fs.readFileSync(filePath, 'utf-8')`），对于 GB 级文件会耗尽内存。GraphSON 的 `importGraphSon(data: string)` 同样要求完整 JSON 在内存中。RDF 导入也是整体读入。
- **方案**: 使用 `fs.createReadStream()` + `readline` 逐行处理 CSV；使用流式 JSON 解析器（如 `JSONStream`）处理 GraphSON；RDF 导入实现流式读取。
- **工作量**: 中

### I-03 无导入错误恢复/事务回滚
- **模块**: `src/import/graph-import.ts`
- **严重度**: 🟡
- **对比**: Neo4j 的 LOAD CSV 和 neo4j-admin import 使用事务，部分失败时可回滚；Dgraph Bulk Loader 使用批量事务。
- **描述**: 导入过程**没有事务包装**。每行数据独立调用 `engine.upsertNode()`，单行失败时只记录错误继续（已有实现），但已写入的行无法回滚。`ImportResult` 包含 `nodesCreated` 计数，但没有提供回滚或清理接口。
- **方案**: 导入前创建 checkpoint/snapshot，失败时回滚到 checkpoint；或包装为事务（批量提交前不持久化）。对于生产化的导入流程，支持"导入会话"概念（开始 → 批量提交 → 提交/回滚）。
- **工作量**: 大

### I-04 RDF 解析器脆弱
- **模块**: `src/import/graph-import.ts`
- **严重度**: 🟡
- **对比**: Neo4j 通过 APOC 插件支持 RDF（使用 Apache Jena）；Dgraph 通过 rdf-to-dgraph 工具；ArangoDB 通过 Foxx 服务。
- **描述**: RDF/XML 和 Turtle 解析器使用**粗糙的正则表达式**（`/<[^:]*:Description[^>]*>/gi`、`/<[^\s>]+(?::[^\s>]+)?/gi`），不支持标准 RDF 命名空间缩写（如 `foaf:name`）、不支持 RDFa 嵌入、不支持 XML 命名空间默认 URI 解析。对于复杂 RDF 文档可能产生错误解析或不完整解析。
- **方案**: 集成 `n3`（Turtle 解析器）和 `rdfxml-streaming-parser` 作为可选依赖，实现完整的 RDF 1.1 标准解析。保留原生正则解析作为零依赖降级方案。
- **工作量**: 中

---

## 4. 可观测性

### O-01 指标收集已接入但未暴露
- **模块**: `src/ops/otel-metrics.ts`
- **严重度**: 🟡
- **对比**: Neo4j 内置 Prometheus 端点（metrics endpoint）、Grafana 面板；Dgraph 内置 /health、/admin、Prometheus 兼容的 /metrics 端点；ArangoDB 内置 /_admin/metrics。
- **描述**: `MetricsCollector` 和 `Telemetry` 实现良好：计数器、直方图、仪表盘均已封装，ShardManager 已埋点（`incrementCounter('graph.ops.writes')`、`recordHistogram('graph.ops.latency')`）。但 **dashboard server 没有暴露 /metrics 端点**（不符合 Prometheus 或 OTel 标准接口）。指标只能通过 OTLP gRPC 协议推送到外部 collector，没有拉模式支持。
- **方案**: 在 dashboard server 中添加 `/metrics` 端点，以 Prometheus 文本格式暴露 OpenTelemetry 指标（使用 `@opentelemetry/exporter-prometheus` 或自定义 transform）。支持 Prometheus scrape 模式。同时保留 OTLP gRPC push 模式。
- **工作量**: 中

### O-02 分布式追踪链路不完整
- **模块**: `src/ops/otel.ts` + `src/shard/shard-manager.ts`
- **严重度**: 🟡
- **对比**: Neo4j 支持事务追踪；Dgraph 支持 opentracing/gRPC 追踪；ArangoDB 支持链路追踪。
- **描述**: `Telemetry.traceAsync()` 实现了 OTel span 包装，ShardManager 已使用 `this.telemetry.traceAsync('shard.upsertNode', ...)`。但**埋点覆盖不完整**：导入流程、备份恢复、CLI 命令都没有 span 包装。traceId 未跨模块传播（审计日志中记录 traceId 但源头 span 没有关联上下游）。
- **方案**: 全面埋点：导入器每个 batch 创建 span、备份流程创建 root span、GraphQL 解析器创建 span。确保 traceId 通过异步上下文传播（`AsyncLocalStorage` 或 context API）。
- **工作量**: 中

### O-03 Dashboard 健康检查缺失磁盘信息
- **模块**: `src/ops/health.ts`
- **严重度**: 🔵
- **对比**: Neo4j 监控系统有完整的磁盘使用监控；Dgraph 内置 /health 节点信息；ArangoDB Dashboard 提供存储统计。
- **描述**: `Health.getStatus()` 中 `storage.diskFree` 和 `storage.diskUsed` 硬编码为 0，注释"需要从实际文件系统读取"。作为健康检查的重要维度，磁盘空间监控缺失。
- **方案**: 使用 `df` 或 `fs.statfs`（或 `check-disk-space` 包）读取数据目录所在文件系统的可用磁盘。`check()` 方法中当磁盘空间低于阈值（如 10%）时返回 `degraded` 状态。
- **工作量**: 小

### O-04 Dashboard 数据源集成不完善
- **模块**: `src/dashboard/data-provider.mjs`
- **严重度**: 🟡
- **对比**: Neo4j Browser 提供 Cypher 查询控制台和实时监控；Dgraph Ratel 提供 Schema 管理、查询和监控。
- **描述**: `data-provider.mjs` 使用 `createRequire` 桥接编译后的 CommonJS 模块，但 `init(sm)` 需要在服务器启动时调用，**没有自动初始化机制**。`getSlowQueries()` 返回空数组（`queries: []`），没有任何慢查询记录能力。dashboard 没有可交互的查询控制台。
- **方案**: 集成慢查询记录能力（在 graph-engine 层捕获超过阈值的查询），dashboard 添加 Cypher/Gremlin 风格的查询控制台。将 data-provider 改写为纯 ESM 的 `index.mjs` 导出，简化初始化流程。
- **工作量**: 中

---

## 5. CLI

### CLI-01 `node add/remove` 命令未实现
- **模块**: `src/cli/index.ts`
- **严重度**: 🟡
- **对比**: Neo4j 提供 `neo4j-admin` 全部运维命令；Dgraph 提供 `dgraph zero`、`dgraph alpha`、`dgraph bulk` 等完备 CLI；ArangoDB 提供 `arangosh` 交互式 shell。
- **描述**: `node add` 和 `node remove` 命令只打印占位消息（`console.log('Adding node...')`），没有实际逻辑。不支持节点热添加/移除、集群扩缩容的完整流程。同样 `cluster snapshot` 和 `admin compact` 也是占位实现。
- **方案**: 实现 `node add`（通过 Raft 配置变更动态添加 peer）和 `node remove`（graceful removal + data migration）。`cluster snapshot` 触发 Raft snapshot + 存储快照。`admin compact` 触发 OverGraph 存储压缩。
- **工作量**: 大

### CLI-02 CLI 缺少按标签/属性查询
- **模块**: `src/cli/index.ts`
- **严重度**: 🔵
- **对比**: Neo4j 提供完整的 Cypher 查询能力；Dgraph 提供 GraphQL± 和 DQL 查询；ArangoDB 提供 AQL 查询。
- **描述**: 查询命令仅限于 `get-node --id`（按 ID）和 `get-node --name --type-id`（按名称+类型）。不支持按任意属性查询（`--filter prop=value`）、复杂条件查询或 Cypher/DQL/AQL 风格的图查询。对于图数据库的 CLI 工具链来说，查询能力严重不足。
- **方案**: 添加 `query` 子命令，支持过滤条件表达式（`--filter "age > 18"`、`--filter "status = active"`）。支持输出格式选择（`--format json|cypher|table`）。支持交互式查询模式。
- **工作量**: 中

### CLI-03 CLI 缺少运维自动化脚本支持
- **模块**: `src/cli/index.ts`
- **严重度**: 🔵
- **对比**: Neo4j 提供 `neo4j-admin` 脚本化运维、`cypher-shell` 批量查询；Dgraph 提供 `dgraph live` 批量导入模式。
- **描述**: CLI 缺少对自动化/脚本使用场景的支持：没有 `--quiet` 模式（无彩色输出）、没有 `--output json` 选项（`cluster status` 和 `admin stats` 已输出 JSON，但 `admin compact`、`cluster snapshot` 等仍是控制台消息）、没有管道友好格式（每行一个 JSON）、没有批量操作模式。
- **方案**: 统一输出格式：所有命令默认支持 `--json` 和 `--quiet` 选项；添加 `batch` 子命令支持批量操作（从 JSONL 文件读入操作序列）。
- **工作量**: 小

---

## 6. 物化视图 & 事件驱动

### MV-01 物化视图刷新为全量扫描，无增量更新
- **模块**: `src/materialized-view/materialized-view.ts`
- **严重度**: 🟡
- **对比**: Neo4j Transaction Events + APOC Trigger 支持增量触发；Dgraph 无内置物化视图但可基于 Subscription 实现增量；ArangoDB Foxx Queue + Collection Events 支持事件驱动。
- **描述**: `MaterializedView.refresh()` 每次调用都执行全量 `queryPattern()` 扫描 source engine，然后 upsert 所有结果。**没有增量更新机制**（只处理变更的记录）。对于大图，全量扫描代价高昂。`refreshPolicy` 仅支持 `periodic`，没有 `event-driven` 模式。
- **方案**: 实现事件驱动刷新：通过 WAL CDC 订阅捕获变更事件，仅处理受影响的模式匹配结果。添加 `refreshPolicy: 'event-driven'` 模式。实现增量合并（batch 内多条变更合并后刷新）。与 MaterializedViewConfig 配合，支持条件过滤和投影字段配置。
- **工作量**: 大

### MV-02 缺少触发器/事件订阅机制
- **模块**: `src/core/`、`src/api/`、`src/shard/`
- **严重度**: 🔴
- **对比**: Neo4j Transaction Events 可以拦截所有写操作；Dgraph Subscription/Watch 支持实时推送；ArangoDB Foxx Queue 支持异步事件处理。
- **描述**: 全系统**没有事件总线或事件发布/订阅机制**。WAL 的 `onCommit` 回调仅用于审计日志。物化视图、触发器、WebSocket 推送、跨 DC 同步等场景完全依赖轮询（periodic refresh）。没有任何 `EventEmitter`、pub/sub 或消息队列的抽象。
- **方案**: 实现 `EventBus` 单例：数据变更（upsert/delete）发布到 `EventBus.emit('data.changed', payload)`；订阅者注册 `EventBus.on('data.changed', handler)`。在 WAL commit 回调中触发事件分发。支持以下消费者：物化视图增量刷新、WebSocket 推送、跨 DC 复制加速、自定义触发器。
- **工作量**: 大

### MV-03 无 WebSocket/长连接推送能力
- **模块**: `src/api/`
- **严重度**: 🟡
- **对比**: Dgraph Subscription 通过 gRPC streaming 实时推送数据变更；Neo4j 支持 Bolt 协议的事务推送。
- **描述**: REST API 基于纯 HTTP，没有任何 WebSocket 端点。无法实现实时数据变更通知。对于"监听节点变更"、"图变更推送"等场景需要客户端轮询。
- **方案**: 集成 `ws` 库，在 REST API server 中并行启动 WebSocket server。通过 EventBus（见 MV-02）驱动推送。提供订阅协议：`subscribe { type: 'node', id: 123 }` → 当该节点变更时推送更新。
- **工作量**: 中

---

## 审查总结

| 维度 | 严重问题 (🔴) | 中等问题 (🟡) | 轻微问题 (🔵) |
|------|:---------:|:---------:|:---------:|
| 安全模型 | 4 | 1 | 0 |
| 备份与恢复 | 1 | 2 | 0 |
| 导入性能 | 1 | 3 | 0 |
| 可观测性 | 0 | 3 | 1 |
| CLI | 0 | 1 | 2 |
| 物化视图&事件 | 1 | 2 | 0 |
| **合计** | **7** | **12** | **3** |

### Top-3 优先修复

1. **S-03 / MV-02**: 缺乏 API 认证中间件 + 无事件总线 — 安全和实时基础设施的基座缺陷
2. **S-01 / S-05**: 无用户/角色系统 + 无加密 — 生产级安全的基本要求缺失
3. **I-01 / B-01**: 导入无并发 + 备份无一致性 — 性能和可靠性的基础瓶颈
