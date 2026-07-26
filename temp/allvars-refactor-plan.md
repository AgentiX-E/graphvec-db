# 方案: 重构 allVars 填充逻辑（comma 适配）

## 核心思路
comma 情况下，allVars 填充分两阶段：
1. 从 matchingPath（通过 defStepIdx 匹配）遍历所有 steps，填充 source/targetAlias
2. 不依赖 lastStepV.source 的单独填充

## 具体改动

### Phase 1: 统一 allVars 填充
替换现有的三步填充（lastStepV.targetAlias + boundedPaths + lastStepV.source）为：
- 找到 matchingPath
- 遍历 psi = 0..steps.length-1:
  - step[psi].source → allNodes[matchingPath[psi]]
  - step[psi].targetAlias → allNodes[matchingPath[psi+1]]
- 遍历 psi = steps.length..matchingPath.length-1（逗号步对应路径余量）

### Phase 2: source/target 不再依赖 allNodes[i] 和 lastStepV
- 删掉 lastStepV.source 的单独填充
- 所有变量统一从 matchingPath 获取

### Phase 3: 清理 debug 代码
