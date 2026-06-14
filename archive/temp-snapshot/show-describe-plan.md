# SHOW/DESCRIBE + DROP CONSTRAINT 执行计划

创建时间: 2026-06-03 23:59

## 目标

实现 SHOW/DESCRIBE/DROP CONSTRAINT 元数据语句的 PEG 解析和 query-engine 支持。

## 步骤

- [x] 了解项目结构和现有代码
- [x] 修改 `cypher-lite.peggy`:
  - [x] 添加 `ShowStatement` — SHOW CONSTRAINTS/INDEXES/PROCEDURES/FUNCTIONS/LABELS/RELATIONSHIPTYPES
  - [x] 添加 `DESCRIBE` 作为 `EXPLAIN`/`PROFILE` 同义词 (ExplainStatement)
  - [x] 添加 `DropConstraint` — DROP CONSTRAINT ON ... ASSERT ... IS UNIQUE
  - [x] 将 ShowStatement, ExplainStatement, DropConstraintStatement 加入 `Start`
- [x] 修改 `query-engine.ts`:
  - [x] `QueryPlan` 加 `show?: string` 字段
  - [x] `parseQuery` 新增 direct PEG parse 前置处理来解析 SHOW/DESCRIBE/DROP 等
  - [x] DESCRIBE 解析为 explain=true
  - [x] DROP CONSTRAINT 解析成功 (执行留空)
- [x] 重新生成 parser
- [x] 创建 `src/query/show-describe.spec.ts` 测试文件
  - [x] SHOW: 12 个测试 (4 parseQuery + 6 PEG + 2 BUILTIN_FUNCTIONS)
  - [x] DESCRIBE: 3 个测试
  - [x] DROP: 5 个测试
- [x] 运行测试确认全部通过 (20/20 ✅)

## 达成

- 20 tests in `show-describe.spec.ts` all passing ✅
- Pre-existing test failures (3) are unrelated to this change
  - `union-skip.spec.ts` — pre-existing syntax errors
  - `cypher-function.spec.ts` — pre-existing function list mismatch
  - `planner-bridge.spec.ts` — pre-existing sort ordering issue
