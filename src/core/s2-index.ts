// ============================================================
// S2Index — S2 geometry based geospatial index
//
// Uses the s2-geometry library to provide S2 cell-based indexing.
// Supports:
//   - Point indexing via S2CellId (configurable level)
//   - Region covering (s2 cover) for rectangular areas
//   - k-nearest neighbor search
//   - Radius queries with Haversine post-filter
//   - Cell hierarchy navigation (parent / children / neighbors)
// ============================================================

import { haversineKm } from './geo-index'

/** S2 indexed item with node ID and coordinates */
export interface S2IndexItem {
  nodeId: number
  lat: number
  lng: number
  cellId: string // Hilbert quadkey string like "1/203231003020023"
  level: number
}

/**
 * Options for S2Index construction
 */
export interface S2IndexOptions {
  /** S2 cell level (0-30). Higher = finer granularity. Default: 15 */
  defaultLevel?: number
  /** Max cells for region covering. Default: 30 */
  maxCoverCells?: number
  /** Min level for region covering. Default: 10 */
  minCoverLevel?: number
  /** Max level for region covering. Default: 20 */
  maxCoverLevel?: number
}

/**
 * S2Index — S2 geometry based geospatial index.
 *
 * Uses S2 cell IDs (Hilbert quadkey strings) to index lat/lng points.
 * Provides fast lookup by cell, hierarchical navigation, and spatial queries.
 *
 * Thread-safe for single-threaded Node.js usage.
 */
export class S2Index {
  /** nodeId → item lookup */
  private _items: Map<number, S2IndexItem> = new Map()
  /** cellId → Set<nodeId> lookup */
  private _cellIndex: Map<string, Set<number>> = new Map()

  private _defaultLevel: number
  private _maxCoverCells: number
  private _minCoverLevel: number
  private _maxCoverLevel: number

  constructor(options?: S2IndexOptions) {
    this._defaultLevel = options?.defaultLevel ?? 15
    this._maxCoverCells = options?.maxCoverCells ?? 30
    this._minCoverLevel = options?.minCoverLevel ?? 10
    this._maxCoverLevel = options?.maxCoverLevel ?? 20
  }

  /**
   * Return the total number of indexed nodes.
   */
  get size(): number {
    return this._items.size
  }

  /**
   * Check whether a nodeId is currently indexed.
   */
  has(nodeId: number): boolean {
    return this._items.has(nodeId)
  }

  /**
   * Add a node to the S2 index.
   * Overwrites existing entry for the same nodeId.
   */
  addNode(nodeId: number, lat: number, lng: number, level?: number): void {
    if (this._items.has(nodeId)) {
      this.removeNode(nodeId)
    }

    const cellLevel = level ?? this._defaultLevel
    const cellId = latLngToKey(lat, lng, cellLevel)

    const item: S2IndexItem = {
      nodeId,
      lat,
      lng,
      cellId,
      level: cellLevel,
    }

    this._items.set(nodeId, item)

    if (!this._cellIndex.has(cellId)) {
      this._cellIndex.set(cellId, new Set())
    }
    this._cellIndex.get(cellId)!.add(nodeId)
  }

  /**
   * Remove a node from the S2 index.
   * No-op if nodeId is not indexed.
   */
  removeNode(nodeId: number): void {
    const item = this._items.get(nodeId)
    if (!item) return

    const cellNodes = this._cellIndex.get(item.cellId)
    if (cellNodes) {
      cellNodes.delete(nodeId)
      if (cellNodes.size === 0) {
        this._cellIndex.delete(item.cellId)
      }
    }

    this._items.delete(nodeId)
  }

  /**
   * Update the position of an already-indexed node.
   * Equivalent to removeNode + addNode.
   */
  updateNode(nodeId: number, lat: number, lng: number, level?: number): void {
    this.removeNode(nodeId)
    this.addNode(nodeId, lat, lng, level)
  }

  /**
   * Get the S2 cell key for a lat/lng at the given level.
   * Uses the s2-geometry library.
   */
  cellIdAt(lat: number, lng: number, level?: number): string {
    return latLngToKey(lat, lng, level ?? this._defaultLevel)
  }

  /**
   * Get the parent cell key for a given cell.
   * Returns the cell key at parent level (one level up).
   */
  parentCell(cellId: string): string {
    return parentKey(cellId)
  }

  /**
   * Get the four neighboring cells for a given cell.
   */
  neighborCells(cellId: string): string[] {
    try {
      const s2Cell = require('s2-geometry').S2.S2Cell
      return s2Cell.latLngToNeighborKeys(
        ...keyToLatLng(cellId),
        0,  // dummy — the function uses lat/lng and level
      )
    } catch {
      return []
    }
  }

  /**
   * Query all nodes within a given radius (km) from a center point.
   * Uses S2 cells for initial filtering and Haversine for accuracy.
   */
  queryRadius(lat: number, lng: number, radiusKm: number): number[] {
    if (radiusKm <= 0) return []

    // Determine appropriate level from radius (coarser for larger radius)
    const level = this._radiusToLevel(radiusKm)

    // Compute bounding box for the radius
    const { latKm, lngKm } = kmPerDegree(lat)
    const dLat = radiusKm / latKm
    const dLng = radiusKm / lngKm

    const minLat = lat - dLat
    const maxLat = lat + dLat
    const minLng = lng - dLng
    const maxLng = lng + dLng

    // Get covering S2 cells for the bounding box
    const coveringCells = this._coverRect(minLat, minLng, maxLat, maxLng, level)

    // Collect candidates from covering cells (and their sub-cells)
    const seen = new Set<number>()
    const candidates: Array<{ nodeId: number; lat: number; lng: number }> = []

    for (const cellId of coveringCells) {
      this._collectNodesInCell(cellId, seen, candidates)
    }

    // If few covering cells, also search neighboring cells
    if (coveringCells.length <= 4) {
      for (const cellId of coveringCells) {
        this._collectNeighborNodes(cellId, seen, candidates)
      }
    }

    // Post-filter with Haversine for accurate radius
    return candidates
      .filter(item => {
        const dist = haversineKm(lat, lng, item.lat, item.lng)
        return dist <= radiusKm
      })
      .map(item => item.nodeId)
  }

  /**
   * Query all nodes within a given bounding box.
   */
  queryBBox(
    southWest: [number, number],
    northEast: [number, number],
  ): number[] {
    const [minLat, minLng] = southWest
    const [maxLat, maxLng] = northEast

    const coveringCells = this._coverRect(minLat, minLng, maxLat, maxLng)

    const seen = new Set<number>()
    const result: number[] = []

    for (const cellId of coveringCells) {
      this._collectNodesInCell(cellId, seen, result)
    }

    // Also expand to neighboring cells to catch boundary cases
    if (coveringCells.length <= 4) {
      for (const cellId of coveringCells) {
        this._collectNeighborNodes(cellId, seen, result)
      }
    }

    // Post-filter by bbox
    return result.filter(nodeId => {
      const item = this._items.get(nodeId)
      if (!item) return false
      return (
        item.lat >= minLat &&
        item.lat <= maxLat &&
        item.lng >= minLng &&
        item.lng <= maxLng
      )
    })
  }

  /**
   * Find the k nearest neighbors from a given point.
   */
  kNearest(
    lat: number, lng: number,
    k: number,
    maxRadiusKm?: number,
  ): number[] {
    if (k <= 0 || this._items.size === 0) return []

    // Determine search radius
    const searchRadius = maxRadiusKm ?? this._estimateRadius(k)
    const candidates = this.queryRadius(lat, lng, searchRadius)

    // If not enough candidates, expand search
    let finalCandidates = candidates
    if (finalCandidates.length < k && (!maxRadiusKm || maxRadiusKm <= 0)) {
      // Expand radius iteratively
      const expanded = this.queryRadius(lat, lng, searchRadius * 3)
      for (const id of expanded) {
        if (!finalCandidates.includes(id)) {
          finalCandidates.push(id)
        }
      }
    }

    // Sort by Haversine distance
    return finalCandidates
      .map(nodeId => ({
        nodeId,
        dist: haversineKm(lat, lng,
          this._items.get(nodeId)!.lat,
          this._items.get(nodeId)!.lng),
      }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, k)
      .map(item => item.nodeId)
  }

  /**
   * Clear all entries from the index.
   */
  clear(): void {
    this._items.clear()
    this._cellIndex.clear()
  }

  /**
   * Get the stored data for a nodeId (if indexed).
   */
  getPosition(nodeId: number): { lat: number; lng: number; cellId: string } | null {
    const item = this._items.get(nodeId)
    if (!item) return null
    return { lat: item.lat, lng: item.lng, cellId: item.cellId }
  }

  /**
   * Get all nodeIds in a specific S2 cell.
   */
  getNodesInCell(cellId: string): number[] {
    const nodes = this._cellIndex.get(cellId)
    if (!nodes) return []
    return [...nodes]
  }

  /**
   * Get all indexed S2 cell keys.
   */
  getCellKeys(): string[] {
    return [...this._cellIndex.keys()]
  }

  /**
   * Convert a radius to an appropriate S2 cell level.
   * Smaller radius → higher level (finer cells).
   */
  private _radiusToLevel(radiusKm: number): number {
    if (radiusKm <= 0.1) return 20
    if (radiusKm <= 0.5) return 18
    if (radiusKm <= 1) return 16
    if (radiusKm <= 5) return 14
    if (radiusKm <= 20) return 12
    if (radiusKm <= 100) return 10
    return 8
  }

  /**
   * Estimate a search radius that would contain at least k items.
   */
  private _estimateRadius(k: number): number {
    if (this._items.size === 0) return 1
    const density = this._items.size / 510.1 // Earth surface area ~510M km²
    if (density === 0) return 1
    const areaPerK = k / density
    const radius = Math.sqrt(areaPerK / Math.PI)
    return Math.max(radius, 0.1)
  }

  /**
   * Get covering S2 cells for a rectangular region.
   */
  private _coverRect(
    minLat: number, minLng: number,
    maxLat: number, maxLng: number,
    level?: number,
  ): string[] {
    const cellLevel = level ?? this._defaultLevel

    // Simplified covering: compute corner cells and all cells between them
    // Since s2-geometry doesn't have a native cover, we compute a set of cells
    // that cover the bounding box at the target level.
    return this._computeCellsInRect(minLat, minLng, maxLat, maxLng, cellLevel)
  }

  /**
   * Compute all S2 cell keys that overlap with a bounding box at a given level.
   * Uses a simple grid-based approach: compute cells for corners and interior points.
   */
  private _computeCellsInRect(
    minLat: number, minLng: number,
    maxLat: number, maxLng: number,
    level: number,
  ): string[] {
    const cells = new Set<string>()

    // Add center
    const centerLat = (minLat + maxLat) / 2
    const centerLng = (minLng + maxLng) / 2
    cells.add(latLngToKey(centerLat, centerLng, level))

    // Add 4 corners
    cells.add(latLngToKey(minLat, minLng, level))
    cells.add(latLngToKey(minLat, maxLng, level))
    cells.add(latLngToKey(maxLat, minLng, level))
    cells.add(latLngToKey(maxLat, maxLng, level))

    // Add edge midpoints
    cells.add(latLngToKey((minLat + maxLat) / 2, minLng, level))
    cells.add(latLngToKey((minLat + maxLat) / 2, maxLng, level))
    cells.add(latLngToKey(minLat, (minLng + maxLng) / 2, level))
    cells.add(latLngToKey(maxLat, (minLng + maxLng) / 2, level))

    // For wider boxes, add more interior points
    const latSpan = Math.abs(maxLat - minLat)
    const lngSpan = Math.abs(maxLng - minLng)
    const cellSize = cellApproxSize(level)

    if (latSpan > cellSize * 3 || lngSpan > cellSize * 3) {
      const steps = Math.min(
        Math.max(Math.ceil(latSpan / cellSize), 1),
        this._maxCoverCells
      )
      for (let i = 0; i <= steps; i++) {
        for (let j = 0; j <= steps; j++) {
          const lat = minLat + (maxLat - minLat) * (i / steps)
          const lng = minLng + (maxLng - minLng) * (j / steps)
          cells.add(latLngToKey(lat, lng, level))
        }
      }
    }

    return [...cells]
  }

  /**
   * Collect all indexed node IDs that fall under a given S2 cell.
   */
  private _collectNodesInCell(
    cellId: string,
    seen: Set<number>,
    out: number[] | Array<{ nodeId: number; lat: number; lng: number }>,
  ): void {
    const direct = this._cellIndex.get(cellId)
    if (direct) {
      for (const nodeId of direct) {
        if (!seen.has(nodeId)) {
          seen.add(nodeId)
          out.push(nodeId)
        }
      }
    }

    // Check all indexed cells — if the indexed cell is a child of this cell (cellId prefix match),
    // include those nodes too
    const prefix = cellId + '/'
    for (const [idxCellId, nodeIds] of this._cellIndex.entries()) {
      if (idxCellId.startsWith(prefix) || idxCellId === cellId) {
        for (const nodeId of nodeIds) {
          if (!seen.has(nodeId)) {
            seen.add(nodeId)
            out.push(nodeId)
          }
        }
      }
    }
  }

  /**
   * Collect nodes from neighboring cells.
   */
  private _collectNeighborNodes(
    cellId: string,
    seen: Set<number>,
    out: number[] | Array<{ nodeId: number; lat: number; lng: number }>,
  ): void {
    try {
      const S2Cell = require('s2-geometry').S2.S2Cell
      // Extract lat/lng from the cell key to get neighbors
      const [lat, lng] = keyToLatLng(cellId)
      const level = cellKeyLevel(cellId)
      const neighbors = S2Cell.latLngToNeighborKeys(lat, lng, level)
      for (const neighborId of neighbors) {
        this._collectNodesInCell(neighborId, seen, out)
      }
    } catch {
      // ignore
    }
  }
}

// ──────────────────────────────────────────────
//  Standalone S2 helper functions
// ──────────────────────────────────────────────

/**
 * Convert lat/lng to S2 cell key (Hilbert quadkey) at given level.
 * Wraps s2-geometry library.
 */
export function latLngToKey(lat: number, lng: number, level: number): string {
  const S2Cell = require('s2-geometry').S2.S2Cell
  return S2Cell.latLngToKey(lat, lng, level)
}

/**
 * Convert lat/lng to S2 cell numeric ID at given level.
 */
export function latLngToId(lat: number, lng: number, level: number): string {
  const S2Cell = require('s2-geometry').S2.S2Cell
  const key = S2Cell.latLngToKey(lat, lng, level)
  return String(S2Cell.keyToId(key))
}

/**
 * Convert S2 cell key to lat/lng (center of cell).
 */
export function keyToLatLng(cellId: string): [number, number] {
  const S2Cell = require('s2-geometry').S2.S2Cell
  const result = S2Cell.keyToLatLng(cellId)
  if (result && typeof result.lat === 'number' && typeof result.lng === 'number') {
    return [result.lat, result.lng]
  }
  return [0, 0]
}

/**
 * Get the parent cell key (one level up).
 */
export function parentKey(cellId: string): string {
  const parts = cellId.split('/')
  if (parts.length < 2) return cellId
  const parentParts = parts[1].slice(0, -3) // Remove last 3 bits (S2 uses 3 bits per level)
  if (parentParts.length === 0) return parts[0]
  return `${parts[0]}/${parentParts}`
}

/**
 * Extract the level from an S2 cell key.
 */
export function cellKeyLevel(cellId: string): number {
  const parts = cellId.split('/')
  if (parts.length < 2) return 0
  return Math.floor(parts[1].length / 3) // S2: 3 chars per level
}

/**
 * Approximate cell size (km) at a given S2 level.
 * S2 cells vary in size; this is a rough estimate.
 */
export function cellApproxSize(level: number): number {
  // Approximate cell width at each level (in km, at equator)
  // S2 has ~6e7 cells at level 30 covering 510M km²
  const sizes: Record<number, number> = {
    0: 10000,
    1: 5000,
    2: 2500,
    3: 1250,
    4: 625,
    5: 312,
    6: 156,
    7: 78,
    8: 39,
    9: 20,
    10: 10,
    11: 5,
    12: 2.5,
    13: 1.25,
    14: 0.625,
    15: 0.312,
    16: 0.156,
    17: 0.078,
    18: 0.039,
    19: 0.020,
    20: 0.010,
  }
  return sizes[level] ?? 0.001
}

// ──────────────────────────────────────────────
//  Utility functions
// ──────────────────────────────────────────────

/**
 * Convert degrees to radians.
 */
function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

/**
 * Approximate km-per-degree at a given latitude.
 */
function kmPerDegree(lat: number): { latKm: number; lngKm: number } {
  const latKm = 111.32
  const lngKm = 111.32 * Math.cos(toRad(lat))
  return { latKm, lngKm }
}

export { haversineKm }
