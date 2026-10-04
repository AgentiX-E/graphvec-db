# Return6[13] 修复计划 — 变长路径 + WITH 聚合折叠

创建时间: 2026-09-27 11:20

## 目标

修复 `MATCH p=(a:T {name:'a'})-[:R*]->(other:T) WHERE other<>a WITH a.name AS name, other.name AS other, min(length(p)) AS len RETURN name, collect(other) AS others, len`

期望: `{name:'a', others:['c','b'], len:1}`（当前返回 `[]`）

## 根因（三层叠加）

1. **变长路径未构建 `p` 路径对象**：line 4667 `multiStepRaw.push({id, props, __targetProps, __crossVarRows})` 只放 target 节点属性，无 `p` 路径变量（含边序列 + length=跳数）。→ `length(p)` 无处求值。

2. **`_groupAggregateWithRows`（line 2314）对表达式聚合/变长路径失效**：
   - 分组键 `name`/`other` 从 WITH 表达式 `a.name`/`other.name` 经 `split('.').pop()` 拆出，但 flat 行键是 `a`/`other`（节点对象），不是 `name` → 分组键全 `__NULL__`。
   - 聚合 field `length(p)` 在 flat 行无键 → `min([])=0`。
   - 折叠后 `rec` 只含 `{name,other,len}`，丢失 `a`/`other` 节点对象。

3. **WHERE 在 WITH 折叠后执行（line 7061）**：`other<>a` 求值时 `a` 丢失、`other` 变字符串 `"b"` → null → 行全过滤 → `[]`。

## 正确语义

执行顺序：MATCH → WHERE(other<>a，用原始节点变量) → WITH 分组(name/other)+min(length(p)) → RETURN collect(other)+len

3 条候选路径：a→b(len1)、a→c(len1)、a→c→b(len2)
分组后：{name:'a',other:'b',len:min(1,2)=1}、{name:'a',other:'c',len:1}
collect(other) 去重 = ['c','b'] → 期望 others:['c','b']，len:1

## 步骤

- [ ] 步骤1: 变长路径构建 `p` 路径对象（含 length=跳数、边序列），随 multiStepRaw 传递
- [ ] 步骤2: `_groupAggregateWithRows` 正确处理：分组键基于节点对象属性求值；聚合 `length(p)` 基于 p.length；折叠保留节点变量
- [ ] 步骤3: WHERE 在 WITH 折叠前用原始 MATCH 变量执行（需谨慎，不破坏其他 case）
- [ ] 步骤4: 验证单 scenario → Return6.feature 全量 → 742 核心回归
- [ ] 步骤5: 清理探针，Lambertyan 英文提交

## 当前进度

正在执行: 步骤1（先确认 `p` 路径对象应如何构建、length 如何计算）
