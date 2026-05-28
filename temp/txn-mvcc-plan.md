# Txn-MVCC 执行计划

创建时间: 2026-05-29 06:42

## 目标
对 `src/core/transaction.ts` 进行 MVCC 升级：
1. **TransactionManager** — 全局管理 snapshotId 和读写锁
2. **增强 Transaction** — 添加 MVCCSnapshot、writeSet/readSet、主动提交/回滚
3. **GraphEngine 接口升级** — beginTransaction / withTransaction / execInTransaction
4. **测试覆盖** 9 个场景

## 步骤

- [x] 步骤1: 阅读现有代码（交易/图引擎/存储接口）
- [x] 步骤2: 重写 transaction.ts — TransactionManager + 增强 Transaction
- [x] 步骤3: 在 graph-engine.ts 中添加 beginTransaction / withTransaction / execInTransaction
- [x] 步骤4: 重写 transaction.spec.ts — 9 个测试场景
- [x] 步骤5: npm run test:core-base 确认通过
- [x] 步骤6: 提交 checkpoint + 汇报

## 当前进度

正在执行: 步骤2
