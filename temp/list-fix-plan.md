# List Expression TCK Fix — Execution Plan

Created: 2026-08-07 13:46

## Progress

- [x] Phase 1: Analyze 17 failing scenarios ✅
- [x] Phase 2a: Fix missing imports (_parseCommaList, _resolveUnwindList) — `7c74d148` ✅
- [x] Phase 2b: Implement ALL/ANY/NONE/SINGLE list predicates — `0ac9b76f` ✅
- [x] Phase 2c: Fix SET DML persistence (record props sync + literal parsing) — `6909d0ea` ✅
- [ ] Phase 3: Fix remaining 14 failures (pattern comprehension + list comprehension runtime)
- [ ] Phase 4: Target-specific vitest (≥95% coverage on list dimensions)
- [ ] Phase 5: Full list TCK regression (185/185 target)
- [ ] Phase 6: Commit as Lambertyan

## Results So Far

| Commit | Desc | List TCK |
|--------|------|----------|
| baseline | — | 168/185 |
| `7c74d148` | import fixes | 168/185 (crash→assertion) |
| `0ac9b76f` | list predicates | 169/185 (+1) |
| `6909d0ea` | SET DML sync | 171/185 (+2) |

## Remaining: 14 failures

| Category | Count | Scenarios |
|----------|-------|-----------|
| Pattern comprehension size() | 8 | List6 [6]x4, [7][8][9][10] |
| List comprehension runtime | 6 | List12 [1]-[6] |
