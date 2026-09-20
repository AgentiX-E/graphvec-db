# SET Clauses 全量归零计划

创建时间: 2026-09-06 19:50

## 目标
将 set 目录 6 个 feature 文件（53 场景）从 33 失败降到 0 失败，同时保持 delete/call/match 零回归。

## 失败分类（33 个）

### 迭代 1 — SET 表达式值 + null 移除 + 表达式选择器（~9 场景）
- Set1 [2] `SET n.name = n.name + ' was here'`（表达式值）
- Set1 [3][4] `SET (n).name = 'neo4j'`（括号表达式选择器）
- Set2 [1][2][3] `SET n.property1 = null`（null 移除属性）
- Set1 [5][6][7] `SET n.numbers = [1,2,3]` / `a.numbers + [4,5]`（list 属性/list 拼接表达式）

### 迭代 2 — SET 标签（~7 场景）
- Set3 [1]-[7] `SET n:Foo` / `n:Foo:Bar` / `n :Foo`

### 迭代 3 — SET map + +=（~8 场景）
- Set4 [1]-[4] `SET n = {map}`
- Set5 [2][3][4] `SET n += {map}`

### 迭代 4 — 错误处理（~2 场景）
- Set1 [9] undefined variable → SyntaxError UndefinedVariable
- Set1 [10] list of maps → TypeError InvalidPropertyType

### 迭代 5 — SET + SKIP/LIMIT/filter/聚合（~7 场景）
- Set6 [1]-[21]（节点/关系/标签 各组聚合、SKIP/LIMIT、WITH WHERE）

## 当前实现缺陷

### extractSetClauses（ast-to-plan-v2.ts:2034）
只识别 `(\w+)\.(\w+)\s*=\s*(.+)$`，value 仅解析字面量，无法表达：
1. 表达式值（已保留原始字符串，但执行层未求值）
2. `(n).name` 括号选择器
3. `n:Foo` 标签
4. `n = {map}` / `n += {map}`

### SET 执行块（query-executor.ts ~2962）
- 把 value 原样赋给 node[property]，不识别表达式
- 不识别 null（应 delete 属性）
- 不识别标签、map、+=

## 方案

### 扩展 setClauses 类型（保持向后兼容）
```ts
setClauses?: Array<{
  kind?: 'PROP' | 'LABEL' | 'MAP' | 'MAP_APPEND'
  property?: string
  value?: unknown
  valueExpr?: string   // 表达式文本
  label?: string
  labels?: string[]
  props?: Record<string, unknown>
}>
```

### extractSetClauses 增强
- 识别 `n.prop = <expr>` → kind=PROP, property, valueExpr（表达式）或 value（字面量）
- 识别 `(n).prop = <val>` → 括号选择器，同 PROP
- 识别 `n:L1:L2` → kind=LABEL, labels
- 识别 `n = {map}` → kind=MAP, props
- 识别 `n += {map}` → kind=MAP_APPEND, props

### SET 执行块增强
- valueExpr 非空 → `_evaluateExpression(valueExpr, {varName: node})`
- value === null → delete node[property]
- kind=LABEL → 追加 labels 到 node._label
- kind=MAP → 全量替换 props（null 移除）
- kind=MAP_APPEND → 合并 props（null 移除，覆盖）

## 验收标准
- 每迭代：set 目录对应场景全绿 + delete/call/match 零回归 + core regression 813/813
- 测试覆盖率 >95%
