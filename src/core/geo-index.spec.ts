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
