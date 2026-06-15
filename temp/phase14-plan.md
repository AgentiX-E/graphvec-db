# Phase 14 — MERGE + FOREACH + LOAD CSV 三项交付

创建时间: 2026-06-15 09:30

## 并行策略

三项高度独立，可全并行。但各自复杂度不同：

| 任务 | 复杂度 | TCK 基线 | 交付路径 |
|------|--------|----------|----------|
| MERGE 完整语义 | M | 31/31 → 目标~60 | 修复 + 扩展 |
| FOREACH 子句 | H | 0 → 新实现 | 全栈新写 |
| LOAD CSV | M | 0 → 新实现 | 全栈新写 |

**最优路径：3 个 sub-agent 全并行**

1. sub-agent A: MERGE 完整语义修复
2. sub-agent B: FOREACH 子句全栈实现
3. sub-agent C: LOAD CSV 全栈实现

完成后主 session 做集成回归验证。

## A: MERGE 完整语义（~60 TCK scenarios）

### 当前状态
- Merge5 TCK 29/29 已通过
- 基础 MATCH-or-CREATE 模式工作
- 缺口：ON CREATE SET / ON MATCH SET 子句

### 实现策略
- 在 `_executeViaGraphEngine` 中分析 plan.mergeItems
- 对每个 merge item：
  - 尝试 MATCH 模式（现有能力）
  - 如果未匹配 → CREATE + 执行 ON CREATE SET
  - 如果已匹配 → 执行 ON MATCH SET
- AST 解析器需要解析 ON CREATE/ON MATCH

### 文件
- `src/query/ast-to-plan-v2.ts` — AST 解析
- `src/query/query-engine.ts` — `_executeMerge` 函数
- `src/query/query-engine.spec.ts` — 测试

## B: FOREACH 子句（全栈新实现）

### 语法
```
FOREACH (var IN list | update1, update2, ...)
```

### 实现策略
- AST：识别 FOREACH 子句，解析变量 + 列表表达式 + 更新语句
- Plan：`plan.foreach: [{ var, list, updates: [...] }]`
- 执行：GE 执行后遍历 `plan.foreach`，对列表每个元素执行 update 语句
- update 支持：CREATE, SET, DELETE, REMOVE

### 无 TCK 覆盖
- 自行编写测试覆盖各种 list 类型（字面量、属性引用、参数）

## C: LOAD CSV（全栈新实现）

### 语法
```
LOAD CSV FROM 'file:///path.csv' AS row [WITH HEADERS | WITH NO HEADERS] [FIELDTERMINATOR ';']
RETURN row
```

### 实现策略
- AST：解析 LOAD CSV 子句（url, as var, headers flag, delimiter）
- 执行：`fs.readFileSync` + CSV 解析（手动 split，无外部依赖）
- 行内省略处理（引号内逗号）

### 测试
- 创建临时 .csv 文件
- 验证 headers/no headers 模式
- 验证自定义分隔符
- 验证空行/换行

## 步骤

### Step 1: Spawn 3 sub-agents 并行
- [ ] sub-agent A: MERGE 完整语义
- [ ] sub-agent B: FOREACH 全栈
- [ ] sub-agent C: LOAD CSV 全栈

### Step 2: 集成回归
- [ ] 723+ vitest 不退化
- [ ] TCK 全量回归

## 当前进度

已完成:
- [x] C (LOAD CSV): 代码已写，9/9 测试通过，需 commit
- [x] 主 session 分析 MERGE + FOREACH 现状

进行中:
- [ ] A (MERGE): 执行层处理 mergeOnCreate/mergeOnMatch（AST 已解析，plan 已存，缺执行）
- [ ] B (FOREACH): 全栈新实现

### A: MERGE ON CREATE/MATCH 执行层

AST 解析已有（`plan.mergeOnCreate`/`plan.mergeOnMatch` 存了 `{property, value}[]`），缺执行。

方案：
1. 在 `_executeViaGraphEngine` 的 merge 分支（`type === 'MERGE'`）中，在执行创建前先做一次 delabeled MATCH
2. 如果匹配到了 → 跳过创建，执行 `mergeOnMatch` setClauses
3. 如果没匹配 → 执行创建，再执行 `mergeOnCreate` setClauses
4. SET 复用现有 `plan.setClauses` 执行逻辑（line 2585-2605）

### B: FOREACH 子句

新实现，需要：
1. AST: `plan.foreach: [{variable, list, updates}]`
2. 执行: 遍历 list items，对每个 item 执行 updates（CREATE/SET/DELETE/REMOVE）
3. 测试: 字面量列表、变量引用、空列表
