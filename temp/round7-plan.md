# Round 7 — 全量 Gap 关闭执行计划

**创建**: 2026-05-29 07:25
**目标**: 关闭全部 11 项 P0/P1 Gap（Step 1~5 闭环）
**当前 HEAD**: `76b7022f` — Round 6 Step 2

## 11 项 Gap 分组（依赖分析）

### 无冲突可并行组

| 组 | 项 | 文件 | 估算 |
|:--|:---|:-----|:----:|
| **A-1: ACID 事务增强** | P0-1 事务 SSI + 版本链 + 死锁检测 | transaction.ts + spec | 2d |
| **A-2: InstallSnapshot 自动化** | P0-2 log compaction→snapshot→recovery | raft-logic-consensus.ts | 1.5d |
| **A-3: fsync 默认策略+ Raft联动** | P0-3 默认 every-n + Raft commit 联动 | segment-stream-wal.ts, raft-core.ts | 0.5d |
| **A-4: 流式快照** | P0-4 StorageProvider 分块 + 原子操作 | overgraph-storage.ts, storage-provider.ts | 1d |
| **B-1: 查询优化器 CBO** | P1-1 StatsCollector→planner 集成 | query-planner.ts, stats-collector.ts | 2d |
| **B-2: 基准测试套件+LDBC** | P1-5 benchmark 框架 | test/benchmark/ | 2d |
| **C-1: 全文索引持久化** | P1-7 MiniSearch WAL 恢复 | search/fulltext.ts | 0.5d |
| **C-2: 热分片+自动再平衡** | P1-2 QPS 统计 + 负载迁移 | shard-health.ts, rebalancer.ts | 1d |
| **C-3: 跨 DB 查询路由** | P1-3 DatabaseManager 联邦查询 | rest.ts, database-manager.ts | 1d |
| **C-4: 自动墓碑清理** | P1-6 setInterval 自动 GC | database-manager.ts | 0.5d |
| **C-5: 算法流式模式** | P1-4 BFS/DFS/PageRank 流式批处理 | algorithms/*.ts | 1.5d |

### 依赖关系
- A-3 (fsync 联动) 依赖 A-2 (raft snapshot) 先完成 → 顺序执行
- B-1 (CBO) 依赖 StatsCollector 已存在 → 无阻塞
- B-2 (benchmark) 独立 → 并行
- C-1~C-5 全部独立 → 并行

### 冲突检测
- **A-1** vs **B-1**: 无冲突（不同文件）
- **C-2** vs 现有 shard 代码: `shard-health.ts` 单独文件，无冲突
- **C-3** vs 现有 rest.ts: 新增路由端点，需检查中间件顺序

## Step 流程
1. **Step 1**: 文档同步（所有 11 项写入审计/技术设计/进度追踪）
2. **Step 2**: 并行 Gap 关闭（A/B/C 组并行，组内可能顺序）
3. **Step 3**: 深度审查
4. **Step 4**: 迭代
5. **Step 5**: 总结报告
