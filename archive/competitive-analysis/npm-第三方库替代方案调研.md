# npm 第三方库替代方案调研报告

> 调研日期: 2026-05-24
> 方法: 4 路子 agent 并行深度调研 npm 生态 + 关键包版本/依赖验证
> 目标: 为 AgentiX GraphVec 108 项优化找出可替代「自己动手实现」的成熟 npm 包
> 原则: 只评估可嵌入、零外部服务依赖的纯 npm 包

---

## 核心结论

### 推荐采用的包（A 级，节省 47~61 人天）

| 包 | 版本 | 项目对应需求 | 可替代 | 节省 |
|:---|:----:|:------------|:------:|:----:|
| **graphology** + 扩展 | 0.26.0 | 图算法(A*/SCC/Louvain/连通图/metrics) | 8 个自研算法文件 | **8~10d** |
| **lmdb** | 3.5.4 | WAL 持久化/Key-Value 存储/Range 元数据 | wal.ts + stream-wal.ts 部分 | **10~15d** |
| **minisearch** | 7.2.0 | 全文搜索(百万文档) | 全文搜索全部 | **5~7d** |
| **chokidar** | 5.0.0 | 配置文件热加载(身份文件/证书) | mtime poll | **1.5d** |
| **archiver** | 8.0.0 | 备份压缩/归档 | 手写 fs.cpSync | **1d** |
| **csv-parse** | 6.2.1 | 导入 CSV 解析 | CSV parser | **1d** |
| **node-cron** | 4.2.1 | 自动备份调度 | cron scheduler | **1d** |
| **prom-client** | 15.1.3 | Prometheus metrics 导出 | 手写 metrics | **2d** |
| **rotating-file-stream** | 3.2.9 | 审计日志轮转 | log rotator | **1d** |
| **xxhash-wasm** | 1.1.0 | CRC 完整性校验 | 手写 hash | **0.5d** |
| **msgpackr** | 2.0.1 | 二进制序列化替代 JSON | MessagePack 编码 | **2d** |
| **selfsigned** (dev) | 5.5.0 | 测试用自签名证书 | 手写 openssl | **0.5d** |

### 已有但需要升级用法的（无需安装）

| 已存在的包 | 项目版本 | 未充分利用的能力 |
|:---------|:--------:|:----------------|
| **pino** | 9.x ✅ | 审计日志输出（当前项目自己的 Logger 实现可以改用 pino child logger） |
| **lru-cache** | 11.x ✅ | 查询结果缓存（当前只用在 _nodeIdToName，可以扩展到邻接缓存） |
| **@opentelemetry/*** | ✅ | 当前已有但未接到 Raft/共识层 metrics |
| **@consento/hlc** | ✅ | HLC 时钟已经用得很好 |

### 不可替代的自研方向（npm 生态空白）

| 领域 | 原因 | 替代策略 |
|:-----|:----|:---------|
| **Raft 共识** | 已用 raft-logic（tikv/raft-rs WASM），这是唯一的生产级 JS Raft 引 | 完善 adapter 连接，不换包 |
| **增量备份** | npm 无 rdiff/rsync 库（rdiff@0.0.5 已废弃，不兼容 Node 18+） | WAL shipping 自研或 child_process rsync |
| **CRDT 图 merge** | yjs(13.x) 是 text/richtext CRDT，不适用于图结构 merge | 继续使用 graph-crdt 或自研 |
| **Cypher 解析** | cypher-parser@0.1.14 依赖 C 扩展，无法嵌入 | 轻量自研或 Neo4j Driver 代理 |
| **mTLS + HTTPS** | Node.js 原生 tls 已经做完了 | 不需要额外包 |

---

## 详细调研：A 级推荐

### 1. graphology 生态 — 替代 8 个图算法文件

**npm**: `graphology@0.26.0` + `graphology-components` + `graphology-shortest-path` + `graphology-communities-louvain` + `graphology-metrics` + `graphology-traversal` + `graphology-dag`

**版本检查**: 0.26.0 发布于 2025-01-26，维护中（Guillaume Plique / yomguithereal，也是 sigma.js 作者）

**覆盖清单**：

| 项目 P0 需求 | graphology 对应 | match |
|:-------------|:---------------|:-----:|
| A* 最短路径 | `graphology-shortest-path` → `astar()` | ✅ |
| K-Shortest Paths | `graphology-shortest-path` → `yen()` | ✅ |
| SCC (Tarjan) | `graphology-components` → `stronglyConnectedComponents()` | ✅ |
| 连通子图 | `graphology-components` → `connectedComponents()` | ✅ |
| 社区发现 | `graphology-communities-louvain` | ✅ |
| BFS/DFS | `graphology-traversal` → `bfsFromNode()/dfsFromNode()` | ✅ |
| 节点中心性 | `graphology-metrics` → `centrality` | ✅ |
| DAG 检测 | `graphology-dag` → `willCreateCycle()` | ✅ |

**集成策略**: graphology 是纯内存 Graph 对象。我们不能把 OverGraph 的数据全部倒入 graphology 再跑算法——那会 OOM。正确的做法是：
1. **在 graphology 中建轻量索引**（仅存 nodeId + edgeType）
2. 算法需要的 neighbor 查询由 OverGraph 的 `neighbors()` 实时喂给 graphology
3. 或者一次性提取子图（如 A* 只需要 source-target 间的小图）→ graphology → 算法

**适配器代码估算**: 约 60~100 行（将 OverGraph 查询结果适配到 graphology 的 `Graph` 接口），而非每个算法写 100~300 行。

**节省**: 8 个算法文件 → **8~10 人天**

---

### 2. LMDB — 替代 WAL 存储层

**npm**: `lmdb@3.5.4`

**为什么重要**：
- LMDB 是 **mmap 的键值存储**，零拷贝读取、事务写入
- Node.js 生态中最快的嵌入式数据库（12+ 个版本，2026-04 仍活跃）
- 原生 C 绑定，性能接近 SQLite，比纯 JS 的 JSON 文件快 100x+

**可替代方案**：

| 方案 | 做法 | 节省 |
|:----|:-----|:----:|
| **激进** | 用 LMDB 完全替代 `stream-wal.ts` + `wal.ts` | **10~15d** |
| **中等** | 仅用 LMDB 做 Raft Log 存储（替代 WAL JSON 文件），写入事务有 fsync 保证 | **5~7d** |
| **保守** | 仅用 LMDB 做 Smart Routing 持久化（SH-05）+ Raft 元数据 | **2~3d** |

**LMDB 自带的能力**：
- ✅ Transaction: 事务写入，崩溃恢复
- ✅ fsync: 默认调用 msync，写入保证
- ✅ MMap: 零拷贝，不占用 JS heap
- ✅ CRC: 内部 checksum
- ✅ 并发: Reader 完全无锁（MVCC），Writer 单线程序列化

**风险**：需要 native addon 编译（`node-gyp-build-optional-packages` 可回退）

**推荐策略**：**保守起步**——先用 LMDB 做 Smart Routing 持久化 + Raft meta 存储。如果效果好，再逐步扩大 WAL 替换范围。

---

### 3. MiniSearch — 替代全文搜索

**npm**: `minisearch@7.2.0`（2025-09 发布，无依赖）

**覆盖清单**：

| 项目需求 | MiniSearch 支持 |  
|:---------|:---------------|
| BM25 评分 | ✅ 内置 BM25F |
| 模糊/前缀搜索 | ✅ `{ fuzzy: true, prefix: true }` |
| 分段 | ✅ `processTerm` 可自定义分析器链 |
| 多字段索引 | ✅ |
| 停止词 | ✅ |
| 中文支持 | ⚠️ 需要配合 `jieba` 或 `nodejieba` 做自定义 tokenizer |

**集成成本**：约 60 行代码替代 `src/search/fulltext.ts` + `src/search/fuzzy-search.ts`

**节省**：**5~7 人天**（当前方案 OOM 风险，且分段/模糊搜索均需自己实现）

---

### 4. 其他 A 级工具包

| 包 | 替代内容 | 代码行数 | 风险 |
|:---|:--------|:--------:|:----:|
| **chokidar** | 身份文件热加载的 mtime poll | 5 行 | 极低（1000 万周下载） |
| **archiver** | 备份压缩（`fs.cpSync` → tar.gz） | 20 行 | 极低（1200 万周下载，100% 覆盖） |
| **csv-parse** | CSV 导入解析器 | 10 行 | 极低（无依赖） |
| **msgpackr** | 序列化 JSON → MessagePack（快 2-3x） | 3 行 | 极低（无依赖，零配置） |
| **xxhash-wasm** | WAL 完整性 CRC | 2 行 | 低（纯 WASM） |
| **prom-client** | Prometheus metrics 端点 | 30 行 | 低（OpenTelemetry 已存在，prom-client 更轻） |
| **node-cron** | 定时备份调度 | 10 行 | 极低（无依赖） |
| **rotating-file-stream** | 审计日志按天轮转 | 5 行 | 极低（无依赖） |
| **selfsigned** (dev) | mTLS 测试证书生成 | 3 行 | 低（仅 dev 使用） |

---

## 详细调研：B 级（可选）

| 方案 | 评估 | 建议 |
|:-----|:-----|:-----|
| **zod** (4.4.3, 无依赖) | 可做 Schema 验证 + REST 参数校验 | **B** — 替代手写 Schema 引擎（3-5d），但不是图 Schema |
| **ajv** (JSON Schema) | 标准方案，更通用 | **B** — 替代 REST 请求验证（Q-14） |
| **blake3** | 加密级哈希 | **B** — 除非需要加密完整性，否则 xxhash 已够 |
| **flexsearch** (0.8.212) | 速度最快的纯 JS 全文搜索 | **B** — 比 minisearch 略快但生态更小 |
| **better-sqlite3** (12.10.0) | 持久化 Raft 状态/Smart Routing | **B** — LMDB 更轻量，SQLite 更通用 |
| **selfsigned** (dev) | 测试/开发证书 | **B** — 便利但不是必须 |
| **graphology-graphml** | GraphML 格式导入 | **B** — 如果支持 GraphML 导入 |
| **dataloader** | GraphQL N+1 消除 | **B** — 如果有 GraphQL 需求 |

---

## 详细调研：C 级（不推荐）

| 方案 | 原因 |
|:-----|:-----|
| **yjs** | CRDT 方向切 graph 不可行（yjs 是 text/richtext 协作引擎，没有图 merge 能力） |
| **automerge** | 同 yjs，针对 JSON 文档 |
| **delta-crdts** | 已 5 年不维护（最后发布 2021） |
| **winston** | 重，pino 更快更轻已存在 |
| **ngraph.path** | graphology 已覆盖可用 |
| **bree** | 太重，node-cron 已够 |
| **rdiff / node-rdiff** | 不兼容 Node 18+，已废弃 |
| **cypher-parser** | C addon，无法纯嵌入 |
| **express / uWebSockets.js** | 替换原生 http 重构量太大（REST 层已写 300+ 行） |

---

## 总体影响评估

### 对 v3 报告 108 项的影响

| Phase | 原估算 | 采用 npm 方案后 | 节省 |
|:-----|:------:|:--------------:|:----:|
| **Phase 0** (28 项 P0) | ~15 周 | ~11 周 | **~28%** |
| **Phase 1** (57 项 P1) | ~12 周 | ~8 周 | **~33%** |
| **Phase 2** (23 项 P2) | ~5 周 | ~4 周 | **~20%** |
| **总计 (3 人)** | **~11 周** | **~7~8 周** | **~30%** |

### 核心节省来源

| 领域 | 原估算(人天) | 采用后(人天) | 节省 | 关键包 |
|:----|:----------:|:-----------:|:----:|:------|
| 图算法 | 11 | 3 | **8d** | graphology + 7 扩展 |
| 全文搜索 | 8 | 3 | **5d** | minisearch |
| WAL 持久化 | 15~20 | 5~10 | **10d** | lmdb (保守) |
| 序列化 | 2 | 0.5 | **1.5d** | msgpackr |
| 审计/监控/调度 | 6 | 2 | **4d** | pino/prom-client/node-cron |
| 备份/导入 | 10~12 | 8~10 | **2d** | archiver/csv-parse |
| 配置热加载 | 1 | 0.5 | **0.5d** | chokidar |
| **合计** | **53~60** | **20~27** | **~31d** | |

### 新增依赖评估

```
新增的包：
  graphology + 7 个扩展（~300KB 未压缩）
  lmdb (~500KB native addon)
  minisearch (无依赖，~30KB)
  archiver (9 个依赖)
  chokidar (无直接依赖，底层依赖)
  csv-parse (无依赖)
  node-cron (无依赖)
  msgpackr (无依赖)
  xxhash-wasm (无依赖)
  prom-client (2 个依赖)
  rotating-file-stream (无依赖)
  selfsigned (dev 依赖)

与当前 package.json 对比：
- 当前: 16 个生产依赖 + 7 个 dev 依赖
- 建议新增: ~12 个（3 个有依赖传递）
- 建议移除: jsonwebtoken + @types/jsonwebtoken（mTLS-only 不再需要 JWT）
```

---

## 执行建议

### Step 1：先引入的（低风险、高回报）

1. **xxhash-wasm** → 0.5d，WAL CRC 校验，零 API 侵入
2. **msgpackr** → 0.5d，一行 `.encode()` 替代 `JSON.stringify()`
3. **chokidar** → 0.5d，身份文件热加载
4. **minisearch** → 1d，全文搜索立刻安全

### Step 2：分步引入的（需要架构设计）

5. **graphology** → 3d，算法适配器 + OverGraph 桥接层
6. **lmdb** → 5~10d，先 Smart Routing 持久化，再逐步扩大

### Step 3：随手引入的（已有的或者很小）

7. **prom-client** + **node-cron** + **rotating-file-stream** + **archiver** + **csv-parse**
