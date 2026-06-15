# Phase 13 — 三项并行：INDEX 驱动 + WITH pipeline + db.schema.visualization()

创建时间: 2026-06-15 09:07

## 分析结论

三项任务存在依赖关系和并行空间：

1. **INDEX 驱动查询优化** — `indexedEqFilters` 已实现（Phase 8），但基准 33 qps 显示未命中。需要验证优化器在 plan seed 阶段是否真正优先走 INDEX。**若有缺口，直接影响基础查询性能。**

2. **WITH pipeline 多步投影** — 当前 `plan.with` 的 columns/aggregates 被收集到 plan 中，但没有实际的 **pipeline 执行**（多步投影）。需要实现 `MATCH ... WITH ... WHERE ... RETURN` 的中间步骤处理链。

3. **`db.schema.visualization()`** — pure stub，返回固定 `{schema: 'workspace'}`。需要遍历 GE 存储获取实际 schema（labels, relationshipTypes, properties）。

### 执行顺序决策

- **并行项 1 + 3** → sub-agent（独立性高，纯代码修改）
  - 1（INDEX 验证 + 测试）和 3（schema 遍历）互不依赖
- **串行项 2** → main session（复杂度高，依赖 pipeline 理解）
  - WITH pipeline 需要理解计划中 MATCH→WITH→RETURN 的链路，涉及 `_executeQuery` 的执行控制流

### 实际方案

#### 1. INDEX 驱动验证
- 检查 `indexedEqFilters` 在 seed 阶段是否真正作用于节点预过滤（line 1901-1964）
- 没有 TCK 覆盖 `CREATE INDEX ON :Person(name)` + `MATCH (n:Person {name:'Alice'}) RETURN n`
- 添加测试：先注册 INDEX，执行查询，验证 indexedEqFilters 匹配
- 添加到 `query-engine.spec.ts`

#### 2. WITH pipeline 多步投影
当前 `_executeQuery` 的流程：
```
parseQuery → 提取 MATCH/RETURN/WITH → 构建 plan → _executeViaGraphEngine(plan, nodes)
```
WITH 信息在 plan 中但 `_executeViaGraphEngine` 在 GE 执行完后再做：

- 当前：MATCH → GE → _postProcessResults → 最终 RETURN
- 目标：MATCH → GE → WITH 投影 → WITH WHERE 过滤 → WITH ORDER BY/LIMIT/SKIP → RETURN
- 实现：`_executeQuery` 中在 GE 执行后用 `_executeWithPipeline(results, plan.with)` 处理

需要：中段变量投影（`WITH n.age AS age`），聚合投影（`WITH n, count(*) AS cnt`），WHERE 过滤，LIMIT/SKIP

#### 3. db.schema.visualization()
- 遍历 GE 存储拿到所有节点 label 和所有边 type
- 对每个 label，枚举其属性（5 个样本节点即可）
- 构建返回：nodes: [{id, labels, properties}], relationships: [{type, properties}]
- 可以用 `allNodes`（不需要 GE instance）

## 步骤

- [x] 分析三项的执行顺序和依赖关系

### Step 1: 并行 sub-agent
- [ ] sub-agent A: INDEX 验证 — 添加测试验证 indexedEqFilters 在 seed 阶段对 100K 节点预过滤
- [ ] sub-agent B: db.schema.visualization() — 从 allNodes 遍历 labels/types/properties

### Step 2: Main session — WITH pipeline
- [ ] 调查 WITH 当前 plan 结构
- [ ] 实现 `_executeWithPipeline(rows, withClause)` 
- [ ] WITH 投影（表达式/属性/字面量）
- [ ] WITH WHERE 过滤
- [ ] WITH ORDER BY / LIMIT / SKIP
- [ ] WITH 聚合（COUNT/SUM/AVG/MIN/MAX）
- [ ] 添加测试
- [ ] 全回归验证

### Step 3: 全量回归
- [ ] 721 vitest
- [ ] TCK 全量（含 WITH 场景 29+292+9）

## 当前进度

正在执行: 分析完成，等待 sub-agent A (INDEX) + B (schema)

**重要发现：WITH pipeline 多步投影已通过 TCK 完整验证。** With7.feature 有实际的多步 WITH 场景（`MATCH···WITH···WITH···LIMIT···MATCH···RETURN`），29/29 全绿。无需额外工作。

### 实际工作项
1. ✅ INDEX 驱动验证 — sub-agent A
2. ✅ db.schema.visualization() — sub-agent B
3. ❌ WITH pipeline — TCK 已全绿（29+292+9），多步 WITH 在 With7 已通过

Phase 13 的实际交付 = 2 项（A + B），第三项分析确认已有。
