# MW2 Phase Final — 修复计划

## 目标
从 6e2674dd 出发（已有 _ceComma guard），修复剩余的 7 个 MW TCK 失败场景，目标 34/34。
保持 GE 622 ✅ 和 QE 71 ✅ 零回归。

## 失败分析

All 7 失败共享同一根因：allVars 和 __crossVarRows 填充不完整，导致 WHERE 过滤器丢失变量。

### 具体：MW2[1] — comma-separated MATCH
- `_ceComma` 检测正确 ✅ → boundedTargetIndices = interEnds 正确 ✅
- 但 WHERE a.id=1 AND c.id=2 需要 allVars['a'] 和 allVars['c']
- **当前 allVars** 只填充 lastStepV.source（从 allNodes[i] 出发，在 comma case 中是 first available 节点）
- **修复**：从 matchingPath 遍历所有 steps 填充 allVars

### 具体：MW2[2] — RETURN out.name
- effectiveRetVar='out' 正确 ✅
- boundedTargetIndices 正确 ✅
- `out.name` 需要 out 变量在 __crossVarRows 中有完整 props（name 属性）
- **修复**：allVars 所有 steps 的 source+target 变量到 __crossVarRows

### 具体：MW3[2]、MW3[3] — disjunctive/multi predicates
- 同上，缺失中间变量

### 具体：MW6[6]、[7]、[8] — OPTIONAL MATCH
- OPTIONAL MATCH 有额外 steps 合并到主 plan 中
- allVars 不完整导致 WHERE filter 失败

## 修复方案

### 1. allVars 统一填充（query-executor.ts ~960-990 行）
替换现有的 lastStepV-based allVars 填充为从 boundedPaths/matchingPath 自动推导的完整填充：

```typescript
// 从 boundedPaths 中找匹配的路径
const matchingPath = boundedPaths?.find(p => p[p.length-1] === targetIdx)
if (matchingPath && plan.steps) {
  // 遍历所有步，填充 source 和 targetAlias 变量
  for (let psi = 0; psi < matchingPath.length; psi++) {
    const nodeIdx = matchingPath[psi]
    if (nodeIdx === undefined || nodeIdx < 0 || nodeIdx >= allNodes.length) continue
    const node = allNodes[nodeIdx]
    if (!node) continue
    
    if (psi < plan.steps.length) {
      const step = plan.steps[psi]
      // Fill source variable
      if (step.source && !allVars[step.source]) {
        allVars[step.source] = { _label: node._label || 'Default' }
        for (const k of Object.keys(node)) {
          if (k !== '__edges' && k !== 'props' && !k.startsWith('__'))
            allVars[step.source][k] = node[k]
        }
      }
      // Fill targetAlias variable (from next node in path)
      const tgtIdx = matchingPath[psi + 1]
      if (step.targetAlias && !allVars[step.targetAlias] && tgtIdx !== undefined && allNodes[tgtIdx]) {
        allVars[step.targetAlias] = { _label: allNodes[tgtIdx]._label || 'Default' }
        for (const k of Object.keys(allNodes[tgtIdx])) {
          if (k !== '__edges' && k !== 'props' && !k.startsWith('__'))
            allVars[step.targetAlias][k] = allNodes[tgtIdx][k]
        }
      }
    }
  }
}
```

### 2. __crossVarRows 全量注入（已存在于 dcdcbb96，但被 6e2674dd 覆盖）
从 allVars 到 geNode.__crossVarRows 的全量映射（dcdcbb96 的第二段 FIX）。

### 3. _ceComma 的 boundedTargetGuard（已存在于 6e2674dd）
保持现有逻辑。

## 步骤
1. 应用 allVars 统一填充
2. 确保 __crossVarRows 全量注入存在
3. 运行 MW TCK 验证
4. 运行 full-regression --quick 验证零回归
