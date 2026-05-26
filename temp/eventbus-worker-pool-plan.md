# EventBus WorkerPool 多进程架构 - 执行计划

创建时间: 2026-05-26 19:56

## 目标

实现 EventBusWorkerPool 类，通过 child_process.fork() 将 ZMQ DEALER socket 管理分散到 N 个子进程，解决单事件循环中 ≥50 peer 时的性能瓶颈。

## 关键约束

- ZMQ socket 必须在 fork 之后各自创建（子进程各自 new zmq context）
- 一致性 hash 分配 peer → worker
- 子进程通过 LMDB mmap 只读读取 ACK 状态
- 不修改 TransportMessage、EventBusConfig 接口
- 不修改现有测试文件
- ROUTER socket 保留在主进程

## 步骤

- [x] 步骤1: 理解现有代码结构 (event-bus.ts, outbox-replication.ts, zmq mock)
- [ ] 步骤2: 创建 `src/core/event-bus-worker-process.ts` — 子进程入口
- [ ] 步骤3: 修改 zmq mock 以支持子进程（fork 兼容）
- [ ] 步骤4: 创建 `src/core/event-bus-worker-pool.ts` — worker pool 主进程管理
- [ ] 步骤5: 集成到 EventBus（event-bus.ts 修改）
- [ ] 步骤6: 创建 `src/core/event-bus-worker-pool.spec.ts` — 测试
- [ ] 步骤7: 运行测试验证

## 当前进度

已完成 ✅

### 测试结果

**58/58 测试通过**，包含：
- `event-bus-edge.spec.ts` — 16/16 ✅
- `event-bus.live.spec.ts` — 5/5 ✅  
- `multi-leader-replication.spec.ts` — 10/10 ✅
- `multi-leader-edge.spec.ts` — 7/7 ✅
- `outbox-peerdb.spec.ts` — 6/6 ✅
- `event-bus-worker-pool.spec.ts` (新) — 14/14 ✅
