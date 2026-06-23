# Phase 21 — VLE（变长路径）支持计划

创建时间: 2026-06-23 13:07

## 目标
实现变长路径（Variable Length Edge）查询支持，覆盖 TCK 中 `path/`、`match/Match2` 场景。

## 范围

### Phase 1 ✅ — Match2 86/86 ✅ (commit 82519d02 + 67234412)
- `[var*]` 边变量正则 → VariableTypeConflict 编译时校验
- isAny 自环边放行（VLE + 单跳）

### Phase 2 — Path 场景 5 fail → 0 ✅

#### 2a: 路径分配解析 `p = (...)`
AS 解析层：在 `buildQueryPlan` / `extractMatch` 中识别 `MATCH p = (` 前缀
- 提取路径变量名 `p`
- 从 MATCH 文本移除 `p =` 前缀，继续 ANTLR 解析
- 存储为 `plan.pathVar`

#### 2b: length() 类型校验（场景 2 & 3）
`_validatePlan` 中检 length(node) 和 length(edge) → SyntaxError: InvalidArgumentType

#### 2c: `_executeVarLenPath` 结果正确（场景 1）
`p = (a)-[*0..1]->(b)` — 当 plan.pathVar 存在时：
- 调用 `_executeVarLenPath` 执行 VLE
- 将路径绑定到 plan.pathVar
- length(p) 表达式求值 → 返回路径长度

### Phase 3 — Path2 场景 2 fail ✅
`MATCH p = (a)-[:REL*2..2]->(b) RETURN relationships(p)`
- `relationships(p)` 函数求值
- 路径绑定确保 p 包含所有边信息（pathEdges）

### Phase 4 — 零退化回归
- `--quick` 4/4 ✅
- full regression (全量 TCK)
- quantifier 场景二次确认

## 当前进度

### ✅ Phase 1 done: Match2 86/86 ✅
- HEAD: 67234412
- --quick 4/4 ✅

### Phase 2-3: Path 5 fail → 0
- [ ] 2a: `p = (...)` 路径分配解析
- [ ] 2b: length() 类型校验
- [ ] 2c: `_executeVarLenPath` invoke + path binding
- [ ] Phase 3: `relationships(p)` / `nodes(p)` function eval
- [ ] git commit
- [ ] --quick regression

## 验证
- 每个子阶段独立 git commit
- `--quick` 回归确认零退化
- 最终全量回归

## 验收标准
1. Path1-3 全部 7/7 ✅（当前 2/7 → +5）
2. Match2 86/86 ✅ 维持不退化
3. `--quick` 全绿 ✅
4. `--full` 全量 TCK 零退化
5. quantifier 604/604 ✅（当前 596/604 = 8 fail 不退化）
