# Phase 16 执行计划 — 查询语言扩展（hashIndex + USING INDEX）

基线：`2c50e896` (Phase 15 Step 1)
创建时间: 2026-06-22 14:30

## 目标
实现 hashIndex 内存索引 + USING INDEX 语法 hint，在 seed 阶段用 Map<value, indices[]> O(1) 精准定位节点，替换线性 scanAll。

## 步骤

### Step 1: hashIndex 构建 ✅
- `_executeViaGraphEngine` seed 阶段前构建 `hashIndex: Map<label+property+value, nodeIndices[]>`
- 使用 `indexedEqFilters`（已在 3393 行解析）作为构建键
- 构建时机：`allNodes` 完善后、GE 遍历开始前
- commit: `2b76afae`

### Step 2: USING INDEX hint ✅
- `buildQueryPlan` 正则提取 `USING INDEX n:Label(prop)` → plan `_indexHint`
- commit: `657abf43`

### Step 3: hashIndex hint 优先 ✅
- 当 `_indexHint` 存在时，只构建 hint 指定的索引键
- 跳过 `indexedEqFilters` 的注册检查（hint 不需要索引已注册）

### Step 4: 验证 ✅
- query-engine 120/120 ✅
- graph-engine 637/637 ✅
- DML 15/15 ✅
- CountingSubgraphMatches 11/11 ✅

## 当前进度
全部完成 ✅ — commit `657abf43`

