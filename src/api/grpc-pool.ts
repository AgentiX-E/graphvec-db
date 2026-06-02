// ============================================================
// GrpcClientPool — Connection Pool for gRPC GraphVec Client
//
// Manages a pool of gRPC clients per target address, with
// idle-timeout, health checks, auto-reconnect, and graceful
// shutdown.
// ============================================================

import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import * as path from 'path'
import { GraphVecClient, createGrpcClient } from './grpc-client'

// ── Package Definition (shared singleton, same as grpc-client.ts) ──
const PROTO_PATH = path.resolve(__dirname, 'graph.proto')
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: true,
})
const graphvecProto = grpc.loadPackageDefinition(packageDefinition) as any

// ── Interfaces ──

export interface GrpcPoolOptions {
  /** Maximum number of concurrent connections per address (default: 4) */
  maxPerAddress?: number
  /** Idle timeout in ms — a connection unused for this long is closed (default: 300_000 = 5 min) */
  idleTimeoutMs?: number
  /** Health check interval in ms (default: 60_000 = 1 min) */
  healthCheckIntervalMs?: number
  /** Maximum number of consecutive health check failures before triggering reconnect (default: 3) */
  maxHealthCheckFailures?: number
  /** Logger (default: console) */
  logger?: Pick<Console, 'warn' | 'info' | 'error' | 'debug'>
}

interface PoolEntry {
  client: GraphVecClient
  lastUsed: number
  createdAt: number
  failures: number
}

// ── GrpcClientPool ──

export class GrpcClientPool {
  private readonly pools = new Map<string, PoolEntry[]>()
  private readonly options: Required<GrpcPoolOptions>
  private readonly logger: Required<GrpcPoolOptions['logger']>
  private idleTimer: ReturnType<typeof setInterval> | null = null
  private healthTimer: ReturnType<typeof setInterval> | null = null
  private closed = false

  constructor(options: GrpcPoolOptions = {}) {
    this.options = {
      maxPerAddress: options.maxPerAddress ?? 4,
      idleTimeoutMs: options.idleTimeoutMs ?? 300_000,
      healthCheckIntervalMs: options.healthCheckIntervalMs ?? 60_000,
      maxHealthCheckFailures: options.maxHealthCheckFailures ?? 3,
    }
    this.logger = options.logger ?? console

    // Start maintenance timers
    this.idleTimer = setInterval(() => this._evictIdle(), this.options.idleTimeoutMs / 2)
    this.healthTimer = setInterval(() => this._healthCheckAll(), this.options.healthCheckIntervalMs)
    // Unref so they don't keep the process alive
    if (typeof this.idleTimer === 'object' && 'unref' in this.idleTimer) {
      this.idleTimer.unref()
      this.healthTimer!.unref()
    }
  }

  /**
   * Get a gRPC client for the given address.
   * Returns an existing idle client or creates a new one up to maxPerAddress.
   */
  get(address: string): GraphVecClient {
    if (this.closed) {
      throw new Error('GrpcClientPool is closed')
    }

    let entries = this.pools.get(address)
    if (!entries) {
      entries = []
      this.pools.set(address, entries)
    }

    // Try to find an alive client (prefer the one with least recent failures)
    let bestEntry: PoolEntry | null = null
    for (const entry of entries) {
      if (entry.failures >= this.options.maxHealthCheckFailures) continue
      bestEntry = entry
      break
    }

    if (bestEntry) {
      bestEntry.lastUsed = Date.now()
      return bestEntry.client
    }

    // Create a new connection if under maxPerAddress
    if (entries.length >= this.options.maxPerAddress) {
      // All connections are failing or at capacity — return the least recently used
      entries.sort((a, b) => a.lastUsed - b.lastUsed)
      const oldest = entries[0]
      // Close and replace the oldest one
      this._closeEntry(oldest)
      entries.shift()
    }

    const entry = this._createEntry(address)
    entries.push(entry)
    this.logger.info?.(`[GrpcClientPool] created connection to ${address} (pool size: ${entries.length})`)
    return entry.client
  }

  /**
   * Release a client back to the pool (update its lastUsed timestamp).
   * If the pool is closed, the client is closed instead.
   */
  release(address: string, client: GraphVecClient): void {
    if (this.closed) {
      client.close()
      return
    }
    const entries = this.pools.get(address)
    if (!entries) return
    for (const entry of entries) {
      if (entry.client === client) {
        entry.lastUsed = Date.now()
        return
      }
    }
    // Client not tracked — close it
    client.close()
  }

  /**
   * Health check a specific address's connections.
   * Returns true if at least one connection is healthy.
   */
  async healthCheck(address: string): Promise<boolean> {
    const entries = this.pools.get(address)
    if (!entries || entries.length === 0) return false

    let healthy = false
    for (const entry of entries) {
      try {
        await entry.client.health()
        entry.failures = 0
        healthy = true
      } catch {
        entry.failures++
        this.logger.warn?.(
          `[GrpcClientPool] health check failed for ${address} (failure #${entry.failures})`
        )
        if (entry.failures >= this.options.maxHealthCheckFailures) {
          this._reconnect(address, entry)
        }
      }
    }
    return healthy
  }

  /**
   * Close all connections and stop maintenance timers.
   */
  close(): void {
    this.closed = true

    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer)
      this.healthTimer = null
    }

    for (const [address, entries] of this.pools.entries()) {
      for (const entry of entries) {
        this._closeEntry(entry)
      }
      this.pools.delete(address)
    }
  }

  /**
   * Number of active pool entries across all addresses.
   */
  get totalConnections(): number {
    let count = 0
    for (const entries of this.pools.values()) {
      count += entries.length
    }
    return count
  }

  /**
   * Detailed pool stats (useful for monitoring).
   */
  getStats(): Record<string, { active: number; failing: number }> {
    const stats: Record<string, { active: number; failing: number }> = {}
    for (const [address, entries] of this.pools.entries()) {
      const active = entries.filter(e => e.failures < this.options.maxHealthCheckFailures).length
      const failing = entries.length - active
      stats[address] = { active, failing }
    }
    return stats
  }

  // ── Private Helpers ──

  private _createEntry(address: string): PoolEntry {
    const client = new graphvecProto.graphvec.GraphService(
      address,
      grpc.credentials.createInsecure(),
    )
    return {
      client: this._wrapClient(address, client),
      lastUsed: Date.now(),
      createdAt: Date.now(),
      failures: 0,
    }
  }

  /**
   * Wrap a gRPC client with promisified methods (same pattern as grpc-client.ts)
   * but delegate to the raw client underneath so we can track it in the pool.
   */
  private _wrapClient(address: string, rawClient: any): GraphVecClient {
    function promisify<T>(method: string): (request: any) => Promise<T> {
      return (request: any) =>
        new Promise<T>((resolve, reject) => {
          rawClient[method](request, (err: grpc.ServiceError | null, response: T) => {
            if (err) reject(err)
            else resolve(response)
          })
        })
    }

    const promisified: Record<string, any> = {
      GetNode: promisify<any>('GetNode'),
      AddNode: promisify<any>('AddNode'),
      UpdateNode: promisify<any>('UpdateNode'),
      DeleteNode: promisify<{ success: boolean }>('DeleteNode'),
      GetEdge: promisify<any>('GetEdge'),
      AddEdge: promisify<{ success: boolean }>('AddEdge'),
      UpdateEdge: promisify<any>('UpdateEdge'),
      DeleteEdge: promisify<{ success: boolean }>('DeleteEdge'),
      Query: promisify<{ results: any[]; count: number }>('Query'),
      Neighbors: promisify<any>('Neighbors'),
      BatchNeighbors: promisify<any>('BatchNeighbors'),
      Health: promisify<any>('Health'),
    }

    return {
      getNode: (id: number) => promisified.GetNode({ id }),
      addNode: (typeId: number, name: string, props?: Record<string, string>) =>
        promisified.AddNode({ typeId, name, props: props ?? {} }),
      updateNode: (id: number, props: Record<string, string>) =>
        promisified.UpdateNode({ id, props }),
      deleteNode: (id: number, cascade?: boolean) =>
        promisified.DeleteNode({ id, cascade: cascade ?? false }),
      getEdge: (src: number, dst: number, type: number) =>
        promisified.GetEdge({ src, dst, type }),
      addEdge: (src: number, dst: number, typeId: number, props?: Record<string, string>, weight?: number) =>
        promisified.AddEdge({ src, dst, typeId, props: props ?? {}, weight: weight ?? 0 }),
      updateEdge: (src: number, dst: number, typeId: number, props: Record<string, string>) =>
        promisified.UpdateEdge({ src, dst, typeId, props }),
      deleteEdge: (src: number, dst: number, typeId: number) =>
        promisified.DeleteEdge({ src, dst, typeId }),
      query: (queryStr: string, limit?: number, skip?: number) =>
        promisified.Query({ query: queryStr, limit: limit ?? 0, skip: skip ?? 0 }),
      neighbors: (nodeId: number, maxDepth?: number, edgeTypeFilter?: number[]) =>
        promisified.Neighbors({ nodeId, maxDepth: maxDepth ?? 1, edgeTypeFilter: edgeTypeFilter ?? [] }),
      batchNeighbors: (ids: number[], maxDepth?: number, edgeTypeFilter?: number[]) =>
        promisified.BatchNeighbors({ ids, maxDepth: maxDepth ?? 1, edgeTypeFilter: edgeTypeFilter ?? [] }),
      health: () => promisified.Health({}),
      close: () => rawClient.close(),
    }
  }

  private _closeEntry(entry: PoolEntry): void {
    try {
      entry.client.close()
    } catch {
      // ignore close errors
    }
  }

  private _reconnect(address: string, entry: PoolEntry): void {
    this.logger.info?.(`[GrpcClientPool] reconnecting to ${address}`)
    this._closeEntry(entry)
    // Remove from pool list
    const entries = this.pools.get(address)
    if (entries) {
      const idx = entries.indexOf(entry)
      if (idx >= 0) entries.splice(idx, 1)
    }
    // Create new entry
    const newEntry = this._createEntry(address)
    if (entries) {
      entries.push(newEntry)
    }
  }

  private _evictIdle(): void {
    const now = Date.now()
    for (const [address, entries] of this.pools.entries()) {
      const alive: PoolEntry[] = []
      for (const entry of entries) {
        if (now - entry.lastUsed > this.options.idleTimeoutMs) {
          this.logger.info?.(
            `[GrpcClientPool] evicting idle connection to ${address} (idle ${now - entry.lastUsed}ms)`
          )
          this._closeEntry(entry)
        } else {
          alive.push(entry)
        }
      }
      if (alive.length === 0) {
        this.pools.delete(address)
      } else {
        this.pools.set(address, alive)
      }
    }
  }

  private _healthCheckAll(): void {
    for (const address of this.pools.keys()) {
      this.healthCheck(address).catch(() => {
        // health check errors are logged inside healthCheck
      })
    }
  }
}
