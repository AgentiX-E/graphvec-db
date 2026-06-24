# agentiX-graphvec — 性能优化与质保体系 设计方案

> 版本: 1.0
> 日期: 2026-06-24
> 作者: 云仔

---

## 0. 现状全景

### 项目规模
- **TypeScript 代码**: 255,980 行（含测试）
- **核心模块**:
  - `graph-engine.ts`: 3,454 行 — 底层图引擎（节点/边 CRUD、索引、遍历）
  - `query-engine.ts`: 7,331 行 — Cypher 查询编排（解析→执行→后处理）
  - `expression-engine.ts`: 2,216 行 — 表达式求值纯函数
  - `ast-to-plan-v2.ts`: 2,323 行 — ANTLR Cypher → QueryPlan 转换
  - `api/rest.ts`: 2,678 行 — REST API 服务层
  - `api/query-planner.ts`: 1,816 行 — 查询计划器
  - `search/fulltext.ts`: 1,260 行 — MiniSearch 全文索引
  - `core/outbox-replication.ts`: 1,530 行 — 日志复制
  - `core/transaction.ts`: 649 行 — 事务管理器
  - `core/event-bus.ts`: 970 行 — 事件总线

### 已完成的架构优化（Phase 24-29）
- `query-engine.ts` 从 9,615 → 7,308 行（-2,307 行），提取 4 个独立模块
- `expression-helpers.ts` 寄存器模式已消除
- 索引/约束文件持久化（`.opengraph/` JSON 自动恢复）
- 23 项表达式引擎性能基准
- TCK 全量 ~4,630 场景 100% 通过

### 现有 benchmark 覆盖
| 文件 | 行数 | 覆盖领域 |
|------|------|----------|
| `latency.spec.ts` | 117K | 15+ 延迟测试（upsertNode/Edge, scan, query, vector） |
| `scalability.spec.ts` | 105K | 扩展性测试（多线程/并发） |
| `stability.spec.ts` | 231K | 稳定性压力测试 |
| `throughput.spec.ts` | 85K | 吞吐量测试 |
| `query-benchmark.spec.ts` | 20K | GE 查询性能（3K/10K/30K 节点规模） |
| `expression-benchmark.spec.ts` | 5.5K | 表达式引擎（23 项指标） |
| `ldbc-snb.spec.ts` | 6.3K | LDBC SNB 基准查询 |
| 合计 | 584K | 8 个 benchmark 文件 |

---

## 1. 两个方向的统一设计

两个方向：
1. **性能优化** — 基于现有 benchmark 数据做 profile → 优化 → 量化对比
2. **质保体系** — 建立可重复的 benchmark 基线 + 回归门禁 + 性能 dashboard

### 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                      Performance QAP                         │
│                (Quality Assurance Pipeline)                  │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────────┐    ┌──────────────────────────┐     │
│  │   Benchmark Runner   │    │    Benchmark Reporter    │     │
│  │                     │    │                          │     │
│  │  • perf run         │    │  • baseline compare      │     │
│  │  • full run         │    │  • regression detection  │     │
│  │  • quick smoke      │    │  • markdown report       │     │
│  └─────────┬───────────┘    └───────────┬──────────────┘     │
│            │                            │                    │
│  ┌─────────▼────────────────────────────────▼──────────┐     │
│  │              Benchmark Collection                    │     │
│  │                                                      │     │
│  │  ┌──────────┐  ┌───────────┐  ┌────────────────┐   │     │
│  │  │ Graph    │  │ Expression│  │ Query Pipeline │   │     │
│  │  │ Engine   │  │ Engine    │  │ (parse→exec→   │   │     │
│  │  │ (GE)     │  │ (EE)      │  │  post-process) │   │     │
│  │  └──────────┘  └───────────┘  └────────────────┘   │     │
│  │                                                      │     │
│  │  ┌──────────┐  ┌───────────┐  ┌────────────────┐   │     │
│  │  │ Cypher   │  │ Fulltext  │  │ Latency/       │   │     │
│  │  │ Queries  │  │ Search    │  │ Throughput     │   │     │
│  │  │ (TCK+)   │  │           │  │                │   │     │
│  │  └──────────┘  └───────────┘  └────────────────┘   │     │
│  └─────────────────────────────────────────────────────┘     │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │              Profiling Pipeline                       │    │
│  │  ┌────────┐  ┌──────────┐  ┌──────────┐  ┌──────┐  │    │
│  │  │Node.js │→│ Identify │→│ Optimize  │→│Verify│  │    │
│  │  │Profiler│  │Hot Spots │  │(targeted) │  │(bench)│  │    │
│  │  └────────┘  └──────────┘  └──────────┘  └──────┘  │    │
│  │  每发现一个热点，迭代一个完整的优化循环                    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 设计原则

1. **现存量测基础设施优先** — 已有 584K benchmark 代码，先充分利用而不是推倒重来
2. **增量优化** — 每次只改一个热点，量化验证后提交
3. **回归检测** — 每次提交运行 baseline comparison，性能退化 >=5% 做标记
4. **可重复** — 所有 benchmark 都是纯 vitest，单命令可复现
5. **可扩展** — 新的 benchmark 统一继承 Runner 接口

---

## 2. 功能设计和拆解

### 2.1 Benchmark 统一 Runner（后端，`src/benchmark/` 中新增模块）

**功能**: 统一的 benchmark 运行器，支持 `perf`（快速烟雾测试）、`full`（全量基线）模式

**技术选择**:

| 候选 | 选择 | 理由 |
|------|------|------|
| `tinybench` | ❌ | 增加新依赖，vitest bench 已集成 |
| `mitata` | ❌ | 不活跃，不兼容 vitest |
| vitest `bench` API | ✅ | 零依赖，已集成，支持 `--reporter=json` |
| 自研 Runner | ✅（补充） | vitest bench 不支持 baseline 对比和回归检测，需要薄的封装层 |

**自研组件**:
- `src/benchmark/runner.ts` — 统一运行入口
  - `perf()` — 选 3-5 个代表性测试，快速验证（~30s）
  - `full()` — 所有 benchmark 全量运行（~10min）
  - `compareBaseline(baselinePath)` — 与历史基线 JSON 对比
- `src/benchmark/baseline-store.ts` — 基线存储/加载（JSON 格式，git 跟踪）

**不选更重方案的理由**:
- GitHub Action Benchmark 需要 CI 绑定，超标
- `benchmark.js` 太重量级
- 现有 vitest bench API 足够覆盖核心需求

**验收条款**:
- TB1: `npx tsx src/benchmark/runner.ts perf` 输出 JSON 基线文件
- TB2: `npx tsx src/benchmark/runner.ts full` 跑完全部 8 个 benchmark，输出基线
- TB3: 两次运行同一条件下结果误差 < 5%
- TB4: 人为插入 50ms sleep 后 baseline comparison 检测到退化

### 2.2 Baseline 对比 + 回归检测（后端，`src/benchmark/` 中新增）

**功能**: 将当前运行结果与 git 跟踪的基线文件做对比，输出回归报告

**自研理由**: 
- GitHub Actions 不适合嵌入式引擎
- 现有 OSS 方案（`vitest-benchmark-reporter`）不支持自定义对比逻辑
- 核心逻辑只有 ~150 行：JSON diff + 百分比计算 + markdown 格式化

**验收条款**:
- RD1: baseline 对比输出 Markdown 表格，包含 change% 和是否退化
- RD2: >=5% 退化标注 ⚠️，>=10% 标注 🔴
- RD3: 退化检测结果可通过 exit code 暴露（0=无退化，1=有退化）
- RD4: baseline 文件通过 git 跟踪，支持版本间对比

### 2.3 Profile 驱动优化循环（后端，手工操作 + 脚本辅助）

**功能**: 识别热点 → 优化 → 验证的迭代流程

**工具链**:
- Node.js `--prof` / `--cpu-prof` — 内置 profiler，零依赖
- `0x`（npm 包）— flamegraph 可视化（`npm install -g 0x`）
- vitest benchmark — 优化前后量化对比

**不选 cloc/flamebearer 的理由**:
- `0x` 是最好的 flamegraph 工具，TypeScript 兼容

**验收条款**:
- PF1: 每个优化循环前运行 profiler 生成 CPU profile
- PF2: 优化前后 benchmark 对比，写进优化记录
- PF3: 至少完成 3 个优化循环

### 2.4 Benchmark 覆盖率补全（后端，新增 benchmark spec）

**当前 benchmark 覆盖的缺口**:
| 领域 | 当前覆盖 | 缺口 |
|------|----------|------|
| GE API | ❌ 有 latency/scalability | 无单操作基准（1M ops/s 级别） |
| AST 解析 | ❌ 无 | `parseCypherToPlan` 解析延迟 |
| DML（CREATE/SET/DELETE） | ❌ 无 | DML 路径性能 |
| 结果格式化 | ❌ 无 | `_formatResultRow` 吞吐 |
| 计划验证 | ❌ 无 | `_validatePlan` 延迟 |
| 边遍历模式 | ❌ 部分 | `_walkMultiSteps` BFS 深度 |

**新增 benchmark 文件**:

1. **`parse-benchmark.spec.ts`** — AST 解析性能
   - 简单查询（`MATCH (n) RETURN n`）
   - 复杂查询（3 层嵌套 + 聚合）
   - 带参数查询
   - DML 查询

2. **`dml-benchmark.spec.ts`** — DML 路径性能
   - CREATE 1 节点
   - CREATE 100 节点 + 边
   - SET 属性
   - DELETE 节点（10/100/1000 规模）
   - MERGE 模式

3. **`format-benchmark.spec.ts`** — 结果格式化
   - `_formatResultRow` 小行（3 列）
   - `_formatResultRow` 大行（20 列）
   - `_postProcessResults` ORDER BY
   - `_postProcessResults` ORDER BY + SKIP + LIMIT

**验收条款**:
- BB1: 新增 3 个 benchmark 文件，合计 >=50 项指标
- BB2: 每个 benchmark 可单独运行（`npx vitest run src/benchmark/xxx`）
- BB3: 所有 benchmark 通过 full 模式运行（无 timeout/error）

### 2.5 性能报告生成（后端，`src/benchmark/` 中新增）

**功能**: 将 benchmark 结果转为结构化报告（Markdown + JSON）

**技术选择**:
- Markdown — 人类可读，可直接提交到 PR
- JSON — 程序可解析，用于 CI 自动对比

**不选 HTML dashboard 的理由**:
- 不需要外部 Web 服务
- 当前不需要实时监控（单机项目）
- Markdown + JSON 覆盖面足够

**验收条款**:
- RP1: `perf` 模式输出 Markdown 报告到 stdout
- RP2: `full` 模式输出 JSON 基线到 `benchmark/baselines/`
- RP3: 报告包含：测试名、ops/s、中位数延迟、95p 延迟、对比上次变化%

---

## 3. 推进计划

### Phase 1: Benchmark 统一基础设施（Day 1-2）

**目标**: 建立 Runner + Baseline 对比，日验收前有可用的 `./perf.sh`

| 步骤 | 内容 | 产出 |
|------|------|------|
| 1.1 | 创建 `src/benchmark/runner.ts` | `perf()`, `full()`, `compareBaseline()` 函数 |
| 1.2 | 创建 `src/benchmark/baseline-store.ts` | JSON 基线读写 + git 跟踪 |
| 1.3 | 创建 `scripts/perf.sh` 一键 perf 脚本 | `bash scripts/perf.sh` → stdout 报告 |
| 1.4 | 创建 `scripts/bench-full.sh` 全量运行脚本 | `bash scripts/bench-full.sh` → baseline 文件 |

**验收标准**:
- `bash scripts/perf.sh` 在 < 60s 内输出报告
- `bash scripts/bench-full.sh` 输出 JSON 基线到 `benchmark/baselines/YYYY-MM-DD.json`
- 两次连续运行 ops/s 差异 < 5%

### Phase 2: 补全 Benchmark 覆盖（Day 2-3）

**目标**: 新增 3 个 benchmark 文件，覆盖解析/DML/格式化领域

| 步骤 | 内容 | 产出 |
|------|------|------|
| 2.1 | 创建 `parse-benchmark.spec.ts`（15 项） | AST 解析性能基线 |
| 2.2 | 创建 `dml-benchmark.spec.ts`（20 项） | DML 路径性能基线 |
| 2.3 | 创建 `format-benchmark.spec.ts`（15 项） | 格式化后处理性能基线 |
| 2.4 | 运行 `bench-full.sh` 获取新基线 | 更新 `baselines/YYYY-MM-DD.json` |

**验收标准**:
- 3 个新文件合计 >=50 项指标
- 所有 benchmark 可单独运行
- 全量运行不失败

### Phase 3: Profile 驱动优化（Day 3-7）

**目标**: 至少 3 个 Profile → Optimize → Verify 循环

**循环流程**:
1. 运行 profiler：`node --cpu-prof src/benchmark/query-benchmark.spec.ts`
2. 分析 CPU profile 找热点（Top 5 消耗函数）
3. 优化（每个循环限 1 个修改）
4. 运行 benchmark 验证
5. 记录优化报告

**预期优化方向（按优先级）**:

| 方向 | 预期收益 | 风险 |
|------|----------|------|
| **表达式缓存** — 重复解析的表达式做 memoization | 中~高 | 低（纯函数） |
| **`_evaluateExpression` 字符串预编译** — AST 缓存 | 中 | 低 |
| **`_postProcessResults` 快速路径** — 无 ORDER BY 时跳过排序 | 低 | 低 |
| **`_walkMultiSteps` BFS 缓存** — 重复边路径缓存 | 中 | 中 |
| **`_formatResultRow` 零分配模式** — 重用对象 | 低 | 中 |
| **`_validatePlan` 延迟/缓存** | 低 | 低 |

**验收标准**:
- 至少 3 个优化循环完成
- 每个优化有量化对比（优化前后 ops/s 变化）
- 全量回归：`--quick` 4/4 + split spec 991/991 + TCK 零退化
- 累计优化收益 >=10%（合基线对比）

### Phase 4: 回归门禁集成（Day 7-8）

**目标**: 性能基准可作为 CI 门禁

| 步骤 | 内容 | 产出 |
|------|------|------|
| 4.1 | `baseline-to-report.sh` 脚本 | 基线对比 exit code |
| 4.2 | 集成到 `full-regression.sh` | `--quick` + `--bench-perf` |
| 4.3 | 文档：如何解读和更新基线 | `docs/benchmark.md` |

**验收标准**:
- `bash scripts/full-regression.sh --bench-perf` 在 90s 内完成
- 退化 >=10% 时 exit code = 1
- 通过 `--update-baseline` 可以接受当前结果为新基线

### Phase 5: 文档和可重复性（Day 8）

**目标**: 完整的性能工作流文档

| 步骤 | 内容 |
|------|------|
| 5.1 | 写 `docs/benchmark.md` — 如何运行、解读、添加新 benchmark |
| 5.2 | 写 `docs/perf-optimization-log.md` — 所有优化循环记录 |
| 5.3 | 写 `scripts/benchmark-README.md` — 脚本速查 |

---

## 4. 完整的验收测试条款

### P1 — Benchmark Runner
- [ ] P1.1: `scripts/perf.sh` 运行成功，输出 Markdown 报告
- [ ] P1.2: `scripts/bench-full.sh` 运行成功，输出 JSON 基线文件
- [ ] P1.3: JSON 基线文件包含 HASH（内容哈希），可校验完整性
- [ ] P1.4: Runner 支持自定义 benchmark 子集（`--filter` 参数）
- [ ] P1.5: 两次运行同一条件下，代表指标（中位数）差异 < 5%

### P2 — Baseline 对比
- [ ] P2.1: `compareBaseline(baselineA, baselineB)` 输出差异矩阵
- [ ] P2.2: 退化 >=5% 标 ⚠️，>=10% 标 🔴
- [ ] P2.3: exit code 与退化程度匹配
- [ ] P2.4: 支持 `--update-baseline` 更新当前基线

### P3 — 新 benchmark
- [ ] P3.1: `parse-benchmark.spec.ts` 覆盖简单/复杂/参数/DML 解析
- [ ] P3.2: `dml-benchmark.spec.ts` 覆盖 CREATE/SET/DELETE/MERGE
- [ ] P3.3: `format-benchmark.spec.ts` 覆盖 formatRow/postProcess
- [ ] P3.4: 新增 benchmark 在 `perf` 模式下的代表性子集被选中
- [ ] P3.5: 新增 benchmark 值合理（无异常慢或异常快）

### P4 — Profile 优化
- [ ] P4.1: 至少 3 个独立优化循环完成
- [ ] P4.2: 每个优化有 before/after 基准对比
- [ ] P4.3: 每个优化不通入全量回归（`--quick` + split spec + TCK）
- [ ] P4.4: 累计优化收益 >=10%
- [ ] P4.5: 所有优化通过 git commit 记录，每个 commit 包含 before/after 数据

### P5 — 回归门禁
- [ ] P5.1: `full-regression.sh --bench-perf` 完成 perf benchmark
- [ ] P5.2: 退化 >=10% 检测到并 exit code = 1
- [ ] P5.3: CI 可在有退化时阻止合并

### P6 — 文档
- [ ] P6.1: `docs/benchmark.md` 包含：快速开始、添加 benchmark、解读报告
- [ ] P6.2: `docs/perf-optimization-log.md` 包含所有优化记录
- [ ] P6.3: 脚本有 `--help` 参数

---

## 5. 不开工的方向

| 方向 | 不开工理由 |
|------|-----------|
| HTML Dashboard | 不需要 Web 服务，Markdown + JSON 足够 |
| CI GitHub Action | 当前是嵌入式引擎，非 SaaS 服务 |
| 分布式性能测试 | 单机版本不需要 |
| Benchmark 去重/新增太多 | 8 个已有文件覆盖充足，仅补 3 个缺口 |
| 花哨的可视化 | dev 阶段 roi 低，`0x` flamegraph 已够用 |
| `benchmark.js` 迁移 | vitest bench 已集成，迁移成本高 |
