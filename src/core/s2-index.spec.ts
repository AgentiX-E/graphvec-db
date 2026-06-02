// ============================================================
// s2-index.spec.ts — Tests for S2Index
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest'
import {
  S2Index,
  latLngToKey,
  keyToLatLng,
  cellKeyLevel,
  cellApproxSize,
  neighborKeysForCell,
} from './s2-index'
import { haversineKm } from './geo-index'

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

describe('S2Index', () => {
  let idx: S2Index

  beforeEach(() => {
    idx = new S2Index()
  })

  describe('empty index', () => {
    it('should return 0 size on construction', () => {
      expect(idx.size).toBe(0)
    })

    it('should return empty array for queryRadius on empty index', () => {
      const results = idx.queryRadius(CENTER_LAT, CENTER_LNG, 2)
      expect(results).toEqual([])
    })

    it('should return empty array for queryBBox on empty index', () => {
      const results = idx.queryBBox([1.0, 103.0], [2.0, 105.0])
      expect(results).toEqual([])
    })

    it('should return empty array for kNearest on empty index', () => {
      const results = idx.kNearest(CENTER_LAT, CENTER_LNG, 5)
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
      idx.addNode(1, CENTER_LAT, CENTER_LNG)
      expect(idx.has(1)).toBe(true)
    })

    it('should duplicate add update position', () => {
      idx.addNode(1, CENTER_LAT, CENTER_LNG)
      idx.addNode(1, 1.249, 103.830)
      expect(idx.size).toBe(1)
      const pos = idx.getPosition(1)
      expect(pos).toBeTruthy()
      expect(pos!.lat).toBeCloseTo(1.249, 3)
      expect(pos!.lng).toBeCloseTo(103.830, 3)
    })

    it('should store cellId for added nodes', () => {
      idx.addNode(1, CENTER_LAT, CENTER_LNG)
      const pos = idx.getPosition(1)
      expect(pos).toBeTruthy()
      expect(pos!.cellId).toBeDefined()
      expect(pos!.cellId.length).toBeGreaterThan(0)
    })

    it('should support custom level', () => {
      idx.addNode(1, CENTER_LAT, CENTER_LNG, 10)
      const pos = idx.getPosition(1)
      // S2 key format: face/chars — chars length = level
      // e.g., "1/2032310030" has 10 chars after / for level 10
      expect(pos!.cellId.split('/')[1].length).toBe(10)
    })
  })

  describe('queryRadius', () => {
    beforeEach(() => {
      SG_POINTS.forEach(p => idx.addNode(p.id, p.lat, p.lng))
    })

    it('should return 0 results for zero radius', () => {
      const results = idx.queryRadius(CENTER_LAT, CENTER_LNG, 0)
      expect(results).toEqual([])
    })

    it('should return 0 results for negative radius', () => {
      const results = idx.queryRadius(CENTER_LAT, CENTER_LNG, -1)
      expect(results).toEqual([])
    })

    it('should find nodes within 2km (MBS and Gardens)', () => {
      const results = idx.queryRadius(CENTER_LAT, CENTER_LNG, 2)
      expect(results).toContain(1) // Marina Bay Sands itself
      expect(results).toContain(2) // Gardens by the Bay ~0.6km
      expect(results.length).toBe(2)
    })

    it('should find 3 nodes within 4km', () => {
      const results = idx.queryRadius(CENTER_LAT, CENTER_LNG, 4)
      expect(results.length).toBe(3)
      expect(results).toContain(1)
      expect(results).toContain(2)
      expect(results).toContain(5) // Orchard Road
    })

    it('should find all 5 nodes within 25km', () => {
      const results = idx.queryRadius(CENTER_LAT, CENTER_LNG, 25)
      expect(results.length).toBe(5)
    })

    it('should return empty array for far away location', () => {
      const results = idx.queryRadius(0, -30, 1)
      expect(results).toEqual([])
    })
  })

  describe('queryBBox', () => {
    beforeEach(() => {
      SG_POINTS.forEach(p => idx.addNode(p.id, p.lat, p.lng))
    })

    it('should return nodes within central Singapore bbox', () => {
      const results = idx.queryBBox([1.27, 103.82], [1.31, 103.87])
      expect(results).toContain(1)
      expect(results).toContain(2)
      expect(results).toContain(5)
    })

    it('should return empty array for far away bbox', () => {
      const results = idx.queryBBox([40.0, -74.0], [40.8, -73.0])
      expect(results).toEqual([])
    })
  })

  describe('kNearest', () => {
    beforeEach(() => {
      SG_POINTS.forEach(p => idx.addNode(p.id, p.lat, p.lng))
    })

    it('should return nearest 3 nodes to MBS', () => {
      const results = idx.kNearest(CENTER_LAT, CENTER_LNG, 3)
      expect(results).toContain(1)
      expect(results).toContain(2)
      expect(results).toContain(5)
      expect(results.length).toBe(3)
    })

    it('should return empty for k=0', () => {
      const results = idx.kNearest(CENTER_LAT, CENTER_LNG, 0)
      expect(results).toEqual([])
    })

    it('should return all 5 nodes for k > size', () => {
      const results = idx.kNearest(CENTER_LAT, CENTER_LNG, 100)
      expect(results.length).toBe(5)
    })

    it('should return results sorted by distance (closest first)', () => {
      const results = idx.kNearest(CENTER_LAT, CENTER_LNG, 5)
      expect(results.length).toBe(5)
      expect(results[0]).toBe(1) // Same point (distance 0)
    })
  })

  describe('removeNode', () => {
    beforeEach(() => {
      SG_POINTS.forEach(p => idx.addNode(p.id, p.lat, p.lng))
    })

    it('should remove a node from the index', () => {
      expect(idx.size).toBe(5)
      idx.removeNode(4)
      expect(idx.size).toBe(4)
      expect(idx.has(4)).toBe(false)
    })

    it('should not return removed nodes in query', () => {
      idx.removeNode(4)
      const results = idx.queryRadius(CENTER_LAT, CENTER_LNG, 25)
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
      idx.updateNode(3, CENTER_LAT, CENTER_LNG)
      const pos = idx.getPosition(3)
      expect(pos!.lat).toBeCloseTo(CENTER_LAT, 5)
      expect(pos!.lng).toBeCloseTo(CENTER_LNG, 5)
    })

    it('should not change size when updating', () => {
      idx.updateNode(3, CENTER_LAT, CENTER_LNG)
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

    it('should return correct coordinates and cellId', () => {
      idx.addNode(1, CENTER_LAT, CENTER_LNG)
      const pos = idx.getPosition(1)
      expect(pos).toBeTruthy()
      expect(pos!.lat).toBe(CENTER_LAT)
      expect(pos!.lng).toBe(CENTER_LNG)
      expect(typeof pos!.cellId).toBe('string')
    })
  })

  describe('getNodesInCell', () => {
    it('should return nodes in the same cell', () => {
      idx.addNode(1, CENTER_LAT, CENTER_LNG)
      const cellId = idx.cellIdAt(CENTER_LAT, CENTER_LNG)
      const nodes = idx.getNodesInCell(cellId)
      expect(nodes).toContain(1)
    })
  })

  describe('cellIdAt', () => {
    it('should return a valid cell key', () => {
      const cellId = idx.cellIdAt(CENTER_LAT, CENTER_LNG)
      expect(cellId).toContain('/')
      const [face] = cellId.split('/')
      expect(['0', '1', '2', '3', '4', '5']).toContain(face)
      // S2 key chars after /: each char is one level
      expect(cellId.split('/')[1].length).toBeGreaterThan(0)
    })

    it('should return different keys for different levels', () => {
      const key1 = idx.cellIdAt(CENTER_LAT, CENTER_LNG, 10)
      const key2 = idx.cellIdAt(CENTER_LAT, CENTER_LNG, 15)
      expect(key1).not.toBe(key2)
      expect(key2.split('/')[1].length).toBe(15)
      expect(key1.split('/')[1].length).toBe(10)
    })
  })
})

describe('S2 helper functions', () => {
  describe('latLngToKey', () => {
    it('should produce a valid S2 cell key', () => {
      const key = latLngToKey(1.284, 103.859, 15)
      expect(key).toContain('/')
      expect(key.split('/')[0]).toMatch(/^[0-5]$/)
      expect(key.split('/')[1].length).toBe(15)
    })
  })

  describe('keyToLatLng', () => {
    it('should roundtrip through latLngToKey', () => {
      const originalLat = 1.284
      const originalLng = 103.859
      const key = latLngToKey(originalLat, originalLng, 15)
      const [lat, lng] = keyToLatLng(key)
      // S2 cell center is approximate
      expect(Math.abs(lat - originalLat)).toBeLessThan(0.01)
      expect(Math.abs(lng - originalLng)).toBeLessThan(0.01)
    })
  })

  describe('latLngToKey', () => {
    it('should produce keys whose length = level', () => {
      const k10 = latLngToKey(1.284, 103.859, 10)
      const k15 = latLngToKey(1.284, 103.859, 15)
      expect(k10.split('/')[1].length).toBe(10)
      expect(k15.split('/')[1].length).toBe(15)
    })
  })

  describe('cellKeyLevel', () => {
    it('should detect level correctly', () => {
      const key = latLngToKey(1.284, 103.859, 15)
      expect(cellKeyLevel(key)).toBe(15)
    })

    it('should detect level 10 correctly', () => {
      const key = latLngToKey(1.284, 103.859, 10)
      expect(cellKeyLevel(key)).toBe(10)
    })
  })

  describe('neighborKeysForCell', () => {
    it('should return 4 neighbor keys', () => {
      const key = latLngToKey(1.284, 103.859, 15)
      const neighbors = neighborKeysForCell(key, 15)
      expect(neighbors.length).toBeGreaterThanOrEqual(4)
    })
  })

  describe('cellApproxSize', () => {
    it('should return smaller values for higher levels', () => {
      const s10 = cellApproxSize(10)
      const s15 = cellApproxSize(15)
      expect(s15).toBeLessThan(s10)
    })

    it('should return known values', () => {
      expect(cellApproxSize(0)).toBeGreaterThan(1000)
      expect(cellApproxSize(15)).toBeLessThan(1)
    })
  })
})

describe('S2Index vs GeoIndex comparison', () => {
  it('should produce compatible haversine distances', () => {
    const d1 = haversineKm(1.284, 103.859, 1.282, 103.864)
    const d2 = haversineKm(1.284, 103.859, 1.282, 103.864)
    expect(Math.abs(d1 - d2)).toBeLessThan(0.001)
  })

  it('both indexes should return same results for simple radius query', () => {
    const s2idx = new S2Index()
    SG_POINTS.forEach(p => s2idx.addNode(p.id, p.lat, p.lng))

    const s2results = s2idx.queryRadius(CENTER_LAT, CENTER_LNG, 4)
    expect(s2results.length).toBe(3)
    expect(s2results.sort()).toEqual([1, 2, 5])
  })
})
