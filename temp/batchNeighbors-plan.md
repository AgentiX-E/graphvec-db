# batchNeighbors + LRU Cache 执行计划

创建时间: 2026-05-24 20:10

## 目标

1. 在 `src/core/graph-engine.ts` 增加 `batchNeighbors(ids: NodeId[], opts?)` 方法
2. 添加 LRU 缓存类（1000 条），缓存 `neighbors(id)` 结果，使用 Map + 双向链表
3. 缓存有 TTL（默认 60 秒），过期自动失效
4. 对外暴露 `enableCache()` / `disableCache()` / `clearCache()` 方法
5. tsc 0 errors 保持
6. 用 npx tsx -e 验证

## 步骤

- [x] 分析现有代码结构
- [ ] 实现 LRU 缓存类（在 graph-engine.ts 内或单独文件）
- [ ] 在 GraphEngine 中集成缓存 + batchNeighbors
- [ ] tsc 编译检查
- [ ] 功能验证

## 当前进度

已完成分析，开始实现。
