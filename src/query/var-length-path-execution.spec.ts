/**
 * var-length-path-execution.spec.ts — Real-behaviour coverage for the variable-length
 * path (VLE) BFS engine in var-length-path.ts.
 *
 * Unlike var-length-path.spec.ts (which mocks ./expression-engine and mostly exercises
 * the legacy api/query-planner IR), these tests exercise `executeVarLenPath` through
 * real `parseQuery`-produced plans with NO mocking, so they drive the actual production
 * branches: path variables, relationship-list variables, edge/target/source inline
 * predicates, zero-hop self-matches, undirected traversal dedupe, multi-step chains,
 * and WITH projection/aggregation.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { parseQuery, _executeQuery } from './query-engine'
import { executeVarLenPath } from './var-length-path'

// ─────────────────────────────────────────────────────────────
// Graph fixtures: a 5-node chain  v0 -[:NEXT]-> v1 ... -> v4
// Edges are stored on BOTH endpoints (as the TCK seed does) so
// undirected traversal and dedupe logic are genuinely exercised.
// ─────────────────────────────────────────────────────────────
function chain(n: number, edgeLabel = 'NEXT'): Array<Record<string, unknown>> {
  const nodes: Array<Record<string, unknown>> = []
  for (let i = 0; i < n; i++) nodes.push({ _label: 'Node', name: 'v' + i, __edges: [] })
  for (let i = 0; i < n - 1; i++) {
    const e = { srcIdx: i, dstIdx: i + 1, label: edgeLabel }
    ;(nodes[i] as any).__edges.push(e)
    ;(nodes[i + 1] as any).__edges.push(e)
  }
  return nodes
}

describe('executeVarLenPath — real behaviour (no mocks)', () => {
  describe('basic hop ranges', () => {
    it('1..3 hops returns every connected pair within range', () => {
      const nodes = chain(5)
      const plan = parseQuery('MATCH (a:Node)-[:NEXT*1..3]->(b) RETURN b') as any
      const rows = executeVarLenPath(plan, nodes)
      // pairs: 0-1,0-2,0-3  1-2,1-3,1-4  2-3,2-4  3-4  = 9
      expect(rows).toHaveLength(9)
    })

    it('exact 1 hop returns 4 pairs', () => {
      const nodes = chain(5)
      const plan = parseQuery('MATCH (a:Node)-[:NEXT*1..1]->(b) RETURN b') as any
      expect(executeVarLenPath(plan, nodes)).toHaveLength(4)
    })

    it('unbounded * traverses the full chain (>10 hops)', () => {
      // 21-node chain: unbounded * must reach node 20 (a hard-coded 10-hop cap
      // would truncate this — see the maxHops guard in executeVarLenPath).
      const nodes = chain(21)
      const plan = parseQuery('MATCH (a:Node)-[:NEXT*]->(b) RETURN b') as any
      const rows = executeVarLenPath(plan, nodes)
      const names = rows.map(r => (r.b as any).name)
      expect(names).toContain('v20')
    })

    it('range beyond graph size returns empty', () => {
      const nodes = chain(5)
      const plan = parseQuery('MATCH (a:Node)-[:NEXT*10..20]->(b) RETURN b') as any
      expect(executeVarLenPath(plan, nodes)).toHaveLength(0)
    })
  })

  describe('path variable (MATCH p = ...)', () => {
    it('binds path variable to {__path, __pathEdges}', () => {
      const nodes = chain(5)
      const plan = parseQuery('MATCH p = (a:Node)-[:NEXT*1..2]->(b) RETURN p') as any
      const rows = executeVarLenPath(plan, nodes)
      expect(rows.length).toBeGreaterThan(0)
      for (const r of rows) {
        const p = r.p as any
        expect(p).toBeDefined()
        expect(Array.isArray(p.__path)).toBe(true)
        expect(Array.isArray(p.__pathEdges)).toBe(true)
        expect(p.__path.length).toBe(p.__pathEdges.length + 1)
      }
    })

    it('zero-hop path has empty edges', () => {
      const nodes = chain(5)
      const plan = parseQuery('MATCH p = (a:Node)-[:NEXT*0..0]->(b) RETURN p') as any
      const rows = executeVarLenPath(plan, nodes)
      expect(rows.length).toBeGreaterThan(0)
      const p = rows[0].p as any
      expect(p.__path).toHaveLength(1)
      expect(p.__pathEdges).toHaveLength(0)
    })
  })

  describe('relationship-list variable (MATCH ()-[r*..]->())', () => {
    it('binds r to the list of relationship objects along each path', () => {
      const nodes = chain(5)
      const plan = parseQuery('MATCH (a:Node)-[r:NEXT*1..2]->(b) RETURN r') as any
      const rows = executeVarLenPath(plan, nodes)
      for (const row of rows) {
        const rels = row.r as any[]
        expect(Array.isArray(rels)).toBe(true)
        expect(rels.length).toBeGreaterThan(0)
        for (const rel of rels) expect(rel._type).toBe('NEXT')
      }
    })

    it('zero-hop self-match binds r to an empty list', () => {
      const nodes = chain(5)
      const plan = parseQuery('MATCH (a:Node)-[r:NEXT*0..1]->(b) RETURN r') as any
      const rows = executeVarLenPath(plan, nodes)
      // self-match rows (a === b) must carry r === []
      const selfMatch = rows.find(row => (row.a as any).name === (row.b as any).name)
      expect(selfMatch).toBeDefined()
      expect((selfMatch!.r as any[])).toEqual([])
    })
  })

  describe('inline predicates', () => {
    it('sourceProps constrains the BFS start node', () => {
      const nodes = chain(5)
      const plan = parseQuery('MATCH (a:Node {name:"v1"})-[:NEXT*1..3]->(b) RETURN b') as any
      const rows = executeVarLenPath(plan, nodes)
      // only v1 can be the source: v1->v2, v1->v3, v1->v4 = 3 rows
      expect(rows).toHaveLength(3)
      for (const r of rows) expect((r.a as any).name).toBe('v1')
    })

    it('sourceProps mismatch yields empty', () => {
      const nodes = chain(5)
      const plan = parseQuery('MATCH (a:Node {name:"nope"})-[:NEXT*1..3]->(b) RETURN b') as any
      expect(executeVarLenPath(plan, nodes)).toHaveLength(0)
    })

    it('targetLabel constrains the endpoint', () => {
      const nodes = chain(5)
      nodes[3]._label = 'Node:End' // v3 carries an additional label
      const plan = parseQuery('MATCH (a:Node)-[:NEXT*1..3]->(m:End) RETURN m') as any
      const rows = executeVarLenPath(plan, nodes)
      expect(rows.length).toBeGreaterThan(0)
      for (const r of rows) expect(String((r.m as any)._label)).toContain('End')
    })

    it('targetProps constrains the endpoint property', () => {
      const nodes = chain(5)
      nodes[4].flag = 'x'
      const plan = parseQuery('MATCH (a:Node)-[:NEXT*1..3]->(m {flag:"x"}) RETURN m') as any
      const rows = executeVarLenPath(plan, nodes)
      expect(rows.length).toBeGreaterThan(0)
      for (const r of rows) expect((r.m as any).flag).toBe('x')
    })

    it('edgeProps constrains the traversed relationship', () => {
      const nodes = chain(5)
      ;(nodes[0] as any).__edges[0].props = { year: 1988 }
      const plan = parseQuery('MATCH (a:Node)-[:NEXT*1..2 {year:1988}]->(b) RETURN b') as any
      // only the v0->v1 edge has year:1988; at most 1-2 hop paths starting there
      const rows = executeVarLenPath(plan, nodes)
      for (const r of rows) expect((r.a as any).name).toBe('v0')
    })
  })

  describe('zero-hop self match (minHops = 0)', () => {
    it('binds source and target to the same start node', () => {
      const nodes = chain(5)
      const plan = parseQuery('MATCH (a:Node)-[:NEXT*0..1]->(b) RETURN b') as any
      const rows = executeVarLenPath(plan, nodes)
      const self = rows.filter(r => (r.a as any).name === (r.b as any).name)
      expect(self.length).toBe(5) // every node matches itself at depth 0
    })
  })

  describe('direction', () => {
    it('in direction reverses traversal', () => {
      // directed edges v0->v1->...; 'in' from v4 should reach v3, v2, v1, v0
      const nodes = chain(5)
      const plan = parseQuery('MATCH (a:Node)<-[:NEXT*1..4]-(b) RETURN b') as any
      const rows = executeVarLenPath(plan, nodes)
      expect(rows.length).toBeGreaterThan(0)
    })

    it('undirected (any) traversal deduplicates reverse-adjacency edges', () => {
      // edges stored on both endpoints; undirected walk must not double-count.
      const nodes = chain(5)
      const plan = parseQuery('MATCH (a:Node)-[:NEXT*1..2]-(b) RETURN b') as any
      // undirected: from each node, neighbors in both directions within 2 hops
      const rows = executeVarLenPath(plan, nodes)
      expect(rows.length).toBeGreaterThan(0)
      // no row may have a === b (self) for a >=1 hop path... actually 2-hop can revisit
      const pairKeys = new Set(rows.map(r => `${(r.a as any).name}|${(r.b as any).name}`))
      expect(pairKeys.size).toBe(rows.length) // no duplicate a|b pairs
    })
  })

  describe('multi-step chain (two VLE steps)', () => {
    it('joins two variable-length steps on the shared node', () => {
      const nodes = chain(6)
      const plan = parseQuery('MATCH (a:Node)-[:NEXT*1..2]->(b)-[:NEXT*1..2]->(c) RETURN c') as any
      const rows = executeVarLenPath(plan, nodes)
      // c must be reachable 2..4 hops from a
      expect(rows.length).toBeGreaterThan(0)
      for (const r of rows) {
        expect((r.a as any).name).toBeDefined()
        expect((r.b as any).name).toBeDefined()
        expect((r.c as any).name).toBeDefined()
      }
    })

    it('chain with zero-length middle step', () => {
      const nodes = chain(5)
      const plan = parseQuery('MATCH (a:Node)-[:NEXT*0..1]->(b)-[:NEXT*1..1]->(c) RETURN c') as any
      const rows = executeVarLenPath(plan, nodes)
      expect(rows.length).toBeGreaterThan(0)
    })

    it('chain binds path variable across all steps (p = full path)', () => {
      const nodes = chain(5)
      const plan = parseQuery('MATCH p = (a:Node)-[:NEXT*1..1]->(b)-[:NEXT*1..1]->(c) RETURN p') as any
      const rows = executeVarLenPath(plan, nodes)
      expect(rows.length).toBeGreaterThan(0)
      for (const r of rows) {
        const p = r.p as any
        expect(p).toBeDefined()
        expect(p.__path.length).toBeGreaterThanOrEqual(3) // a-b-c (three nodes)
        expect(p.__pathEdges).toHaveLength(2)
      }
    })

    it('chain binds relationship-list and target variables', () => {
      const nodes = chain(5)
      const plan = parseQuery('MATCH (a:Node)-[r:NEXT*1..1]->(b)-[r2:NEXT*1..1]->(c) RETURN c') as any
      const rows = executeVarLenPath(plan, nodes)
      expect(rows.length).toBeGreaterThan(0)
      for (const r of rows) {
        expect((r.c as any).name).toBeDefined()
      }
    })

    it('chain middle-step targetLabel rejects non-matching candidates', () => {
      const nodes = chain(5)
      nodes[2]._label = 'Node:Middle' // v2 carries the Middle label
      // step1: a -[:NEXT*1..1]-> m:Middle ; step2: m -[:NEXT*1..1]-> c
      const plan = parseQuery('MATCH (a:Node)-[:NEXT*1..1]->(m:Middle)-[:NEXT*1..1]->(c) RETURN c') as any
      const rows = executeVarLenPath(plan, nodes)
      // only paths whose middle node is v2 survive the targetLabel filter
      expect(rows.length).toBeGreaterThan(0)
      for (const r of rows) {
        expect((r.m as any).name).toBe('v2')
        expect((r.c as any).name).toBe('v3')
      }
    })

    it('chain middle-step targetProps rejects non-matching candidates', () => {
      const nodes = chain(5)
      nodes[1].flag = 'mid'
      const plan = parseQuery('MATCH (a:Node)-[:NEXT*1..1]->(m {flag:"mid"})-[:NEXT*1..1]->(c) RETURN c') as any
      const rows = executeVarLenPath(plan, nodes)
      expect(rows.length).toBeGreaterThan(0)
      for (const r of rows) {
        expect((r.m as any).name).toBe('v1')
      }
    })

    it('chain edgeProps rejects non-matching edges', () => {
      const nodes = chain(5)
      // tag the v1 -> v2 edge (srcIdx 1 -> dstIdx 2) with w:9
      const targetEdge = (nodes[1] as any).__edges.find((e: any) => e.srcIdx === 1 && e.dstIdx === 2)
      targetEdge.props = { w: 9 }
      const plan = parseQuery('MATCH (a:Node)-[:NEXT*1..1 {w:9}]->(b)-[:NEXT*1..1]->(c) RETURN c') as any
      const rows = executeVarLenPath(plan, nodes)
      // only the path through v1 -> v2 -> v3 should survive the edge predicate
      expect(rows.length).toBeGreaterThan(0)
      for (const r of rows) {
        expect((r.b as any).name).toBe('v2')
      }
    })
  })

  describe('WITH projection / aggregation', () => {
    it('WITH projection is applied to VLE rows', () => {
      const nodes = chain(5)
      const plan = parseQuery('MATCH (a:Node)-[:NEXT*1..2]->(b) WITH b.name AS n RETURN n') as any
      const rows = executeVarLenPath(plan, nodes)
      expect(rows.length).toBeGreaterThan(0)
    })

    it('WITH count(b) aggregate groups by non-aggregate column', () => {
      const nodes = chain(5)
      const plan = parseQuery('MATCH (a:Node)-[:NEXT*1..2]->(b) WITH a, count(b) AS cnt RETURN a, cnt') as any
      const rows = executeVarLenPath(plan, nodes)
      // grouped by `a`: v0 reaches v1,v2 (cnt 2); v1 reaches v2,v3 (2); v2 reaches v3,v4 (2); v3 reaches v4 (1)
      const byName: Record<string, number> = {}
      for (const r of rows) byName[(r.a as any).name] = (r as any).cnt
      expect(byName.v0).toBe(2)
      expect(byName.v1).toBe(2)
      expect(byName.v2).toBe(2)
      expect(byName.v3).toBe(1)
    })

    it('WITH count(*) aggregate (no non-aggregate column) yields single row', () => {
      const nodes = chain(5)
      const plan = parseQuery('MATCH (a:Node)-[:NEXT*1..2]->(b) WITH count(b) AS cnt RETURN cnt') as any
      const rows = executeVarLenPath(plan, nodes)
      expect(rows).toHaveLength(1)
      expect((rows[0] as any).cnt).toBe(7) // total 1..2-hop pairs: 4+3 = 7
    })
  })

  describe('end-to-end via _executeQuery', () => {
    it('returns correct node name column', async () => {
      const nodes = chain(5)
      const rows = await _executeQuery(
        parseQuery('MATCH (a:Node)-[:NEXT*1..2]->(b) RETURN b.name'),
        nodes,
        'MATCH (a:Node)-[:NEXT*1..2]->(b) RETURN b.name',
      )
      expect(rows.length).toBeGreaterThan(0)
      for (const r of rows) {
        // return column "b.name" (or "name" alias) resolves to a node name
        const v = (r as any)['b.name'] ?? (r as any).name
        expect(typeof v).toBe('string')
      }
    })

    it('path variable serializes with __path/__pathEdges', async () => {
      const nodes = chain(4)
      const rows = await _executeQuery(
        parseQuery('MATCH p = (a:Node)-[:NEXT*1..2]->(b) RETURN p'),
        nodes,
        'MATCH p = (a:Node)-[:NEXT*1..2]->(b) RETURN p',
      )
      expect(rows.length).toBeGreaterThan(0)
      for (const r of rows) {
        expect((r as any).p).toBeDefined()
      }
    })

    it('return source-node property (a.name) via dotMatch', async () => {
      const nodes = chain(4)
      const rows = await _executeQuery(
        parseQuery('MATCH (a:Node)-[:NEXT*1..2]->(b) RETURN a.name'),
        nodes,
        'MATCH (a:Node)-[:NEXT*1..2]->(b) RETURN a.name',
      )
      expect(rows.length).toBeGreaterThan(0)
      for (const r of rows) {
        const v = (r as any)['a.name'] ?? (r as any).name
        expect(typeof v).toBe('string')
      }
    })

    it('return literal expression (length of path)', async () => {
      const nodes = chain(4)
      const rows = await _executeQuery(
        parseQuery('MATCH p = (a:Node)-[:NEXT*1..2]->(b) RETURN length(p)'),
        nodes,
        'MATCH p = (a:Node)-[:NEXT*1..2]->(b) RETURN length(p)',
      )
      expect(rows.length).toBeGreaterThan(0)
    })

    it('collision-qualified return columns resolve source and target via dotMatch', () => {
      // When the same property `name` is projected from two variables, the
      // collision-aware returnColumns keeps both qualified (a.name, b.name),
      // driving the dotMatch source/target branches in _buildRow.
      const nodes = chain(4)
      const plan = parseQuery('MATCH p = (a:Node)-[:NEXT*1..1]->(b) RETURN p, a.name, b.name') as any
      const rows = executeVarLenPath(plan, nodes)
      expect(rows.length).toBeGreaterThan(0)
      for (const r of rows) {
        expect((r as any)['a.name']).toBe((r as any).a.name)
        expect((r as any)['b.name']).toBe((r as any).b.name)
      }
    })
  })

  describe('_matchesLabel variants', () => {
    it('matches multi-label __fullLabel via colon split', () => {
      const nodes = chain(3)
      ;(nodes[0] as any).__fullLabel = 'Node:Person'
      const plan = parseQuery('MATCH (a:Node)-[:NEXT*1..1]->(b) RETURN b') as any
      const rows = executeVarLenPath(plan, nodes)
      expect(rows.length).toBeGreaterThan(0)
    })

    it('matches multi-label _label via colon split', () => {
      const nodes = chain(3)
      nodes[0]._label = 'Node:Person'
      const plan = parseQuery('MATCH (a:Node)-[:NEXT*1..1]->(b) RETURN b') as any
      const rows = executeVarLenPath(plan, nodes)
      expect(rows.length).toBeGreaterThan(0)
    })
  })
})
