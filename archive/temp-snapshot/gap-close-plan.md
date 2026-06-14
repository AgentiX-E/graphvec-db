# Gap Close Plan — 全速推进闭包

## 目标
关闭深度审查中识别的所有 GAP（P0:9项 + P1:12项 + P2:9项），通过全量验收测试。

## 执行策略

优先级: 顺序执行（大部分有代码依赖），可并行项通过 sub-agent 并行

### Phase 1: P0 快速修复（无依赖项可并行）

| 项 | 文件 | 工作量 | 并行组 |
|:--|:-----|:------:|:------:|
| P0-5 Fluent优化器默认开启 | `fluent.ts` | 0.5天 | A |
| P0-9 跨分片await修复 | `graph-algorithms.ts` | 0.5天 | A |
| P0-3 RangeIndex → sorted-btree | `range-index.ts` | 0.5天 | A |
| P0-1/8 备份冻结+显式事务 | `backup.ts` + `rest.ts` | 1天 | B(依赖图存储) |
| P0-2 索引持久化 | `label-engine.ts` | 2天 | B |
| P0-4 PageRank O(V²) → CSR | `pagerank.ts` | 1天 | C |
| P0-6 变长路径 | `query-engine.ts` | 1-2天 | C |
| P0-7 参数化查询 | query引擎 | 1天 | C |

### Phase 2: P1修复

| 项 | 文件 | 工作量 | 并行组 |
|:--|:-----|:------:|:------:|
| P1-1 废弃wal.ts | remove + test | 0.5天 | D |
| P1-2 JS层_nodeIds删除 | `graph-engine.ts` | 0.5天 | D |
| P1-8 2PC协调者WAL | `cross-shard-tx.ts` | 1天 | E |
| P1-9 JWT认证 | `auth.ts` | 1天 | E |
| P1-11 betweenness shift修复 | `betweenness.ts` | 0.5天 | D |
| P1-12 Louvain Phase2 | `louvain.ts` | 1天 | F |

### Phase 3: P2优化

剩余小而独立的优化项。

### Phase 4: 全量验收测试

- 确保所有新测试加入 vitest 配置
- 执行 `npx vitest run` 全量测试
- 修复 flaky + 失败

### Phase 5: 最终深度审查

- 对比代码 vs 审计报告/vs 设计文档
- 标记已关闭 gap
- 最终总结

## 金规
- 每个修改必须附带测试
- 不能降低现有测试通过率
- 复杂项先用 sub-agent 分析再改
- 每完成一个 Phase 提交一次
