# EXISTS 子查询支持 - 执行计划

创建时间: 2026-06-23 08:09

## 目标
使 Cypher TCK 的 ExistentialSubquery 3 个 feature（11 个场景）通过测试。

## 步骤

- [ ] Step 1: 修复 TCK features 路径检测 — `st.nodes` 中节点需要存储 __edges（相邻关系），以便 EXISTS 能查询到关联边；同时将 features 注册到 cucumber.js
- [ ] Step 2: 增强 existsFilters 的解析，支持 TCK 中的 EXISTS 语法：
  - `EXISTS { (n)-->() }` (out direction, no edge label)
  - `EXISTS { MATCH (n)-->(m) RETURN true }` (full subquery form)
  - `EXISTS { MATCH (n)-->(m) WHERE n.prop = m.prop }` (with WHERE)
  - `EXISTS { MATCH (n)-->(m) WITH n, count(*) AS numConnections WHERE numConnections = 3 RETURN true }`
  - Nested EXISTS
  - `NOT EXISTS { ... }`
  - `EXISTS { (n)-[:R]->(m) }` (with edge label)
  - SyntaxError for SET/MERGE inside EXISTS
- [ ] Step 3: 实现 existsFilters 的执行时应用（SemiApply 语义）
  - 在 MATCH 结果的 WHERE 后过滤中，对每个候选行检查 EXISTS 条件
  - 简单模式: 检查(source)→(target)是否存在边
  - 完整子查询: 对 EXISTS 内部进行子查询计算，如果有结果返回 true
- [ ] Step 4: 运行 --quick 回归，确保全绿

## 当前进度
正在执行: Step 1 — 分析现有代码结构
