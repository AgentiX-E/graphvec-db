# GraphVec 性能基准基线 — 2026-06-21

## 环境
- **Host**: iZuf66ab7u7zhjeyi216pwZ (Linux 5.15.0-144-generic x64)
- **Node**: v24.14.0
- **GE**: Rust native addon + TS wrapper
- **Commit**: `627d80da` (FOREACH 48/48 ✅)

## 基线数据

| # | 测项 | 平均耗时 | Ops/sec | 备注 |
|---|------|---------|---------|------|
| 1 | `_scanNodesByLabel('Person')` 35K Person + 15K Other x20 | **209.2 ms** | — | 混合 label 场景 |
| 2 | `scanAllNodes(50K)` x20 | **262.2 ms** | 4 | 全表扫描 |
| 3 | GE query `MATCH (n:Person) WHERE n.age > 25 RETURN n` (10K) x50 | **78.4 ms** | 13 | 全链路 parse+scan+filter |
| 4 | GE query `MATCH (n:Person)-[:KNOWS]->(m:Person)` (5K+5K, 15K edges) x30 | **58.2 ms** | — | 返回 0 rows（边 ID 构造问题，不作为参考值） |
| 5 | QE `_executeQuery` MATCH+WHERE (10K) x20 | **—** | — | 需要 GE 预 seed，跳过 |
| 6 | QE `_executeQuery` MATCH+EDGE (500 nodes, 3K edges) x30 | **28.0 ms** | — | 全链路 query-engine |

## 注意事项
- 测项 4 的随机边构造用了 Person array index 而非 GE node ID，导致边连接无效，结果行数为 0。不影响 benchmark 代码示例，仅数据构造问题。
- 测项 5 需要 GE 预 seed 节点，benchmark 中未做，待修复后加入。
- 测项 1 混合 label 场景（35K matching + 15K non-matching label）比纯 matching scan（labelStrIndex 40x）慢，因为需要逐节点判断 label 字符串匹配。
- 可参考历史基线：100K 节点 `_scanNodesByLabel('Person', 1000)` = **15ms**（纯 matching），测试在 `src/benchmark/scalability.spec.ts`。
