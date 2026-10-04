# WITH Aggregation Folding — Execution Plan

Created: 2026-09-27 04:35

## Goal

Implement WITH aggregation folding (`with.aggregate`) in the QE main path
(`_executeViaGraphEngine`), so that a query combining a variable-length path,
a WITH aggregate (`min(length(p))`), and a RETURN aggregate (`collect(other)`)
folds correctly. Fixes Return6 [13] and (with multi-aggregate support) Return6 [16].

## Root Cause

`with.aggregate` is read only as an alias hint (query-executor.ts line 8926),
but is NEVER folded. The intended folder is GE's `_executeWithClause`
(graph-engine.ts line 1859), but that only handles simple property aggregates
(`n.prop` / `*`), not expression fields (`length(p)`) nor variable-length-path
rows (which are reconstructed on the QE side via `_walkMultiSteps`).

For [13] the query is:
```
MATCH p = (a:T {name:'a'})-[:R*]->(other:T) WHERE other <> a
WITH a.name AS name, other.name AS other, min(length(p)) AS len
RETURN name, collect(other) AS others, len
```
Expected: `{name:'a', others:['c','b'], len:1}` (one row).
Actual: `[]` (empty) — WITH aggregate never folded, so `len` never exists and
the RETURN grouping falls apart.

## Pipeline (correct semantics)

1. MATCH var-length → 3 rows `{a, other, p}` (verified correct via naked VL).
2. WITH fold: group by non-aggregate columns `(name, other)`, compute
   `len = min(length(p))` → 2 rows `{name:'a', other:'b', len:1}` and
   `{name:'a', other:'c', len:1}`.
3. RETURN fold: group by `(name, len)`, `others = collect(other)` → 1 row.

## Steps

- [ ] Step 1: Add WITH-aggregation folding in `_executeViaGraphEngine` after
      WHERE filtering, before RETURN projection. Detect `with.aggregate` +
      non-aggregate `with.columns`; group rows by the non-aggregate columns
      (deep-equal); evaluate the aggregate field via `_evalBinary` (so
      `length(p)` resolves against the path object), then fold (min/sum/avg/
      max/count).
- [ ] Step 2: Ensure the folded `len` reaches the RETURN aggregate grouping
      (collect(other) over name/len groups).
- [ ] Step 3: Extend for multi-aggregate WITH (Return6 [16]): `with.aggregates`
      array + `extractWith` collecting all aggregates (remove early `break`).

## Validation

- [ ] Single scenario [13] → pass
- [ ] Return6.feature full → 0 fail
- [ ] Core regression: `npx vitest run src/core/graph-engine.spec.ts src/query/query-engine.spec.ts --coverage.enabled=false` → 742 passed
- [ ] Commit as Lambertyan (English message)

## Current Progress

Investigating exact insertion point in `_executeViaGraphEngine` main path.
