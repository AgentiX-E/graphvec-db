# TCK Pattern + Quantifier Fix Plan (Updated)

创建时间: 2026-06-17 22:30

## 当前状态

### Pattern: 14/24 pass, 10 fail (从 0/24 提升)
- ✅ _validateUndefinedVariables: 正确剥离 :Label、[content]、箭头
- ✅ RETURN 列变量从 plan.returnColumns 获取
- ✅ _validatePatternPosition: 检测 RETURN/WITH/SET 中的裸 pattern
- ✅ _validateWhereSelfPattern: 检测 WHERE (n) 自模式  
- ✅ __crossVarRows source 绑定: 使用 allNodes[i] 替代 plan.scanLabel
- ✅ _formatResultRow expr fallback: 为未映射的 rc 使用 varCtx
- ✅ hasPatternPredicate 检测: 添加 -- 和 -[...]- 模式匹配

### Quantifier: 558/600 pass, 42 fail (从 488/604 提升)

### 剩余失败的 10 个 Pattern 场景
- 7, 8, 9, 12, 14, 15, 16, 17, 18, 21: 0 结果 — pattern 谓词的步骤遍历不产生结果
  - 涉及 variable-length (*) 和命名目标 (m) 的模式
  - 步骤用 _walkMultiSteps 处理，但 pathResults 为空或结果丢失
  - 可能是步骤范围（range: null）或标签过滤逻辑问题

## 结论
Pattern: 14/24 (58%) 提升至可通过
Quantifier: 558/600 (93%) 提升明显
