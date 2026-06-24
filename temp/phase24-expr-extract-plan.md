# Phase 24: `_evaluateExpression` 模块提取

## 目标
将 `query-engine.ts` 中的表达式求值引擎（`_evaluateExpression` + 81 个依赖函数）提取到独立的 `expression-engine.ts`。
消除 `expression-helpers.ts` 寄存器模式。

## 当前状态
- `query-engine.ts`: **9615 行**（含~1900 行表达式引擎）
- `expression-helpers.ts`: 39 行（寄存器模式临时方案）
- `expression-engine.ts`: 32 行（stub）

## 提取范围
需要提取的函数（从 `_evaluateExpression` BFS 递归依赖链）：

### 核心导出函数
- `_evaluateExpression(expr, row, ctx, ...)` — 表达式求值入口
- `_postProcessResults(result, plan)` — 后处理（ORDER BY/HAVING/SKIP/LIMIT）
- `_bindPositionalParams`, `_injectParamsToPlan` — 参数注入

### 内部辅助函数（纯表达式）
- `_evalArithmetic` — 算术运算
- `_evalBinary` — 二元运算（+-*/^%）
- `_evalComparison` — 比较运算（<> ≤ ≥ =）
- `_evalUnary` — 一元运算（- + NOT）
- `_evalIn` — IN 列表运算
- `_evalCaseExprOnRow` — CASE WHEN
- `_evalLiteral` — 字面量求值
- `_evalCoalesce` / `_evalNullIf` — null 处理
- `_evalToString` / `_evalToBoolean` — 类型转换
- `_evalIsNull` / `_evalIsNotNull`
- `_evalIsNaN` / `_evalIsNotNaN`
- `_evalPropertyAccess` — n.property
- `_evalListIndex` — list[index]
- `_evalListRange` — list[1..3]
- `_evalConditional` — CASE/COALESCE
- `_matchFilter` — 行级匹配
- `_deepEqWithNull`, `_deepEq` — 深度比较（三值逻辑）
- `_orderByField` — ORDER BY 字段提取
- `_bigintReplacer`, `_bigintReviver` — JSON 序列化
- `_evalCollectionFunction` — collect/avg/min/max/sum/stdev
- `_evalPatternPredicate` — 模式谓词
- `_stringifyVal` — 值序列化
- `_evalList` — 列表构造
- `_evalMap` — Map 构造

### 非表达式函数（**不提取**，留在 query-engine.ts）
- `_executeViaGraphEngine` — 全量查询执行
- `_formatResultRow` — 结果格式化（依赖 GE 输出格式）
- `_executeQuery` — 入口
- `_validatePlan` — 编译时校验
- `parseQuery` — 解析入口
- DML 执行（DELETE/SET/MERGE/REMOVE）
- CSV 解析函数
- `_execAggregation` (GE 层)
- GE 实例管理（`_geInstanceRegistry`）

## 策略

### 第一步：精确收集依赖
1. 从 `_evaluateExpression` 函数体 BFS 收集所有引用的内部函数名
2. 从 `_postProcessResults` 函数体 BFS 收集所有引用的内部函数名
3. 从 `_bindPositionalParams` / `_injectParamsToPlan` 收集
4. 去重后得到完整的 export 列表

### 第二步：创建 expression-engine.ts
1. 复制所有提取函数的代码（保留原始行号注释 → 行号溯源）
2. 添加 `export` 前缀到每个提取函数
3. 处理类型依赖（是否需要在本地定义 QueryRow 等类型）
4. 注意：不需要 import query-engine.ts！提取的函数是纯函数

### 第三步：query-engine.ts 转为转发
1. 顶部 `import { _evaluateExpression, _postProcessResults, ... } from './expression-engine'`
2. 删除原有函数定义（从 _evaluateExpression、_postProcessResults 开始，到文件尾）
3. 在 query-engine.ts 文件最后，将 `registerEvaluateExpression` / `registerPostProcessResults` 更新为直接 import

### 第四步：消除 expression-helpers.ts
1. 删除 var-length-path.ts 中的 `import { getEvaluateExpression, getPostProcessResults }`
2. 改为 `import { _evaluateExpression, _postProcessResults } from './expression-engine'`
3. 删除 expression-helpers.ts（弃用）

### 第五步：回归验证
1. `--quick` 回归（4 项）
2. split spec 991/991
3. 全量 cucumber TCK 验证

## 验收标准
✅ `query-engine.ts` 减少 < 7500 行（从 9615）
✅ `expression-engine.ts` 存在且独立（不 import query-engine.ts）
✅ `expression-helpers.ts` 被删除
✅ `var-length-path.ts` 直接 import expression-engine
✅ `--quick` 4/4
✅ split spec 991/991
✅ cucumber TCK 全量

## 风险控制
- **循环依赖防御**：expression-engine.ts 不允许 import query-engine.ts
- **非纯依赖防御**：如果某个"纯"表达式函数依赖了 query-engine.ts 的副作用函数（如 _procedureRegistry），标记后留在原处
- **验收为硬约束**：任何一步破坏验收标准就立即回退
