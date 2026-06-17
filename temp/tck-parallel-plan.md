# TCK Parallel Advancement Plan

Base: master (ea528e5c) — 122/122 tests pass, 0 pre-existing bugs

## Phase A2: Comparison2 [3] cross-type (ANTLR multi-WITH fallback)
- Sub-agent: comparison-fix
- Fix multi-WITH chain bug in ANTLR adapter: parse query string for types list
- Target: Comparison2 19/19

## Phase B: List (6/11/12 still failing)
- Sub-agent: list-fix
- Fix List6 (14 more), List11 (29 more), List12 (6 more)
- Target: List 185/185

## Phase C: Map + Path + Aggregation
- Sub-agent: map-path-agg-fix
- Fix Map (10 more), Path (5 more), Aggregation (29 more)
- Target: Map 44/44, Path 7/7, Agg 35/35

## Execution Order
Phase A2, B, C in parallel (independent modules)
