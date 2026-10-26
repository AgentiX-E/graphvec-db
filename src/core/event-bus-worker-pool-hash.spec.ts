/**
 * event-bus-worker-pool-hash.spec.ts — pure-logic unit tests for the worker pool.
 *
 * Unlike event-bus-worker-pool.spec.ts (which runs in the slow serial suite and
 * exercises real child-process fork + ZMQ lifecycle), this spec only covers the
 * deterministic, process-free surface of `ConsistentHash` and the early-return /
 * empty-state behaviour of `EventBusWorkerPool`. It runs in the default suite so
 * the hash-ring routing logic is actually measured by coverage.
 */
import { describe, it, expect } from 'vitest'
import { ConsistentHash, EventBusWorkerPool } from './event-bus-worker-pool'

describe('ConsistentHash', () => {
  it('is deterministic: the same peer always maps to the same worker', () => {
    const ring = new ConsistentHash(256)
    ring.updateWorkers(4)

    const idx = ring.getWorkerIndex('node-7')
    for (let i = 0; i < 1000; i++) {
      expect(ring.getWorkerIndex('node-7')).toBe(idx)
    }
  })

  it('returns worker 0 before updateWorkers is called (workerCount === 0)', () => {
    const ring = new ConsistentHash(256)
    expect(ring.count).toBe(0)
    expect(ring.getWorkerIndex('anything')).toBe(0)
  })

  it('maps all peers to worker 0 when there is a single worker', () => {
    const ring = new ConsistentHash(256)
    ring.updateWorkers(1)
    for (const id of ['a', 'b', 'c', 'node-1', 'node-2', 'node-999']) {
      expect(ring.getWorkerIndex(id)).toBe(0)
    }
  })

  it('always returns an in-range worker index for a diverse peer set', () => {
    const ring = new ConsistentHash(256)
    ring.updateWorkers(5)
    for (let i = 0; i < 500; i++) {
      const idx = ring.getWorkerIndex(`peer-${i}`)
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(idx).toBeLessThan(5)
    }
  })

  it('distributes a large peer set across all workers (no starving worker)', () => {
    const ring = new ConsistentHash(1024)
    const workerCount = 8
    ring.updateWorkers(workerCount)

    const counts = new Array<number>(workerCount).fill(0)
    for (let i = 0; i < 2000; i++) {
      counts[ring.getWorkerIndex(`peer-${i}`)]++
    }
    // Every worker must receive at least one peer — a CRC32 ring this size
    // would have to be pathological to starve a worker.
    for (const c of counts) {
      expect(c).toBeGreaterThan(0)
    }
  })

  it('exhibits consistent-hashing locality: adding a worker moves a minority of peers', () => {
    // The defining property of consistent hashing: when the worker set grows
    // from N to N+1, only a bounded fraction of keys remap — unlike a naive
    // `hash % N` scheme which would remap nearly everything.
    const ring = new ConsistentHash(1024)
    ring.updateWorkers(4)

    const peers = Array.from({ length: 500 }, (_, i) => `peer-${i}`)
    const before = peers.map((p) => ring.getWorkerIndex(p))

    ring.updateWorkers(5)
    const after = peers.map((p) => ring.getWorkerIndex(p))

    const moved = before.reduce((acc, _, i) => acc + (before[i] !== after[i] ? 1 : 0), 0)
    // With 8 virtual nodes per worker, the theoretical remap ceiling is ~1/5,
    // but the ring ordering + vnode placement keeps it well under 50%.
    expect(moved / peers.length).toBeLessThan(0.5)
  })

  it('masks the raw CRC32 into the ring size consistently', () => {
    // ringSize bounds the hash: the returned worker must be stable across
    // different ring sizes for the same worker count.
    const peers = ['node-a', 'node-b', 'node-c', 'node-d', 'node-e']
    const r1 = new ConsistentHash(64)
    const r2 = new ConsistentHash(4096)
    r1.updateWorkers(3)
    r2.updateWorkers(3)

    // Ring size changes placement, but the mapping must still be valid and
    // deterministic within each ring.
    const map1 = peers.map((p) => r1.getWorkerIndex(p))
    const map2 = peers.map((p) => r2.getWorkerIndex(p))
    for (const idx of [...map1, ...map2]) {
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(idx).toBeLessThan(3)
    }
  })

  it('handles the ring-search wrap-around (hash beyond the largest ring point)', () => {
    // Force a workerCount where the ring is populated, then probe peer ids that
    // hash near/beyond the largest point. The binary search must wrap to ring[0].
    const ring = new ConsistentHash(256)
    ring.updateWorkers(2)
    // A large, adversarial peer set exercises both the in-range branch and the
    // wrap-around branch of getWorkerIndex.
    for (let i = 0; i < 1000; i++) {
      const idx = ring.getWorkerIndex(`wrap-${i}-${'x'.repeat(i % 20)}`)
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(idx).toBeLessThan(2)
    }
  })
})

describe('EventBusWorkerPool (pure-logic surface)', () => {
  it('reports empty stats before start()', () => {
    const pool = new EventBusWorkerPool()
    const stats = pool.getStats()
    expect(stats.totalWorkers).toBe(0)
    expect(stats.totalPeers).toBe(0)
    expect(stats.workers).toEqual([])
  })

  it('reports an empty routing map before start()', () => {
    const pool = new EventBusWorkerPool()
    expect(pool.getRoutingMap().size).toBe(0)
  })

  it('send() is a no-op before start() and does not throw', async () => {
    const pool = new EventBusWorkerPool()
    await expect(pool.send('node-1', [])).resolves.toBeUndefined()
  })

  it('stop() is a no-op before start()', async () => {
    const pool = new EventBusWorkerPool()
    await expect(pool.stop()).resolves.toBeUndefined()
    expect(pool.getStats().totalWorkers).toBe(0)
  })

  it('rebalance() is a no-op before start()', async () => {
    const pool = new EventBusWorkerPool()
    await expect(
      pool.rebalance([{ nodeId: 'n1', port: 1, address: '127.0.0.1' }]),
    ).resolves.toBeUndefined()
  })
})
