# [with-orderBy] UNWIND 字符串字面量引号丢失修复 执行计划

创建时间: 2026-08-21 17:50

## 目标

修复 with-orderBy TCK 中 UNWIND 列表字符串字面量引号丢失导致的排序错误：
[7] "null" !== "''"、[8] 等字符串排序场景。

## 根因（已精确定位）
1. extractUnwind 剥离字符串引号 → 空串/空格与字面量 '' 无法区分
2. _resolveUnwindList 对裸 token 一律 _evaluateExpression → null
3. unwind.list 两个消费点契约冲突（executor vs TCK seed）

## Steps
- [x] 步骤1: 修改 extractUnwind，字符串字面量保留引号（raw text）
- [x] 步骤2: 修复 query-executor.ts CREATE+UNWIND 的 elem 还原（用 _resolveUnwindList）
- [x] 步骤3: 修复 step-definitions.ts（TCK seed）的 list 还原（用 _resolveUnwindList）
- [x] 步骤4: 修复 _splitListItems 加 () 深度（range/date 含逗号不切分）
- [x] 步骤5: with-orderBy 全量 + list/string/comparison TCK + quick 回归零回归验收
- [x] 步骤6: commit as Lambertyan → a6db1950 (pushed)

## 最终状态（commit a6db1950）
with-orderBy 218/292；list+string+comparison TCK 284/289；quick 回归 4/4。
