# Parser Fix Plan - v57 #108c

Goal: Fix ~106 TCK extension query failures by modifying the PEG parser and query engine.

## Root Issues Identified

1. **EdgePattern LabelExpression uses wrong rule** — LabelExpression expects leading `:`, but the colon is already consumed by EdgePattern, so `-[:KNOWS*2..5]->` fails
2. **Column rule doesn't chain FunctionCall with `+`** — `toUpper(...) + ...` needs to go through Additive, not just `FunctionCall + \+ + ListSubscript`
3. **Nested subscript** — `[[1,2],[3,4]][0][1]` — needs `ListSubscript` to chain recursively
4. **MatchStatement has OPTIONAL MATCH but parseQuery direct path doesn't route OPTIONAL MATCH queries to planFromAST correctly** — `directAst.type === 'QUERY' && directAst.match` evaluates, but `directAst.optionalMatches` is ignored
5. **DELETE in MatchStatement returns QUERY type with both match and delete** — But parseQuery enters the compound QUERY branch which only checks `(directAst.create || directAst.set || directAst.remove || directAst.delete || directAst.forEach || directAst.match)` and the delete clause check isn't right
6. **UNWIND + WITH combo** — UnwindStatement rule lacks WITH clause
7. **FUNCTION_CHAIN** — Column rule has `FunctionCall _ op:("+" / "-") _ rest:ListSubscript` but this requires `+` immediately after function call without space, and `ListSubscript` isn't the right follow-up — needs `Additive`
8. **HAVING with `>` comparison** — HAVING uses OrExpression which may not handle `>` properly

## Fix Plan

### Batch 1: PEG grammar fixes

#### 1.1 `LabelExpressionNoColon` rule + fix EdgePattern (VARLEN + MULTI_RELTYPE)
- Add `LabelExpressionNoColon` rule that's like `LabelExpression` but without leading `:`
- Change EdgePattern rules (lines 891-897) from `LabelExpression` to `LabelExpressionNoColon`
- Also fix `-[:TYPE:` → PipePartStyle for `:KNOWS|:WORKS_WITH`

#### 1.2 Column rule for FunctionCall chaining (FUNCTION_CHAIN)
- Fix the Column rule for `FunctionCall _ op:("+" / "-") _ rest:Additive` to properly chain
- Add: `expr:FunctionCall _ op:AdditiveOp _ rest:Additive alias:AsClause?`

#### 1.3 Nested subscript (NESTED_LIST_INDEX)
- `ListSubscript` currently returns `expr:Primary "["...` which only goes one level deep
- Need to make `ListSubscript` recursive: the expr in subscript can itself be a subscript

#### 1.4 UNWIND + WITH (UNWIND_COMPLEX)
- Add UnwindStatement rules for `UNWIND ... WITH ... RETURN` and `UNWIND ... WITH ... MATCH ... RETURN`

#### 1.5 WITH DISTINCT
- Add `DISTINCT` keyword support in `WithClause`

#### 1.6 HAVING with comparison operator
- HAVING expression currently uses `OrExpression` — change to allow `>`/`<` operators

#### 1.7 MULTI_MATCH + MATCH_CREATE (comma-separated MATCH patterns then CREATE)
- Currently MatchClause supports PatternList (comma-separated paths)
- But ensure `MATCH (a:Person), (b:Person) CREATE ...` works with DMLStatement

### Batch 2: Query engine fixes

#### 2.1 OPTIONAL MATCH routing
- When `directAst.type === 'QUERY'` has `match` and `optionalMatches`, route through `planFromAST`
- OR: force queries containing "OPTIONAL MATCH" through preprocessing path

#### 2.2 DELETE routing
- When `directAst` has both `match: {...}` and `delete: {...}`, planFromAST should handle it

## Implementation Order
1. Fix PEG grammar for all syntax issues
2. Compile PEG → parser
3. Fix parseQuery routing in query engine
4. Test all 106 queries
