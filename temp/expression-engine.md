# 表达式引擎执行计划

## 动机
TCK expressions 18 目录 (97 场景) + useCases 全部失败。根因：`_executeViaGraphEngine` 对纯 RETURN 表达式（非节点属性）完全不解析。

## 架构决策

**不实现独立 AST 执行器。** 现有 parseQuery 已将表达式解析为 `plan.returnColumns` 字符串数组（如 `'1'`, `'1 + 2'`, `'abs(-1)'`）。
采用 **EvaluateExpression(expr: string, row: any): unknown** 函数，在纯 RETURN 分支中逐列求值。

## 分步计划

### Phase A: 字面量求值 (RETURN 1, 'hello', true, null, [], {})
- 覆盖：literals 8 scenarios, typeConversion 4/5, bool 部分
- 实现 `evalLiteral(expr: string): unknown` — JSON.parse + 特殊格式处理
- 修改 pure RETURN 分支：对每个 returnColumn 尝试字面量求值
- **验证**: Literals1-8 ✅

### Phase B: 一元/二元运算 (1+2, -3, true AND false, n IS NULL)
- 覆盖：mathematical, boolean, null, comparison, precedence, quantifier
- 实现 `evalExpression(expr: string, row: any): unknown`
- 解析操作符优先级：OR → AND → NOT → 比较 → 加减 → 乘除 → 一元 → 函数/属性
- 递归求值
- **验证**: ~40 scenarios ✅

### Phase C: 内置函数 (abs, sqrt, reverse, toUpper, coalesce, toInteger, labels, type, etc.)
- 覆盖：string, mathematical (函数部分), graph (labels/type/keys/properties), typeConversion, conditional (coalesce)
- 实现 `evalFunction(fn: string, args: string[], row: any): unknown`
- 约 20+ 个函数
- **验证**: ~20 scenarios ✅

### Phase D: 聚合函数 (count, sum, avg, min, max, collect)
- 覆盖：aggregation 8 scenarios, useCase count( * )
- 需要在 GE 执行后的结果 rows 上做行级聚合
- 实现 `evalAggregate(fn: string, args: string[], rows: QueryRow[]): QueryRow[]`
- **验证**: aggregation 8/8 ✅, useCase 2/2 ✅

### Phase E: 列表/映射/路径/时间
- 覆盖：list, map, path, temporal
- 列表操作 (head, tail, range, length, reverse), 映射访问, 路径函数
- **最后一期**
- **验证**: ~25 scenarios ✅

## 执行策略
- 每 Phase 一个 commit，vitest + TCK 验证
- Phase D 需改动 `_postProcessResults`（行级聚合）
- Phase E 可用 sub-agent 并行
