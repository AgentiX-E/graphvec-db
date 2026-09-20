# Pattern Comprehension Plan (Pattern2)

Created: 2026-08-29 19:15

## Goal
Implement pattern comprehension — `[p = (n)-->() | p]` — which produces a
LIST of paths (one per relationship match), unlike `_evalPatternPredicate`
which produces a boolean.

## Current state
Pattern2.feature: 11 scenarios, 11 failed (0 passed). TCK overall 146 failed.

## Scenarios
- [1] `[p = (n)-->() | p]` basic
- [2] `[p = (n)-->(:B) | p]` label predicate on target
- [3] bound nodes
- [4..] more (need full read of Pattern2.feature)

## Steps
- [ ] Read Pattern2.feature fully to enumerate all 11 scenarios + syntax variants.
- [ ] Locate existing pattern-comprehension parsing (comprehensionColumns,
      PATTERN_COMPREHENSION expr type in ast-to-plan / query-parser).
- [ ] Determine whether execution layer evaluates comprehensionColumns or
      whether the raw string is re-parsed in _executeQuery.
- [ ] Implement path generation (list of relationship records / path objects).
- [ ] Match expected row shapes (paths rendered as <(:A)-[:T]->(:B)> or similar).
- [ ] Run Pattern2, quick regression, full TCK.
- [ ] Add unit tests (coverage >= 95%).
- [ ] Commit as Lambertyan (English).

## Progress
Step: reading Pattern2.feature.
