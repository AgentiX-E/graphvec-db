/**
 * query-executor-exists.spec.ts — end-to-end tests for EXISTS subqueries and
 * pattern-predicate evaluation in `query-executor.ts`.
 *
 * These drive the internal evaluators (`_evalChainExists`,
 * `_evalPatternPredicate`, `_evalExistsSubquery`, `_evalExistsAggregate`,
 * `_evalExistsPatternWhere`) through the public `_executeQuery` entry point,
 * covering chain direction, anonymous vs. named endpoints, union edge types,
 * labels, variable-length edges, and the aggregate/WHERE/full subquery forms.
 *
 * Regression coverage for four bugs found while closing this code:
 *   1. Anonymous interior nodes in a chain were dropped (forced to index -1),
 *      wrongly rejecting `(n)-[]->()-[]->()`.
 *   2. Pipe-separated union edge types (`KNOWS|LIKES`) were compared as a whole
 *      string in `_evalChainExists`, never matching.
 *   3. A named target in a single-edge EXISTS (`EXISTS { (n)-->(m) }`) was
 *      treated as a required outer binding instead of an existential.
 *   4. `EXISTS { MATCH ... RETURN true }` (full form) yielded false positives
 *      for the same existential-named-variable reason.
 */
import { describe, it, expect } from 'vitest'
import { parseQuery, _executeQuery } from './query-engine'

// a -KNOWS-> b -KNOWS-> c ; a -LIKES-> d
function knowsChainGraph() {
  return [
    { _id: 'a', _label: 'Person', name: 'Alice', age: 30, _alias: 'a', __edges: [
      { srcIdx: 0, dstIdx: 1, label: 'KNOWS' },
      { srcIdx: 0, dstIdx: 3, label: 'LIKES' },
    ] },
    { _id: 'b', _label: 'Person', name: 'Bob', age: 25, _alias: 'b', __edges: [
      { srcIdx: 1, dstIdx: 2, label: 'KNOWS' },
      { srcIdx: 1, dstIdx: 2, label: 'LIKES' },
      { srcIdx: 1, dstIdx: 1, label: 'SELF' },
    ] },
    { _id: 'c', _label: 'Employee', name: 'Charlie', age: 40, _alias: 'c', __edges: [] },
    { _id: 'd', _label: 'Person', name: 'Diana', age: 28, _alias: 'd', __edges: [] },
  ]
}

async function execNames(query: string, nodes: any[] = knowsChainGraph()): Promise<string[]> {
  const rows = await _executeQuery(parseQuery(query), nodes, query) as any[]
  return rows.map((r) => r.name).sort()
}

describe('EXISTS — chained patterns (_evalChainExists)', () => {
  it('matches a 2-hop out chain with an anonymous interior and tail', async () => {
    expect(await execNames('MATCH (n:Person) WHERE EXISTS { (n)-[:KNOWS]->()-[:KNOWS]->() } RETURN n.name'))
      .toEqual(['Alice'])
  })

  it('matches a 2-hop chain with all endpoints named', async () => {
    expect(await execNames('MATCH (n:Person) WHERE EXISTS { (n)-[:KNOWS]->(m)-[:KNOWS]->(x) } RETURN n.name'))
      .toEqual(['Alice'])
  })

  it('matches a reversed (incoming) chain', async () => {
    // a -KNOWS-> b -KNOWS-> c, so c has a 2-hop incoming chain c<-b<-a.
    const nodes = [
      { _id: 'a', _label: 'Person', name: 'Alice', _alias: 'a', __edges: [{ srcIdx: 0, dstIdx: 1, label: 'KNOWS' }] },
      { _id: 'b', _label: 'Person', name: 'Bob', _alias: 'b', __edges: [{ srcIdx: 1, dstIdx: 2, label: 'KNOWS' }] },
      { _id: 'c', _label: 'Person', name: 'Charlie', _alias: 'c', __edges: [] },
    ]
    expect(await execNames('MATCH (n:Person) WHERE EXISTS { (n)<-[:KNOWS]-()<-[:KNOWS]-() } RETURN n.name', nodes))
      .toEqual(['Charlie'])
  })

  it('matches an undirected chain in either direction', async () => {
    expect(await execNames('MATCH (n:Person) WHERE EXISTS { (n)-[:KNOWS]-()-[:KNOWS]-() } RETURN n.name'))
      .toEqual(['Alice', 'Bob'])
  })

  it('matches a pipe-separated union edge type (regression #2)', async () => {
    // Alice -KNOWS-> Bob -KNOWS-> Charlie, and Alice -LIKES-> Diana; the union
    // must match per-type, so Alice reaches a 2-hop chain via KNOWS.
    expect(await execNames('MATCH (n:Person) WHERE EXISTS { (n)-[:KNOWS|LIKES]->()-[:KNOWS|LIKES]->() } RETURN n.name'))
      .toEqual(['Alice'])
  })

  it('returns nothing when no chain matches the edge type', async () => {
    expect(await execNames('MATCH (n:Person) WHERE EXISTS { (n)-[:LIKES]->()-[:LIKES]->() } RETURN n.name'))
      .toEqual([])
  })

  it('enforces the target label inside a chain', async () => {
    expect(await execNames('MATCH (n:Person) WHERE EXISTS { (n)-[:KNOWS]->()-[:KNOWS]->(x:Employee) } RETURN n.name'))
      .toEqual(['Alice'])
  })

  it('rejects a 3-hop chain when only a 2-hop path exists', async () => {
    expect(await execNames('MATCH (n:Person) WHERE EXISTS { (n)-[:KNOWS]->()-[:KNOWS]->()-[:KNOWS]->() } RETURN n.name'))
      .toEqual([])
  })
})

describe('EXISTS — single-edge patterns (_evalPatternPredicate allowUnbound)', () => {
  it('matches a named existential target (regression #3)', async () => {
    expect(await execNames('MATCH (n:Person) WHERE EXISTS { (n)-[:KNOWS]->(m) } RETURN n.name'))
      .toEqual(['Alice', 'Bob'])
  })

  it('matches a named existential target with a label', async () => {
    expect(await execNames('MATCH (n:Person) WHERE EXISTS { (n)-[:KNOWS]->(m:Employee) } RETURN n.name'))
      .toEqual(['Bob'])
  })

  it('matches an anonymous target with a label', async () => {
    expect(await execNames('MATCH (n:Person) WHERE EXISTS { (n)-[:KNOWS]->(:Employee) } RETURN n.name'))
      .toEqual(['Bob'])
  })

  it('matches an anonymous target without a label', async () => {
    expect(await execNames('MATCH (n:Person) WHERE EXISTS { (n)-[:KNOWS]->() } RETURN n.name'))
      .toEqual(['Alice', 'Bob'])
  })

  it('matches a reversed single edge (incoming edge exists)', async () => {
    // Bob is a Person with an incoming KNOWS (a->b); Charlie is an Employee
    // (not scanned) and Diana has no incoming KNOWS.
    expect(await execNames('MATCH (n:Person) WHERE EXISTS { (n)<-[:KNOWS]-(m) } RETURN n.name'))
      .toEqual(['Bob'])
  })

  it('returns nothing for a missing edge type', async () => {
    expect(await execNames('MATCH (n:Person) WHERE EXISTS { (n)-[:NA]->() } RETURN n.name'))
      .toEqual([])
  })
})

describe('EXISTS — subquery forms', () => {
  it('full form: MATCH ... RETURN true (regression #4)', async () => {
    expect(await execNames('MATCH (n:Person) WHERE EXISTS { MATCH (n)-[:KNOWS]->(m) RETURN true } RETURN n.name'))
      .toEqual(['Alice', 'Bob'])
  })

  it('full form returns nothing for a missing pattern', async () => {
    expect(await execNames('MATCH (n:Person) WHERE EXISTS { MATCH (n)-[:NA]->(m) RETURN true } RETURN n.name'))
      .toEqual([])
  })

  it('pattern + WHERE form enumerates inner bindings', async () => {
    expect(await execNames('MATCH (n:Person) WHERE EXISTS { (n)-[:KNOWS]->(m) WHERE m.age > 20 } RETURN n.name'))
      .toEqual(['Alice', 'Bob'])
  })

  it('pattern + WHERE with an unsatisfiable condition', async () => {
    expect(await execNames('MATCH (n:Person) WHERE EXISTS { (n)-[:KNOWS]->(m) WHERE m.age > 100 } RETURN n.name'))
      .toEqual([])
  })

  it('aggregate form: WITH count(m) filtered by c', async () => {
    expect(await execNames('MATCH (n:Person) WHERE EXISTS { MATCH (n)-[:KNOWS]->(m) WITH count(m) AS c WHERE c = 1 } RETURN n.name'))
      .toEqual(['Alice', 'Bob'])
  })

  it('aggregate form: count = 0 selects nodes with no outgoing edge', async () => {
    const nodes = [
      { _id: 'a', _label: 'Person', name: 'Alice', _alias: 'a', __edges: [{ srcIdx: 0, dstIdx: 1, label: 'KNOWS' }] },
      { _id: 'b', _label: 'Person', name: 'Bob', _alias: 'b', __edges: [] },
    ]
    expect(await execNames('MATCH (n:Person) WHERE EXISTS { MATCH (n)-[:KNOWS]->() WITH count(*) AS c WHERE c = 0 } RETURN n.name', nodes))
      .toEqual(['Bob'])
  })
})

describe('Pattern predicates (WHERE without EXISTS)', () => {
  it('single-edge predicate with an anonymous target', async () => {
    expect(await execNames('MATCH (n:Person) WHERE (n)-[:KNOWS]->() RETURN n.name'))
      .toEqual(['Alice', 'Bob'])
  })

  it('single-edge predicate with an anonymous labeled target', async () => {
    expect(await execNames('MATCH (n:Person) WHERE (n)-[:KNOWS]->(:Employee) RETURN n.name'))
      .toEqual(['Bob'])
  })

  it('variable-length pattern predicate honours hop bounds', async () => {
    expect(await execNames('MATCH (n:Person) WHERE (n)-[:KNOWS*1..2]->() RETURN n.name'))
      .toEqual(['Alice', 'Bob'])
  })

  it('variable-length predicate with a too-short minimum', async () => {
    expect(await execNames('MATCH (n:Person) WHERE (n)-[:KNOWS*2]->() RETURN n.name'))
      .toEqual(['Alice'])
  })
})
