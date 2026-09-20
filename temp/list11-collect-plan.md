# List11 RETURN 跨行 collect 聚合修复计划

创建时间: 2026-08-24 13:15

## 目标

修复 `RETURN ALL(ok IN collect(expr) WHERE ok)` 类场景——collect 聚合出现在 RETURN 表达式（而非 WITH 聚合投影）时，pipeline 无法跨行收集，返回空结果。

## 根因（已定位）

- `executor-unwind-pipeline.ts` Step 4 只处理 `plan.aggregate && !plan.with?.columns?.length`
  （独立聚合 WITH），collect 只在 `plan.aggregate` 里。
- 当 `collect(...)` 出现在 RETURN 表达式 `ALL(ok IN collect((size(list)=0)=empty) WHERE ok)` 时，
  Step 5 逐行映射 `_evaluateExpression(expr, row)` 在**单行**上下文求值，collect 只能收集当前行的值。
- 结果：collect 得到空/单元素列表 → `all([])` = true（假阳性）或错误。

## 步骤

- [ ] 步骤1: 精确诊断 Step 5 里 RETURN 表达式含跨行 collect 时的行为，确认 collect 内核能否感知全量 rows
- [ ] 步骤2: 设计最小优雅修复——让 RETURN 表达式里的 collect 聚合在 Step 5 求值前，把全量 rows 注入上下文
       （如：先识别 RETURN 表达式中的 collect/聚合跨行依赖，物化到 varCtx 再求值）
- [ ] 步骤3: 实施修复，验证 List11 [3] → true
- [ ] 步骤4: 全量回归（quick 4/4 + 表达式 TCK before/after diff）确认零退化 + 未新增假阳性
- [ ] 步骤5: 验收达标后 Lambertyan 提交（英文）

## 当前进度

正在执行: 步骤1（诊断 Step 5 跨行 collect）
