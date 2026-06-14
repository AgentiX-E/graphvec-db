# E2E Deep Extension Plan

Targets: +100 api, +80 graph-engine, +75 multi-leader, +60 security

## Approach
- Append to each file after closing brace of existing describe block
- Use `makeEngine` from `../test-utils/make-engine`
- Only test existing API methods
- Each test must actually pass

## Files to edit
1. api-e2e.spec.ts (50 → 150, +100)
2. graph-engine-e2e.spec.ts (70 pass → +80 in new describe blocks)
3. multi-leader-e2e.spec.ts (25 → 100, +75)
4. security-e2e.spec.ts (20 → 80, +60)
