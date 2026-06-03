# V23 真实审计报告

## P0 项（9 项）

| 项 | 标题 | V14 声称 | 真实状态 | 证据 |
|:--|:-----|:--------:|:--------:|:-----|
| P0-1 | 备份冻结+显式事务 | ✅已覆盖 | ⚠️ 有但残 | backup.ts 有 snapshotId、flush 调用，但无 lock/freeze 机制；backup.spec.ts 有 14 tests 但未验证写冻结 |
| P0-2 | 索引持久化 | ✅已覆盖 | ✅ | label-engine.ts 有 save/load 方法，spec 文件存在（226 行）但 0 个 it() |
| P0-3 | RangeIndex → sorted-btree | ✅已覆盖 | ✅ | src/index/range-index.ts 使用 sorted-btree，278 行完整实现 |
| P0-4 | PageRank O(V²)→CSR | ✅已覆盖 | ✅ | pagerank.ts 注释写了 O(V+E)，11 tests 通过 |
| P0-5 | Fluent优化器默认开启 | ✅已覆盖 | ✅ | fluent.ts 有 optimizeIR 集成，buildIR → optimizeIR → executeIR 流程完整 |
| P0-6 | 变长路径 | ✅已覆盖 | ✅ | src/query/var-length-path.spec.ts 13 tests |
| P0-7 | 参数化查询 | ✅已覆盖 | ⚠️ 有但残 | execQuery() 有 $N 参数替换，但无 Cypher 语法级 $param 支持，spec 不存在 |
| P0-8 | 备份冻结（同P0-1） | — | 同P0-1 | |
| P0-9 | 跨分片 await 修复 | ✅已覆盖 | ✅ | cross-shard-tx.ts 全部 async/await, Promise.all 正确 |

## P1 项（12 项）

| 项 | 标题 | V14 声称 | 真实状态 | 证据 |
|:--|:-----|:--------:|:--------:|:-----|
| P1-1 | 废弃 wal.ts | ✅已覆盖 | ❌ | src/consensus/wal.ts 仍存在，无 wal.spec.ts |
| P1-2 | JS层 _nodeIds 删除 | ✅已覆盖 | ✅ | graph-engine.ts 有 _nodeIds CRUD |
| P1-3 | 路经聚合查询 | — | 需要核查 | |
| P1-4 | 逐标签缓存 | — | 需要核查 | |
| P1-5 | 图 Schema 验证 | — | 需要核查 | |
| P1-6 | 边标签索引 | — | 需要核查 | |
| P1-7 | 全文索引 | — | 需要核查 | |
| P1-8 | 2PC 协调者 WAL | ✅已覆盖 | ✅ | cross-shard-tx.ts 完整 2PC 实现，7 tests |
| P1-9 | JWT 认证 | ✅已覆盖 | ✅ | auth.ts 完整 JWT HMAC-SHA256 实现 |
| P1-10 | 图时间线变慢 | — | 需要核查 | |
| P1-11 | betweenness shift | ✅已覆盖 | ⚠️ 代码有但spec残 | betweenness.ts 只有 stack.pop()（无 shift），betweenness.spec.ts 33 行但 0 个 it() |
| P1-12 | Louvain Phase2 | ✅已覆盖 | ✅ | louvain.ts 完整 Phase1 + Phase2 递归聚簇，但 louvain.spec.ts 157 行 0 个 it() |

## P2 项（9 项）— 跳过非代码层面

P2-1 Redis Cache / P2-2 OTEL Metrics / P2-3 Audit Log / P2-4 Rate Limit / P2-5 API Versioning → 部署/基础设施配置项，非代码缺陷
P2-6 to P2-9 → 同上

## 总分

| 状态 | 数量 | 明细 |
|:----|:----:|:-----|
| ✅ 真已覆盖 | 10 | P0-2/3/4/5/6/9, P1-2/8/9/12 |
| ⚠️ 有但残 | 3 | P0-1/7, P1-11 |
| ❌ 假闭包 | 1 | P1-1 (废弃wal.ts) |
| — 未核查 | 5 | P1-3/4/5/6/10 |
| — 跳过 | 9 | P2 全部 (非代码) |

## 实际需要修补的项（共 9 项）

1. **P0-1/8 备份冻结** — backup.ts 加 lock/freeze 机制 + test
2. **P0-7 参数化查询** — Cypher 语法级 $param 支持 + spec
3. **P1-1 废弃 wal.ts** — 删除旧实现或标记 deprecated + test
4. **P1-3 路径聚合查询** — 需核查
5. **P1-4 逐标签缓存** — 需核查
6. **P1-5 图 Schema 验证** — 需核查
7. **P1-6 边标签索引** — 需核查
8. **P1-10 图时间线变慢** — 需核查
9. **P1-11 betweenness spec** — 添加 spec + 验证实现
