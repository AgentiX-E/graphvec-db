# 索引加速查询扫描 - 执行计划

创建时间: 2026-06-14 17:51

## 目标

在 `_executeViaGraphEngine` 的 seed 阶段，利用已注册的 label+property 索引做预过滤加速。

## 步骤

- [x] 步骤1: 理解现有代码结构
- [x] 步骤2: 添加 `_getIndex(label, property)` 函数（查询 registry）
- [x] 步骤3: 在 seed 循环前的 skipNodeIndices 构建阶段，检查 plan.filters 中的 EQ filter 是否匹配已注册索引
- [x] 步骤4: 当匹配时，利用索引做预过滤加速
- [x] 步骤5: 运行测试验证不退化（86 tests pass ✅）

## 当前进度

✅ 全部完成
