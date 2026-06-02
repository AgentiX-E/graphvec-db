# V6 列式索引 + CDC 执行计划

创建时间: 2026-06-02 11:44

## 目标

实现 GAP-14（列式索引）和 GAP-15（CDC 变更数据捕获），完成 V6 存储层核心。

## 步骤

- [x] 步骤 1: 调研现有代码结构 ✅
- [x] 步骤 2: 写 columnar-index.ts + columnar-index.spec.ts ✅ (25/25 tests)
- [x] 步骤 3: 集成 colIndex 到 StorageConfig 和 OverGraphStorage ✅
- [x] 步骤 4: 跑 columnar-index 测试 ✅
- [x] 步骤 5: 写 cdc-adapter.ts + cdc-adapter.spec.ts ✅ (7 tests)
- [x] 步骤 6: 写 cdc-server.ts + cdc-server.spec.ts ✅ (23 tests)
- [x] 步骤 7: 跑所有测试 ✅ (55 tests + existing tests unchanged)
- [ ] 步骤 8: 最终 commit
- [ ] 步骤 9: 输出 __V6_STORAGE_COMPLETE__ 到 temp/v6-storage-done.md

## 当前进度

正在执行: 步骤 8 — 最终 commit
