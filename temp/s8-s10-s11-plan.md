# Phase A: 路由一致性 + Rebalancing 安全 修复计划 ✅

## 状态：已完成

### S8 修复 ✅
- 在 `ShardManager` 中添加 `_nodeIdToName: Map<NodeId, string>` 缓存
- 添加 `_getRangeForNodeId(id)` 方法：优先按名称路由，缓存 miss 回退 `String(id)`
- `upsertNode` → 写入后缓存 nodeId→prefixedName
- `batchUpsertNodes` → 批量写入后缓存所有映射  
- `getNode(id)` → 通过 `_getRangeForNodeId` 按名称路由
- `deleteNode(id)` → 同上
- `neighbors(id)` → 同上
- `upsertEdge(src,...)` → 同上
- `batchUpsertEdges(src,...)` → 同上

### S10 修复 ✅
- `_migrateNode` 迁移节点时同时迁移所有 outgoing edges
- 边中涉及迁移节点的 src/dst 替换为新的 target ID
- Cleanup 阶段先删除边再删除节点

### S11 修复 ✅
- `RangeInstance` 添加 `_draining` 标记 + `setDraining()` + 写入拒绝
- `isHealthy()` 在 draining 时返回 false
- `_doRebalanceNodes` 在迁移前设置 draining，迁移写入完成后解除
- 迁移的写入（upsert → target）在 draining 期间进行，读取（neighbors → source）不受影响
- Cleanup 阶段在 draining 解除后进行
- 使用 try/finally 确保 draining 始终解除

### 验证 ✅
- 29/30 测试通过（1 个 pre-existing vectorSearch 测试失败，与改动无关）
- 所有 rebalancer 测试通过
