# Phase 7 代码审查报告 — _executeViaGraphEngine

审查时间: 2026-06-14 15:50
审查范围: query-engine.ts lines 1376-3000 (约 1600 行)

## CRITICAL

### C1: Plan 对象突变泄漏
**位置**: 多处（line 787, 812, 833, 1542 等）
**问题**: `_executeViaGraphEngine` 直接 mutate 传入的 `plan` 对象（filter 清除、returnColumns 重写、labelExpr 赋值等）。重复使用同一 `QueryPlan` 会得到不同结果。
**修复**: 简单 — GE 执行前做 `JSON.parse(JSON.stringify(plan))` 深拷贝，操作副本。

### C2: REMOVE / FOREACH / CREATE_CONSTRAINT 死代码
**问题**: `isDML` 包含这三种类型，但实际执行只有 CREATE/MERGE/DELETE/SET 路径。REMOVE 不删除属性、FOREACH 不循环、CREATE_CONSTRAINT 不做任何事。TCK 静默通过。
**修复**: 简单 — 为 REMOVE 添加属性删除处理；FOREACH 加子查询展开或标记为 TODO。

### C3: Skip Node Stub 边干扰
**位置**: lines 1647-1703
**问题**: seed 阶段跳过的节点被创建为 GE stub node（`'s'+si`），边却连接到 stub。GE 从邻居遍历会到达"被过滤掉"的节点。
**修复**: 中等 — stub 节点不应参与边创建。

### C4: 字符串参数注入风险
**位置**: `_injectParamsToPlan` lines 648-662
**问题**: 字符串类型值注入时，仅当同时含 `'` 和 `"` 两种引号时做移除。含 `'` 的值（如 `O'Brien`）原样注入，可能破坏查询结构。
**修复**: 简单 — 对字符串参数统一做引号安全转义。

## HIGH

### H1: stepSourceFilters 双重应用
**位置**: lines 1508 + 1808 + 1542
**问题**: stepSourceFilters 同时在 seed 阶段（skipNodeIndices）和 _walkMultiSteps 中应用，且从 plan.filters 移除后仍然存在导致的过滤不一致。
**修复**: 简单 — 统一过滤链路，确保每个 filter 只应用一次。

### H2: _formatResultRow 多变量解析
**位置**: _formatResultRow lines 2510-2543
**问题**: `isSourceVar` 只检查 `plan.steps[0].source`。`RETURN a, b, c` 中 b 是中间 step 的 target，_formatResultRow 的变量回退链（__targetProps / __targetPropsMap）不完整。
**修复**: 复杂 — 需要构建完整的 stepIndex→varAlias 映射。

### H3: WHERE type(r) 正则只匹配第一个
**位置**: lines 1746-1758
**问题**: 非全局正则，`WHERE type(r) = 'A' AND type(r) = 'B'` 只匹配第一个，第二个约束不执行。
**修复**: 简单 — 改为全局匹配 + 循环应用。

### H4: 内联属性过滤代码重复
**位置**: lines 1554-1574 + lines 2040-2073
**问题**: `(n {name: 'A'})` 的节点属性预过滤两次实现，第二次是死代码，且当 inlineVar 不匹配 steps[0].source 时两次都不生效。
**修复**: 简单 — 合并过滤逻辑，删除死代码。

### H5: extractEdgesFromNodes 字符串索引静默丢弃
**位置**: line 3110+
**问题**: `typeof e.srcIdx === 'number'` 检查，字符串格式索引的边被静默丢弃。
**修复**: 简单 — `Number(e.srcIdx)` 转换。

### H6: ORDER BY null 排序方向错误
**位置**: _postProcessResults line 1208
**问题**: null 排在 ASC 最前，openCypher 规范要求 null 排在 ASC 最后。
**修复**: 简单 — 交换 null 比较方向。

## MEDIUM

### M1: labelExpr 与 step.targetLabel 重复校验
- 无功能 bug，架构冗余

### M2: String() 类型强转
- `String(undefined)` → `"undefined"`，当 `expected` 恰为字符串 `"undefined"` 时误匹配

### M3: _walkMultiSteps returnVar 交集粒度
- boundedResults 只检查 returnVar === lastStep.targetAlias，不能处理 RETURN 多列

### M4: CREATE_CONSTRAINT → 缺少错误提示
- 当前返回空，应至少抛 NotSupportedError

### M5: ORDER BY 多列排序降级
- 只处理第一列排序，多列 ORDER BY 退化

## 修复优先级

| 优先级 | 问题 | 复杂度 | 影响 |
|--------|------|--------|------|
| P0 | C1 Plan 突变泄漏 | 简单 | 使用同一 plan 重复查询返回错误结果 |
| P0 | C2 REMOVE/FOREACH 死代码 | 简单 | 三种 DML 类型静默不工作 |
| P1 | H3 type(r) 多条件 | 简单 | 复合 type filter 部分丢失 |
| P1 | H5 字符串索引 | 简单 | TCK 数据可能静默丢边 |
| P1 | H6 ORDER BY null 排序 | 简单 | 违反 openCypher 规范 |
| P1 | H4 死代码 + 过滤缺口 | 简单 | 内联属性过滤在某些场景不生效 |
| P1 | H1 双重过滤 | 简单 | 过滤不一致 |
| P2 | C3 stub 边干扰 | 中等 | 跳过节点在 GE 路径中仍可达 |
| P2 | C4 字符串注入 | 简单 | 边界安全场景 |
| P2 | H2 多变量解析 | 复杂 | RETURN 3+ 变量场景 |
| P3 | M1-M5 | 简单-中等 | 边界场景或架构整洁 |
