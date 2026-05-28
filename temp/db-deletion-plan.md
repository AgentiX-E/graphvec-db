# DB Deletion Phase 1-3 实现计划

创建时间: 2026-05-29 05:55

## 目标
为 DatabaseManager 实现三阶段删除（参考 docs/multi-database-arch-design.md §8）

## 步骤

- [x] Phase 0: 已有 — dropDatabase() 停止 shardManager + 从 map 删除
- [x] Step 1: 在 dropDatabase() 中补充 Phase 1 — Tombstone 写入
- [x] Step 2: 实现 Phase 2 — restoreDatabase() 回滚方法
- [x] Step 3: 实现 Phase 3 — gcDatabases() / cleanupDeletedDatabases() 物理清理
- [x] Step 4: 运行 test:core-base 和 test:int 确认不破坏

## 当前进度

✅ 全部完成
