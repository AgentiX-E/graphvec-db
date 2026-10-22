/**
 * Query statistics snapshot returned by StatsCollector.collectStats.
 *
 * Describes the size, complexity and recency of the query workload that has
 * been executed against the engine.
 */
export interface QueryStats {
  /** Number of nodes referenced by the recorded query workload */
  nodeCount: number
  /** Number of edges referenced by the recorded query workload */
  edgeCount: number
  /** Aggregate complexity score of the recorded queries */
  complexityScore: number
  /** Timestamp (epoch ms) of the most recent query, if any */
  lastQueryAt?: number
  /** Estimated content size in bytes */
  contentSize: number
  /** Number of node inputs consumed while executing queries */
  nodeInput: number
  /** Number of edge inputs consumed while executing queries */
  edgeInput: number
}
