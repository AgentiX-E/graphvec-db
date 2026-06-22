# Phase 15 执行计划 — Plan 注解 + 谓词下推 + 索引 hint

基线：`438bdd01` (Phase 14 finish)
创建时间: 2026-06-22 14:30

## 修正方向
分析后确认：
1. `__edges` 已经是 O(degree) 最优，adjIdx 全局 Map 不额外加速
2. QueryPlanner class 提取在 9217 行 qe 中风险 > 收益
3. **真正价值：谓词下推 + 索引 hint + plan 注解**

## 策略
不提取独立 class，在 `_executeViaGraphEngine` 中内联增强。

## 步骤

### Step 1: Plan 注解层
在 plan 上附加 `_annotations` 元数据字段：
- `estimatedRows`: 基于 seed 节点数预估
- `predicateTypes`: WHERE 谓词类型分类（EQ → 精准匹配 / GT/GTE → 范围扫描）
- `hasIndex`: 是否有用于属性过滤的索引
- `labelStats`: allNodes 中各标签的节点计数

### Step 2: 谓词下推增强
当前已部分支持（stepSourceFilters / indexedEqFilters匹配 在 seed 阶段过滤）。增强：
- 多步场景：中间步属性过滤直接下推
- 跨变量引用：`a.id = b.id` 在结果中过滤（当前有 crossVarFilters 但无优化决策）

### Step 3: 索引 hint 支持
- 语法：`MATCH (n:Person) USING INDEX n:Person(name)` → plan 注解 `_indexHint`
- `_executeViaGraphEngine` seed 阶段用索引扫描代替线性扫描
- `hashIndex` 内存索引
  - label + property → Map<value, nodeIndices[]> 精准 O(1)
  - 只在 seed 阶段构建，不持久化

### Step 4: 验证 + 基准
- TCK 零退化
- hashIndex 性能基准
- 谓词下推正确的正确性验证

## 原则
- 不改变现有执行路径的行为
- 每一步可逆，git commit 常态化
- 每一步后 --quick 回归
