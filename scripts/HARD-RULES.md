# HARD RULES — 防卡死防重启（第六版，零容忍版）

> 违反任何一条都曾导致 session 崩溃或 TLE。此版本为根本解决方案。

## Rule 0: 禁制令——永不跑 `vitest run src/`
**`src/` 下有 300+ spec 文件，涵盖 DatabaseManager、Redis、Persistence 等外部依赖模块。**
- 某些文件依赖外部服务（Redis/mock-server），setup 阶段会永久挂起
- 某些文件有 50+ open/close 循环（benchmark 套件），跑完需要数分钟
- ❌ 命令示例：`vitest run src/`、`vitest run src/ --no-coverage`、`vitest run src/**/*.spec.ts`
- ✅ 替代：显式列出核心文件名：`vitest run src/core/graph-engine.spec.ts src/query/query-engine.spec.ts src/query/query-engine-dml.spec.ts`

## Rule 1: 禁制令——永不串行 exec
**`exec("cmd1 && cmd2")` 等 $SHELL 串行链导致 tool call 无输出时 TLE。**
- ❌ `exec("vitest run x && full-regression.sh")` — 两步串行，总时间 = vitest + TCK = 60s+ → TLE
- ❌ `exec("timeout 60 cmd; exit 0")` — shell 包装不能绕过 tool-level timeout
- ✅ 两步分两个独立的 `exec` 调用，各带自己的 timeout

## Rule 2: 所有 exec 必须显式传 timeout（不超过 30s）
- `vitest` 跑核心 3 文件：`timeout=30`
- `cucumber-js` 跑单 feature：`timeout=30`
- TCK 全量（clauses/expressions）：**必须用 sub-agent**，不用 `exec`
- `full-regression.sh --quick`：`timeout=120`

## Rule 3: 任何测试执行 >60s 的必须用 sub-agent
- 全量回归（--quick 或 --full）→ sub-agent，yield
- TCK clauses 全量 → sub-agent
- **主 session 永远不等待超过 60s 的测试命令**

## Rule 4: 回复不超过 15 行（代码 diff 除外）
- 大段内容写文件，回复只写路径和摘要数字
- 测试结果不写表格，只写 "708/708 ✅"
- 紧密贴合 AGENTS.md 中「回复风格：回答简短一些」

## Rule 5: sub-agent 超时兜底
- sub-agent spawn 时设 `runTimeoutSeconds`（默认 120s）
- sub-agent 结果可能不完整（超时/错误），先 commit 已有代码再检查

## Rule 6: 先 git commit 再验证
- 写完代码先 `git add + commit`
- 验证用 sub-agent 或 bg，绝不阻塞主回复

## 恢复协议（死透后）
当用户说「你又挂了/卡了」：
1. 先 kill all zombie: `ps aux | grep -E vitest|cucumber|full-reg`
2. 再 `git log -3` 看最近 commit 有没有已完成的代码
3. 再 `git status` 看脏文件
4. 汇报：已提交了什么、脏了什么、然后继续推进
