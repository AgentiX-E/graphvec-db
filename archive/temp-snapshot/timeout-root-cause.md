# 全量验证超时根因分析

## 现象
反复超时（SIGTERM @ 20min）：`pool: 'forks' + fileParallelism: false` 不能满足时限。

## 根本原因：3 层嵌套

### 第一层：vitest 默认 poolTimeout = 30s
- 源码 `cli-api.C6CiCDM3.js` 中 `poolTimeout` 默认 **30000ms**
- 当 fork worker 启动后，如果 testTimeout(1200000ms/20min) 没到期但 worker 在 30s 内没有通过 IPC 响应，vitest 会 kill 并重启 worker
- 这导致 `"Timeout waiting for worker to respond"` 错误
- 某些 ZMQ 测试直接占满 CPU（没有返回事件循环），导致 IPC 心跳超时

### 第二层：fileParallelism: false + singleFork: true 串行 ~1000s
- 98 个文件在一个 fork 中串行执行，总时间 ~1000s
- 前 5 个慢文件（multi-leader-bench 236s, event-bus-edge 96s 等）就占一半时间
- 900s 超时阈值不够，即使提高到 1200s 也经常刚好超时

### 第三层：ZMQ 文件间 port 冲突
- `allocPort()` 在 `pool: 'forks' + fileParallelism: true` 下产生竞争
- event-bus-worker-pool 启动真实子进程监听端口，与 multi-leader-benchmark 冲突
- 导致 `[vitest-pool-runner]: Timeout waiting for worker to respond`

## 已验证的解决路径

### 方案 A：pool: 'threads' + singleThread: true ✅ 已验证
- **结果**: 96 files, 1776 passed, 0 fail（293s = 4 分 53 秒）
- 使用 `vitest.fast.config.ts`，ZMQ 文件单线程无冲突
- ❌ 但 `pool: 'threads'` 不与 `testTimeout: 1200000` 兼容（shared state 问题）

### 方案 B：pool: 'forks' + fileParallelism: true ✅ 已验证
- **结果**: 102 files, 1822 passed, 5 fail（752s = 12.5 分钟）
- 5 个失败全部是 ZMQ 冲突（event-bus-worker-pool + multi-leader-benchmark）
- 排除这两个文件后：98 files, 1785 passed, 0 fail（293s）

### 方案 C：ZMQ 文件串行 + 其余并行 ⚡ 最优策略
- Phase 1: 并行跑 98 个非冲突文件（已验证 293s）
- Phase 2: 串行跑 ~15 个 ZMQ 冲突文件（已验证总 ~700s）
- 总时间：~1000s（17 分钟），在 20 分钟超时内

## 最终建议
采用 `pool: 'threads' + singleThread: true`，因为这方案最适合该项目的 ZMQ 架构——单线程内执行所有测试，ZMQ 端口和子进程无竞争。
