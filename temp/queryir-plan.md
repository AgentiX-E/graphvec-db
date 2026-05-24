# QueryIR Implementation Plan

创建时间: 2026-05-23 22:41

## 目标

在 Fluent API (GraphQuery) 和 QueryPlanner 之间添加 QueryIR 中间层，支持计划树构建、优化和执行。

## 步骤

- [x] 步骤1: 分析现有代码结构
- [x] 步骤2: 在 query-planner.ts 中添加 QuerySpec 接口、buildIRFromSpec、optimizeIR、executeIR
- [x] 步骤3: 在 query-planner.ts 中添加 limitPushdown 优化
- [x] 步骤4: 在 fluent.ts 中添加 plan() 方法并集成 IR 执行
- [x] 步骤5: 验证 tsc --noEmit + jest ✅ (134/134 tests pass)

## 完成

全部实现完成：

### 新增 API（query-planner.ts）
- `QuerySpec` 接口 — Fluent API 与 QueryIR 之间的标准化接口
- `buildIRFromSpec()` — 将 QuerySpec 转换为 PlanNode 树
- `optimizeIR()` — 应用优化规则：pushDownFilter + limitPushdown + deadBranchElimination
- `limitPushdown()` — 新优化规则：将 LIMIT 推入 SCAN/NEIGHBORS
- `executeIR()` — 递归执行 PlanNode 树（支持 SCAN, NEIGHBORS, FILTER, SORT, LIMIT, PROJECT, VECTOR_SEARCH）
- `formatPlanExplain()` — 将 PlanNode 格式化为可读的 EXPLAIN 字符串

### 新增 API（fluent.ts）
- `plan()` 方法 — 输出当前查询的优化计划，不实际执行
- `enableOptimizer()` 方法 — 开关 QueryIR 优化器

### 新增测试文件
- `query-ir.spec.ts` — 29 个新测试用例覆盖全部新功能
