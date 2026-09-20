# existentialSubqueries 执行计划

创建时间: 2026-09-03 20:30

## 目标
实现 Cypher `EXISTS { subquery }` 子查询谓词的完整语义，清零 existentialSubqueries 目录 9 个失败，零回归。

## 背景
Cypher 的 `EXISTS { ... }` 是子查询谓词：外层 `MATCH (n) WHERE exists { <subquery> } RETURN n`，
对每个候选 `n`，执行子查询，若子查询返回 ≥1 行则 EXISTS 为 true，否则 false。
子查询可访问外层变量（`n`），子查询内部新增变量不外泄。

## 9 个失败分类
- A. 返回空 row（7 个）：`(n)-->()` / `MATCH (n)-->()` / 嵌套 exists 等，existsFilters 未被正确解析
- B. UndefinedVariable（2 个）：子查询 WHERE 引用外层变量 n，被误报未定义
- C. 缺 SyntaxError（1 个）：子查询含 SET update clause，应抛 InvalidClauseComposition

## 步骤
- [ ] 步骤1: 诊断 - 完整梳理现有 existsFilters 解析 + 执行路径 + 验证路径
- [ ] 步骤2: 解析层 - 支持完整 EXISTS { subquery } 语法（含 MATCH/WHERE/RETURN/WITH/SET/嵌套 exists）
- [ ] 步骤3: 执行层 - 对每个外层候选行执行子查询，判断非空
- [ ] 步骤4: 验证层 - 变量作用域正确处理（外层变量可访问，子查询内新增变量不外泄）
- [ ] 步骤5: InvalidClauseComposition 检测（子查询含 update clause）
- [ ] 步骤6: 严格验收（existential 9/9 + 核心回归 813 + 全量 expression 零回归）
- [ ] 步骤7: Lambertyan 提交

## 当前进度
正在执行: 步骤1
