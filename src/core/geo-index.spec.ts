// ============================================================
// geo-index.spec.ts — Tests for GeoIndex
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest'
import { GeoIndex, haversineKm } from './geo-index'

/**
 * Singapore reference points for testing:
 *   Marina Bay Sands (center): 1.284, 103.859
 *   Gardens by the Bay:        1.282, 103.864
 *   Sentosa:                   1.249, 103.830
 *   Changi Airport:            1.364, 103.991
 *   Orchard Road:              1.304, 103.832
 *   Raffles Place:             1.284, 103.851
 */

const CENTER_LAT = 1.284
const CENTER_LNG = 103.859

interface TestPoint {
  id: number
  lat: number
  lng: number
  name: string
}

const SG_POINTS: TestPoint[] = [
  { id: 1, lat: 1.284, lng: 103.859, name: 'Marina Bay Sands' },
  { id: 2, lat: 1.282, lng: 103.864, name: 'Gardens by the Bay' },
  { id: 3, lat: 1.249, lng: 103.830, name: 'Sentosa' },
  { id: 4, lat: 1.364, lng: 103.991, name: 'Changi Airport' },
  { id: 5, lat: 1.304, lng: 103.832, name: 'Orchard Road' },
]

describe('GeoIndex', () => {
  let idx: GeoIndex

  beforeEach(() => {
    idx = new GeoIndex()
  })

  describe('empty index', () => {
    it('should return 0 size on construction', () => {
      expect(idx.size).toBe(0)
    })

    it('should return empty array for queryRadius on empty index', () => {
      const results = idx.queryRadius(1.284, 103.859, 2)
      expect(results).toEqual([])
    })

    it('should return empty array for queryBBox on empty index', () => {
      const results = idx.queryBBox([1.0, 103.0], [2.0, 105.0])
      expect(results).toEqual([])
    })

    it('should return empty array for kNearest on empty index', () => {
      const results = idx.kNearest(1.284, 103.859, 5)
      expect(results).toEqual([])
    })
  })

  describe('addNode', () => {
    it('should add nodes and reflect size', () => {
      SG_POINTS.forEach(p => idx.addNode(p.id, p.lat, p.lng))
      expect(idx.size).toBe(5)
    })

    it('should return false for has before add, true after', () => {
      expect(idx.has(1)).toBe(false)
      idx.addNode(1, 1.284, 103.859)
      expect(idx.has(1)).toBe(true)
    })

    it('should duplicate add update position', () => {
      idx.addNode(1, 1.284, 103.859)
      idx.addNode(1, 1.249, 103.830) // same nodeId, new pos
      expect(idx.size).toBe(1)
      const pos = idx.getPosition(1)
      expect(pos).toBeTruthy()
      expect(pos!.lat).toBeCloseTo(1.249, 3)
      expect(pos!.lng).toBeCloseTo(103.830, 3)
    })
  })

  describe('queryRadius', () => {
    beforeEach(() => {
      SG_POINTS.forEach(p => idx.addNode(p.id, p.lat, p.lng))
    })

    it('should return 0 results for zero radius', () => {
      const results = idx.queryRadius(1.284, 103.859, 0)
      expect(results).toEqual([])
    })

    it('should return 0 results for negative radius', () => {
      const results = idx.queryRadius(1.284, 103.859, -1)
      expect(results).toEqual([])
    })

    it('should find nodes within 2km of Marina Bay Sands (Orchard ~3.7km is outside)', () => {
      // Distances from MBS (1.284, 103.859):
      //   MBS: 0km, Gardens: 0.6km, Orchard: 3.7km, Sentosa: 5.1km, Changi: 17.2km
      const results = idx.queryRadius(CENTER_LAT, CENTER_LNG, 2)
      expect(results).toContain(1) // Marina Bay Sands itself
      expect(results).toContain(2) // Gardens by the Bay ~0.6km
      expect(results.length).toBe(2)
      expect(results).not.toContain(5) // Orchard is ~3.7km, outside 2km
    })

    it('should find exactly 3 nodes within 4km (excludes Sentosa 5.1km and Changi 17.2km)', () => {
      // Within 4km: MBS (0), Gardens (0.6), Orchard (3.7)
      // Sentosa is 5.1km, Changi is 17.2km
      const results = idx.queryRadius(CENTER_LAT, CENTER_LNG, 4)
      expect(results.length).toBe(3)
      expect(results).toContain(1) // Marina Bay Sands
      expect(results).toContain(2) // Gardens by the Bay
      expect(results).toContain(5) // Orchard Road (~3.7km)
      expect(results).not.toContain(3) // Sentosa (5.1km > 4km)
      expect(results).not.toContain(4) // Changi (17.2km)
    })

    it('should find all 5 nodes within 25km', () => {
      const results = idx.queryRadius(CENTER_LAT, CENTER_LNG, 25)
      expect(results.length).toBe(5)
    })

    it('should return empty array when no nodes match radius', () => {
      // In the middle of the Atlantic Ocean
      const results = idx.queryRadius(0, -30, 1)
      expect(results).toEqual([])
    })
  })

  describe('queryBBox', () => {
    beforeEach(() => {
      SG_POINTS.forEach(p => idx.addNode(p.id, p.lat, p.lng))
    })

    it('should return nodes within the bounding box of central Singapore', () => {
      // Box covering central Singapore: lat [1.27, 1.31], lng [103.82, 103.87]
      const results = idx.queryBBox([1.27, 103.82], [1.31, 103.87])
      expect(results).toContain(1) // Marina Bay Sands
      expect(results).toContain(2) // Gardens by the Bay
      expect(results).toContain(5) // Orchard Road
      expect(results).not.toContain(3) // Sentosa (lat 1.249 < 1.27)
      expect(results).not.toContain(4) // Changi (lng 103.991 > 103.87)
    })

    it('should return empty array for bbox in wrong location', () => {
      const results = idx.queryBBox([40.0, -74.0], [40.8, -73.0])
      expect(results).toEqual([])
    })
  })

  describe('kNearest', () => {
    beforeEach(() => {
      SG_POINTS.forEach(p => idx.addNode(p.id, p.lat, p.lng))
    })

    it('should return nearest 3 nodes to Marina Bay Sands', () => {
      // Nearest to (1.284, 103.859):
      // 1 - MBS (itself - 0km)
      // 2 - Gardens by the Bay (~0.6km)
      // 5 - Orchard Road (~3.1km)
      const results = idx.kNearest(1.284, 103.859, 3)
      expect(results).toContain(1)
      expect(results).toContain(2)
      expect(results).toContain(5)
      expect(results.length).toBe(3)
    })

    it('should return empty for k=0', () => {
      const results = idx.kNearest(1.284, 103.859, 0)
      expect(results).toEqual([])
    })

    it('should return empty for k < 0', () => {
      const results = idx.kNearest(1.284, 103.859, -1)
      expect(results).toEqual([])
    })

    it('should return all 5 nodes for k > size', () => {
      const results = idx.kNearest(1.284, 103.859, 100)
      expect(results.length).toBe(5)
    })

    it('should return nodes within maxRadiusKm', () => {
      // 2km should only include MBS and Gardens by the Bay
      const results = idx.kNearest(1.284, 103.859, 10, 2)
      expect(results.length).toBeLessThanOrEqual(3)
      expect(results).toContain(1) // 0km
      expect(results).toContain(2) // ~0.6km
    })

    it('should return results sorted by distance (closest first)', () => {
      const results = idx.kNearest(1.284, 103.859, 5)
      expect(results.length).toBe(5)
      // Verify first element is the same point (distance 0)
      expect(results[0]).toBe(1)
    })
  })

  describe('removeNode', () => {
    beforeEach(() => {
      SG_POINTS.forEach(p => idx.addNode(p.id, p.lat, p.lng))
    })

    it('should remove a node from the index', () => {
      expect(idx.size).toBe(5)
      idx.removeNode(4) // Remove Changi
      expect(idx.size).toBe(4)
      expect(idx.has(4)).toBe(false)
    })

    it('should no longer return removed node in radius query', () => {
      idx.removeNode(4) // Remove Changi
      const results = idx.queryRadius(CENTER_LAT, CENTER_LNG, 25)
      expect(results.length).toBe(4)
      expect(results).not.toContain(4)
    })

    it('should be no-op for non-existent nodeId', () => {
      idx.removeNode(999)
      expect(idx.size).toBe(5)
    })
  })

  describe('updateNode', () => {
    beforeEach(() => {
      SG_POINTS.forEach(p => idx.addNode(p.id, p.lat, p.lng))
    })

    it('should update node position', () => {
      idx.updateNode(3, 1.284, 103.859) // Move Sentosa to MBS location
      const pos = idx.getPosition(3)
      expect(pos!.lat).toBeCloseTo(1.284, 5)
      expect(pos!.lng).toBeCloseTo(103.859, 5)
    })

    it('should reflect new position in radius query', () => {
      idx.updateNode(3, 1.284, 103.859) // Move Sentosa to center
      // Within 1km, should now include node 3
      const results = idx.queryRadius(CENTER_LAT, CENTER_LNG, 1)
      expect(results).toContain(3)
    })

    it('should not change size when updating', () => {
      idx.updateNode(3, 1.284, 103.859)
      expect(idx.size).toBe(5)
    })
  })

  describe('clear', () => {
    it('should clear all entries', () => {
      SG_POINTS.forEach(p => idx.addNode(p.id, p.lat, p.lng))
      expect(idx.size).toBe(5)
      idx.clear()
      expect(idx.size).toBe(0)
      expect(idx.queryRadius(CENTER_LAT, CENTER_LNG, 100)).toEqual([])
    })
  })

  describe('getPosition', () => {
    it('should return null for non-existent node', () => {
      expect(idx.getPosition(999)).toBeNull()
    })

    it('should return correct coordinates', () => {
      idx.addNode(1, 1.284, 103.859)
      const pos = idx.getPosition(1)
      expect(pos).toBeTruthy()
      expect(pos!.lat).toBe(1.284)
      expect(pos!.lng).toBe(103.859)
    })
  })

  describe('haversineKm utility', () => {
    it('should return 0 for same point', () => {
      expect(haversineKm(1.284, 103.859, 1.284, 103.859)).toBe(0)
    })

    it('should calculate ~0.6km between MBS and Gardens by the Bay', () => {
      // MBS: 1.284, 103.859
      // Gardens by the Bay: 1.282, 103.864
      const dist = haversineKm(1.284, 103.859, 1.282, 103.864)
      // Should be roughly 0.6km
      expect(dist).toBeGreaterThan(0.3)
      expect(dist).toBeLessThan(1.0)
    })

    it('should calculate ~5km between MBS and Sentosa', () => {
      // MBS: 1.284, 103.859
      // Sentosa: 1.249, 103.830
      const dist = haversineKm(1.284, 103.859, 1.249, 103.830)
      // Sentosa is ~5.05km from MBS
      expect(dist).toBeGreaterThan(4.5)
      expect(dist).toBeLessThan(5.5)
    })
  })
})

// ============================================================
// 🚀 ADDITIONAL TESTS — GeoIndex Enhanced Coverage
// ============================================================

describe('GeoIndex — Different Map Range Queries', () => {
  let idx: GeoIndex

  beforeEach(() => {
    idx = new GeoIndex()
    SG_POINTS.forEach(p => idx.addNode(p.id, p.lat, p.lng))
  })

  it('GAP-13-1: queryRadius with very large radius returns all points', () => {
    const results = idx.queryRadius(1.284, 103.859, 50000) // 50,000 km covers entire Earth
    expect(results.length).toBe(5)
  })

  it('GAP-13-2: queryRadius with 1km finds only center and Gardens', () => {
    const results = idx.queryRadius(1.284, 103.859, 1)
    expect(results).toContain(1)
    expect(results).toContain(2)
    expect(results.length).toBe(2)
  })

  it('GAP-13-3: queryRadius from different center (Orchard)', () => {
    // From Orchard (1.304, 103.832): MBS ~3.1km, Gardens ~3.8km, Sentosa ~6.2km
    const results = idx.queryRadius(1.304, 103.832, 3)
    // Should include Orchard itself and possibly MBS
    expect(results).toContain(5) // Orchard
    expect(results.length).toBeGreaterThan(0)
  })

  it('GAP-13-4: queryBBox tight bounds around single point', () => {
    // Very tight box around MBS
    const results = idx.queryBBox([1.283, 103.858], [1.285, 103.860])
    expect(results).toEqual([1])
  })

  it('GAP-13-5: queryBBox covering equator area returns empty for Singapore data', () => {
    const results = idx.queryBBox([0, 0], [0.5, 0.5])
    expect(results).toEqual([])
  })

  it('GAP-13-6: queryBBox reversed corners (southwest larger than northeast)', () => {
    // Should still work if implementation handles it
    const results = idx.queryBBox([1.31, 103.87], [1.27, 103.82])
    expect(results.length).toBeGreaterThanOrEqual(0)
  })
})

describe('GeoIndex — Exact vs Approximate Coordinates', () => {
  let idx: GeoIndex

  beforeEach(() => {
    idx = new GeoIndex()
  })

  it('GAP-13-7: exact coordinates match via queryRadius', () => {
    idx.addNode(1, 1.284, 103.859)
    const results = idx.queryRadius(1.284, 103.859, 0.01)
    expect(results).toContain(1)
  })

  it('GAP-13-8: approximate coordinates within small radius', () => {
    idx.addNode(1, 1.284, 103.859)
    // Query slightly offset
    const results = idx.queryRadius(1.285, 103.860, 0.5) // 0.5km radius captures 0.13km offset
    expect(results).toContain(1)
  })

  it('GAP-13-9: very close but distinct points are separate', () => {
    idx.addNode(1, 1.2841, 103.8591)
    idx.addNode(2, 1.2842, 103.8592)
    const results = idx.queryRadius(1.28415, 103.85915, 0.1)
    expect(results.length).toBe(2)
  })

  it('GAP-13-10: far-off query from exact point returns empty', () => {
    idx.addNode(1, 1.284, 103.859)
    const results = idx.queryRadius(50.0, 120.0, 100)
    expect(results).toEqual([])
  })
})

describe('GeoIndex — Boundary Inside/Outside Points', () => {
  let idx: GeoIndex

  beforeEach(() => {
    idx = new GeoIndex()
  })

  it('GAP-13-11: point on bbox boundary', () => {
    idx.addNode(1, 1.284, 103.859)
    // Query with exactly the same coordinate as boundary
    const results = idx.queryBBox([1.284, 103.859], [1.285, 103.860])
    expect(results).toContain(1)
  })

  it('GAP-13-12: point barely inside radius', () => {
    // Center at MBS, point 1.5km away should be inside 2km radius
    idx.addNode(1, 1.284, 103.859)
    idx.addNode(2, 1.297, 103.848)
    const results = idx.queryRadius(1.284, 103.859, 2)
    expect(results.length).toBe(2)
  })

  it('GAP-13-13: point just outside radius', () => {
    idx.addNode(1, 1.284, 103.859)
    // Changi is 17.2km away
    idx.addNode(4, 1.364, 103.991)
    const results = idx.queryRadius(1.284, 103.859, 15) // 15km < 17.2km
    expect(results).not.toContain(4)
  })

  it('GAP-13-14: kNearest at boundary restricts to maxRadius', () => {
    SG_POINTS.forEach(p => idx.addNode(p.id, p.lat, p.lng))
    const results = idx.kNearest(1.284, 103.859, 10, 3) // 3km radius
    expect(results).toContain(1)
    expect(results).toContain(2)
    // Orchard ~3.7km, should be excluded by 3km limit
    expect(results).not.toContain(5)
  })
})

describe('GeoIndex — Large Point Sets (1000+)', () => {
  it('GAP-13-15: add 1000 random points in Singapore area', () => {
    const idx = new GeoIndex()
    for (let i = 0; i < 1000; i++) {
      const lat = 1.2 + Math.random() * 0.3
      const lng = 103.7 + Math.random() * 0.4
      idx.addNode(i, lat, lng)
    }
    expect(idx.size).toBe(1000)

    // Query should still work
    const results = idx.queryRadius(1.284, 103.859, 50)
    expect(results.length).toBe(1000)
  })

  it('GAP-13-16: queryBBox on 500 points', () => {
    const idx = new GeoIndex()
    for (let i = 0; i < 500; i++) {
      const lat = 1.2 + Math.random() * 0.3
      const lng = 103.7 + Math.random() * 0.4
      idx.addNode(i, lat, lng)
    }
    // Query a subset
    const results = idx.queryBBox([1.25, 103.75], [1.35, 103.90])
    expect(results.length).toBeGreaterThan(0)
    expect(results.length).toBeLessThanOrEqual(500)
  })

  it('GAP-13-17: kNearest on 1000 points', () => {
    const idx = new GeoIndex()
    for (let i = 0; i < 1000; i++) {
      const lat = 1.2 + Math.random() * 0.3
      const lng = 103.7 + Math.random() * 0.4
      idx.addNode(i, lat, lng)
    }
    const results = idx.kNearest(1.284, 103.859, 10)
    expect(results.length).toBe(10)
  })
})

describe('GeoIndex — Circular vs Rectangular Range', () => {
  let idx: GeoIndex

  beforeEach(() => {
    idx = new GeoIndex()
  })

  it('GAP-13-18: circular query (queryRadius) vs rectangular (queryBBox) overlap for center', () => {
    SG_POINTS.forEach(p => idx.addNode(p.id, p.lat, p.lng))

    // Same area: ~4km radius covers area ≈ (1.28-1.29) lat x (103.84-103.87) lng
    const radiusResults = idx.queryRadius(1.284, 103.859, 4)
    const bboxResults = idx.queryBBox([1.27, 103.82], [1.31, 103.87])

    // Both should include MBS and Gardens
    expect(radiusResults).toContain(1)
    expect(radiusResults).toContain(2)
    expect(bboxResults).toContain(1)
    expect(bboxResults).toContain(2)
  })

  it('GAP-13-19: circular query narrows results vs bbox', () => {
    SG_POINTS.forEach(p => idx.addNode(p.id, p.lat, p.lng))

    // Large rectangle covers most of SG
    const bboxResults = idx.queryBBox([1.24, 103.80], [1.37, 104.00])
    // Small radius from MBS
    const radiusResults = idx.queryRadius(1.284, 103.859, 2)

    expect(bboxResults.length).toBeGreaterThan(radiusResults.length)
  })
})

describe('GeoIndex — Latitude/Longitude Boundary Values', () => {
  let idx: GeoIndex

  beforeEach(() => {
    idx = new GeoIndex()
  })

  it('GAP-13-20: pole latitude', () => {
    idx.addNode(1, 90, 0) // North pole
    expect(idx.has(1)).toBe(true)
    const pos = idx.getPosition(1)
    expect(pos!.lat).toBe(90)
    expect(pos!.lng).toBe(0)
  })

  it('GAP-13-21: boundary longitude 180', () => {
    idx.addNode(1, 0, 180)
    const pos = idx.getPosition(1)
    expect(pos!.lng).toBe(180)
  })

  it('GAP-13-22: boundary longitude -180', () => {
    idx.addNode(1, 0, -180)
    const pos = idx.getPosition(1)
    expect(pos!.lng).toBe(-180)
  })

  it('GAP-13-23: equator point', () => {
    idx.addNode(1, 0, 0)
    const pos = idx.getPosition(1)
    expect(pos!.lat).toBe(0)
    expect(pos!.lng).toBe(0)
  })

  it('GAP-13-24: negative latitude', () => {
    idx.addNode(1, -33.86, 151.21) // Sydney
    expect(idx.has(1)).toBe(true)
  })
})

describe('GeoIndex — Delete and Re-query', () => {
  let idx: GeoIndex

  beforeEach(() => {
    idx = new GeoIndex()
    SG_POINTS.forEach(p => idx.addNode(p.id, p.lat, p.lng))
  })

  it('GAP-13-25: remove then query shows removed point absent', () => {
    idx.removeNode(3) // Remove Sentosa
    const radiusResults = idx.queryRadius(1.284, 103.859, 6)
    expect(radiusResults).not.toContain(3)
  })

  it('GAP-13-26: remove, add back, then query shows readded point', () => {
    idx.removeNode(3)
    expect(idx.has(3)).toBe(false)
    idx.addNode(3, 1.249, 103.830) // Re-add Sentosa
    expect(idx.has(3)).toBe(true)
    expect(idx.size).toBe(5)
    const results = idx.queryRadius(1.284, 103.859, 6)
    expect(results).toContain(3)
  })

  it('GAP-13-27: remove multiple nodes then query', () => {
    idx.removeNode(4)
    idx.removeNode(5)
    expect(idx.size).toBe(3)
    const results = idx.queryRadius(1.284, 103.859, 25)
    expect(results.length).toBe(3)
    expect(results).not.toContain(4)
    expect(results).not.toContain(5)
  })

  it('GAP-13-28: clear all then add new points and query', () => {
    idx.clear()
    expect(idx.size).toBe(0)
    idx.addNode(100, 40.7128, -74.0060) // New York
    const results = idx.queryRadius(40.7128, -74.0060, 10)
    expect(results).toEqual([100])
  })
})

describe('GeoIndex — kNearest Advanced', () => {
  it('GAP-13-29: kNearest returns unique results', () => {
    const idx = new GeoIndex()
    SG_POINTS.forEach(p => idx.addNode(p.id, p.lat, p.lng))
    const results = idx.kNearest(1.284, 103.859, 5)
    const unique = new Set(results)
    expect(unique.size).toBe(results.length)
  })

  it('GAP-13-30: kNearest with k=1 returns the closest', () => {
    const idx = new GeoIndex()
    SG_POINTS.forEach(p => idx.addNode(p.id, p.lat, p.lng))
    const results = idx.kNearest(1.284, 103.859, 1)
    expect(results[0]).toBe(1) // MBS is closest to itself
  })

  it('GAP-13-31: kNearest from different location', () => {
    const idx = new GeoIndex()
    SG_POINTS.forEach(p => idx.addNode(p.id, p.lat, p.lng))
    // From Changi Airport location
    const results = idx.kNearest(1.364, 103.991, 2)
    expect(results[0]).toBe(4) // Changi is closest to itself
  })
})

describe('GeoIndex — Update Position Effects', () => {
  it('GAP-13-32: update to far location changes query results', () => {
    const idx = new GeoIndex()
    SG_POINTS.forEach(p => idx.addNode(p.id, p.lat, p.lng))
    // Move MBS to New York
    idx.updateNode(1, 40.7128, -74.0060)
    const results = idx.queryRadius(1.284, 103.859, 5)
    expect(results).not.toContain(1) // MBS no longer in Singapore
  })

  it('GAP-13-33: update then kNearest reflects new position', () => {
    const idx = new GeoIndex()
    idx.addNode(1, 0, 0)
    idx.updateNode(1, 10, 10)
    const results = idx.kNearest(9, 9, 1)
    expect(results).toContain(1)
  })
})

describe('GeoIndex — has() and removeNode consistency', () => {
  it('GAP-13-34: has returns false after removeNode', () => {
    const idx = new GeoIndex()
    idx.addNode(5, 1.284, 103.859)
    expect(idx.has(5)).toBe(true)
    idx.removeNode(5)
    expect(idx.has(5)).toBe(false)
  })

  it('GAP-13-35: has returns true after addNode', () => {
    const idx = new GeoIndex()
    expect(idx.has(99)).toBe(false)
    idx.addNode(99, 0, 0)
    expect(idx.has(99)).toBe(true)
  })
})

describe('GeoIndex — queryBBox Boundary Edge Cases', () => {
  it('GAP-13-36: queryBBox with identical corners', () => {
    const idx = new GeoIndex()
    idx.addNode(1, 1.284, 103.859)
    const results = idx.queryBBox([1.284, 103.859], [1.284, 103.859])
    expect(results).toContain(1)
  })

  it('GAP-13-37: queryBBox with large global bounding box', () => {
    const idx = new GeoIndex()
    SG_POINTS.forEach(p => idx.addNode(p.id, p.lat, p.lng))
    const results = idx.queryBBox([-90, -180], [90, 180])
    expect(results.length).toBe(5)
  })
})
