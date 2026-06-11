# Phase 5: 从 mock 迁移到 GraphEngine 执行路径

## 现状

- **TCK**: 1016 tests，通过 `_executeQuery(plan, data)` 在纯 JS 内存中模拟执行
- **GraphEngine**: 3410 行，已有完整 `engine.query()` + `_executeQueryPlan` 实现
- **GraphEngine query()**: 内部调用 `parseQuery(queryString)`，然后走自己的一套执行链

## 核心发现

**GraphEngine.query() 已经可以做 TCK 需要的一切：**
- MATCH/WHERE/RETURN/ORDER BY/SKIP/LIMIT ✅
- CREATE/MERGE/DELETE/SET/REMOVE ✅
- WITH/OPTIONAL MATCH/UNWIND ✅
- UNION/INTERSECT/SUBTRACT ✅
- Aggregation (COUNT/SUM/AVG/MIN/MAX) ✅
- CASE/EXISTS ✅
- CALL procedure ✅
- FOREACH ✅

## 迁移策略

### Option A: 直接替换（推荐）
把 TCK runner 中 `const result = _executeQuery(plan, nodes)` 替换为：
```ts
const engine = new GraphEngine(...)
engine.open()
// 前置创建 data 中的节点到 engine
const result = engine.query(queryString)
engine.close()
```
预估改动: TCK runner ~50 行适配代码

### Option B: 桥接层
写一个 `executeViaGraphEngine(plan, nodes, queryString)` 函数：
- 对每个 `_executeQuery` 调用，自动将 `nodes` 数据插入 GraphEngine
- 然后用 `engine.query(queryString)` 执行
- 比较结果是否一致

### Option C: 混合模式
对简单查询继续用 mock，对复杂查询（聚合、集合运算、OPTIONAL MATCH）用 GraphEngine
（不推荐——增加维护复杂度）

## 所需前置工作

1. **数据注入**: TCK 的 `nodes` 是纯 JSON 数组，需要转为 `engine.upsertNode()` 调用
2. **edge 数据**: TCK 的 `nodes` 中 edge 关系以 `_edges` 属性或独立的 `edges` 参数传递
3. **查询字符串传递**: `_executeQuery` 接收的是 plan，不保留原始 query string

## 前置检查

查看 `graph-engine.spec.ts`:
- Cypher-lite query (5 tests): simple MATCH/WHERE/LIMIT — 用 `engine.query()` ✅
- Aggregation (COUNT/SUM/AVG/MIN/MAX): 用 `engine.query()` ✅
- Set operations (UNION/INTERSECT/SUBTRACT): 用 `engine.query()` ✅
- WITH/OPTIONAL MATCH/UNWIND: 用 `engine.query()` ✅
- CASE: 用 `engine.query()` ✅

约 212 个 GraphEngine 测试已经使用了 `engine.query()` 且全部通过。
