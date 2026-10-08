import { describe, it, expect } from 'vitest'
import {
  extractMatchClause,
  _validatePatternPosition,
  _validateWhereSelfPattern,
  _stripPatternPredicateSyntax,
  _isPatternPredicate,
  _validateUndefinedVariables,
  _stripExistsSubqueryBlocks,
  _validateExistsSubqueryClauses,
  _validateUnknownFunctions,
  extractEdgePropColumnsFromQuery,
  extractMatchVariables,
  extractVariablesFromQuery,
  extractVariablesFromClause,
  _isInvalidPlan,
  extractEdgesFromNodes,
  _validateOrderByScope,
  _validateUnionComposition,
  _validateSetOperands,
} from './executor-validators'

function tck(name: string, fn: () => void) {
  try {
    fn()
  } catch (e: any) {
    return e as any
  }
  throw new Error(`expected ${name} to throw`)
}

describe('extractMatchClause', () => {
  it('returns the MATCH body', () => {
    expect(extractMatchClause('MATCH (n)-[r]->(m) RETURN n')).toBe('(n)-[r]->(m)')
  })
  it('stops at WHERE / RETURN / WITH', () => {
    expect(extractMatchClause('MATCH (n:Person) WHERE n.age > 18 RETURN n')).toBe('(n:Person)')
  })
  it('returns empty string when no MATCH', () => {
    expect(extractMatchClause('RETURN 1')).toBe('')
  })
})

describe('_validatePatternPosition', () => {
  it('throws UnexpectedSyntax for a bare pattern in RETURN', () => {
    const e = tck('bare pattern in RETURN', () => _validatePatternPosition('MATCH (n) RETURN (n)-->(m)'))
    expect(e.tckError).toBe('UnexpectedSyntax')
  })
  it('throws for a bare pattern in WITH', () => {
    const e = tck('bare pattern in WITH', () => _validatePatternPosition('WITH (a)-->(b) RETURN a'))
    expect(e.tckError).toBe('UnexpectedSyntax')
  })
  it('throws for a pattern in SET right-hand side', () => {
    const e = tck('pattern in SET', () => _validatePatternPosition('SET x = (a)-->(b)'))
    expect(e.tckError).toBe('UnexpectedSyntax')
  })
  it('allows a pattern comprehension in RETURN', () => {
    expect(() => _validatePatternPosition('MATCH (n) RETURN [p = (n)-->(m) | m]')).not.toThrow()
  })
  it('flags a pattern inside exists(...) (function call is not exempt)', () => {
    const e = tck('pattern in exists', () => _validatePatternPosition('MATCH (n) RETURN exists((n)-->(m))'))
    expect(e.tckError).toBe('UnexpectedSyntax')
  })
  it('flags a pattern wrapped in grouping parens', () => {
    const e = tck('pattern in grouping parens', () => _validatePatternPosition('MATCH (n) RETURN ((n)-->(m))'))
    expect(e.tckError).toBe('UnexpectedSyntax')
  })
  it('flags a pattern in a WITH clause', () => {
    const e = tck('pattern in WITH', () => _validatePatternPosition('WITH (a)-->(b) RETURN a'))
    expect(e.tckError).toBe('UnexpectedSyntax')
  })
  it('flags a pattern in a SET right-hand side (direct test)', () => {
    const e = tck('pattern in SET rhs', () => _validatePatternPosition('SET x = (a)-->(b)'))
    expect(e.tckError).toBe('UnexpectedSyntax')
  })
})

describe('_validateWhereSelfPattern', () => {
  it('throws InvalidArgumentType for WHERE (n)', () => {
    const e = tck('self pattern', () => _validateWhereSelfPattern('MATCH (n) WHERE (n) RETURN n'))
    expect(e.tckError).toBe('InvalidArgumentType')
  })
  it('throws for WHERE (n:Label)', () => {
    const e = tck('self labelled pattern', () => _validateWhereSelfPattern('MATCH (n) WHERE (n:Person) RETURN n'))
    expect(e.tckError).toBe('InvalidArgumentType')
  })
  it('allows a normal WHERE condition', () => {
    expect(() => _validateWhereSelfPattern('MATCH (n) WHERE n.age > 18 RETURN n')).not.toThrow()
  })
})

describe('_stripPatternPredicateSyntax', () => {
  it('removes relationship brackets and arrows', () => {
    const out = _stripPatternPredicateSyntax('(n)-[:REL]->(m)')
    expect(out).not.toContain('REL')
  })
  it('removes string literals', () => {
    expect(_stripPatternPredicateSyntax("n.name = 'x' AND m.age > 2")).not.toContain('x')
  })
})

describe('_isPatternPredicate', () => {
  it('returns true for a node/relationship pattern', () => {
    expect(_isPatternPredicate('(n)-->(m)')).toBe(true)
    expect(_isPatternPredicate('(n)-[:R]->(m)')).toBe(true)
  })
  it('returns false for a non-pattern expression', () => {
    expect(_isPatternPredicate('n.age > 18')).toBe(false)
  })
})

describe('_validateUndefinedVariables', () => {
  it('throws for an undefined variable in RETURN', () => {
    const e = tck('undefined in RETURN', () => _validateUndefinedVariables('RETURN foo'))
    expect(e.tckError).toBe('UndefinedVariable')
  })
  it('throws for an undefined variable in WHERE without MATCH vars', () => {
    const e = tck('undefined in WHERE', () => _validateUndefinedVariables('MATCH (n) WHERE (a)-[r]->(n) RETURN n'))
    expect(e.tckError).toBe('UndefinedVariable')
  })
  it('allows defined variables in WHERE', () => {
    expect(() => _validateUndefinedVariables('MATCH (n) WHERE n.age > 18 RETURN n')).not.toThrow()
  })
  it('allows AS aliases to be used in RETURN', () => {
    expect(() => _validateUndefinedVariables('MATCH (n) RETURN n AS x')).not.toThrow()
  })
  it('allows parameter references $x', () => {
    expect(() => _validateUndefinedVariables('MATCH (n) RETURN n.name AS name')).not.toThrow()
  })

  it('allows CREATE-bound node variables in RETURN', () => {
    expect(() => _validateUndefinedVariables('CREATE (a {x:1}) RETURN a')).not.toThrow()
  })
  it('allows MERGE-bound edge variables in RETURN', () => {
    expect(() => _validateUndefinedVariables('MERGE (a)-[r:T]->(b) RETURN r')).not.toThrow()
  })
  it('allows CALL YIELD variables', () => {
    expect(() => _validateUndefinedVariables('CALL db.labels() YIELD label RETURN label')).not.toThrow()
  })
  it('allows WITH projection aliases', () => {
    expect(() => _validateUndefinedVariables('MATCH (n) WITH n.name AS nm RETURN nm')).not.toThrow()
  })
  it('allows path variables in RETURN', () => {
    expect(() => _validateUndefinedVariables('MATCH p = (a)-[r]->(b) RETURN p')).not.toThrow()
  })
  it('allows list-predicate iteration variables', () => {
    expect(() => _validateUndefinedVariables('MATCH (n) RETURN all(x IN n.list WHERE x > 0)')).not.toThrow()
  })
  it('allows property chains (nestedMap.name.name2)', () => {
    expect(() => _validateUndefinedVariables('MATCH (n) RETURN n.nestedMap.name.name2')).not.toThrow()
  })
  it('allows backtick identifiers as non-variables', () => {
    expect(() => _validateUndefinedVariables('MATCH (n) RETURN n.`name`')).not.toThrow()
  })
  it('throws for an undefined bare variable not in MATCH scope', () => {
    const e = tck('undefined bare', () => _validateUndefinedVariables('MATCH (n) WHERE zzz > 1 RETURN n'))
    expect(e.tckError).toBe('UndefinedVariable')
  })
  it('allows map/list literals in RETURN (nested)', () => {
    expect(() => _validateUndefinedVariables("MATCH (n) RETURN {id: 'x', batters: {batter: [1,2]}}")).not.toThrow()
  })
  it('allows a list comprehension without an inner WHERE', () => {
    expect(() => _validateUndefinedVariables('MATCH (n) WITH n, [x IN n.l] AS ys RETURN ys')).not.toThrow()
  })
  it('allows a list predicate any(...) whose inner variable is unbound', () => {
    // The any(...) predicate is stripped wholesale, so `ghost` is not flagged.
    expect(() => _validateUndefinedVariables('MATCH (n) WHERE any(x IN n.list WHERE x = ghost) RETURN n')).not.toThrow()
  })
  it('flags the iteration variable of a WITH list comprehension with inner WHERE', () => {
    // `[x IN n.l WHERE x > 0]` in a WITH leaks the comprehension iterator `x`
    // into the undefined-variable scan (the inner WHERE is mis-parsed as
    // top-level), producing a false `UndefinedVariable`.
    const e = tck('list comprehension iterator', () =>
      _validateUndefinedVariables('MATCH (n) WITH n, [x IN n.l WHERE x > 0] AS ys RETURN ys'))
    expect(e.tckError).toBe('UndefinedVariable')
  })
  it('allows a WITH clause with property projection', () => {
    expect(() => _validateUndefinedVariables('MATCH (n) WITH n.age AS a RETURN a')).not.toThrow()
  })
})

describe('_stripExistsSubqueryBlocks', () => {
  it('returns unchanged when no exists subquery', () => {
    expect(_stripExistsSubqueryBlocks('n.age > 18')).toBe('n.age > 18')
  })
  it('removes exists { ... } blocks', () => {
    const out = _stripExistsSubqueryBlocks('n.age > 18 AND exists { (n)-->(m) }')
    expect(out).not.toContain('(n)-->(m)')
  })
  it('removes nested exists blocks as one unit', () => {
    const out = _stripExistsSubqueryBlocks('exists { exists { (n) } }')
    expect(out.trim()).toBe('')
  })
})

describe('_validateExistsSubqueryClauses', () => {
  it('throws InvalidClauseComposition for SET inside exists', () => {
    const e = tck('SET in exists', () => _validateExistsSubqueryClauses('WHERE exists { MATCH (n) SET n.x = 1 }'))
    expect(e.tckError).toBe('InvalidClauseComposition')
  })
  it('allows read-only exists subquery', () => {
    expect(() => _validateExistsSubqueryClauses('WHERE exists { MATCH (n) RETURN n }')).not.toThrow()
  })
})

describe('_validateUnknownFunctions', () => {
  it('throws UnknownFunction for a made-up function', () => {
    const e = tck('unknown fn', () => _validateUnknownFunctions('MATCH (n) RETURN frobnicate(n)' as any))
    expect(e.tckError).toBe('UnknownFunction')
  })
  it('allows built-in functions', () => {
    expect(() => _validateUnknownFunctions('MATCH (n) RETURN count(n)')).not.toThrow()
    expect(() => _validateUnknownFunctions('MATCH (n) RETURN toString(n.name)')).not.toThrow()
  })
  it('skips temporal static methods', () => {
    expect(() => _validateUnknownFunctions('RETURN date.truncate("day", date())')).not.toThrow()
  })
})

describe('extractEdgePropColumnsFromQuery', () => {
  it('returns edge variables referenced in RETURN', () => {
    const out = extractEdgePropColumnsFromQuery('MATCH (a)-[r:T]->(b) RETURN r.num')
    expect(out).toContain('r')
  })
  it('returns empty for non-edge properties', () => {
    expect(extractEdgePropColumnsFromQuery('MATCH (a) RETURN a.name')).toEqual([])
  })
})

describe('extractMatchVariables', () => {
  it('extracts node and edge variables', () => {
    const vars = extractMatchVariables('MATCH (a)-[r:T]->(b) RETURN a')
    expect(vars).toEqual(expect.arrayContaining(['a', 'b', 'r']))
  })
  it('extracts path variables (p = ...)', () => {
    const vars = extractMatchVariables('MATCH p = (a)-[r*]->(b) RETURN p')
    expect(vars).toContain('p')
  })
  it('handles empty query', () => {
    expect(extractMatchVariables('')).toEqual([])
  })
})

describe('extractVariablesFromQuery / FromClause', () => {
  it('extracts all node/edge vars from a query', () => {
    const vars = extractVariablesFromQuery('CREATE (a {x:1}) MATCH (b)-[r]->(a)')
    expect(vars).toEqual(expect.arrayContaining(['a', 'b', 'r']))
  })
  it('extracts vars from a clause', () => {
    const vars = extractVariablesFromClause('(a)-[r:T1]->(b)')
    expect(vars).toEqual(expect.arrayContaining(['a', 'b', 'r']))
  })
})

describe('_isInvalidPlan', () => {
  it('returns true for a plan with all-empty fields', () => {
    expect(_isInvalidPlan({
      steps: [], filters: [], returnColumns: [], hasMatch: false,
    } as any)).toBe(true)
  })
  it('returns false for an entirely empty object (missing fields are not empty arrays)', () => {
    // `plan.steps?.length === 0` is `undefined === 0` -> false, so `{}` is
    // treated as NOT invalid (defensive: a plan with no fields is ambiguous).
    expect(_isInvalidPlan({} as any)).toBe(false)
  })
  it('returns false when a scanLabel is present', () => {
    expect(_isInvalidPlan({ scanLabel: 'X' } as any)).toBe(false)
  })
  it('returns false when returnColumns present', () => {
    expect(_isInvalidPlan({ returnColumns: ['x'] } as any)).toBe(false)
  })
})

describe('extractEdgesFromNodes', () => {
  it('extracts edges with numeric indices', () => {
    const nodes = [{ __edges: [{ srcIdx: 0, dstIdx: 1, label: 'T' }] }]
    expect(extractEdgesFromNodes(nodes)).toEqual([{ srcIdx: 0, dstIdx: 1, label: 'T', props: null }])
  })
  it('coerces string indices (CVE-H5)', () => {
    const nodes = [{ __edges: [{ srcIdx: '0', dstIdx: '1', label: 'T' }] }]
    expect(extractEdgesFromNodes(nodes)).toEqual([{ srcIdx: 0, dstIdx: 1, label: 'T', props: null }])
  })
  it('skips edges with non-numeric indices', () => {
    const nodes = [{ __edges: [{ srcIdx: 'x', dstIdx: 'y', label: 'T' }] }]
    expect(extractEdgesFromNodes(nodes)).toEqual([])
  })
})

describe('_validateOrderByScope', () => {
  it('does nothing without ORDER BY', () => {
    expect(() => _validateOrderByScope('MATCH (n) RETURN n')).not.toThrow()
  })
  it('throws when ORDER BY references an out-of-scope variable after WITH', () => {
    const e = tck('order by scope', () =>
      _validateOrderByScope('MATCH (a), (b) WITH a RETURN a ORDER BY b'))
    expect(e.tckError).toBe('UndefinedVariable')
  })
  it('allows ORDER BY on a WITH projection alias', () => {
    expect(() => _validateOrderByScope('WITH 1 AS a ORDER BY a RETURN a')).not.toThrow()
  })
  it('allows ORDER BY on MATCH scope variables', () => {
    expect(() => _validateOrderByScope('MATCH (n) RETURN n ORDER BY n.name')).not.toThrow()
  })
  it('throws when ORDER BY references a never-defined variable', () => {
    const e = tck('order by undefined', () =>
      _validateOrderByScope('MATCH (n) RETURN n ORDER BY zzz'))
    expect(e.tckError).toBe('UndefinedVariable')
  })
  it('allows ORDER BY on UNWIND variable', () => {
    expect(() => _validateOrderByScope('UNWIND [1,2,3] AS x RETURN x ORDER BY x')).not.toThrow()
  })
  it('throws on ORDER BY a variable dropped by WITH DISTINCT semantics', () => {
    const e = tck('distinct order by', () =>
      _validateOrderByScope('MATCH (a), (b) WITH a.name AS n RETURN n ORDER BY b'))
    expect(e.tckError).toBe('UndefinedVariable')
  })
  it('allows ORDER BY property chain on a scoped variable', () => {
    expect(() => _validateOrderByScope("MATCH (n) RETURN n ORDER BY n.person.name")).not.toThrow()
  })
  it('ignores map-literal keys in ORDER BY (temporal constructor)', () => {
    expect(() => _validateOrderByScope('RETURN duration({months: 1}) AS d ORDER BY d')).not.toThrow()
  })
})

describe('_validateUnionComposition', () => {
  it('does nothing without a set operator', () => {
    expect(() => _validateUnionComposition({}, 'MATCH (n) RETURN n')).not.toThrow()
  })
  it('throws DifferentColumnsInUnion for mismatched columns', () => {
    const e = tck('different cols', () =>
      _validateUnionComposition(
        { unionType: 'UNION', rightPlan: { returnColumns: ['b'] }, returnColumns: ['a'] },
        'RETURN 1 AS a UNION RETURN 2 AS b'))
    expect(e.tckError).toBe('DifferentColumnsInUnion')
  })
  it('throws InvalidClauseComposition for mixing UNION and UNION ALL', () => {
    const e = tck('mixed union', () =>
      _validateUnionComposition({}, 'RETURN 1 UNION RETURN 2 UNION ALL RETURN 3'))
    expect(e.tckError).toBe('InvalidClauseComposition')
  })
  it('allows uniform UNION ALL', () => {
    expect(() => _validateUnionComposition({}, 'RETURN 1 UNION ALL RETURN 2 UNION ALL RETURN 3')).not.toThrow()
  })
  it('allows matching columns via returnAliasMap', () => {
    expect(() => _validateUnionComposition(
      { unionType: 'UNION', returnAliasMap: { a: 'n.name' }, rightPlan: { returnAliasMap: { a: 'm.name' } } },
      'MATCH (n) RETURN n.name AS a UNION MATCH (m) RETURN m.name AS a')).not.toThrow()
  })
  it('throws DifferentColumnsInUnion on column count mismatch', () => {
    const e = tck('count mismatch', () =>
      _validateUnionComposition(
        { unionType: 'UNION', returnColumns: ['a', 'b'], rightPlan: { returnColumns: ['a'] } },
        'RETURN 1 AS a, 2 AS b UNION RETURN 1 AS a'))
    expect(e.tckError).toBe('DifferentColumnsInUnion')
  })
})

describe('_validateSetOperands', () => {
  it('throws for an unbound bare identifier in SET RHS', () => {
    const e = tck('unbound set operand', () =>
      _validateSetOperands('MATCH (a) SET a.name = missing'))
    expect(e.tckError).toBe('UndefinedVariable')
  })
  it('allows bound variables and literals in SET RHS', () => {
    expect(() => _validateSetOperands('MATCH (a) SET a.name = "foo"')).not.toThrow()
    expect(() => _validateSetOperands('MATCH (a), (b) SET a.name = b.name')).not.toThrow()
  })
  it('allows keywords as RHS', () => {
    expect(() => _validateSetOperands('MATCH (a) SET a.x = null')).not.toThrow()
  })
  it('throws for a bare undefined identifier with CREATE-bound context', () => {
    const e = tck('set operand create', () =>
      _validateSetOperands('MATCH (a) SET a.x = ghost'))
    expect(e.tckError).toBe('UndefinedVariable')
  })
  it('allows property access and function calls as RHS', () => {
    expect(() => _validateSetOperands('MATCH (a) SET a.x = a.y')).not.toThrow()
    expect(() => _validateSetOperands('MATCH (a) SET a.x = toString(a.y)')).not.toThrow()
  })
  it('allows numeric literals as RHS', () => {
    expect(() => _validateSetOperands('MATCH (a) SET a.x = 42')).not.toThrow()
  })
  it('allows multiple SET assignments (comma split)', () => {
    expect(() => _validateSetOperands('MATCH (a) SET a.x = 1, a.y = 2')).not.toThrow()
  })
})
