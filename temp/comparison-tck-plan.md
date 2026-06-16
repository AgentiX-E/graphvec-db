# Comparison TCK 修复计划

创建时间: 2026-06-16 14:15

## 目标
Cypher TCK Comparison 测试 72/72 全通过（当前 48/72，24 fail）

## 已修交付物（本轮会话）
- ✅ string 字典序比较（`_compareValues`）
- ✅ 跨类型比较返回 null（`_compareValues`）
- ✅ NaN 与数字比较返回 false，跨类型 null
- ✅ `_extractChain` — 通用链式比较识别（`a < b = c <> d`、`1 < n.num < 3`）
- ✅ `_findTopLevelOp` — 子串保护（`1 <> 2` 不误匹配）
- ✅ `_listLexCompare` — List 字典序 + null 传播

## 剩余 24 fail 分类

### 类别 A: Graph Engine 全链路问题（23 个） ⛔ 不在此次修复范围
所有 row count 失败（20 个） + Large int string + Node comparison + long chain operators
- 根本原因：graph-engine 的 `_matchFilter` 不支持复杂 WHERE（toInteger、链式比较等）
- 后处理 `_evaluateExpression` 虽存在，但 GE 在 MATCH 阶段就返回了 0 行
- 这是 GE 层面的 MATCH → 节点扫描 → WHERE 过滤全链路问题
- 需要 GE 的 `_executeQuery` → `_executeViaGraphEngine` → GE native API 调用链的深度修复

### 类别 B: UndefinedVariable 编译时语法错误（1 个） ⛔ 不在本次范围
- `s.name = undefinedVariable` — 需要符号表检测未定义变量
- 架构变更：parseQuery → 需要 SymbolTree/SemanticAnalysis

## 当前策略
1. 确认 vitest 回归未破坏（744/744）
2. 提交当前修改
3. 标记 Comparison 48/72 为当前进展，说明剩余失败类型的根因
4. 进入下一个表达式 TCK 目录（如果可以推进的话）

## 决策记录
- `_listLexCompare` null 传播逻辑：等长部分任何 _compareValues 返回 null → 整体 null；不等长部分多出元素含 null → 整体 null
- `_findTopLevelOp` 子串保护：单字符 op 前一个字符是 `<`、`>`、`=` 则跳过
- `_extractChain` 重叠过滤：如果操作符起始位置在前一个操作符范围内，跳过

## Open TODOs
- [ ] vitest 回归验证
- [ ] 提交 git
- [ ] 汇报给 Lambert
