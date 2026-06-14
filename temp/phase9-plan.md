# Phase 9: 剩余 CVE 全修复 + 后续最优路径

## 范围
P0: 所有剩余 CVE 修复（C4, H1（确认）, H2, M1-M5）
P1: TCK 验证 + 新增 CVE 测试
P2: 后续路径——多图命名空间 / 性能基准

## 步骤

### C4: 字符串注入防护（3min）
- 文件: `src/query/query-engine.ts` line 676-726 (`_injectParamsToPlan`)
- 修复: 字符串参数统一做引号安全转义（`'` → `\'`）
- 验证: vitest 708/708

### H1: 确认状态并添加注释（1min）
- 已在 line 1728 从 plan.filters 移除，_walkMultiSteps 不会再收到
- 修复: 更新报告注释

### H2: 多变量解析（15min）
- 文件: `src/query/query-engine.ts` line 2695-2780 (`_formatResultRow`)
- 修复: 构建完整的 stepIndex→varAlias 映射
- 验证: 写一个包含 RETURN a, b, c 的测试
- 风险: 中等复杂度，TCK 未触发

### M1: labelExpr 去重 + M2: String() 强转 + M3: returnVar 粒度 + M4: CREATE_CONSTRAINT 错误提示 + M5: 多列 ORDER BY（15min）

### P1: 全量回归验证（30min via sub-agent）
- vitest 3 文件 + TCK quick

### P2: 后续路径选择
1. 多图命名空间（CATALOG/USE/CREATE DATABASE）
2. 变量长度路径的 TCK 测试覆盖
3. 性能基准测试
