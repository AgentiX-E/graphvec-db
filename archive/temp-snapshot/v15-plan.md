# V15: 无 spec 模块全覆盖计划

创建时间: 2026-06-03 16:45

## 目标
对代码库中所有 export 业务函数/类实现完整的单元测试覆盖。

## Phase A: ✅ 已全部完成 — 7 specs, 104 tests
- [x] A1: backup-helpers.spec.ts — 25/25 ✅
- [x] A2: tenant-manager.spec.ts — 29/29 ✅ (fix: _removeAllTenantAcls)
- [x] A3: bfs.spec.ts + dfs.spec.ts — 7/7 + 7/7 ✅
- [x] A4: dijkstra.spec.ts — 7/7 ✅
- [x] A5: pagerank.spec.ts — 11/11 ✅ (含多线程 2/4 线程)
- [x] A6: closeness.spec.ts — 6/6 ✅
- [x] A7: pagerank-stream.spec.ts + bfs-stream.spec.ts — 6/6 + 6/6 ✅

## Phase B: ✅ 已全部完成 — 2 specs, 28 tests
- [x] B1: event-bus.spec.ts — 已有 event-bus-edge + event-bus-live specs (跳过)
- [x] B2: lmdb-wal.spec.ts — 15/15 ✅ (fix: _deleteBefore LMDB range)
- [x] B3: grpc-server.spec.ts — 已有 grpc.spec.ts 12 tests (跳过)

## Phase C: ✅ 已全部完成 — 13 tests
- [x] C1: outbox-replication.spec.ts — 13/13 ✅ (OutboxV2 CRUD/PerPeerWorker/Manager)

## 生产代码 bug 修复
1. _removeAllTenantAcls: 遍历所有角色删除 ACL (之前只删 '*' 角色)
2. _deleteBefore (lmdb-wal): LMDB getRange start 参数用 0 而非 -Infinity

## 总结
- **新增 specs**: 10 (9 + 1 内部合并)
- **新增 tests**: 117 (104 + 13)
- **V14i+V15 合计**: 181 tests (64 V14i + 117 V15)
- **V14 累计**: 131 + 181 = 312 tests
