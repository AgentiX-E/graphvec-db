/**
 * executor-validate-plan.spec.ts — table-driven compile-time validation tests.
 *
 * `_validatePlan` is a pure validator: every branch maps a query shape to a
 * compile-time error (`tckError` discriminator).  This spec drives each error
 * branch directly through `parseQuery` + `_validatePlan` so that all 26 error
 * discriminators are exercised with representative inputs, and asserts the
 * exact `tckError` so the TCK step definitions stay reproducible.
 */
import { describe, it, expect } from 'vitest'
import { parseQuery, _validatePlan } from './query-engine'

/** Run compile-time validation and return the thrown `tckError`, or null. */
function validateErr(query: string): string | null {
  try {
    const plan = parseQuery(query)
    _validatePlan(plan as any, query)
    return null
  } catch (e: any) {
    return e?.tckError ?? e?.constructor?.name ?? String(e)
  }
}

/** Assert that the given query raises a specific `tckError`. */
function expectErr(query: string, tck: string): void {
  expect(validateErr(query)).toBe(tck)
}

describe('executor-validate-plan — SemanticError / scope', () => {
  it('MergeReadOwnWrites: MERGE node with a null property', () => {
    // A null property value can never match an existing node.
    expectErr('MERGE ({num: null})', 'SemanticError')
    expectErr('MERGE (a)-[r:X {num: null}]->(b)', 'SemanticError')
  })

  it('NoVariablesInScope: RETURN * with nothing bound', () => {
    expectErr('MATCH () RETURN *', 'NoVariablesInScope')
  })

  it('NoVariablesInScope is NOT raised when an UNWIND binds a var', () => {
    expect(validateErr('UNWIND [1,2] AS x RETURN *')).toBeNull()
  })
})

describe('executor-validate-plan — InvalidParameterUse', () => {
  it('rejects $param as a RETURN column', () => {
    expectErr('MATCH (n) RETURN $param', 'InvalidParameterUse')
  })

  it('rejects a parameter as a node predicate', () => {
    expectErr('MATCH (n:Person $param) RETURN n', 'InvalidParameterUse')
  })

  it('rejects a parameter as a relationship predicate', () => {
    expectErr('MATCH ()-[r:FOO $param]->() RETURN r', 'InvalidParameterUse')
  })
})

describe('executor-validate-plan — InvalidDelete / DeletedEntityAccess', () => {
  it('rejects DELETE of a label expression', () => {
    expectErr('MATCH (n:Person) DELETE n:Person', 'InvalidDelete')
  })

  it('rejects property access on a deleted entity', () => {
    expectErr('MATCH (n) DELETE n RETURN n.num', 'DeletedEntityAccess')
  })

  it('rejects labels() on a deleted entity', () => {
    expectErr('MATCH (n) DELETE n RETURN labels(n)', 'DeletedEntityAccess')
  })

  it('allows type(r) after DELETE (relationship type remains readable)', () => {
    // type(r) is intentionally excluded from DeletedEntityAccess: a
    // relationship's type stays readable even after deletion.
    expect(validateErr('MATCH (a)-[r]->(b) DELETE r RETURN type(r)')).toBeNull()
  })

  it('rejects deletion of an unbound variable', () => {
    expectErr('MATCH (n) DELETE x', 'UndefinedVariable')
  })
})

describe('executor-validate-plan — negative / float SKIP-LIMIT', () => {
  it('rejects negative SKIP', () => {
    expectErr('MATCH (n) RETURN n SKIP -1', 'NegativeIntegerArgument')
  })

  it('rejects negative LIMIT', () => {
    expectErr('MATCH (n) RETURN n LIMIT -2', 'NegativeIntegerArgument')
  })

  it('rejects floating-point SKIP', () => {
    expectErr('MATCH (n) RETURN n SKIP 1.5', 'InvalidArgumentType')
  })

  it('rejects floating-point LIMIT', () => {
    expectErr('MATCH (n) RETURN n LIMIT 1.7', 'InvalidArgumentType')
  })
})

describe('executor-validate-plan — non-constant SKIP/LIMIT expression', () => {
  it('rejects a variable reference in SKIP', () => {
    expectErr('MATCH (n) RETURN n SKIP n.count', 'NonConstantExpression')
  })

  it('rejects a bare variable in LIMIT', () => {
    expectErr('MATCH (n) RETURN n LIMIT n', 'NonConstantExpression')
  })

  it('accepts a constant function call in SKIP', () => {
    expect(validateErr('MATCH (n) RETURN n SKIP toInteger(rand()*9)')).toBeNull()
  })
})

describe('executor-validate-plan — aggregation validation', () => {
  it('rejects nested aggregation', () => {
    expectErr('MATCH (n) RETURN count(count(*))', 'NestedAggregation')
  })

  it('rejects rand() inside an aggregate argument', () => {
    expectErr('MATCH (n) RETURN count(rand())', 'NonConstantExpression')
  })

  it('rejects ambiguous aggregation mixing key and aggregate', () => {
    expectErr('MATCH (me) RETURN me.age + count(*)', 'AmbiguousAggregationExpression')
  })

  it('rejects a new aggregation in ORDER BY', () => {
    expectErr('MATCH (n) RETURN n ORDER BY count(n)', 'InvalidAggregation')
  })

  it('rejects an aggregate inside a WHERE clause', () => {
    expectErr('MATCH (a) WHERE count(a) > 10 RETURN a', 'InvalidAggregation')
  })
})

describe('executor-validate-plan — CALL procedure validation', () => {
  it('rejects an unknown procedure', () => {
    expectErr('CALL db.unknown.proc()', 'ProcedureNotFound')
  })

  it('rejects too many arguments', () => {
    expectErr('CALL db.labels(1, 2, 3)', 'InvalidNumberOfArguments')
  })

  it('rejects an aggregate as a CALL argument (via parsed plan args)', () => {
    // The aggregate check runs over the parsed callProcedure.args.  Drive it
    // directly with an in-scope arg count so the aggregate guard (not the
    // argument-count guard) is the one that fires.
    const plan = {
      type: 'CALL',
      scanLabel: null,
      labelExpr: null,
      steps: [],
      filters: [],
      returnColumns: [],
      orderBy: [],
      callProcedure: { name: 'db.index.fulltext.queryNodes', args: ['count(*)', "'term'"] as any[] },
    }
    let tck: string | null = null
    try {
      _validatePlan(plan as any, "CALL db.index.fulltext.queryNodes(count(*), 'term')")
    } catch (e: any) {
      tck = e?.tckError ?? e?.constructor?.name ?? String(e)
    }
    expect(tck).toBe('InvalidAggregation')
  })
})

describe('executor-validate-plan — relationship pattern validation', () => {
  it('rejects missing * before a range', () => {
    expectErr('MATCH ()-[:LIKES..]->() RETURN 1', 'InvalidRelationshipPattern')
  })

  it('rejects a negative variable-length bound', () => {
    expectErr('MATCH ()-[:LIKES*-2]->() RETURN 1', 'InvalidRelationshipPattern')
  })

  it('rejects CREATE of an untyped relationship', () => {
    expectErr('CREATE ()-->()', 'NoSingleRelationshipType')
  })

  it('rejects CREATE of a multi-typed relationship', () => {
    expectErr('CREATE ()-[:A|:B]->()', 'NoSingleRelationshipType')
  })

  it('rejects CREATE of a variable-length relationship', () => {
    expectErr('CREATE ()-[:FOO*2]->()', 'CreatingVarLength')
  })

  it('rejects CREATE of an undirected typed relationship', () => {
    expectErr('CREATE (a)-[:R]-(b)', 'RequiresDirectedRelationship')
  })
})

describe('executor-validate-plan — variable binding', () => {
  it('rejects MATCH-bound var reused in CREATE node', () => {
    expectErr('MATCH (a) CREATE (a:Person)', 'VariableAlreadyBound')
  })

  it('allows MATCH-bound vars as relationship endpoints in CREATE', () => {
    expect(validateErr('MATCH (a),(b) CREATE (a)-[:R]->(b)')).toBeNull()
  })

  it('rejects the same node var bound twice across CREATE clauses', () => {
    expectErr('CREATE (n:Foo) CREATE (n:Bar)', 'VariableAlreadyBound')
  })

  it('rejects a path variable reused as a node variable', () => {
    expectErr('MATCH p = (a)-[]-() MATCH (p) RETURN p', 'VariableTypeConflict')
  })

  it('rejects an edge var reused as a node var', () => {
    expectErr('MATCH ()-[r]->() MATCH (r) RETURN r', 'VariableTypeConflict')
  })

  it('rejects duplicate relationship variable in one MATCH', () => {
    expectErr('MATCH (a)-[r]->()-[r]->(a) RETURN a', 'RelationshipUniquenessViolation')
  })
})

describe('executor-validate-plan — WITH / RETURN aliasing', () => {
  it('rejects duplicate WITH aliases', () => {
    expectErr('WITH 1 AS a, 2 AS a RETURN a', 'ColumnNameConflict')
  })

  it('rejects an unaliased non-trivial WITH expression', () => {
    expectErr('MATCH (n) WITH count(*) RETURN n', 'NoExpressionAlias')
  })

  it('rejects a nested aggregate in a WITH expression', () => {
    expectErr('MATCH (n) WITH count(count(*)) AS c RETURN c', 'NestedAggregation')
  })
})

describe('executor-validate-plan — IN operator argument type', () => {
  it('rejects a scalar literal on the right of IN', () => {
    expectErr('MATCH (n) RETURN 1 IN 5', 'InvalidArgumentType')
  })

  it('accepts a list on the right of IN', () => {
    expect(validateErr('MATCH (n) RETURN 1 IN [1,2,3]')).toBeNull()
  })
})

describe('executor-validate-plan — MERGE validation', () => {
  it('rejects MERGE on an already-bound MATCH variable', () => {
    expectErr('MATCH (n) MERGE (n)', 'VariableAlreadyBound')
  })

  it('rejects MERGE re-binding a MATCH relationship', () => {
    expectErr('MATCH (a)-[r]->(b) MERGE (a)-[r]->(b)', 'VariableAlreadyBound')
  })

  it('rejects a variable used as both node and relationship in MERGE', () => {
    expectErr('MATCH (a) MERGE (a)-[a]->(b)', 'VariableTypeConflict')
  })

  it('rejects MERGE of an untyped relationship', () => {
    expectErr('MERGE (a)-->(b)', 'NoSingleRelationshipType')
  })

  it('rejects MERGE of a multi-typed relationship', () => {
    expectErr('MERGE (a)-[:A|:B]->(b)', 'NoSingleRelationshipType')
  })

  it('rejects MERGE of a variable-length relationship', () => {
    expectErr('MERGE (a)-[:FOO*2]->(b)', 'CreatingVarLength')
  })

  it('rejects a parameter predicate in a MERGE relationship', () => {
    expectErr('MERGE (a)-[r:FOO $param]->(b)', 'InvalidParameterUse')
  })

  it('rejects an unbound variable in an ON CREATE SET clause', () => {
    expectErr('MERGE (n) ON CREATE SET x.num = 1', 'UndefinedVariable')
  })
})

describe('executor-validate-plan — CALL passing mode', () => {
  it('rejects bare CALL with YIELD on a parameterized procedure', () => {
    expectErr('CALL db.index.fulltext.queryNodes YIELD node', 'InvalidArgumentPassingMode')
  })

  it('allows bare CALL with YIELD on a no-argument procedure', () => {
    expect(validateErr('CALL db.labels YIELD label')).toBeNull()
  })
})

describe('executor-validate-plan — type() / labels() / length() misuse', () => {
  it('rejects type() on a node variable', () => {
    expectErr('MATCH (n) RETURN type(n)', 'InvalidArgumentType')
  })

  it('rejects labels() on a path variable', () => {
    expectErr('MATCH p = (a)-[]-(b) RETURN labels(p)', 'InvalidArgumentType')
  })

  it('rejects length() on a node variable', () => {
    expectErr('MATCH (n) RETURN length(n)', 'InvalidArgumentType')
  })

  it('rejects size() on a path variable', () => {
    expectErr('MATCH p = (a)-[]-(b) RETURN size(p)', 'SyntaxError')
  })
})
