# V14i: 剩余 4 项真实实现执行计划

创建时间: 2026-06-03 16:20

## 目标
为 4 个已有生产代码但缺 spec 的模块编写测试 + 补齐 UNWIND runtime spec

## 项

### Phase 1: planner-bridge.spec.ts（443 行生产代码）
- `OptimizerBridge` 有：executeOptimized / executeOptimizedString / _executeOptimizedIR / _executeChildren / _executeNode / _collectNeighbors
- filter pushdown / limit early cutoff / project / sort / skip / union
- **测试目标**: Scan filter pushdown → Limit early cutoff → Filter → Project → Sort → Skip → Union → 完整 pipeline
- 预计: ~15 tests

### Phase 2: embed-viz.spec.ts（320 行生产代码）
- `reduceWithPCA` / `getPCALoadings` / `reduceWithTSNE` / `forceDirectedLayout`
- PCA: 矩阵乘法、降维、可逆性
- t-SNE: 概率矩阵、KL 散度迭代、perplexity
- Force-directed: 弹簧力模型、布局收敛、节点稳定
- **测试目标**: 输入/输出维度校验、算法可重复性、边际场景（空数组、单点、所有点重合）
- 预计: ~15 tests

### Phase 3: batch-processor.spec.ts（37 行生产代码）
- `splitIntoBatches` / `processInBatches`
- **测试目标**: 分块正确性、批量异步处理、边界值（0、1、大于数组长度）
- 预计: ~8 tests

### Phase 4: UNWIND runtime spec
- query-engine.ts 中已有 UNWIND executor（`plan.unwind` 分支）
- **测试目标**: 简单数组展开、引用变量展开、WITH 链式传递、空数组、嵌套展开
- 预计: ~8 tests

## 当前进度

## 当前进度

✅ Phase 1: planner-bridge.spec.ts 19/19 ✅ + `limitPushdown` SORT 修复
✅ Phase 2: embed-viz.spec.ts 26/26 ✅
✅ Phase 3: batch-processor.spec.ts 12/12 ✅
✅ Phase 4: unwind.spec.ts 7/7 ✅ + `_executeUnwind` runtime 真实实现

# V14i 完成

- **8 个新文件**：planner-bridge.spec.ts / embed-viz.spec.ts / batch-processor.spec.ts / unwind.spec.ts
- **1 个生产代码修复**：limitPushdown 不应越过 SORT 下推
- **1 个生产代码新增**：_executeUnwind runtime 执行器
- **共 64 新增 spec tests**：19 + 26 + 12 + 7 = 64 ✅
