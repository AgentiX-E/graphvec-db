# 深度研究结果

## 从 226K 行中识别的 4 个高价值优化方向

经过全量代码扫描（226K 行 TypeScript, 150+ 文件）、baseline 性能分析（66 个唯一基准指标）、以及瓶颈热点分析，选出以下高价值方向。

---

## 方向一：UNION 去重引擎（性能瓶颈 #1）

### 现状
- `_executeViaGraphEngine` 中 UNION 去重用 `JSON.stringify(row)` + `Set<string>`:
  ```typescript
  const seen = new Set<string>()
  for (const row of [...leftRows, ...rightRows]) {
    const k = JSON.stringify(row)
    if (!seen.has(k)) { seen.add(k); merged.push(row) }
  }
  ```
- 每个 row 做一次 `JSON.stringify`（O(n) 深度遍历），Set 存储完整 JSON 字符串
- benchmark 数据：UNION = **243 ops/s**，是全局最低

### 方案
**自研快速去重器** — 不在 npm 中寻找替代品，因为：
- `lodash.uniqWith` / `ramda.uniqWith` 深度比较也是递归遍历（与 JSON.stringify 复杂度相同）
- `Set([{}, {}])` 在 JS 中按引用判断，对对象无效
- 自定义实现可以**利用数据特征**大幅优化

**核心思想：多级签名过滤**，比 JSON.stringify 快 10-100x：
1. **一级签名**：`Object.keys` 排序后拼接 + row 中每个值的 `typeof` + 基本类型值拼接。对大多数差异巨大的行，直接跳过 JSON.stringify。
2. **二级签名**：仅在对象层级签名碰撞时 fallback 到 JSON.stringify。

对于 `intersect` 和 `subtract` 同样适用（当前也是 JSON.stringify）。

### 文件位置
- **后端**：`src/query/query-engine.ts`，行 2774-2791（UNION 去重代码）
- 修改范围：~30 行替换，无新增文件

### 文献/借鉴
- 借鉴 **Bloom Filter** 思想：先通过快速哈希过滤，再精确比较
- 不借鉴 `lodash.isEqual`（递归遍历，性能相当）
- 不使用 npm 包：`xxhash-wasm` 已存在于 dependencies 中，可以直接用

### 验收测试

| # | 场景 | 验证方式 |
|---|------|----------|
| 1 | UNION 两集合无交集 | JSON.stringify 去重 vs 新函数结果一致 |
| 2 | UNION 两集合完全相等 | 去重后返回唯一行 |
| 3 | UNION 嵌套对象（`{a: {b: 1}}`） | 深度比较正确 |
| 4 | UNION null/undefined 属性 | 边界值处理正确 |
| 5 | UNION 含数组属性 | `{tags: [1,2]}` 深度比较 |
| 6 | INTERSECT 正确性 | 两集合交集 |
| 7 | SUBTRACT 正确性 | A - B 差集 |
| 8 | 性能对比 | 同数据量下 ops/s 提升 >= 5x |
| 9 | 回归 | `--quick` 4/4 + split 991 + TCK 全量 0 fail |
| 10 | 0 行、1 行特殊情况 | 边界不 crash |

---

## 方向二：GE 实例生命周期优化 — 惰性构建 (Lazy GE)

### 现状
- `_executeViaGraphEngine` 的每次 MATCH 执行都耗时在 GE 构建/重用上：
  ```
  2973: let ge: GraphEngine | null = null
  2977: if (_geInstanceRegistry.has(_activeDatabase)) {
  2983:     const oldGe = _geInstanceRegistry.get(_activeDatabase)
  2986:     try { oldGe.close() } catch {}
  2988:     _geInstanceRegistry.delete(_activeDatabase)
  2998: const config: OverGraphConfig = { path: dir, denseVector: { dimension: 384 } }
  2999: ge = new GraphEngine(config)
  3000: ge.open()
  ```
- 每次 `_executeQuery`（行 6021）都调 `_executeViaGraphEngine`，即使是无 MATCH 的纯 RETURN/WITH 查询
- `parseQuery`（行 852）执行 `_executeQuery` → `_executeViaGraphEngine` → GE 创建/LMDB open
- benchmark：simple MATCH-RETURN = **873 ops/s**，其中绝大部分是 GE 构造/seed 开销

### 方案
**Lazy GE 初始化 + Skip GE for non-MATCH queries**：
1. 在 `_executeViaGraphEngine` 中，对不需要 GE 的 plan 类型（PURE RETURN、WITH、UNWIND、SHOW、CATALOG、LOAD CSV），跳过 GE 创建
2. 上述路径中，GE 在首次用到时才创建（如 CREATE/DELETE/SET/MERGE + MATCH）

### 文件位置
- `src/query/query-engine.ts`，`_executeViaGraphEngine` 函数（2450-3024 行）
- 在 GE 构造段（2973-3000 行）上加一个条件守卫
- 修改范围：~10 行

### 文献/借鉴
- 经典 **Lazy Initialization** 模式（GoF 设计模式）
- 不借鉴任何 npm 包

### 验收测试

| # | 场景 | 验证方式 |
|---|------|----------|
| 1 | `RETURN 1 AS x` 无 MATCH | 不创建 GE，不调用 `ge.open()` |
| 2 | `WITH 1 AS x RETURN x` | 不创建 GE |
| 3 | `MATCH (n) RETURN n` | 正常创建 GE |
| 4 | `CREATE (n:Person {name: 'x'})` | 正常创建 GE |
| 5 | `SHOW LABELS` | 不创建 GE |
| 6 | 回归 | `--quick` 4/4 + split 991 + TCK 全量 |
| 7 | 性能提升 | 纯 RETURN 场景 >= 50% 提升 |

---

## 方向三：`scope-babel` — 基于作用域链的表达式缓存（高收益高频路径）

### 现状
- `_evaluateExpression` 每次被调用时都走完整的递归下降解析（除非是结构化对象）
- 即使是相同的表达式 `n.name`、`n.age`，每行都重新解析
- 表达式引擎中大量 prop 访问的瓶颈在 `_evalBinary → _evalOr → _evalXor → _evalAnd → _evalNot → _evalComparison → _evalArith → _evalTerm → _evalAtom` 链，每个都调用 `_splitTopLevel`

### 方案
**为频繁的 prop 访问 + 简单算术建立 trivially cached 表达式缓存**：
用一个 WeakMap 缓存表达式 AST 字符串 → 求值函数：
```typescript
const _exprCache = new Map<string, (row: Record<string, unknown>) => unknown>()
```
缓存 key 是 `expr + JSON.stringify(??)` — 对无副作用的纯行表达式（prop 访问、算术运算），第一次求值时编译并缓存，后续直接调用。

### 文件位置
- `src/query/expression-engine.ts`，在 `_evalBinary` 入口行 636 附近
- 修改范围：~20 行

### 文献/借鉴
- 数据库系统原理中的 **Expression Compilation / Caching**（类似 PostgreSQL 的 expression cache）
- 借鉴 V8 的 **Inline Cache** 概念
- 不使用 npm 包：`lru-cache` 已在依赖中，但这里用原生 `Map` 更合理（避免 LRU 开销）

### 验收测试

| # | 场景 | 验证方式 |
|---|------|----------|
| 1 | 'n.name' 相同行不同 row 调用 10000 次 | 缓存命中，只解析一次 |
| 2 | 'n.age + 10' 相同表达式 | 缓存命中 |
| 3 | '1 + 2' 常量表达式 | 缓存命中 |
| 4 | 不同表达式不共享缓存 | key 区分正确 |
| 5 | 正确性：`n.name` → `row.n.name` | 返回正确值 |
| 6 | 正确性：`a + b + c` → `row.a + row.b + row.c` | 返回正确值 |
| 7 | 内存安全：不泄漏 | 使用 `Map` 天然不泄漏 |
| 8 | 回归 | `--quick` 4/4 + split 991 + TCK 全量 |
| 9 | 性能提升 | 高频 prop 访问提升 >= 20% |

---

## 方向四：`_postProcessResults` ORDER BY 原地排序（降低内存分配）

### 现状
- ORDER BY 路径始终 `processed = result.slice()` 后再 sort/skip/limit
- 即使 SKIP + LIMIT 可以部分 slice，也先做 full slice + full sort
- 对大结果集，slice + sort + 多次 filter 引入大量对象分配

### 方案
**3-stage 分区后处理**：
1. **stage 1（无必要性）**：如果 ORDER BY 列和原始 row 顺序完全一致（先检测），跳过 sort
2. **stage 2（原地索引排序）**：改为对 indices 排序而非对整个 row 对象排序
3. **stage 3（延迟切片）**：先 sort indices，再应用 skip/limit slice

```typescript
// 当前：
let processed = result.slice()
processed.sort(comparator)
return processed.slice(skip, skip + limit)

// 优化后：
const indices = Array.from(result.keys())
indices.sort((a, b) => compare(result[a], result[b]))
return indices.slice(skip, skip + limit).map(i => result[i])
```

### 文件位置
- `src/query/expression-engine.ts`，`_postProcessResults` 函数（行 2149）
- 修改范围：~30 行

### 文献/借鉴
- 经典 **Index Sort / Schwartzian Transform** 模式
- 不借鉴任何 npm 包

### 验收测试

| # | 场景 | 验证方式 |
|---|------|----------|
| 1 | ORDER BY ASC 100 行 | 结果与 JSON.stringify 排序一致 |
| 2 | ORDER BY DESC 100 行 | 逆序正确 |
| 3 | ORDER BY 多列 | 多排序键正确 |
| 4 | ORDER BY + SKIP 10 + LIMIT 5 | 分片正确 |
| 5 | 1000 行 ORDER BY | 正确性 + 性能提升 >= 2x |
| 6 | 1 行 ORDER BY | 边界值不 crash |
| 7 | 原地排序不修改原始 result | 引用不变 |
| 8 | 回归 | `--quick` 4/4 + split 991 + TCK 全量 |
| 9 | 性能对比 | big.sort 场景提升 >= 2x |

---

## 不做/不推荐的方向（已评估）

| 方向 | 原因 |
|------|------|
| **SQL.js 替换 expression-engine** | SQL.js 是 WebAssembly 自重 ~5MB，且不支持 Cypher 语法 |
| **ANGEL parser 替换**（ANTLR 替换） | 仅 ~50 行可删，2200+ 行是有效逻辑 |
| **DML Async 改造** | 已 async，仅有 1 处 await 省略（语义等效） |
| **Storage Engine 替换** | OverGraph/LMDB + Classic-Level 已满足需求 |
| **FulltextIndex 替换** | MiniSearch 7.2.0 已经是优秀选择 |
| **`benchmark.js` 迁移** | vitest bench API 已满足需求 |
| **`tinybench` 迁移** | 同上 |
| **`mnemonist` 哈希集合** | 自带 `Set` 对 string key 足够，额外依赖 2x 包大小 |

---

## 推进计划

### Phase A: UNION 去重引擎（预期 1 session）

- Step 1: `_fastDedup` — 自研多级签名去重
- Step 2: 替换 `union / intersect / subtract` 三条路径
- Step 3: 正确性验证 + perf 对比 + 回归

### Phase B: Lazy GE（预期 1 session）

- Step 1: 识别不需要 GE 的 plan type
- Step 2: GE 创建段前加守卫
- Step 3: 正确性验证 + perf 对比 + 回归

### Phase C: 表达式缓存（预期 1 session）

- Step 1: `_exprCache` WeakMap 实现
- Step 2: `_evalBinary` 入口缓存检查
- Step 3: 正确性验证 + perf 对比 + 回归

### Phase D: ORDER BY 原地排序（预期 1 session）

- Step 1: indices sort 实现
- Step 2: 3-stage 分区
- Step 3: 正确性验证 + perf 对比 + 回归

### 每个 Phase 的验收标准

| 检查项 | 命令 | 必须通过 |
|--------|------|----------|
| graph-engine 622 tests | `--quick` | ✅ |
| query-engine 71 tests | `--quick` | ✅ |
| TCK top (5) + MatchWhere (34) | `--quick` | ✅ |
| split spec (55 files, 991) | `npx vitest run` | ✅ |
| cucumber TCK (~4632) | `full-regression.sh --cucumber` | ✅ |
| perf (143 metrics) | `scripts/perf.sh --save` | ✅ 无回归 |
| correctness 专项测试 | 新 spec 文件 | ✅ |
