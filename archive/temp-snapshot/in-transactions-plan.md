# CALL IN TRANSACTIONS + DETACH DELETE - 执行计划

创建时间: 2026-06-03 21:05

## 目标

1. **CALL { ... } IN TRANSACTIONS** — 解析支持 + 分批提交执行 + 测试
2. **DETACH DELETE 增强** — 执行层完善 + 更多测试

## 步骤

- [ ] 步骤1: 修改 PEG parser，添加 IN TRANSACTIONS 关键字
- [ ] 步骤2: 修改 AST 类型（QueryAST）+ QueryPlan 类型
- [ ] 步骤3: 修改 planFromAST 传递 inTransactions
- [ ] 步骤4: 修改 _executeQuery 实现分批提交
- [ ] 步骤5: 创建 in-transactions.spec.ts（至少5个测试）
- [ ] 步骤6: 完善 detach-delete 执行逻辑
- [ ] 步骤7: 补充 detach-delete.spec.ts（至少3个新测试）
- [ ] 步骤8: 运行所有测试验证

## 当前进度

正在执行: 运行测试
