# TCK Failure Analysis — 2026-08-07

## Summary
Total scenarios: ~2946 (all clauses + expressions + useCases)
Green suites: temporal (1004/1004), mathematical (6/6), graph-engine (622), query-engine (120)

## Failure Distribution — Clauses (sorted by fail count)

| Suite | Pass/Total | Fail | % | Priority |
|-------|-----------|------|---|----------|
| match | 295/381 | 86 | 77% | **CRITICAL** — core feature, high leverage |
| merge | 12/75 | 63 | 16% | HIGH |
| set | 8/53 | 45 | 15% | HIGH |
| create | 44/78 | 34 | 56% | HIGH — 56%, almost there |
| return | 23/63 | 40 | 37% | HIGH |
| call | 16/52 | 36 | 31% | MEDIUM |
| delete | 13/41 | 28 | 32% | MEDIUM |
| return-orderby | 7/35 | 28 | 20% | MEDIUM |
| with | 4/29 | 25 | 14% | **HIGH** — involves expression eval |
| return-skip-limit | 10/31 | 21 | 32% | MEDIUM |
| remove | 13/33 | 20 | 39% | MEDIUM |
| unwind | 0/14 | 14 | 0% | LOW |
| union | 4/12 | 8 | 33% | LOW |

## Failure Distribution — Expressions (sorted by fail count)

| Suite | Pass/Total | Fail | % | Priority |
|-------|-----------|------|---|----------|
| quantifier | 66/604 | 538 | 11% | LOW — very far, large effort |
| precedence | 64/121 | 57 | 53% | MEDIUM |
| pattern | 4/50 | 46 | 8% | LOW |
| graph | 31/61 | 30 | 51% | MEDIUM |
| aggregation | 8/35 | 27 | 23% | HIGH — aggregation is core |
| boolean | 129/150 | 21 | 86% | **HIGH** — 86% almost there |
| comparison | 52/72 | 20 | 72% | **HIGH** — 72%, close |
| list | 168/185 | 17 | 91% | **HIGH** — 91%, very close |
| typeConversion | 34/47 | 13 | 72% | MEDIUM |
| existentialSubqueries | 2/10 | 8 | 20% | LOW |
| map | 36/44 | 8 | 82% | MEDIUM — 82% close |
| string | 26/32 | 6 | 81% | LOW |
| path | 4/7 | 3 | 57% | LOW |
| null | 42/44 | 2 | 95% | LOW — almost done |
| conditional | 12/13 | 1 | 92% | LOW — almost done |

## Recommended Priority

### Tier 1 — High Impact, Close to 100%
1. **match** (86 fail, 77%) — core feature, affects everything
2. **boolean** (21 fail, 86%) — close to complete
3. **comparison** (20 fail, 72%) — close to complete
4. **list** (17 fail, 91%) — very close
5. **with** (25 fail, 14%) — WITH clause processing, 和 expression engine 紧密相关

### Tier 2 — Core Features
6. **aggregation** (27 fail, 23%)
7. **create** (34 fail, 56%)
8. **return** (40 fail, 37%)

### Tier 3 — Later
9. merge, set, call, delete, etc.
