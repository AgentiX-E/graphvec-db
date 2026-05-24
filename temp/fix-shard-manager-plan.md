# 修复 shard-manager.ts 三个缺陷 — 执行计划

创建时间: 2026-05-23 19:53

## 目标
修复 shard-manager.ts 的三个缺陷（P0.1 缓存miss丢失数据、P0.2 PPR 只跑一个 Range、P1.1 LRU替换），确保所有测试通过且 tsc 零错误。

## 步骤

- [x] 步骤1: 读取所有相关文件理解代码结构
- [x] 步骤2: 修复 P1.1 — 将 _nodeIdToName Map 替换为 LRUCache（最简单，先做）
- [x] 步骤3: 修复 P0.1 — upsertNode 写入 _rangeKey 到 props，getNode 读取并重新缓存
- [x] 步骤4: 修复 P0.2 — PPR 跨所有 Range fan-out 执行
- [x] 步骤5: 运行测试验证

## 当前进度

✅ 全部完成
- tsc --noEmit: 零错误
- 24/24 tests passed
