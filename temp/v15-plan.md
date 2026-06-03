# V15: 无 spec 模块全覆盖计划

创建时间: 2026-06-03 16:45

## 目标
对代码库中所有 export 业务函数/类实现完整的单元测试覆盖。

## Phase A: 短平快模块（8 specs, ~100 tests）
- [ ] A1: backup-helpers.spec.ts — 纯函数 8 exports, 272 行
- [ ] A2: tenant-manager.spec.ts — 安全层核心, 268 行
- [ ] A3: bfs.spec.ts + dfs.spec.ts — 小算法模块
- [ ] A4: dijkstra.spec.ts — 中等成熟算法
- [ ] A5: pagerank.spec.ts — 302 行的主流算法
- [ ] A6: closeness.spec.ts — 图论中心性
- [ ] A7: pagerank-stream.spec.ts + bfs-stream.spec.ts — 流式版本

## Phase B: 中大型模块（3 specs, ~60+ tests）
- [ ] B1: event-bus.spec.ts — 970 行核心事件总线
- [ ] B2: lmdb-wal.spec.ts — 206 行共识 WAL
- [ ] B3: grpc-server.spec.ts — 388 行（需要 mock gRPC server）

## Phase C: 巨型模块（1-2 specs, ~50 tests）
- [ ] C1: outbox-replication.spec.ts — 1530 行
  - 拆分为 Outbox / OutboxV2 / PerPeerWorker / OutboxReplicationManager 子块

## 当前进度

Starting Phase A1: backup-helpers.spec.ts
