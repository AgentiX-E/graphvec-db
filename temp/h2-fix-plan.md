# H2 合规修复方案

## 问题描述

`_formatResultRow` 的 `a.id` 属性解析分支（line ~2816-2842）中：
- `isSourceVar` 只与 `steps[0].source` 比较
- 非 source 变量统一回退到 `r.__targetProps`（最后一步 target 的属性）
- **中间步变量**（如 `RETURN b, c` 中的 `b`）的属性会被错误地导向最后一步 target

## 修复方案

**修改 `_formatResultRow` 的 `propMatch` 分支**，增加 `__targetPropsMap` 查询：

```typescript
// propMatch 分支中，在 !isSourceVar 检查之后、回退之前：
if (!isSourceVar && r.__targetPropsMap && variable in r.__targetPropsMap) {
  // 从 __targetPropsMap 取中间步变量的属性
  result[rc] = r.__targetPropsMap[variable]?.[property] ?? null
  continue
}
```

## 验证

1. `MATCH (a)-[:R1]->(b)-[:R2]->(c) RETURN a.name, b.name, c.name`
   - a.name → r.props（source=firstStep）
   - b.name → r.__targetPropsMap['b'].name（中间步）
   - c.name → r.__targetProps（最后一步 target）

2. 现有单步和两步用例不受影响（`__targetPropsMap` 只在 steps>1 时存在）
