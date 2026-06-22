# Phase 17: CALL YIELD 全修复计划

基线：`657abf43`
创建时间: 2026-06-22 14:42

## 目标
CALL TCK 15/52 → 52/52 全绿

## 失败模式分析（37 fail）

### Group 1: 缺少内置过程（~20 fail）
- `test.doNothing` — 无参数无返回的测试过程
- `test.labels` — 同 db.labels 但测试用命名空间
- `test.my.proc` — 测试格式校验
- `db.createLabel` — 创建标签的内置过程
- `db.createProperty` — 创建属性的内置过程
- `db.labels` 已有但对 YIELD 支持不完整

### Group 2: 变量验证（~5 fail）
- `_validateUndefinedVariables` 不识别 CALL 定义的变量
- CALL YIELD 的变量应在校验时注册到 definedVars

### Group 3: 错误类型不匹配（~7 fail）
- `test.my.proc` 应抛 ProcedureNotFound/ProcedureError
- `db.labels()` 无参调用格式
- `ParameterMissing` 未正确抛出的场景

### Group 4: SUBQUERY 执行 dispatch（~5 fail）
- `CALL { ... }` plan.type='CALL' 未路由到子查询执行

## 策略
按 fix 难度排序，优先修收益最大的：

1. 添加 `test.doNothing`、`test.labels`、`db.createLabel` 等内置过程
2. `_validateUndefinedVariables` 添加 CALL 变量识别
3. 错误类型映射（ProcedureNotFound, ProcedureError, ParameterMissing）
4. CALL subquery dispatch

## 步骤
1. 按 feature 逐个跑 → 记录每个 fail 的根因
2. Group 1 修复：内置过程注册
3. Group 2 修复：变量验证
4. Group 3 修复：错误类型
5. Group 4 修复：subquery 执行
6. 全量回归

## 原则
- 每修复一组 git commit
- 增量回归（只跑 CALL feature）
