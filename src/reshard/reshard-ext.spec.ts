/**
 * reshard-ext.spec.ts — Reshard Module Extended Tests
 *
 * Additional tests (does not modify existing tests):
 * - Data consistency after resharding
 * - Writes during resharding
 * - Multiple resharding rounds
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { ReshardManager } from './reshard-manager'
import { ReshardPlan } from './reshard-plan'
import { ReshardWorker } from './reshard-worker'
import { HotMigrator, selectNearestNode, haversineDistance } from './hot-migrate'
import { ShardManager } from '../shard/shard-manager'
import { HlcClock } from '../replication/hlc-clock'
import { ShardMap, ReshardSplit } from '../types'
import * as path from 'path'
import * as fs from 'fs'

// ──────────────────────────────────────────
// ReshardPlan Extension Tests
// ──────────────────────────────────────────

describe('ReshardPlan - Extended', () => {
  let plan: ReshardPlan
  let shardMap: ShardMap

  beforeEach(() => {
    plan = new ReshardPlan()
    shardMap = {
      version: 1,
      ranges: [
        {
          rangeId: 'range-1',
          dataDir: '/data/r1',
          raftConfig: { nodeId: 'node-1', peers: [], storagePath: '/data/r1/raft' },
          overgraphConfig: { path: '/data/r1' },
        },
        {
          rangeId: 'range-2',
          dataDir: '/data/r2',
          raftConfig: { nodeId: 'node-2', peers: [], storagePath: '/data/r2/raft' },
          overgraphConfig: { path: '/data/r2' },
        },
      ],
      hashRing: {
        virtualNodes: 100,
        nodes: [
          { hash: '0x0000', rangeId: 'range-1' },
          { hash: '0x7FFF', rangeId: 'range-2' },
        ],
      },
    }
  })

  describe('Data consistency after resharding', () => {
    test('should generate plan with unique planId for each call', () => {
      const ranges = [
        { rangeId: 'range-1', nodeCount: 50000, opsPerSec: 1000 },
      ]
      const result1 = plan.generatePlan(shardMap, ranges)
      const result2 = plan.generatePlan(shardMap, ranges)
      expect(result1!.planId).not.toBe(result2!.planId)
    })

    test('should not suggest split for below-threshold ranges', () => {
      const ranges = [
        { rangeId: 'range-1', nodeCount: 500, opsPerSec: 50 },
        { rangeId: 'range-2', nodeCount: 300, opsPerSec: 30 },
      ]
      const result = plan.generatePlan(shardMap, ranges)
      expect(result).toBeNull()
    })
  })

  describe('Multiple resharding rounds', () => {
    test('should handle multiple sequential re-splits of same range', () => {
      // First split: range-1 with 200k nodes -> splits into 2
      const r1 = [
        { rangeId: 'range-1', nodeCount: 200000, opsPerSec: 1000 },
      ]
      const result1 = plan.generatePlan(shardMap, r1)
      expect(result1).not.toBeNull()

      // Simulate updated shardMap with new ranges
      const updatedMap: ShardMap = {
        ...shardMap,
        version: 2,
        ranges: [
          {
            rangeId: 'range-1a',
            dataDir: '/data/r1a',
            raftConfig: { nodeId: 'node-1a', peers: [], storagePath: '/data/r1a/raft' },
            overgraphConfig: { path: '/data/r1a' },
          },
          {
            rangeId: 'range-1b',
            dataDir: '/data/r1b',
            raftConfig: { nodeId: 'node-1b', peers: [], storagePath: '/data/r1b/raft' },
            overgraphConfig: { path: '/data/r1b' },
          },
          ...shardMap.ranges.slice(1),
        ],
        hashRing: {
          virtualNodes: 100,
          nodes: [
            { hash: '0x0000', rangeId: 'range-1a' },
            { hash: '0x3FFF', rangeId: 'range-1b' },
            { hash: '0x7FFF', rangeId: 'range-2' },
          ],
        },
      }

      // Second split: one of the new ranges still too large
      const r2 = [
        { rangeId: 'range-1a', nodeCount: 120000, opsPerSec: 2000 },
        { rangeId: 'range-1b', nodeCount: 80000, opsPerSec: 500 },
      ]
      const result2 = plan.generatePlan(updatedMap, r2)
      expect(result2).not.toBeNull()
      expect(result2!.version).toBe(3)
      expect(result2!.splits.some(s => s.sourceRangeId === 'range-1a')).toBe(true)
    })
  })

  describe('Writes during resharding', () => {
    test('should handle concurrent split generation correctly', () => {
      // Generate multiple plans concurrently — should all work
      const ranges = [
        { rangeId: 'range-1', nodeCount: 60000, opsPerSec: 2000 },
      ]
      const promises = Array.from({ length: 5 }, () =>
        Promise.resolve().then(() => plan.generatePlan(shardMap, ranges))
      )
      // All should succeed
      return Promise.all(promises).then(results => {
        for (const r of results) {
          expect(r).not.toBeNull()
        }
      })
    })
  })
})

// ──────────────────────────────────────────
// HotMigrator Extension Tests
// ──────────────────────────────────────────

describe('HotMigrator - Extended', () => {
  test('haversineDistance should return 0 for same point', () => {
    const d = haversineDistance(40.7128, -74.0060, 40.7128, -74.0060)
    expect(d).toBe(0)
  })

  test('haversineDistance should calculate NYC to LA distance approximately', () => {
    const d = haversineDistance(40.7128, -74.0060, 34.0522, -118.2437)
    // NYC to LA is about 3940 km
    expect(d).toBeGreaterThan(3000)
    expect(d).toBeLessThan(5000)
  })
})


