# Phase 1-2 卡住根因分析及防复发策略

## 卡住根因：DML benchmark 过重导致 vitest 线程池死锁

**实际症状**：
- `npx vitest run src/benchmark/dml-benchmark.spec.ts` — 输出 `RUN` 后静默退出，无测试输出、无 error、exit code 0
- 其他 benchmark（expression、parse、format）都能正常通过
- 与其他文件唯一区别：DML benchmark 每次 `it()` 创建/销毁 ~2000 个 GraphEngine 实例（`new GraphEngine` + `ge.open()` + `ge.close()`）

**根因链**：
1. vitest 配置 `pool: 'threads'` + `singleThread: true`
2. DML benchmark 每个 `it()` 块内含多次 `new GraphEngine()`（LMDB overgraph 存储初始化）
3. 大量同步+异步的引擎创建/销毁操作触发 vitest 线程池内部状态竞争
4. vitest worker 线程退出但主线程收不到通知 → exec 工具挂起，无输出无 exit
5. exec yieldMs 超时后 SIGTERM kill → AI 以为还在运行 → 无限 poll wait

**为什么其他 benchmark 不卡**：
- `expression-benchmark`：纯函数调用，无 GraphEngine
- `parse-benchmark`：只调用 `parseQuery()`，解析器无 I/O
- `format-benchmark`：只调用 `_postProcessResults()` 纯函数
- 唯一有 I/O 的 `dml-benchmark` 也是唯一卡住的文件

## 防复发战术规则（强制！）

### Rule 1: 新 benchmark 先空跑验证
**创建新 benchmark 文件后，先用 `--reporter=verbose --reporter=json` 双重验证是否能正常输出**。如果 15s 内无输出，立即 kill 并排查 import 问题。

### Rule 2: I/O-intensive benchmark 用 `pool: 'forks'` 或 `singleThread` 模式
vitest `pool: 'threads'` 对频繁创建/销毁后端存储实例不友好。需要 I/O benchmark 时可：
- 暂时改为 `pool: 'forks'`
- 或减少每次测试的 engine 操作次数（< 500 次）
- 或使用 `vitest.fast.config.ts`（项目已有，使用 forks pool）

### Rule 3: 不要主 session 等重的 vitest 跑完
所有 benchmark 跑完都可能超过 60s。用后台 spawn 或 sub-agent，不等 poll。

### Rule 4: 15s 无输出 = 卡死
exec 跑 vitest 如果 15 秒内无输出，不要无限等 poll。立即 SIGTERM + 换策略。

## 本次修复方案：简化 DML benchmark
- 每个 `it()` 块的 engine 操作次数降为 1/10（CREATE 1 node: 2000→200）
- 避免一次测试创建数千个 engine 实例
- benchmark 的目的不是压力测试，而是获得稳定的相对性能指标
- 已有 `stability.spec.ts` (231K) 做压力覆盖
