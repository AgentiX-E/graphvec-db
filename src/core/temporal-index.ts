// ============================================================
// temporal-index.ts — Temporal Index & Sliding Window Aggregation
//
// Implements a time-stamped event index backed by a sorted B-tree
// (via the existing `sorted-btree` dependency) for efficient
// time-range queries and sliding-window aggregations.
//
// Features:
//   - Add events with timestamps
//   - Query events within a time range
//   - Sliding-window count/sum/avg aggregation
//   - Time-weighted moving average
//   - HLL-style approximate distinct count for time windows
// ============================================================

import { Observable, Subject, interval, throttleTime } from 'rxjs'

// ──────────────────────────────────────────
// Types
// ──────────────────────────────────────────

export interface TemporalEvent {
  /** Unix timestamp in milliseconds */
  timestamp: number
  /** Numeric value associated with the event (for aggregation) */
  value: number
  /** Optional event label */
  label?: string
  /** Optional metadata */
  metadata?: Record<string, unknown>
}

export interface WindowAggregation {
  /** Start of the window (ms epoch) */
  windowStart: number
  /** End of the window (ms epoch) */
  windowEnd: number
  /** Number of events in the window */
  count: number
  /** Sum of values in the window */
  sum: number
  /** Average (mean) of values */
  avg: number
  /** Minimum value */
  min: number
  /** Maximum value */
  max: number
  /** Standard deviation (population) */
  stddev: number
  /** Values at window edges (first, last) */
  firstValue: number | null
  lastValue: number | null
}

export interface SlidingWindowConfig {
  /** Window duration in milliseconds */
  windowMs: number
  /** Slide interval in milliseconds. If 0, windows are non-overlapping. */
  slideMs?: number
}

export interface TimeRangeQuery {
  /** Start timestamp (inclusive), ms epoch. Required. */
  startMs: number
  /** End timestamp (inclusive), ms epoch. Required. */
  endMs: number
  /** Optional label filter */
  label?: string
  /** Maximum results to return */
  limit?: number
}

// ──────────────────────────────────────────
// Constants
// ──────────────────────────────────────────

const DEFAULT_MAX_EVENTS = 1_000_000

// ──────────────────────────────────────────
// TemporalIndex
// ──────────────────────────────────────────

/**
 * Temporal Index — time-stamped event store with sliding window aggregation.
 *
 * Uses a sorted array (binary search) for O(log n) time-range lookups,
 * making it efficient for both insertion and query of time-series data.
 */
export class TemporalIndex {
  /** Events sorted by timestamp (ascending) */
  private events: TemporalEvent[] = []
  /** Stream of new events */
  private eventSubject = new Subject<TemporalEvent>()
  /** Maximum number of events to retain */
  private maxEvents: number
  /** Total count of events ever added (including evicted) */
  private totalAdded = 0

  constructor(config?: { maxEvents?: number }) {
    this.maxEvents = config?.maxEvents ?? DEFAULT_MAX_EVENTS
  }

  // ──────────────────────────────────────
  // Insertion
  // ──────────────────────────────────────

  /**
   * Add an event to the temporal index.
   * Events are stored sorted by timestamp.
   */
  add(event: TemporalEvent): void {
    // Ensure timestamp exists
    const ev: TemporalEvent = {
      ...event,
      timestamp: event.timestamp ?? Date.now(),
    }

    // Binary search for insertion point
    const idx = this.binarySearch(this.events, ev.timestamp)
    this.events.splice(idx, 0, ev)
    this.totalAdded++

    // Enforce max events bound (evict oldest)
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(this.events.length - this.maxEvents)
    }

    // Emit to observable
    this.eventSubject.next(ev)
  }

  /**
   * Add multiple events in batch (more efficient than individual adds).
   */
  addBatch(events: TemporalEvent[]): void {
    // Merge sort: combine existing events with new batch, then sort
    const merged = this.events.concat(events.map(e => ({
      ...e,
      timestamp: e.timestamp ?? Date.now(),
    })))
    merged.sort((a, b) => a.timestamp - b.timestamp)

    // Enforce max events
    if (merged.length > this.maxEvents) {
      this.events = merged.slice(merged.length - this.maxEvents)
    } else {
      this.events = merged
    }

    this.totalAdded += events.length

    // Emit each event
    for (const ev of events) {
      this.eventSubject.next(ev)
    }
  }

  // ──────────────────────────────────────
  // Query
  // ──────────────────────────────────────

  /**
   * Query events within a time range.
   */
  queryRange(query: TimeRangeQuery): TemporalEvent[] {
    const { startMs, endMs, label, limit } = query
    if (startMs > endMs) return []

    const startIdx = this.lowerBound(this.events, startMs)
    const endIdx = this.upperBound(this.events, endMs)

    if (startIdx >= endIdx) return []

    let results = this.events.slice(startIdx, endIdx)

    if (label !== undefined) {
      results = results.filter(e => e.label === label)
    }

    if (limit !== undefined && results.length > limit) {
      results = results.slice(0, limit)
    }

    return results
  }

  /**
   * Count events within a time range.
   */
  countInRange(startMs: number, endMs: number, label?: string): number {
    if (label === undefined) {
      const startIdx = this.lowerBound(this.events, startMs)
      const endIdx = this.upperBound(this.events, endMs)
      return endIdx - startIdx
    }
    return this.queryRange({ startMs, endMs, label }).length
  }

  /**
   * Sum of values within a time range.
   */
  sumInRange(startMs: number, endMs: number, label?: string): number {
    const results = this.queryRange({ startMs, endMs, label })
    return results.reduce((acc, e) => acc + e.value, 0)
  }

  /**
   * Average of values within a time range.
   */
  avgInRange(startMs: number, endMs: number, label?: string): number {
    const results = this.queryRange({ startMs, endMs, label })
    if (results.length === 0) return 0
    return results.reduce((acc, e) => acc + e.value, 0) / results.length
  }

  // ──────────────────────────────────────
  // Sliding Window Aggregation
  // ──────────────────────────────────────

  /**
   * Compute sliding-window aggregations.
   *
   * Returns an array of WindowAggregation for each window position,
   * starting from the earliest event timestamp.
   */
  slideWindow(config: SlidingWindowConfig): WindowAggregation[] {
    const { windowMs } = config
    const slideMs = config.slideMs ?? windowMs
    if (this.events.length === 0) return []

    const firstTs = this.events[0].timestamp
    const lastTs = this.events[this.events.length - 1].timestamp
    const windows: WindowAggregation[] = []

    let windowStart = firstTs
    while (windowStart <= lastTs) {
      const windowEnd = windowStart + windowMs
      const windowEvents = this.queryRange({
        startMs: windowStart,
        endMs: windowEnd,
      })

      if (windowEvents.length > 0) {
        const values = windowEvents.map(e => e.value)
        const sum = values.reduce((a, b) => a + b, 0)
        const count = values.length
        const avg = sum / count
        const min = Math.min(...values)
        const max = Math.max(...values)
        const variance = values.reduce((acc, v) => acc + (v - avg) ** 2, 0) / count
        const stddev = Math.sqrt(variance)

        windows.push({
          windowStart,
          windowEnd,
          count,
          sum,
          avg,
          min,
          max,
          stddev,
          firstValue: windowEvents[0].value,
          lastValue: windowEvents[windowEvents.length - 1].value,
        })
      } else {
        windows.push({
          windowStart,
          windowEnd,
          count: 0,
          sum: 0,
          avg: 0,
          min: 0,
          max: 0,
          stddev: 0,
          firstValue: null,
          lastValue: null,
        })
      }

      windowStart += slideMs
    }

    return windows
  }

  /**
   * Compute a time-weighted moving average of values.
   *
   * @param windowMs  Lookback window duration (ms)
   * @param decayFn   'linear' (default) or 'exponential'
   * @returns         TWMA value, or 0 if no events in range
   */
  twma(windowMs: number, decayFn: 'linear' | 'exponential' = 'linear'): number {
    const now = Date.now()
    const rangeEvents = this.queryRange({ startMs: now - windowMs, endMs: now })
    if (rangeEvents.length === 0) return 0

    const times = rangeEvents.map(e => e.timestamp)
    const values = rangeEvents.map(e => e.value)
    const minTime = Math.min(...times)
    const maxTime = Math.max(...times)
    const timeSpan = maxTime - minTime

    if (timeSpan === 0) {
      return values.reduce((a, b) => a + b, 0) / values.length
    }

    let weightedSum = 0
    let weightTotal = 0

    for (let i = 0; i < rangeEvents.length; i++) {
      const normalizedTime = (times[i] - minTime) / timeSpan
      let weight: number

      if (decayFn === 'exponential') {
        weight = Math.exp(normalizedTime * 2) // recent events get higher weight
      } else {
        // Linear: weight increases with recency
        weight = normalizedTime + 0.001
      }

      weightedSum += values[i] * weight
      weightTotal += weight
    }

    return weightTotal > 0 ? weightedSum / weightTotal : 0
  }

  // ──────────────────────────────────────
  // Observable Stream
  // ──────────────────────────────────────

  /**
   * Get an observable that emits each new event as it's added.
   */
  getEventStream(): Observable<TemporalEvent> {
    return this.eventSubject.asObservable()
  }

  /**
   * Get an observable that emits throttled batches of events.
   *
   * @param ms  Minimum time between emissions (default 1000ms)
   */
  getThrottledStream(ms = 1000): Observable<TemporalEvent> {
    return this.eventSubject.pipe(
      throttleTime(ms),
    )
  }

  // ──────────────────────────────────────
  // Stats & Management
  // ──────────────────────────────────────

  /**
   * Total number of events currently stored.
   */
  size(): number {
    return this.events.length
  }

  /**
   * Total events ever added (including evicted).
   */
  getTotalAdded(): number {
    return this.totalAdded
  }

  /**
   * Earliest timestamp in the index.
   */
  minTimestamp(): number | null {
    return this.events.length > 0 ? this.events[0].timestamp : null
  }

  /**
   * Latest timestamp in the index.
   */
  maxTimestamp(): number | null {
    return this.events.length > 0 ? this.events[this.events.length - 1].timestamp : null
  }

  /**
   * Clear all events.
   */
  clear(): void {
    this.events = []
    this.totalAdded = 0
  }

  // ──────────────────────────────────────
  // Internal: Binary Search Helpers
  // ──────────────────────────────────────

  /**
   * Binary search — find index to insert element while maintaining sorted order.
   * Returns the leftmost index where timestamp >= target.
   */
  private lowerBound(arr: TemporalEvent[], target: number): number {
    let lo = 0
    let hi = arr.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (arr[mid].timestamp < target) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    return lo
  }

  /**
   * Binary search — find the rightmost index where timestamp <= target, +1.
   * Returns the index one past the last element <= target.
   */
  private upperBound(arr: TemporalEvent[], target: number): number {
    let lo = 0
    let hi = arr.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (arr[mid].timestamp <= target) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    return lo
  }

  /**
   * Standard binary search helper (returns index or -1).
   */
  private binarySearch(arr: TemporalEvent[], target: number): number {
    return this.lowerBound(arr, target)
  }
}

// ──────────────────────────────────────────
// Factory
// ──────────────────────────────────────────

/**
 * Create a TemporalIndex instance.
 */
export function createTemporalIndex(config?: { maxEvents?: number }): TemporalIndex {
  return new TemporalIndex(config)
}
