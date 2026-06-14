# HARD RULES — 防卡死 · 防重启 · 最高标准

> 此文件是 Lambert 的强制规则，优先级高于所有其他指令。
> 每次 session 启动时必须读取并强制执行。

## Rule 1: 绝不在主 session 同步等长任务

**禁止**：
- ❌ `exec "cmd"` 不设 `yieldMs` 或设 `yieldMs=0`（默认 10s 也会卡）
- ❌ `process(poll)` 在主 session 中长时间等待
- ❌ 写一个命令期望它在主 session 里跑完

**规则**：
- 任何 >3s 的命令 → `exec` + `background: true`（立即后台）或 `yieldMs: 30000` 且用 sub-agent
- 用 `process` 检查状态 → 只做一次 quick poll，结果立即汇报
- **绝对禁止**在主 session 死等回归/TCK

## Rule 2: 全量回归必须 sub-agent 跑

```bash
# 永远不要直接在主 session 跑：
bash scripts/full-regression.sh  # ❌ 死等 3min

# 应该：
sessions_spawn task="cd /home/admin/openclaw/workspace/agentiX-graphvec && bash scripts/full-regression.sh 2>&1" label="full-regression"
sessions_yield()
# 然后等 push 结果
```

## Rule 3: Context 70% 就投降

| Context % | 行为 |
|-----------|------|
| <50% | 正常干活 |
| 50-70% | 每步完成后 flush 到文件 |
| >70% | **暂停一切新任务**，写完整 snapshot 到文件后回复简短总结 |
| >85% | 只能做一个 tool call 就 flush |

**检测方法**：每次回复前检查 `session_status` 的 `Context`。

## Rule 4: 每完成一个 Phase 必须 commit + push

```
git add -A
git commit -m "phase-xxx: description"
git push  # 如果有 remote
```

**为什么**：如果重启，git log 就是唯一恢复手段。不要依赖 context 恢复。

## Rule 5: 回复必须简短到极致

- 先给结论（1-3 行）
- 有需要才给详情
- 不要重复粘贴大段代码或日志
- 状态更新不要超过 10 行
- **不要输出整段 markdown 表格**（context 杀手）

## Rule 6: "重复直到全部解决" 的正确执行方式

不要试图在一条 message 里做所有事。正确流程：

1. 写执行计划 → 1 次 tool call
2. 执行修复 → N 次 tool call（每个修复 1-3 次）
3. spawn sub-agent 跑回归 → 1 次 tool call → `sessions_yield`
4. sub-agent 结果到了 → 继续下一步
5. 如果回归失败 → 回退 git checkout → 单独分析失败

**绝对禁止**：
- ❌ 在主 session 跑大回归
- ❌ 不写 plan 直接开修
- ❌ 修一个 bug 后不等回归就修下一个

## Rule 7: 主 session 只做三件事

1. **写代码/plan**（小步，每步 commit）
2. **spawn sub-agent** 跑验证
3. **向用户汇报**（极简）
