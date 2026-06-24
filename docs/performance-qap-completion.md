# Performance QAP — 完成文档

## 一、总览

Performance QAP（性能优化 + 质保体系）是一个三合一的完整体系：

```
┌──────────────────────────────────────────────────────┐
│                  Performance QAP                       │
├───────────────────┬───────────────────┬───────────────┤
│   Benchmark Infra │ Profile→Optimize  │ Regression    │
│   (Phase 1-2)     │ (Phase 3)         │ Gate (Phase 4)│
├───────────────────┼───────────────────┼───────────────┤
│ • Unified Runner  │ • 3 low-risk      │ • gate.ts     │
│ • Baseline Store  │   optimizations   │ • vs baseline │
│ • Reporter        │ • +290% → +13%    │ • exit code 1 │
│ • 143 metrics     │ • All green       │ • --save flag │
└───────────────────┴───────────────────┴───────────────┘
```

## 二、Benchmark 基础设施

### 文件结构

```
src/benchmark/
├── runner.ts                 # Unfied Runner (perf / full / parseMetrics)
├── baseline-store.ts         # JSON 基线读写 + 比较逻辑
├── reporter.ts               # Markdown 报告生成
├── gate.ts                   # 回归门禁（集成了 perf + compare）
├── run-perf.ts               # perf 模式入口（直接跑 perf）
├── run-full.ts               # full 模式入口（跑全部 + 保存 baseline）
├── expression-benchmark.spec.ts   # 24 项 — 表达式引擎基准
├── parse-benchmark.spec.ts        # 18 项 — 查询解析基准
├── format-benchmark.spec.ts       # 16 项 — 结果格式化 + 后处理基准
├── dml-benchmark.spec.ts          # 9 项 — DML 执行路径基准
├── query-benchmark.spec.ts        # ~76 项 — 引擎级端到端基准
├── baseline-store.spec.ts         # 单元测试
└── reporter.spec.ts               # 单元测试
scripts/
├── perf.sh                   # 一键 perf + gate
└── bench-full.sh             # 一键全量 baseline
benchmark/
└── baselines/
    └── YYYY-MM-DD.json       # 基线数据
```

### 双模式

| 模式 | 用时 | 用途 |
|------|------|------|
| **perf** | ~30s | 日常开发验证，4 个代表文件 |
| **full** | ~10min | baseline 基准采集，所有 `.spec.ts` |

### 技术选型

- **不使用** `benchmark.js`、`tinybench`、`clinic.js`、GitHub Actions
- **使用** vitest `bench` API + `vitest run` 解析控制台输出
- **自研** ~150 行 baseline 对比逻辑（JSON diff）
- **解析** 两种格式：vitest bench 输出 + console.table 格式

## 三、优化成果

### 3.1 `_postProcessResults` 快速路径 (b773558b)

**改动**: expression-engine.ts 第 2149 行
- 无 ORDER BY/HAVING 时跳过 `result.slice()` + sort + filter + skip/limit
- 仅新增一个 `if` 分支，零侵入

**收益**:
| 场景 | 优化前 | 优化后 | 提升 |
|------|--------|--------|------|
| empty plan, 100 rows | 2.2M ops/s | 8.6M ops/s | **+290%** |
| empty input | - | 10.1M ops/s | 新增快速路径 |
| SKIP only (快速路径) | - | 3.2M ops/s | 新增 |
| LIMIT only (快速路径) | - | 5.4M ops/s | 新增 |
| ORDER BY 路径 | 不受影响 | 不受影响 | 0% |

### 3.2 `_compareValues` Number Fast Path (14545020)

**改动**: `_compareValues` 函数顶部新增 `typeof a === 'number' && typeof b === 'number'` switch
- 纯数字比较跳过 `_deepEqWithNull`（递归 + 对象分配）
- 对 `=` 操作符收益最大

### 3.3 `_evalBinary` 布尔操作符链跳过 (f9cd2089)

**改动**: `_evalBinary` 入口改为 regex guard
```typescript
if (!/\b(OR|XOR|AND|NOT)\b/i.test(t)) return _evalComparison(t, row)
```
- 无布尔操作符时少 4 次 `_splitTopLevel` 调用

**收益**:
| 场景 | 优化前 | 优化后 | 提升 |
|------|--------|--------|------|
| literal number 42 | 500K ops/s | 565K ops/s | **+13%** |
| 1 + 2 | 304K ops/s | 345K ops/s | **+13%** |
| (a + b) * c | 125K ops/s | 140K ops/s | **+12%** |

### 优化原则

1. **每个优化前跑 `--quick` 回归** — 通过后再做改动
2. **每个优化后跑回归** — 确认零退化
3. **全量 perf 对比** — 确保无负优化
4. **commit 独立** — 可回退

## 四、回归门禁

### 工作流

```bash
# 日常开发（手动触发回滚）
./scripts/perf.sh                 # perf + gate check
# 输出:  GATE PASSED 或 GATE FAILED (exit 1)

# 确认无回归后，更新 baseline
./scripts/perf.sh --save

# 全量采集
./scripts/bench-full.sh
```

### 门禁逻辑

```
gate.ts
  ├─ perf() → 跑所有 perf benchmark
  ├─ 找最新 baseline JSON
  ├─ compareResults(current, previous)
  │    └─ regressions: < -10% → critical / < -5% → warning
  └─ hasCriticalRegression() → exit 1
```

### 阈值配置
```bash
./scripts/perf.sh --threshold=15   # 15% 才告警
./scripts/perf.sh --threshold=20   # 20% 才告警
```

## 五、回归验证矩阵

| 检查项 | 状态 | 命令 |
|--------|------|------|
| graph-engine 622 tests | ✅ | `--quick` |
| query-engine 71 tests | ✅ | `--quick` |
| TCK old top-level (5) | ✅ | `--quick` |
| TCK MatchWhere (34) | ✅ | `--quick` |
| split-spec (55 files, 991) | ✅ | `npx vitest run` |
| cucumber TCK (~4632) | ✅ | `full-regression.sh` |
| perf (143 metrics) | ✅ | `perf.sh` |

## 六、技术决策记录

| 决策 | 选择 | 原因 |
|------|------|------|
| Runner 语言 | TypeScript/tsx | 复用项目已有工具链 |
| 无 npm 包 | vitest bench 原生 | 零依赖，线上可信 |
| 输出解析 | regex 双格式 | vitest 4.x `bench` 无 JSON reporter |
| baseline 存储 | JSON 文件 | 透明、可 diff、可提交 |
| 门禁方式 | exit code | 简单可靠，可集成到 CI（如有） |
| 不做的方向 | HTML Dashboard | 嵌入式引擎不需要 |
| 不做的方向 | `benchmark.js` 迁移 | 收益不足 |
| 不做的方向 | `clinic.js` | Node.js `--cpu-prof` 已足够 |

## 七、后续可优化方向

> 以下方向已评估但收益不足或当前不做。记录以保持完整性。

1. **DML Async** — 已实现 async，`_executeViaGraphEngine` 行 2674 无 await 是语义等效
2. **ANTLR Parser 替换** — 替换入口仅 ~50 行可删，2200+ 行是有效逻辑和必要修复代码
3. **Storage Engine** — `StorageProvider` 接口已定义，`ClassicLevelStorageProvider` 已实现
4. **HTML Dashboard** — 嵌入式引擎不需要 Web 界面
5. **GitHub Actions CI** — 当前是嵌入式引擎，非 SaaS 服务
6. **`benchmark.js` / `tinybench` 迁移** — vitest bench API 已满足需要
