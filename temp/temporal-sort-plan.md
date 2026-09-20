# [with-orderBy] Temporal sort ordering (WithOrderBy1 [15]-[20]) 执行计划

创建时间: 2026-08-22 11:45

## 目标
修复 with-orderBy TCK 中 temporal 类型（time/localdatetime/datetime）的 ORDER BY 排序。
根因有两类：
1. year 0-99 → JS Date.UTC 映射成 1900+year（date({year:1}) → 1901）
2. 带时区 time/datetime 用字符串比较而非 UTC 绝对时刻比较

## Steps
- [x] 步骤1: 复现定位 year=1 → 1901（Date.UTC 经典坑）
- [x] 步骤2: `_utcDateFromYmd`（setUTCFullYear 避免 1900+ 映射）+ `_resolveDateFromMap` 全部走它
- [x] 步骤3: `_fmtUtcDate`（year 补零 4 位）+ date/localdatetime/datetime 输出点替换
- [x] 步骤4: `_temporalSortKey`（带时区 temporal 归一化 UTC）+ comparator 接入
- [x] 步骤5: 清理遗留 debug（DUR DATE+TIME / T8_PLUS_DUR）
- [x] 步骤6: temporal TCK + with-orderBy + quick 回归验收
- [x] 步骤7: commit as Lambertyan → c6725353 (pushed)

## 最终状态（commit c6725353）
- temporal 表达式 TCK 1004/1004 全绿（零回归）
- with-orderBy 218 → 240（+22）
- quick 回归 4/4 全绿
