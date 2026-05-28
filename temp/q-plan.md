# Q01/Q02/Q03 Query Enhancements Plan

## Goal
Add aggregate functions, UNION support, and query optimizer to Cypher-lite query engine.

## Steps
- [x] Step 0: Understand current code — grammar (peggy) already has aggregate/union rules, need to fix CountFunc for n.age
- [x] Step 0.5: Fix grammar — CountFunc needs to support `count(n.age)` in addition to `count(n)` and `count(*)`
- [x] Step 0.6: Regenerate parser ✓
- [ ] Step 1: Implement `_evaluateAggregate(fn, values)` in query-engine.ts
- [ ] Step 2: Update `planFromAST` to set `unionType` and `rightPlan` properly from AST
- [ ] Step 3: Implement `_optimizePlan(ast)` with predicate pushdown, projection pruning, cost estimation
- [ ] Step 4: Add tests for Q01/Q02/Q03 to query-engine.spec.ts
- [ ] Step 5: Run `npm run test:core-base` to confirm nothing broken
- [ ] Step 6: Output "DONE: Q01/Q02/Q03 query enhancements"

## Current Progress
Starting implementation
