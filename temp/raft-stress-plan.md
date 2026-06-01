# Raft 成员变更 — Stress/分区测试 执行计划

创建时间: 2026-06-01 18:25

## 目标
为 AppMembershipManager 实现 stress 测试 + 分区测试，验证在网络不稳定、并发操作和边界条件下成员变更的正确性。

## 步骤

- [x] 步骤1: 读取完整 app-membership-manager.ts 和 spec，确认最新代码状态
- [x] 步骤2: 创建 stress 测试文件 `membership-manager-stress.spec.ts` (21 tests)
  - [x] 并发提案测试
  - [x] ACK 乱序/延迟测试
  - [x] 高频率重复 add/remove 测试
  - [x] 超时恢复测试
  - [x] Commit 去重测试
- [x] 步骤3: 分区测试
  - [x] 少数 ACK 丢失
  - [x] 部分 commit 丢失
  - [x] 隔离节点提案被忽略
- [x] 步骤4: PreSync + syncCheck 集成 stress
  - [x] syncCheck 连续失败/成功交替（flapping）
  - [x] preSyncCheck 超时 + 恢复
  - [x] syncCheck 长时间返回（接近超时边界）
  - [x] syncCheck 挂起恢复
- [x] 步骤5: 运行全量测试并提交

## 当前进度
✅ 全部完成! 21/21 stress tests passed.
