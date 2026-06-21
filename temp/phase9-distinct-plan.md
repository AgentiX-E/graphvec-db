# Phase 9: RETURN DISTINCT 补全

## 现状
- `plan.distinct` 只在 WITH/UNWIND pipeline 路径中处理（line 5330）
- `RETURN DISTINCT n` 直接走 GE 执行时不会去重
- `query-engine.spec.ts` 无 DISTINCT 测试

## 目标
在 `_executeViaGraphEngine` 的 GE 执行结果后添加 DISTINCT 去重逻辑

## 步骤
1. 定位 GE 直接执行路径（query-engine.ts `_executeViaGraphEngine` 的返回段）
2. 在有 `plan.distinct` 且不走 pipeline 时去重
3. 写测试验证：`RETURN DISTINCT n` 返回不重复节点
4. 验证全量无退化

影响面：极受控（只改一个点的后处理）
