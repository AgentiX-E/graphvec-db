# V19 执行计划 — 4 路功能迭代

创建时间: 2026-06-03 20:01

## 目标
CALL 子查询 + LOAD CSV + GNN batch API + CASE 条件注入 + 全量回归

## Phase 1 (P0): Cypher CALL 子查询
- [ ] parseQuery: CALL `{ subquery }` 解析为 callSubquery plan
- [ ] _executeQuery: CALL 分支递归执行内层 plan
- [ ] 作用域隔离（内外层变量互不污染）
- [ ] 参数传递（外→内）
- [ ] CALL 内 RETURN 返回结果到外层
- [ ] call-subquery.spec.ts: 至少 8 个测试

## Phase 2 (P0): LOAD CSV
- [ ] parseQuery: LOAD CSV FROM 'file' AS row 解析
- [ ] _executeLoadCSV: 读取文件 + CSV 解析 + 行映射
- [ ] 支持本地文件路径 + URL
- [ ] 支持 WITH HEADERS
- [ ] 错误处理（文件不存在、格式错误）
- [ ] load-csv.spec.ts: 至少 6 个测试

## Phase 3 (P1): GNN REST API batch 端点
- [ ] POST /api/v1/gnn/predict-links-batch (pairs array)
- [ ] POST /api/v1/gnn/recommend-batch (multiple source nodes)
- [ ] rest.spec.ts 扩展测试

## Phase 4 (P1): CASE 条件注入增强
- [ ] CASE 中支持复杂条件（AND/OR/NOT）
- [ ] CASE 中支持属性引用（n.age）
- [ ] case-eval.spec.ts 扩展测试

## Phase 5 (Cleanup): 全量回归验证
- [ ] npx vitest run 全量通过
- [ ] 修复发现的 flaky test

## 当前进度
启动中
