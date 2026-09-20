# [DISTINCT + HAVING] 执行计划

创建时间: 2026-08-31 08:40

## 目标

补齐 aggregate 功能缺口，让 aggregate.spec.ts 69/69 全绿，然后零退化回归，以 Lambertyan 提交。

## 剩余 3 个失败

1. n. `COUNT(DISTINCT name)` → 0 而非 5（DISTINCT 修饰符未实现）
2. q. `COUNT vs COUNT(DISTINCT name)` → DISTINCT 同上
3. h. `WITH count(*) AS cnt WHERE cnt > 1` → 0 而非 10（HAVING / WITH-WHERE 聚合后过滤未实现）

## 步骤

- [ ] Step 1: 诊断 DISTINCT 精确根因（field 提取 + GE count 计算路径）
- [ ] Step 2: 诊断 HAVING 精确根因（whereBody 在 WITH 聚合路径的流转）
- [ ] Step 3: 实现 COUNT(DISTINCT x) — field 剥离 DISTINCT + distinct 标志贯通 parser→GE
- [ ] Step 4: 实现 HAVING — WITH 聚合后应用 whereBody 过滤
- [ ] Step 5: 新增针对性单测覆盖 DISTINCT/HAVING 边界（含空集、null、多列）
- [ ] Step 6: aggregate.spec.ts 69/69 全绿验证
- [ ] Step 7: 全量回归（graph-engine 622 + query-engine 71 + TCK）零退化验证
- [ ] Step 8: 以 Lambertyan 提交（全英文注释/commit）

## 当前进度

正在执行: Step 1（诊断 DISTINCT）
