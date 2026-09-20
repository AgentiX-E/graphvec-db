# Aggregation3/6/8 UNWIND 聚合失败修复计划

创建时间: 2026-08-26 09:10

## 目标
修复 expressions/aggregation 目录中 Aggregation3/6/8 的 UNWIND 聚合失败场景（真实现缺口）。

## 当前已定位失败
- Aggregation3 [1] `Sum only non-null values`（line 33）：`sum(n.num)` 返回 0 + n.name=null，期望 `'a'`/75 — 疑似走 UNWIND pipeline 而非 MATCH 分组，sum 逐行而非聚合
- Aggregation3 [2] `No overflow during summation`（line 51）：`sum(i)` 返回 `1500001500000`（累加错误，可能是 range 未正确展开或重复累加），期望 `3004498500`

## 步骤
- [ ] 诊断 Aggregation3 [1] 根因
- [ ] 诊断 Aggregation3 [2] 根因
- [ ] 诊断 Aggregation6 / Aggregation8 失败场景
- [ ] 设计最小修复
- [ ] 编写覆盖测试（≥95%）
- [ ] 全量回归（quick 4/4 + expressions TCK + clauses）
- [ ] Lambertyan 提交（英文）

## 当前进度
正在执行: 诊断 Aggregation3 [1]/[2] 根因
