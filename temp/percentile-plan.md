# Percentile Functions (Aggregation6) 执行计划

创建时间: 2026-08-26 22:59

## 目标
实现 `percentileDisc()` / `percentileCont()` 聚合函数，使 Aggregation6.feature 5 个场景全绿（含参数越界 NumberOutOfRange 校验）。

## 场景清单
- [1] `percentileDisc(n.price, $p)`：3 例（0.0→10.0, 0.5→20.0, 1.0→30.0）
- [2] `percentileCont(n.price, $p)`：3 例（同上）
- [3] `percentileCont` 参数越界（p=-1/1000/1.1）→ ArgumentError NumberOutOfRange
- [4] `percentileDisc` 参数越界 → 同上
- [5] `percentileDisc(0.90, deg)`（参数顺序颠倒，deg 是值）→ ArgumentError NumberOutOfRange

## 根因
1. **validator 白名单** `BUILTIN_FN_NAMES` + 排除列表无 percentile → `SyntaxError: UnknownFunction`（executor-validators.ts:376）
2. **`_parseAggregate`** 用 `.split('.').pop()` 提取 `prop`，双参 `percentileDisc(n.price, 0.5)` 被拆成 `prop="5"`（错误）
3. **`_executeAggregation` / `_computeAggregate`** 无 PERCENTILEDISC/PERCENTILECONT 分支 → 返回默认 0
4. **参数越界校验缺失**：p 需 0<=p<=1，否则 ArgumentError NumberOutOfRange

## 实现步骤
- [ ] 1. validator 白名单 + 排除列表加入 percentileDisc/percentileCont（大小写不敏感）
- [ ] 2. `_parseAggregate` 扩展：识别 percentile 双参数，保留完整 field，正确提取值字段 prop + percentile 参数
- [ ] 3. `AggColumnInfo` 增加 percentile 参数字段（如 `pctArg`）
- [ ] 4. `_executeAggregation` 提取 percentile 值 + 传 percentile 参数到 `_computeAggregate`
- [ ] 5. `_computeAggregate` 实现 PERCENTILEDISC（最近秩）与 PERCENTILECONT（线性插值）+ 越界抛 NumberOutOfRange
- [ ] 6. 编写单元测试（正常 + 越界 + 边界 0.0/1.0）
- [ ] 7. 跑 Aggregation6 feature 全绿 + quick 回归 + 表达式 TCK 零回归
- [ ] 8. Lambertyan 提交

## 关键语义（Neo4j / openCypher）
- `percentileDisc(value, p)`：value 升序排序后，取 `ceil(p * n) - 1` 索引（p=0→min, p=1→max, p=0.5→中位）
- `percentileCont(value, p)`：`(n-1)*p` 位置线性插值
- percentile 参数 p 必须 0<=p<=1，否则 ArgumentError NumberOutOfRange
- 值参数是聚合列（跨行），p 是标量参数

## 当前进度
正在执行: 步骤 1
