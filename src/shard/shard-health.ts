/**
 * Shard Health Monitoring & Hot Shard Detection
 *
 * Provides:
 * - Health check tracking for shards
 * - HotShardDetector: Rolling-window QPS + latency tracking for hot shard identification
 */

// ──────────────────────────────────────────
// Constants
// ──────────────────────────────────────────

/** Default rolling window size in seconds */
const DEFAULT_WINDOW_SECONDS = 60
/** Default ring buffer bucket count (1-second granularity) */
const DEFAULT_BUCKET_COUNT = 60

// ──────────────────────────────────────────
// Types
// ──────────────────────────────────────────

export interface OperationRecord {
  timestamp: number      // ms
  latencyMs: number
}

export interface ShardStats {
  qps: number
  p50Latency: number
  p99Latency: number
  avgLatency: number
  totalOps: number
}

export interface HotShardDetectorConfig {
  windowSeconds?: number
  minQpsThreshold?: number
  p99LatencyThresholdMs?: number
}

// ──────────────────────────────────────────
// HotShardDetector
// ──────────────────────────────────────────

/**
 * HotShardDetector — rolling-window hot shard detection
 *
 * Tracks per-shard QPS and latency using a ring buffer with 1-second buckets.
 * Provides methods to record operations, compute statistics, and identify
 * shards that exceed QPS or P99 latency thresholds.
 */
export class HotShardDetector {
  private _windowSeconds: number
  private _bucketCount: number
  private _buckets: Map<string, OperationRecord[][]>
  private _currentBucketIndex: number
  private _lastBucketSwitch: number

  constructor(config?: HotShardDetectorConfig) {
    this._windowSeconds = config?.windowSeconds ?? DEFAULT_WINDOW_SECONDS
    this._bucketCount = config?.windowSeconds ?? DEFAULT_BUCKET_COUNT
    this._buckets = new Map()
    this._currentBucketIndex = 0
    this._lastBucketSwitch = Date.now()
  }

  /**
   * Record an operation for a shard.
   * Automatically advances the ring buffer if a new second has elapsed.
   */
  recordOp(shardId: string, latencyMs: number): void {
    this._advanceBuckets()

    if (!this._buckets.has(shardId)) {
      this._buckets.set(shardId, Array.from({ length: this._bucketCount }, () => []))
    }

    const shardBuckets = this._buckets.get(shardId)!
    shardBuckets[this._currentBucketIndex].push({
      timestamp: Date.now(),
      latencyMs,
    })
  }

  /**
   * Get the IDs of shards that exceed the QPS and/or P99 latency thresholds.
   *
   * @param minQps - Minimum QPS threshold (default 100)
   * @param p99LatencyMs - Maximum acceptable P99 latency in ms (default Infinity — no latency filter)
   * @returns Array of hot shard IDs
   */
  getHotShards(minQps?: number, p99LatencyMs?: number): string[] {
    const qpsThreshold = minQps ?? DEFAULT_MIN_QPS
    const latencyThreshold = p99LatencyMs ?? Infinity
    const hotShards: string[] = []

    this._advanceBuckets()

    for (const [shardId] of this._buckets) {
      const stats = this.getShardStats(shardId)
      if (stats.qps >= qpsThreshold && stats.p99Latency <= latencyThreshold) {
        hotShards.push(shardId)
      }
    }

    return hotShards
  }

  /**
   * Get detailed stats for a single shard.
   */
  getShardStats(shardId: string): ShardStats {
    this._advanceBuckets()
    const allOps = this._getWindowedOps(shardId)
    if (allOps.length === 0) {
      return { qps: 0, p50Latency: 0, p99Latency: 0, avgLatency: 0, totalOps: 0 }
    }

    const latencies = allOps.map(o => o.latencyMs).sort((a, b) => a - b)
    const total = latencies.length
    const avg = latencies.reduce((s, v) => s + v, 0) / total

    // QPS = total ops / window seconds
    const qps = total / this._windowSeconds

    // P50
    const p50 = latencies[Math.floor(total * 0.5)] ?? latencies[latencies.length - 1]
    // P99
    const p99 = latencies[Math.floor(total * 0.99)] ?? latencies[latencies.length - 1]

    return { qps, p50Latency: p50, p99Latency: p99, avgLatency: avg, totalOps: total }
  }

  /**
   * Get all tracked shard IDs.
   */
  getTrackedShards(): string[] {
    return [...this._buckets.keys()]
  }

  /**
   * Reset all tracking data.
   */
  reset(): void {
    this._buckets.clear()
    this._currentBucketIndex = 0
    this._lastBucketSwitch = Date.now()
  }

  // ── Private ──

  /**
   * Advance the ring buffer to the current second.
   * Clears expired buckets and increments the index.
   */
  private _advanceBuckets(): void {
    const now = Date.now()
    const elapsed = now - this._lastBucketSwitch
    const bucketsToAdvance = Math.floor(elapsed / 1000)

    if (bucketsToAdvance <= 0) return

    for (let i = 0; i < Math.min(bucketsToAdvance, this._bucketCount); i++) {
      this._currentBucketIndex = (this._currentBucketIndex + 1) % this._bucketCount
      // Clear the incoming bucket for all shards
      for (const [, shardBuckets] of this._buckets) {
        shardBuckets[this._currentBucketIndex] = []
      }
    }

    this._lastBucketSwitch += bucketsToAdvance * 1000
  }

  /**
   * Get all ops within the current window for a shard.
   */
  private _getWindowedOps(shardId: string): OperationRecord[] {
    const shardBuckets = this._buckets.get(shardId)
    if (!shardBuckets) return []

    const allOps: OperationRecord[] = []
    const now = Date.now()
    const cutoff = now - this._windowSeconds * 1000

    for (const bucket of shardBuckets) {
      for (const op of bucket) {
        if (op.timestamp >= cutoff) {
          allOps.push(op)
        }
      }
    }

    return allOps
  }
}

/** Default minimum QPS threshold for hot shard detection */
const DEFAULT_MIN_QPS = 100
