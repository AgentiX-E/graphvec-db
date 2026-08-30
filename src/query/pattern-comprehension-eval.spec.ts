/**
 * pattern-comprehension-eval.spec.ts — Execution-level tests for pattern
 * comprehension evaluation in the query engine.
 *
 * Covers the end-to-end scenarios that the compile/validate stage cannot reach:
 *   - [7] nested list comprehension wrapping a pattern comprehension (`size([(x)-->(:Y) | 1])`)
 *   - [8] pattern comprehension mixed with `count` in a WITH clause (implicit grouping)
 *   - [9] variable-length pattern comprehension (`[*]`) in a WITH clause
 *   - regression: path-variable source binding must not inflate row count
 *
 * Node objects follow the graph-engine storage shape: `_label` identifies the
 * label and `__edges` carries `{ srcIdx, dstIdx, label, props }` incidence rows.
 */

import { describe, it, expect } from 'vitest'
import { parseQuery, _executeQuery } from './query-engine'
import { _clearGeInstances } from './query-engine'

interface Edge {
  srcIdx: number
  dstIdx: number
  label?: string
  props?: Record<string, unknown> | null
}

function node(label: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return { _label: label, __edges: [] as Edge[], ...(extra || {}) }
}

/** Wire a single directed edge from `from` to `to` inside the shared node list. */
function edge(nodes: Record<string, unknown>[], from: number, to: number, label = 'T'): void {
  const e: Edge = { srcIdx: from, dstIdx: to, label, props: null }
  ;(nodes[from].__edges as Edge[]).push(e)
}

async function run(query: string, nodes: Record<string, unknown>[]): Promise<any[]> {
  _clearGeInstances()
  const plan = parseQuery(query)
  return (await _executeQuery(plan, nodes, query)) as any[]
}

describe('pattern comprehension — execution (end-to-end)', () => {
  describe('[7] pattern comprehension inside a list comprehension', () => {
    it('computes size([(x)-->(:Y) | 1]) per node of the path', async () => {
      // n1:X -> m1:Y ; m1:Y -> i1:Y, i2:Y
      // n2:X -> m2   ; m2   -> i3:L, i4:Y
      const nodes = [
        node('X', { n: 1 }),
        node('Y'),
        node('Y'),
        node('Y'),
        node('X', { n: 2 }),
        node('Default'),
        node('L'),
        node('Y'),
      ]
      edge(nodes, 0, 1) // n1 -> m1
      edge(nodes, 1, 2) // m1 -> i1
      edge(nodes, 1, 3) // m1 -> i2
      edge(nodes, 4, 5) // n2 -> m2
      edge(nodes, 5, 6) // m2 -> i3 (:L)
      edge(nodes, 5, 7) // m2 -> i4 (:Y)

      const result = await run(
        'MATCH p = (n:X)-->() RETURN n, [x IN nodes(p) | size([(x)-->(:Y) | 1])] AS list ORDER BY n.n',
        nodes,
      )
      expect(result.length).toBe(2)
      expect(result[0].list).toEqual([1, 2])
      expect(result[1].list).toEqual([0, 1])
    })
  })

  describe('[8] pattern comprehension in WITH with count (implicit grouping)', () => {
    it('groups by n and counts b per group', async () => {
      // (a:A) -> (b:B) ; (b:B) -> (:C)
      const nodes = [node('A'), node('B'), node('C')]
      edge(nodes, 0, 1)
      edge(nodes, 1, 2)

      const result = await run(
        'MATCH (n)-->(b) WITH [p = (n)-->() | p] AS ps, count(b) AS c RETURN ps, c ORDER BY c',
        nodes,
      )
      expect(result.length).toBe(2)
      // Both rows report one outgoing neighbour.
      for (const row of result) {
        expect(row.c).toBe(1)
        expect(Array.isArray(row.ps)).toBe(true)
        expect(row.ps.length).toBe(1)
      }
    })
  })

  describe('[9] variable-length pattern comprehension in WITH', () => {
    it('resolves the A -> B path instead of [null]', async () => {
      // (:A) -> (:B)
      const nodes = [node('A'), node('B')]
      edge(nodes, 0, 1)

      const result = await run(
        'MATCH (a:A), (b:B) WITH [p = (a)-[*]->(b) | p] AS paths, count(a) AS c RETURN paths, c',
        nodes,
      )
      expect(result.length).toBe(1)
      expect(result[0].c).toBe(1)
      const paths = result[0].paths as any[]
      expect(Array.isArray(paths)).toBe(true)
      expect(paths.length).toBe(1)
      // The path object binds source A and target B.
      const p = paths[0] as any
      expect(Array.isArray(p.__path)).toBe(true)
      expect(p.__path.length).toBe(2)
      expect((p.__path[0] as any)._label).toBe('A')
      expect((p.__path[1] as any)._label).toBe('B')
    })
  })

  describe('regression: path-variable source binding', () => {
    it('does not expand rows across undirected neighbours', async () => {
      // Two :X sources, each with one outgoing step; the query binds a path
      // variable and returns the source. Row count must stay at 2.
      const nodes = [
        node('X', { n: 1 }),
        node('Y'),
        node('Y'),
        node('Y'),
        node('X', { n: 2 }),
        node('Default'),
        node('L'),
        node('Y'),
      ]
      edge(nodes, 0, 1)
      edge(nodes, 1, 2)
      edge(nodes, 1, 3)
      edge(nodes, 4, 5)
      edge(nodes, 5, 6)
      edge(nodes, 5, 7)

      const result = await run(
        'MATCH p = (n:X)-->() RETURN n ORDER BY n.n',
        nodes,
      )
      expect(result.length).toBe(2)
    })
  })
})
