# Round 2: 全量 5 步执行计划

**创建**: 2026-05-28 09:25
**指令**: Lambert 要求新一轮完整的 5 步流程

## 步骤总览

- [ ] **Step 1**: 同步所有技术文档 ✓（已确认一致，无冲突）
  - Scope 分离正确：多数据库为独立设计文档，R1-R21 单数据库架构
  - 唯一新增：multi-database-arch-design.md §8(删除数据库)+§9(执行计划)
  - 其他文档不需修改

- [ ] **Step 2**: 全速推进关闭所有级别的 Gap
  - 并行写 3 个 gap-close 测试 + 删除数据库三阶段逻辑测试
    - 🟡 R4: 加精确的 logger.assert 测试验证 alert 输出
    - 🟡 R16: CURVE bad-key / missing .pub 场景测试（mock ZMQ）
    - 🟡 R21: barrier 测试（用 SimulatedRaft + range-instance 验证）
    - 🆕 新增: 删除数据库三阶段 tombstone→grace→GC 逻辑验收（mock fs）
  - 执行全量验收: `npm run test:all`
  - 标记不可关闭项

- [ ] **Step 3**: 验收成功后深度审查
- [ ] **Step 4**: 有回退，无则继续
- [ ] **Step 5**: 总结汇报

## 当前

正在执行: Step 2 — 全量验收 `npm run test:all`

关键: 用并行 batch 避免单进程超时

### ✅ 新增测试 (全部通过)
| 测试文件 | 结果 | 验证内容 |
|----------|------|----------|
| R4 `r4-alert-logger.test.ts` | 3/3 ✅ | local write 不变式, replicate success:true, 无 peer 场景 |
| R16 `curve-error-scenarios.test.ts` | 8/8 ✅ | parsePubFilename 鲁棒性, readAllPeerKeys 容错性 |
| R21 `barrier-linearizable.test.ts` | 7/7 ✅ | 选举、写入后 barrier 可见性、顺序保证、follower 委托 |
| 删除数据库 `database-deletion.test.ts` | 18/18 ✅ | 三阶段删除全场景 (tombstone/grace/GC/恢复/边界)
