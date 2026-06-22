# Phase 16 执行计划 — 查询语言扩展（hashIndex + USING INDEX）

基线：`2c50e896` (Phase 15 Step 1)
创建时间: 2026-06-22 14:30

## 目标
实现 hashIndex 内存索引 + USING INDEX 语法 hint，在 seed 阶段用 Map<value, indices[]> O(1) 精准定位节点，替换线性 scanAll。

## 步骤

### Step 1: hashIndex 构建
- `_executeViaGraphEngine` seed 阶段前构建 `hashIndex: Map<label+property+value, nodeIndices[]>`
- 使用 `indexedEqFilters`（已在 3393 行解析）作为构建键
- 构建时机：`allNodes` 完善后、GE 遍历开始前
- 数据结构：`Map<string, number[]>` key = `${label}:${property}:${String(value)}`
- 只构建当前查询需要的（不全部构建）

### Step 2: GE plan 改造传递 hashIndex
- 在 plan 上附加 `_hashIndex` 字段
- GE 在 `_scanAll` → `_scanNodesByLabel` 路径检查 `_hashIndex[f.label][f.property][String(f.value)]`
- 跳过不匹配的节点

### Step 3: USING INDEX 语法支持
- `parseCypherToPlan` 提取 `USING INDEX n:Person(name)` → plan 注解 `_indexHint`
- 解析器现有 hint 处理框架（hints.xml 基准测试）
- 传递到 GE 的 _executeQueryPlan 供给 `_scanNodesByLabel` 使用

### Step 4: 验证 + 基准
- 迭代回归 + hashIndex 基准
- TCK 零退化

## 原则
- 现有路径完全不受影响，hashIndex 是纯加速层
- 每一步 git commit
- --quick 回归每步
