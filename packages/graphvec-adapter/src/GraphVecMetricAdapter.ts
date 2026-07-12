/**
 * GraphVecMetricAdapter — Implements IMetricsRegistry for the graphvec-db engine.
 *
 * Wraps the src/ops/Metrics class, which maintains local counters/latency
 * histograms and delegates to OpenTelemetry. Maps the native graphvec-db
 * metrics types to the canonical IMetricsRegistry interface (ICounter, IGauge, IHistogram).
 */

import type { IMetricsRegistry, ICounter, IGauge, IHistogram } from '@agentix-e/db-operations-metrics';
import type { MetricsSnapshot } from '@agentix-e/db-operations-core/types';
import { Metrics } from 'graphvec-db/ops/metrics';

/**
 * Counter wrapper — adapts the native Metrics.incrementCounter() to ICounter.
 */
class AdapterCounter implements ICounter {
  private metrics: Metrics;
  private name: string;

  constructor(metrics: Metrics, name: string) {
    this.metrics = metrics;
    this.name = name;
  }

  inc(): void {
    this.metrics.incrementCounter(this.name, 1);
  }

  incBy(value: number): void {
    this.metrics.incrementCounter(this.name, value);
  }

  reset(): void {
    // GraphVec Metrics doesn't have a per-counter reset.
    // We track the current value and negate it.
    const current = this.metrics.getCounter(this.name);
    if (current > 0) {
      this.metrics.incrementCounter(this.name, -current);
    }
  }

  get(): number {
    return this.metrics.getCounter(this.name);
  }
}

/**
 * Gauge wrapper — uses the counter mechanism as a gauge (set → override).
 */
class AdapterGauge implements IGauge {
  private metrics: Metrics;
  private name: string;
  private _value: number = 0;

  constructor(metrics: Metrics, name: string) {
    this.metrics = metrics;
    this.name = name;
  }

  set(value: number): void {
    // Delta from current value
    const delta = value - this._value;
    if (delta !== 0) {
      this.metrics.incrementCounter(this.name, delta);
    }
    this._value = value;
  }

  inc(): void {
    this._value++;
    this.metrics.incrementCounter(this.name, 1);
  }

  dec(): void {
    this._value--;
    this.metrics.incrementCounter(this.name, -1);
  }

  add(value: number): void {
    this._value += value;
    this.metrics.incrementCounter(this.name, value);
  }

  get(): number {
    return this._value;
  }
}

/**
 * Histogram wrapper — adapts native Metrics.recordLatency() to IHistogram.
 */
class AdapterHistogram implements IHistogram {
  private metrics: Metrics;
  private name: string;
  private _count: number = 0;
  private _sum: number = 0;
  private samples: number[] = [];

  constructor(metrics: Metrics, name: string) {
    this.metrics = metrics;
    this.name = name;
  }

  observe(value: number): void {
    this._count++;
    this._sum += value;
    this.samples.push(value);
    // Keep last 1000 samples for quantile estimation
    if (this.samples.length > 1000) {
      this.samples.shift();
    }
    // Delegate to the native latency recorder
    this.metrics.recordLatency(this.name, value);
  }

  getCount(): number {
    return this._count;
  }

  getSum(): number {
    return this._sum;
  }

  getQuantile(p: number): number | undefined {
    if (this.samples.length === 0) return undefined;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * p);
    return sorted[Math.min(idx, sorted.length - 1)];
  }

  reset(): void {
    this._count = 0;
    this._sum = 0;
    this.samples = [];
  }
}

/**
 * GraphVecMetricAdapter — adapts the graphvec-db Metrics class to IMetricsRegistry.
 *
 * The graphvec-db `Metrics` class provides:
 * - incrementCounter(name, delta) — atomic counter increments
 * - recordLatency(name, latencyMs) — latency samples
 * - snapshot() — aggregate MetricsSnapshot with percentiles
 * - getCounter(name) — current counter value
 * - reset() — clear all metrics
 *
 * @example
 * ```ts
 * const adapter = new GraphVecMetricAdapter();
 * const counter = adapter.counter('graphvec_queries_total');
 * counter.inc();
 * ```
 */
export class GraphVecMetricAdapter implements IMetricsRegistry {
  private metrics: Metrics;
  private counters: Map<string, ICounter> = new Map();
  private gauges: Map<string, IGauge> = new Map();
  private histograms: Map<string, IHistogram> = new Map();

  constructor(metrics?: Metrics) {
    this.metrics = metrics ?? new Metrics();
  }

  /**
   * Get the underlying Metrics instance for native interop.
   */
  get nativeMetrics(): Metrics {
    return this.metrics;
  }

  // ── IMetricsRegistry implementation ──

  counter(name: string, _labels?: Record<string, string>): ICounter {
    const existing = this.counters.get(name);
    if (existing) return existing;
    const c = new AdapterCounter(this.metrics, name);
    this.counters.set(name, c);
    return c;
  }

  gauge(name: string, _labels?: Record<string, string>): IGauge {
    const existing = this.gauges.get(name);
    if (existing) return existing;
    const g = new AdapterGauge(this.metrics, name);
    this.gauges.set(name, g);
    return g;
  }

  histogram(name: string, _labels?: Record<string, string>, _buckets?: number[]): IHistogram {
    const existing = this.histograms.get(name);
    if (existing) return existing;
    const h = new AdapterHistogram(this.metrics, name);
    this.histograms.set(name, h);
    return h;
  }

  snapshot(): MetricsSnapshot {
    const native = this.metrics.snapshot();
    return {
      points: [
        // Map native metrics to metric points
        ...Array.from(this.counters.entries()).map(([name, c]) => ({
          name,
          type: 'counter' as const,
          value: c.get(),
          labels: [],
          timestamp: Date.now(),
        })),
        ...Array.from(this.gauges.entries()).map(([name, g]) => ({
          name,
          type: 'gauge' as const,
          value: g.get(),
          labels: [],
          timestamp: Date.now(),
        })),
        ...Array.from(this.histograms.entries()).map(([name, h]) => ({
          name,
          type: 'histogram' as const,
          value: h.getSum(),
          labels: [],
          timestamp: Date.now(),
        })),
      ],
      capturedAt: Date.now(),
    };
  }

  /**
   * Reset all metrics.
   */
  reset(): void {
    this.metrics.reset();
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}
