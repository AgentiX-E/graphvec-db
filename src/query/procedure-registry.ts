/**
 * procedure-registry.ts — APOC-style CALL procedure registration system
 *
 * Allows registering named procedures (e.g. algo.pageRank, algo.shortestPath)
 * and invoking them by name with typed arguments.
 *
 * Built-in procedures:
 *   - algo.pageRank(graph, iterations?, dampingFactor?)
 *   - algo.shortestPath(graph, startNode, endNode, relationshipType?)
 *   - algo.connectedComponents(graph)
 *   - algo.kCore(graph, k?)
 */

import type { GraphEngine } from '../core/graph-engine'

// ── Types ─────────────────────────────────────────────────

export type ProcedureArg = string | number | boolean | null | Record<string, unknown> | ProcedureArg[]

export interface ProcedureContext {
  graph: GraphEngine
  [key: string]: unknown
}

export type ProcedureResult = Record<string, unknown> | Record<string, unknown>[]

export type ProcedureImpl = (
  args: ProcedureArg[],
  ctx: ProcedureContext,
) => ProcedureResult | Promise<ProcedureResult>

interface ProcedureEntry {
  name: string
  impl: ProcedureImpl
  description?: string
}

// ── Procedure Registry ────────────────────────────────────

export class ProcedureRegistry {
  private procedures = new Map<string, ProcedureEntry>()

  constructor() {
    this.registerBuiltins()
  }

  /** Register a procedure by dot-notation name (e.g. "algo.pageRank") */
  registerProcedure(name: string, impl: ProcedureImpl, description?: string): void {
    if (this.procedures.has(name)) {
      throw new Error(`Procedure "${name}" is already registered`)
    }
    this.procedures.set(name, { name, impl, description })
  }

  /** Check if a procedure is registered */
  hasProcedure(name: string): boolean {
    return this.procedures.has(name)
  }

  /** List all registered procedures */
  listProcedures(): Array<{ name: string; description?: string }> {
    const result: Array<{ name: string; description?: string }> = []
    for (const entry of this.procedures.values()) {
      result.push({ name: entry.name, description: entry.description })
    }
    return result
  }

  /** Call a procedure by name with arguments and context */
  async callProcedure(
    name: string,
    args: ProcedureArg[],
    ctx: ProcedureContext,
  ): Promise<ProcedureResult> {
    const entry = this.procedures.get(name)
    if (!entry) {
      throw new Error(`Unknown procedure: "${name}". Available: ${this.listProcedures().map(p => p.name).join(', ')}`)
    }
    return entry.impl(args, ctx)
  }

  /** Invoke with shorthand syntax — returns the result directly */
  async invoke(name: string, ...args: ProcedureArg[]): Promise<ProcedureResult>
  async invoke(name: string, args: ProcedureArg[], ctx: ProcedureContext): Promise<ProcedureResult>
  async invoke(
    name: string,
    argsOrCtx: ProcedureArg[] | ProcedureArg,
    ctx?: ProcedureContext,
  ): Promise<ProcedureResult> {
    if (ctx) {
      return this.callProcedure(name, argsOrCtx as ProcedureArg[], ctx)
    }
    // Called without context — last arg might be context
    const args = Array.isArray(argsOrCtx) ? argsOrCtx : []
    return this.callProcedure(name, args, { graph: {} as GraphEngine })
  }

  // ── Built-in procedures ────────────────────────────────

  private registerBuiltins(): void {
    this.registerProcedure(
      'algo.pageRank',
      this.pageRankImpl.bind(this),
      'PageRank algorithm. Usage: CALL algo.pageRank(graph, iterations?, dampingFactor?)',
    )
    this.registerProcedure(
      'algo.shortestPath',
      this.shortestPathImpl.bind(this),
      'Shortest path between two nodes. Usage: CALL algo.shortestPath(graph, startNode, endNode, relationshipType?)',
    )
    this.registerProcedure(
      'algo.connectedComponents',
      this.connectedComponentsImpl.bind(this),
      'Connected components detection. Usage: CALL algo.connectedComponents(graph)',
    )
    this.registerProcedure(
      'algo.kCore',
      this.kCoreImpl.bind(this),
      'K-Core decomposition. Usage: CALL algo.kCore(graph, k?)',
    )
  }

  private async pageRankImpl(
    args: ProcedureArg[],
    ctx: ProcedureContext,
  ): Promise<ProcedureResult> {
    const iterations = typeof args[0] === 'number' ? args[0] : 20
    const dampingFactor = typeof args[1] === 'number' ? args[1] : 0.85
    const engine = ctx.graph

    // Get all nodes
    const nodes = engine.getAllNodes ? engine.getAllNodes() : []
    if (nodes.length === 0) return []

    // Simple iterative PageRank
    const scores = new Map<string, number>()
    const danglingScore = (1 - dampingFactor) / nodes.length

    // Initialize
    for (const node of nodes) {
      scores.set(node.id, 1 / nodes.length)
    }

    // Iterate
    for (let i = 0; i < iterations; i++) {
      const newScores = new Map<string, number>()
      let totalDanglingRank = 0

      for (const node of nodes) {
        const outEdges = engine.getOutEdges ? engine.getOutEdges(node.id) : []
        if (outEdges.length === 0) {
          totalDanglingRank += scores.get(node.id) ?? 0
        }
      }

      for (const node of nodes) {
        let rank = danglingScore + dampingFactor * totalDanglingRank / nodes.length

        // Incoming edges
        const inEdges = engine.getInEdges ? engine.getInEdges(node.id) : []
        for (const edge of inEdges) {
          const outEdges = engine.getOutEdges ? engine.getOutEdges(edge.source) : []
          const sourceRank = scores.get(edge.source) ?? 0
          rank += dampingFactor * sourceRank / Math.max(outEdges.length, 1)
        }

        newScores.set(node.id, rank)
      }

      for (const [id, score] of newScores) {
        scores.set(id, score)
      }
    }

    return Array.from(scores.entries())
      .map(([node, score]) => ({ node, score }))
      .sort((a, b) => b.score - a.score)
  }

  private async shortestPathImpl(
    args: ProcedureArg[],
    ctx: ProcedureContext,
  ): Promise<ProcedureResult> {
    const startNode = String(args[0] ?? '')
    const endNode = String(args[1] ?? '')
    const relationshipType = args[2] ? String(args[2]) : undefined
    const engine = ctx.graph

    if (!startNode || !endNode) {
      throw new Error('shortestPath requires startNode and endNode')
    }

    // BFS shortest path
    const visited = new Set<string>()
    const parent = new Map<string, { node: string; edge: Record<string, unknown> | null } | null>()
    const queue: string[] = [startNode]
    visited.add(startNode)
    parent.set(startNode, null)

    while (queue.length > 0) {
      const current = queue.shift()!
      if (current === endNode) break

      const edges = engine.getOutEdges ? engine.getOutEdges(current) : []
      for (const edge of edges) {
        if (relationshipType && edge.type !== relationshipType) continue
        const target = edge.target
        if (!visited.has(target)) {
          visited.add(target)
          parent.set(target, { node: current, edge })
          queue.push(target)
        }
      }
    }

    if (!parent.has(endNode)) {
      return []
    }

    // Reconstruct path
    const path: Array<{ node: string; edge: Record<string, unknown> | null }> = []
    let current: string | null = endNode
    while (current) {
      const p = parent.get(current)
      if (p) {
        path.unshift({ node: current, edge: p.edge })
        current = p.node
      } else {
        path.unshift({ node: current, edge: null })
        current = null
      }
    }

    return path
  }

  private async connectedComponentsImpl(
    args: ProcedureArg[],
    ctx: ProcedureContext,
  ): Promise<ProcedureResult> {
    const engine = ctx.graph
    const nodes = engine.getAllNodes ? engine.getAllNodes() : []
    if (nodes.length === 0) return []

    const visited = new Set<string>()
    const components: Array<{ component: number; nodes: string[]; size: number }> = []
    let componentId = 0

    for (const node of nodes) {
      if (visited.has(node.id)) continue

      // BFS
      const component: string[] = []
      const queue = [node.id]
      visited.add(node.id)

      while (queue.length > 0) {
        const current = queue.shift()!
        component.push(current)

        const edges = [
          ...(engine.getOutEdges ? engine.getOutEdges(current) : []),
          ...(engine.getInEdges ? engine.getInEdges(current) : []),
        ]
        for (const edge of edges) {
          const neighbor = edge.target === current ? edge.source : edge.target
          if (!visited.has(neighbor)) {
            visited.add(neighbor)
            queue.push(neighbor)
          }
        }
      }

      components.push({
        component: componentId++,
        nodes: component,
        size: component.length,
      })
    }

    return components.sort((a, b) => b.size - a.size)
  }

  private async kCoreImpl(
    args: ProcedureArg[],
    ctx: ProcedureContext,
  ): Promise<ProcedureResult> {
    const k = typeof args[0] === 'number' ? args[0] : 2
    const engine = ctx.graph
    const nodes = engine.getAllNodes ? engine.getAllNodes() : []
    if (nodes.length === 0) return []

    // Compute degrees
    const degree = new Map<string, number>()
    for (const node of nodes) {
      const edges = [
        ...(engine.getOutEdges ? engine.getOutEdges(node.id) : []),
        ...(engine.getInEdges ? engine.getInEdges(node.id) : []),
      ]
      degree.set(node.id, new Set(edges.map(e => e.target === node.id ? e.source : e.target)).size)
    }

    // Peeling
    const removed = new Set<string>()
    let changed = true

    while (changed) {
      changed = false
      for (const [id, deg] of degree) {
        if (!removed.has(id) && deg < k) {
          removed.add(id)
          changed = true

          // Decrease degree of neighbors
          const edges = [
            ...(engine.getOutEdges ? engine.getOutEdges(id) : []),
            ...(engine.getInEdges ? engine.getInEdges(id) : []),
          ]
          for (const edge of edges) {
            const neighbor = edge.target === id ? edge.source : edge.target
            if (!removed.has(neighbor)) {
              degree.set(neighbor, (degree.get(neighbor) ?? 1) - 1)
            }
          }
        }
      }
    }

    const coreNodes: string[] = []
    for (const node of nodes) {
      if (!removed.has(node.id)) {
        coreNodes.push(node.id)
      }
    }

    return [{
      k,
      coreSize: coreNodes.length,
      coreNodes,
    }]
  }
}

/** Singleton instance (shared across the application) */
export const procedureRegistry = new ProcedureRegistry()
