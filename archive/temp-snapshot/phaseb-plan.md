# Phase B: Direct `_executeQueryPlan` Call

**创建时间**: 2026-06-12 11:40

## 目标

`_executeViaGraphEngine` 不再通过 `_planToQuery` → `ge.query(string)` → `parseQuery` 绕路，
改为直接调用 `(ge as any)._executeQueryPlan(plan)`。

## 变更

### 删除
- `_planToQuery()` 函数（~96 行，不再需要字符串生成）
- `_returnCols()` 辅助函数（GE 已做列投影）
- `_postProcessResults()` 中的列投影部分

### 保留
- `_orderByField()` — 用于 ORDER BY 后处理
- `_postProcessResults()` 中的 ORDER BY / HAVING / SKIP/LIMIT — GE 不处理这些
- `_executeUse()` — 仍在顶层逻辑中

### 修改
- `_executeViaGraphEngine()`：
  - 插入 nodes 后，直接调用 `(ge as any)._executeQueryPlan(plan)`
  - 格式化结果（NodeRecord[] → QueryRow[]）
  - postProcess（ORDER BY/HAVING）

## 步骤

- [x] 步骤1: 写计划文件
- [ ] 步骤2: 修改 `_executeViaGraphEngine` — 删除 `_planToQuery` 调用，直接 `ge._executeQueryPlan(plan)`
- [ ] 步骤3: 删除 `_planToQuery`、`_returnCols` 函数
- [ ] 步骤4: 简化 `_postProcessResults`（去掉列投影）
- [ ] 步骤5: npx tsc --noEmit 编译检查
- [ ] 步骤6: TCK 3 轮全绿

## 当前进度

正在执行: 步骤1
