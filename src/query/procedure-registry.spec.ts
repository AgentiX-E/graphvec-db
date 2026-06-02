/**
 * procedure-registry.spec.ts — Tests for APOC-style procedure registry
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ProcedureRegistry, type ProcedureContext, type ProcedureArg } from './procedure-registry'

// ── Mock GraphEngine ──────────────────────────────────────

function createMockGraph() {
  const nodes = new Map<string, Record<string, unknown>>()
  const outEdges = new Map<string, Array<{ target: string; source: string; type: string }>>()
  const inEdges = new Map<string, Array<{ target: string; source: string; type: string }>>()

  const graph = {
    getAllNodes: () => Array.from(nodes.values()),
    getOutEdges: (id: string) => outEdges.get(id) ?? [],
    getInEdges: (id: string) => inEdges.get(id) ?? [],
  }

  function addNode(id: string, props: Record<string, unknown> = {}): void {
    nodes.set(id, { id, ...props })
  }

  function addEdge(source: string, target: string, type = 'RELATED'): void {
    const edge = { source, target, type }
    if (!outEdges.has(source)) outEdges.set(source, [])
    outEdges.get(source)!.push(edge)
    if (!inEdges.has(target)) inEdges.set(target, [])
    inEdges.get(target)!.push(edge)
  }

  return { graph, addNode, addEdge }
}

// ── Tests ─────────────────────────────────────────────────

describe('ProcedureRegistry', () => {
  let registry: ProcedureRegistry

  beforeEach(() => {
    registry = new ProcedureRegistry()
  })

  describe('register / has / list', () => {
    it('registers and checks a procedure', () => {
      registry.registerProcedure('test.echo', (args) => ({ result: args }))
      expect(registry.hasProcedure('test.echo')).toBe(true)
      expect(registry.hasProcedure('nonexistent')).toBe(false)
    })

    it('lists all registered procedures', () => {
      const list = registry.listProcedures()
      expect(list).toBeInstanceOf(Array)
      // Built-in procedures
      const names = list.map(p => p.name)
      expect(names).toContain('algo.pageRank')
      expect(names).toContain('algo.shortestPath')
      expect(names).toContain('algo.connectedComponents')
      expect(names).toContain('algo.kCore')
    })

    it('throws on duplicate registration', () => {
      registry.registerProcedure('test.dup', () => [])
      expect(() => registry.registerProcedure('test.dup', () => []))
        .toThrow('already registered')
    })

    it('throws on unknown procedure call', async () => {
      const ctx: ProcedureContext = { graph: {} as any }
      await expect(registry.callProcedure('nonexistent', [], ctx))
        .rejects.toThrow('Unknown procedure')
    })
  })

  describe('callProcedure', () => {
    it('calls a custom procedure and returns result', async () => {
      registry.registerProcedure('custom.fn', (args) => {
        return { args, length: args.length }
      })

      const ctx: ProcedureContext = { graph: {} as any }
      const result = await registry.callProcedure('custom.fn', ['hello', 42], ctx)
      expect(result).toEqual({ args: ['hello', 42], length: 2 })
    })

    it('supports async procedures', async () => {
      registry.registerProcedure('custom.async', async (args) => {
        return { processed: true, count: args.length }
      })

      const ctx: ProcedureContext = { graph: {} as any }
      const result = await registry.callProcedure('custom.async', [1, 2, 3], ctx)
      expect(result).toEqual({ processed: true, count: 3 })
    })

    it('calling an unregistered procedure throws', async () => {
      const ctx: ProcedureContext = { graph: {} as any }
      await expect(registry.callProcedure('unknown.proc', [], ctx))
        .rejects.toThrow('Unknown')
    })
  })

  describe('built-in procedures - algo.pageRank', () => {
    it('returns empty for empty graph', async () => {
      const { graph } = createMockGraph()
      const result = await registry.callProcedure('algo.pageRank', [], { graph } as any)
      expect(result).toEqual([])
    })

    it('computes PageRank scores for a simple graph', async () => {
      const { graph, addNode, addEdge } = createMockGraph()
      addNode('A')
      addNode('B')
      addNode('C')
      addEdge('A', 'B')
      addEdge('A', 'C')
      addEdge('B', 'C')

      const result = await registry.callProcedure('algo.pageRank', [100], { graph } as any) as Array<{ node: string; score: number }>
      expect(result).toHaveLength(3)
      expect(result.map(r => r.node).sort()).toEqual(['A', 'B', 'C'])
      // A (source) should have lower score than C (sink)
      const scoreA = result.find(r => r.node === 'A')!.score
      const scoreC = result.find(r => r.node === 'C')!.score
      expect(scoreA).toBeGreaterThan(0)
      expect(scoreC).toBeGreaterThan(scoreA)
    })
  })

  describe('built-in procedures - algo.shortestPath', () => {
    it('returns path between two connected nodes', async () => {
      const { graph, addNode, addEdge } = createMockGraph()
      addNode('A')
      addNode('B')
      addNode('C')
      addEdge('A', 'B')
      addEdge('B', 'C')

      const result = await registry.callProcedure(
        'algo.shortestPath',
        ['A', 'C'],
        { graph } as any,
      ) as Array<{ node: string; edge: Record<string, unknown> | null }>

      expect(result.length).toBeGreaterThanOrEqual(2)
      expect(result[0].node).toBe('A')
      expect(result[result.length - 1].node).toBe('C')
    })

    it('returns empty array when no path exists', async () => {
      const { graph, addNode } = createMockGraph()
      addNode('A')
      addNode('B')

      const result = await registry.callProcedure(
        'algo.shortestPath',
        ['A', 'B'],
        { graph } as any,
      )
      expect(result).toEqual([])
    })

    it('throws when start/end node are missing', async () => {
      const { graph } = createMockGraph()
      await expect(registry.callProcedure(
        'algo.shortestPath',
        ['', 'B'],
        { graph } as any,
      )).rejects.toThrow('requires startNode')
    })
  })

  describe('built-in procedures - algo.connectedComponents', () => {
    it('finds connected components', async () => {
      const { graph, addNode, addEdge } = createMockGraph()
      addNode('A')
      addNode('B')
      addNode('C')
      addNode('D')
      addEdge('A', 'B') // component 0
      addEdge('C', 'D') // component 1

      const result = await registry.callProcedure(
        'algo.connectedComponents',
        [],
        { graph } as any,
      ) as Array<{ component: number; nodes: string[]; size: number }>

      expect(result).toHaveLength(2)
      expect(result[0].size).toBe(2)
      expect(result[1].size).toBe(2)
    })

    it('returns empty for empty graph', async () => {
      const { graph } = createMockGraph()
      const result = await registry.callProcedure(
        'algo.connectedComponents',
        [],
        { graph } as any,
      )
      expect(result).toEqual([])
    })
  })

  describe('built-in procedures - algo.kCore', () => {
    it('finds k-core in a graph', async () => {
      const { graph, addNode, addEdge } = createMockGraph()
      addNode('A')
      addNode('B')
      addNode('C')
      addNode('D')
      addEdge('A', 'B')
      addEdge('B', 'C')
      addEdge('C', 'A') // triangle A-B-C
      addEdge('D', 'A') // D connected to A only

      const result = await registry.callProcedure(
        'algo.kCore',
        [2],
        { graph } as any,
      ) as Array<{ k: number; coreSize: number; coreNodes: string[] }>

      expect(result).toHaveLength(1)
      expect(result[0].k).toBe(2)
      expect(result[0].coreSize).toBe(3) // A, B, C are in 2-core
    })

    it('returns nodes for default k=2', async () => {
      const { graph, addNode, addEdge } = createMockGraph()
      addNode('A')
      addNode('B')
      addNode('C')
      addEdge('A', 'B')
      addEdge('B', 'C')
      addEdge('C', 'A')

      const result = await registry.callProcedure(
        'algo.kCore',
        [],
        { graph } as any,
      ) as Array<{ k: number; coreSize: number }>

      expect(result[0].k).toBe(2)
      expect(result[0].coreSize).toBe(3)
    })
  })

  describe('invoke shorthand', () => {
    it('invoke with context', async () => {
      const { graph } = createMockGraph()
      const result = await registry.invoke('algo.pageRank', [], { graph } as any)
      expect(result).toEqual([])
    })

    it('invoke without context works for registered procs', async () => {
      // This calls pageRank with empty args and empty graph - should return empty
      const result = await registry.invoke('algo.pageRank', [])
      expect(result).toEqual([])
    })

    it('invoke throws for unknown procedure', async () => {
      await expect(registry.invoke('unknown.proc', []))
        .rejects.toThrow('Unknown')
    })
  })
})
