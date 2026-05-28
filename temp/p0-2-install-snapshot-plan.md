# P0-2 InstallSnapshot 自动化 — 执行计划

创建时间: 2026-05-29 07:27

## 目标

Automate InstallSnapshot with log compaction and crash recovery.

## 步骤

- [x] 步骤1: 阅读现有代码，理解 _triggerSnapshotOnce、handleInstallSnapshot、_tryRegisterOnSnapshot 等
- [ ] 步骤2: 修改 raft-logic-consensus.ts — 添加自动 log compaction trigger（_snapshotThresholdBytes）
  - 添加 _snapshotThresholdBytes: number (default 64MB)
  - _triggerSnapshotOnce 检查 total log bytes > threshold 时触发 engine.exportSnapshot()
  - handleAppendEntries 响应中也检查
- [ ] 步骤3: 修改 raft-logic-consensus.ts — Follower crash recovery
  - handleInstallSnapshot 成功后设置 _lastSnapshotIndex
  - 添加 _recoverFromSnapshot() — 在 start() 中调用
  - start() 中检查 StorageProvider 是否已有 persisted snapshot
- [ ] 步骤4: 修改 raft-logic-consensus.ts — 增强 _tryRegisterOnSnapshot
  - 不静默吞错误，记录日志
  - WASM 不可用时始终使用 TS handler fallback
  - 移除 !WASM 检查，始终走 TS 路径
- [ ] 步骤5: 修改 raft-logic-consensus.ts — 添加 snapshot metrics
  - _snapshotCount, _lastSnapshotSize, _lastSnapshotDurationMs
- [ ] 步骤6: 修改 raft-install-snapshot.spec.ts — 添加新测试
  - Log entry count exceeds threshold → snapshot automatically triggered
  - Follower crash → restart → recovers from StorageProvider snapshot
  - WASM handler unavailable → TS handler used instead
  - Snapshot after compaction → follower can catch up with InstallSnapshot
- [ ] 步骤7: 运行测试，验证通过

## 当前进度

正在执行: 步骤2
