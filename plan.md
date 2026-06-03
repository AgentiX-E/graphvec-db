# Plan: String Concatenation + String Predicates

## Implementation plan

### 1. PEG Grammar (`src/query/cypher-lite.peggy`)
- Add `Additive` level between `PrimaryPart` and `Primary` to handle `+`
- Expand `StringPredicate` to accept `Primary` instead of just `(StringLiteral / PropertyRef)`
- Regenerate parser

### 2. Query Engine (`src/query/query-engine.ts`)
- Add `{ type: 'ADD'; left: PrimaryAST; right: PrimaryAST }` to `PrimaryAST`
- Handle `ADD` in `resolvePrimary()` / or create new `_evaluateExpression()` 
- Handle `STRING_PREDICATE` in `_executeQuery()` / `_applyWhereFilters()`
- Update `formatColumn()` for ADD type
- Update `_compareValues()` for string predicates

### 3. Tests (`src/query/string-predicates.spec.ts`)
- ≥7 tests including string concat, mixed types, numeric addition, STARTS WITH, ENDS WITH, CONTAINS, and non-matching
Done ✅
