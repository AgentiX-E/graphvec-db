/**
 * GraphVecSlowQueryAdapter — Implements ISlowQueryRecorder for the graphvec-db engine.
 *
 * Wraps the src/ops/QuerySlowLog class and maps its native SlowLogEntry
 * types to the canonical ISlowQueryRecorder interface types.
 */

import type { ISlowQueryRecorder, SlowQueryRecord, QueryPattern } from '@agentix-e/db-operations-monitor';
import { QuerySlowLog } from 'graphvec-db/ops/query-slow-log';

/**
 * GraphVecSlowQueryAdapter — adapts the graphvec-db QuerySlowLog to ISlowQueryRecorder.
 *
 * The graphvec-db `QuerySlowLog` class tracks slow queries in-memory with
 * optional rotating-file-stream persistence. This adapter wraps it and
 * populates the richer SlowQueryRecord / QueryPattern formats.
 *
 * @example
 * ```ts
 * const adapter = new GraphVecSlowQueryAdapter(100);
 * const result = await adapter.record({
 *   query: 'MATCH (n) RETURN n',
 *   durationMs: 250,
 *   timestamp: new Date(),
 *   database: 'graphvec',
 * });
 * ```
 */
export class GraphVecSlowQueryAdapter implements ISlowQueryRecorder {
  private slowLog: QuerySlowLog;
  private history: SlowQueryRecord[] = [];

  constructor(thresholdMs: number = 100, maxEntries: number = 1000, logFilePath?: string) {
    this.slowLog = new QuerySlowLog(thresholdMs, maxEntries, logFilePath);
  }

  /**
   * Get the underlying QuerySlowLog instance for native interop.
   */
  get nativeSlowLog(): QuerySlowLog {
    return this.slowLog;
  }

  // ── ISlowQueryRecorder implementation ──

  async record(query: SlowQueryRecord): Promise<void> {
    this.history.push(query);
    // Keep bounded
    if (this.history.length > 10000) {
      this.history = this.history.slice(-5000);
    }
    // Also add to the native slow log for file persistence
    await this.slowLog.track(
      query.query,
      async () => {
        // Simulate the operation duration (it's already been recorded)
        await new Promise(resolve => setTimeout(resolve, 0));
        return query.query;
      },
      query.user,
    );
  }

  async getSlowQueries(thresholdMs: number): Promise<SlowQueryRecord[]> {
    // Return records exceeding the threshold
    return this.history
      .filter(r => r.durationMs >= thresholdMs)
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 1000);
  }

  async analyzePatterns(): Promise<QueryPattern[]> {
    if (this.history.length === 0) return [];

    // Group by normalized query pattern
    const patternMap = new Map<string, SlowQueryRecord[]>();

    for (const record of this.history) {
      // Normalize query: remove values, keep structure
      const normalized = this._normalizeQuery(record.query);
      const group = patternMap.get(normalized) || [];
      group.push(record);
      patternMap.set(normalized, group);
    }

    // Convert grouped records to QueryPattern
    const patterns: QueryPattern[] = [];
    for (const [pattern, records] of patternMap.entries()) {
      const totalDuration = records.reduce((sum, r) => sum + r.durationMs, 0);
      const lastSeen = records.reduce(
        (latest, r) => (r.timestamp > latest ? r.timestamp : latest),
        records[0].timestamp,
      );

      patterns.push({
        pattern,
        averageDurationMs: Math.round(totalDuration / records.length),
        count: records.length,
        lastSeen,
      });
    }

    // Sort by most frequent first
    return patterns.sort((a, b) => b.count - a.count).slice(0, 200);
  }

  /**
   * Set a new threshold for the underlying slow log.
   */
  setThreshold(ms: number): void {
    this.slowLog.setThreshold(ms);
  }

  /**
   * Clear all recorded slow queries.
   */
  clear(): void {
    this.history = [];
    this.slowLog.clear();
  }

  /**
   * Close underlying file streams.
   */
  close(): void {
    this.slowLog.close();
  }

  /**
   * Normalize a query by replacing literals with placeholders.
   */
  private _normalizeQuery(query: string): string {
    return query
      .replace(/'[^']*'/g, "'?'")
      .replace(/"[^"]*"/g, '"?"')
      .replace(/\b\d+\b/g, '?')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
