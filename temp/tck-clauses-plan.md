# TCK clauses 清零计划

创建时间: 2026-09-25 15:10

## 目标
将 openCypher TCK `clauses` 目录全部场景驱动到 0 失败（当前 1191 scenarios，77 failed）。
核心回归 742 passed 零退化。Lambertyan 身份提交，英文注释/文档/commit。

## 失败基线（串行跑，干净数据）
| 目录 | 失败数 |
|------|--------|
| return | 27 |
| create | 8 |
| with-where | 8 |
| return-orderby | 7 |
| delete | 6 |
| unwind | 5 |
| with-skip-limit | 5 |
| remove | 4 |
| set | 4 |
| match | 2 |
| merge | 1 |
| **合计** | **77** |

## 策略
按失败数从高到低、且优先「根因可能高度相关」的目录分组，逐目录：
1. 跑该目录单 feature 定位具体失败场景（精确 scenario:line）
2. 归类根因（通常是同一底层 bug 引发多场景失败）
3. 修复 → 重跑该目录 → 跑核心回归 742 确认零退化
4. 提交（Lambertyan / 英文）

## 迭代顺序
- [ ] Phase A: return (27) + return-orderby (7) —— RETURN 投影/排序，根因可能共享
- [ ] Phase B: create (8) + delete (6) + remove (4) + set (4) —— DML 写操作
- [ ] Phase C: with-where (8) + with-skip-limit (5) —— WITH + 过滤/分页
- [ ] Phase D: unwind (5) + match (2) + merge (1) —— 收尾杂项

## 当前进度
正在执行: 基线收集（已完成）。下一步 Phase A: return + return-orderby。
