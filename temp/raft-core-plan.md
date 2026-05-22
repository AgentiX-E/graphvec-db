# RaftCore 固化共识实现 + WAL 持久化 - 执行计划

创建时间: 2026-05-22 15:20

## 目标

创建 Transport 接口层、WAL 持久化、RaftCore 固化共识类，将共识从"可插拔组件"变为"固化的基础设施"。

## 步骤

- [x] 步骤1: 阅读现有代码，理解设计
- [x] 步骤2: 创建 `src/consensus/transport.ts` — Transport 接口 + MockTransport
- [x] 步骤3: 创建 `src/consensus/wal.ts` — WAL 持久化
- [x] 步骤4: 创建 `src/consensus/raft-core.ts` — RaftCore 固化类
- [x] 步骤5: 修改 `src/consensus/simulated-raft.ts` — 别名导出
- [x] 步骤6: 创建测试文件 `raft-core.spec.ts` (7 tests)
- [x] 步骤7: 创建 WAL 测试文件 `wal.spec.ts` (9 tests)
- [x] 步骤8: 验证 — tsc --noEmit + jest 测试通过

## 当前进度

✅ 全部完成
