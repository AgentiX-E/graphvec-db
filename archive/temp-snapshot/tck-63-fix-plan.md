# 修复 63 个 TCK Fail — 执行计划

创建时间: 2026-06-10 17:45

## 目标
将 master 分支 TCK 从 953/1016 → 1016/1016 PASS

## 分层策略（按依赖链推进）
| Layer | 类型 | 个数 | 难度 | 策略 |
|:-----:|:----|:----:|:----:|:-----|
| 1 | Parser 不识别的语法 | 5 | ⭐ | 补 PEG 规则 |
| 2 | Preprocessing 不足 | ~16 | ⭐⭐ | 加 _preprocessQuery 规则 |
| 3 | engine planFromAST 缺失 | ~22 | ⭐⭐⭐ | 补 planFromAST 分支 |
| 4 | executor 复杂交互 | ~20 | ⭐⭐⭐⭐ | 深改 executor |

## 当前进度

### Layer 1: Parser 语法补全 (5) ✅
- [x] IDX-07 NODE KEY constraint → 补 PEG NODE KEY 语法
- [x] IDX-08 CREATE + SHOW INDEX → 补 PEG 链式命令 (CreateIndexThenShowStatement)
- [x] IDX-09 CREATE + SHOW CONSTRAINT → 补链式规则 (ConstraintThenShowStatement)
- [x] IDX-10 DROP CONSTRAINT by name → 补 DROP CONSTRAINT name 语法
- [x] TCK-SUB-09 CALL 子查询 IN TRANSACTIONS OF N ROWS → CallStatement 改用 DMLStatement

### Layer 2: Preprocessing 扩展 (~16)
- [ ] EDGE-14/15/16 变长路径范围
- [ ] EDGE-02/03 CREATE 关系带属性/并 RETURN
- [ ] FOREACH-15/20, FOREACH2-01/04/05/07/12
- [ ] UNWIND-19, UNW2-03/04/08
- [ ] MERGE-17/19/20
- [ ] DELETE_EXT-08
- [ ] CALL-01/03/04/05/06/07/08/09
- [ ] LIST-21 RETURN list WHERE
- [ ] CPX-20/26

### Layer 3: engine planFromAST (~22)
- [ ] SETOP-01~20 (20 tests)
- [ ] MAP-04
- [ ] CASE-10

### Layer 4: executor (~20)
- [ ] STR2-07/08
- [ ] MATH2-14
- [ ] LIST2-02
- [ ] SQ2-10
- [ ] 剩余复杂组合
