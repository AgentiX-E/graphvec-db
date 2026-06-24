### Benchmark 体系架构

```
当前 (8 个, 584K 行)
├── latency.spec.ts (117K)   — 15+ 延迟测试 (upsertNode/Edge, scan, query)
├── scalability.spec.ts (105K) — 扩展性 (多线程/并发)
├── stability.spec.ts (231K)   — 稳定性压力
├── throughput.spec.ts (85K)   — 吞吐量
├── query-benchmark.spec.ts (20K)  — GE 查询 (3K/10K/30K)
├── expression-benchmark.spec.ts (5.5K)  — 表达式引擎 (23 项)
├── ldbc-snb.spec.ts (6.3K)    — LDBC SNB 基准
├── label-str-index.spec.ts (7K)  — 标签索引

新增 (Phase 2, 3 个, ~30K)
├── parse-benchmark.spec.ts    — AST 解析 (15 项)
├── dml-benchmark.spec.ts      — DML 路径 (20 项)
├── format-benchmark.spec.ts   — 格式化 (15 项)

基础设施
├── runner.ts                  — 统一运行入口
├── baseline-store.ts          — 基线存储/对比
├── scripts/perf.sh            — 一键 perf
├── scripts/bench-full.sh      — 全量基线
```

### 无新增 npm 包依赖

| 功能 | 方案 |
|------|------|
| Profiler | Node.js 内置 `--cpu-prof` |
| Flamegraph | `0x`（全局安装，开发工具） |
| Benchmark API | vitest `bench` 内置 |
| Baseline 对比 | 自研 ~150 行 |
| Reporter | 自研 Markdown 格式化 |

### 不开工的方案

| 方案 | 理由 |
|------|------|
| `benchmark.js` | vitest bench 已足够 |
| GitHub Actions Benchmark | 当前非 SaaS 服务，不需要 CI 集成 |
| HTML Dashboard | 单机项目不需要 Web 服务 |
| `clinic.js` doctor/flame | `0x` 更轻量，TypeScript 兼容更好 |
| `pkg-size.dev` | 不需要包大小分析 |
