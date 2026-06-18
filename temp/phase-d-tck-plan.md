# Phase D — TCK 剩余模块全覆盖计划

创建时间: 2026-06-18 18:50

## 目标
Expression TCK 剩余模块推至 100%：

| 模块 | 当前 | 目标 | 优先级 |
|------|:----:|:----:|:------:|
| Pattern | 3/50 | P3 | 低 — 依赖 GE MATCH |
| List | 168/185 | P1 | 高 — eval 层可修大部分 |
| Quantifier | 602/604 | P1 | 中 — GE 可变长路径 |
| Aggregation | 7/35 | P2 | 中 — eval + GE |
| Temporal | 696/1004 | P3 | 极低 — GE 层 |
| Comparison | 70/72 | P0 | 高 — 2 个 eval 层 |
| Graph | 61/61 | ✅ | |
| Map | 43/44 | ✅ | |
| Precedence | 121/121 | ✅ | |
| Boolean | 150/150 | ✅ | |
| Literals | 131/131 | ✅ | |
| Mathematical | 65/65 | ✅ | |
| Null | 32/32 | ✅ | |
| String | 100/100 | ✅ | |
| Conditional | 24/24 | ✅ | |
| TypeConv | 95/95 | ✅ | |
| Existential | 8/8 | ✅ | |

Expression 总场景: ~1970（约 1688/1970 passed，~282 fail）

## 策略

### Phase D1 — Quick Wins (P0-P1)
每个模块一个 sub-agent，并行分析失败场景。

### Phase D2 — GE 层修复
**不可修改 graph-engine.ts**，只能在 query-engine.ts 外层绕行。

### Phase D3 — ANTLR 层修复
ANSI 适配器限制，eval 层可绕行。

## 当前进度

正在执行: 启动分析
