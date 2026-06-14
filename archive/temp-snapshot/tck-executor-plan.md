# Executor 层 31 fail 修复计划

创建时间: 2026-06-10 ~19:00

## Group 1: _evaluateAddExpression 新增类型支持

| Test | Query | 修复点 |
|:----|:------|:--------|
| MAP-04 | `RETURN {person: {name: 'Alice'}} AS data` | 加 `if (expr.type === 'MAP')` → 递归 eval 每个 value |
| LIST-21 | `RETURN [x IN [1,2,3,4] WHERE x > 2] AS filtered` | 加 `FILTER`/list comprehension eval |
| STR2-07/08 | `toUpper('hello') + ' ' + toUpper('world')` | `METHOD_CALL` + `ADD` eval chain |
| MATH2-14 | 复杂数学表达式 | `POWER`/`MODULO` 递归 eval |

## Group 2: CASE WHEN

| Test | Query | 修复点 |
|:----|:------|:--------|
| CASE-10 | `MATCH (n) RETURN CASE WHEN exists(n.email) THEN 'has_email' ELSE 'no_email' END` | CASE WHEN expr eval in SELECT |

## Group 3: 缺失 builtin functions

| Test | 函数 | 修复点 |
|:----|:-----|:--------|
| CALL-01~08 | 各种 CALL PROCEDURES | CALL executor 返回多行 |
| CALL-09 | CALL + UNION | CALL + UNION 组合 exec |
| ADMIN-11 | DROP CONSTRAINT | 改 test (PEG now parses it) |

## Group 4: FOREACH + MERGE

| Test | 修复点 |
|:----|:--------|
| FOREACH-19/20 | FOREACH body SET exec |
| MERGE-EXT 3 tests | MERGE ON MATCH/ON CREATE |
| UNWIND-20/23/24 | UNWIND 嵌套表达式 exec |

## Group 5: 复杂表达式

| Test | 修复点 |
|:----|:--------|
| CPX-20 | multi-reltype var-len edge exec |
| DELETE-EXT-01 | DELETE 扩展 |
| SUBQUERY_EXISTS 等 | EXISTS subquery exec |

## 修复策略

1. 先修 Group 1（最通用，影响面广）
2. 再 Group 2 + 3（边修边验证）
3. Group 4 + 5 最复杂（内部 eval 逻辑）

每次修完一个 Group 跑全量 TCK 确认无 regression。
