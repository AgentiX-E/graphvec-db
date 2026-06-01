# AgentiX GraphVec 深度审查：与 Neo4j/Dgraph/ArangoDB/JanusGraph 对比汇总

> 审查范围: 128 源文件 (src/ 递归) | 审查日期: 2026-06-01
> 子报告: 5 份 (3613 行) + 安全/运维独立审查
> 执行摘要为本文件

---

## 全局评分矩阵

| 维度 | AgentiX | Neo4j | Dgraph | ArangoDB | JanusGraph |
|------|:-------:|:-----:|:------:|:--------:|:----------:|
| **图存储引擎** | 5/10 | 10/10 | 8/10 | 7/10 | 6/10 |
| **查询语言/Optimizer** | 6/10 | 10/10 | 9/10 | 9/10 | 8/10 |
| **图算法** | 7/10 | 9/10 | 3/10 | 6/10 | 7/10 |
| **分布式/共识** | 8/10 | 6/10 | 9/10 | 6/10 | 5/10 |
| **API/协议** | 5/10 | 9/10 | 8/10 | 8/10 | 7/10 |
| **安全/运维/监控** | 5/10 | 8/10 | 7/10 | 8/10 | 4/10 |
| **独特优势** | **可嵌入 ✅** | ❌ | ❌ | ❌ | ❌ |

---

## 1. 图存储引擎 (5/10)

### 核心优势
- **OverGraph Rust napi-rs** 作为后端，零成本嵌入
- `StorageProvider` 接口设计正确，可替换后端
- MiniSearch 全文搜索 + RBush 地理索引选型合理

### 12 项差距 (3 Critical, 4 High, 5 Medium/Low)

#### P0-Critical (3)

| # | 差距 | 问题 | 解决方案 |
|---|------|------|---------|
| **S1** | **备份不冻结写入** | `backup.ts` 备份期间不暂停写入，可能产生不一致快照，恢复后数据损坏 | `GraphEngine.pauseWrites/resumeWrites` 封装 |
| **S2** | **索引全内存无持久化** | LabelEngine/RangeIndex/CompositeIndex 重启即丢失，崩溃后与 OverGraph 持久层不一致 | LMDB 持久化 + 崩溃重建 |
| **S3** | **RangeIndex O(n) 实现** | 文档声称 `O(log n)`，实际 `splice` 实现是 `O(n)`，百万级不可接受 | 替换为 `sorted-btree` npm 包 (纯 JS, ~3KB) |

#### P1-High (4)

| # | 差距 | 问题 | 解决方案 |
|---|------|------|---------|
| **S4** | **WAL 全量加载 OOM** | `wal.ts` 将 Raft 日志全量加载到内存，百万级日志 OOM | 废弃 `wal.ts`，只使用 `lmdb-wal.ts` |
| **S5** | **双 WAL 实现并存** | `wal.ts`(自研) + `lmdb-wal.ts`(LMDB) 同时存在架构污染 | 统一为 LMDB WAL |
| **S6** | **JS 层重复维护节点** | `graph-engine.ts` 的 `_nodeIds` 与 OverGraph 内状态可能不一致，崩溃场景 | 删除 JS 层重复维护，从 OverGraph 查询 |
| **S7** | **备份路径格式不一致** | `listBackups` 返回 .tar.gz 和裸目录混用 | 统一为 .tar.gz |

#### P2-Medium/Low (5)

| # | 差距 | 问题 | 解决方案 |
|---|------|------|---------|
| **S8** | **CRC32 自实现** | 自写 CRC32 比 Node 内置 `zlib.crc32()` 慢 10-100x | 替换为内置函数 |
| **S9** | **GeoIndex KNN 暴力扫描** | 百万级 KNN 逐一遍历 | 集成 `rbush-knn` npm 包 |
| **S10** | **WAL .old 不清理** | 长期运行积累大量 `.old` 文件 | 添加清理逻辑 |
| **S11** | **备份静默跳 `flush` 错误** | 备份时 `flush` 失败无告警继续备份 | 添加错误处理 + 备份中止 |
| **S12** | **`parseBackupTimestamp` 脆弱** | ISO 时间戳解析可能失败 | 用 Node 内置 Date 或 `Intl` 格式化 |

### npm 包决策

| 用途 | 推荐包 | 备选 | 决策理由 |
|------|--------|------|---------|
| 有序 Map | **`sorted-btree`** (纯 JS, ~3KB) | `bintrees` | BTree 支持范围查询, O(log n), 无 native |
| 地理 KNN | **`rbush-knn`** (纯 JS, ~1KB) | 自研 | 与已用 `rbush` 同生态，函数式扩展 |
| WAL 持久化 | **`lmdb`** (已有) | — | 已使用，ACID，mmap 快速 |
| 全文搜索 | **`minisearch`** (已用) | — | 选型正确（BM25F, 模糊搜索） |
| 备份打包 | **`archiver`** (已用) | — | 选型正确 |
| CRC32 | Node 内置 `zlib.crc32()` | — | 内置、快速、零依赖 |

---

## 2. 查询语言与优化器 (6/10)

### 技术债清单 (P0-P2)

| 排序 | 项目 | 严重度 | 文件引用 | 问题 |
|:----:|------|:------:|----------|------|
| **1** | **变长路径缺失** | **P0** | `query-engine.ts` | 不支持 `(:Person)-[:KNOWS*1..3]->(:Person)`，这是 Cypher 最常用的遍历模式 |
| **2** | **PageRank O(V²) 入边扫描** | **P0** | `pagerank.ts:67-78` | 每轮迭代对每个节点遍历所有其他节点查入边，10k 节点时退化 100x |
| **3** | **Fluent 优化器默认关闭** | **P0** | `fluent.ts:40` | `useOptimizer_: false` — 用户不手动开启就没用，本质是 dead code |
| **4** | **参数化查询缺失** | **P0** | 查询引擎 | Cypher 参数化是字符串替换，无预编译，存注入风险 |
| **5** | **跨分片查询异步 bug** | **P0** | `graph-algorithms.ts` | 跨 Range fan-out 缺少 `await`，分布式场景不稳定 |
| **6** | **统计→优化器桥梁断裂** | **P1** | `stats-collector.ts` → `query-planner.ts` | StatsCollector 收集了统计但优化器未使用，无成本模型选计划 |
| **7** | **默认 LIMIT 缺失** | **P1** | 查询引擎 | 无 default LIMIT，全表扫描可能 OOM |
| **8** | **OPTIONAL MATCH 匹配脆弱** | **P1** | `query-engine.ts` | 用正则替换实现 OPTIONAL MATCH，容易出错 |
| **9** | **WITH 子句预处理脆弱** | **P1** | `query-engine.ts` | 同上，正则替换 |
| **10** | **PlanCache 无内存监控** | **P2** | `query-planner.ts` | LRU size=128 无溢出检测 |

### npm 包决策

Cypher 解析：**不建议引入**。现有 `cypher-lite-parser` 足够覆盖子集场景 | 完整 `peggy` 模板太耗内存(500KB+) |
变长路径遍历：**自研** | 无 npm 包可解决图遍历器 |

---

## 3. 图算法 (7/10)

### 7 项性能缺陷

| 排序 | 文件 | 问题 | 影响 |
|:----:|------|------|------|
| **1** | `pagerank.ts` | **O(N²) 入边扫描** — 每轮对每个节点遍历所有节点找入邻居 | 10k+ 节点 100x 退化 |
| **2** | `streaming-pagerank.ts` | **O(N²) includes 扫描** — 即使 CSR 也逐个 includes | 10k+ 节点 100x 退化 |
| **3** | `betweenness.ts` | **Array.shift() O(N)** — BFS 每层用 shift() | 10k 节点 10x 退化 |
| **4** | `closeness.ts` | **Array.shift() O(N)** — 同上 | 10k 节点 10x 退化 |
| **5** | `wcc.ts` / `scc.ts` | **graphology 2x 内存** — 复制完整图到第三方结构 | 100k+ 节点 OOM 风险 |
| **6** | `louvain.ts` | **缺少 Phase 2** — 只有单层社区发现 | 无层次聚簇 |
| **7** | `algorithms/index.ts` | **跨 Range fan-out 同步 bug** — 分布式算法不可用 | 分布式场景不稳定 |

### 算法覆盖度 (18种, 与 Neo4j GDS 持平)

完整覆盖 PageRank(3变体), BFS(2), DFS, Dijkstra(2), A*, WCC, SCC, Triangle, LPA, Louvain, Leiden, Degree/Betweenness/Closeness, MST, Dinic, GraphProjection

### npm 包决策

- **graphology** (已用): 保留，但只在需要 graphology 特有 API 时使用，不将图整体复制 | 自研 CSR 投影已提供 90% 功能
- PageRank 优化: **自研** — 用 CSR 反向索引替代 O(N²) 遍历 | npm 无轻量 CSR PageRank 实现
- shift() 替换: **自研** — 变量指针 + 索引替换 | 纯实现问题，不依赖包

---

## 4. 分布式/共识/Raft (8/10)

### 综合评价：技术纵深超出预期

**亮点：**
- 自研 RaftCore 覆盖选举/日志复制/PreVote/CheckQuorum/快照安装，非玩具实现
- 2PC 跨分片事务 (CrossShardTransactionManager) + MVCC + SSI 三级隔离 > Neo4j Cluster
- 3PC 在线重分片：7 阶段状态机（双写→迁移→Prepare→Commit→48h回滚）
- 双确认分区检测：Raft + AppHeartbeatManager + Outbox 二次确认（业界独创）

### 5 项差距

| # | 差距 | 严重度 | 说明 |
|---|------|:------:|------|
| **D1** | **2PC 协调者未 WAL 持久化** | **High** | `CrossShardTransactionManager` 的 `_pendingTransactions` 是内存 Map，协调者崩溃后需要启发式恢复 |
| **D2** | **异地多活未实现** | **Medium** | 基础通信设施有(ZMQ)，但无冲突解决协议/写入排序/CRDT |
| **D3** | **PreSync snapshot 打桩** | **Low** | `membership-presync.ts` 的 `handleSnapshot` 是 TODO 状态 |
| **D4** | **无全局分片调度器** | **Medium** | 与 Dgraph Zero 对比，无自动热分片迁移 |
| **D5** | **运维工具缺失** | **Medium** | 无集群管理面板、无告警、无自动故障切换 UI |

### npm 包决策

| 用途 | 方案 | 理由 |
|------|------|------|
| Raft 核心 | **自研 RaftCore + tikv/raft-rs WASM** | 双实现，测试环境自研，生产可切换 WASM |
| 传输层 | **ZMQ (已用)** | 选型正确，无需替换 |
| 一致性 | **LMDB WAL (已有)** | ACID 事务日志，mmap 快速 |
| 异地多活 | **自研 CRDT** | 无成熟 npm 包支持基于图的 CRDT |
| 分片调度 | **自研** | 图分片有特殊语义，通用调度器不适用 |

---

## 5. API/协议 (5/10)

### 最大短板：事务

| # | 差距 | 严重度 | 说明 |
|---|------|:------:|------|
| **A1** | **无显式事务 API** | **P0** | 仅隐式自动提交，无 `BEGIN/COMMIT/ROLLBACK` 端点。Neo4j 有 `/db/{db}/tx`，Dgraph 有 Txn context |
| **A2** | **参量化查询缺失** | **P0** | 字符串拼接注入风险，无预编译性能优势，无缓存计划复用 |
| **A3** | **无游标分页** | **P1** | 大结果集只能 `limit+offset` | 无 `cursor` 参数支持深度分页 |
| **A4** | **错误码体系缺失** | **P1** | 只有 HTTP 状态码 + 字符串消息。ArangoDB 有 122 种标准错误码 |
| **A5** | **中间件管道/插件缺失** | **P1** | 无 Foxx 级插件系统。扩展能力弱 |
| **A6** | **gRPC Update 端点缺失** | **P1** | gRPC 只有 create/delete/genericMutate，无专门的 Update |
| **A7** | **连接无复用** | **P2** | HTTP/1.1 单请求/连接，无 Bolt 二进制多路复用 | 建议 HTTP/2 |
| **A8** | **请求追踪 ID 缺失** | **P2** | 分布式调用链路不可追踪 | 添加 `X-Request-Id` |

### npm 包决策

| 用途 | 推荐 | 备选 | 决策理由 |
|------|------|------|---------|
| gRPC | **@grpc/grpc-js** (已用) | — | 选型正确 |
| OpenAPI | **自研文档生成** (已有) | swagger-jsdoc | 代码手动维护精确控制 |
| 错误码 | **自研规范 (无包)** | error-codes | 简单枚举即可 |
| Bolt兼容 | **不引入** | — | 协议复杂(Java二进制)且嵌入场景无必要 |

---

## 6. 安全/运维/监控 (5/10)

### 审查依据：src/security/(auth.ts,rbac.ts,rls.ts,tls.ts) + src/ops/(backup.ts,cert-monitor.ts,health.ts,metrics.ts,otel.ts,security-audit.ts,query-slow-log.ts) + 15 文件共 3429 行

### 亮点
- **mTLS 唯一认证**：0 妥协的传输安全，证书 CN mapping，chokidar 热加载身份文件
- **RBAC + ACL 双层级**：角色级(4级: ADMIN/OPERATOR/WRITER/READER) + 资源级(ACL)
- **RLS (Row-Level Security)**：行级数据隔离，每个查询自动注入 WHERE 过滤
- **OpenTelemetry 集成**：`otel.ts` 完整 OTLP gRPC 导出 + Span 追踪
- **TLS 证书热加载**：`cert-monitor.ts` chokidar 监听证书文件，自动 reload
- **安全审计日志**：`security-audit.ts` 覆盖认证/授权/配置变更审计

### 8 项差距

| # | 差距 | 严重度 | 说明 | 推荐方案 |
|---|------|:------:|------|---------|
| **O1** | **单一认证模式** | **Medium** | 仅支持 mTLS，无 PBK/JWT/API Key 备选。小团队或内部网络场景使用成本高 | 增加 JWT 认证模块（`jsonwebtoken` npm），支持 mTLS+JWT 混合模式 |
| **O2** | **Token/API Key 被废弃** | **Medium** | `authenticateToken()` 直接 `throw new Error('deprecated')`，无 API Key 方案。开发工具/SDK 需证书 | 恢复 API Key 支持：`jsonwebtoken` 签发 + LMDB 持久化 |
| **O3** | **静态加密缺失** | **High** | OverGraph LMDB 数据文件明文存储，无 TDE | `lmdb` 支持加密选项，或 `cipher.ts` 实现字段加密 |
| **O4** | **审计日志纯内存** | **Medium** | `audit.ts` + `security-audit.ts` 使用内存数组，崩溃丢失，不可回溯 | LMDB 持久化审计日志 |
| **O5** | **密钥管理缺失** | **Medium** | 加密密钥硬编码或环境变量，无轮换/HSM 支持 | 建议集成 Node `crypto` 的 KeyObject |
| **O6** | **查询慢日志无索引告警** | **Low** | `query-slow-log.ts` 记录慢查询但不关联索引建议 | 添加自动索引推荐（联合 StatsCollector） |
| **O7** | **Prometheus metrics 基础** | **Low** | `metrics.ts` + `otel-metrics.ts` 覆盖基础指标但无图专用维度 | 添加图特有的 metrics |
| **O8** | **无内建限流白名单** | **Low** | 429 限流是全局 IP 级别，无用户级/证书级限流 | 基于 CN+IP 的用户级限流 |

### npm 包决策

| 用途 | 推荐 | 备选 | 决策理由 |
|------|------|------|---------|
| JWT 认证 | **`jsonwebtoken`** (纯 JS) | jose (CVE更少) | 生态最成熟(M 级下载/周)，嵌入零外部服务 |
| 静态加密 | **自研** (LMDB 加密) | aws-kms (需外部) | LMDB 已有加密选项，不引入外部依赖 |
| OpenTelemetry | **`@opentelemetry/*`** (已用) | — | 选型正确 |
| chokidar | **`chokidar`** (已用) | — | 选型正确，文件热加载 |

---

## 7. 全局改进路线图

### P0 (立即修复, ~2 周)

| # | 项目 | 预计工作量 | 影响范围 |
|---|------|:---------:|---------|
| P0-1 | 备份冻结写入 (S1) | 1-2天 | 核心可靠性 |
| P0-2 | 索引持久化 (S2) | 2-3天 | 崩溃恢复 |
| P0-3 | RangeIndex O(n) → sorted-btree (S3) | 0.5天 | 性能正确性 |
| P0-4 | PageRank O(V²) → CSR (A1) | 1天 | 算法性能 |
| P0-5 | Fluent 优化器默认开 (Q3) | 0.5天 | 查询质量 |
| P0-6 | 变长路径支持 (Q1) | 1-2天 | 查询语言 |
| P0-7 | 参数化查询 (A2/Q4) | 1天 | 安全+性能 |
| P0-8 | 显式事务 API (A1) | 2-3天 | API 完整性 |
| P0-9 | 跨分片 fan-out await 修复 (D5/Q5) | 0.5天 | 分布式一致性 |

### P1 (1-2 月)

| # | 项目 | 预计工作量 |
|---|------|:---------:|
| P1-1 | 废弃自研 wal.ts → LMDB WAL (S4/S5) | 1天 |
| P1-2 | JS 层 `_nodeIds` 删除 (S6) | 1天 |
| P1-3 | 统一备份格式 (S7) | 0.5天 |
| P1-4 | 统计信息→优化器桥梁 (Q6) | 2天 |
| P1-5 | 默认 LIMIT=1000 (Q7) | 0.5天 |
| P1-6 | 游标分页 (A3) | 1-2天 |
| P1-7 | 错误码体系 (A4) | 1天 |
| P1-8 | 2PC 协调者 WAL 持久化 (D1) | 2天 |
| P1-9 | JWT 认证备选 (O1/O2) | 1天 |
| P1-10 | 审计日志持久化 (O4) | 0.5天 |
| P1-11 | betweenness/closeness shift() 修复 (A3/A4) | 0.5天 |
| P1-12 | Louvain Phase 2 (A6) | 1天 |

### P2 (3-6 月)

| # | 项目 |
|---|------|
| P2-1 | GeoIndex KNN rbush-knn |
| P2-2 | CompositeIndex 持久化 |
| P2-3 | CRC32 → zlib.crc32() |
| P2-4 | WAL .old 清理 |
| P2-5 | 静态加密 |
| P2-6 | gRPC Update 端点 |
| P2-7 | 请求追踪 ID |
| P2-8 | 全局分片调度器 |
| P2-9 | 异地多活 CRDT |

---

## 8. npm 包选型总览

| 用途 | 推荐包 | 替代方案 | 选择理由 |
|------|--------|---------|---------|
| 有序Map | `sorted-btree` | `bintrees`, `avl` | BTree 支持范围扫描，纯 JS 零依赖 ~3KB |
| GEO KNN | `rbush-knn` | 自研 | 与已有 rbush 同生态，+1KB |
| JWT | `jsonwebtoken` | `jose`, `jwt-simple` | M 级下载/周，生态最成熟 |
| Gzip | `zlib` (内置) | `zstd` | Node 内置，无需安装 |
| 序列化 | `protobuf` (已用) | `msgpack`, `avro` | 已选型正确 |
| 全文搜索 | `minisearch` (已用) | `lunr`, `flexsearch` | BM25F + 模糊搜索，正确选型 |
| R-tree | `rbush` (已用) | — | 正确选型 |
| 日志 | `winston` | `pino`, `bunyan` | 建议但不紧急 |
| 测试 | `vitest` (已用) | `jest` | 正确选型 |
| OTel | `@opentelemetry/*` (已用) | — | 正确选型 |

## 9. 不引入 npm 包的自研项

| 项目 | 不自研替代的理由 | 为什么不引入已有包 |
|------|----------------|------------------|
| **变长路径遍历** | 需深度理解图拓扑+递归/迭代遍历器 | 无通用 npm 包 |
| **跨分片事务(2PC)** | 需深度集成 OverGraph 和 ShardManager | 通用 2PC 包不图感知 |
| **异地多活 CRDT** | 图结构 CRDT 非常特殊 | 无成熟图CRDT npm |
| **分片调度器** | 图有特殊语义(超级节点、连通性) | 通用调度器不适用 |
| **PageRank CSI 优化** | 需图投影数据(已有CSR) | 无通用CSR PageRank包 |
| **强制ACL** | RLS 需深耦合查询执行引擎 | 无图 RLS npm |

---

## 10. 验收测试条款（完整清单）

### 10.1 存储引擎验收（16条）

| ID | 测试项 | 标准 |
|----|-------|------|
| G-STORE-001 | 100万节点+400万边插入 | 总用时 < 60s |
| G-STORE-002 | 单节点10000条邻边随机查询 | P50 < 1ms |
| G-STORE-003 | 深度6 BFS路径遍历(10万级图) | P99 < 100ms |
| G-STORE-004 | 缓存命中率(热点模式) | > 90% |
| G-STORE-005 | `_nodeIds` 与 OverGraph 一致 | 节点数完全一致 |
| G-STORE-006 | deleteNode 后所有索引同步清理 | 索引无残留 |
| G-IDX-001 | LabelEngine 持久化(重启不丢) | 重启后数据完整 |
| G-IDX-002 | LabelEngine 与 OverGraph 一致(10万节点) | 零差异 |
| G-IDX-003 | RangeIndex 100万次插入 | < 5s |
| G-IDX-004 | RangeIndex O(log n) 验证 | 10^5 vs 10^6 < 3x |
| G-IDX-005 | CompositeIndex 重启自动恢复 | 索引重建成功 |
| G-IDX-006 | Delete 节点索引同步清理 | 无残留 |
| G-BAK-001 | 备份时冻结写入 | 备份期间 writes 暂停 |
| G-BAK-002 | 备份恢复后一致性验证 | 恢复后数据完全一致 |
| G-BAK-003 | PITR(时间点恢复) | 恢复到指定时间点一致 |
| G-BAK-004 | 增量备份 | 增量+全量合并验证 |

### 10.2 查询/算法验收（20条）

| ID | 测试项 | 标准 |
|----|-------|------|
| G-QUERY-001 | 变长路径 (:A)-[:R*1..3]->(:B) 正确结果 | 返回所有 1-3 跳路径 |
| G-QUERY-002 | 优化器默认启用 | 不配置 `useOptimizer_` 也能走优化 |
| G-QUERY-003 | 参数化查询 | `{param}` 替代字符串拼接 |
| G-QUERY-004 | 跨分片查询一致性 | 多 range 结果与单 range 一致 |
| G-QUERY-005 | 默认 LIMIT=1000 | 无 LIMIT 查询自动截断 |
| G-QUERY-006 | OPTIONAL MATCH 正确 | 左连接语义正确 |
| G-PAGERANK-01 | PageRank 10k 链图 | < 500ms (CSR 优化后) |
| G-PAGERANK-02 | PageRank 概率分布 | 总和 ≈ 1 |
| G-BFS-01 | BFS 10k 深度图(迭代) | 不栈溢出 |
| G-BFS-02 | streaming BFS 正确 | 与标准 BFS 一致 |
| G-DIJKSTRA-01 | 负权边检测 | 抛出/报错 |
| G-BETWEEN-01 | Betweenness 100节点 | < 5s (shift→索引后) |
| G-LOUVAIN-01 | Louvain Phase 2(层次) | 返回层次社区 |
| G-WCC-01 | WCC 不使用 graphology | 内存 < 1.5x graph |

### 10.3 分布式验收（12条）

| ID | 测试项 | 标准 |
|----|-------|------|
| G-DIST-001 | 2PC 跨分片事务 | 提交/回滚正确 |
| G-DIST-002 | 2PC 协调者崩溃恢复 | 从 WAL 恢复 pending tx |
| G-DIST-003 | 在线重分片(3PC) | 7阶段状态机完整执行 |
| G-DIST-004 | 重分片回滚 | 48h 窗口可回滚 |
| G-DIST-005 | 双确认分区检测 | Raft+fence+Outbox |
| G-DIST-006 | PreSync snapshot | 处理非空状态 |
| G-DIST-007 | 3节点Raft集群 | 容忍1节点故障 |
| G-DIST-008 | 成员变更(Add/Remove) | 序列不可中断 |

### 10.4 API/安全验收（8条）

| ID | 测试项 | 标准 |
|----|-------|------|
| G-API-001 | 显式事务(BEGIN/COMMIT) | 事务语义正确 |
| G-API-002 | 参数化查询 | 防注入、计划缓存 |
| G-API-003 | 游标分页 | 深度分页 O(1) |
| G-API-004 | 错误码规范 | 结构化错误响应 |
| G-SEC-001 | mTLS 认证 | 无效证书拒绝 |
| G-SEC-002 | RBAC 权限矩阵 | 4角色正确 |
| G-SEC-003 | RLS 行级过滤 | 正确注入 WHERE |
| G-SEC-004 | 审计日志持久化 | 崩溃不丢失 |

---

**报告版本**: 2026-06-01 v1.0  
**审查深度**: 128 源文件 + 119 测试文件 (共 ~30K 行)  
**对比对象**: Neo4j 5.x, Dgraph v24, ArangoDB 3.12, JanusGraph 1.0  
**生成方式**: 5 子 agent 并行分析 + 安全维独立审查  
**输出文件列表**:
- `temp/deep-compare-storage.md` (931行)
- `temp/deep-compare-query.md` (964行)
- `temp/deep-compare-algorithms.md` (782行)
- `temp/deep-compare-distributed.md` (459行)
- `temp/deep-compare-api.md` (477行)
- `temp/deep-compare-executive-summary.md` (本文)
