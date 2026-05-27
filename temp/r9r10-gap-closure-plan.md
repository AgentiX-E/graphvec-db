# R9/R10 Gap 关闭计划

创建时间: 2026-05-27 23:08

## 目标

- 应用层心跳 + 多数派确认的方案取代 raft-logic WASM 依赖
- 所有文档保持方向一致
- 全量验收测试 (0 failed, 0 skipped)
- 最终代码审查 vs 审计报告

## 步骤

### Phase 1: 文档统一 (并行)
- [ ] 更新 `docs/r9-r10-technical-design.md` §2/§3 — 加入应用层心跳/成员变更方案
- [ ] 更新 `temp/r9-r10-plan.md` — 反映新策略
- [ ] 更新 `temp/final-audit-v3.md` — R9/R10 状态改为已实现
- [ ] 规划两个新类: `AppHeartbeatManager` + `AppMembershipManager`

### Phase 2: 应用层心跳 R9 实现 (顺序: 核心→测试)
- [x] 创建 `src/consensus/app-heartbeat-manager.ts` — 心跳管理器 ✅
- [ ] 更新 `MultiLeaderReplication` 集成心跳管理器
- [ ] 创建 `src/consensus/app-heartbeat-manager.spec.ts` — 单元测试
- [ ] 创建 `test/integration/heartbeat-partition.test.ts` — 集成测试

### Phase 3: 应用层成员变更 R10 实现 (顺序: 核心→测试)
- [x] 创建 `src/consensus/app-membership-manager.ts` — 成员变更管理器 ✅
- [ ] 更新 `MultiLeaderReplication` 集成成员变更
- [ ] 创建 `src/consensus/app-membership-manager.spec.ts` — 单元测试
- [ ] 创建 `test/integration/membership-app.test.ts` — 集成测试

### Phase 4: 全量验收
- [ ] 新测试加入 `package.json` 的 `test:int` 分组
- [ ] 运行 `npm run test:all` → 0 failed, 0 skipped

### Phase 5: 代码审查
- [ ] 最新代码 vs final-audit-v3.md 对比
- [ ] 最新代码 vs docs/r9-r10-technical-design.md 对比
- [ ] 设计模式一致性检查
- [ ] 潜在问题列表

## 当前进度

正在执行: Phase 1
