# Phase 22 — CASE WHEN 表达式支持计划

创建时间: 2026-06-23 18:48

## 目标
在表达式引擎中实现完整的 CASE WHEN 支持，覆盖 Simple CASE 和 Search CASE 两种形式。

## 验收标准
1. Conditional 目录全部场景 ✅（目前 13/13，实际是 1 个 Outline × 12 values + 1 coalesce）
2. CASE WHEN 在 VLE 路径和 GE 路径都正确求值
3. `--quick` 零退化

## 执行方案

### 方案：表达式引擎实现（推荐）
在 `_evaluateExpression` 上游实现 `CASE WHEN ... END` 作为特殊表达式类型，不依赖 GE 的 `_execCaseColumns`。

解析方式：
1. ANTLR AST 中提取 CASE WHEN（当前 ANTLR 语法不认识 CASE WHEN 表达式）
2. 文本正则回退解析 `CASE ... WHEN ... THEN ... ELSE ... END`
3. 构建 `_builtinFunctions.caseWhen` 函数或专用 `_evalCaseWhen` 分支

### 步骤
1. 分析现有文本正则解析（query-engine.ts line 1195-1215）的覆盖能力
2. 确认 ANTLR 语法是否识别 CASE WHEN（.g4 文件）
3. 在 `_evaluateExpression` 中添加 `CASE` 表达式检测分支
4. `_evalCaseWhen` 实现（评估 WHEN 条件，返回匹配的 THEN 值）
5. GE `_execCaseColumns` 路径双轨修复（如需）
6. Conditional 目录验证
7. `--quick` 回归

## 当前进度
- [ ] Step 1: 分析现有实现
- [ ] Step 2: ANTLR 兼容分析
- [ ] Step 3: 表达式引擎实现
- [ ] Step 4: VLE 路径适配
- [ ] Step 5: 验证 + 回归
