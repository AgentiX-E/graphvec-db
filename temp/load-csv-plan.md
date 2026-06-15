# LOAD CSV 全栈实现计划

创建时间: 2026-06-15 09:31

## 目标
实现 LOAD CSV FROM 功能，支持 `LOAD CSV FROM 'file:///path.csv' AS row [WITH HEADERS | WITH NO HEADERS] [FIELDTERMINATOR ';'] RETURN row`

## 步骤

- [x] Step 1: 了解现有代码结构
  - QueryPlan 已有 loadCsv 字段定义（ast-to-plan-v2.ts:68, query-engine.ts:420）
  - loadCsv: { url, rowVariable, hasHeaders }
  - 需要添加 delimiter 字段
  - ast-to-plan-v2.ts 的 buildQueryPlan 需要添加 LOAD CSV 解析
  - query-engine.ts 的 _executeViaGraphEngine 需要添加执行分支

- [x] Step 2: 扩展 QueryPlan loadCsv 接口 - 添加 delimiter 字段
- [x] Step 3: ast-to-plan-v2.ts 添加 LOAD CSV 解析
- [x] Step 4: query-engine.ts 添加 parseCsvContent + splitCsvLine 辅助函数
- [x] Step 5: query-engine.ts 的 _executeViaGraphEngine 添加 loadCsv 执行分支
- [x] Step 6: 补充测试（query-engine.spec.ts）
- [ ] Step 7: 运行测试验证
- [ ] Step 8: git commit

## 当前进度

正在执行: Step 2
