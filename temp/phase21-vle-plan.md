# Phase 21 — VLE（变长路径）支持计划

创建时间: 2026-06-23 13:07

## 目标
实现变长路径（Variable Length Edge）查询支持，覆盖 TCK 中 `path/`、`quantifier/`、`match/Match2` 等场景。

## 范围

### 第一阶段 — VLE 基础（`(n)-[*2..5]->(m)`）
- [ ] 1a: GE 的 `_executeVariableLengthTraversal` 接入 query-engine
- [ ] 1b: 解析层 `[*min..max]` 语法支持（AST → plan）
- [ ] 1c: 基础固定长度 `[*n]` + 范围 `[*n..m]`
- [ ] 1d: 无界 `[*]` / `[*n..]`

### 第二阶段 — VLE 增强
- [ ] 2a: 标签过滤 `(n)-[:Label1|Label2*1..5]->(m)`
- [ ] 2b: WHERE 过滤 + VLE 组合
- [ ] 2c: 路径变量 `p = (n)-[*2..5]->(m)`

### 第三阶段 — 量化路径（Quantifier）
- [ ] 3a: `{n,m}` 量化语法
- [ ] 3b: `*` / `+` 量化简写

## TCK 基线确认 (10:58 全量 regression)
- Match2.feature: 86场景, 77 pass, **9 fail** (2 运行时 + 7 编译时)
- Path1-3: 7场景, 2 pass, 5 fail（关联修复）

## 9 fail 分解

### 运行时 (2)
1. **Self-loop undirected `()-[]-()`** — `isAny` 分支 `neighborIdx !== fidx` 过滤了自环边
   - 修复：自环时让 `neighborIdx = fidx`
2. **VLE 变量绑定 `[r*]`** — VLE BFS 的 `paths = [...varLenSet].map(idx => [startIdx, idx])` 只返回目标节点，不绑定边变量

### 编译时 (7)
3-9. **`VariableTypeConflict` — `[r*]` 中 `r` 被 `v !== '*'` 过滤** — 边变量正则 `\[(\w+)\s*(?::|\])` 不匹配 `[r*]`
   - 修复：添加 `\[(\w+)\s*\*` 匹配

## 当前进度

Phase 1: Match2 9 fail → 2 fail（7/9 ✅）

- [x] 分析 GE 现有 VLE API + 确认 TCK 基线
- [x] 修复1: `[var*]` 边变量正则（编译时 7 fail → 0 ✅）
- [x] 修复2: isAny VLE 自环放行（运行时 1 fail → 0）
- [ ] 修复3: 非 VLE 自环 `type(r) AS r` 表达式未解析到 returnColumns（运行时 2 fail 待修）
- [ ] fix+commit
- [ ] `--quick` 回归确认零退化
- [ ] 最终全量回归

## 验证
- 每个子阶段独立 git commit
- `--quick` 回归确认零退化
- 最终全量回归
