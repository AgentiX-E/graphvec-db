# RETURN / RETURN-ORDERBY / RETURN-SKIP-LIMIT Fix Plan

## Current Baseline (master, b8e94fc3)
- return: 18/63 pass (45 fail)
- return-orderby: 1/35 pass (33 fail + 1 undefined)
- return-skip-limit: 7/31 pass (18 fail + 6 undefined)

## Analysis of Failures

### Return1 (1 fail)
- [ ] RETURN foo — UndefinedVariable not thrown (need validation that detects undefined vars in RETURN)
- `MATCH () RETURN foo` should raise SyntaxError: UndefinedVariable

### Return2 (10 fails)
- [ ] NaN → null (arithmetic with null: `null + 5` = `NaN` should be `null`)
- [ ] `r.num` as property access from relationship variable
- [ ] `(n:Foo)` label predicate expression - should return boolean
- [ ] `count(a) > 0` should be evaluated, not passed as raw expression

### Return3 (1 fail)
- [ ] Edge relationship RETURN ambiguity (bar should not equal [:T])
- Actually this is an ordering/structure issue

### Return4 (7 fails)
- [ ] count(*) should work
- [ ] DML RETURN should work
- [ ] Column name for count should be correct
- [ ] Aggregation with grouping 
- [ ] DISTINCT in aggregation

### Return5 (5 fails)
- [ ] count with grouping (too many rows or wrong count values)
- [ ] count(DISTINCT ...)

### Return6 (18 fails)
- [ ] RETURN n (node representation null) - this is a big one
- [ ] RETURN aggregation expressions with arithmetic
- [ ] count with grouping

### Return7 (2 fails)
- [ ] RETURN * - variables should be expanded
- [ ] RETURN * with no variables should raise NoVariablesInScope

### Return8 (1 fail)
- [ ] count(*) in simple query

## Key Fixes Needed

### Fix 1: `_formatResultRow` - RETURN n (node variable representation)
When RETURN n matches a variable from MATCH, the node should be represented as `(:Label {prop1: val1, ...})` format.

### Fix 2: `_formatResultRow` - RETURN * (all variables)
RETURN * needs to expand to all scope variables. Missing variables should be detected.

### Fix 3: _evaluateExpression - null arithmetic
In `_evaluateExpression`, when one operand is null, all arithmetic operations should return null (not NaN).

### Fix 4: _evaluateExpression - label predicate `(n:Foo)`
Parenthesized label expressions should evaluate to boolean true/false.

### Fix 5: _evaluateExpression - count(*) and aggregation handling
Aggregate functions in RETURN without GROUP BY should still work.

### Fix 6: _validatePlan - UndefinedVariable detection
MATCH () RETURN foo should raise UndefinedVariable when foo is not defined.

### Fix 7: Aggregation - column name count(*) capitalization
count(*) should be cOuNt( * ) or as specified.

## Execution Order
1. Fix NaN → null in `_evaluateExpression` (Fix 3) - easy fix
2. Fix `_formatResultRow` for RETURN n / RETURN * (Fix 1, 2) - critical
3. Fix `_validatePlan` UndefinedVariable (Fix 6)
4. Fix aggregation column names (Fix 5, 7)
5. Test and iterate
