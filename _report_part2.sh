#!/bin/bash
# Append remaining sections to the report

cat >> /home/admin/openclaw/workspace/agentiX-graphvec/deep-review-v3-full-report.md << 'SECTION12'

  });
```

**修改量**: ~80 行 | **接口变更**: config 新增 `tls.enabled`、`tls.keyPath`、`tls.certPath`

#### 12.3 npm 包研究与选择

使用 Node.js 内置 `tls` 模块。无需引入外部包。

#### 12.4 是否需要自研

无需自研。

**推荐方案**: 使用 Node.js 内置 `tls` 模块，配置文件启用。

#### 12.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-12.1 | TLS 无配置 | tls.enabled=false | 默认明文连接 | 基本功能 |
| TC-12.2 | TLS 启用 | 配置 tls.enabled=true + key/cert | 节点间 TLS 加密通信 | 基本功能 |
| TC-12.3 | 证书不匹配 | 使用无效证书 | 连接失败，报错 | 安全 |
| TC-12.4 | mTLS | 配置 ca + requestCert | 双向证书验证 | 安全 |
| TC-12.5 | 性能 | 对比 TLS 与非 TLS 的吞吐 | 退化 ≤15% | 性能 |

---

### 13. deleteNode级联删除 (P1)

#### 13.1 问题是什么

**文件**: `src/shard/shard-manager.ts:331`

```typescript
async deleteNode(nodeId: string): Promise<void> {
  await this._storage.deleteNode(nodeId);
  // ❌ 未删除关联的边 → 产生孤儿边
  // ❌ 未清理 event-stream 中的缓存
}
```

**问题本质**: 删除节点后，关联该节点的边仍然存在于存储中。后续查询这些边会引用不存在的节点（`null` 或 `undefined`），导致不一致。

**影响范围**: 图数据完整性。所有 delete 操作。

#### 13.2 如何解决

**修改文件**: `src/shard/shard-manager.ts`

```typescript
async deleteNode(nodeId: string): Promise<void> {
  // 1. 获取所有关联边
  const edges = await this._storage.getEdgesByNode(nodeId);
  // 2. 删除关联边
  for (const edge of edges) {
    await this._storage.deleteEdge(edge.id);
  }
  // 3. 删除节点
  await this._storage.deleteNode(nodeId);
  // 4. 清理缓存
  this._cache.clear(nodeId);
  
  logger.info(`Deleted node ${nodeId} and ${edges.length} associated edges`);
}
```

**修改量**: ~30 行 | **接口变更**: 无

#### 13.3 npm 包研究与选择

无需引入。

#### 13.4 是否需要自研

无需自研。

**推荐方案**: 先查关联边 → 批量删除边 → 删除节点 → 清理缓存。

#### 13.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-13.1 | 正常删除 | 删除有 10 条关联边的节点 | 节点 + 所有关联边被删除 | 基本功能 |
| TC-13.2 | 无关联边 | 删除孤立节点 | 正常删除 | 边界 |
| TC-13.3 | 删除后查询 | 删除后查询孤儿边 | 0 条结果 | 基本功能 |
| TC-13.4 | 级联后重建 | 删除后创建同 ID 节点 | 可以正常创建，无残留 | 边界 |
| TC-13.5 | 并发删除 | 两个线程同时删除关联同一节点的边 | 无死锁，数据一致 | 并发 |
| TC-13.6 | 性能 | 删除有 10K 关联边的节点 | 在合理时间内完成 | 性能 |

---

### 14. Rebalance draining修复 (P1)

#### 14.1 问题是什么

**文件**: `src/shard/rebalancer.ts:339`

**问题本质**: 分片 rebalance 过程中，draining 阶段临时解除 drain 标记后、delete 操作前有写操作偷跑的窗口。即在 drain 关闭的瞬间、数据删除前，有新的写入落到该分片，但随后分片被删除 → 写入丢失。

**影响范围**: 分片 rebalance 时的数据丢失。

#### 14.2 如何解决

**修改文件**: `src/shard/rebalancer.ts`

**实现思路**: 保持 drain 状态直到数据完全传输完成。使用两阶段提交：
1. Phase 1: 标记 drain，停止新写入，开始迁移数据
2. Phase 2: 确认数据迁移完成，在持有 drain 锁的情况下删除源数据

```typescript
async rebalance(shardId: string): Promise<void> {
  // Phase 1: Drain
  await this._markDrain(shardId, true);
  
  // 迁移数据（drain 锁持有中）
  const data = await this._readAllData(shardId);
  await this._targetShard.writeBatch(data);
  
  // 验证一致性
  const checksum = await this._computeChecksum(shardId);
  const targetChecksum = await this._targetShard.computeChecksum();
  if (checksum !== targetChecksum) throw new Error('Checksum mismatch');
  
  // Phase 2: 删除源数据（仍持有 drain 锁）
  await this._deleteSourceData(shardId);
  
  // 释放 drain
  await this._markDrain(shardId, false);
}
```

**修改量**: ~40 行 | **接口变更**: 无

#### 14.3 npm 包研究与选择

无需引入。

#### 14.4 是否需要自研

无需自研。

**推荐方案**: 数据迁移完成前不释放 drain 锁 + 数据校验后再删除源数据。

#### 14.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-14.1 | 正常 rebalance | 分片 shard-1 rebalance 到新节点 | 数据完整迁移，无丢失 | 基本功能 |
| TC-14.2 | 迁移中写入 | drain 后、迁移完成前尝试写入 | 请求排队/delay，等待完成后写入目标 | 并发 |
| TC-14.3 | 迁移失败 | 目标节点中途离线 | 保持 drain + 回滚 | 异常路径 |
| TC-14.4 | 大量数据 | 迁移 100K 条数据 | 正常完成，校验一致 | 性能 |
| TC-14.5 | 并发 rebalance | 同时 rebalance 两个分片 | 各自独立完成 | 并发 |

---

### 15. 48h cleanup持久化 (P1)

#### 15.1 问题是什么

**文件**: `src/shard/reshard-manager.ts:173`

```typescript
// 问题代码
setTimeout(() => {
  this._cleanupExpiredData();
}, 48 * 60 * 60 * 1000).unref();
// ❌ unref() → 进程重启后丢失
// ❌ 不持久化 → 重启后过期数据不会被清理
```

**问题本质**: `setTimeout().unref()` 创建的定时器不会阻止进程退出，且进程重启后定时器状态完全丢失。48 小时的 cleanup 检查完全不可靠。

**影响范围**: 过期数据永远不会被清理。存储无限增长。

#### 12.2 如何解决 (修正序号)

**修改文件**: `src/shard/reshard-manager.ts`

**实现思路**: 
- 使用持久化存储记录 cleanup 状态（上次执行时间）
- 重启时读取上次执行时间，如果距离当前 > 48h 则立即执行
- 使用 `node-cron` 或 setInterval（不 unref）定期检查

```typescript
async _initCleanupScheduler(): Promise<void> {
  // 读取上次 cleanup 时间
  const lastCleanup = await this._persistState.get('lastCleanupTime');
  const now = Date.now();
  
  if (lastCleanup && (now - lastCleanup) >= 48 * 60 * 60 * 1000) {
    logger.info('Last cleanup > 48h ago, running immediately');
    await this._cleanupExpiredData();
  }
  
  // 定期检查（每 1h 检查一次是否到 48h 阈值）
  setInterval(async () => {
    const lastCleanup = await this._persistState.get('lastCleanupTime');
    if (lastCleanup && (Date.now() - lastCleanup) >= 48 * 60 * 60 * 1000) {
      await this._cleanupExpiredData();
      await this._persistState.set('lastCleanupTime', Date.now());
    }
  }, 60 * 60 * 1000); // 每小时检查
}
```

**修改量**: ~40 行 | **接口变更**: 无

#### 15.3 npm 包研究与选择

无需引入。使用文件/数据库持久化状态即可。

#### 15.4 是否需要自研

无需自研。

**推荐方案**: 持久化 lastCleanup 时间 + 每小时检查 + 重启时判断是否超 48h。

#### 15.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-15.1 | 正常 cleanup | 插入过期数据，等待 cleanup 执行 | 过期数据被删除 | 基本功能 |
| TC-15.2 | 进程重启恢复 | 设置 lastCleanup = 48h 前，重启进程 | 重启后立即执行 cleanup | 基本功能 |
| TC-15.3 | 进程重启不需要清理 | 设置 lastCleanup = 1h 前，重启进程 | 不执行清理 | 边界 |
| TC-15.4 | 非过期数据 | 插入不过期数据 | 不受影响 | 边界 |
| TC-15.5 | 持久化正确 | 重启后读取持久化时间 | 值与重启前一致 | 基本功能 |

---

### 16. 全量logger替换console（37处）(P1)

#### 16.1 问题是什么

**涉及文件**: 全库约 37 处

```typescript
// ❌ 散落在各处的 console.log/console.error
console.log(`Node upserted: ${nodeId}`);
console.error('Failed to send message:', err);
```

**问题本质**: 
- `console.log` 不包含 traceId、不输出到日志系统、无法查询
- 生产环境中 `console` 输出可能被重定向或丢失
- 无法关联到具体请求/操作

**影响范围**: 可观测性全面缺失。故障排查困难。

#### 16.2 如何解决

**修改文件**: 全库搜索 `console.log`、`console.error`、`console.warn` 等共 37 处

**实现思路**:
- 使用项目已有的 logger 替换
- logger 需要支持：traceId、级别控制、结构化输出

```typescript
// 替换前
console.log(`Node upserted: ${nodeId}`);

// 替换后
logger.info('Node upserted', { nodeId, traceId: getTraceId() });
```

**修改量**: ~74 行（替换 37 处） | **接口变更**: 无

#### 16.3 npm 包研究与选择

| 候选 | 大小 | TS 支持 | 纯嵌入 | 许可 | 维护 | 推荐 |
|------|:----:|:-------:|:------:|:----:|:----:|:----:|
| `winston` | ~200KB | ✅ | ✅ | MIT | ✅ | ✅ |
| `pino` | ~100KB | ✅ | ✅ | MIT | ✅ | ✅ |
| `loglevel` | ~10KB | ✅ | ✅ | MIT | ✅ | ⚠️ 功能少 |
| `debug` | ~20KB | ❌ | ✅ | MIT | ✅ | ⚠️ 只 debug |

**推荐**: `pino`（轻量、高性能、结构化日志、TS 支持好）。但如果项目已有 logger 则复用。

#### 16.4 是否需要自研

如果项目已有 logger 则直接使用；没有则推荐 `pino`。不需要自研。

**推荐方案**: 使用 `pino` 或项目中已有 logger，全量替换 37 处 console 调用。

#### 16.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-16.1 | logger 覆盖 | grep 检查无残留 console.log/error/warn | 0 处残留 | 基本功能 |
| TC-16.2 | 日志级别 | 设置级别为 warn 后 info 不输出 | 只有 warn/error 输出 | 基本功能 |
| TC-16.3 | traceId | 每个日志包含 traceId 字段 | 可追溯 | 基本功能 |
| TC-16.4 | 性能 | 10K 次 logger 调用耗时 | 总耗时 <1s | 性能 |
| TC-16.5 | 日志文件 | 配置日志文件路径 | 可追加写入 | 基本功能 |

---

## 三、P1 扩展（续）— Phase A 其余项

上述 16 项（Phase A 的 8 个 P0 和 Phase B 的 8 个 P1）已全部完成详细分析。以下为 Phase B 其余项。

---

## 四、竞品基准分析 (15 产品)

### 综合排名

| 排名 | 产品 | 加权分 | 定位 |
|:---:|:-----|:------:|:-----|
| 1 | Neo4j | 7.55 | OLTP Graph (Server) |
| 2 | CozoDB | 7.45 | Embedded Rel-Graph-Vector DB |
| 3 | SurrealDB | 7.20 | Multi-Model (Doc+Graph+Vector) |
| 4 | ArangoDB | 6.85 | Multi-Model (Server) |
| 5 | Qdrant | 6.80 | Vector Search Engine |
| 6 | Kùzu | 6.75 | Embedded Columnar Graph DB |
| 7 | Dgraph | 6.40 | Distributed Graph DB |
| 8 | NebulaGraph | 6.25 | Distributed Graph DB (CNCF) |
| 9 | Typesense | 6.20 | Fulltext+Vector Search Engine |
| 10 | TigerGraph | 5.90 | OLTP+OLAP Graph DB |
| **→11** | **AgentiX** | **5.80** | **Embedded Multi-Active Vector Graph DB** |
| 12 | EdgeDB (Gel) | 5.75 | Graph-Relational |
| 13 | HugeGraph | 5.55 | OLTP Graph DB |
| 14 | JanusGraph | 5.20 | Distributed Graph DB |
| 15 | GraphRAG | 3.75 | RAG + Knowledge Graph |

### 9 维评分矩阵 (AgentiX vs 最优)

| 维度 | AgentiX | 行业最优 | 差距 |
|:-----|:------:|:---------:|:----:|
| 嵌入性 | **9** | 9 (CozoDB) | — |
| 向量搜索 | **8** | 9 (Qdrant) | -1 |
| 复制 | **7** | 10 (Neo4j) | -3 |
| 查询语言 | **5** | 10 (Neo4j) | **-5** |
| 安全模型 | **4** | 9 (Neo4j) | **-5** |
| 运维能力 | **5** | 8 (ArangoDB) | -3 |
| 厂商锁定（越低越好） | **9** | 10 (Kùzu) | -1 |
| CJK 分词 | **4** | 7 (Neo4j) | -3 |
| 性能 | **6** | 8 (Neo4j) | -2 |

### 最大差距
1. **查询语言** — Cypher-lite 覆盖 <30%（无 CREATE/DELETE/MERGE/SET 等 DML）
2. **安全模型** — RLS 不完整、RBAC 不完整、无 mTLS、无审计完整链路
3. **性能** — ~8K ops/sec vs 竞品 50K-100K
4. **CJK 分词** — MiniSearch simple analyzer 不支持中文
5. **操作界面** — 无 Web Dashboard/集群可视化

### AgentiX 独特优势（唯一性）
- **唯一同时嵌入式 + 多活复制 + 向量搜索**的开源图数据库
- **Kùzu 已归档** → 市场窗口期

### 速赢项
- 性能基准页面（1 天）
- Fluent API 文档（3-5 天）
- CJK 分词支持（2-3 周）

---

## 五、综合提升路线图

### Phase A (1-2天) — P0 修复 8 项

| # | 项 | 优先级 | 难度 | 修改量 | 核心方案 |
|:--:|:---|:------:|:----:|:------:|:---------|
| 1 | upsertNode 递归死循环 | P0 | 低 | ~30行 | 递归深度计数器 + _applyingRemote 标志 |
| 2 | EventStream ACK前dedup永久丢失 | P0 | 低 | ~20行 | catch分支移除dedup + 重试 |
| 3 | TcpTransport sendTo无ACK | P0 | 中 | ~80行 | 有界缓冲 + writeTimeout + 重试 |
| 4 | 双写非事务 | P0 | 中 | ~60行 | 重试 + batchUpsertEdges双写 |
| 5 | BFS非一致遍历 | P0 | 低 | ~50行 | 内存快照 |
| 6 | health.ts 编译错误 | P0 | 低 | 1行 | 去掉多余await |
| 7 | bodySizeLimit绕过 | P0 | 低 | ~30行 | 413后return + chunk计数 |
| 8 | package-lock无校验 | P0 | 低 | ~10行 | 锁定精确版本 |

### Phase B (1周) — P1 修复 + API 加固 8 项

| # | 项 | 优先级 | 难度 | 修改量 | 核心方案 |
|:--:|:---|:------:|:----:|:------:|:---------|
| 9 | SSE连接泄漏 + metrics无认证 | P1 | 低 | ~50行 | close回调 + auth |
| 10 | Cypher-lite注入防护 | P1 | 中 | ~80行 | depth/join/timeout限制 |
| 11 | ZMQ CURVE认证启用 | P1 | 低 | ~30行 | 默认启用CURVE |
| 12 | TLS加密传输层 | P1 | 中 | ~80行 | Node.js tls模块 |
| 13 | deleteNode级联删除 | P1 | 低 | ~30行 | 先删边再删节点 |
| 14 | Rebalance draining修复 | P1 | 中 | ~40行 | 两阶段 + checksum |
| 15 | 48h cleanup持久化 | P1 | 中 | ~40行 | 持久化时间 + 定时器 |
| 16 | 全量logger替换console（37处） | P1 | 低 | ~74行 | pino/已有logger替换 |

### Phase C (2-4周) — 竞品差距填补 5 项

| # | 项 | 难度 | 估算工时 | 核心方案 |
|:--:|:---|:----:|:--------:|:---------|
| 17 | Cypher-lite扩展至完整DML | 高 | 2-3周 | 扩展peggy语法 + 执行计划 |
| 18 | OverGraph深度调优（50K ops目标） | 高 | 1-2周 | HNSW参数 + LMDB + batch |
| 19 | CJK分词支持 | 中 | 2-3天 | nodejieba/ICU内置 |
| 20 | Web Dashboard v1 | 中 | 1-2周 | React + 图表库 |
| 21 | 性能基准公开页面 | 低 | 1天 | Static site + benchmark charts |

### Phase D (1-3月) — 差异化突破 3 项

| # | 项 | 难度 | 估算工时 | 核心方案 |
|:--:|:---|:----:|:--------:|:---------|
| 22 | 分片Raft组自管理（正式成员变更） | 高 | 2-4周 | Raft成员变更协议 |
| 23 | 向量-全文混合查询 | 中 | 1-2周 | OverGraph HNSW + MiniSearch联合索引 |
| 24 | CI/CD + 安全审计自动化 | 中 | 1周 | GitHub Actions + SAST + npm audit |

---

## 六、Phase C 详细分析 — 竞品差距填补

---

### 17. Cypher-lite扩展至完整DML

#### 17.1 问题是什么

**文件**: 查询语言解析层（peggy grammar 文件 + 查询执行层）

**问题本质**: 当前 Cypher-lite 覆盖率 <30%，仅支持 `MATCH`、`RETURN`、`WHERE` 等基础只读模式。缺少：
- `CREATE` (节点/边)
- `DELETE` (节点/边)
- `MERGE` (upsert)
- `SET` (属性更新)
- `REMOVE` (属性删除)
- `FOREACH` / `UNWIND` / `CALL`

竞品（Neo4j、CozoDB、SurrealDB）均支持完整 DML。

**影响范围**: 查询语言评分比行业最优差 5 分（5 vs 10）。

#### 17.2 如何解决

**修改文件**: 
- peggy grammar 文件（约 500 行扩展）
- 执行计划构建层（约 200 行）
- 执行引擎适配层（约 300 行）

**实现优先级**: `CREATE` → `DELETE` → `SET` → `MERGE` → `REMOVE`

**修改量**: ~1000 行 | **接口变更**: 新增 API 方法

#### 17.3 npm 包研究与选择

无需引入新 npm 包。使用项目已有的 peggy parser 继续扩展。

#### 17.4 是否需要自研

需要自研。这是核心功能开发，没有现成的 parser 可以"嵌入"。

**推荐方案**: 扩展 peggy grammar + 执行计划构建 + 引擎适配。分 5 个 Sprint，每个实现一个关键字。

#### 17.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-17.1 | CREATE node | `CREATE (n:Person {name:'Alice'})` | 节点创建成功 | 基本功能 |
| TC-17.2 | CREATE edge | `MATCH (a),(b) CREATE (a)-[:KNOWS]->(b)` | 边创建成功 | 基本功能 |
| TC-17.3 | DELETE node | `MATCH (n) DELETE n` | 节点和关联边被删除 | 基本功能 |
| TC-17.4 | SET property | `MATCH (n) SET n.age = 30` | 属性更新 | 基本功能 |
| TC-17.5 | MERGE upsert | `MERGE (n:Person {id:1}) SET n.name='Alice'` | 存在更新、不存在创建 | 基本功能 |
| TC-17.6 | 空数据 CREATE | `CREATE (n:Person)` 在空图中 | 节点创建 | 边界 |
| TC-17.7 | 链式操作 | `CREATE (a)-[:E]->(b)` 一行创建两点一边 | 全部创建 | 基本功能 |
| TC-17.8 | 兼容性 | 已有 MATCH 查询不变 | 正常执行 | 向后兼容 |
| TC-17.9 | 性能 | 批量 CREATE 10K 节点 | <500ms | 性能 |

---

### 18. OverGraph深度调优（50K ops目标）

#### 18.1 问题是什么

**文件**: `src/core/overgraph-storage.ts` 及 OverGraph 绑定层

**问题本质**: 当前 ~8K ops/sec vs 竞品 50K-100K。原因：
1. HNSW 参数未调优（efConstruction、M 等使用默认值）
2. LMDB map size 配置不合理
3. 写入路径未使用 batch/wal 批量写入
4. 零拷贝路径有额外序列化开销

#### 18.2 如何解决

**修改文件**: overgraph-storage.ts

**实现思路**:
1. HNSW 参数调优：`M=16`, `efConstruction=200`, `efSearch=50`
2. LMDB map size 根据可用内存动态计算
3. 批量写入合并（batch 大小 100-1000）
4. 写入路径引入 WAL 批量 flush

```typescript
const hnswConfig = {
  m: 16,         // 默认 12 → 提高连接度
  efConstruction: 200,  // 默认 100 → 提高构建质量
  efSearch: 50,  // 默认 40
};

const lmdbConfig = {
  mapSize: Math.min(availableMemory * 0.5, 4 * 1024 ** 4), // 可用内存50%，最大4TB
  maxDbs: 10,
};
```

**修改量**: ~100 行 | **接口变更**: config 级别

#### 18.3 npm 包研究与选择

无需引入新包。

#### 18.4 是否需要自研

无需自研。调参 + 优化即可。

**推荐方案**: HNSW 参数调优 + LMDB mapSize 自动配置 + 批量写入 + 减少序列化。

#### 18.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-18.1 | 写入吞吐 | 批量写入 50K 条 | ≥50K ops/sec | 性能 |
| TC-18.2 | 向量搜索延迟 | 10K 向量数据集，k=10 最近邻搜索 | P99 < 10ms | 性能 |
| TC-18.3 | HNSW 召回率 | 100 次查询的 recall@10 | ≥95% | 基本功能 |
| TC-18.4 | 内存使用 | 写入 100K 数据后 | 不触发 OOM | 性能 |
| TC-18.5 | 配置可调 | 通过 config 调整 efConstruction 等参数 | 立即生效 | 边界 |
| TC-18.6 | 长期稳定 | 持续写入 1h（100 ops/sec） | 无内存泄漏 | 性能 |

---

### 19. CJK分词支持 (P1, 竞品差距)

#### 19.1 问题是什么

**文件**: 全文搜索模块（MiniSearch 配置）

```typescript
// 当前配置
const miniSearch = new MiniSearch({
  fields: ['title', 'content'],
  searchOptions: {
    prefix: true,
    fuzzy: 0.2,
  },
});
// ❌ 无 tokenizer 配置 → MiniSearch 默认 simple analyzer（空格/标点分割）
// 中文"我爱北京天安门"被当作一个 token "我爱北京天安门" → 搜索"北京"匹配不到
```

**问题本质**: MiniSearch 默认的 `simple` tokenizer（空格+标点分割）完全不适用于 CJK 语言。中文、日文、韩文中的词之间没有分隔符。

**影响范围**: 全文搜索对 CJK 语言用户完全不可用。竞品评分差 3 分（4 vs 7）。

#### 19.2 如何解决

**修改文件**: MiniSearch 配置初始化代码

**实现思路**: 
- 使用中文分词器对文本预处理（将"我爱北京天安门"变为"我 爱 北京 天安门"）
- 直接设置 `tokenize` 选项到 MiniSearch 的 tokenizer 字段

```typescript
import { createTokenizer } from 'jieba'; // 或 nodejieba

const tokenizer = (text: string) => {
  // 对包含 CJK 字符的文本使用 jieba 分词
  if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(text)) {
    return jieba.cut(text, true); // 精确模式
  }
  // 非 CJK 使用默认空格分割
  return text.split(/[\s,.;:!?()\[\]{}'"<>/\\@#$%^&*+=|~`\u0020]+/).filter(Boolean);
};

const miniSearch = new MiniSearch({
  fields: ['title', 'content'],
  tokenize: tokenizer,
  searchOptions: {
    prefix: true,
    fuzzy: 0.2,
  },
});
```

**修改量**: ~50 行 | **接口变更**: 无

#### 19.3 npm 包研究与选择

**候选方案**:

| 候选 | 大小 | TS支持 | 纯嵌入 | 许可 | 维护 | CJK质量 | 推荐 |
|------|:----:|:------:|:------:|:----:|:----:|:-------:|:----:|
| `nodejieba` | ~5MB(含词典) | ✅ | ✅ | MIT | ✅ | 优秀 | ✅ |
| `@node-rs/jieba` | ~4MB | ✅ | ✅ | MIT | ✅ | 优秀 | 备选 |
| `segmentit` | ~2MB | ❌ | ✅ | MIT | ⚠️低 | 良好 | ⚠️ |
| `node-icu-charset-detector` | ~3MB | ✅ | ✅ | ICU | ✅ | 一般(只有检测) | ❌ |

**深度分析**: `nodejieba` 是结巴分词的 Node.js 绑定，纯嵌入式（不需要外部服务），词典内置。`@node-rs/jieba` 是 Rust 实现的更高性能版本。

**最终推荐**: `nodejieba`（成熟稳定，生态好）。

#### 19.4 是否需要自研

不需要。`nodejieba` 完全满足需求：纯嵌入式、MIT 协议、中文分词准确。

**推荐方案**: 使用 `nodejieba` 自定义 MiniSearch tokenizer。

#### 19.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-19.1 | 中文分词 | 搜索"北京"在包含"我爱北京天安门"的文本中 | 匹配到 | 基本功能 |
| TC-19.2 | 英文不变 | 搜索"hello" | 正常匹配 | 基本功能 |
| TC-19.3 | 混合文本 | 搜索"北京 company" | 中文英文都匹配 | 基本功能 |
| TC-19.4 | 日文支持 | 搜索"東京" | 匹配到日文文本 | 基本功能 |
| TC-19.5 | 空字符串 | 搜索"" | 不报错，返回空 | 边界 |
| TC-19.6 | 性能 | 10K 中文文档索引 + 100 次搜索 | 总耗时 <5s | 性能 |
| TC-19.7 | 内存 | 加载 nodejieba 后内存增量 | <30MB | 性能 |

---

### 20. Web Dashboard v1

#### 20.1 问题是什么

**现状**: 无任何 Web UI。全 CLI/REST API 操作。运维态用户需要：
- 查看集群状态（节点、分片、Leader）
- 执行查询（SQL-like 查询）
- 查看监控指标（吞吐、延迟、错误率）
- 查看拓扑图

竞品：Neo4j Browser、ArangoDB WebUI、Dgraph Ratel 均为标准配置。

#### 20.2 如何解决

**实现方案**: 
- 前端：React + Vite + D3.js（拓扑图）
- 后端：复用已有的 REST API
- 功能：集群状态、查询执行、基本监控

**修改量**: ~2000 行（前端） | **接口变更**: 无（复用已有 API）

#### 20.3 npm 包研究与选择

| 候选 | 大小 | 许可 | 用途 | 推荐 |
|------|:----:|:----:|:-----|:----:|
| React | ~120KB | MIT | UI 框架 | ✅ |
| D3.js | ~250KB | ISC | 图可视化 | ✅ |
| Chart.js | ~60KB | MIT | 监控图表 | ✅ |
| Monaco | ~10MB | MIT | 查询编辑器 | ⚠️ 太重 |
| CodeMirror | ~500KB | MIT | 查询编辑器 | ✅ |

**推荐**: React + D3.js + Chart.js + CodeMirror。

#### 20.4 是否需要自研

需要自研（前端应用开发），但核心组件使用现有 npm 包。

**推荐方案**: React + D3.js + Chart.js + CodeMirror。后端复用已有 REST API。

#### 20.5 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-20.1 | 集群状态 | 打开 Dashboard | 显示节点列表、Leader、分片分布 | 基本功能 |
| TC-20.2 | 查询执行 | 在查询框输入 MATCH (n) RETURN n | 显示查询结果表格 | 基本功能 |
| TC-20.3 | 拓扑可视化 | 查询结果包含图数据 | 显示节点-边图 | 基本功能 |
| TC-20.4 | 监控指标 | 打开监控面板 | 显示 QPS、延迟、错误率图表 | 基本功能 |
| TC-20.5 | 查询错误 | 输入错误语法 | 显示友好错误信息 | 异常路径 |
| TC-20.6 | 大结果集 | 查询返回 10K 行 | 分页显示，浏览器不卡死 | 性能 |
| TC-20.7 | 空集群 | 新部署的集群 | Dashboard 正常加载，显示空状态 | 边界 |

---

### 21. 性能基准公开页面

#### 21.1 问题是什么

**现状**: 项目无公开的性能基准页面。用户无从判断性能指标。竞品通常有专门的 benchmark 页面。

#### 21.2 如何解决

**实现方案**: 
- 静态站点（GitHub Pages / Vercel）
- 使用 Chart.js 渲染性能图表
- 包含：写入吞吐、向量搜索延迟、遍历速度、与竞品对比

**修改量**: ~500 行（HTML + JS + data JSON）

#### 21.3 npm 包研究与选择

无需后端。纯静态页面。

**推荐方案**: 静态 HTML + Chart.js + GitHub Pages。

#### 21.4 验收测试条款

| # | 测试项 | 步骤 | 预期结果 | 类型 |
|---|--------|------|----------|------|
| TC-21.1 | 页面加载 | 访问公开 URL | 页面正常渲染 | 基本功能 |
| TC-21.2 | 图表显示 | 浏览
