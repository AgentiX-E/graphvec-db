# Phase 12 — 最高标准全面攻坚

创建时间: 2026-06-14 22:20

## 目标
三项并行推进，全部达到生产级标准。

## 三项任务

### A — TCK 变量长度路径（约 50+ scenarios）
- 步骤: 将 TCK featuress 中未匹配的 var-len 集中，接入 step-definitions
- 关键: `I get` 步骤中的 `relationships` 需要新的 path 处理
- 交付: TCK 变量长度 100%

### B — INDEX-driven seed 加速
- 现状: `_indexRegistry` 已注册但不加速 seed
- 方案: 在 seed 前查 `_getIndex`，直接构建索引节点 ID set，跳过全量扫描
- 仅对 `CREATE INDEX ON :Label(prop)` 且查询匹配 `WHERE label.prop = val` 时生效

### C — 多图 GE 实例隔离
- 现状: `USE db` 只切换 `_activeDatabase`，不创建新 GE
- 方案: `_executeViaGraphEngine` 中切换 DB 时用 `_getDatabaseInstances` 的隔离 GE
- 关键: 多图模式下每个 DB 独立 GE instance

## 优先级

A = 最高（TCK 覆盖率最大缺口），B = 次高（性能），C = 次高（CATALOG 完整性）

A + B 同时并行（独立模块），C 在 A 之后。

## 当前进度

正在执行:
- ✅ B INDEX 加速 — 已存在（indexedEqFilters 在 Phase 8 实现）
- [x] 并行 spawn sub-agent A (TCK 分析) + C (多图 GE)
- [ ] 等待两个 sub-agent 完成
- [ ] 根据报告决定后续
