# Phase 14 执行计划 — DML 持久化 async 改造

基线：40/40 PASS (commit `b048b1f6`)
创建时间: 2026-06-22 13:25

## 实际结果
Phase 14 验证了 DML 持久化的 async 状态并修复了缺失的 await：

| 操作 | 状态 | 修复 |
|------|------|------|
| CREATE nodes upsertNode | ✅ 已有 await | 不需改 |
| CREATE edges upsertEdge | ✅ 同步 storage 直接写入 | 不需改 |
| SET upsertNode | ❌ 缺失 await | **加了 await** (line 4296) |
| DELETE deleteNode | ✅ 已有 await | 不需改 |
| REMOVE upsertNode | ✅ 已有 await | 不需改 |
| MERGE 变量验证 | ❌ `_validateUndefinedVariables` 未识别 MERGE 变量 | **加了 (?:CREATE\|MERGE)** |

## 架构结论
- `_executeViaGraphEngine` 每次都 close+reopen GE（复用目录，不损失数据）
- allNodes 仍然是唯一数据源，DML 修改 allNodes + await 同步 GE 存储
- 消除 allNodes 的代价 > 收益（allNodes 在 seed 阶段的插入可靠性高于 GE durability）
- TCK DML 280 场景 + DML 15 spec + 全量 ~4632 零退化

## 已提交
`438bdd01` — Phase 14: DML 持久化 async 修复
- SET upsertNode await
- _validateUndefinedVariables MERGE 变量识别
- 全量回归 0 fail

## 当前进度
已全部完成 ✅
