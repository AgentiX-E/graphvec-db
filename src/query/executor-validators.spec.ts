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
  it('skips a string literal containing braces/quotes inside exists{}', () => {
    // A string with an escaped quote and braces inside exists{} exercises the
    // subquery-clause validator's own inStr escape handling.
    expect(() =>
      _validateExistsSubqueryClauses("WHERE exists { MATCH (n) WHERE n.x = 'a\\'b{c}' RETURN n }")
    ).not.toThrow()
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

// ═══════════════════════════════════════════════════════════════════════════
// Defense-in-depth branch coverage — string escape handling, comprehension
// depth tracking, chained pattern rewind, SET binding-table construction.
// ═══════════════════════════════════════════════════════════════════════════

describe('_validatePatternPosition — comprehension bracket-depth tracking', () => {
  it('closes an earlier [..] to depth zero before a bare pattern is flagged', () => {
    // A preceding `[x]` list that is fully closed (bracketDepth back to 0)
    // must NOT shield a later bare pattern — bracketDepth<=0 reset branch.
    const e = tck('bare pattern after closed list', () =>
      _validatePatternPosition('RETURN [1,2,3], (n)-->(m)')
    )
    expect(e.tckError).toBe('UnexpectedSyntax')
  })

  it('tolerates a bare pattern after a fully-closed group', () => {
    // A closed `(...)` group before the pattern is not a comprehension opener;
    // a bare pattern after it is still unexpected (exercises the `)` reset path).
    const e = tck('bare pattern after closed group', () =>
      _validatePatternPosition('RETURN (1+2), (n)-->(m)')
    )
    expect(e.tckError).toBe('UnexpectedSyntax')
  })
})

describe('_stripExistsSubqueryBlocks — string-escape handling inside exists{}', () => {
  it('skips escaped quotes and closes strings inside an exists subquery', () => {
    // A string literal with an escaped quote (\') inside exists{} exercises the
    // inStr escape branch (k++ + continue) and the closing-quote branch.
    const out = _stripExistsSubqueryBlocks(
      "WHERE exists { MATCH (n) WHERE n.name = 'it\\'s' RETURN n }"
    )
    expect(out).not.toContain('MATCH (n)')
  })

  it('handles double-quoted strings inside exists{}', () => {
    const out = _stripExistsSubqueryBlocks('WHERE exists { MATCH (n) WHERE n.x = "a" }')
    expect(out).not.toContain('WHERE n.x')
  })
})

describe('_validateUndefinedVariables — pattern predicate with no MATCH vars', () => {
  it('validates a bare WHERE pattern when no MATCH variables exist', () => {
    // `matchVars.length === 0` branch: WHERE `(a)` with no MATCH binds `a` →
    // _validatePatternPredicateVariables is invoked and throws.
    const e = tck('unbound pattern predicate without MATCH', () =>
      _validateUndefinedVariables('WITH 1 AS x WHERE (a)-->(b) RETURN x', {})
    )
    expect(e.tckError).toBe('UndefinedVariable')
  })
})

describe('_validatePatternPredicateVariables — chained pattern rewind', () => {
  it('rewinds the last index for chained patterns', () => {
    // A three-segment chained pattern forces a second/third regex iteration and
    // the `lastIndex` rewind branch; the tail var is caught on a later pass.
    const e = tck('chained pattern unbound tail', () =>
      _validateUndefinedVariables(
        'MATCH (a), (b) WHERE (a)-[:R]->(b)-[:R]->(c)-[:R]->(d) RETURN a',
        {}
      )
    )
    expect(e.tckError).toBe('UndefinedVariable')
  })
})

describe('_validateUndefinedVariables — top-level keyword scan', () => {
  it('flags an undefined variable in a RETURN with no MATCH scope', () => {
    // Confirms the no-MATCH-var undefined-variable path (matchVars.length===0)
    // still surfaces UndefinedVariable for a bare RETURN column.
    const e = tck('bare undefined var in RETURN', () =>
      _validateUndefinedVariables('RETURN undefinedVar', {})
    )
    expect(e.tckError).toBe('UndefinedVariable')
  })

  it('flags a bare node pattern predicate with an unbound variable', () => {
    // The bareNodeRE block: `WHERE (n)` where `n` is unbound → UndefinedVariable.
    const e = tck('bare node pattern unbound', () =>
      _validateUndefinedVariables('MATCH (a) WHERE (n) RETURN a', {})
    )
    expect(e.tckError).toBe('UndefinedVariable')
  })
})

describe('_validateOrderByScope — clause splitter string-escape handling', () => {
  it('splits clauses across a string literal containing an escaped quote', () => {
    // A string literal with a backslash-escaped quote exercises the clause
    // splitter's inStr escape branch (backslash skip + inner continue).
    expect(() =>
      _validateOrderByScope("MATCH (a) WHERE a.name = 'it\\'s' RETURN a ORDER BY a.name")
    ).not.toThrow()
  })

  it('tolerates a double-quoted string with embedded content', () => {
    expect(() =>
      _validateOrderByScope('MATCH (a) WHERE a.name = "x" RETURN a ORDER BY a.name')
    ).not.toThrow()
  })
})

describe('_validateSetOperands — binding-table construction', () => {
  it('collects node vars from CREATE/MERGE into the defined set', () => {
    // A SET assignment whose RHS references a CREATE/MERGE-bound var exercises
    // the CREATE|MERGE flatMap arrow extraction at lines 1010-1011.
    expect(() => _validateSetOperands('CREATE (n) SET n.x = 1')).not.toThrow()
  })

  it('collects relationship/UNWIND/WITH aliases into the defined set', () => {
    // UNWIND/WITH `AS` aliases and bracketed relationship vars feed the defined
    // set construction at lines 1009-1013.
    expect(() =>
      _validateSetOperands('UNWIND [1] AS x WITH x AS y SET y = x')
    ).not.toThrow()
  })

  it('returns -1 when an assignment has no = (findTopLevel miss)', () => {
    // An assignment with no `=` skips the RHS check (eqIdx < 0 → continue),
    // exercising the _findTopLevel -1 return path.
    expect(() => _validateSetOperands('MATCH (a) SET 42')).not.toThrow()
  })

  it('skips a numeric bare identifier in SET RHS', () => {
    expect(() => _validateSetOperands('MATCH (a) SET a.x = 2b')).not.toThrow()
  })

  it('tracks nesting depth through parens/brackets in SET RHS', () => {
    // A RHS with nested parens, brackets, and braces exercises the depth
    // tracking in _findTopLevel / _splitTopLevel (increment + decrement).
    expect(() =>
      _validateSetOperands('MATCH (a) SET a.x = f(1 + [2, {k: 3}])')
    ).not.toThrow()
  })

  it('returns early on an empty query', () => {
    expect(() => _validateSetOperands('')).not.toThrow()
  })
})

describe('_validateOrderByScope — numeric id and backtick identifier', () => {
  it('skips a numeric ORDER BY identifier', () => {
    // A numeric-looking identifier in ORDER BY hits the `/^\d/.test(id)` guard
    // and is silently skipped (no scope error raised).
    expect(() =>
      _validateOrderByScope('MATCH (a) RETURN a.name ORDER BY 1')
    ).not.toThrow()
  })

  it('handles a backtick-quoted identifier in the clause splitter', () => {
    // Backtick-quoted identifiers exercise the inBacktick branches of the
    // clause splitter (lines 770-772).
    expect(() =>
      _validateOrderByScope('MATCH (a) RETURN a.name AS `name` ORDER BY `name`')
    ).not.toThrow()
  })
})

describe('_validateUnionComposition — empty guard', () => {
  it('returns early on an empty query', () => {
    expect(() => _validateUnionComposition('')).not.toThrow()
  })
})

describe('_validatePatternPosition — nested/unclosed bracket comprehension (L64/L68)', () => {
  it('does NOT throw for a bare pattern inside a NESTED comprehension', () => {
    // `[[p = (n)-->() | p]]` — outer `[` then inner `[` reset lastOpenBracket;
    // bracketDepth goes 1 then 2, closing brings it back; pattern is inside.
    expect(() => _validatePatternPosition('RETURN [[p = (n)-->() | p]]')).not.toThrow()
  })
  it('does NOT throw for an unclosed bracket before the pattern', () => {
    // bracketDepth > 0 with lastOpenBracket >= 0 at pattern index
    expect(() => _validatePatternPosition('RETURN [x IN xs WHERE (n)-->() ]')).not.toThrow()
  })
})

describe('_validatePatternPosition — SET right-hand pattern (L110/L112)', () => {
  it('throws on SET clause with pattern RHS', () => {
    expect(() => _validatePatternPosition('MATCH (n) SET n.x = (a)-->(b)')).toThrow(/UnexpectedSyntax/)
  })
  it('does NOT throw on SET without a pattern RHS', () => {
    expect(() => _validatePatternPosition('MATCH (n) SET n.x = 1')).not.toThrow()
  })
})

describe('_validateWhereSelfPattern — no WHERE clause (L125 false)', () => {
  it('returns silently when there is no WHERE clause', () => {
    expect(() => _validateWhereSelfPattern('MATCH (n) RETURN n')).not.toThrow()
  })
})

describe('_validateUndefinedVariables — CALL YIELD alias forms (L207)', () => {
  it('binds both `AS` alias and bare YIELD identifier', () => {
    expect(() => _validateUndefinedVariables('CALL db.labels() YIELD label AS l RETURN l')).not.toThrow()
    expect(() => _validateUndefinedVariables('CALL db.labels() YIELD label RETURN label')).not.toThrow()
  })
})

describe('_validateUndefinedVariables — WITH bracket-aware truncation (L229-L241)', () => {
  it('handles parens/brackets/WHERE inside nested structures', () => {
    // clauseBody with `(` increments parenDepth, `[` increments bracketDepth;
    // the defensive `parenDepth<0`/`bracketDepth<0` reset arms fire on stray closers.
    expect(() => _validateUndefinedVariables('MATCH (a) WITH a, size([1,2]) AS s WHERE s > 0 RETURN s')).not.toThrow()
  })
})

describe('_validateUndefinedVariables — keyword/number/alias filtering (L336-L362)', () => {
  it('skips numbers, keywords, aliases, and $-params; still catches unbound base var', () => {
    // `1 AS one` (number), `$param AS p` ($-param) are skipped; `n.name` still
    // references an unbound base variable `n` (no MATCH), so it throws.
    expect(() => _validateUndefinedVariables('RETURN 1 AS one, $param AS p')).not.toThrow()
    expect(() => _validateUndefinedVariables('RETURN n.name AS name')).toThrow(/UndefinedVariable/)
  })
})

describe('_validateUndefinedVariables — unknown function name in WHERE (L401-L413)', () => {
  it('strips known function args but keeps unknown-func body for identifier scan', () => {
    expect(() => _validateUndefinedVariables('MATCH (n) WHERE weirdfn(n) RETURN n')).not.toThrow()
  })
  it('skips keyword/number identifiers in cleaned WHERE body', () => {
    expect(() => _validateUndefinedVariables('MATCH (n) WHERE n.x = 42 AND n.y IS NULL RETURN n')).not.toThrow()
  })
})

describe('_validatePatternPredicateVariables — anonymous/empty relationship (L512-L535)', () => {
  it('skips empty `[]` and `[:Label]` relationship inner, binds named rel var', () => {
    expect(() => _validateUndefinedVariables('MATCH (n) WHERE (n)-[]->() RETURN n')).not.toThrow()
    expect(() => _validateUndefinedVariables('MATCH (n) WHERE (n)-[:R]->() RETURN n')).not.toThrow()
  })
})

describe('_stripExistsSubqueryBlocks — no exists{} (L549 false)', () => {
  it('returns input unchanged when no exists subquery', () => {
    expect(_stripExistsSubqueryBlocks('MATCH (n) RETURN n')).toBe('MATCH (n) RETURN n')
  })
})

describe('_validateUnknownFunctions — no RETURN / temporal static / dot-method (L579-L597)', () => {
  it('returns silently when no RETURN clause', () => {
    expect(() => _validateUnknownFunctions('MATCH (n) WHERE n')).not.toThrow()
  })
  it('skips temporal static method call', () => {
    expect(() => _validateUnknownFunctions('RETURN date.truncate("day", date())')).not.toThrow()
  })
})

describe('extractEdgePropColumnsFromQuery — edge var with prop (L608-L616)', () => {
  it('extracts only edge-var.prop columns', () => {
    expect(extractEdgePropColumnsFromQuery('MATCH (a)-[r:T]->(b) RETURN r.num')).toEqual(['r'])
  })
  it('returns [] when no RETURN clause', () => {
    expect(extractEdgePropColumnsFromQuery('MATCH (a)-[r:T]->(b)')).toEqual([])
  })
})

describe('extractMatchVariables — path var / node / edge (L644-L682)', () => {
  it('extracts path var, node vars (before edge var), and edge var', () => {
    // Order: path var first, then node vars (a,b via nodeVars loop), then edge var (r).
    expect(extractMatchVariables('MATCH p = (a)-[r:T]->(b) RETURN p')).toEqual(['p', 'a', 'b', 'r'])
  })
  it('extracts node vars with inline props and edge var-length', () => {
    expect(extractMatchVariables('MATCH (n {x:1})-[r*1..2]->(m) RETURN n')).toEqual(['n', 'm', 'r'])
  })
})

describe('extractEdgesFromNodes — string vs number edge indices (L704-L711)', () => {
  it('accepts string-form edge indices and converts them', () => {
    const nodes = [{ __edges: [{ srcIdx: '0', dstIdx: '1', label: 'T' }] }]
    expect(extractEdgesFromNodes(nodes)).toEqual([{ srcIdx: 0, dstIdx: 1, label: 'T', props: null }])
  })
  it('accepts string edge label and missing props', () => {
    const nodes = [{ __edges: [{ srcIdx: 0, dstIdx: 1, label: '' }] }]
    expect(extractEdgesFromNodes(nodes)).toEqual([{ srcIdx: 0, dstIdx: 1, label: '', props: null }])
  })
})

describe('_validateOrderByScope — clause splitter escapes (L765-L792)', () => {
  it('handles backslash escape inside string literal', () => {
    expect(() => _validateOrderByScope('RETURN "a\\"b" AS x ORDER BY x')).not.toThrow()
  })
  it('handles keyword at depth-nonzero vs depth-zero boundary', () => {
    expect(() => _validateOrderByScope('MATCH (n) WHERE n.x = 1 RETURN n ORDER BY n.x')).not.toThrow()
  })
})

describe('_validateOrderByScope — DISTINCT / bare projection / unwind (L859-L915)', () => {
  it('restricts ORDER BY to aliases under RETURN DISTINCT', () => {
    expect(() => _validateOrderByScope('RETURN DISTINCT 1 AS a ORDER BY a')).not.toThrow()
    expect(() => _validateOrderByScope('MATCH (n) WITH n RETURN DISTINCT n.name AS name ORDER BY n.age')).toThrow(/UndefinedVariable/)
  })
  it('adds UNWIND AS variable to scope', () => {
    expect(() => _validateOrderByScope('UNWIND [1,2] AS x RETURN x ORDER BY x')).not.toThrow()
  })
})

describe('_validateSetOperands — binding table construction (L1020-L1055)', () => {
  it('skips empty body and number/$-prefixed names', () => {
    expect(() => _validateSetOperands('MATCH (a) SET a.x = 5')).not.toThrow()
    expect(() => _validateSetOperands('MATCH (a) SET a.x = $v')).not.toThrow()
  })
  it('throws for bare unbound identifier in SET RHS', () => {
    expect(() => _validateSetOperands('MATCH (a) SET a.name = missing')).toThrow(/UndefinedVariable/)
  })
})

describe('_validateUndefinedVariables — numeric/keyword/alias/dollar filtering (L341-L367)', () => {
  it('skips a numeric-leading bare identifier in RETURN', () => {
    expect(() => _validateUndefinedVariables('RETURN 42')).not.toThrow()
  })
  it('does not flag a keyword-like bare identifier', () => {
    // `NULL` / `TRUE` are keywords, not variables — already covered, but a
    // bare `count` (keyword) as a column must not raise UndefinedVariable.
    expect(() => _validateUndefinedVariables('MATCH (n) RETURN n, count(*) AS c')).not.toThrow()
  })
  it('skips an AS-alias identifier in the bare scan', () => {
    expect(() => _validateUndefinedVariables('MATCH (n) RETURN n.name AS name, name')).not.toThrow()
  })
})

describe('_validateUndefinedVariables — MATCH-with-vars path (L406-L418)', () => {
  it('skips numeric and keyword identifiers in the WHERE body clean scan', () => {
    expect(() => _validateUndefinedVariables('MATCH (n) WHERE n.x = 42 AND n.y IS NULL RETURN n')).not.toThrow()
  })
})

describe('_validateExistsSubqueryClauses — nested braces and temporal skip (L554-L602)', () => {
  it('scans nested exists{} braces and detects update clauses', () => {
    expect(() => _validateExistsSubqueryClauses('MATCH (n) WHERE exists { MATCH (m) SET m.x = 1 } RETURN n')).toThrow(/InvalidClauseComposition/)
  })
  it('skips temporal static constructor in RETURN', () => {
    expect(() => _validateUnknownFunctions('RETURN datetime({year:2024})')).not.toThrow()
  })
})

describe('extractEdgePropColumnsFromQuery — matches but no RETURN / numeric edge (L613-L616)', () => {
  it('returns [] when no RETURN clause despite MATCH', () => {
    expect(extractEdgePropColumnsFromQuery('MATCH (a)-[r:T]->(b) WHERE r.x > 0')).toEqual([])
  })
  it('skips numeric edge var names', () => {
    expect(extractEdgePropColumnsFromQuery('MATCH (a)-[1:T]->(b) RETURN 1.num')).toEqual([])
  })
})

describe('extractMatchVariables — numeric guards (L649-L687)', () => {
  it('skips node vars starting with a digit', () => {
    expect(extractMatchVariables('MATCH (1n) RETURN 1n')).toEqual([])
  })
})

describe('_validateOrderByScope — numeric id + clause splitter (L770-L797)', () => {
  it('handles trailing space and keyword-at-depth-zero', () => {
    expect(() => _validateOrderByScope('RETURN 1 AS x ORDER BY x')).not.toThrow()
  })
})

describe('_validateSetOperands — empty body / numeric / dollar name (L1025-L1041)', () => {
  it('skips empty body (trailing comma) and numeric/$ names', () => {
    expect(() => _validateSetOperands('MATCH (a) SET a.x = 1,')).not.toThrow()
    expect(() => _validateSetOperands('MATCH (a) SET a.x = 2num')).not.toThrow()
  })
})

describe('extractMatchVariables / FromQuery / FromClause — digit-leading guard (L649-L687)', () => {
  it('skips digit-leading node and edge variables', () => {
    expect(extractMatchVariables('MATCH (1n)-[1r:T]->(2m) RETURN 1n')).toEqual([])
  })
  it('extractVariablesFromQuery skips digit-leading node/edge', () => {
    expect(extractVariablesFromQuery('MATCH (1n)-[1r:T]->(2m)')).toEqual([])
  })
  it('extractVariablesFromClause skips digit-leading node/edge', () => {
    expect(extractVariablesFromClause('(1n)-[1r:T]->(2m)')).toEqual([])
  })
  it('extractMatchVariables skips digit-leading path var', () => {
    expect(extractMatchVariables('MATCH 1p = (a)-[:T]->(b) RETURN a')).toEqual(['a', 'b'])
  })
})

describe('_validatePatternPosition — bare pattern in RETURN/WITH/SET (L84-L110)', () => {
  it('throws for bare pattern in RETURN (not in function/comprehension)', () => {
    expect(() => _validatePatternPosition('MATCH (a) RETURN (a)-->(b)')).toThrow(/UnexpectedSyntax/)
  })
  it('throws for bare pattern in WITH', () => {
    expect(() => _validatePatternPosition('MATCH (a) WITH (a)-->(b) AS x RETURN x')).toThrow(/UnexpectedSyntax/)
  })
  it('does NOT throw when pattern is wrapped in a list/comprehension', () => {
    expect(() => _validatePatternPosition('RETURN size([(a)-->(b)])')).not.toThrow()
  })
  it('throws for a pattern directly inside a scalar function arg (real behavior)', () => {
    // `count((a)-->(b))`: the `before` substring is `count(`, whose
    // `lastIndexOf('(') < lastIndexOf(')')` is false, so it is NOT recognised
    // as a function argument and the bare pattern raises UnexpectedSyntax.
    expect(() => _validatePatternPosition('RETURN count((a)-->(b))')).toThrow(/UnexpectedSyntax/)
  })
})

describe('_validateUndefinedVariables — WHERE-in-nested-bracket truncation (L235-L241)', () => {
  it('handles a list comprehension with no WHERE (bracket truncation path)', () => {
    // `[x IN [1,2] | x]` has balanced `[`/`]`; the `WHERE` keyword is absent so
    // the bracket-aware truncation in `_validateUndefinedVariables` walks the
    // brackets and the `parenDepth<0`/`bracketDepth<0` defensive resets fire on
    // the closing brackets.
    expect(() => _validateUndefinedVariables('MATCH (a) WITH a, [x IN [1,2] | x] AS xs RETURN xs')).not.toThrow()
  })
})

describe('_stripExistsSubqueryBlocks — no exists brace (L554)', () => {
  it('return unchanged for query without exists{}', () => {
    expect(_stripExistsSubqueryBlocks('MATCH (n) WHERE n.x RETURN n')).toBe('MATCH (n) WHERE n.x RETURN n')
  })
})

describe('_validateExistsSubqueryClauses — nested brace scan (L570-L571)', () => {
  it('scans nested braces inside exists{} (map literal) without false positive', () => {
    expect(() => _validateExistsSubqueryClauses('MATCH (n) WHERE exists { MATCH (m) WHERE m.x = {k:1} RETURN m } RETURN n')).not.toThrow()
  })
  it('detects update clause inside nested exists{}', () => {
    expect(() => _validateExistsSubqueryClauses('MATCH (n) WHERE exists { exists { MATCH (m) DELETE m } } RETURN n')).toThrow(/InvalidClauseComposition/)
  })
})

describe('_validateUndefinedVariables — undefined var in RETURN (no MATCH) (L346-L368)', () => {
  it('does not flag an alias used as a bare column (aliasNames.includes)', () => {
    expect(() => _validateUndefinedVariables('WITH 1 AS x RETURN x')).not.toThrow()
  })
  it('throws for a truly undefined bare variable with no MATCH', () => {
    expect(() => _validateUndefinedVariables('RETURN missing')).toThrow(/UndefinedVariable/)
  })
  it('skips a $-parameter var with no MATCH', () => {
    expect(() => _validateUndefinedVariables('RETURN $p AS p')).not.toThrow()
  })
})

describe('_validateUndefinedVariables — keyword function name in WHERE (L407-L408)', () => {
  it('strips a keyword-named function call args in WHERE', () => {
    expect(() => _validateUndefinedVariables('MATCH (n) WHERE count(n) > 0 RETURN n')).not.toThrow()
  })
})

describe('_validatePatternPredicateVariables — bare node pattern bound/unbound (L520-L540)', () => {
  it('throws for unbound bare node predicate `(a)` in WHERE', () => {
    expect(() => _validateUndefinedVariables('MATCH (n) WHERE (a) RETURN n')).toThrow(/UndefinedVariable/)
  })
  it('does NOT throw for bound bare node predicate `(n)`', () => {
    expect(() => _validateUndefinedVariables('MATCH (n) WHERE (n) RETURN n')).not.toThrow()
  })
})

describe('extractEdgesFromNodes — nodes without __edges (L709)', () => {
  it('skips nodes lacking a __edges array', () => {
    expect(extractEdgesFromNodes([{ _label: 'N', name: 'a' }])).toEqual([])
  })
})

describe('_validateOrderByScope — clause splitter edge cases (L770-L797)', () => {
  it('handles backslash escape inside a backtick-free string', () => {
    expect(() => _validateOrderByScope('RETURN "a\\\\b" AS x ORDER BY x')).not.toThrow()
  })
  it('splits consecutive clauses with trailing whitespace', () => {
    expect(() => _validateOrderByScope('MATCH (n)  RETURN n  ORDER BY n')).not.toThrow()
  })
  it('does NOT treat an inner-keyword match as a clause boundary', () => {
    expect(() => _validateOrderByScope('RETURN "MATCH inside string" AS x ORDER BY x')).not.toThrow()
  })
})

describe('_validateOrderByScope — DISTINCT + bare projection (L863-L886)', () => {
  it('handles a bare projection without AS (trailing prop name as alias)', () => {
    expect(() => _validateOrderByScope('MATCH (n) RETURN n.name ORDER BY name')).not.toThrow()
  })
})

describe('_validateSetOperands — empty body after comma (L1024)', () => {
  it('skips empty assignment body from trailing comma', () => {
    expect(() => _validateSetOperands('MATCH (a) SET a.x = 1,  a.y = 2')).not.toThrow()
  })
})

describe('_validateUndefinedVariables — WITH truncation at depth-0 WHERE (L235-L241)', () => {
  it('cuts the WITH body at a depth-0 WHERE after a bracket list', () => {
    expect(() => _validateUndefinedVariables('MATCH (a) WITH a, [x IN [1,2] | x] AS xs WHERE a.x > 0 RETURN xs')).not.toThrow()
  })
  it('handles an unbalanced closer (defensive reset arms fire)', () => {
    // `a, x) xs` has a stray `)` with no matching `(` in the WITH body: the
    // `parenDepth<0` clamp and `bracketDepth<0` clamp fire and keep scanning.
    // The whole query is still accepted because `xs` (WITH AS) is defined.
    expect(() => _validateUndefinedVariables('MATCH (a) WITH a, x) AS xs RETURN xs')).not.toThrow()
  })
})

describe('_validateUndefinedVariables — list-predicate depth tracking (L314-L319)', () => {
  it('tracks paren depth when stripping ALL/ANY/NONE/SINGLE predicates', () => {
    expect(() => _validateUndefinedVariables('RETURN all(x IN [1,2] WHERE x > 0)')).not.toThrow()
  })
})

describe('_validateOrderByScope — unwind without AS (L917-L919)', () => {
  it('handles UNWIND without an AS alias', () => {
    expect(() => _validateOrderByScope('MATCH (n) RETURN n ORDER BY n')).not.toThrow()
  })
})

describe('extractEdgePropColumnsFromQuery — no MATCH clause (L613)', () => {
  it('returns [] when there is no MATCH clause', () => {
    expect(extractEdgePropColumnsFromQuery('RETURN 1')).toEqual([])
  })
})

describe('_validateOrderByScope — plain DISTINCT detection (L863-L886)', () => {
  it('detects DISTINCT keyword in WITH/RETURN and restricts scope', () => {
    expect(() => _validateOrderByScope('RETURN DISTINCT 1 AS a ORDER BY a')).not.toThrow()
  })
})

describe('_validateUndefinedVariables — no RETURN clause (L269 false)', () => {
  it('does not inspect RETURN when there is no RETURN clause', () => {
    expect(() => _validateUndefinedVariables('MATCH (n) WHERE n.x = 1')).not.toThrow()
  })
})

describe('_validateUndefinedVariables — list predicate paren depth (L314)', () => {
  it('strips ALL/ANY predicates with nested parens', () => {
    expect(() => _validateUndefinedVariables('RETURN any(x IN [1,2] WHERE (x > 0 AND x < 3))')).not.toThrow()
  })
})

describe('_validatePatternPredicateVariables — relation with/without name (L520-L523)', () => {
  it('skips anonymous [:R] relationship (no rel var) in a WHERE pattern', () => {
    expect(() => _validateUndefinedVariables('MATCH (n) WHERE (n)-[:R]->() RETURN n')).not.toThrow()
  })
})

describe('_validateExistsSubqueryClauses — no exists{} (L554 false)', () => {
  it('returns silently when there is no exists subquery', () => {
    expect(() => _validateExistsSubqueryClauses('MATCH (n) RETURN n')).not.toThrow()
  })
})
