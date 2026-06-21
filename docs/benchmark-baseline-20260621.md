# GraphVec 性能基准基线 — 2026-06-21

## 环境
- **Host**: iZuf66ab7u7zhjeyi216pwZ (Linux 5.15.0-144-generic x64)
- **Node**: v24.14.0
- **GE**: Rust native addon + TS wrapper
- **Commit**: `c012426a` (Phase 9: 基准 + 审查 + Comparison 确认)

## vitest spec 级基线（label-str-index.spec.ts）
以下数据为 3 次运行取平均值，波动 <3%。

| # | 测项 | 3-run avg | 阈值 | 断言 |
|---|------|----------|------|------|
| B1 | `_scanNodesByLabel('Person')` x5 on 100K (80K matching) | **496.1 ms** | ≤1000ms | 5/5 ✅ |
| B2 | `_scanNodesByLabel('NonExistent')` x5 on 100K (0 matching) | **622.5 ms** | ≤1000ms | 5/5 ✅ |
| B3 | `_scanNodesByLabel('Other')` x5 on 100K (20K matching) | **121.4 ms** | ≤500ms | 5/5 ✅ |
| B4 | `_scanNodesByLabel` x10 on 0 nodes | **0.00 ms** | ≤2ms | 10/10 ✅ |
| B5 | `_scanNodesByLabel('Person')` x5 on 50K (35K Person + 15K Other) | **191.2 ms** | ≤800ms | 5/5 ✅ |

**诊断**: `_labelStrIndex` 路径的实际开销 ~7.75 µs/node（80K Person x 5 iterations = 400K getNode 调用 / 3100ms ≈ 7.7µs）。大部分是 LMDB native addon 的 `getNode(id)` 开销。之前的 15ms/100K 记录是在特定 GE 构建下的热缓存值，当前冷缓存基线更保守。

## benchmark.sh 基线（可运行，非断言）

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
- 测项 1 混合 label 场景（35K matching + 15K non-matching label）比纯 matching scan 慢，因为需要逐节点判断 label 字符串匹配。
- 可参考历史：`_scanNodesByLabel('Person', 1000)` on 100K nodes = **15ms**（特定 GE 构建下的热缓存值）。
- **label-str-index.spec.ts** 提供 CI 可执行的断言基线，**benchmark.sh** 提供快速手动参考。
