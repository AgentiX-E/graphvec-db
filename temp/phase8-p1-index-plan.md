# Phase 8 — P1: 索引前缀扫描

创建时间: 2026-06-20 22:43
目标: GE seed 阶段利用 `_indexRegistry` 加速节点扫描

## 背景
- `_indexRegistry` 已完整（CREATE/DROP/GET/CLEAR）
- GE seed 阶段：所有 `allNodes` upsert 到 GE，然后 GE 的 `_executeQueryPlan` 对 `plan.scanLabel` 做 `_scanNodesByLabel`（O(n) 全量扫描）
- 100K 节点扫描 ~1.4M ops/s，但 WHERE filter 在 seed 阶段再过滤一次

## 方案
不改 GE `_scanNodesByLabel`。改为：**在 query-engine seed 阶段，用 `_indexRegistry` 匹配后，将 GE 的 `_scanNodesByLabel` 范围缩小。**

更具体：GE `_executeQueryPlan` 中的候选节点获取方式：
- 有 index → GE query `MATCH (n:Label) WHERE n.prop = val RETURN n` → 只扫 index 节点
- 无 index → 现有 O(n) 全量扫描

**但在 query-engine 层，我们无法直接插入 GE 内部的 `_scanNodesByLabel`。** 实际可行的方案：

**方案一：seed 过滤**（推荐）
在 GE seed 前或后，对有 index 的 label+filter 预先用 GE 的 index query 查询，筛选 `allNodes`，只把匹配的节点 upsert 到 GE。

**方案二：GE 补 `_indexQuery` 方法**
给 GE 加一个方法，接收 label + property + value，返回匹配的节点 ID 列表。

**选方案一**，因为不需要改 GE 接口，只在 query-engine 的 seed 段增加一个过滤步骤。

## 步骤

- [x] 分析 seed 阶段代码路径
- [ ] Step 1: 确认 `_scanNodesByLabel` + filter 的交互路径
- [ ] Step 2: 在 seed 阶段加 index 查询 -> 预过滤 allNodes
- [ ] Step 3: 验证 TCK 无回归
- [ ] Step 4: 性能基准对比
