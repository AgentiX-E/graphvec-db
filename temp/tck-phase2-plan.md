# TCK Phase 2 — Deep Modules

Base: master (b8e94fc3)

## Priority

### P0: Clauses (17 dirs, ~1232 scenarios)
Most clause types have ANTLR adapter issues (plan parsing incomplete).
Strategy: for each clause dir, analyze which clause types fail due to plan structure vs execution.
- match: 253/381 pass → remaining 128 fail (label expressions, multi-label, etc.)
- match-where: 7/34 pass
- create: 37/78 pass
- return: 18/63 pass
- return-orderby: 1/35 pass
- return-skip-limit: 7/31 pass
- with: many fail
- merge: 14/75 pass
- call: 0/52 pass
- delete: 13/41 pass
- set: many fail
- remove: 11/33 pass
- union: many fail
- unwind: many fail

### P1: Pattern (50 scenarios)
- 15/50 pass → 35 fail (path pattern syntax)

### P2: Quantifier (604 scenarios)
- 488/604 pass → 116 fail (complex quantifier path patterns)

### P3: Temporal (1004 scenarios)
- 25/1004 pass → 979 fail (temporal types/functions mostly unimplemented)

## Agent allocation
1. clause-match-fix: match + match-where + with
2. clause-return-fix: return + return-orderby + return-skip-limit
3. clause-dml-fix: create + delete + set + remove + merge
4. clause-rest-fix: call + union + unwind
5. pattern-and-quantifier-fix
6. temporal-fix (largest, needs builtin date/duration functions)

## Execution
Batch 1: sub-agents 1-4 (clauses) in parallel
Batch 2: sub-agents 5-6 after batch 1
