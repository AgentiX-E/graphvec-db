# Seed Edge Injection Plan

## 根因
`Given('having executed:')` in `step-definitions.ts` has a multiparse branch (L672+) that handles `CREATE (a), (b), (a)-[:T]->(b)` with `lines.length > 1`. It iterates `createNodes` but **never processes `createEdges`**. Result: nodes without edges → `expected N, got 0`.

## 修复方案
Add edge injection to the multiparse CREATE branch (L687 area, after node push):

```typescript
// After node push loop, inject edges
const cEdges = (subPlan as any).createEdges
if (cEdges?.length) {
  // Need alias→index mapping since createNodes may have duplicates
  const aliasToIdx = new Map<string, number>()
  st.nodes.forEach((n: any, idx: number) => {
    if (n._alias && !aliasToIdx.has(n._alias)) aliasToIdx.set(n._alias, idx)
  })
  for (const ce of cEdges) {
    const srcIdx = aliasToIdx.get(ce.source)
    const dstIdx = aliasToIdx.get(ce.target)
    if (srcIdx !== undefined && dstIdx !== undefined && srcIdx < st.nodes.length && dstIdx < st.nodes.length) {
      if (!st.nodes[srcIdx].__edges) st.nodes[srcIdx].__edges = []
      st.nodes[srcIdx].__edges.push({
        srcIdx, dstIdx,
        label: ce.label || 'T',
        props: ce.props || null,
      })
    }
  }
}
```

## 风险
- Must use `aliasToIdx` (first occurrence) not raw `createNodes.findIndex` (backwards `createNodes` has duplicates)
- Must add `__edges` to existing node objects (not create new nodes)
- GE side: should also `ge.upsertEdge()` for completeness
- L160's `MATCH (node)-[r:KNOWS {name: 'monkey'}]->(a)` has inline edgeProps — edge prop filtering should work via the existing `edgePropSteps` logic

## 验证顺序
1. MW1 L160 → expected 1, got 0 → should become 1 ✅
2. MW1 L216 → should remain ✅
3. query-engine.spec.ts 120/120 ✅
4. graph-engine.spec.ts 622/622 ✅
5. Remaining MatchWhere failures (~20)
