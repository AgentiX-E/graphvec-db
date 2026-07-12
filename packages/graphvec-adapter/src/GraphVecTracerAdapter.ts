/**
 * GraphVecTracerAdapter — Implements IDistributedTracer for the graphvec-db engine.
 *
 * Wraps the src/ops/Telemetry class (OpenTelemetry-based tracing) and maps
 * its API to the canonical db-operations IDistributedTracer interface.
 *
 * When OTel is not enabled, falls back to a lightweight in-memory tracer
 * that maintains span trees without external exporters.
 */

import { type IDistributedTracer, type Span } from '@agentix-e/db-operations-observability';
import { Telemetry } from 'graphvec-db/ops/otel';
import { v4 as uuidv4 } from 'uuid';

/**
 * In-memory span for when OTel is not enabled.
 */
interface MemorySpan {
  spanId: string;
  parentSpanId?: string;
  traceId: string;
  name: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, string | number | boolean>;
  status: 'ok' | 'error';
  errorMessage?: string;
}

/**
 * GraphVecTracerAdapter — adapts the graphvec-db Telemetry/OpenTelemetry
 * tracing to the db-operations IDistributedTracer interface.
 *
 * Uses the native OTel Tracer when Telemetry is enabled, and falls back to
 * in-memory span tracking when Telemetry is not initialized.
 *
 * @example
 * ```ts
 * const adapter = new GraphVecTracerAdapter();
 * const { spanId, end } = adapter.startSpan('query.execute', {
 *   attributes: { queryType: 'match' },
 * });
 * // ... do work ...
 * end('ok');
 * ```
 */
export class GraphVecTracerAdapter implements IDistributedTracer {
  private telemetry: Telemetry;
  private memorySpans: Map<string, MemorySpan> = new Map();
  private currentSpanId: string | undefined;
  private currentTraceId: string | undefined;
  private completedSpans: Span[] = [];

  constructor() {
    this.telemetry = Telemetry.getInstance();
  }

  /**
   * Whether OTel is enabled and the native tracer is available.
   */
  get isOTelEnabled(): boolean {
    // _enabled and tracer are private on Telemetry; we use a flag tracked by initOTel
    return this._otelInitialized;
  }
  private _otelInitialized = false;

  // ── IDistributedTracer implementation ──

  startSpan(
    name: string,
    options?: {
      parentSpanId?: string;
      traceId?: string;
      attributes?: Record<string, string | number | boolean>;
    },
  ): { spanId: string; end: (status?: 'ok' | 'error', errorMessage?: string) => void } {
    const traceId = options?.traceId || uuidv4();
    const spanId = uuidv4();
    const parentSpanId = options?.parentSpanId || this.currentSpanId;

    if (this.isOTelEnabled) {
      // Use native OTel tracer
      const otelApi = (globalThis as any)['@opentelemetry/api'];
      if (otelApi) {
        const tracer = otelApi.trace.getTracer('graphvec-db');
        const span = tracer.startSpan(name);
        return {
          spanId,
          end: (status?: 'ok' | 'error', errorMessage?: string) => {
            if (status === 'error') {
              span.setStatus({ code: otelApi.SpanStatusCode.ERROR, message: errorMessage });
            }
            span.end();
          },
        };
      }
    }

    // Fallback: in-memory span tracking
    const span: MemorySpan = {
      spanId,
      parentSpanId,
      traceId,
      name,
      startTime: Date.now(),
      attributes: options?.attributes || {},
      status: 'ok',
    };

    this.memorySpans.set(spanId, span);
    this.currentSpanId = spanId;
    this.currentTraceId = traceId;

    return {
      spanId,
      end: (status?: 'ok' | 'error', errorMessage?: string) => {
        const existing = this.memorySpans.get(spanId);
        if (existing) {
          existing.endTime = Date.now();
          existing.status = status || 'ok';
          existing.errorMessage = errorMessage;
          // Move to completed spans for export
          this.completedSpans.push({
            spanId: existing.spanId,
            parentSpanId: existing.parentSpanId,
            traceId: existing.traceId,
            name: existing.name,
            startTime: existing.startTime,
            endTime: existing.endTime,
            attributes: existing.attributes,
            status: existing.status,
            errorMessage: existing.errorMessage,
          });
          this.memorySpans.delete(spanId);
        }
      },
    };
  }

  getCurrentSpan(): { traceId: string; spanId: string } | undefined {
    if (this.currentTraceId && this.currentSpanId) {
      return { traceId: this.currentTraceId, spanId: this.currentSpanId };
    }
    return undefined;
  }

  getCompletedSpans(): Span[] {
    return [...this.completedSpans];
  }

  clearCompletedSpans(): void {
    this.completedSpans = [];
  }

  inject(carrier: Record<string, string>): void {
    const current = this.getCurrentSpan();
    if (current) {
      // W3C Trace Context format
      carrier['traceparent'] = `00-${current.traceId}-${current.spanId}-01`;
      carrier['tracestate'] = '';
    }
  }

  extract(
    carrier: Record<string, string>,
  ): { traceId: string; parentSpanId: string } | undefined {
    const traceparent = carrier['traceparent'];
    if (traceparent) {
      // Parse W3C Trace Context: version-traceId-spanId-flags
      const parts = traceparent.split('-');
      if (parts.length >= 3) {
        const traceId = parts[1];
        const parentSpanId = parts[2];
        // Set as current
        this.currentTraceId = traceId;
        this.currentSpanId = parentSpanId;
        return { traceId, parentSpanId };
      }
    }
    return undefined;
  }

  /**
   * Start the native OTel Telemetry if not yet started.
   */
  async initOTel(serviceName: string = 'graphvec-db', serviceVersion: string = '0.1.0'): Promise<void> {
    if (this._otelInitialized) return;
    try {
      this.telemetry.initSdk();
      this.telemetry.startTracing(serviceName, serviceVersion);
      this._otelInitialized = true;
    } catch {
      // OTel init failure is non-fatal; in-memory fallback will be used
    }
  }

  /**
   * Shut down the native OTel Telemetry.
   */
  async shutdownOTel(): Promise<void> {
    try {
      await this.telemetry.shutdown();
    } catch {
      // Ignore shutdown errors
    }
  }
}
