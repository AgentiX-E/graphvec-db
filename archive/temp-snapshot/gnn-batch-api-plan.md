# GNN Batch API + CASE 条件注入增强 - 执行计划

创建时间: 2026-06-03 20:02

## 目标
1. 在 `rest.ts` 中新增 GNN batch 端点 (predict-links-batch + recommend-batch)
2. 在 `rest.spec.ts` 中为 batch 端点添加至少 5 个新测试
3. 增强 `query-engine.ts` 的 `_applyCaseColumns` 支持属性引用、比较操作符、AND/OR/NOT、ELSE、简化 CASE
4. 创建 `case-eval.spec.ts` 为 CASE 增强添加至少 5 个新测试
5. 确保现有 test 全部通过

## 步骤

- [x] 步骤1: 分析现有代码结构 (rest.ts, rest.spec.ts, gnn-engine.ts, query-engine.ts)
- [ ] 步骤2: 在 rest.ts 中添加 predict-links-batch 端点
- [ ] 步骤3: 在 rest.ts 中添加 recommend-batch 端点
- [x] 步骤2: 在 rest.ts 中添加 predict-links-batch 端点 ✅
- [x] 步骤3: 在 rest.ts 中添加 recommend-batch 端点 ✅
- [x] 步骤4: 在 rest.spec.ts 中添加 GNN batch 端点测试 (≥5 个) ✅
- [x] 步骤5: 增强 query-engine.ts _applyCaseColumns 支持增强的条件表达式 ✅
- [x] 步骤6: 增强 _evalSimpleExpr 支持复合逻辑 (AND/OR/NOT) ✅
- [x] 步骤7: 创建 case-eval.spec.ts 添加 CASE 增强测试 (≥5 个) ✅
- [x] 步骤8: 运行现有测试确保全部通过 ✅

## 完成

### 任务 A：GNN batch 端点 (rest.ts)
- POST /api/v1/gnn/predict-links-batch ✅
- POST /api/v1/gnn/recommend-batch ✅
- 10 个新测试在 rest.spec.ts ✅
- 增加了 `predictLinksBatch` 到 MockGnnEngine

### 任务 B：CASE 条件注入增强 (query-engine.ts)
- PROP_REF (dot-notation: n.age) 支持 ✅
- COMPARISON 操作符 (EQ/NEQ/GT/GTE/LT/LTE) ✅
- AND/OR 逻辑操作符 ✅
- ELSE 默认值 ✅
- 简化 CASE (CASE expr WHEN val) ✅
- 15 个新测试在 case-eval.spec.ts ✅

### 测试结果
- rest.spec.ts: 135 tests passed ✅
- query-engine.spec.ts: 69 tests passed ✅
- case-eval.spec.ts: 15 tests passed ✅

## 当前进度

正在执行: 步骤1 - 已完成
