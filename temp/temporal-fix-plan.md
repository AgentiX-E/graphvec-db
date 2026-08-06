# Temporal TCK Fixes — Execution Plan

Created: 2026-08-06 10:20

## Goal
Fix 233 temporal TCK failures across Temporal3 (183), Temporal6 (17), Temporal7 (18), Temporal8 (15).

## Current State
- All 14 clause suites: 100% ✅
- 17/18 expression suites: 100% ✅
- graph-engine: 622/622 ✅
- query-engine: 71/71 ✅
- Temporal1,2,4,5,9,10: 100% ✅

## Root Cause Analysis

### Temporal3 (183 fail) — Project Temporal Values
Queries like `WITH date({year:1984}) AS d RETURN date(d) AS result` return null.
The `date(other)` form receives a string `'1984-11-11'` as argument to `date()`.
The string-passing path in `date()` function needs to handle bare date strings (not map).

### Temporal6 (17 fail) — Serialize Duration
`toString()` not implemented for duration values. TCK expects `'P1DT2H3M4S'` format.

### Temporal7 (18 fail) — Compare Temporal Values
Date/time/datetime comparison using `<`, `>`, `=`, `<>` returns null.
The `_evalComparison` path for temporal types needs enhancement.

### Temporal8 (15 fail, 12 pass) — Arithmetic
Some arithmetic paths already work (12 pass), 15 fail likely involving
edge cases in duration addition/subtraction or datetime arithmetic.

## Steps

- [ ] Phase 1: Temporal3 — Project temporal (fix function dispatch for string args)
- [ ] Phase 2: Temporal6 — toString/string serialization for duration
- [ ] Phase 3: Temporal7 — Temporal comparisons
- [ ] Phase 4: Temporal8 — Arithmetic edge fixes
- [ ] Phase 5: Full regression (vitest + all temporal + clause regression)

## Progress
Currently: Phase 1 starting
