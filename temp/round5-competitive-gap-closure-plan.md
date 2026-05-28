# Round 5 — 竞品 Gap 关闭执行计划

**创建**: 2026-05-28 22:55
**目标**: 关闭审计报告 27 项竞品优化项（P0/P1 优先），保持 Step 1~5 闭环

## 背景

R1-R21 全部 21/21 (100%) ✅ 已完成。当前的 27 项竞品优化项（审计报告 §2.2）是下一阶段核心工作。

## 任务优先级（基于审计报告 + 竞品对比）

| 优先级 | 项目 | 描述 | 预估工作量 | 是否影响核心功能 |
|:------:|:----|:-----|:---------:|:--------------:|
| **P0** | S03 | MiniSearch 全文索引替换纯 Map | 0.5d | 🟡 中等 — 搜索可用性 |
| **P0** | S02 | Schema 类型系统深层集成 | 1d | 🟡 中等 — 数据完整性 |
| **P0** | E01 | mTLS 认证引擎 | 1d | 🟢 低 — 安全增强 |
| **P1** | Q04 | REST API 补齐（边/批量/流式/订阅） | 1d | 🟡 中等 — API 可用性 |
| **P1** | Q05 | Follower/Stale read | 1d | 🟢 低 — 读性能 |
| **P1** | SH03 | Rebalancer 一致性校验 | 1d | 🟢 低 — 分布式正确性 |
| P2 | S01 | batchNeighbors + LRU 缓存 | 1d | 🟢 低 — 性能 |
| P2 | R04 | InstallSnapshot (raft-logic) | 1d | 🟢 低 |
| P2 | O01 | 备份一致性 + 压缩 | 0.5d | 🟢 低 |
| P2 | Q01/Q02/Q03 | 聚合/UNION/优化器 | 2d | 🟢 低 |
| P2 | R08 | readIndex safety | 0.5d | 🟢 低 |
| P2 | SH01/SH02/SH04 | Reshard 自动化 | 2d | 🟢 低 |
| P2 | O02 | 导入流式+批量+并发 | 1d | 🟢 低 |
| P3 | R05 | raft-logic 成员变更绑定 | 1d | 🟢 低 |
| P3 | A01/A02 | graphology adapter + 算法 | 0.5d | 🟢 低 |
| P3 | R01 | WAL fsync 增强 | 0.5d | 🟢 低 |
| P4 | E02/E04/E05 | 多DB路由/HTTPS/RBAC | 3d | 🟢 低 |

## 步骤

### Step 1: 文档同步 ✅
- [x] 读取全部 5 份 WHT 文档 + final-audit-v3
- [x] 发现审计报告大量标注未开始的项目实际代码已实现
- [x] 更新 audit-compiled-v1: S03/E01/S02/Q04 状态 ✅
- [x] 更新「仍存在差距」表格
- [x] 更新优先级路线图

### Step 2: 并行 Gap 关闭 ✅
- [x] **SH03: Rebalancer 一致性校验** — 实现 `computeChecksums()` + `verifyConsistency()`
  - 对每个 Range 计算 NodeId 的 63-bit 聚合哈希
  - 检测节点数偏差、空 range 边界、两次采集不一致
  - 集成测试通过: 191 单元 + 223 集成 ✅
- [x] **Q05: Follower/Stale read** — 实现 `canServeStaleRead()` + `getCommitIndex()`
  - Follower 在 commitIndex 在阈值内时可提供读
  - Leader 始终可读，Candidate 不可读
  - 集成测试通过: 191 单元 + 223 集成 ✅

### Step 3: 深度审查 ✅
- [x] 比较最新代码 vs 所有文档
- [x] 发现 rebalancer.ts 接口间缺失换行 — 已修复
- [x] 发现 deep-research 中 auth.ts/tls.ts 规模描述过时 (~80→476, ~120→361) — 已修复
- [x] Rebalancer tests 挂起状态 — 已更新为 ✅
- [x] 全量测试通过: 191 单元 + 223 集成 ✅
- [x] 文档一致性确认: 白皮书/技术设计/进度追踪对齐

### Step 4: 迭代 — 并行 Phase 1-3 + Reshard 自动化 ✅
- [x] **数据库删除 Phase 1-3** (database-manager.ts):
  - Phase 1: Tombstone 写入 (`{dataDir}/.tombstone.json`) — database/requestedAt/gracePeriod/gcEarliestAt/phase
  - Phase 2: Grace Period + `restoreDatabase()` — 冷静期内可恢复，移除 tombstone 重新注册
  - Phase 3: GC Cleanup — `gcDatabases()` 扫描过期 tombstone 后物理删除 (fs.rmSync)
- [x] **SH01: Reshard 数据迁移完整性** (rebalancer.ts):
  - `migrateRangeComplete()` — fence + flush(wait ops drain) + verify(checksum) + cleanup
  - `_flushOps()` — 轮询等待指定 range 的 ops count 降为 0
- [x] **SH02: Reshard 状态持久化** (rebalancer.ts):
  - ReshardStateEntry 类型 + reshardStatePath 配置
  - `_persistReshardState()` / `_clearReshardState()` / `recoverInterruptedMigrations()`
- [x] **SH04: Auto-split 自动化** (rebalancer.ts):
  - `checkAndSplit()` — 检测 range 节点数超 maxNodesPerRange (默认 10000) 触发
  - `_splitRange()` — 按 nodeId 范围对半分割，新建 range + 迁移一半节点 + 更新路由表
- [x] 全量测试通过: 191 单元 + 223 集成 (26 files) ✅

### Step 5: 总结报告 [待开始]
- [ ] 生成 Round 5 总结报告
- [ ] 更新最终审计结论
