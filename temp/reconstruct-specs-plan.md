# 重建 4 个缺失的 spec 文件 — 执行计划

创建时间: 2026-05-23 13:47

## 目标

在 `agentiX-graphvec/src/` 下重建 4 个被误删除的 spec 文件：

1. **`src/api/rest.spec.ts`** — RestApiServer 测试（38 tests）
2. **`src/api/query-planner.spec.ts`** — 查询优化器测试（25 tests）
3. **`src/import/graph-import.spec.ts`** — 导入功能测试（19 tests）
4. **`src/search/fulltext.spec.ts`** — 全文搜索测试（43 tests）

还需要创建对应的源文件（因为它们也不存在）：
- `src/api/rest.ts` — RestApiServer
- `src/api/query-planner.ts` — QueryPlanner
- `src/import/graph-import.ts` — GraphImporter
- `src/search/fulltext.ts` — FullTextIndex (segmented-fulltext.ts 依赖此文件)

## 步骤

- [x] 步骤1: 创建 `src/search/fulltext.ts`（FullTextIndex 实现）
- [ ] 步骤2: 创建 `src/search/fulltext.spec.ts`（43 个测试）
- [ ] 步骤3: 创建 `src/api/rest.ts`（RestApiServer 实现）
- [ ] 步骤4: 创建 `src/api/rest.spec.ts`（38 个测试）
- [ ] 步骤5: 创建 `src/api/query-planner.ts`（QueryPlanner 实现）
- [ ] 步骤6: 创建 `src/api/query-planner.spec.ts`（25 个测试）
- [ ] 步骤7: 创建 `src/import/graph-import.ts`（GraphImporter 实现）
- [ ] 步骤8: 创建 `src/import/graph-import.spec.ts`（19 个测试）
- [ ] 步骤9: 运行 `npx tsc --noEmit` 验证零错误
- [ ] 步骤10: 单跑各 spec 验证全部通过

## 当前进度

正在执行: 步骤1
