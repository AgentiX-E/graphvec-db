# typeConversion 目录 Remediation 执行计划

创建时间: 2026-09-03 00:56

## 目标

将 typeConversion 目录 26 个 TCK 失败全部清零，零退化。

## 步骤

- [ ] 步骤1: 跑 typeConversion 全目录，按失败场景精确分类（错误类型 + 根因子类）
- [ ] 步骤2: 定位最集中子类根因（可能是类型转换/类型检查语义）
- [ ] 步骤3: 修复实现层（不碰 .feature / grammar）
- [ ] 步骤4: 核心回归 813 + typeConversion 全量 + 全量 expression 三层验证零退化
- [ ] 步骤5: 提交（Lambertyan，英文注释/commit）

## 当前进度

正在执行: 步骤1
