# V25 路线

## 目标：Cypher 元数据查询 + 语义增强 + 深度覆盖

### 路线

| # | 特性 | 工作量 | 说明 |
|--:|:-----|:------:|:-----|
| 1 | **PERIODIC COMMIT** | 1天 | `USING PERIODIC COMMIT 500` 批量事务提示 |
| 2 | **CREATE CONSTRAINT** | 1天 | `CREATE CONSTRAINT ON (n:Person) ASSERT n.age IS UNIQUE` |
| 3 | **SHOW/DESCRIBE 元数据** | 1天 | `SHOW CONSTRAINTS/SHOW INDEXES/SHOW PROCEDURES` |
| 4 | **DROP CONSTRAINT** | 0.5天 | 反向操作 |
| 5 | **CREATE/DROP INDEX** | 1天 | 索引管理语句 |
| 6 | **`ALL`/`OPTIONAL MATCH` 增强** | 1天 | 多个 OPTIONAL MATCH 组合/全量匹配 |
| 7 | **`SET` 多重赋值** | 0.5天 | `SET n.age = 30, n.name = 'Alice'` |
| 8 | **`REMOVE` 属性/标签** | 0.5天 | `REMOVE n.age; REMOVE n:Person` |
| 9 | **`IS NULL` / `IS NOT NULL`** | 0.5天 | 空值判断 |
| 10 | **多语句事务** | 2天 | `BEGIN/COMMIT/ROLLBACK` |
