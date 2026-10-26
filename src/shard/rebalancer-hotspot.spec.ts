/**
 * rebalancer-hotspot.spec.ts — unit tests for the hot-spot detection logic of
 * the Rebalancer (SH05), which is pure in-memory window counting with no
 * dependence on ShardManager, fs, or the scheduler. Fake timers make the
 * window-boundary behaviour deterministic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Rebalancer } from './rebalancer'
import type { ShardManager } from './shard-manager'

// The hotspot logic never touches the manager; a minimal stub suffices.
function stubManager(): ShardManager {
  return {
    getAllRanges: () => new Map(),
  } as unknown as ShardManager
}

describe('Rebalancer hot-spot detection (SH05)', () => {
  let rb: Rebalancer

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    rb = new Rebalancer(stubManager(), {
      hotSpotThreshold: 10, // 10 ops/sec
      hotSpotWindowMs: 60000, // 1 minute window
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('counts operations within the current window', () => {
    rb.recordOperation('r1')
    rb.recordOperation('r1')
    rb.recordOperation('r1')
    expect(rb.getOperationCount('r1')).toBe(3)
  })

  it('returns 0 for an unknown range', () => {
    expect(rb.getOperationCount('nope')).toBe(0)
  })

  it('resets the count when the window expires', () => {
    rb.recordOperation('r1')
    rb.recordOperation('r1')
    expect(rb.getOperationCount('r1')).toBe(2)

    // Advance past the window: the record becomes stale.
    vi.advanceTimersByTime(60001)
    expect(rb.getOperationCount('r1')).toBe(0)

    // A fresh operation starts a new window with count 1.
    rb.recordOperation('r1')
    expect(rb.getOperationCount('r1')).toBe(1)
  })

  it('recordOperation resets count when called after the window expires', () => {
    rb.recordOperation('r1')
    rb.recordOperation('r1')
    vi.advanceTimersByTime(60001)
    // Expired window → new window, count reset to 1 (not 3).
    rb.recordOperation('r1')
    expect(rb.getOperationCount('r1')).toBe(1)
  })

  it('findHotRanges flags a range whose rate exceeds the threshold', () => {
    // 100 ops recorded within a short span → far above 10 ops/sec.
    for (let i = 0; i < 100; i++) rb.recordOperation('hot')
    vi.advanceTimersByTime(1000) // 1 second elapsed → 100 ops/sec
    const hot = rb.findHotRanges()
    expect(hot).toContainEqual(expect.objectContaining({ rangeId: 'hot' }))
  })

  it('findHotRanges does not flag a range below the threshold', () => {
    // 5 ops over ~1 second → 5 ops/sec < 10.
    for (let i = 0; i < 5; i++) rb.recordOperation('cold')
    vi.advanceTimersByTime(1000)
    expect(rb.findHotRanges()).toEqual([])
  })

  it('findHotRanges ignores expired windows and cleans them up', () => {
    rb.recordOperation('stale')
    vi.advanceTimersByTime(60001)
    expect(rb.findHotRanges()).toEqual([])
    // The stale record was removed.
    expect(rb.getOperationCount('stale')).toBe(0)
  })

  it('does NOT flag a hot range at the exact instant of recording (elapsed=0)', () => {
    // Regression: elapsedMs === 0 previously produced opsPerSec = Infinity,
    // marking a single just-recorded operation as "hot". A single op can never
    // exceed a rate threshold of 10 ops/sec.
    rb.recordOperation('just-now')
    const hot = rb.findHotRanges()
    expect(hot).toEqual([])
  })

  it('clearStaleOpRecords removes only expired records', () => {
    rb.recordOperation('fresh')
    rb.recordOperation('expiring')
    // Advance so only 'expiring' becomes stale: record it first, then advance,
    // then record 'fresh' so its window is later.
    vi.advanceTimersByTime(60001)
    rb.recordOperation('fresh2')

    rb.clearStaleOpRecords()

    // 'fresh' and 'expiring' were recorded before the advance → both stale.
    expect(rb.getOperationCount('fresh')).toBe(0)
    expect(rb.getOperationCount('expiring')).toBe(0)
    // 'fresh2' was recorded after the advance → still fresh.
    expect(rb.getOperationCount('fresh2')).toBe(1)
  })

  it('exposes hot-spot config', () => {
    expect(rb.getHotSpotConfig()).toEqual({
      hotSpotThreshold: 10,
      hotSpotWindowMs: 60000,
    })
  })
})
