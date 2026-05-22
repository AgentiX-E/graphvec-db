# fix-cross-range-ppr 执行计划

创建时间: 2026-05-22 14:11

## 目标

修复 `src/core/graph-algorithms.ts` 中 PPR/最短路径/Dijkstra 只在本 Range 执行的跨 Range 数据丢失问题。

## 步骤

- [x] 步骤1: 阅读当前代码（algorithms.ts, shard-router.ts, types.ts, spec.ts）
- [x] 步骤2: 建立测试基线（6 个测试通过，全项目 312 个通过）
- [x] 步骤3: 修改 `ppr()` 支持跨 Range fan-out + 添加文档注释
- [x] 步骤4: 修改 `shortestPath()` 支持跨 Range fan-out + 添加文档注释
- [x] 步骤5: 修改 `dijkstra()` 支持跨 Range fan-out + 添加文档注释
- [x] 步骤6: 添加 `_collectReachableCrossRange()` / `_fanOutExpand()` 等辅助方法
- [x] 步骤7: 更新测试文件，添加跨 Range 场景测试（25 个测试全部通过）
- [x] 步骤8: 验证 `npx tsc --noEmit` 编译通过
- [x] 步骤9: 验证 `npx jest --verbose` 全部通过（仅 backup.spec.ts 有 4 个预存失败）

## 当前进度

✅ 全部完成
