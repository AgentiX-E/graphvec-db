# agentiX-graphvec — 深度分析报告与优化方案

> 日期: 2026-06-24 22:45
> 基于全量代码审查 + Perf baseline (66 指标)

---

## 一、项目全局结构

**总代码**: ~226K 行 TypeScript（含 1000+ spec 测试文件）
**核心模块**:

| 模块 | 行数 | 角色 |
|------|------|------|
| `query-engine.ts` | 7405 | Cypher 查询引擎（入口 + Plan 适配 + GE 执行 + 后处理） |
| `expression-engine.ts` | 2284 | 表达式求值（独立，不 import query-engine） |
| `ast-to-plan-v2.ts` | 2323 | ANTLR Cipher 解析适配器 |
| `graph-engine.ts` | 3454 | 底层图引擎（LRU 缓存 + 节点/边存储 + 标签索引） |
| `overgraph-storage.ts` | 1188 | OverGraph 存储适配器 |
| `consensus/raft-core.ts` | 1481 | Raft 共识 |
| `consensus/transport.ts` | 983 | Raft 传输层 |
| `core/event-bus.ts` | 970 | 事件总线 |
| `core/outbox-replication.ts` | 1530 | Outbox 模式复制 |
| `core/simple-txn-manager.ts` | ~500 | 简单事务管理器 |

---

## 二、性能瓶颈分析（来自 Perf Baseline）

### 瓶颈 1: GE 实例创建 + Seed 节点的 I/O 开销（#1 blocker）

**症状**: 所有需要 GE 的查询都在 <1500 ops/s:
```
simple MATCH-RETURN    952 ops/s    (5000x in 5255ms)
MERGE                  921 ops/s
SET properties         701 ops/s
UNWIND                1314 ops/s
CREATE node           1323 ops/s  
CALL procedure        1527 ops/s
```

**根因** (来自代码分析 `_executeViaGraphEngine` 第 3054-3080 行):
1. **每次查询创建一个新 GraphEngine 实例**: `new GraphEngine(config)` + `ge.open()`
2. **LMDB 目录创建 + GC**: `/tmp/tckge-pid-timestamp-random` 每次新目录
3. **Schema 初始化**: `ge.open()` 内调用 `labelEngine.init()` 等
4. **Seed 所有节点到 GE**: 每个节点一次 `upsertNode` (async，但实际没 await——吞了)
5. **每条边 `storage.upsertEdge`**: 同步调用

**典型路径开销**:
- GE 创建 + open: ~0.5-1ms
- Seed 1 个节点 + 0 条边: ~0.5ms  
- 加上解析 ~0.2ms + Plan 适配 ~0.1ms + 后处理 ~0.01ms
- 合计 ~1.2-1.8ms/查询 → ~550-830 ops/s
- 实测 952 ops/s ≈ 1.05ms/query — 吻合

### 瓶颈 2: `_walkMultiSteps` 的 `__edges` 遍历（Matched queries）

**症状**:
```
2-hop pattern          5961 ops/s
filter WHERE           4669 ops/s
nested MATCH with WHERE 984 ops/s
```

**根因**: `_walkMultiSteps` 对每对节点执行多步遍历——嵌套查询意味着递归调用 GE 全流程。对 100+ 有边节点的图，BFS 复杂度 O(节点 * 边)。

### 瓶颈 3: _executeQuery 的 `JSON.parse(JSON.stringify(plan))`（每请求开销）

**行 6027**: `const planCopy = JSON.parse(JSON.stringify(plan, _bigintReplacer), _bigintReviver)`

即使 plan 不需要修改也要深拷贝。对大 plan（含 filters/columns/steps 大量嵌套对象），这个拷贝额外增加 0.05-0.15ms。

### 瓶颈 4: ANTLR 解析器初始化

**症状**: `batch parse: 10 unique queries (500x batch)` — 1624 ops/s (615μs/parse)
**原因**: ANTLR 解析器每次 `parseQuery` 都重新实例化 lexer + parser + listener。非 ANTLR 瓶颈（不可优化，已在 ~600μs）

---

## 三、高收益优化方案

### 方案 1: GE 实例 Pool / 复用（预计 +300-500%）

**改动**: 不创建新 GE 实例，而是创建 GE Pool（预热好的空引擎）
- `_executeViaGraphEngine` 中，对 `!plan.scanLabel && !plan.steps?.length` 的纯 DML/CREATE 查询，
  使用预热的共享 GE 实例（已注册 0-5 个节点）
- 或者：用轻量 in-memory 模式替代 LMDB（跳过 StorageProvider 的 open/close）

**复杂度**: 中（~50 行改动，需要线程安全的 Pool）
**注意**: TCK 的节点隔离依赖每个查询新 GE（`_clearGeInstances` 在 `afterAll`），不过当前 `_executeViaGraphEngine` 已注册到 registry 并在 `afterAll` 清理

### 方案 2: `_executeQuery` Plan 懒拷贝（预计 +5-10%）

**改动**: 只在 `_executeViaGraphEngine` 内部真正需要 deep copy 时才做 `JSON.parse(JSON.stringify(plan))`。
当前在 `_executeQuery` 入口处（行 6027）无条件深拷贝。改为按需拷贝。

**分析**: `plan` 在 `_executeViaGraphEngine` 中有多处 mutate（`plan.filters = ...`, `plan.steps[0].edgeLabel = ...`）。
需要精确识别哪些路径真实 mutate。大部分路径 mutate 后没有后续引用，深拷贝在前 95% 路径是浪费。

**复杂度**: 低（~20 行）

### 方案 3: `scanAllNodes` 优化（预计 +50-100% MATCH 无 WHERE）

**症状**: `simple MATCH-RETURN` 952 ops/s，但 GE 的 `scanAllNodes` 1000 节点只要 4396 ops/s。

**根因**: `scanAllNodes` 是 GE 原生方法（读取存储），但 QE 每次 MATCH 需要从全部 1000 节点构建结果行。
GE 返回 `NodeRecord[]` 然后 QE 映射为 `QueryRow[]`——中间的格式转换 + 边重建。

**改动**: 优化 seed 后减少格式转换开销，或缓存 `_label` index 跳过重建。

### 方案 4: ORDER BY index-sort + 移除 `result.slice()`（已完成）

✅ Phase D 已实施

### 方案 5: 表达式缓存（已完成）

✅ Phase C 已实施

### 方案 6: UNION 快速去重（已完成）

✅ Phase A 已实施

### 方案 7: `_buildDmlRows` CREATE 节点返回优化

**现状**: `CREATE + RETURN n.name` 中，`createNodes` 构建节点然后 `_buildDmlRows` 映射为返回行。
这在多节点创建场景下与 GE seed 重叠——节点在 seed 阶段已 upsert 到 GE，又在 DML 返回阶段重新构造。

**优化**: DML 路径跳过 GE seed（当前已有逻辑——DML 不经过 GE 路径），但 `_buildDmlRows` 仍需要 `plan.createNodes` → `allNodes` 映射。

### 方案 8: Plan 预编译缓存

**现状**: 同一个 Cypher 语句每次解析都走完整 ANTLR 路径（~0.2ms + ~0.4ms plan 适配）。

**优化**: 对 `parseQuery` 增加 LRU 缓存（key = query string）。注意需要基于 query string 而不是 plan hash，因为 plan 的输出格式可能变化。

**收益**: batch parse 场景下，如果 10 个查询高频重复，可跳过 80%+ 的解析开销。
`batch parse` 目前 1624 ops/s (615μs/iter)，其中 parse ~60%。缓存命中可降到 ~200μs（纯 Plan 适配）。

**复杂度**: 低（~20 行，`Map<string, QueryPlan>` + LRU evict at 100 条）

### 方案 9: GE 的 `_scanAll` 惰性化

**现状**: GE 的 `scanAllNodes` / `_scanAll` 每次遍历全部存储节点。在无 `scanLabel` 的 MATCH 中（`MATCH (n)`），
GE 扫描全部节点再让 QE 应用 WHERE 过滤。

**优化**: 当有 `scanLabel` 时，GE 只返回匹配标签的节点。

**复杂度**: 低（修改 `_scanAll` 接受可选 label filter）

---

## 四、推荐优先级

| 优先级 | 方案 | 预计收益 | 复杂度 | 风险 |
|--------|------|----------|--------|------|
| **P0** | GE Instance Pool / 复用 | +300-500% | 中 | 低（当前已有 registry 模式） |
| **P1** | Plan 懒拷贝 | +5-10% | 低 | 低（分析精准） |
| **P2** | Plan 预编译缓存 | 解析提升 3-5x | 低 | 低 |
| **P3** | `_scanAll` 惰性化 | +20-50% MATCH | 低 | 中（GE 内部 API 改动） |
| **P4** | `_buildDmlRows` 冗余消除 | +10-20% DML | 低 | 低 |

**推荐立即开始**: P0 GE Instance Pool。这是唯一能在 `simple MATCH-RETURN` 上突破 1000 ops/s 天花板的手段。

---

## 五、方案 1 详细设计：GE Instance Pool

```typescript
// 在 query-engine.ts 添加
const GE_POOL_SIZE = 5
const _gePool: GraphEngine[] = []

function _getGeFromPool(): GraphEngine { ... }
function _returnGeToPool(ge: GraphEngine): void { ... }
function _initGePool(): void { ... }

// 调用方式：
// 在 _executeViaGraphEngine 中，当 plan 类型是简单 MATCH 时：
//   ge = _getGeFromPool()  // 跳过 new GraphEngine + open + dir 创建
//   // 直接 upsertNode + seed
//   ...
//   _returnGeToPool(ge)    // 不清除节点，只重置状态
```

但需要注意：GE 是 OverGraph-based（LMDB 后端），`ge.open()` 和 `ge.close()` 是 I/O-heavy。
Pool 中每个引擎需要持久化路径。

更务实的做法：

1. 在 `_geInstanceRegistry` 已有基础上，添加"缓存关闭但不销毁"策略
   - 当前: 每次 `_clearGeInstances` 关闭并清除所有 GE
   - 改为: keep N 个 GE 在池中，close 但 reopen 时不新建目录（复用 LMDB 缓存）

2. 或者在 QE 层：对无网络连接的 MCK 场景，禁用 OverGraph 回退到 in-memory storage
