// ============================================================
// GeoIndex — R-tree based geospatial index using rbush
//
// Uses rbush (pure JS R-tree) for spatial queries.
// Coordinates are stored in the rbush tree as bounding boxes
// (minX, minY, maxX, maxY). For point data, min==max.
// ============================================================

import RBush from 'rbush'

/** Internal rbush item with node ID and bounding box */
export interface GeoItem {
  minX: number  // longitude
  minY: number  // latitude
  maxX: number  // longitude
  maxY: number  // latitude
  nodeId: number
}

/** Earth radius in kilometers */
const EARTH_RADIUS_KM = 6371

/**
 * Convert degrees to radians
 */
function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

/**
 * Compute distance (km) between two lat/lng points using the
 * Haversine formula.
 */
export function haversineKm(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return EARTH_RADIUS_KM * c
}

/**
 * Approximate km-per-degree at a given latitude.
 * Used for computing bounding box extents from radius queries.
 */
function kmPerDegree(lat: number): { latKm: number; lngKm: number } {
  const latKm = 111.32 // ~ constant
  const lngKm = 111.32 * Math.cos(toRad(lat))
  return { latKm, lngKm }
}

/**
 * GeoIndex — R-tree backed geospatial index.
 *
 * Thread-safe for single-threaded Node.js usage.
 * Wraps rbush for fast spatial queries on graph nodes.
 */
export class GeoIndex {
  private _tree: RBush<GeoItem>
  /** nodeId → GeoItem lookup for O(1) removal/update */
  private _map: Map<number, GeoItem> = new Map()

  constructor() {
    this._tree = new RBush<GeoItem>(9) // default maxEntries=9
  }

  /**
   * Return the total number of indexed nodes.
   */
  get size(): number {
    return this._map.size
  }

  /**
   * Check whether a nodeId is currently indexed.
   */
  has(nodeId: number): boolean {
    return this._map.has(nodeId)
  }

  /**
   * Add a node to the geo index.
   * Overwrites existing entry for the same nodeId.
   */
  addNode(nodeId: number, lat: number, lng: number): void {
    // Remove existing if present (upsert semantics)
    if (this._map.has(nodeId)) {
      this.removeNode(nodeId)
    }

    const item: GeoItem = {
      minX: lng,
      minY: lat,
      maxX: lng,
      maxY: lat,
      nodeId,
    }
    this._tree.insert(item)
    this._map.set(nodeId, item)
  }

  /**
   * Remove a node from the geo index.
   * No-op if nodeId is not indexed.
   */
  removeNode(nodeId: number): void {
    const item = this._map.get(nodeId)
    if (!item) return
    this._tree.remove(item)
    this._map.delete(nodeId)
  }

  /**
   * Update the position of an already-indexed node.
   * Equivalent to removeNode + addNode.
   */
  updateNode(nodeId: number, lat: number, lng: number): void {
    this.removeNode(nodeId)
    this.addNode(nodeId, lat, lng)
  }

  /**
   * Query all nodes within a given radius (km) from a center point.
   * Uses the Haversine formula for accurate distance filtering.
   */
  queryRadius(lat: number, lng: number, radiusKm: number): number[] {
    if (radiusKm <= 0) return []

    // Compute bounding box for the radius
    const { latKm, lngKm } = kmPerDegree(lat)
    const dLat = radiusKm / latKm
    const dLng = radiusKm / lngKm

    const minLat = lat - dLat
    const maxLat = lat + dLat
    const minLng = lng - dLng
    const maxLng = lng + dLng

    const candidates = this._tree.search({
      minX: minLng,
      minY: minLat,
      maxX: maxLng,
      maxY: maxLat,
    })

    // Post-filter with Haversine for accuracy
    return candidates
      .filter(item => {
        const dist = haversineKm(lat, lng, item.minY, item.minX)
        return dist <= radiusKm
      })
      .map(item => item.nodeId)
  }

  /**
   * Query all nodes within a given bounding box.
   * Box coordinates: southWest = [minLat, minLng], northEast = [maxLat, maxLng]
   */
  queryBBox(
    southWest: [number, number],
    northEast: [number, number],
  ): number[] {
    const [minLat, minLng] = southWest
    const [maxLat, maxLng] = northEast

    const candidates = this._tree.search({
      minX: minLng,
      minY: minLat,
      maxX: maxLng,
      maxY: maxLat,
    })

    return candidates.map(item => item.nodeId)
  }

  /**
   * Find the k nearest neighbors from a given point.
   * Optionally limited to a max radius for performance.
   *
   * Uses a naive distance-scan over all indexed points.
   * For large datasets, consider k-d tree or incremental NN search.
   */
  kNearest(
    lat: number, lng: number,
    k: number,
    maxRadiusKm?: number,
  ): number[] {
    if (k <= 0 || this._map.size === 0) return []

    // If maxRadiusKm provided, first filter by bounding box to reduce candidates
    let candidates: GeoItem[]
    if (maxRadiusKm && maxRadiusKm > 0) {
      const { latKm, lngKm } = kmPerDegree(lat)
      const dLat = maxRadiusKm / latKm
      const dLng = maxRadiusKm / lngKm
      candidates = this._tree.search({
        minX: lng - dLng,
        minY: lat - dLat,
        maxX: lng + dLng,
        maxY: lat + dLat,
      })
      // Post-filter with Haversine
      candidates = candidates.filter(item => {
        const dist = haversineKm(lat, lng, item.minY, item.minX)
        return dist <= maxRadiusKm!
      })
    } else {
      candidates = Array.from(this._map.values())
    }

    // Sort by Haversine distance and take top k
    return candidates
      .map(item => ({
        nodeId: item.nodeId,
        dist: haversineKm(lat, lng, item.minY, item.minX),
      }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, k)
      .map(item => item.nodeId)
  }

  /**
   * Clear all entries from the index.
   */
  clear(): void {
    this._tree.clear()
    this._map.clear()
  }

  /**
   * Get the stored coordinate for a nodeId (if indexed).
   */
  getPosition(nodeId: number): { lat: number; lng: number } | null {
    const item = this._map.get(nodeId)
    if (!item) return null
    return { lat: item.minY, lng: item.minX }
  }
}
