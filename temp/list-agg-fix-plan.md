# Cypher TCK List + Aggregation Fix Plan

## Target: src/query/query-engine.ts only

### Issues by category (in priority order):

### Phase 1: _builtinFunctions fixes (lines 5744-5784)
1. **`range`** - Fix direction logic (sign match); add validation (step=0, non-integer)
2. **`reverse`** - Handle lists in addition to strings
3. **`size`** - Add path/pattern SyntaxError detection in validate
4. **Split current range impl**

### Phase 2: `_validatePlan` / `_validateUndefinedVariables` fix
5. **`withVars` ReferenceError** - Fix TDZ issue in query validation

### Phase 3: `_execAggregation` fix
6. **Aggregation collect/percentile** - Handle collect for nulls, count(DISTINCT) fix

### Phase 4: Missing aggregation functions
7. **percentileCont, percentileDisc** - Add to _builtinFunctions
