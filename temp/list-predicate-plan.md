# List Predicate Implementation — Execution Plan

Created: 2026-08-07 13:52

## Goal

Implement ALL/ANY/NONE/SINGLE list predicates in expression-engine.ts.
Currently these predicates return null because they have no evaluation handler.

## Phases

- [ ] Phase 1: Study list predicate syntax — ALL(x IN list WHERE cond), ANY, NONE, SINGLE
- [ ] Phase 2: Implement _evalListPredicate in expression-engine.ts
- [ ] Phase 3: Integrate into _evalBinary / _callFunction
- [ ] Phase 4: Target-specific vitest (≥95% coverage on list predicates)
- [ ] Phase 5: Quick regression (graph-engine 622, query-engine 120, temporal 1004)
- [ ] Phase 6: List11 [3] TCK verification + full list regression
- [ ] Phase 7: Commit as Lambertyan

## Constraints

- English comments, docs, commits
- No TCK test data modification
- No ANTLR grammar changes
- Zero degradation on all existing suites
