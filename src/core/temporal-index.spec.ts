// ============================================================
// temporal-index.spec.ts — Temporal Index & Sliding Window Tests
// ============================================================

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { TemporalIndex, createTemporalIndex, TemporalEvent } from './temporal-index'
import { firstValueFrom, take, timeout } from 'rxjs'

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────

function makeEvent(ts: number, value: number, label?: string): TemporalEvent {
  return { timestamp: ts, value, label }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ──────────────────────────────────────────
// Tests
// ──────────────────────────────────────────

describe('TemporalIndex — Basic Operations', () => {
  let index: TemporalIndex

  beforeEach(() => {
    index = new TemporalIndex()
  })

  test('GAP-12-1: new index is empty', () => {
    expect(index.size()).toBe(0)
    expect(index.getTotalAdded()).toBe(0)
    expect(index.minTimestamp()).toBeNull()
    expect(index.maxTimestamp()).toBeNull()
  })

  test('GAP-12-2: add single event', () => {
    index.add(makeEvent(1000, 42))
    expect(index.size()).toBe(1)
    expect(index.getTotalAdded()).toBe(1)
    expect(index.minTimestamp()).toBe(1000)
    expect(index.maxTimestamp()).toBe(1000)
  })

  test('GAP-12-3: add multiple events with default timestamp', () => {
    const now = Date.now()
    index.add({ value: 10 })
    expect(index.size()).toBe(1)
    expect(index.minTimestamp()).toBeGreaterThanOrEqual(now)
  })

  test('GAP-12-4: addBatch inserts multiple events', () => {
    index.addBatch([
      makeEvent(100, 1),
      makeEvent(200, 2),
      makeEvent(300, 3),
    ])
    expect(index.size()).toBe(3)
    expect(index.getTotalAdded()).toBe(3)
    expect(index.minTimestamp()).toBe(100)
    expect(index.maxTimestamp()).toBe(300)
  })

  test('GAP-12-5: events are sorted by timestamp', () => {
    index.addBatch([
      makeEvent(300, 3),
      makeEvent(100, 1),
      makeEvent(200, 2),
    ])
    // Query full range
    const events = index.queryRange({ startMs: 0, endMs: 1000 })
    expect(events.map(e => e.value)).toEqual([1, 2, 3])
  })

  test('GAP-12-6: queryRange returns events in time range', () => {
    index.addBatch([
      makeEvent(100, 1),
      makeEvent(200, 2),
      makeEvent(300, 3),
      makeEvent(400, 4),
      makeEvent(500, 5),
    ])

    const result = index.queryRange({ startMs: 150, endMs: 350 })
    expect(result).toHaveLength(2)
    expect(result.map(e => e.value)).toEqual([2, 3])
  })

  test('GAP-12-7: queryRange returns empty for no match', () => {
    index.addBatch([makeEvent(100, 1)])
    const result = index.queryRange({ startMs: 200, endMs: 300 })
    expect(result).toHaveLength(0)
  })

  test('GAP-12-8: queryRange with limit', () => {
    index.addBatch([
      makeEvent(100, 1),
      makeEvent(200, 2),
      makeEvent(300, 3),
    ])
    const result = index.queryRange({ startMs: 0, endMs: 1000, limit: 2 })
    expect(result).toHaveLength(2)
    expect(result[0].value).toBe(1)
    expect(result[1].value).toBe(2)
  })

  test('GAP-12-9: queryRange with label filter', () => {
    index.addBatch([
      makeEvent(100, 1, 'a'),
      makeEvent(200, 2, 'b'),
      makeEvent(300, 3, 'a'),
    ])
    const result = index.queryRange({ startMs: 0, endMs: 1000, label: 'a' })
    expect(result).toHaveLength(2)
    expect(result.map(e => e.value)).toEqual([1, 3])
  })

  test('GAP-12-10: countInRange', () => {
    index.addBatch([
      makeEvent(100, 1),
      makeEvent(200, 2),
      makeEvent(300, 3),
    ])
    expect(index.countInRange(0, 250)).toBe(2)
    expect(index.countInRange(400, 500)).toBe(0)
  })

  test('GAP-12-11: sumInRange', () => {
    index.addBatch([
      makeEvent(100, 10),
      makeEvent(200, 20),
      makeEvent(300, 30),
    ])
    expect(index.sumInRange(0, 250)).toBe(30)
  })

  test('GAP-12-12: avgInRange', () => {
    index.addBatch([
      makeEvent(100, 10),
      makeEvent(200, 20),
      makeEvent(300, 30),
    ])
    expect(index.avgInRange(0, 250)).toBe(15) // (10+20)/2
  })

  test('GAP-12-13: clear removes all events', () => {
    index.addBatch([
      makeEvent(100, 1),
      makeEvent(200, 2),
    ])
    expect(index.size()).toBe(2)
    index.clear()
    expect(index.size()).toBe(0)
    expect(index.getTotalAdded()).toBe(0)
  })
})

describe('TemporalIndex — Sliding Window', () => {
  let index: TemporalIndex

  beforeEach(() => {
    index = new TemporalIndex()
  })

  test('GAP-12-14: slideWindow on empty index', () => {
    const windows = index.slideWindow({ windowMs: 100 })
    expect(windows).toHaveLength(0)
  })

  test('GAP-12-15: slideWindow single window', () => {
    index.addBatch([
      makeEvent(100, 1),
      makeEvent(150, 2),
      makeEvent(200, 3),
    ])
    const windows = index.slideWindow({ windowMs: 200 })
    expect(windows.length).toBeGreaterThanOrEqual(1)
    const w = windows[0]
    expect(w.count).toBe(3)
    expect(w.sum).toBe(6)
    expect(w.avg).toBe(2)
    expect(w.min).toBe(1)
    expect(w.max).toBe(3)
  })

  test('GAP-12-16: slideWindow with slide interval', () => {
    index.addBatch([
      makeEvent(100, 1),
      makeEvent(200, 2),
      makeEvent(300, 3),
      makeEvent(400, 4),
    ])
    // Window=200ms, slide=100ms
    const windows = index.slideWindow({ windowMs: 200, slideMs: 100 })
    expect(windows.length).toBeGreaterThanOrEqual(3)
    // First window: [100, 300) = events at 100, 200 — but the window is [100, 300)
    // Our queryRange is inclusive on both ends. Event at 200 is at exact boundary.
    // Events: 100, 200, 300, 400
    // Window [100, 300]: events at 100, 200, 300 (inclusive on both ends)
    expect(windows[0].count).toBe(3)
    expect(windows[0].sum).toBe(6) // 1+2+3
  })

  test('GAP-12-17: slideWindow computes stddev', () => {
    index.addBatch([
      makeEvent(100, 2),
      makeEvent(200, 4),
      makeEvent(300, 6),
    ])
    const windows = index.slideWindow({ windowMs: 300 })
    const w = windows[0]
    expect(w.stddev).toBeCloseTo(Math.sqrt(((2-4)**2 + (4-4)**2 + (6-4)**2)/3), 5)
  })

  test('GAP-12-18: slideWindow with empty windows', () => {
    index.addBatch([
      makeEvent(100, 1),
      makeEvent(500, 5),
    ])
    const windows = index.slideWindow({ windowMs: 200, slideMs: 100 })
    // Some windows will be empty (no events between 200-400)
    const emptyWindows = windows.filter(w => w.count === 0)
    expect(emptyWindows.length).toBeGreaterThan(0)
    for (const ew of emptyWindows) {
      expect(ew.sum).toBe(0)
      expect(ew.avg).toBe(0)
      expect(ew.firstValue).toBeNull()
      expect(ew.lastValue).toBeNull()
    }
  })

  test('GAP-12-19: slideWindow first/last values', () => {
    index.addBatch([
      makeEvent(100, 10),
      makeEvent(200, 20),
      makeEvent(300, 30),
    ])
    const windows = index.slideWindow({ windowMs: 300 })
    const w = windows[0]
    expect(w.firstValue).toBe(10)
    expect(w.lastValue).toBe(30)
  })
})

describe('TemporalIndex — Time-Weighted Moving Average (TWMA)', () => {
  let index: TemporalIndex

  beforeEach(() => {
    index = new TemporalIndex()
  })

  test('GAP-12-20: twma with no events returns 0', () => {
    expect(index.twma(1000)).toBe(0)
  })

  test('GAP-12-21: twma with single value returns that value', () => {
    const now = Date.now()
    index.add(makeEvent(now, 42))
    const result = index.twma(5000)
    expect(result).toBe(42)
  })

  test('GAP-12-22: twma with multiple values', () => {
    const now = Date.now()
    index.add(makeEvent(now - 2000, 10))
    index.add(makeEvent(now - 1000, 20))
    index.add(makeEvent(now, 30))
    const result = index.twma(5000)
    // Should be between 10-30, biased towards recent
    expect(result).toBeGreaterThan(10)
    expect(result).toBeLessThanOrEqual(30)
  })

  test('GAP-12-23: twma outside lookback returns 0', () => {
    const farPast = Date.now() - 100000
    index.add(makeEvent(farPast, 100))
    expect(index.twma(100)).toBe(0)
  })

  test('GAP-12-24: twma with exponential decay', () => {
    const now = Date.now()
    index.add(makeEvent(now - 2000, 10))
    index.add(makeEvent(now - 1000, 20))
    index.add(makeEvent(now, 30))
    const linear = index.twma(5000, 'linear')
    const expo = index.twma(5000, 'exponential')
    expect(typeof linear).toBe('number')
    expect(typeof expo).toBe('number')
  })
})

describe('TemporalIndex — Observable Stream', () => {
  test('GAP-12-25: getEventStream emits events', async () => {
    const index = new TemporalIndex()
    const stream = index.getEventStream()

    // Subscribe and wait for event
    const promise = firstValueFrom(stream.pipe(
      timeout(3000),
    ))

    setTimeout(() => {
      index.add(makeEvent(100, 42, 'test'))
    }, 50)

    const event = await promise
    expect(event.value).toBe(42)
    expect(event.label).toBe('test')
    expect(event.timestamp).toBe(100)
  })

  test('GAP-12-26: addBatch emits each event to stream', () => {
    const index = new TemporalIndex()
    const stream = index.getEventStream()
    const received: TemporalEvent[] = []

    const sub = stream.subscribe(e => received.push(e))
    index.addBatch([
      makeEvent(100, 1),
      makeEvent(200, 2),
    ])

    expect(received).toHaveLength(2)
    sub.unsubscribe()
  })
})

describe('TemporalIndex — Max Events Bound', () => {
  test('GAP-12-27: maxEvents evicts oldest events', () => {
    const index = new TemporalIndex({ maxEvents: 3 })
    index.addBatch([
      makeEvent(100, 1),
      makeEvent(200, 2),
      makeEvent(300, 3),
      makeEvent(400, 4), // evicts event at 100
    ])
    expect(index.size()).toBe(3)
    expect(index.minTimestamp()).toBe(200) // oldest kept is 200
  })

  test('GAP-12-28: addBatch respects maxEvents', () => {
    const index = new TemporalIndex({ maxEvents: 2 })
    index.addBatch([
      makeEvent(100, 1),
      makeEvent(200, 2),
      makeEvent(300, 3),
    ])
    expect(index.size()).toBe(2)
    expect(index.minTimestamp()).toBe(200)
    expect(index.maxTimestamp()).toBe(300)
  })
})

describe('TemporalIndex — createTemporalIndex factory', () => {
  test('GAP-12-29: factory creates instance', () => {
    const index = createTemporalIndex()
    expect(index).toBeInstanceOf(TemporalIndex)
    expect(index.size()).toBe(0)
  })

  test('GAP-12-30: factory with maxEvents config', () => {
    const index = createTemporalIndex({ maxEvents: 100 })
    expect(index.size()).toBe(0)
    index.add(makeEvent(1, 1))
    expect(index.size()).toBe(1)
  })
})
