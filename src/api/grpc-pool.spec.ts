// ============================================================
// GrpcClientPool Tests
// ============================================================

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { GrpcClientPool, GrpcPoolOptions } from './grpc-pool'
import { GraphEngine } from '../core/graph-engine'
import { createGrpcServer, GrpcServerInstance } from './grpc-server'
import type { OverGraphConfig } from '../types'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'grpc-pool-test-'))
}

function makeEngine(dir: string): GraphEngine {
  const config: OverGraphConfig = { path: dir }
  const engine = new GraphEngine(config)
  engine.open()
  return engine
}

describe('GrpcClientPool', () => {
  let engine: GraphEngine
  let server: GrpcServerInstance
  let tmpDir: string
  let address: string
  let pool: GrpcClientPool

  beforeAll(async () => {
    tmpDir = makeTempDir()
    engine = makeEngine(tmpDir)

    server = createGrpcServer(engine, { port: 0, host: '127.0.0.1' })
    await server.start()
    address = `127.0.0.1:${server.getPort()}`
  })

  afterAll(async () => {
    if (pool) pool.close()
    if (server) await server.stop()
    if (engine) engine.close()
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  beforeEach(() => {
    // Create a fresh pool per test with short timeouts for fast testing
    pool = new GrpcClientPool({
      maxPerAddress: 3,
      idleTimeoutMs: 500,       // 500ms idle for fast testing
      healthCheckIntervalMs: 2000,
      maxHealthCheckFailures: 2,
    })
  })

  afterEach(() => {
    if (pool) pool.close()
  })

  // ── Basic Get / Release ──

  it('should get a client for an address', () => {
    const client = pool.get(address)
    expect(client).toBeDefined()
    expect(typeof client.getNode).toBe('function')
    expect(typeof client.addNode).toBe('function')
    expect(typeof client.health).toBe('function')
    expect(typeof client.close).toBe('function')
  })

  it('should return the same client on repeated gets (undersaturated)', () => {
    const c1 = pool.get(address)
    const c2 = pool.get(address)
    // Both should be the same instance because maxPerAddress > 1 and we release between?
    // Actually without release() we keep using the first one since it's not failing
    expect(c1).toBe(c2)
  })

  it('should create up to maxPerAddress clients when previous ones have failures', () => {
    // Simulate failures on existing connections to force creation of new ones
    const c1 = pool.get(address)
    // Manually mark as failing to force pool to create new
    const entries = (pool as any).pools.get(address)
    if (entries) {
      for (const e of entries) e.failures = 999
    }
    const c2 = pool.get(address)
    // Now both should exist
    expect(pool.totalConnections).toBe(2)
    expect(c1).not.toBe(c2)
  })

  it('should reuse a released client', () => {
    const c1 = pool.get(address)
    pool.release(address, c1)
    const c2 = pool.get(address)
    expect(c1).toBe(c2)
  })

  // ── Client Functionality ──

  it('should execute gRPC calls via pooled client', async () => {
    const client = pool.get(address)
    const added = await client.addNode(1, 'pooled-node', { key: 'value' })
    expect(added).toBeDefined()
    expect(added.id).toBeGreaterThan(0)
    expect(added.name).toBe('pooled-node')
    expect(added.props.key).toBe('value')

    const fetched = await client.getNode(added.id)
    expect(fetched).toBeDefined()
    expect(fetched.id).toBe(added.id)
  })

  it('should query neighbors via pooled client', async () => {
    const client = pool.get(address)
    const n1 = await client.addNode(1, 'pool-src')
    const n2 = await client.addNode(1, 'pool-dst')
    await client.addEdge(n1.id, n2.id, 1)

    const neighborsResp = await client.neighbors(n1.id)
    expect(neighborsResp.edgeCount).toBe(1)
    expect(neighborsResp.edges[0].dst).toBe(n2.id)
  })

  // ── Health Check ──

  it('should return true from healthCheck on a live server', async () => {
    pool.get(address) // ensure a connection exists
    const healthy = await pool.healthCheck(address)
    expect(healthy).toBe(true)
  })

  it('should return false from healthCheck on a dead address', async () => {
    // Don't add any connection — get one first, then check
    // Use a bogus address — no connections will exist
    const healthy = await pool.healthCheck('127.0.0.1:19999')
    expect(healthy).toBe(false)
  })

  // ── Close ──

  it('should close all connections on close()', () => {
    // Force creation of 2 clients by marking first as failing
    const c1 = pool.get(address)
    let entries = (pool as any).pools.get(address)
    if (entries) for (const e of entries) e.failures = 999

    const c2 = pool.get(address)
    entries = (pool as any).pools.get(address)
    if (entries) for (const e of entries) e.failures = 999

    const c3 = pool.get(address)
    expect(pool.totalConnections).toBe(3)
    pool.close()
    expect(pool.totalConnections).toBe(0)
  })

  it('should throw on get() after close()', () => {
    pool.close()
    expect(() => pool.get(address)).toThrow('closed')
  })

  // ── Stats ──

  it('should return pool stats', () => {
    pool.get(address)
    const stats = pool.getStats()
    expect(stats[address]).toBeDefined()
    expect(stats[address].active).toBe(1)
    expect(stats[address].failing).toBe(0)
  })

  // ── Eviction (idle timeout) ──

  it('should evict idle connections after idleTimeoutMs', async () => {
    // Create pool with very short idle timeout
    const fastPool = new GrpcClientPool({
      maxPerAddress: 2,
      idleTimeoutMs: 100,    // 100ms
      healthCheckIntervalMs: 5000,
    })
    fastPool.get(address)
    expect(fastPool.totalConnections).toBe(1)
    // Wait for eviction
    await new Promise(r => setTimeout(r, 250))
    expect(fastPool.totalConnections).toBe(0)
    fastPool.close()
  })

  // ── Release unmanaged client ──

  it('should close unmanaged client on release', async () => {
    // Create a client that isn't in the pool and release it — should not throw
    const client = pool.get(address)
    // Manually close it
    client.close()
    // Release should not throw even though the client is closed
    pool.release(address, client) // no error expected
  })

  // ── Multiple Addresses ──

  it('should maintain separate pools for different addresses', () => {
    const addr1 = '127.0.0.1:50051'
    const addr2 = '127.0.0.1:50052'
    pool.get(addr1)
    pool.get(addr1)  // reuses same
    pool.get(addr2)
    const stats = pool.getStats()
    expect(stats[addr1].active).toBe(1)
    expect(stats[addr2].active).toBe(1)
  })
})
