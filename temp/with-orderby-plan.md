# with-orderBy Remaining Semantic Bugs — Execution Plan

Created: 2026-08-20 08:09

## Goal
Fix the remaining 118 with-orderBy TCK failures (real semantic bugs, not flaky)
with rigorous scientific testing and ≥95% dimension coverage.

## Baseline (commit 6372776e)
with-orderBy: 174/292 passed, 118 failed.
Breakdown:
- other-assert: 51 (e.g. strings: "null" !== "''" — empty-string vs null sort semantics)
- unexpected-row: 38 (e.g. multi-type node notation `{n,types,r}`)
- row-count-mismatch: 14
- ArgumentError: 10 (range at expression-engine.ts:1387)
- TypeError: 4 (Property access on non-map type at expression-engine.ts:3985)
- AmbiguousAggregation: 1

## Steps
- [x] Step 1: Re-run with-orderBy, collect exact failing scenarios → report baseline 174/292
- [x] Step 2: Prioritize → UndefinedVariable (ORDER BY scope) identified as highest-value, well-defined
- [x] Step 3: Fix ORDER BY undefined-variable scope tracking (_validateOrderByScope)
- [x] Step 4: (deferred) range()/property-access — next iteration
- [x] Step 5: Full with-orderBy re-run → 216/292 (+42), quick regression 4/4 zero-regression
- [x] Step 6: Commit as Lambertyan → 537b20f2 (pushed)

## Current status (commit 537b20f2)
with-orderBy: 216/292 passed, 76 failed.
Remaining: unexpected-row 38, row-count 14, ArgumentError 10, other-assert 9, TypeError 4, AmbiguousAggregation 1.

