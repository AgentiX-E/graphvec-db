# Clauses TCK Zero-Failure Plan

Created: 2026-09-05

## Goal
Bring the entire clauses TCK directory (~7854 scenarios across 17 subdirs) to
zero failures, then the whole TCK suite (clauses + expressions + useCases +
top-level) to global zero. Highest-standard, systematic, one root-cause class
at a time.

## Current State
- expressions: 15725/15725 ✅ (0 fail)
- useCases: 191/191 ✅
- core regression: 813/813 ✅
- clauses: ~7854 scenarios, ~1500 failures

## Root-cause classes (ordered by cross-directory impact)

### Class 1 — Missing syntax-error validation (validation layer gaps)
Symptoms: `no SyntaxError`, `InvalidNumberLiteral`, `InvalidDelete`,
`InvalidAggregation`, `AmbiguousAggregationExpression`, `VariableTypeConflict`,
`UndefinedVariable`, `RequiresDirectedRelationship`.
Affects: create, delete, merge, return, return-orderby, return-skip-limit,
with, union.
Action: add/restore compile-time validators in `_validatePlan` /
`executor-validate-plan.ts` / `executor-validators.ts`.

### Class 2 — Aggregate null after DML (DML persistence)
Symptoms: `{"sum":"null"}`, `{"count(r)":"null"}`, `{"sum":"0"}` after
SET/CREATE/DELETE/REMOVE/MERGE.
Affects: create, delete, merge, remove, set.
Action: ensure DML mutations propagate to the row/node props used by the
aggregation pass.

### Class 3 — Row-count / MATCH semantic mismatches
Symptoms: `row count: expected N, got M` (N/M vary widely).
Affects: match (103), merge, create, return, unwind, with, with-*.
Action: per-scenario MATCH matching correctness (self-loops, var-length,
optional match, deduplication).

### Class 4 — Property access on non-map type (TypeError)
Affects: delete, set, unwind, with-orderBy (heavy).
Action: guard property access; ensure node props are maps.

### Class 5 — Ordering / temporal type formatting
Affects: with-orderBy (time literals, float/int ordering).
Action: ordering comparator + temporal literal stringification.

### Class 6 — SET property name overwrite / labels() / props
Symptoms: `{"n":"(:X {name:'A', name2:'B'})"}`, `labels(n)` wrong.
Affects: set, remove.
Action: SET/REMOVE prop/label semantics.

### Class 7 — call `_executeQuery` / `_executeQueryPlan` dead code
Symptoms: `_executeQuery is not defined` (1 remaining call scenario).
Action: resolve cycle by injecting execution callback or inlining MATCH path.

## Execution order
1. Class 7 (trivial, 1 fail) — resolve call dead code.
2. Class 1 — syntax validation (biggest cross-cutting win).
3. Class 2 — DML aggregate propagation.
4. Class 4 — property-access guard.
5. Class 3 — MATCH row-count semantics (largest, most careful).
6. Class 5 — ordering/temporal.
7. Class 6 — SET/REMOVE/labels/props.

After each class: run full clauses regression + core regression (813) to
ensure zero regression, then commit as Lambertyan.

## Acceptance criteria (per class)
- Targeted failing scenarios drop to 0.
- No new failures introduced elsewhere in clauses.
- Core regression 813/813 stays green.
