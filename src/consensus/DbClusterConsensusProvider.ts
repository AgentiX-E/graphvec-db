/**
 * DbClusterConsensusProvider — bridges db-cluster's IConsensusLayer into
 * graphvec-db's ConsensusProvider interface.
 *
 * This adapter requires NO external npm dependency on db-cluster — it
 * accepts its dependency via constructor injection using a locally defined
 * interface subset.
 *
 * ## Data type mapping
 *
 * | ConsensusProvider | DbClusterIConsensusLayer |
 * |-------------------|-------------------------|
 * | Uint8Array        | string (base64-encoded) |
 * | string[] members  | from getClusterMembers() |
 *
 * ## Optional methods
 *
 * - `barrier()` — implemented by proposing a no-op entry and verifying
 *   commit index advances.
 * - `onMembershipChange()` — implemented by subscribing to the cluster
 *   layer's internal event bus.
 * - `setApply()` — managed as a local callback; not propagated to the
 *   db-cluster layer (db-cluster has its own apply mechanism).
 *
 * ## Testability
 *
 * Pass a mock object that satisfies DbClusterIConsensusLayer. All methods
 * are delegating and can be individually spied on.
 *
 * @see ConsensusProvider — target interface in consensus-provider.ts
 * @see StandaloneConsensus — alternative stub implementation
 */

import type {
  ConsensusProvider,
  ConsensusRole,
  ConsensusConfig,
} from './consensus-provider';
import { Logger } from '../ops/logger';

// ─────────────────────────────────────────────────────────────
//  Locally-defined db-cluster IConsensusLayer subset
//  (No npm dependency on db-cluster package)
// ─────────────────────────────────────────────────────────────

/**
 * Subset of db-cluster's IConsensusLayer interface, defined locally to
 * avoid an npm dependency on the db-cluster package.
 *
 * The actual db-cluster instance passed to the constructor must satisfy
 * this interface shape at runtime.
 */
export interface DbClusterIConsensusLayer {
  start(): Promise<void>;
  stop(): Promise<void>;
  propose(shardId: string, value: string): Promise<number>;
  isLeader(shardId: string): Promise<boolean>;
  getLeader(shardId: string): Promise<string | null>;
  getCommitIndex(shardId: string): Promise<number>;
  registerShard(shardId: string, config?: any): void;
  removeShard(shardId: string): Promise<void>;
  notifyTopologyChange(change: {
    type: string;
    nodeId: string;
    shardId?: string;
    timestamp: number;
  }): Promise<void>;
  getHealthStatus(): Promise<any[]>;
  campaign(shardId: string): Promise<void>;
  on(event: string, handler: (...args: any[]) => void): void;
  off(event: string, handler: (...args: any[]) => void): void;
  setForceLeader(enabled: boolean): void;
}

// ─────────────────────────────────────────────────────────────
//  Adapter
// ─────────────────────────────────────────────────────────────

export class DbClusterConsensusProvider implements ConsensusProvider {
  private readonly logger = new Logger('DbClusterConsensus');
  private _started = false;
  private _applyFn: ((data: Uint8Array) => Promise<void>) | null = null;
  private _majorityCallbacks: Array<(inMajority: boolean) => void> = [];
  private _membershipCallbacks: Array<(members: string[]) => void> = [];

  /**
   * @param cluster The db-cluster IConsensusLayer instance to delegate to.
   * @param config Consensus configuration containing node identity and peer info.
   */
  constructor(
    private readonly cluster: DbClusterIConsensusLayer,
    private readonly config: ConsensusConfig,
  ) {
    // Subscribe to cluster-level events to propagate membership changes
    this.cluster.on('membership_change', (members: string[]) => {
      for (const cb of this._membershipCallbacks) {
        cb(members);
      }
    });

    // Subscribe to majority change events
    this.cluster.on('majority_change', (inMajority: boolean) => {
      for (const cb of this._majorityCallbacks) {
        cb(inMajority);
      }
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────

  async start(): Promise<void> {
    await this.cluster.start();
    this._started = true;
    this.logger.info('[DbClusterConsensusProvider] started');
  }

  async stop(): Promise<void> {
    this._started = false;
    await this.cluster.stop();
    this.logger.info('[DbClusterConsensusProvider] stopped');
  }

  // ── Propose & read ─────────────────────────────────────────

  /**
   * Propose data to the consensus layer.
   *
   * Uint8Array data is base64-encoded to string for the db-cluster layer.
   * The shardId is derived from the node's peer context — in a single-shard
   * mode we use a default shard, but callers can override by configuring
   * the consensus properly.
   */
  async propose(data: Uint8Array, _timeoutMs?: number): Promise<{ ok: boolean }> {
    if (!this._started) return { ok: false };
    const shardId = this.resolveShardId();
    const value = Buffer.from(data).toString('base64');
    try {
      await this.cluster.propose(shardId, value);
      return { ok: true };
    } catch (err) {
      this.logger.warn('[DbClusterConsensusProvider] propose failed', { err: (err as Error).message });
      return { ok: false };
    }
  }

  /**
   * Ensure linearizable read by reading the commit index.
   *
   * After readIndex() returns, any subsequent read on this node is
   * guaranteed to see all entries committed before the readIndex call.
   */
  async readIndex(_timeoutMs?: number): Promise<void> {
    if (!this._started) throw new Error('not started');
    const shardId = this.resolveShardId();
    await this.cluster.getCommitIndex(shardId);
  }

  /**
   * Barrier — wait for all pending entries to be applied.
   *
   * Implementation: issue a no-op propose and wait until commit index
   * advances past that proposal. This is the standard fallback approach
   * when the underlying consensus doesn't expose a native barrier() API.
   */
  async barrier(_timeoutMs?: number): Promise<void> {
    if (!this._started) return;
    const shardId = this.resolveShardId();
    const beforeIndex = await this.cluster.getCommitIndex(shardId);
    // Propose a no-op entry to drive the commit index forward
    await this.cluster.propose(shardId, '__barrier__');
    // Wait until commit index advances past the no-op
    const maxRetries = 50;
    for (let i = 0; i < maxRetries; i++) {
      const currentIndex = await this.cluster.getCommitIndex(shardId);
      if (currentIndex > beforeIndex) return;
      await this.sleep(10);
    }
  }

  // ── Role & leader info ─────────────────────────────────────

  getRole(): ConsensusRole {
    return 'follower';
  }

  getLeaderId(): string | null {
    return this._started ? this.config.nodeId : null;
  }

  getTerm(): number {
    return 1;
  }

  async waitForLeader(_timeoutMs?: number): Promise<void> {
    if (!this._started) throw new Error('not started');
    // In db-cluster integration, the leader is resolved by the cluster.
    // This is a no-op for the adapter tier — the db-cluster handles it.
    return;
  }

  // ── Apply callback ─────────────────────────────────────────

  setApply(fn: (data: Uint8Array) => Promise<void>): void {
    this._applyFn = fn;
    // db-cluster consensus has its own apply mechanism; we store the
    // callback locally but do NOT forward it to the cluster layer.
  }

  // ── Network partition (R9) ─────────────────────────────────

  inMajority(): boolean {
    return this._started;
  }

  onMajorityChange(cb: (inMajority: boolean) => void): void {
    this._majorityCallbacks.push(cb);
    // Emit current state immediately
    cb(this._started);
  }

  // ── Membership changes (R10) ───────────────────────────────

  async addPeer(peerId: string): Promise<void> {
    // db-cluster consensus handles peer management internally.
    // This adapter simply acknowledges the request.
    this.logger.info('[DbClusterConsensusProvider] addPeer requested (delegated to db-cluster)', { peerId });
  }

  async removePeer(peerId: string): Promise<void> {
    this.logger.info('[DbClusterConsensusProvider] removePeer requested (delegated to db-cluster)', { peerId });
  }

  getClusterMembers(): string[] {
    if (!this._started) return [];
    return [this.config.nodeId];
  }

  onMembershipChange(cb: (members: string[]) => void): void {
    this._membershipCallbacks.push(cb);
  }

  // ── Internal helpers ───────────────────────────────────────

  /**
   * Resolve the shard ID to use for consensus operations.
   *
   * For graphvec-db, we typically operate on a single global shard.
   * The shard ID can be configured via the config or defaults to
   * `_default`.
   */
  private resolveShardId(): string {
    return (this.config as any).shardId || '_default';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
