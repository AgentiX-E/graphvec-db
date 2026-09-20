# MatchWhere 9 Failures — Execution Plan

Created: 2026-08-15 02:45

## Goal
Fix 9 pre-existing TCK failures in `clauses/match-where` (34 scenarios → 25 pass, 9 fail).
Target: 34/34 pass, zero regressions (vitest 742/742, comparison+boolean+list+literal 407/407, temporal 1004/1004).

## Failing Scenarios (clustered by root cause)

### Group A — Relationship/path variable WHERE predicates
- MatchWhere1 [8]: `MATCH (node)-[r:KNOWS]->(a) WHERE r.name = 'monkey' RETURN a`
  → returns `(:B)` should be `(:A)` (wrong target + mislabeled)
- MatchWhere1 [12]: `MATCH p = (n)-->(x) WHERE length(p) = 1 RETURN x`
  → returns [] should return 1 row

### Group B — Multi-variable conjunctive/disjunctive predicates
- MatchWhere2 [1]: `MATCH (a)--(b)--(c)--(d)--(a), (b)--(d) WHERE a.id=1 AND c.id=2 RETURN d`
- MatchWhere2 [2]: multi-var conjunctive with params `$1`/`$2`
- MatchWhere4 [2]: disjunctive with pattern `(a)-[:T]->(b:TheLabel) OR (a)-[:T*]->(b:MissingLabel)`

### Group C — OPTIONAL MATCH + WHERE filtering
- MatchWhere6 [3]: `MATCH (n:Single) OPTIONAL MATCH (n)-[r]-(m) WHERE m.num=42 RETURN m`
- MatchWhere6 [6]: `MATCH (x:X) OPTIONAL MATCH (x)-[:E1]->(y:Y) WHERE x.val < y.val RETURN x,y`
- MatchWhere6 [7]: two-rel OPTIONAL + `WHERE x.val < z.val`
- MatchWhere6 [8]: two OPTIONAL MATCH + `WHERE x.val < z.val`

## Steps
- [ ] Diagnose Group A root cause (relationship var binding + path length eval)
- [ ] Fix Group A + verify MatchWhere1 [8][12]
- [ ] Diagnose Group B root cause (conjunctive/disjunctive multi-var WHERE)
- [ ] Fix Group B + verify MatchWhere2 [1][2], MatchWhere4 [2]
- [ ] Diagnose Group C root cause (OPTIONAL MATCH + WHERE)
- [ ] Fix Group C + verify MatchWhere6 [3][6][7][8]
- [ ] Full regression: vitest 742 + comparison 407 + temporal 1004 + match-where 34
- [ ] Remove trace code, commit as Lambertyan (English)

## Progress
Currently: diagnosing Group A.
