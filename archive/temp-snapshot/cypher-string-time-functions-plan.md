# Cypher 字符串 + 时间函数 执行计划

创建时间: 2026-06-03 21:04

## 目标

在 `src/query/query-engine.ts` 中实现所有 Cypher 内置函数（字符串、时间、聚合），编写测试文件通过至少 12 个测试，且不破坏现有测试。

## 步骤

- [x] 步骤1: 分析代码结构 — 找到 BUILTIN_FUNCTIONS、_evalSimpleExpr、formatColumn
- [ ] 步骤2: 在 BUILTIN_FUNCTIONS 中添加缺失函数
- [ ] 步骤3: 在 _evalSimpleExpr 中添加 FUNCTION_CALL 处理
- [ ] 步骤4: 在 formatColumn 中添加 FUNCTION_CALL 处理
- [ ] 步骤5: 创建 builtin-functions.spec.ts
- [ ] 步骤6: 运行测试验证

## 当前进度

✅ 全部完成: 90 tests passed (3 files)
- builtin-functions.spec.ts: 13 tests ✅
- cypher-function.spec.ts: 8 tests ✅ (included old tests, updated the "all 7 functions" assertion)
- query-engine.spec.ts: 69 tests ✅ (no regressions)
