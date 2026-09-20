# MERGE relationship (no-MATCH) execution + startNode/endNode runtime — Plan

Created: 2026-09-18 20:05

## Goal
Fix the no-MATCH relationship MERGE path so `MERGE (a)-[r:T]-(b) RETURN startNode(r).id` builds the relationship, binds `r`, and evaluates `startNode`/`endNode` correctly.

## Root cause (confirmed)
- `_executeMultiMatchCrossJoin` (query-executor.ts:1088 `if (!mm?.length) return null`) bails when no `multiMatch` exists, so a bare relationship MERGE (`MERGE (a)-[r:T]-(b)` with no MATCH) never reaches the relationship endowmer at line 1813.
- The GE DML fast-return path (line 2981 `if ((plan.type==='CREATE'||plan.type==='MERGE') && plan.returnColumns?.length)`) only handles node MERGE (ON CREATE/MATCH SET on `effectiveCreateNodes`); `plan.mergeEdges` is never materialised there.
- `startNode`/`endNode` have no runtime implementation in production code (`executeBuiltinFunction`/`BUILTIN_FUNCTIONS` only exist in stale specs). `_mkEdgeObj` emits `{__edgeId,__relId,__edgeLabel,_type,_label,srcIdx,dstIdx}` with no `_startNode`/`_endNode`.

## Steps
- [ ] L1: Add relationship-MERGE materialisation in the GE DML fast-return path (before `_buildDmlRows`), mirroring the CREATE edge path: resolve endpoints via `varToNodeMap`/`_alias`/`cnToAllNodeMap`, match-or-create by label+direction, write `__edges`, bind `r`.
- [ ] L2: Implement `startNode`/`endNode` evaluation (edge → endpoint node), and ensure the bound `r` carries endpoint refs (`_startNode`/`_endNode` or srcIdx/dstIdx resolvable to node objects).
- [ ] Verify [10][11][12][13] pass; run core regression (837); merge TCK 75/75.
- [ ] Commit as Lambertyan (English).

## Key locations
- `_findMergeNodeMatch` query-executor.ts:888 (node match-or-create, reuse pattern)
- Node MERGE match-or-create: query-executor.ts:2356-2424
- CREATE edge materialisation: query-executor.ts:2876-2968
- MERGE DML fast-return (node-only): query-executor.ts:2981-3030
- `_executeMultiMatchCrossJoin` relationship endowmer: query-executor.ts:1813-1975 (reference for match-or-create edge + `_mkEdgeObj`)
- `plan.mergeEdges`: `{source,target,label,direction,variable,props}` (ast-to-plan-v2.ts:116)

## Progress
Doing: L1 relationship-MERGE materialisation.
