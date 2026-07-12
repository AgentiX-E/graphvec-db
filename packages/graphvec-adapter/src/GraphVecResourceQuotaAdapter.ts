/**
 * GraphVecResourceQuotaAdapter — Implements IResourceQuotaManager for the graphvec-db engine.
 *
 * Wraps the src/ops/ResourceQuotaManager class and maps its native config/usage
 * types to the canonical db-operations IResourceQuotaManager interface.
 */

import type { IResourceQuotaManager, IResourceQuota, ResourceUsageSnapshot } from '@agentix-e/db-operations-monitor';
import { ResourceQuotaManager as NativeResourceQuotaManager } from 'graphvec-db/ops/resource-quota';

/**
 * GraphVecResourceQuotaAdapter — adapts the graphvec-db ResourceQuotaManager to
 * the db-operations IResourceQuotaManager interface.
 *
 * The graphvec-db `ResourceQuotaManager` provides memory, query rate, and
 * connection count limits with auto-resetting counters. This adapter wraps it
 * with the canonical interface.
 *
 * @example
 * ```ts
 * const adapter = new GraphVecResourceQuotaAdapter({
 *   maxMemoryMB: 2048,
 *   maxQueriesPerSec: 5000,
 *   maxConnections: 200,
 * });
 * await adapter.setQuota('admin', {
 *   cpuLimit: 8,
 *   memoryLimitMB: 2048,
 *   connectionLimit: 200,
 *   queryRateLimit: 5000,
 * });
 * ```
 */
export class GraphVecResourceQuotaAdapter implements IResourceQuotaManager {
  private nativeManager: NativeResourceQuotaManager;
  private roleQuotas: Map<string, IResourceQuota> = new Map();
  private roleUsage: Map<string, { cpu: number; memoryMB: number; connections: number; queryRate: number }> = new Map();

  constructor(config?: {
    maxMemoryMB?: number;
    maxQueriesPerSec?: number;
    maxConnections?: number;
  }) {
    this.nativeManager = new NativeResourceQuotaManager(config);
    // Set a default quota for system role
    this.roleQuotas.set('__system__', {
      cpuLimit: 0,
      memoryLimitMB: config?.maxMemoryMB ?? 1024,
      connectionLimit: config?.maxConnections ?? 100,
      queryRateLimit: config?.maxQueriesPerSec ?? 1000,
    });
  }

  /**
   * Get the underlying ResourceQuotaManager for native interop.
   */
  get nativeQuotaManager(): NativeResourceQuotaManager {
    return this.nativeManager;
  }

  // ── IResourceQuotaManager implementation ──

  async setQuota(roleId: string, quota: IResourceQuota): Promise<void> {
    this.roleQuotas.set(roleId, { ...quota });
  }

  async getQuota(roleId: string): Promise<IResourceQuota | null> {
    return this.roleQuotas.get(roleId) || null;
  }

  async checkQuota(
    roleId: string,
  ): Promise<{ allowed: boolean; reason?: string }> {
    // First check global rate limit
    if (!this.nativeManager.tryAcquire()) {
      return {
        allowed: false,
        reason: `Query rate limit exceeded (${this.nativeManager.getQueryCount()}/${this.nativeManager.getConfig().maxQueriesPerSec})`,
      };
    }

    // Then check role-specific quota
    const quota = this.roleQuotas.get(roleId);
    if (!quota) {
      return { allowed: true }; // No quota set = allowed
    }

    const usage = await this.getUsage(roleId);

    if (usage.connections >= quota.connectionLimit) {
      return {
        allowed: false,
        reason: `Connection limit exceeded (${usage.connections}/${quota.connectionLimit})`,
      };
    }

    if (usage.memoryMB >= quota.memoryLimitMB) {
      return {
        allowed: false,
        reason: `Memory limit exceeded (${usage.memoryMB}MB/${quota.memoryLimitMB}MB)`,
      };
    }

    if (usage.queryRate >= quota.queryRateLimit) {
      return {
        allowed: false,
        reason: `Query rate limit exceeded (${usage.queryRate}/${quota.queryRateLimit})`,
      };
    }

    return { allowed: true };
  }

  async getUsage(
    roleId: string,
  ): Promise<{ cpu: number; memoryMB: number; connections: number; queryRate: number }> {
    const memoryMB = this.nativeManager.getMemoryUsageMB();
    const queryRate = this.nativeManager.getQueryCount();
    const connections = this._estimateConnections();

    const usage = {
      cpu: Math.round(process.cpuUsage().user / 1_000_000), // seconds
      memoryMB,
      connections,
      queryRate,
    };

    this.roleUsage.set(roleId, usage);
    return usage;
  }

  /**
   * Get a resource usage snapshot.
   */
  async getResourceSnapshot(): Promise<ResourceUsageSnapshot> {
    const memoryBytes = process.memoryUsage().heapUsed;
    const memoryLimitBytes = this.nativeManager.getConfig().maxMemoryMB * 1024 * 1024;
    const memoryUtilization = memoryLimitBytes > 0 ? memoryBytes / memoryLimitBytes : 0;
    const queriesPerSec = this.nativeManager.getQueryCount();
    const maxQueriesPerSec = this.nativeManager.getConfig().maxQueriesPerSec;
    const connections = this._estimateConnections();
    const maxConnections = this.nativeManager.getConfig().maxConnections;
    const poolUtilization = maxConnections > 0 ? connections / maxConnections : 0;
    const cpuPercent = this._estimateCpuPercent();

    return {
      memoryBytes,
      memoryLimitBytes,
      memoryUtilization,
      queriesPerSec,
      maxQueriesPerSec,
      cpuPercent,
      connectionPool: {
        total: maxConnections,
        active: Math.floor(connections * 0.7),
        idle: Math.floor(connections * 0.3),
        waiting: 0,
        maxSize: maxConnections,
        utilization: poolUtilization,
      },
      diskUsedBytes: 0,
      diskFreeBytes: 0,
      timestamp: Date.now(),
    };
  }

  /**
   * Update the native config.
   */
  async updateConfig(config: {
    maxMemoryMB?: number;
    maxQueriesPerSec?: number;
    maxConnections?: number;
  }): Promise<void> {
    this.nativeManager.updateConfig(config);
  }

  /**
   * Dispose the native quota manager.
   */
  dispose(): void {
    this.nativeManager.dispose();
  }

  // ── Private helpers ──

  private _estimateConnections(): number {
    // A rough estimate based on the connection count
    const config = this.nativeManager.getConfig();
    const currentMemoryRatio = this.nativeManager.getMemoryUsageMB() / config.maxMemoryMB;
    return Math.floor(config.maxConnections * Math.min(currentMemoryRatio, 1));
  }

  private _estimateCpuPercent(): number {
    const cpuUsage = process.cpuUsage();
    const totalCpuMicros = cpuUsage.user + cpuUsage.system;
    // Rough estimate: CPU percent based on a ~1 second window
    const elapsedMicros = 1_000_000; // 1 second reference
    return Math.min(100, Math.round((totalCpuMicros / elapsedMicros) * 100));
  }
}
