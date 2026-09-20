# Pattern Predicate 修复执行计划

创建时间: 2026-08-29 13:00
状态: 执行层修复完成（已提交）；编译期校验作为下一迭代

## 成果（commit 已提交）
Pattern1 数据执行类场景（Matching）从 0 → 21 passed：
- [1]-[6] 基本方向（out/in/undirected）+ 边类型
- [8] 变长 undirected、[10] 长度2
- [12]-[21] 命名两端、NOT、AND/OR 组合

## 修复的三层根因
1. `_evalPatternPredicate` 正则不支持匿名端点 `()` / `(:C)` → 改为 `\w*`，匿名 = 存在性检查
2. `nodeIndexOf` 对匿名节点（无 `_alias`）无法定位 → 增加 label+属性指纹 fallback
3. 方向语义混淆（反向边被误匹配）→ edgeExistsFromTo + reachable 改为严格方向
4. `_resolveWherePatternPredicates` 下游 `_isPatternPredicate` 无条件 true 抢走结果 → 改为优先求值重写后的 whereBodyExpr

## 下一步（独立迭代）
- [10] 14 例：UndefinedVariable 编译期校验（pattern 内未绑定变量）
- [11] self pattern `(n)` → InvalidArgumentType
- [22][23][24] RETURN/WITH/SET 里 pattern → UnexpectedSyntax
- Pattern2 (11 个)：Pattern Comprehension `[p=(n)-->() | p]` 生成 path 列表（独立特性）

## 验收基线
- Pattern1：21 passed / 18 failed（剩余全为编译期错误类）
- quick 回归 4/4 全绿
- 待跑表达式 TCK 全量确认零回归
