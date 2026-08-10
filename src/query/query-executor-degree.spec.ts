/**
 * Unit tests for pattern comprehension degree computation.
 *
 * These tests validate the core logic that computes node degree from
 * allNodes[sourceIdx].__edges — the same logic used in
 * _executeViaGraphEngine for evaluating size([(n)--() | 1]) expressions.
 *
 * The computation is extracted as a standalone pure function for
 * testability, while the integration path is verified via TCK List6.
 */

import { describe, it, expect } from 'vitest'

// ── Standalone degree computation function ──
// Extracted from _executeViaGraphEngine (query-executor.ts) to allow
// pure unit testing without the full GE pipeline.

interface EdgeEntry {
  srcIdx: number
  dstIdx: number
  label?: string
  props?: Record<string, unknown> | null
}

interface ComputeDegreeParams {
  /** All nodes (original + any post-DML additions). */
  allNodes: Array<Record<string, unknown>>
  /** Count of original seed nodes (before DML additions). */
  originalNodeCount: number
  /** Optional edge-type filter labels (e.g. ['T'] or ['T','S','R']). */
  filterLabels?: string[] | null
  /** Index of the source node in allNodes to compute degree for. */
  sourceIdx: number
}

/**
 * Compute the degree of a source node by reading its __edges array.
 *
 * This mirrors the inline logic in _executeViaGraphEngine:
 *   1. Look up allNodes[sourceIdx].__edges
 *   2. Skip edges where dstIdx >= originalNodeCount (post-DML nodes)
 *   3. Skip edges where !allNodes[dstIdx] (missing target)
 *   4. If filterLabels provided, only count edges whose label matches
 *   5. Deduplicate by (srcIdx, dstIdx, label) composite key
 *
 * The original inline code also has a seen set and per-row source
 * locating logic, but the core edge-counting is this function.
 */
function computeDegree(params: ComputeDegreeParams): number {
  const { allNodes, originalNodeCount, filterLabels, sourceIdx } = params
  const seen = new Set<string>()
  let degree = 0

  if (sourceIdx < 0 || sourceIdx >= originalNodeCount) return 0

  const sourceEdges = (allNodes[sourceIdx] as any).__edges
  if (!sourceEdges || !Array.isArray(sourceEdges)) return 0

  for (const edge of sourceEdges) {
    const dstIdx = edge.dstIdx
    if (dstIdx == null || dstIdx >= originalNodeCount) continue
    if (!allNodes[dstIdx]) continue

    if (filterLabels?.length) {
      const edgeLabel = edge.label ? String(edge.label) : ''
      if (!filterLabels.includes(edgeLabel)) continue
    }

    const dedupKey = `${sourceIdx}|${dstIdx}|${edge.label || ''}`
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)
    degree++
  }

  return degree
}

// ── Helper builders ──

/** Build a node with optional label, properties, and edges. */
function node(opts: {
  _label?: string
  _alias?: string
  props?: Record<string, unknown>
  edges?: EdgeEntry[]
}): Record<string, unknown> {
  const n: Record<string, unknown> = { ...opts.props }
  if (opts._label) n._label = opts._label
  if (opts._alias) n._alias = opts._alias
  ;(n as any).__edges = (opts.edges || []).map(e => ({ ...e }))
  return n
}

/** Build an edge entry. */
function edge(srcIdx: number, dstIdx: number, label?: string): EdgeEntry {
  return { srcIdx, dstIdx, label }
}

// ── Tests ──

describe('computeDegree (pattern comprehension)', () => {
  // ─── Dimension 1: unfiltered degree ───

  describe('unfiltered degree', () => {
    it('should return 0 for a node with no edges', () => {
      const allNodes = [node({ _label: 'X', props: { num: 1 } })]
      expect(computeDegree({ allNodes, originalNodeCount: 1, sourceIdx: 0 })).toBe(0)
    })

    it('should return degree for a node with 1 edge', () => {
      const allNodes = [
        node({ _label: 'X', edges: [edge(0, 1, 'T')] }),
        node({ _label: 'Default' }),
      ]
      expect(computeDegree({ allNodes, originalNodeCount: 2, sourceIdx: 0 })).toBe(1)
    })

    it('should return degree for a node with 3 edges', () => {
      const allNodes = [
        node({ _label: 'X', edges: [
          edge(0, 1, 'T'), edge(0, 2, 'T'), edge(0, 3, 'T'),
        ]}),
        node({ _label: 'Default' }),
        node({ _label: 'Default' }),
        node({ _label: 'Default' }),
      ]
      expect(computeDegree({ allNodes, originalNodeCount: 4, sourceIdx: 0 })).toBe(3)
    })

    it('should deduplicate edges with same (srcIdx, dstIdx, label)', () => {
      const allNodes = [
        node({ _label: 'X', edges: [
          edge(0, 1, 'T'), edge(0, 1, 'T'), // duplicate
          edge(0, 2, 'T'),
        ]}),
        node({ _label: 'Default' }),
        node({ _label: 'Default' }),
      ]
      expect(computeDegree({ allNodes, originalNodeCount: 3, sourceIdx: 0 })).toBe(2)
    })
  })

  // ─── Dimension 2: filtered degree ───

  describe('filtered degree by edge label', () => {
    it('should count only edges matching the filter label [:T]', () => {
      const allNodes = [
        node({ _label: 'X', edges: [
          edge(0, 1, 'T'), edge(0, 2, 'T'), edge(0, 3, 'T'), edge(0, 4, 'OTHER'),
        ]}),
        node({ _label: 'Default' }), node({ _label: 'Default' }),
        node({ _label: 'Default' }), node({ _label: 'Default' }),
      ]
      expect(computeDegree({
        allNodes, originalNodeCount: 5, sourceIdx: 0,
        filterLabels: ['T'],
      })).toBe(3)
    })

    it('should count edges matching any of multiple filter labels [:T|S|R]', () => {
      const allNodes = [
        node({ _label: 'X', edges: [
          edge(0, 1, 'T'), edge(0, 2, 'S'), edge(0, 3, 'R'),
          edge(0, 4, 'T'), edge(0, 5, 'Z'), // Z excluded
        ]}),
        node({ _label: 'Default' }), node({ _label: 'Default' }),
        node({ _label: 'Default' }), node({ _label: 'Default' }),
        node({ _label: 'Default' }), node({ _label: 'Default' }),
      ]
      expect(computeDegree({
        allNodes, originalNodeCount: 7, sourceIdx: 0,
        filterLabels: ['T', 'S', 'R'],
      })).toBe(4) // T(1), S(2), R(3), T(4) → 4 (Z excluded)
    })

    it('should return 0 when filter labels match no edges', () => {
      const allNodes = [
        node({ _label: 'X', edges: [edge(0, 1, 'T')] }),
        node({ _label: 'Default' }),
      ]
      expect(computeDegree({
        allNodes, originalNodeCount: 2, sourceIdx: 0,
        filterLabels: ['NOTHING'],
      })).toBe(0)
    })

    it('should handle edge with no label property (empty string)', () => {
      const allNodes = [
        node({ _label: 'X', edges: [
          { srcIdx: 0, dstIdx: 1 }, // no label
          edge(0, 2, 'T'),
        ]}),
        node({ _label: 'Default' }), node({ _label: 'Default' }),
      ]
      // Empty label edges NOT counted when filterLabels present
      expect(computeDegree({
        allNodes, originalNodeCount: 3, sourceIdx: 0,
        filterLabels: ['T'],
      })).toBe(1)
    })
  })

  // ─── Dimension 3: edge cases ───

  describe('edge cases', () => {
    it('should return 0 when allNodes is empty', () => {
      expect(computeDegree({ allNodes: [], originalNodeCount: 0, sourceIdx: 0 })).toBe(0)
    })

    it('should return 0 when sourceIdx is negative', () => {
      const allNodes = [node({ _label: 'X', edges: [edge(0, 1, 'T')] }), node({ _label: 'Default' })]
      expect(computeDegree({ allNodes, originalNodeCount: 2, sourceIdx: -1 })).toBe(0)
    })

    it('should return 0 when sourceIdx >= originalNodeCount (post-DML node)', () => {
      const allNodes = [
        node({ _label: 'X' }), // idx 0: original
        node({ _label: 'Y', edges: [edge(1, 2, 'T')] }), // idx 1: post-DML
        node({ _label: 'Default' }),
      ]
      // sourceIdx=1 >= originalNodeCount=1 → should skip
      expect(computeDegree({ allNodes, originalNodeCount: 1, sourceIdx: 1 })).toBe(0)
    })

    it('should skip edges with dstIdx >= originalNodeCount', () => {
      const allNodes = [
        node({ _label: 'X', edges: [
          edge(0, 1, 'T'), // dstIdx=1 < oc=2 → counted
          edge(0, 2, 'T'), // dstIdx=2 >= oc=2 → skipped
        ]}),
        node({ _label: 'Default' }), // idx 1
        node({ _label: 'Default' }), // idx 2 (post-DML)
      ]
      expect(computeDegree({ allNodes, originalNodeCount: 2, sourceIdx: 0 })).toBe(1)
    })

    it('should skip edges where dstIdx is null', () => {
      const allNodes = [
        node({ _label: 'X', edges: [
          edge(0, 1, 'T'),
          { srcIdx: 0, dstIdx: null as unknown as number, label: 'T' }, // null dstIdx
        ]}),
        node({ _label: 'Default' }),
      ]
      expect(computeDegree({ allNodes, originalNodeCount: 2, sourceIdx: 0 })).toBe(1)
    })

    it('should return 0 when __edges is not an array', () => {
      const allNodes = [node({ _label: 'X' })]
      ;(allNodes[0] as any).__edges = 'not-an-array'
      expect(computeDegree({ allNodes, originalNodeCount: 1, sourceIdx: 0 })).toBe(0)
    })

    it('should return 0 when allNodes[dstIdx] is undefined', () => {
      const allNodes = [
        node({ _label: 'X', edges: [edge(0, 99, 'T')] }), // dstIdx 99 doesn't exist
      ]
      expect(computeDegree({ allNodes, originalNodeCount: 1, sourceIdx: 0 })).toBe(0)
    })
  })

  // ─── Dimension 4: cross-scenario contamination resistance ───

  describe('cross-scenario contamination resistance', () => {
    it('should not count edges added to __edges after original snapshot', () => {
      const allNodes = [
        node({ _label: 'X', edges: [edge(0, 1, 'T'), edge(0, 2, 'T')] }),
        node({ _label: 'Default' }), node({ _label: 'Default' }),
      ]
      // Simulate contamination: extra edge pushed after creation
      ;(allNodes[0] as any).__edges.push(edge(0, 3, 'T'))
      // But dstIdx=3 >= originalNodeCount=3 → skipped
      expect(computeDegree({ allNodes, originalNodeCount: 3, sourceIdx: 0 })).toBe(2)
    })

    it('should handle multiple source nodes independently (List6 [7] pattern)', () => {
      // List6 [7]: two X nodes — one with edge, one without
      const allNodes = [
        node({ _label: 'X', props: { num: 42 }, edges: [edge(0, 2, 'T')] }),
        node({ _label: 'X', props: { num: 43 } }), // no edges
        node({ _label: 'Default' }),
      ]
      expect(computeDegree({ allNodes, originalNodeCount: 3, sourceIdx: 0 })).toBe(1)
      expect(computeDegree({ allNodes, originalNodeCount: 3, sourceIdx: 1 })).toBe(0)
    })

    it('should maintain independence when computing degree for multiple source nodes', () => {
      const allNodes = [
        node({ _label: 'A', edges: [edge(0, 2, 'R')] }),
        node({ _label: 'B', edges: [edge(1, 2, 'S'), edge(1, 3, 'T')] }),
        node({ _label: 'Default' }), node({ _label: 'Default' }),
      ]
      // Each node's seen Set is independent
      expect(computeDegree({ allNodes, originalNodeCount: 4, sourceIdx: 0 })).toBe(1)
      expect(computeDegree({ allNodes, originalNodeCount: 4, sourceIdx: 1 })).toBe(2)
    })
  })
})
