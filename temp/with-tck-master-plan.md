# WITH Clause TCK — Master Execution Plan

Created: 2026-09-22 00:05 GMT+8

## Goal
Drive all `with` and `with-orderBy` TCK feature directories to 0 failures,
keeping core regression at 742 passed with zero regressions, coverage >=95%
per dimension.

## Current State
- with-orderBy: 0 fail (done)
- With3: 0 fail (done)
- With6: 1 fail `[4]` (var-length path implicit grouping)
- with directory total: 14 fail
  - With1 [1][2]
  - With2 [1][2]
  - With4 [2][4][5][6][7]
  - With5 [1][2]
  - With6 [4]
  - With7 [1][2]

## Phase Order (decided)
1. With6 [4] — var-length path + path-variable + implicit grouping (deep, active)
2. With7 [1][2]
3. With5 [1][2]
4. With4 [2][4][5][6][7]
5. With2 [1][2]
6. With1 [1][2]

## Acceptance Criteria (every iteration)
- Targeted TCK feature: N → 0 fail
- Core regression: 742 passed, zero regressions
- Coverage: >=95% each dimension
- English code comments / docs / commit message
- Commit as Lambertyan <lambertyan@example.com>, single-quoted -m

## Progress Log
- [ ] With6 [4] fix + test + commit
- [ ] With7
- [ ] With5
- [ ] With4
- [ ] With2
- [ ] With1
