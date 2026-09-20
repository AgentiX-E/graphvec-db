# Match4 [7] — bound relationship reuse in cross-join

## Query
```
MATCH ()-[r:EDGE]-()
MATCH p = (n)-[*0..1]-()-[r]-()-[*0..1]-(m)
RETURN count(p) AS c   -- expected 32, actual 96 (= 32 × 3)
```

## Root cause
`_executeMultiMatchCrossJoin` cross-join (line ~1352) only equates shared
variables when BOTH bindings are numbers (node indices).  The relationship
variable `r` is bound to a relationship OBJECT on both sides, so the join
never equates `r` and instead Cartesian-products: pattern[0] binds 3 r edges,
pattern[1] binds path middle-edge r, giving 3× over-count.

## Correct semantics
`r` bound by the first MATCH is reused in the second MATCH: the two patterns
must join on relationship identity (direction-insensitive), not produce a
Cartesian product.

## Fix plan
1. Give every enumerated relationship a direction-insensitive stable id
   `__edgeId = [min(src,dst)]|[max(src,dst)]|label` (rels collection AND the
   edgeObj bound in multi-step path binding, which currently drops src/dst).
2. In the cross-join equality loop, when a shared variable is bound to an
   object carrying `__edgeId` on both sides, equate on `__edgeId` (fall back to
   `===` for other object types / node objects).
3. Verify Match4 [7] yields 32 and no regression across match/ + core.

## Notes
- rels currently build `__edgeId = srcIdx|dstIdx|label` (directed).  For
  undirected patterns the traversal may produce the reverse order, so use the
  undirected canonical form for identity comparison.
- path binding edgeObj (line ~1308) copies only label props, dropping src/dst;
  add canonical `__edgeId` there from `hopEdges[pi].relEdge`.
