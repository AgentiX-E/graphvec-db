# OPTIONAL MATCH 支持 — 执行计划

## 目标
OPTIONAL MATCH 完成 TCK 全量验证（131 scenarios）

## 阶段

### Phase A: 基础匹配（~50 scenarios）
- [ ] 实现 `_executeViaGraphEngine` 中 OPTIONAL MATCH 的基本逻辑
- [ ] 单模式 `OPTIONAL MATCH (n)` — 匹配到或 null
- [ ] 带标签、属性的 OPTIONAL MATCH
- [ ] 验证：expression graph/NULL scenarios

### Phase B: 边匹配（~40 scenarios）
- [ ] `OPTIONAL MATCH (a)-[r]->(b)` — 边不存在时 r,b 为 null
- [ ] `OPTIONAL MATCH (a)-[r:TYPE]->(b)` — 特定边类型
- [ ] 验证：Graph4/5/6/8/9

### Phase C: OPTIONAL MATCH + WHERE（~30 scenarios）
- [ ] `OPTIONAL MATCH (n) WHERE n.prop = val`
- [ ] OPTIONAL + 普通 MATCH 联合
- [ ] 验证：复合场景

### Phase D: 别名/聚合（~11 scenarios）
- [ ] `OPTIONAL MATCH` 结果在 RETURN 中使用
- [ ] `collect()` 与 OPTIONAL MATCH 组合
- [ ] 验证：Aggregation5/8

## 当前进度

开始 Phase A
