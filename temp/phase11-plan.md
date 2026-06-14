# Phase 11: 变量长度路径查询

## 目标
支持 `MATCH (a)-[:KNOWS*1..3]->(b) RETURN a, b`

## 现状
- AST 解析（`ast-to-plan-v2.ts`）已有 `extractVarLength` 和 `varLength` 属性
- QueryPlan 接口有 `varLength` 字段
- **执行层缺失**：`_executeViaGraphEngine` 遇到 `varLength` 时不做处理

## 实现方案

### 1. GE 层：BFS 层面直接支持多跳遍历
`ge.neighbors(src, { maxDepth, edgeType })` 已经支持 BFS。变量长度路径本质上是：
- 从 source 节点做 BFS 到 depth=minHops..maxHops
- 每层收集路径末端节点及其路径信息

### 2. query-engine 层
在 `_executeViaGraphEngine` 的 step 处理中：
- 检测 `step.varLength`（有 min/maxHops）
- 对每个 source，调 `ge.neighbors(src, { maxDepth: step.varLength.maxHops })`
- 过滤掉 depth < minHops 的结果
- 按每层聚合结果行

## 复杂度
- 不需要修改 ANTLR 语法（已有解析）
- 只需要执行层 ~80-100 行代码
- 测试：内建 + TCK 验证

## 工作量
~1 小时
