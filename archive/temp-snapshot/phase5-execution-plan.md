# Phase 5 执行计划 — 修订版

## 问题诊断

TCK `_executeQuery` (mock, 4000+ 行) 和 GraphEngine `_executeQueryPlan` (3400 行引擎) 之间存在三个不兼容：

### 1. Label 模型差异
- **TCK/mock**: label 是字符串 `_label` 属性，`MATCH (n:Person)` → `plan.scanLabel = 'Person'` → mock 用 `n['_label'] === 'Person'` 过滤
- **GraphEngine**: label 是 `typeId` (数字) + `typeName` (upsertNode 的 name 参数)。`_scanNodesByLabel` 匹配 `node.typeName === label`，但 typeName = upsertNode 的 name，多个同 label 节点不能同名

### 2. Edge label 差异
- **TCK/mock**: edge label 是字符串（如 'KNOWS'），在 `plan.steps[0].edgeLabel` 中作为过滤条件
- **GraphEngine**: edge typeId 是数字，`Number(step.edgeLabel)` 转换失败（'KNOWS' → NaN）

### 3. 查询结果格式差异
- **TCK/mock**: `_executeQuery` 返回 `Array<Record<string, any>>`，key 是节点变量名（'n', 'a', 'b'）
- **GraphEngine**: `engine.query()` 返回 `NodeRecord[]`，key 是节点自身属性（'id', 'type', 'name', 'props'）

## 推荐方案：混合适配

不重写 TCK runner，而是：
1. **简单查询（无 edge、无 label）**: 直接用 `engine.query(queryStr)`，结果做格式转换
2. **含 label 查询**: `engine.query()` 后按 `props._label` 二次过滤
3. **含 edge 查询**: 使用 GraphEngine 的 neighbor API + 自己遍历，不依赖 `step.edgeLabel`
4. **aggregate**: 用 `_execAggregation` 等内部函数

## 替代方案 A：直接在 GraphEngine 上加字符串 label 支持

修改 `graph-engine.ts`：
- `_scanNodesByLabel` 除 `typeName === label` 外，也检查 `props._label === label`
- `_executeQueryPlan` 中 edge label 支持字符串→数字的注册表映射

优点：一次改动，engine.query 原生支持 TCK 标签语义
风险：影响现有测试（需验证不回归）

## 替代方案 B：TCK runner 直接调用 GraphEngine 内部方法

```
_tckExecute(plan, data) → engine._executeQueryPlan(plan)
```
前提是解决 label + edge label 兼容性。

## 建议

**先跑一小批 TCK 测试看子集通过率（20 个），确认哪些可以直接用 engine.query()，哪些需要适配。**
如果 >80% 可以直接过，适配性价比高。
如果 <50% 需要适配，则走替代方案 A（改 GraphEngine）。
