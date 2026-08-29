/**
 * pattern-predicate-validate.spec.ts — compile-time validation for pattern
 * predicates and illegal pattern positions.
 *
 * Covers the openCypher semantic errors that must be raised at compile time:
 *   - UndefinedVariable  — a pattern predicate introduces an unbound node or
 *                          relationship variable.
 *   - InvalidArgumentType — a bare node pattern `WHERE (n)` (no relationship).
 *   - UnexpectedSyntax  — a bare pattern used as a value in RETURN/WITH/SET.
 *
 * Each case asserts the exact `tckError` discriminator so the TCK step
 * definitions can map the thrown error to the expected category.
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

describe('Pattern predicate — UndefinedVariable (compile time)', () => {
  const unboundNodeCases = [
    'MATCH (n) WHERE (a) RETURN n',
    'MATCH (n) WHERE (n)-[r]->(a) RETURN n',
    'MATCH (n) WHERE (a)-[r]->(n) RETURN n',
    'MATCH (n) WHERE (n)<-[r {}]-(a) RETURN n',
    'MATCH (n) WHERE (n)-[r {}]-(a) RETURN n',
    'MATCH (n) WHERE (n)-[r:REL]->(a {num: 5}) RETURN n',
    'MATCH (n) WHERE (n)-[r:REL*0..2]->(a {num: 5}) RETURN n',
    'MATCH (n) WHERE (n)-[r:REL]->(:C)<-[s:REL]-(a {num: 5}) RETURN n',
  ]
  for (const q of unboundNodeCases) {
    it(`raises for unbound endpoint: ${q}`, () => {
      expect(validateErr(q)).toBe('UndefinedVariable')
    })
  }

  const unboundRelCases = [
    'MATCH (n) WHERE (n)-[r]->() RETURN n',
    'MATCH (n) WHERE ()-[r]->(n) RETURN n',
    'MATCH (n) WHERE (n)<-[r]-() RETURN n',
    'MATCH (n) WHERE (n)-[r]-() RETURN n',
    'MATCH (n) WHERE ()-[r]->() RETURN n',
    'MATCH (n) WHERE ()<-[r]-() RETURN n',
    'MATCH (n) WHERE ()-[r]-() RETURN n',
  ]
  for (const q of unboundRelCases) {
    it(`raises for unbound relationship var: ${q}`, () => {
      expect(validateErr(q)).toBe('UndefinedVariable')
    })
  }

  it('does NOT raise when all pattern vars are bound or anonymous', () => {
    expect(validateErr('MATCH (n) WHERE (n)-[]->() RETURN n')).toBeNull()
    expect(validateErr('MATCH (n), (m) WHERE (n)-[]->(m) RETURN n, m')).toBeNull()
    expect(validateErr('MATCH (n), (m) WHERE (n)-[:REL]->(m) RETURN n, m')).toBeNull()
  })
})

describe('Pattern predicate — InvalidArgumentType (self pattern)', () => {
  it('raises for a bare node pattern in WHERE', () => {
    expect(validateErr('MATCH (n) WHERE (n) RETURN n')).toBe('InvalidArgumentType')
  })
})

describe('Pattern in illegal position — UnexpectedSyntax', () => {
  it('raises for a pattern in RETURN projection', () => {
    expect(validateErr('MATCH (n) RETURN (n)-[]->()')).toBe('UnexpectedSyntax')
  })
  it('raises for a pattern in WITH projection', () => {
    expect(validateErr('MATCH (n) WITH (n)-[]->() AS p RETURN p')).toBe('UnexpectedSyntax')
  })
  it('raises for a pattern on the right-hand side of SET', () => {
    expect(validateErr('MATCH (n) SET n.x = (n)-[]->()')).toBe('UnexpectedSyntax')
  })
})
