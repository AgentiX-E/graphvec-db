# [with-orderBy] [45] 多 WITH 链变量传递（ArgumentError）

创建时间: 2026-08-23 07:40

## 目标
修复 WithOrderBy1 [45]（10 个 example 全失败，ArgumentError）。
查询:
```
WITH <values> AS values
WITH values, size(values) AS numOfValues
UNWIND values AS value
WITH size([x IN values WHERE x < value]) AS x, value, numOfValues
  ORDER BY value
WITH numOfValues, collect(x) AS orderedX
RETURN orderedX = range(0, numOfValues-1) AS equal
```
错误: `range(0, numOfValues-1)` 里 `numOfValues` = null（ArgumentError at range）。

## 根因（已定位）
`plan.with` 只保留最后一个 WITH（ast-to-plan-v2.ts:1153 循环覆盖），
中间 `WITH values, size(values) AS numOfValues` 丢失 → numOfValues 无法求值。

## Steps
- [ ] 步骤1: 精确摸清多 WITH 链在解析/执行层的消费链路（plan.with 单值 vs unwinds 数组 vs withColumns 列表）
- [ ] 步骤2: 确定最小且优雅的修复方案（保留 WITH 链 or 折叠投影）
- [ ] 步骤3: 实现
- [ ] 步骤4: 验证 [45] 全部 10 example + with-orderBy 零回归
- [ ] 步骤5: commit as Lambertyan

## 当前进度
正在执行: 步骤1
