# [with-orderBy] 剩余失败分类与修复范围评估

创建时间: 2026-08-22 17:40

## 当前基线（commit c6725353）
with-orderBy: 240 passed / 52 failed

## 剩余 52 失败的三个主要 bucket（均非单点 easy-win）

### Bucket 1: TypeError [22]/[23]（4 例）— MATCH + WITH 隐式分组聚合缺失
- 场景: `MATCH (a) WITH a.name AS name, count(*) AS cnt ORDER BY a.name + 'C' <dir> LIMIT 1 RETURN name, cnt`
- 根因（三层，架构缺口）:
  1. `plan.groupBy` 缺失 — parseQuery 只识别聚合函数（plan.aggregate=count(*)），
     不识别「WITH 非聚合列 = 隐式分组键」（a.name AS name）。
     groupBy 仅在 ast-to-plan-v2.ts:797 从显式 `GROUP BY` 子句提取。
  2. executor-non-ge.ts:395 条件过宽 — `(plan.hasMatch && plan.aggregate && (plan.unwind || plan.with))`
     把「无 UNWIND 的分组聚合」误入 unwind pipeline。
  3. _preProcessAggregateWith（executor-unwind-pipeline.ts:49）崩溃 —
     对分组键 `a.name` 做 `_evaluateExpression('a.name', {a: [5节点数组]})` → Property access on non-map type。
- 修复面: 需识别隐式 groupBy + 收紧路由 + 泛化 GROUP BY 后处理（query-executor.ts:4359 硬编码 `n`）。

### Bucket 2: ArgumentError [45]（10 例）— 多 WITH 链变量传递丢失
- 场景: `WITH <values> AS values ... WITH values, size(values) AS numOfValues UNWIND ... WITH numOfValues, collect(x)... RETURN orderedX = range(0, numOfValues-1)`
- 根因: `plan.with` 只保留最后一个 WITH（ast-to-plan-v2.ts:1153 循环覆盖），
  中间 `WITH values, size(values) AS numOfValues` 丢失 → numOfValues 求值 null → range(0, null-1) 抛错。
- 修复面: 多 WITH 链执行支持（较大架构改造）。

### Bucket 3: other-assert [9]/[10]（2 例）— 列表值排序比较语义缺失
- 场景: `UNWIND [[], ['a'], ['a',1], [1], [1,'a'], [1,null], [null,1], [null,2]] AS lists ... ORDER BY lists`
- 根因: _postProcessResults comparator 对数组值用 String().localeCompare（字符串化比较），
  而非 Cypher 列表字典序（逐元素比较 + 类型层级 + null 位置）。
- 期望: `[] < ['a'] < ['a',1] < [1] < [1,'a'] < [1,null] < [null,1] < [null,2]`
- 修复面: 完整 Cypher 值排序层级（null < number < string < list < map...）。

### 其余（另计）
unexpected-row 21、row-count 14、AmbiguousAggregation 1 —— 未逐一诊断。

## 决策建议
三个 bucket 都是中大型修复，非单点 easy-win。需 Lambert 确定优先级。
