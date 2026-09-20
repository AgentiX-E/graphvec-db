# Match/MatchWhere Remaining Failures — Execution Plan

## Goal
Reduce match/ + match-where/ failures from 24 → 0, with per-iteration scientific
testing, strict acceptance (core 813 green + targeted feature 0 fail), and
English commits authored as Lambertyan.

## Baseline (2026-09-15)
TOTAL pass=2378 fail=24 across 8 feature files.

## Groups (ordered by risk, low → high)

### Group B — multi-variable predicate filtering (cross-var property)
- MatchWhere2[1] conjunctive two-part property predicate on multi variables (expected 2, got 1)
- MatchWhere3[3] join between node properties of adjacent nodes (expected 2, got 0)
- MatchWhere4[2] join with disjunctive multi-part predicates including patterns (expected 1, got 0)

### Group A — multi-label / cyclic
- Match3[7] matching nodes with many labels (expected 1, got 0)
- Match3[17] handling cyclic patterns (expected 1, got 2)

### Group C — label/property predicates after OPTIONAL (multi variables)
- MatchWhere6[1] label predicate on multi variables (expected 1, got 3)
- MatchWhere6[2] false node label predicate after OPTIONAL (expected 1, got 2)
- MatchWhere6[3] property predicate on multi variables after OPTIONAL (expected 1, got 2)

### Group D — MERGE/aggregate + OPTIONAL
- Match8[2] counting rows after MATCH, MERGE, OPTIONAL MATCH (count(*)=null)
- Match8[3] matching and disregarding output then matching again (sum wrong)

### Group E — variable-length paths (deepest, defer until others stable)
- Match4[4][7][8]
- Match5[23][25][26][27][28][29]
- Match9[1][3][6][8][9]

## Status
In progress: Group B.
