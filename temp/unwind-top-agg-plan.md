# UNWIND + 顶层聚合 Step 4 修复计划

创建时间: 2026-08-25 01:36 GMT+8

## 目标

修复 `_executeWithUnwindPipeline` 中「UNWIND 管道 + RETURN 顶层聚合函数（count/sum/avg/max/min/collect）」未正确跨行聚合的既有 bug。当前这些场景（`WITH [1,2,3] AS xs UNWIND xs AS x RETURN count(x) AS n`）返回 3 行 `[{n:1}×3]`，期望单行 `[{n:3}]`。

## 已知根因（初步）

`_executeWithUnwindPipeline` 的 Step 4（聚合）条件为 `plan.aggregate && !plan.with?.columns?.length`。但 UNWIND 分支里 `plan.with.columns` 非空（如 `WITH [1,2,3] AS xs` 的投影列），导致 Step 4 被跳过，聚合不生效。

## 步骤

- [ ] 步骤1: 精确定位 Step 4 被跳过的条件，理解 `with.columns` vs `plan.aggregate` 的语义冲突
- [ ] 步骤2: 设计优雅修复——区分「WITH 聚合投影列」和「RETURN 顶层聚合」，让 RETURN 顶层聚合在 UNWIND 分支正确跨行
- [ ] 步骤3: 验证 count/sum/avg/max/min/collect 各聚合函数 + UNWIND 组合
- [ ] 步骤4: 全量回归（quick 4/4 + 表达式 TCK before/after diff），零回归
- [ ] 步骤5: 覆盖测试 >=95%
- [ ] 步骤6: Lambertyan 英文提交

## 当前进度

正在执行: 步骤1（精确定位 Step 4 跳过条件）
