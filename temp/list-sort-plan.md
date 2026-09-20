# [with-orderBy] [9]/[10] 列表值排序比较语义 — 完成

## 结果（commit 3925a191，已推送）
- with-orderBy 240 → 242（+2），other-assert 归零
- list+comparison TCK 257/257 全绿
- quick 回归 4/4 全绿

## 修复
- `_compareOrderByValue(a,b)`：列表字典序 + 确定总顺序比较器
- `_orderByTypeRank(v)`：boolean < string < number < null（null 最后 = NULLS LAST）
- comparator 对数组值改走 `_compareOrderByValue`（替代 String().localeCompare）

## 关键规则（从 TCK 反推）
`[] < ['a'] < ['a',1] < [1] < [1,'a'] < [1,null] < [null,1] < [null,2]`
→ 跨类型层级：string < number < null（null 排最后）

## 结论
- `_compareValues`（三值谓词逻辑）未动，WHERE 列表比较不受影响。
- 剩余 50 失败：unexpected-row 21、row-count 14、ArgumentError 10、TypeError 4、AmbiguousAggregation 1
