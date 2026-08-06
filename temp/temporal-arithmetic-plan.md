# Temporal8 + MatchWhere Regression Fix Plan

Created: 2026-08-06 13:43

## Goal
1. Fix MatchWhere 33/34 → 34/34 (regression from d0c66063)
2. Fix Temporal8 12/27 → 27/27 (temporal arithmetic: sum/diff)

## Steps
- [ ] Phase 1: Diagnose MatchWhere regression root cause
- [ ] Phase 2: Fix MatchWhere → 34/34
- [ ] Phase 3: Diagnose Temporal8 failures (sum/diff temporal arithmetic)
- [ ] Phase 4: Implement temporal arithmetic (date+duration, date-date, etc.)
- [ ] Phase 5: Full regression (vitest 693 + clauses 14 + expressions 18)
- [ ] Phase 6: Commit as Lambertyan

## Current Progress
Starting Phase 1
