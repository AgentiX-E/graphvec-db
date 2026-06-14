# WHERE + 多 MATCH + 属性投影 — 基础设施层工程

创建时间: 2026-06-13 15:42

## 目标
修复 MatchWhere（30f）、Match3/7/9（57f）、Return（49f）、With（26f）的系统级缺口：
1. WHERE 子句解析 + 过滤执行
2. 多 MATCH 组合（笛卡尔积/嵌套）
3. 属性投影（`a.id`、`a.name`）

## Phase P-1: WHERE 解析（parseQuery 层）

### WHERE AST 结构
```ts
whereClause?: {
  type: 'AND' | 'OR' | 'NOT' | 'SIMPLE'
  left: WhereClause
  right?: WhereClause
  expression?: string // "a:Employee" or "a.name = 'x'" or "n.age > 10"
}
```

### 简单实现（正则解析，非完整 AST）
用正则提取 WHERE 子句文本，拆分为简单条件列表。
每个条件：`variable.predicate` 或 `variable:Label`

### 步骤
- [x] _validatePlan 中提取 WHERE 文本
- [ ] parseQuery 返回 whereConditions: string[]
- [ ] whereConditions 拆分为 (var, op, val) 三元组
- [ ] 标签谓词检测（`a:Employee` → labelFilter）

## Phase P-2: WHERE 过滤执行

### 过滤类型
1. **标签谓词** `a:Employee` — 检查节点 `_label`
2. **属性相等** `a.name = 'Alice'` — 检查节点属性
3. **属性比较** `n.age > 10` — 数值比较
4. **逻辑组合** AND/OR

### 实现位置
在 `_executeViaGraphEngine` 的 `_executeQueryPlan` 之后、结果格式化之前

### 步骤
- [ ] `_applyWhereFilters(records, whereConditions, plan)` 函数
- [ ] 标签谓词过滤（`a:Employee` → 节点 `_label` 检查）
- [ ] 属性过滤（简单 `=` 相等）
- [ ] AND/OR 组合

## Phase P-3: 多 MATCH 组合

### 问题
`MATCH (a)-[:WORKED_ON]->(b), (a)-[:ADMIN]->(b)` 被视为一个遍历链，
但实际是两个独立遍历（a->b 和 a->b），组合为笛卡尔积。

### 修复
- [ ] parseQuery 中识别逗号分隔的 MATCH pattern（步数数组）
- [ ] 在 `_executeViaGraphEngine` 中对两个独立遍历执行 `_executeQueryPlan`
  然后做笛卡尔积组合，再过滤 WHERE

## Phase P-4: 属性投影

### `Return a.id, b.id` 应输出属性值，不是边变量格式
- [ ] 解析 `returnColumns` 中 `a.id` 为 `{var: "a", prop: "id"}`
- [ ] 在 `_formatResultRow` 中投影准确属性

## 当前进度

正在执行: Phase P-1（WHERE 解析）
