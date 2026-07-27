# MW2[1] & MW2[2] Root Cause Analysis

## 执行摘要

两个 MW2 场景的失败有两个独立的根因，分别在解析器（Parser）和图形引擎（GE）执行层：

| 场景 | 根因位置 | 问题 |
|------|----------|------|
| MW2[1] | `ast-to-plan-v2.ts` / `extractMatch()` | 逗号分隔 MATCH 模式的 `currentSource` 未正确重置 |
| MW2[2] | `graph-engine.ts` / `_executeQueryPlan()` | 单跳遍历忽略 `step.direction`，总是查 outgoing 邻居 |

---

## MW2[1] 详细分析

### 现象
查询返回 0 行，预期返回 2 行 (`d = (:A)` 和 `d = (:D)`)。

### 解析后的计划 (parseQuery)
```json
steps: [
  { source: "a", direction: "any", targetAlias: "b" },
  { source: "b", direction: "any", targetAlias: "c" },
  { source: "c", direction: "any", targetAlias: "d" },
  { source: "d", direction: "any", targetAlias: "a" },
  { source: "a", direction: "any", targetAlias: "d" }  // ← BUG: 应该是 source: "b"
]
```

### 根因
在 `ast-to-plan-v2.ts` 的 `extractMatch()` 函数中（~line 1348-1450）：

1. **所有** `PatternElementChain` 被扁平化到一个数组中（line 1362: `findAllChildren(matchCtx, 'PatternElementChainContext')`）
2. `currentSource` 是一个全局变量，跨所有链累积
3. 逗号分隔的子模式之间没有重置 `currentSource`

**执行流程:**
```
PatternElement 1: (a)--(b)--(c)--(d)--(a)
  chain 0: source=currentSource='' → 用首节点变量 → 'a', targetAlias='b'  → currentSource='b'
  chain 1: source=currentSource='b', targetAlias='c' → currentSource='c'
  chain 2: source=currentSource='c', targetAlias='d' → currentSource='d'
  chain 3: source=currentSource='d', targetAlias='a' → currentSource='a'

PatternElement 2: (b)--(d)
  chain 4: source=currentSource='a' ← BUG! 应该是 'b'
            targetAlias='d'
```

因为链的 source 被错误地设为 `'a'` 而不是 `'b'`，第 5 个 step 变成 `a→d` 而不是 `b→d`。这个额外的 `a→d` 步可能是冗余的（已经在步骤 0-3 中遍历过了），但更关键的是，它使得查询变成了 `(a)--(b)--(c)--(d)--(a)` 加上 `(a)--(d)`，而不是正确的 `(b)--(d)`。

另外，`parseWhereClause` 中分离的 filters 没有被正确分配到对应的变量上。GE 的 `_executeQueryPlan` 将所有 filters 应用到最终结果节点上，不区分哪个 filter 属于哪个变量。

### QE 路径的处理
在 `_executeViaGraphEngine` 中，有逗号分离检测逻辑（`_ceComma`，line ~813），它尝试在 `_walkMultiSteps` 之后验证逗号约束。但这依赖于 step 的 source 正确（即 step[4].source 应该是 'b' 而不是 'a'）。由于解析器已经错误地设置了 source，所有后续处理都会失败。

---

## MW2[2] 详细分析

### 现象
查询返回 0 行，预期返回 `out.name = 'product1'`。

### 解析后的计划
```json
steps: [
  { source: "advertiser", direction: "out", edgeLabel: "ADV_HAS_PRODUCT", targetAlias: "out" },
  { source: "out", direction: "out", edgeLabel: "AP_HAS_VALUE", targetAlias: "red" },
  { source: "red", direction: "in", edgeLabel: "AA_HAS_VALUE", targetAlias: "a" }  // ← direction: "in"
]
filters: [
  { source: "advertiser", property: "id", operator: "EQ", value: "$1" },  // → 0
  { source: "a", property: "id", operator: "EQ", value: "$2" },            // → 1
  { source: "red", property: "name", operator: "EQ", value: "red" },
  { source: "out", property: "name", operator: "EQ", value: "product1" }
]
```

### 根因
在 `graph-engine.ts` 的 `_executeQueryPlan()` 中的单跳遍历循环（line ~1676-1693）：

```typescript
const neighborsRaw = this.storage.neighbors(node.id, {
  edgeTypeFilter: step.edgeLabel ? [this._resolveEdgeType(step.edgeLabel)] : undefined,
})
```

这段代码**无论 `step.direction` 是什么**，总是调用 `storage.neighbors(node.id, ...)` — 这总是查询**从 node.id 出发**的 outgoing 边。

对于 step[2]：`red <-[:AA_HAS_VALUE]-(a)`，`step.direction = 'in'`，应该查询**指向 red 的 incoming 边**。但代码查询的是 `red` 的 outgoing 邻居，而 `red` 没有 outgoing `AA_HAS_VALUE` 边 → 返回 0 邻居 → `results = []` → 循环中断 → 最终结果 0。

**实验验证:**
```
Step 0 (ADV_HAS_PRODUCT, direction=out): id=1(advertiser) → neighbors → id=4(product1), id=5(product4) ✅
Step 1 (AP_HAS_VALUE, direction=out): id=4, id=5 → neighbors → id=3(red) ✅
Step 2 (AA_HAS_VALUE, direction=in):   id=3(red) → neighbors → EMPTY! ❌
  (因为没有 outgoing AA_HAS_VALUE 边从 red 出发)
```

注意：`_executeVariableLengthTraversal` 路径（变长路径）**有**方向支持（line 1673 传递了 `direction` 参数），但**单跳遍历**（非 range 步）**没有**。

### 附加问题：Filter 分配
即使遍历正确完成了，GE 的 filter 应用也有问题。`_executeQueryPlan` 将所有 `plan.filters` 应用到**最终结果节点**上，不区分哪个 filter 属于哪个变量。这意味着 `advertiser.id = 0` 也会在 `a` 节点上检查，而 `a` 节点没有 `id` 属性 → `undefined` → filter 失败。不过对于这个特定场景，所有过滤器只需要在最终节点上检查应该也可以工作，因为 `_walkMultiSteps` 在 QE 路径中已经做了变量级别的过滤。

---

## 修复方案

### MW2[1] 修复: `ast-to-plan-v2.ts` — 逗号分隔 MATCH 的 `currentSource`

**文件:** `src/query/ast-to-plan-v2.ts`  
**位置:** `extractMatch()` 函数（~line 1348）

**方案**: 在遍历 `PatternElementChainContext` 之前，先按 `PatternElement` 分组，每个 `PatternElement` 独立提取起始变量并重置 `currentSource`。

具体修改：
1. 使用 `findAllChildren(matchCtx, 'PatternElementContext')` 获取所有 PatternElement
2. 对每个 `PatternElement` 分别提取 NodePattern (起始节点) 和 PatternElementChain
3. 每个 PatternElement 维护独立的 `currentSource`

伪代码：
```typescript
function extractMatch(matchCtx: any): ParsedMatch | null {
  const patternElements = findAllChildren(matchCtx, 'PatternElementContext')
  if (!patternElements.length) return null

  const firstPattern = findAllChildren(patternElements[0], 'NodePatternContext')[0]
  const variable = findSymbolicName(findChild(firstPattern, 'VariableContext'))
  const nodeLabel = findChild(firstPattern, 'NodeLabelContext')
  const label = nodeLabel ? extractLabel(nodeLabel) : (variable || null)
  const propsNode = findChild(firstPattern, 'PropertiesContext')
  const properties = propsNode ? extractMapLiteral(propsNode) : null

  const edges: ParsedEdgeStep[] = []

  for (const pe of patternElements) {
    const peNodePatterns = findAllChildren(pe, 'NodePatternContext')
    if (!peNodePatterns.length) continue
    // 从该 PatternElement 的起始节点变量重置 currentSource
    let currentSource = findSymbolicName(findChild(peNodePatterns[0], 'VariableContext')) ?? ''

    const chains = findAllChildren(pe, 'PatternElementChainContext')
    for (const chain of chains) {
      // ... 处理每个 chain，source = currentSource
      // ... 最后 currentSource = targetVar
    }
  }

  return { variable, label, edges, properties }
}
```

### MW2[2] 修复: `graph-engine.ts` — 单跳遍历支持 direction

**文件:** `src/core/graph-engine.ts`  
**位置:** `_executeQueryPlan()` 函数中的单跳遍历循环（~line 1676-1693）

**方案**: 在调用 `storage.neighbors()` 时，根据 `step.direction` 设置 `direction` 参数：

```typescript
// 单跳遍历（带早期截断）
const filtered: NodeRecord[] = []
for (const node of results) {
  if (effectiveLimit !== undefined && filtered.length >= effectiveLimit) break
  // 根据 step.direction 确定查询方向
  const neighborsOpts: any = {
    edgeTypeFilter: step.edgeLabel ? [this._resolveEdgeType(step.edgeLabel)] : undefined,
  }
  if (step.direction === 'in') {
    neighborsOpts.direction = 'in'
  } else if (step.direction === 'any') {
    neighborsOpts.direction = 'any'
  }
  const neighborsRaw = this.storage.neighbors(node.id, neighborsOpts)
  for (const entry of neighborsRaw) {
    if (effectiveLimit !== undefined && filtered.length >= effectiveLimit) break
    const neighbor = this.getNode(entry.nodeId, ctx)
    if (neighbor) {
      if (step.targetLabel && neighbor.typeName !== step.targetLabel) continue
      filtered.push(neighbor)
    }
  }
}
results = filtered
```

注意事项：
- 需要确认 `storage.neighbors()` 是否已支持 `direction: 'in'` 参数（在 deleteNode 中已有使用，但注释说"部分 storage 实现不支持"）
- 如果 storage 不支持 direction 参数，需要 fallback：先查 outgoing neighbors，然后对 incoming 方向额外查询（通过反向遍历邻接表）
- 对于 `direction: 'any'` 和 `direction: 'out'`（默认），行为与当前保持一致

### 附加修复：参数化查询中的 filter value 解析

对于 MW2[2]，filter value `"$1"` 在 GE 路径中直接与 node.props 比较。`parseQuery` 已经做了参数替换（`parseQuery(query2, { '1': 0, '2': 1 })`），但 GE 的 `_executeQueryPlan` 是在 `engine.query()` 内部调用的，它使用 `parseQuery(queryString)` 而不带参数 → filter values 仍然是 `"$1"` 和 `"$2"` 字符串。

需要在 `engine.query()` 或 `_executeQueryPlan` 中处理参数化查询。不过这是次要问题，因为即使手动替换参数值（`advertiser.id = 0 AND a.id = 1`），GE 方向问题仍然导致返回 0。

### 关于 Filter 分配的根本性修复

长期来看，GE 的 `_executeQueryPlan` 需要重新设计 filter 应用逻辑。目前的实现只看 `plan.filters` 并将所有 filter 应用到最终结果节点上，但 Cypher 语义要求每个 filter 应该应用到其 `source` 变量对应的节点上。这需要：
1. 在遍历过程中收集每个变量的中间节点
2. 对每个 filter，找到对应的变量节点，在该节点上检查 filter

这与 QE 路径中 `_walkMultiSteps` + `allVars` / `__crossVarRows` 的模式类似。短期方案是依赖 QE 路径（`_executeViaGraphEngine`）来正确处理 multi-variable filters，前提是 traversal 本身正确产生了中间结果。
