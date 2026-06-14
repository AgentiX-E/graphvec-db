# INDEX / CONSTRAINT / SHOW 支持 — 执行计划

## 现状
- AST 解析器已完整支持 `SHOW INDEXES | CONSTRAINTS | PROCEDURES | FUNCTIONS | LABELS | RELATIONSHIPTYPES`
- AST 解析器已支持 `CREATE INDEX ON :Label(prop)`、`DROP INDEX ON :Label(prop)`、`DROP CONSTRAINT name`
- 执行层仅有 `SHOW LABELS` 实现，其余为空

## 阶段

### Phase A: INDEX 生命周期 (~20 TCK scenarios)
- [ ] `CREATE INDEX ON :Label(prop)` → 存储索引注册 + 执行层接受并 no-op 确认
- [ ] `SHOW INDEXES` → 返回注册的索引列表
- [ ] `DROP INDEX ON :Label(prop)` → 移除索引注册
- [ ] 需要：内存中 indexes Map

### Phase B: SHOW 补全 (~30 scenarios)
- [ ] `SHOW CONSTRAINTS` → 返回约束列表
- [ ] `SHOW PROCEDURES` → 返回内置过程列表
- [ ] `SHOW FUNCTIONS` → 返回内置函数列表
- [ ] `SHOW RELATIONSHIPTYPES` → 从数据提取边类型

### Phase C: CONSTRAINT (~10 scenarios)  
- [ ] `CREATE CONSTRAINT` 解析（已有类型定义 `ConstraintClauseAST`）
- [ ] `DROP CONSTRAINT name`（已有解析）
- [ ] 约束验证（唯一性约束）

## 当前进度

Phase A
