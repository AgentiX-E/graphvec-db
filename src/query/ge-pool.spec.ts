/**
 * ge-pool.ts — GEPool connection-pool unit tests.
 *
 * Strategy: drive the real GraphEngine against per-test distinct on-disk
 * directories so allocation / release / reclaim / destroy branches are hit
 * deterministically without leaking nodes between tests.  Each test cleans up
 * its own pool and disk state.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { GEPool, getDefaultPool } from './ge-pool'
import { GraphEngine } from '../core/graph-engine'

let testSeq = 0
function tmpDir(): string {
  testSeq += 1
  return path.join('/tmp', `ge-pool-spec-${process.pid}-${testSeq}`)
}

// Always restore the singleton + default-pool cache to pristine state.
afterEach(() => {
  GEPool.destroyInstanceWithCleanup()
})

describe('GEPool — singleton lifecycle', () => {
  it('getInstance returns the same singleton and empty defaults', () => {
    GEPool.destroyInstanceWithCleanup()
    const a = GEPool.getInstance()
    const b = GEPool.getInstance()
    expect(b).toBe(a)
    expect(a.totalCount).toBe(0)
    expect(a.activeCount).toBe(0)
    expect(a.idleCount).toBe(0)
  })

  it('destroyInstance releases the singleton', () => {
    const pool = GEPool.getInstance({ config: { path: tmpDir() } })
    pool.getConnection()
    GEPool.destroyInstance()
    const fresh = GEPool.getInstance()
    expect(fresh).not.toBe(pool)
    expect(fresh.totalCount).toBe(0)
  })

  it('markNeedsRebuild forces a fresh singleton on next getInstance', () => {
    const first = GEPool.getInstance({ config: { path: tmpDir() } })
    GEPool.markNeedsRebuild()
    const second = GEPool.getInstance()
    expect(second).not.toBe(first)
  })

  it('destroyInstanceWithCleanup resets and clears disk dirs', () => {
    const dir = tmpDir()
    const pool = GEPool.getInstance({ config: { path: dir } })
    pool.getConnection()
    expect(fs.existsSync(dir)).toBe(true)
    GEPool.destroyInstanceWithCleanup()
    expect(GEPool.getInstance().totalCount).toBe(0)
  })

  it('destroyInstance is a no-op when the singleton is already null', () => {
    GEPool.destroyInstanceWithCleanup()
    GEPool.destroyInstance()
    expect(GEPool.getInstance().totalCount).toBe(0)
  })
})

describe('GEPool — allocation / release / reuse', () => {
  it('honours maxSize: caps instances and reuses LRU when busy', () => {
    const pool = GEPool.getInstance({ maxSize: 2, config: { path: tmpDir() } })
    pool.getConnection()
    pool.getConnection()
    expect(pool.totalCount).toBe(2)
    expect(pool.activeCount).toBe(2)
    // Third request with all busy reuses LRU instead of creating a 3rd.
    pool.getConnection(true)
    expect(pool.totalCount).toBe(2)
  })

  it('reuses idle instances on subsequent reads', () => {
    const pool = GEPool.getInstance({ config: { path: tmpDir() } })
    const a = pool.getConnection()
    pool.releaseConnection(a)
    expect(pool.idleCount).toBe(1)
    expect(pool.activeCount).toBe(0)
    const b = pool.getConnection()
    expect(pool.totalCount).toBe(1)
    expect(pool.activeCount).toBe(1)
    expect(pool.idleCount).toBe(0)
  })

  it('write requests grab an idle instance exclusively', () => {
    const pool = GEPool.getInstance({ config: { path: tmpDir() } })
    const a = pool.getConnection()
    pool.releaseConnection(a)
    const w = pool.getConnection(true)
    expect(pool.activeCount).toBe(1)
    expect(pool.totalCount).toBe(1)
  })

  it('releaseConnection is a no-op for a foreign engine', () => {
    const pool = GEPool.getInstance({ config: { path: tmpDir() } })
    pool.getConnection()
    const foreign = new GraphEngine({ path: '/tmp/foreign-' + process.pid + '-' + (++testSeq) } as any)
    pool.releaseConnection(foreign)
    expect(pool.activeCount).toBe(1)
    expect(pool.totalCount).toBe(1)
  })

  it('clear() closes all instances and stops the timer', () => {
    const pool = GEPool.getInstance({ config: { path: tmpDir() } })
    pool.getConnection()
    pool.getConnection()
    expect(pool.totalCount).toBe(2)
    pool.clear()
    expect(pool.totalCount).toBe(0)
    expect(pool.activeCount).toBe(0)
    expect(pool.idleCount).toBe(0)
  })
})

describe('GEPool — default-config creation', () => {
  it('_createGE without config uses the default pid dir', () => {
    const pool = GEPool.getInstance() // no config
    pool.getConnection()
    expect(pool.totalCount).toBe(1)
  })
})

describe('GEPool — config with falsy path (L226 || null)', () => {
  it('falls back to null poolDir then surfaces the underlying GE open error', () => {
    GEPool.destroyInstanceWithCleanup()
    const pool = GEPool.getInstance({ config: { path: '' } as any })
    // _createGE sets _poolDir = ('' || null) = null, then GraphEngine.open() throws.
    expect(() => pool.getConnection()).toThrow()
  })
})

describe('GEPool — cleanup with externally-deleted dir', () => {
  it('skips the dir loop when the pool dir no longer exists at cleanup time', () => {
    const dir = tmpDir()
    const pool = GEPool.getInstance({ config: { path: dir } })
    pool.getConnection() // GraphEngine.open() creates the dir
    expect(fs.existsSync(dir)).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
    GEPool.destroyInstanceWithCleanup()
    expect(GEPool.getInstance().totalCount).toBe(0)
  })

  it('destroyInstanceWithCleanup is a no-op when singleton is already null', () => {
    GEPool.destroyInstanceWithCleanup()
    GEPool.destroyInstanceWithCleanup()
    expect(GEPool.getInstance().totalCount).toBe(0)
  })
})

describe('GEPool — getDefaultPool', () => {
  it('returns a GEPool singleton', () => {
    GEPool.destroyInstanceWithCleanup()
    const pool = getDefaultPool()
    expect(pool).toBeInstanceOf(GEPool)
  })

  it('returns the cached default pool on repeat calls', () => {
    GEPool.destroyInstanceWithCleanup()
    const p1 = getDefaultPool()
    const p2 = getDefaultPool()
    expect(p1).toBe(p2)
  })
})

describe('GEPool — warmup (_ensureWarmup)', () => {
  it('seeds a pooled instance when /tmp/tckge-pool already exists', () => {
    GEPool.destroyInstanceWithCleanup()
    if (fs.existsSync('/tmp/tckge-pool')) fs.rmSync('/tmp/tckge-pool', { recursive: true, force: true })
    fs.mkdirSync('/tmp/tckge-pool', { recursive: true })
    try {
      const pool = GEPool.getInstance({ warmup: true })
      expect(pool.totalCount).toBeGreaterThanOrEqual(1)
    } finally {
      GEPool.destroyInstanceWithCleanup()
      if (fs.existsSync('/tmp/tckge-pool')) fs.rmSync('/tmp/tckge-pool', { recursive: true, force: true })
    }
  })

  it('is a no-op when /tmp/tckge-pool is absent', () => {
    GEPool.destroyInstanceWithCleanup()
    if (fs.existsSync('/tmp/tckge-pool')) fs.rmSync('/tmp/tckge-pool', { recursive: true, force: true })
    try {
      const pool = GEPool.getInstance({ warmup: true })
      expect(pool.totalCount).toBe(0)
    } finally {
      GEPool.destroyInstanceWithCleanup()
      if (fs.existsSync('/tmp/tckge-pool')) fs.rmSync('/tmp/tckge-pool', { recursive: true, force: true })
    }
  })
})

describe('GEPool — idle reclamation (_reclaimIdle)', () => {
  it('reclaims idle instances past idleTimeoutMs but always keeps at least one', () => {
    vi.useFakeTimers()
    try {
      GEPool.destroyInstanceWithCleanup()
      const pool = GEPool.getInstance({ idleTimeoutMs: 5, config: { path: tmpDir() } })
      pool.getConnection()
      pool.getConnection()
      // Release both; both become idle.
      ;(pool as any)._instances.forEach((i: any) => (i.inUse = false, i.lastUsed = Date.now() - 1000))
      expect(pool.idleCount).toBe(2)
      vi.advanceTimersByTime(100)
      // Both idle expire, but the pool must preserve at least one idle instance.
      expect(pool.idleCount).toBe(1)
    } finally {
      vi.useRealTimers()
      GEPool.destroyInstanceWithCleanup()
    }
  })

  it('does not reclaim when instances are in-use', () => {
    vi.useFakeTimers()
    try {
      GEPool.destroyInstanceWithCleanup()
      const pool = GEPool.getInstance({ idleTimeoutMs: 5, config: { path: tmpDir() } })
      pool.getConnection()
      pool.getConnection()
      vi.advanceTimersByTime(100)
      expect(pool.totalCount).toBe(2)
      expect(pool.activeCount).toBe(2)
    } finally {
      vi.useRealTimers()
      GEPool.destroyInstanceWithCleanup()
    }
  })

  it('skips idle instances that have not yet exceeded idleTimeoutMs', () => {
    vi.useFakeTimers()
    try {
      GEPool.destroyInstanceWithCleanup()
      const pool = GEPool.getInstance({ idleTimeoutMs: 5, config: { path: tmpDir() } })
      pool.getConnection()
      pool.getConnection()
      // One idle instance just became idle (fresh lastUsed), the other is expired.
      const insts = (pool as any)._instances as any[]
      insts[0].inUse = false
      insts[1].inUse = false
      insts[0].lastUsed = Date.now()          // fresh -> NOT expired
      insts[1].lastUsed = Date.now() - 1000   // expired
      vi.advanceTimersByTime(10)
      // The expired idle gets reclaimed, but the fresh idle is kept (condition false arm).
      expect(pool.totalCount).toBe(1)
    } finally {
      vi.useRealTimers()
      GEPool.destroyInstanceWithCleanup()
    }
  })
})
