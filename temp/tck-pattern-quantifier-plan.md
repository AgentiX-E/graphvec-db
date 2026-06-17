# TCK Pattern + Quantifier Fix Plan

创建时间: 2026-06-17 21:30

## 目标

修复 Pattern（15/50 pass, 35 fail）和 Quantifier（488/604 pass, 116 fail）TCK 场景。
只改 `src/query/query-engine.ts`。

## 问题分析

### Pattern 失败分类（24 failed scenarios）

1. **`_validateUndefinedVariables` 误报** (scenarios 4-10, 13-21)
   - `MATCH (n) WHERE (n)-[:REL1]->() RETURN n`
   - `_validateUndefinedVariables` 提取 WHERE 子句中的 `(:REL1)` 中的 REL1 作为标识符
   - 但这些是标签/类型名，不是变量
   - 修复：在提取 WHERE 标识符时跳过括号模式中的标签名

2. **WHERE 中的模式谓词未被编译为 EXISTS 子查询** (scenarios 1-3, 12)
   - `MATCH (n) WHERE (n)-[]->() RETURN n`
   - Pattern 表达式应被识别为 EXISTS 子查询
   - 当前 whereBody 的 `_evaluateExpression` 不处理 `(n)-[]->()` 这类模式
   - 修复：检测 WHERE 子句中的模式并转换为 exists 检查

3. **缺少 `WHERE (n)` 的编译时错误** (scenario 11)
   - Cypher 要求 `WHERE (n)` 必须报 `InvalidArgumentType`
   - 当前返回空结果
   - 修复：检测 WHERE 中只有 (variable) 的纯节点模式

4. **RETURN/WITH/SET 中的模式应报错** (scenarios 22-24)
   - `MATCH (n) RETURN (n)-[]->()` — 应报 `UnexpectedSyntax`
   - `MATCH (n) WITH (n)-[]->() AS x RETURN x`
   - `MATCH (n) SET n.prop = ...head((n)-[:REL]->())...` 中的模式
   - 修复：在编译时检测这些场景

### Quantifier 失败模式
- 类似的问题：UndefinedVariable, WHERE 中的模式处理, 模式推导等
- 需要先跑看看

## 方案

### Phase 1: Fix `_validateUndefinedVariables`
- 在提取 WHERE 子句中的标识符时，去掉括号模式 `(...)` 和 `[...]` 中的标签/类型名
- 这些是标签或关系类型，不是变量引用

### Phase 2: Fix WHERE 中的模式谓词编译
- 检测 `whereBody` 中的 `(...)` 和 `[...]` 模式语法
- 转换为 exists 检查：对于 `(n)-[]->()` 模式，检查 n 是否有出边
- 对于 `(n)-[:LABEL]->()` 模式，检查 n 是否有特定标签的出边

### Phase 3: Add compile-time error for self-pattern WHERE (n)
- 检测 `WHERE (variable)` 纯模式（无关系部分）
- 抛出 `InvalidArgumentType`

### Phase 4: Pattern in wrong position
- 检测 RETURN/WITH/SET 中的模式语法
- 抛出 `UnexpectedSyntax`
- 使用正则检测 pattern 语法 `(...)-[...]-(...)` 等

## 当前进度

Phase 1: 开始
