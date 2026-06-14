# query-engine 全面修复计划

## 阶段概览

| Phase | 内容 | 预计文件数 | 测试影响 |
|-------|------|-----------|---------|
| 1 | _formatResultRow 修复（B1#1 表达式别名 + #3 null fallthrough） | 1 | ✅ 已修复 |
| 2 | DML 路径修复（B2: MERGE + DELETE + SET） | 1 | ✅ 已修复 |
| 3 | aggregate _buildDmlRows 修复（B3#1 非count聚合） | 1 | ✅ 已修复 |
| 4 | parseQuery 异常处理（B4: try-catch + _validatePlan） | 3 | ✅ 已修复 |
| 5 | 多跳target 别名 + 边变量属性（B1#2/#4/#5） | 1 | **进行中** |
| 6 | 全量回归验证 | — | ⏳ Phase 5 后 |
| 7 | 文档同步 | 1 | ⏳ 最终 |

## 执行顺序策略

按**影响程度**排序，每次修复后立即回归，防止增量退化。

### Phase 1: _formatResultRow 显性 bug

**B1#1** `1+1 AS sum` 表达式别名：
- 定位: `_formatResultRow` L2488 `!expr.includes('.')` 分支
- 修复: 在 L2488 前加 `!/^[a-zA-Z_]\w*$/.test(expr)` 检测，非变量名表达式→走求值/fallback
- 测试: 增加 `RETURN 1+1 AS sum` test case

**B1#3** null fallthrough：
- 定位: for 循环末尾无默认赋值
- 修复: 加 `if (!(rc in result)) result[rc] = null`

**commit tag**: p1-formatResultRow

### Phase 2: DML 执行

**B2#1 MERGE 路径**：
- `plan.mergeNodes` → 复制到 `plan.createNodes`
- `plan.mergeOnCreate` / `plan.mergeOnMatch` → 赋给对应的 setClauses / createProps
- L1718 加 `plan.type === 'MERGE'` 分支

**B2#2 DELETE 路径**：
- `_executeViaGraphEngine` 中 DELETE 时，构造 GE 匹配→标记→用 `ge.deleteNode()` 删除
- 临时 GE 的更改不会持久化——在 DML 语义下需要持久化（暂存到 `nodes` 对象而不是临时 GE）

**B2#3 SET 路径**：
- GE 匹配后，对结果节点的 props 做赋值
- 持久化到调用方的 `nodes` 对象

**commit tag**: p2-dml

### Phase 3: aggregate _buildDmlRows

**B3#1** 非 count 聚合：
- L2540: 替换 `agg.fn === 'count' ? allNodes.length : 0`
- 实现 `_computeAggregate(nodes, agg.fn, propField)`: sum/avg/min/max 的逻辑
- 支持 `collect`: 聚合数组

**commit tag**: p3-aggregate

### Phase 4: parseQuery 异常处理

**B4#1** parseQuery 内部 try-catch：
- 包装 `parseCypherToPlan` → 抛 `QueryParseError`

**B4#2** _executeQuery 调用 `_validatePlan`：
- 在 `_executeQuery` 入口加 `_validatePlan(plan, originalQuery)`

**B4#3** execQuery / GraphEngine.query() 加 try-catch

**commit tag**: p4-parse-exceptions

### Phase 5: 多跳target + 边变量(可选)

**B1#2** 多跳 `__targetProps`：
- 需要 `__targetPropsMap` 结构，较复杂
- 如果现有 TCK 没有这种用例，可以暂缓

**B1#4/#5** 边变量 `__edgeLabel` / `r.weight`：
- rawWithEdges 中补充 `r.__edgeLabel` 赋值
- propMatch 路径边变量检测

**commit tag**: p5-multihop-edge

### Phase 6: 全量回归

```bash
bash scripts/full-regression.sh --quick
```

### Phase 7: 文档同步

更新 memory/2026-06-14.md + MEMORY.md

## 风险控制

- 每个 Phase 前 git commit checkpoint
- 每个 Phase 后全量回归（vitest 622 + 71 + TCK all）
- 发现退化立即 git checkout 回退
