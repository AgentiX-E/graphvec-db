# backup.ts 增强 — 增量备份 + 校验和 执行计划

创建时间: 2026-05-23 11:00

## 目标
在 `src/ops/backup.ts` 中增加增量备份和校验和验证，不破坏现有 API。

## 步骤

- [x] 步骤1: 分析现有代码结构（完成）
- [x] 步骤2: 实现 BackupResult 接口 + SHA-256 校验
- [x] 步骤3: 实现 createIncrementalBackup 方法
- [x] 步骤4: 实现 verifyBackup (SHA256)
- [x] 步骤5: 重命名现有 verifyBackup -> verifyConsistencyMarker (保持兼容)
- [x] 步骤6: 更新 exports
- [x] 步骤7: 添加新测试
- [x] 步骤8: 执行验证

## 当前进度
全部完成 ✅

## 验证结果
- `npx jest src/ops/backup.spec.ts --no-coverage`: 32 passed (✅)
- `npx tsc --noEmit`: 0 errors (✅)
