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

  constructor(options?: S2IndexOptions) {
    this._defaultLevel = options?.defaultLevel ?? 15
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
   */
  cellIdAt(lat: number, lng: number, level?: number): string {
    return latLngToKey(lat, lng, level ?? this._defaultLevel)
  }

  /**
   * Get the parent cell key for a given cell.
   */
  parentCell(cellId: string): string {
    const parts = cellId.split('/')
    if (parts.length < 2 || parts[1].length <= 1) return parts[0]
    return `${parts[0]}/${parts[1].slice(0, -1)}`
  }

  /**
   * Query all nodes within a given radius (km) from a center point.
   * Uses S2 cells for initial filtering and Haversine for accuracy.
   */
  queryRadius(lat: number, lng: number, radiusKm: number): number[] {
    if (radiusKm <= 0) return []

    // Compute all cells to search: start with the center's cell, expand to neighbors
    const searchLevel = this._radiusToLevel(radiusKm)
    const centerCell = latLngToKey(lat, lng, searchLevel)

    // Collect candidate node IDs from target cells
    const candidateIds = new Set<number>()

    // 1. Search the center cell itself
    this._collectMatching(centerCell, candidateIds)

    // 2. Search 1-ring neighbors
    const oneRing = neighborKeysForCell(centerCell, searchLevel)
    for (const nk of oneRing) {
      this._collectMatching(nk, candidateIds)
    }

    // 3. Search 2-ring neighbors for broader coverage
    for (const nk of oneRing) {
      const twoRing = neighborKeysForCell(nk, searchLevel)
      for (const tk of twoRing) {
        if (tk !== centerCell) {
          this._collectMatching(tk, candidateIds)
        }
      }
    }

    // Post-filter with Haversine for accuracy
    const results: number[] = []
    for (const nodeId of candidateIds) {
      const item = this._items.get(nodeId)
      if (!item) continue
      const dist = haversineKm(lat, lng, item.lat, item.lng)
      if (dist <= radiusKm) {
        results.push(nodeId)
      }
    }

    return results
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
    const centerLat = (minLat + maxLat) / 2
    const centerLng = (minLng + maxLng) / 2

    // Approximate radius covering the bbox
    const diagKm = haversineKm(minLat, minLng, maxLat, maxLng)
    const radiusKm = diagKm / 2 + 0.1 // add buffer

    const searchLevel = this._radiusToLevel(radiusKm)

    const candidateIds = new Set<number>()
    const centerCell = latLngToKey(centerLat, centerLng, searchLevel)
    this._collectMatching(centerCell, candidateIds)

    // Include neighbors
    const nk = neighborKeysForCell(centerCell, searchLevel)
    for (const k of nk) this._collectMatching(k, candidateIds)

    // Post-filter by bbox
    const results: number[] = []
    for (const nodeId of candidateIds) {
      const item = this._items.get(nodeId)
      if (!item) continue
      if (
        item.lat >= minLat &&
        item.lat <= maxLat &&
        item.lng >= minLng &&
        item.lng <= maxLng
      ) {
        results.push(nodeId)
      }
    }

    return results
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

    const searchRadius = maxRadiusKm ?? this._estimateRadius(k)

    // Collect all nodes within search radius, expanding if necessary
    let candidates = this._collectCandidatesForRadius(lat, lng, searchRadius)

    if (maxRadiusKm && maxRadiusKm > 0) {
      candidates = candidates.filter(nodeId => {
        const item = this._items.get(nodeId)!
        return haversineKm(lat, lng, item.lat, item.lng) <= maxRadiusKm!
      })
    }

    // If not enough candidates, try a broader search
    if (candidates.length < k && (!maxRadiusKm || maxRadiusKm <= 0)) {
      const larger = this._collectCandidatesForRadius(lat, lng, searchRadius * 5)
      for (const id of larger) {
        if (!candidates.includes(id)) candidates.push(id)
      }
    }

    // If still not enough, use all nodes
    if (candidates.length < k) {
      for (const nodeId of this._items.keys()) {
        if (!candidates.includes(nodeId)) candidates.push(nodeId)
      }
    }

    // Sort by Haversine distance
    return candidates
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
   * Collect matching node IDs: exact cell match + any child cells.
   * S2 key format: "face/bits" where each char = 1 level (e.g., "1/203231003020023" for level 15).
   * Children of cell "1/2032" would be keys like "1/20323", "1/203232", etc.
   */
  private _collectMatching(cellId: string, out: Set<number>): void {
    // Exact match
    const direct = this._cellIndex.get(cellId)
    if (direct) {
      for (const id of direct) out.add(id)
    }

    // Child cells: same face + bits that start with our bits AND are longer
    const [face, bits] = cellId.split('/')
    if (!bits) {
      // Whole face — just check face prefix
      for (const [key, nodes] of this._cellIndex.entries()) {
        if (key.startsWith(face + '/')) {
          for (const id of nodes) out.add(id)
        }
      }
      return
    }

    // S2 key format: "face/bits" where bits length indicates level.
    // Children have the same face and bits starting with parent's bits, but longer.
    // E.g., parent "1/2032" (level 4) -> child "1/20323" (level 5)
    const prefix = `${face}/${bits}`
    for (const [key, nodes] of this._cellIndex.entries()) {
      if (key.startsWith(prefix) && key.length > prefix.length) {
        for (const id of nodes) out.add(id)
      }
    }
  }

  /**
   * Collect candidates within a given radius for kNearest.
   * Returns nodeIds (unsorted).
   */
  private _collectCandidatesForRadius(lat: number, lng: number, radiusKm: number): number[] {
    const searchLevel = this._radiusToLevel(radiusKm)
    const centerCell = latLngToKey(lat, lng, searchLevel)

    const ids = new Set<number>()
    this._collectMatching(centerCell, ids)

    const nk = neighborKeysForCell(centerCell, searchLevel)
    for (const k of nk) this._collectMatching(k, ids)

    if (radiusKm > 1) {
      const parentCell = this.parentCell(centerCell)
      this._collectMatching(parentCell, ids)
      const pnk = neighborKeysForCell(parentCell, searchLevel - 1)
      for (const k of pnk) this._collectMatching(k, ids)
    }

    return [...ids]
  }

  /**
   * Convert a radius to an appropriate S2 cell level.
   * Uses coarser levels so the search cell (center + 1-ring neighbors)
   * covers the radius. The 1-ring spans roughly ~3 cell widths.
   */
  private _radiusToLevel(radiusKm: number): number {
    if (radiusKm <= 0.01) return 20   // cell ~0.010km
    if (radiusKm <= 0.05) return 18   // cell ~0.039km
    if (radiusKm <= 0.2) return 16    // cell ~0.156km
    if (radiusKm <= 0.5) return 15    // cell ~0.312km
    if (radiusKm <= 1.5) return 14    // cell ~0.625km, * 3 = 1.9km
    if (radiusKm <= 5) return 12      // cell ~2.5km, * 3 = 7.5km
    if (radiusKm <= 20) return 10     // cell ~10km, * 3 = 30km
    if (radiusKm <= 100) return 8     // cell ~39km, * 3 = 117km
    return 6                          // cell ~156km, * 3 = 468km
  }

  /**
   * Estimate a search radius that would contain at least k items.
   */
  private _estimateRadius(k: number): number {
    if (this._items.size === 0) return 1
    const density = this._items.size / 510.1
    if (density === 0) return 1
    const areaPerK = k / density
    const radius = Math.sqrt(areaPerK / Math.PI)
    return Math.max(radius, 0.1)
  }
}

// ──────────────────────────────────────────────
//  Standalone S2 helper functions
// ──────────────────────────────────────────────

/**
 * Convert lat/lng to S2 cell key (Hilbert quadkey) at given level.
 */
export function latLngToKey(lat: number, lng: number, level: number): string {
// eslint-disable-next-line @typescript-eslint/no-var-requires -- native/CJS module loaded lazily
  const S2Cell = require('s2-geometry').S2.S2Cell
  return S2Cell.latLngToKey(lat, lng, level)
}

/**
 * Convert S2 cell key to lat/lng (center of cell).
 */
export function keyToLatLng(cellId: string): [number, number] {
// eslint-disable-next-line @typescript-eslint/no-var-requires -- native/CJS module loaded lazily
  const S2Cell = require('s2-geometry').S2.S2Cell
  const result = S2Cell.keyToLatLng(cellId)
  if (result && typeof result.lat === 'number' && typeof result.lng === 'number') {
    return [result.lat, result.lng]
  }
  return [0, 0]
}

/**
 * Extract the level from an S2 cell key.
 * Since each char = 1 level, level = number of chars after '/'.
 */
export function cellKeyLevel(cellId: string): number {
  const parts = cellId.split('/')
  if (parts.length < 2) return 0
  return parts[1].length
}

/**
 * Get neighbor cell keys for a given cell at its level.
 * Uses S2Cell.getNeighbors() for true cell adjacency.
 */
export function neighborKeysForCell(cellId: string, level: number): string[] {
// eslint-disable-next-line @typescript-eslint/no-var-requires -- native/CJS module loaded lazily
  const S2Cell = require('s2-geometry').S2.S2Cell
  try {
    const [lat, lng] = keyToLatLng(cellId)
    const cell = S2Cell.FromLatLng({ lat, lng }, level > 0 ? level : 1)
    return cell.getNeighbors().map((n: any) => n.toHilbertQuadkey())
  } catch {
    return []
  }
}

/**
 * Approximate cell size (km) at a given S2 level.
 */
export function cellApproxSize(level: number): number {
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

export { haversineKm }
