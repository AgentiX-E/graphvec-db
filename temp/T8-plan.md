# Temporal8 修复计划

当前 7/27 ✅，20 fail 分 4 类：

## Phase 1: 场景 6 (duration ± duration, 8 fail)
根因：`_evalAddSub` 的 `-` 分支使用 `_isDurationStrDirect` 等 inline 函数，
但场景 6 通过 GE 路径执行，表达式 `dur.date - dur2.date` 在 `_formatResultRow` 中
可能不走 `_evalAddSub`。
Plan: 把 `-` 分支的 duration 检测从 inline 函数改为使用全局函数。

## Phase 2: 场景 7 (duration ×÷, 2 fail)
根因：`_durationScale` 产生非整数分量（2.5M）。
Plan: 添加归一化，把非整数月转为天数。

## Phase 3: A — _timeAddDuration 纳秒精度 (4 fail)
根因：纳秒归一化方向错误。
Plan: 修复 `_timeAddDuration` 中 `while (ns >= 1e9)` / `while (ns < 0)` 的进位。

## Phase 4: B — _dateTimeAddDuration 负日期 (6 fail)
根因：setUTCDate 对负天数产生无效日期。
Plan: 用日期算术计算正日期。
