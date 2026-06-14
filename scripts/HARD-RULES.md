# HARD RULES — 防卡死防重启

> 违反以下任何一条都曾导致 session 崩溃或 TLE。

## Rule 1: 永远不并行跑多个大 TCK 进程
**cucumber-js + tsx 是重型进程**（每个加载整棵依赖树，~2s 冷启动）。不要同时跑超过 2 个。

## Rule 2: exec 必须 always 带 timeout 参数
- 任何可执行命令都显式传 timeout，不给默认值
- 预估值：vitest < 30s，单 feature cucumber < 30s，全量 > 120s

## Rule 3: 回复不超 15 行（代码 diff 除外）
- 长内容写文件后指向路径
- 不写 TCK 结果表格，只写摘要数字
- 不贴大段代码

## Rule 4: sub-agent 是唯一全量回归方式
- 主 session 永远不等回归完成
- 用 `sessions_spawn` 异步跑，yield 后等结果
- 不要自己等全量回归

## Rule 5: 超过 60s 无输出视为崩溃
- 收到用户抱怨卡死时，立刻 kill 所有 background 进程
- 用 `process(kill)` 杀掉所有 session
- 用 `exec(kill -9)` 杀僵尸 vitest/cucumber
