# Aggregation TCK Bug Fix Plan

Created: 2026-08-31 19:51

## Goal
Fix all 5 remaining aggregation TCK failures (historical baseline bugs) with
zero regression across the full aggregation baseline.

## Target failures
1. Aggregation1 [1] `MATCH (n) RETURN n.name, count(n.num)` — GROUP BY, count non-null → null (should 1/1)
2. Aggregation3 [1] `MATCH (n) RETURN n.name, sum(n.num)` — GROUP BY, sum non-null → null
3. Aggregation5 [1] collect() filtering nulls
4. Aggregation5 [2] OPTIONAL MATCH collect on node property
5. Aggregation8 [2] `MATCH (a) RETURN count(DISTINCT a.name)` — null name should 0, got 1

## Steps
- [ ] Diagnose each failure root cause (GROUP BY + aggregate path)
- [ ] Fix in query-executor.ts / graph-engine.ts / parser
- [ ] Verify: aggregate.spec.ts + graph-engine 622 + query-engine 71 + TCK aggregation 35/35
- [ ] Full regression (clauses/expressions/useCases sharded) zero regression
- [ ] Commit as Lambertyan (English comments/commit)

## Progress
- Step 1: diagnosing GROUP BY aggregation path
