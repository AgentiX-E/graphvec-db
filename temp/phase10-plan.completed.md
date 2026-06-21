# Phase 10 — _labelStrIndex 性能基准测试（spec 化）

创建时间: 2026-06-21 14:35

## 目标
将 `_labelStrIndex` 40x 加速（586ms→15ms）锁定为 vitest spec 级可重复基线

## 步骤

- [ ] **1. 调研现有测试文件**: `src/benchmark/` 目录结构，看看 benchmark.spec.ts 的写法
- [ ] **2. 创建 `src/benchmark/label-str-index.spec.ts`**:
  - `_scanNodesByLabel('Person')` on 100K nodes — 断言 ≤50ms（3σ margin）
  - `_scanNodesByLabel('NonExistent')` on 100K nodes — 0 结果，≤2ms
  - `_scanNodesByLabel` on 0 nodes — 0 结果，≤1ms
  - 混合 label 场景（35K Person + 15K Other）
  - 验证返回值正确（所有 Person 节点都被召回）
- [ ] **3. 验证**: `npx vitest run src/benchmark/label-str-index.spec.ts`
- [ ] **4. 确认**: 运行 3 次，波动 ≤10%
- [ ] **5. 更新 baseline 文档**: docs/benchmark-baseline-20260621.md
- [ ] **6. 验证全量回归**: `--quick` 4/4

## 执行顺序
```
1 → 2 → 3 → 4 → 5 → 6
```

## 当前进度
**Phase 10**: 待开始
