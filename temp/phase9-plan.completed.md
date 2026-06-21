# Phase 9 — 基准套件 + Comparison TCK + 代码审查

创建时间: 2026-06-21 14:00

## 目标
3 个方向全部推进，最高标准零妥协：
1. **Performance Benchmark Suite** — 可重复基线（GE 原生 + query-engine 全链路）
2. **Comparison TCK 29 fail → 0 fail** — 离 100% 最近的未覆盖领域
3. **Phase 7 代码审查遗留项** — HIGH 项修复 + 全量审查更新

## 步骤

### Phase A: 性能基准套件 (预计 ~1h)
- [ ] **A1**: 扩展现有 benchmark.sh——添加 4 个新测项
  - `_scanNodesByLabel('Person')` on 100K nodes (40x 加速基线)
  - `_scanAll` on 100K nodes
  - `query-engine` MATCH (n:Person) WHERE n.age > 25 RETURN n — 全链路
  - `query-engine` MATCH (n)-[:KNOWS]->(m) RETURN m — 有边查询
- [ ] **A2**: 跑基准并记录到 `docs/benchmark-baseline-20260621.md`
- [ ] **A3**: 验证基准在 3 次运行中波动 <10%（否则调大 iterations）

### Phase B: Comparison TCK 29→0 (预计 ~2-3h)
- [ ] **B1**: 运行 Comparison TCK 获取 29 fail 明细
- [ ] **B2**: 分类失败：
  - `row count` — 输出行数不匹配（大概率 20 个）
  - `unexpected row` — 返回了不该有的行（7 个）
  - `undefined var` — 变量未定义（1 个）
- [ ] **B3**: 修复 row count 类（最常见）
- [ ] **B4**: 修复 unexpected row 类
- [ ] **B5**: 修复 undefined var 类
- [ ] **B6**: Comparison 全量 TCK 36/36 目录全绿
- [ ] **B7**: 全量回归（`--quick` 4/4 + TCK clauses + expressions + useCases）

### Phase C: 代码审查 (预计 ~1h)
- [ ] **C1**: 审查 Phase 7 遗留的 HIGH 项
  - 检查 `_executeViaGraphEngine` 中所有的 `filter` 操作
  - 检查 `_walkMultiSteps` 的边界条件
  - 检查 `_formatResultRow` 的 null 安全
- [ ] **C2**: 审查 FOREACH 新增代码（`foreach-exec.ts`, `ast-to-plan-v2.ts` FOREACH 块）
- [ ] **C3**: 审查 `_geInstanceRegistry` 重建的性能影响
- [ ] **C4**: 修复新发现的问题
- [ ] **C5**: 全量回归确认

## 执行顺序
```
A1 → A2 → A3 → B1 → B2 → B3 → B4 → B5 → B6 → B7 → C1 → C2 → C3 → C4 → C5
```

A 和 B 独立 → B 可以 sub-agents 并行 C 的一部分

## 当前进度
**Phase A**: ✅ 全部完成 — 6 测项基准 + 基线文档 docs/benchmark-baseline-20260621.md
**Phase B**: ✅ Comparison 18/18 全绿 — 29 fail 已被历史修复无意识覆盖，无需额外修复
**Phase C**: ✅ 审查完成 — scripts/phase9-code-review-report.md
  - Phase 7 遗留 6 HIGH: 全部已修复/覆盖 ✅
  - Phase 7 遗留 4 CRITICAL: 全部已修复 ✅
  - FOREACH 新增代码: 无安全问题 ✅
  - 新发现问题: 2 个 LATER/P3
**最终交付**: 以下文件需 commit
- scripts/benchmark.sh (重写)
- docs/benchmark-baseline-20260621.md (新建)
- scripts/phase9-code-review-report.md (新建)
- temp/phase9-plan.md (计划文件)

注: query-engine.ts / ast-to-plan-v2.ts / foreach-exec.ts 的 FOREACH 修改已在 `627d80da` 提交
