# Phase 8 — 查询优化 + 约束验证

## 路径分析
当前全量 TCK 3878/3878 ✅，OPTIONAL MATCH + INDEX/CONSTRAINT/SHOW 已交付。
剩余自然缺口（用户可感知的缺失功能）：

## 优先级

### P0: CREATE CONSTRAINT 唯一性验证
- AST 解析已有 `CREATE CONSTRAINT ... UNIQUE`（`ConstraintClauseAST`）
- 执行层只有 DROP CONSTRAINT，没有创建和校验
- 对用户感知：CREATE + 违反约束时抛有意义错误
- 估计 ~50 行代码

### P1: 查询优化 — 索引前缀扫描
- `_executeViaGraphEngine` 在 seed GE 阶段可以通过 index 跳过全量扫描
- 当 plan 中有 `scanLabel + filter 匹配 index` 时，只在 index 节点集上扫描
- 对性能有 10-100x 提升（100K 节点时从 O(n) → O(k)）
- 需要改动 seed 逻辑，影响面较小

### P2: SHOW 查询列格式标准化
- 当前返回 raw rows（`{label: 'Person'}`），TCK 可能期望 `{columnLabel: 'Person'}`
- 但 TCK 中没有对应场景，属于"完美主义"优化

### P3: FOREACH 移除残留
- H4 已处理死代码，但 FOREACH 类型定义还在
- 清理 type guard/fallthrough

## 决策
先 P0（约束验证），再 P1（索引加速）。P2/P3 可并行。
