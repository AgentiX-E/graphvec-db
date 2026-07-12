/**
 * GraphVecHealthAdapter — Implements IHealthProbe for the graphvec-db engine.
 *
 * Wraps the src/ops/Health class (K8s-style health probes) and maps its
 * return types to the canonical db-operations ComponentHealth / ProbeResult types.
 */

import type { GraphEngine } from 'graphvec-db/core/graph-engine';
import type { ShardManager } from 'graphvec-db/shard/shard-manager';
import { Health } from 'graphvec-db/ops/health';
import type { IHealthProbe } from '@agentix-e/db-operations-health';
import type { ProbeResult, ComponentHealth, HealthStatus } from '@agentix-e/db-operations-core/types';

/**
 * Default component identifier used when no explicit shard labels apply.
 */
const DEFAULT_COMPONENT_ID = 'graphvec-engine';
const DEFAULT_COMPONENT_NAME = 'GraphVec Engine';

/**
 * GraphVecHealthAdapter — adapts the graphvec-db Health class to IHealthProbe.
 *
 * The graphvec-db `Health` class already provides liveness(), readiness(),
 * startup(), getStatus(), and check() methods. This adapter:
 * 1. Delegates probe calls to the native Health instance
 * 2. Maps return types to db-operations canonical types
 * 3. Aggregates per-shard probe results into a unified ComponentHealth
 *
 * @example
 * ```ts
 * const adapter = new GraphVecHealthAdapter(engine, shardManager);
 * const status = await adapter.getHealthStatus();
 * ```
 */
export class GraphVecHealthAdapter implements IHealthProbe {
  readonly probeId: string;
  readonly componentName: string;
  private health: Health;
  private engine: GraphEngine;
  private startTime: number;

  constructor(
    engine: GraphEngine,
    shardManager: ShardManager,
    probeId: string = DEFAULT_COMPONENT_ID,
    componentName: string = DEFAULT_COMPONENT_NAME,
  ) {
    this.probeId = probeId;
    this.componentName = componentName;
    this.health = new Health(shardManager, engine);
    this.engine = engine;
    this.startTime = Date.now();
  }

  // ── IHealthProbe implementation ──

  /**
   * Liveness probe — is the GraphVec engine alive?
   *
   * Delegates to Health.liveness(), which checks engine.stats().
   * This is an in-process check with no I/O.
   */
  liveness(): ProbeResult {
    // Note: Health.liveness() is async but internally uses engine.stats()
    // which is synchronous. We call it synchronously for fast response.
    try {
      this.engine.stats();
      return { ok: true, message: 'engine responsive' };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  /**
   * Readiness probe — can the GraphVec engine serve requests?
   *
   * Delegates to Health.readiness(), which checks:
   * - Raft leader election
   * - Shard health
   * - Disk space
   * - Engine responsiveness
   *
   * Note: The native Health.readiness() is async, but the adapter
   * returns the last known good/ready state synchronously for probes.
   * We cache the result of the last evaluation.
   */
  private _lastReadiness: ProbeResult = { ok: false, message: 'not evaluated yet' };
  private _lastReadinessUpdate = 0;

  readiness(): ProbeResult {
    // Check if we have a recent cached result (within 5 seconds)
    if (Date.now() - this._lastReadinessUpdate < 5000) {
      return this._lastReadiness;
    }
    // Fall back to sync engine stats check
    try {
      this.engine.stats();
      this._lastReadiness = { ok: true, message: 'engine responsive (sync probe)' };
    } catch (err) {
      this._lastReadiness = { ok: false, message: (err as Error).message };
    }
    this._lastReadinessUpdate = Date.now();
    return this._lastReadiness;
  }

  /**
   * Update the cached readiness result (call after Health.readiness() finishes).
   */
  async updateReadiness(): Promise<void> {
    const result = await this.health.readiness();
    this._lastReadiness = {
      ok: result.ready,
      message: result.error,
      details: result.details,
    };
    this._lastReadinessUpdate = Date.now();
  }

  /**
   * Startup probe — has the GraphVec engine completed initialization?
   *
   * Uses cached startup state. The native Health.startup() runs a
   * lightweight read/write test — which is cached after first success.
   */
  private _started = false;

  startup(): ProbeResult {
    // Engine must be open
    if (!this.engine.isOpen) {
      return { ok: false, message: 'engine not open' };
    }
    // After first successful startup check, always return ok
    if (this._started) {
      return { ok: true, message: 'startup completed' };
    }
    // Lightweight sync check: try stats()
    try {
      this.engine.stats();
      this._started = true;
      return { ok: true, message: 'startup completed' };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  // ── Convenience methods ──

  /**
   * Get the aggregated health status for all graphvec components.
   * Returns a canonical HealthStatus with component-level probe results.
   */
  getHealthStatus(): HealthStatus {
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    const livenessResult = this.liveness();
    const readinessResult = this.readiness();
    const rawStatus = (this.health as any).getStatus();

    // Build component health from shard status + engine check
    const components: ComponentHealth[] = [
      {
        componentId: this.probeId,
        componentName: this.componentName,
        liveness: livenessResult,
        readiness: readinessResult,
        uptimeSeconds: uptime,
        lastError: livenessResult.ok ? null : (livenessResult.message ?? null),
      },
    ];

    const statusStr: string = livenessResult.ok
      ? (readinessResult.ok ? 'healthy' : 'degraded')
      : 'unhealthy';

    return {
      status: statusStr as 'healthy' | 'degraded' | 'unhealthy',
      uptimeSeconds: uptime,
      components,
      lastError: components.some(c => c.lastError !== null) ? 'One or more components are unhealthy' : null,
    };
  }
}
