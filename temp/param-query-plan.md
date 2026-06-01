# Parameterized Query Implementation Plan

## Goal
Add `ParameterizedQuery` class and `ParameterizedCypher` to replace unsafe string-interpolated Cypher queries.

## Design
1. `ParameterizedQuery` class:
   - Constructor takes a query template string with `$name` params
   - Pre-compiles: parses template, extracts param names, creates a cached representation
   - `compile()` method: returns the template with `$param` → `?` placeholders + param names
   - `execute(params)` method: takes a Map/object of params, binds safely, executes via existing parse/cache

2. LRU cache of pre-compiled templates (max 128 entries, reusing existing QueryPlanCache)

3. Pre-compilation: regex `\$[a-zA-Z_]\w*` to find named params, replace with `?` placeholders

4. Safe binding: instead of string replacement, use the pre-compiled structure to safely inject values at the AST/QueryPlan level

## Files
- Modify: `src/query/query-engine.ts` — add `ParameterizedQuery` class
- Modify/Add: `src/query/query-engine.spec.ts` — add tests

## Steps
1. Add `ParameterizedQuery` class to query-engine.ts
2. Add `ParameterizedCypher` factory function
3. Add tests for all scenarios
4. Run tests
