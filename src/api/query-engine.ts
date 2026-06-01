// ============================================================
// query-engine.ts — Variable-Length Path Query Engine
//
// Supports Neo4j/Cypher-style variable-length path patterns:
//   (:Person)-[:KNOWS*1..3]->(:Person)
//   (:Person)-[:KNOWS*]->(:Person)
//   (:Person)-[:KNOWS*2]->(:Person)
//
// Uses BFS (breadth-first search) for shortest-path-first
// semantics. Max depth is capped at 50 for safety.
// ============================================================

import { ShardManager } from '../shard/shard-manager'
import { NodeId, EdgeRecord, NodeRecord } from '../types'

// ──────────────────────────────────────────
// Types
// ──────────────────────────────────────────

/** Parsed variable-length path range */
export interface VarlenRange {
  /** Minimum number of edges (inclusive). Default 1. */
  min: number
  /** Maximum number of edges (inclusive). null means unbounded (capped to MAX_DEPTH_SAFETY). */
  max: number | null
}

/**
 * Result of a variable-length path query.
 * Each path is an array of node IDs representing the sequence of nodes
 * traversed from the start node to the end node.
 */
export type VarlenPath = NodeId[]

/**
 * Options for finding variable-length paths.
 */
export interface VarlenPathOptions {
  /** Source node ID to start from */
  source: NodeId
  /** Edge type filter (optional) */
  edgeTypeFilter?: number[]
  /** Variable-length range */
  range: VarlenRange
  /** Whether to include paths shorter than min (for *0 pattern). Default false. */
  includeZero?: boolean
  /** Maximum number of paths to return (optional) */
  limit?: number
}

// ──────────────────────────────────────────
// Constants
// ──────────────────────────────────────────

/** Absolute maximum depth to prevent infinite loops. */
const ABSOLUTE_MAX_DEPTH = 50

/** Default max depth when range is unbounded (* only). */
const DEFAULT_UNBOUNDED_MAX_DEPTH = 5

// ──────────────────────────────────────────
// Parse Helpers
// ──────────────────────────────────────────

/**
 * Parse a Cypher-style variable-length edge pattern into a VarlenRange.
 *
 * Supported formats:
 *   *         → { min: 1, max: DEFAULT_UNBOUNDED_MAX_DEPTH }
 *   *0        → { min: 0, max: 0 }
 *   *3        → { min: 3, max: 3 }
 *   *1..3     → { min: 1, max: 3 }
 *   *0..5     → { min: 0, max: 5 }
 *   *1..      → { min: 1, max: ABSOLUTE_MAX_DEPTH }
 *   *..5      → { min: 1, max: 5 }
 *
 * @param spec - The variable-length spec string (everything after *)
 * @returns Parsed VarlenRange
 */
export function parseVarlenSpec(spec: string): VarlenRange {
  if (!spec || spec.trim() === '') {
    // Just "*" — unbounded
    return { min: 1, max: DEFAULT_UNBOUNDED_MAX_DEPTH }
  }

  const trimmed = spec.trim()

  // "*N" — exact length
  const exactMatch = trimmed.match(/^(\d+)$/)
  if (exactMatch) {
    const n = parseInt(exactMatch[1], 10)
    return { min: n, max: n }
  }

  // "*N..M" or "*N.." or "*..M"
  const rangeMatch = trimmed.match(/^(\d*)\s*\.\.\s*(\d*)$/)
  if (rangeMatch) {
    const minStr = rangeMatch[1]
    const maxStr = rangeMatch[2]

    const min = minStr !== '' ? parseInt(minStr, 10) : 1
    const max = maxStr !== '' ? parseInt(maxStr, 10) : ABSOLUTE_MAX_DEPTH

    return { min, max: Math.min(max, ABSOLUTE_MAX_DEPTH) }
  }

  // Fallback — treat as exact N
  const n = parseInt(trimmed, 10)
  if (!isNaN(n)) {
    return { min: n, max: n }
  }

  // Default
  return { min: 1, max: DEFAULT_UNBOUNDED_MAX_DEPTH }
}

/**
 * Parse a full edge label with optional variable-length suffix.
 * e.g. "KNOWS*1..3" → { label: "KNOWS", range: { min: 1, max: 3 } }
 *       "KNOWS*"    → { label: "KNOWS", range: { min: 1, max: 5 } }
 *       "KNOWS"     → { label: "KNOWS", range: null }
 *
 * @param edgeLabel - Full edge label string (may include * suffix)
 * @returns Parsed edge label and optional variable-length range
 */
export function parseVarlenEdgeLabel(
  edgeLabel: string | null,
): { label: string | null; range: VarlenRange | null } {
  if (edgeLabel === null) {
    return { label: null, range: null }
  }

  const starIdx = edgeLabel.indexOf('*')
  if (starIdx === -1) {
    // No variable-length suffix
    return { label: edgeLabel, range: null }
  }

  const label = starIdx > 0 ? edgeLabel.slice(0, starIdx) : null
  const varlenSpec = edgeLabel.slice(starIdx + 1)
  const range = parseVarlenSpec(varlenSpec)

  return { label, range }
}

// ──────────────────────────────────────────
// BFS Path Expansion
// ──────────────────────────────────────────

/**
 * BFS queue entry for path expansion.
 */
interface BfsEntry {
  /** Current node ID */
  nodeId: NodeId
  /** Path from source to this node */
  path: NodeId[]
  /** Current depth (number of edges traversed) */
  depth: number
}

/**
 * Find all variable-length paths from a source node using BFS.
 *
 * Uses breadth-first search to guarantee shortest-path-first
 * semantics. Paths are capped by both the user-specified min/max
 * range and the ABSOLUTE_MAX_DEPTH safety limit.
 *
 * @param manager - ShardManager instance for neighbor lookups
 * @param options - VarlenPathOptions with source, range, filters
 * @returns Array of paths (each path is an array of node IDs)
 */
export async function findVarlenPaths(
  manager: ShardManager,
  options: VarlenPathOptions,
): Promise<VarlenPath[]> {
  const { source, range, edgeTypeFilter, includeZero, limit } = options

  // Apply safety cap
  const effectiveMax = range.max !== null
    ? Math.min(range.max, ABSOLUTE_MAX_DEPTH)
    : DEFAULT_UNBOUNDED_MAX_DEPTH

  const results: VarlenPath[] = []

  // For *0 pattern, include the source node as a zero-length path
  if (includeZero || range.min === 0) {
    results.push([source])
    if (limit !== undefined && results.length >= limit) {
      return results
    }
    // If range.max === 0, we're done
    if (range.max === 0) {
      return results
    }
  }

  // BFS
  const queue: BfsEntry[] = [{ nodeId: source, path: [source], depth: 0 }]
  const visitedThisLevel = new Map<NodeId, number>()

  while (queue.length > 0) {
    const entry = queue.shift()!

    // If we've reached the max depth, don't expand further
    if (entry.depth >= effectiveMax) {
      continue
    }

    // Fetch neighbors
    let neighbors: EdgeRecord[]
    try {
      const result = await manager.neighbors(entry.nodeId, {
        maxDepth: 1,
        edgeTypeFilter,
      })
      neighbors = result.edges ?? []
    } catch {
      neighbors = []
    }

    // Group neighbors by depth to avoid revisiting nodes at same level
    // This prevents cycles within the current BFS level
    const nextDepth = entry.depth + 1

    for (const edge of neighbors) {
      const candidateId = edge.dst

      // Avoid revisiting nodes within the same path (basic cycle prevention)
      if (entry.path.includes(candidateId)) {
        continue
      }

      const newPath = [...entry.path, candidateId]

      // Check if this path matches the minimum depth requirement
      if (nextDepth >= range.min) {
        results.push(newPath)
        if (limit !== undefined && results.length >= limit) {
          return results
        }
      }

      // Only enqueue if we haven't exceeded the max depth
      if (nextDepth < effectiveMax) {
        queue.push({
          nodeId: candidateId,
          path: newPath,
          depth: nextDepth,
        })
      }
    }
  }

  return results
}

/**
 * Find all variable-length paths from a source node using BFS,
 * returning paths as arrays of node IDs.
 *
 * Convenience wrapper with simpler interface.
 *
 * @param manager - ShardManager
 * @param source - Starting node ID
 * @param minDepth - Minimum path length (edges)
 * @param maxDepth - Maximum path length (edges). null = unbounded.
 * @param edgeTypeFilter - Optional edge type filter
 * @returns Array of paths
 */
export async function findPaths(
  manager: ShardManager,
  source: NodeId,
  minDepth: number = 1,
  maxDepth: number | null = null,
  edgeTypeFilter?: number[],
): Promise<VarlenPath[]> {
  return findVarlenPaths(manager, {
    source,
    range: { min: minDepth, max: maxDepth },
    edgeTypeFilter,
  })
}

/**
 * Extract the unique endpoint nodes from variable-length path results.
 * This gives you all nodes reachable via paths of the specified length range.
 *
 * @param paths - Array of paths from findVarlenPaths
 * @returns Unique end node IDs
 */
export function extractEndpoints(paths: VarlenPath[]): NodeId[] {
  const seen = new Set<NodeId>()
  const endpoints: NodeId[] = []

  for (const path of paths) {
    const last = path[path.length - 1]
    if (!seen.has(last)) {
      seen.add(last)
      endpoints.push(last)
    }
  }

  return endpoints
}

/**
 * Flatten variable-length path results to include all intermediate nodes
 * (deduplicated) that appear on any path.
 *
 * @param paths - Array of paths from findVarlenPaths
 * @returns Unique node IDs on all paths
 */
export function flattenPaths(paths: VarlenPath[]): NodeId[] {
  const seen = new Set<NodeId>()
  const nodes: NodeId[] = []

  for (const path of paths) {
    for (const nid of path) {
      if (!seen.has(nid)) {
        seen.add(nid)
        nodes.push(nid)
      }
    }
  }

  return nodes
}
