# Multi-WITH Chain Pipeline Support — Plan

Created: 2026-08-23

## Goal
Support multiple sequential WITH clauses (pipeline) where later WITH/ORDER BY
may reference projections of earlier WITH clauses. Currently `clausesToPlan`
overwrites `plan.with` on each `case 'WITH':`, so only the LAST WITH survives,
dropping earlier projection aliases (e.g. `sum` in `WITH a, a.num+a.num2 AS sum
WITH a, a.num2%3 AS mod ORDER BY sum`).

Affected TCK (WithOrderBy4): [8], [9], [10] (unexpected-row), and the same root
cause drives the ArgumentError [45] family (10 failures).

## Approach
1. Type: add `withChain?: WithClauseAST[]` to QueryPlan (reuse `with` shape).
2. Parser (`ast-to-plan-v2.ts`): `case 'WITH':` push each `extractWith` result
   into `plan.withChain`; keep the last one also in `plan.with` for backward
   compatibility (ORDER BY / LIMIT / SKIP promotion logic reads `plan.with`).
3. Executor (`query-executor.ts`): apply WITH projections sequentially. The
   current single-WITH block (line ~3021) must iterate `withChain` in order,
   evaluating each step's alias against the evolving row, feeding the previous
   step's aliases into the next step's scope.

## Steps
- [ ] Step 1: add `withChain` type + parser accumulation (preserve `plan.with` = last)
- [ ] Step 2: verify parse output for [8]/[9]/[10] shows correct withChain
- [ ] Step 3: sequential application in executor (the WITH-postprocessing block)
- [ ] Step 4: ORDER BY against intermediate aliases (sum) resolves
- [ ] Step 5: acceptance — [8]/[9]/[10] pass, zero regression (quick 4/4 + with-orderBy baseline 259)
- [ ] Step 6: Lambertyan commit (English)

## Risk
- Do NOT break single-WITH path (huge TCK surface). Keep `plan.with` = last WITH
  so existing single-WITH code paths are unchanged.
- Only activate multi-WITH sequential path when `withChain.length > 1`.

## Current baseline
with-orderBy: 259 passed / 33 failed (unexpected-row 14, ArgumentError 10, TypeError 5, row-count 3, agg 1)

## RESULT (iteration C done, committed bbef7553)
- WithOrderBy4 [8]/[9]/[10] PASS.  with-orderBy 259 → 262 passed / 30 failed.
- Quick regression 4/4 green (zero regression).

## NEXT: ArgumentError [45] (10 examples, WithOrderBy1, pure WITH/UNWIND pipeline, non-GE path)
Query: `WITH <values> AS values WITH values, size(values) AS numOfValues UNWIND values AS value WITH size([x IN values WHERE x<value]) AS x, value, numOfValues ORDER BY value WITH numOfValues, collect(x) AS orderedX RETURN orderedX = range(0, numOfValues-1) AS equal`

Root cause (diagnosed, NOT yet fixed):
- plan.hasMatch=false, type=QUERY, withChain.length=4, unwind present, aggregate=collect(x).
- Routed to `_executeWithUnwindPipeline` (executor-unwind-pipeline.ts) via the
  `_startsWithWith && !hasMatch && unwind` guard (executor-non-ge.ts:394-398).
- That pipeline only materializes: (a) the FIRST `WITH [...] AS ...` list literal
  (line ~105-137) and (b) the FIRST `WITH <fn> AS ...` (line ~146, regex
  `^WITH\s+...` anchors to query start). Intermediate WITH projections such as
  `numOfValues` (from `WITH values, size(values) AS numOfValues`) are NEVER
  materialized → numOfValues is undefined → `range(0, numOfValues-1)` throws
  ArgumentError at expression-engine.ts:1409.
- `_preProcessAggregateWith` (line ~37) DOES split multi-column WITH and could
  materialize numOfValues, but its guard (line ~91) requires `plan.hasMatch &&
  plan.with && (aggregate||SET||DELETE)` — false here (hasMatch=false).

Fix direction:
- Materialize ALL WITH projections sequentially (in withChain order) for the
  pure WITH/UNWIND pipeline too, preserving intermediate aliases (numOfValues)
  across the UNWIND + collect aggregation, before the final RETURN evaluation.
- Careful: must not break existing MATCH+WITH+UNWIND aggregate paths nor
  Unwind1/List12/DML regression.
