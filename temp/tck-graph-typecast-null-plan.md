# TCK: Graph + TypeConversion + Null 修复计划

## 当前状态
- Graph: 19/61 pass, 42 fail (Graph3-Graph9)
- TypeConversion: 31/47 pass, 16 fail (TypeConversion1-4)
- Null: 40/44 pass, 4 fail (Null1)

## Root Causes

### 1. `_validateUndefinedVariables` — RETURN 校验不包含 UNWIND/WITH AS 变量
- 第一个校验块（line ~5075-5082）：`if (matchVars.length === 0 && varIdents.length > 0)` 
  - 只检查 `allDefinedVars = [...matchVars, ...createEdgeVars, ...createNodeVars]`
  - 不包含 `withVars`（WITH/UNWIND AS 变量）
- 修复：`allDefinedVars` 应包含 `withVars`

### 2. `_validateUndefinedVariables` — 缺少 `TOBOOLEAN` 关键字
- 第一个校验块：缺少 `TOBOOLEAN`
- 第二个校验块（keywords Set）：缺少 `TOBOOLEAN`

### 3. `_validateUndefinedVariables` — Map literal 变量误判
- `RETURN {a: 1} IS NULL` → `a` 被当作未定义变量
- Map literal 内部的 key 不是变量引用，应忽略
- 需要跳过 map literal `{}` 内部的标识符

### 4. Null: `_alias` 字段泄露
- GE 返回的节点 props 中包含 `_alias` 字段
- `_formatResultRow` 或输出阶段需要过滤 `_alias`

### 5. Graph: `labels()` 返回 `null` 而非 `[]`
- label-less 节点的 labels() 应该返回空数组 `[]`

### 6. Graph: `labels()` 对 path 参数应报 `InvalidArgumentType`
- 需要在编译时验证：`labels(p)` 对 path 参数报错

### 7. Graph: `VariableTypeConflict` at compile time
- UNION 查询中类型不匹配触发编译时检查

## 修复策略
只改 `src/query/query-engine.ts`。

### Fix A: `_validateUndefinedVariables` RETURN 部分 — 加入 `withVars`
在 line ~5075 的 `allDefinedVars` 构建时，也加入 WITH/UNWIND 中定义的变量。

### Fix B: 关键字列表添加 `TOBOOLEAN`
两处关键字列表都加。

### Fix C: 在 `_validateUndefinedVariables` 中跳过 map literal 标识符
在 WHERE 和 RETURN 的标识符提取前，先移除 map literal `{...}` 内容。

### Fix D: 过滤 `_alias` 字段
在 `_formatResultRow` 或输出阶段移除 `_alias` 和 `__fullLabel`。

### Fix E: `labels()` 返回空数组
在 `_evaluateExpression` 或 GE 中修复 labels 函数对无标签节点返回 `[]` 而非 `null`。

### Fix F: `labels()` 对 path 参数编译时报 `InvalidArgumentType`
在 `_validatePlan` 中添加检查。

## 提交策略
- Fix A+B+C (TypeConversion + Graph undefined variable): commit 1
- Fix D (Null _alias): commit 2
- Fix E (labels []): commit 3
- Fix F (labels path): commit 4
