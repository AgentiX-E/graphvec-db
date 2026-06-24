# 推进计划 — Performance QAP

## 整体工期: 8 天

```
Phase 1 (统一 Runner) ───→ Phase 2 (补覆盖) ───→ Phase 3 (Profile 优化) ───→ Phase 4 (门禁) ───→ Phase 5 (文档)
   Day 1-2                   Day 2-3                 Day 3-7                     Day 7-8            Day 8
```

## Phase 1: Benchmark 统一基础设施（Day 1-2）

### 检验方法

**每日检查点**:
- Day 1 结束时: `runner.ts` + `baseline-store.ts` 写完，可输出 JSON
- Day 2 结束时: `perf.sh` + `bench-full.sh` 可用

**验收标准**:
```bash
# 1. perf 快速烟雾测试
bash scripts/perf.sh
# 预期: < 60s, stdout 输出 Markdown 报告

# 2. 全量基线
bash scripts/bench-full.sh
# 预期: 输出 benchmark/baselines/YYYY-MM-DD.json

# 3. 可重复性（连续运行两次）
bash scripts/perf.sh > /tmp/perf1.md
bash scripts/perf.sh > /tmp/perf2.md
# 预期: 代表指标差异 < 5%
```

## Phase 2: 补全 Benchmark 覆盖（Day 2-3）

### 检验方法

**每日检查点**:
- Day 1 结束时: 3 个新 benchmark 文件写完，可单独运行
- Day 2 结束时: 全量运行通过无 error

**验收标准**:
```bash
# 1. 每个新 benchmark 可单独运行
npx vitest run src/benchmark/parse-benchmark.spec.ts --no-coverage
npx vitest run src/benchmark/dml-benchmark.spec.ts --no-coverage
npx vitest run src/benchmark/format-benchmark.spec.ts --no-coverage

# 2. 全量基准通过
bash scripts/bench-full.sh
# 预期: exit code 0, 全部 PASS

# 3. 新覆盖验证
# parse-benchmark 至少 15 项
# dml-benchmark 至少 20 项
# format-benchmark 至少 15 项
# 合计 >= 50 项
```

## Phase 3: Profile 驱动优化（Day 3-7）

### 检验方法

**每个优化循环的检验**:
```bash
# 1. Before 基线
npx vitest run src/benchmark/query-benchmark.spec.ts --no-coverage > /tmp/before.txt

# 2. 运行 profiler
node --cpu-prof src/benchmark/query-benchmark.spec.ts

# 3. 实现优化
# (编辑代码)

# 4. After 验证
npx vitest run src/benchmark/query-benchmark.spec.ts --no-coverage > /tmp/after.txt

# 5. 回归检查
bash scripts/full-regression.sh --quick

# 6. TODO: baseline 对比
# (runner 内部对比 before/after)
```

**每日检查点**:
- 每天结束前至少进入 1 个优化循环的「Verify」阶段
- 每 3 天检查一次全量回归（不是每次，避免浪费时间）

**验收标准**:
- 至少 3 个优化循环完成
- 每个有 before/after 量化对比（记录到 `docs/perf-optimization-log.md`）
- 累计优化收益 >= 10%
- 全量回归零退化

## Phase 4: 回归门禁集成（Day 7-8）

### 检验方法

**验收标准**:
```bash
# 1. 带 benchmark 的回归
bash scripts/full-regression.sh --bench-perf
# 预期: 90s 内完成，产出 perf 报告

# 2. 退化检测
echo "退化测试（手动注入 50ms sleep 到热点函数）"
# 预期: exit code = 1（退化检测到）

# 3. 更新基线
bash scripts/full-regression.sh --bench-perf --update-baseline
# 预期: 基线文件更新
```

## Phase 5: 文档（Day 8）

### 检验方法

- `docs/benchmark.md` 被开发新手在 10 分钟内成功运行 perf benchmark
- 包含 troubleshooting 常见问题

---

## 全局风险控制

| 风险 | 概率 | 缓解 |
|------|------|------|
| benchmark 值波动大（GC 抖动） | 高 | warmup loop + 多次运行取中位数 |
| 优化引入 bug | 中 | 每个优化后跑 --quick + split spec |
| 优化收益 < 预期 | 中 | 规定最低 5% 收益才提交，不够就跳过 |
| 新 benchmark 低质量 | 低 | 代码审查 + 验证值合理 |
| 全量 benchmark 时间过长 | 中 | perf 模式限制代表性测试，full 模式可夜间跑 |
