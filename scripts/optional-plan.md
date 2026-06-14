# OPTIONAL MATCH 支持 — 执行计划

## 目标
OPTIONAL MATCH 完成 TCK 全量验证（131 scenarios）

## 阶段

### Phase A: 基础匹配 ✅ (commit `1588de64`)
- [x] GE._executeQueryPlan 对每个 result row 执行 optional matchesteps
- [x] 匹配到 → 合并 node props; 匹配不到 → 填充 null
- [x] 验证: Graph3/4/5/6/8/9 (58/58), Aggregation5/8 (6/6), Null2 (17/17), List12 (7/7)
- [x] 全量回归 4/4 ALL GREEN

### Phase B: 边匹配（~40 scenarios）
- [ ] `OPTIONAL MATCH (a)-[r]->(b)` — 已实现基础 null 填充，需验证
- [ ] `OPTIONAL MATCH (a)-[r:TYPE]->(b)` — 特定边类型
- [ ] `MATCH (n) OPTIONAL MATCH (n)-[r]->(m)` — 引用主查询变量
- [ ] 验证：clauses 中 OPTIONAL MATCH features + 更多 graph features

### Phase C: OPTIONAL MATCH + WHERE（~30 scenarios）
- [ ] `OPTIONAL MATCH (n) WHERE n.prop = val`
- [ ] OPTIONAL + 普通 MATCH 联合
- [ ] 验证：复合场景

### Phase D: 别名/聚合（~11 scenarios）
- [ ] `OPTIONAL MATCH` 结果在 RETURN 中使用（已完成 Null2, Aggregation 验证）
- [ ] `collect()` 与 OPTIONAL MATCH 组合（已完成验证）

## 当前进度

Phase A ✅ → 推进 Phase B
