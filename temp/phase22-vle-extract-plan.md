# Phase 22 — VLE 模块提取 + 代码质量提升

## 目标
将 `_executeVarLenPath`（397 行内联函数）从 `query-engine.ts` 提取为独立文件 `src/query/var-length-path.ts`，并清理已知的死代码和重复分支。

## 验收标准
1. `--quick` 4/4 全部通过 ✅
2. Match2 86/86 ✅ + Path 7/7 ✅ + quantifier 604/604 ✅
3. `var-length-path.spec.ts` 17/17 ✅（扩充到 25+）
4. 提取后 query-engine.ts 减少 ~400 行

## 步骤
1. 创建 `src/query/var-length-path.ts`：导出 `executeVarLenPath` 函数
2. 创建模块内需要的类型定义和辅助函数（`BfsEntry`, `_edgeToRelObj`）
3. 清理死代码：with 聚合路径的重复实现、无用变量
4. 更新 `query-engine.ts`：删除内联函数，改为 import
5. 扩充 `var-length-path.spec.ts`：添加 VLE BFS、自环、路径变量、WITH 投影测试
6. 验证：`--quick` + Match2 + Path + quantifier

## 当前进度
- [x] Step 0: 深入阅读分析 `_executeVarLenPath` 完整 397 行代码
- [ ] Step 1: 创建独立模块
- [ ] Step 2: 更新调用点
- [ ] Step 3: 清理死代码
- [ ] Step 4: 扩充测试
- [ ] Step 5: 全量验证
