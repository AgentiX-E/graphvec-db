/**
 * DbClusterConsensusProvider.spec.ts
 *
 * Tests for DbClusterConsensusProvider that bridges db-cluster's IConsensusLayer
 * into graphvec-db's ConsensusProvider interface.
 *
 * All tests use a mock DbClusterIConsensusLayer — no real db-cluster dependency.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DbClusterConsensusProvider, type DbClusterIConsensusLayer } from './DbClusterConsensusProvider';
import type { ConsensusConfig } from './consensus-provider';

// ── Helpers ──────────────────────────────────────────────────

function makeConfig(overrides?: Partial<ConsensusConfig>): ConsensusConfig {
  return {
    mode: 'standalone' as const,
    nodeId: 'node-1',
    peers: [],
    ...overrides,
  };
}

function createMockCluster(): DbClusterIConsensusLayer {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    propose: vi.fn().mockResolvedValue(1),
    isLeader: vi.fn().mockResolvedValue(true),
    getLeader: vi.fn().mockResolvedValue('node-1'),
    getCommitIndex: vi.fn().mockResolvedValue(42),
    registerShard: vi.fn(),
    removeShard: vi.fn().mockResolvedValue(undefined),
    notifyTopologyChange: vi.fn().mockResolvedValue(undefined),
    getHealthStatus: vi.fn().mockResolvedValue([{ node: 'node-1', status: 'healthy' }]),
    campaign: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    setForceLeader: vi.fn(),
  };
}

// ── Tests ────────────────────────────────────────────────────

describe('DbClusterConsensusProvider', () => {
  let mockCluster: DbClusterIConsensusLayer;
  let config: ConsensusConfig;
  let provider: DbClusterConsensusProvider;

  beforeEach(() => {
    mockCluster = createMockCluster();
    config = makeConfig({ mode: 'db-cluster' as any });
    provider = new DbClusterConsensusProvider(mockCluster, config);
  });

  // ── Lifecycle ──────────────────────────────────────────────

  describe('lifecycle', () => {
    it('should delegate start() to cluster', async () => {
      await provider.start();
      expect(mockCluster.start).toHaveBeenCalledTimes(1);
    });

    it('should delegate stop() to cluster', async () => {
      await provider.start();
      await provider.stop();
      expect(mockCluster.stop).toHaveBeenCalledTimes(1);
    });

    it('should set _started flag on start/stop', async () => {
      // Before start
      expect(provider.getLeaderId()).toBeNull();

      await provider.start();
      expect(provider.getLeaderId()).toBe('node-1');

      await provider.stop();
      expect(provider.getLeaderId()).toBeNull();
    });
  });

  // ── Propose ────────────────────────────────────────────────

  describe('propose', () => {
    it('should return ok:false before start', async () => {
      const result = await provider.propose(new Uint8Array([1, 2, 3]));
      expect(result).toEqual({ ok: false });
    });

    it('should base64-encode data and delegate to cluster propose', async () => {
      await provider.start();
      const data = Buffer.from('hello consensus');
      const result = await provider.propose(data);
      expect(result).toEqual({ ok: true });
      expect(mockCluster.propose).toHaveBeenCalledWith(
        '_default',
        Buffer.from('hello consensus').toString('base64'),
      );
    });

    it('should return ok:false when cluster propose fails', async () => {
      vi.mocked(mockCluster.propose).mockRejectedValueOnce(new Error('cluster error'));
      await provider.start();
      const result = await provider.propose(new Uint8Array([1]));
      expect(result).toEqual({ ok: false });
    });
  });

  // ── ReadIndex ──────────────────────────────────────────────

  describe('readIndex', () => {
    it('should throw before start', async () => {
      await expect(provider.readIndex()).rejects.toThrow('not started');
    });

    it('should delegate to getCommitIndex after start', async () => {
      await provider.start();
      await provider.readIndex();
      expect(mockCluster.getCommitIndex).toHaveBeenCalled();
    });
  });

  // ── Barrier ────────────────────────────────────────────────

  describe('barrier', () => {
    it('should be a no-op before start', async () => {
      // Should not throw
      await provider.barrier();
    });

    it('should propose no-op and wait for commit index to advance', async () => {
      // Simulate the commit index advancing after the barrier proposal
      vi.mocked(mockCluster.getCommitIndex)
        .mockResolvedValueOnce(42)   // beforeIndex
        .mockResolvedValueOnce(42)   // retry 1 — not yet
        .mockResolvedValueOnce(43);  // retry 2 — advanced

      await provider.start();
      await provider.barrier(100);

      // Should have proposed a barrier entry
      expect(mockCluster.propose).toHaveBeenCalledWith('_default', '__barrier__');
      // Should have polled getCommitIndex
      expect(mockCluster.getCommitIndex).toHaveBeenCalled();
    });
  });

  // ── Role & leader info ─────────────────────────────────────

  describe('role and leader info', () => {
    it('should return follower role', () => {
      expect(provider.getRole()).toBe('follower');
    });

    it('should return null leader before start', () => {
      expect(provider.getLeaderId()).toBeNull();
    });

    it('should return nodeId leader after start', async () => {
      await provider.start();
      expect(provider.getLeaderId()).toBe('node-1');
    });

    it('should return term 1', () => {
      expect(provider.getTerm()).toBe(1);
    });

    it('should return leader id null after stop', async () => {
      await provider.start();
      await provider.stop();
      expect(provider.getLeaderId()).toBeNull();
    });
  });

  // ── waitForLeader ──────────────────────────────────────────

  describe('waitForLeader', () => {
    it('should throw before start', async () => {
      await expect(provider.waitForLeader()).rejects.toThrow('not started');
    });

    it('should resolve after start', async () => {
      await provider.start();
      await expect(provider.waitForLeader()).resolves.toBeUndefined();
    });
  });

  // ── setApply ───────────────────────────────────────────────

  describe('setApply', () => {
    it('should store apply callback without forwarding to cluster', () => {
      // Reset calls first so the membership_change setup doesn't interfere
      vi.mocked(mockCluster.on).mockClear();
      const fn = vi.fn();
      provider.setApply(fn);
      // The callback is stored locally but not forwarded to db-cluster
      expect(mockCluster.on).not.toHaveBeenCalled();
    });
  });

  // ── Network partition (R9) ─────────────────────────────────

  describe('inMajority', () => {
    it('should return true after start', async () => {
      await provider.start();
      expect(provider.inMajority()).toBe(true);
    });
  });

  describe('onMajorityChange', () => {
    it('should fire callback immediately with current state', () => {
      const cb = vi.fn();
      provider.onMajorityChange(cb);
      expect(cb).toHaveBeenCalledWith(false); // not started yet → false
    });
  });

  // ── Membership changes (R10) ───────────────────────────────

  describe('addPeer / removePeer', () => {
    it('should not throw on addPeer', async () => {
      await expect(provider.addPeer('node-2')).resolves.toBeUndefined();
    });

    it('should not throw on removePeer', async () => {
      await expect(provider.removePeer('node-2')).resolves.toBeUndefined();
    });
  });

  describe('getClusterMembers', () => {
    it('should return empty before start', () => {
      expect(provider.getClusterMembers()).toEqual([]);
    });

    it('should return [nodeId] after start', async () => {
      await provider.start();
      expect(provider.getClusterMembers()).toEqual(['node-1']);
    });
  });

  describe('onMembershipChange', () => {
    it('should accept callback registration', () => {
      const cb = vi.fn();
      expect(() => provider.onMembershipChange(cb)).not.toThrow();
    });

    it('should subscribe to cluster membership_change event on construction', () => {
      expect(mockCluster.on).toHaveBeenCalledWith(
        'membership_change',
        expect.any(Function),
      );
    });

    it('should subscribe to cluster majority_change event on construction', () => {
      expect(mockCluster.on).toHaveBeenCalledWith(
        'majority_change',
        expect.any(Function),
      );
    });
  });

  // ── Constructor event subscriptions ─────────────────────────

  describe('constructor', () => {
    it('should subscribe to cluster events', () => {
      expect(mockCluster.on).toHaveBeenCalledTimes(2);
      expect(mockCluster.on).toHaveBeenCalledWith('membership_change', expect.any(Function));
      expect(mockCluster.on).toHaveBeenCalledWith('majority_change', expect.any(Function));
    });
  });
});
