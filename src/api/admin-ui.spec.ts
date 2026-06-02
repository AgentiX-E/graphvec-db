/**
 * admin-ui.spec.ts — Tests for the Web Admin UI
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { startAdminUI } from './admin-ui'
import type { FastifyInstance } from 'fastify'

// ── Mock graph ────────────────────────────────────────────

function createMockGraph() {
  let queryCounter = 0

  return {
    getNodeCount: () => 42,
    getEdgeCount: () => 137,
    getHealth: () => ({ alive: true, uptime: 3600 }),
    query: async (q: string) => {
      queryCounter++
      return { results: [{ query: q, id: queryCounter }] }
    },
  }
}

// ── Tests ─────────────────────────────────────────────────

describe('Admin UI', () => {
  let server: FastifyInstance
  let baseUrl: string

  beforeAll(async () => {
    // Use port 0 to get an available port
    server = await startAdminUI(createMockGraph(), { port: 0, host: '127.0.0.1' })
    const addr = server.addresses()[0] as { address: string; port: number }
    baseUrl = `http://${addr.address}:${addr.port}`
  })

  afterAll(async () => {
    if (server) {
      await server.close()
    }
  })

  it('GET /api/admin/health returns health status', async () => {
    const res = await fetch(`${baseUrl}/api/admin/health`)
    expect(res.ok).toBe(true)
    const data = await res.json()
    expect(data).toHaveProperty('alive')
    expect(data.alive).toBe(true)
    expect(data).toHaveProperty('status')
    expect(data.status).toBe('Healthy')
    expect(data).toHaveProperty('uptime')
    expect(data).toHaveProperty('timestamp')
  })

  it('GET /api/admin/stats returns graph statistics', async () => {
    const res = await fetch(`${baseUrl}/api/admin/stats`)
    expect(res.ok).toBe(true)
    const data = await res.json()
    expect(data).toHaveProperty('nodeCount')
    expect(data.nodeCount).toBe(42)
    expect(data).toHaveProperty('edgeCount')
    expect(data.edgeCount).toBe(137)
  })

  it('GET /api/admin/procedures returns procedure list', async () => {
    const res = await fetch(`${baseUrl}/api/admin/procedures`)
    expect(res.ok).toBe(true)
    const data = await res.json()
    expect(Array.isArray(data)).toBe(true)
    // Should include built-in procedures from the registry
    expect(data.length).toBeGreaterThanOrEqual(4)
    const names = data.map((p: { name: string }) => p.name)
    expect(names).toContain('algo.pageRank')
    expect(names).toContain('algo.shortestPath')
    expect(names).toContain('algo.connectedComponents')
    expect(names).toContain('algo.kCore')
  })

  it('POST /api/admin/query executes a query', async () => {
    const res = await fetch(`${baseUrl}/api/admin/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'MATCH (n) RETURN n' }),
    })
    expect(res.ok).toBe(true)
    const data = await res.json()
    expect(data).toHaveProperty('success', true)
    expect(data).toHaveProperty('result')
  })

  it('POST /api/admin/query returns 400 for missing query', async () => {
    const res = await fetch(`${baseUrl}/api/admin/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data).toHaveProperty('error')
  })

  it('GET / returns HTML dashboard', async () => {
    const res = await fetch(baseUrl)
    expect(res.ok).toBe(true)
    const text = await res.text()
    expect(text).toContain('AgentiX GraphVec Admin')
    expect(text).toContain('Dashboard')
    expect(text).toContain('Procedures')
    expect(text).toContain('Query')
  })

  it('GET /unknown returns HTML dashboard (fallback)', async () => {
    const res = await fetch(`${baseUrl}/some-random-page`)
    expect(res.ok).toBe(true)
    const text = await res.text()
    expect(text).toContain('AgentiX GraphVec')
  })

  it('GET /api/unknown returns 404 JSON', async () => {
    const res = await fetch(`${baseUrl}/api/unknown`)
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data).toHaveProperty('error')
    expect(data.error).toContain('not found')
  })
})
