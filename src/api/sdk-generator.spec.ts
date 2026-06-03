import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateSdk, RuntimeApiClient } from './sdk-generator'
import * as path from 'path'
import * as fs from 'fs'

// ── RuntimeApiClient（mock fetch） ─────────────────

describe('RuntimeApiClient', () => {
  let client: RuntimeApiClient
  let mockFetch: any

  beforeEach(() => {
    mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    client = new RuntimeApiClient('http://localhost:8080')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('constructor strips trailing slash', () => {
    const c = new RuntimeApiClient('http://test.com/')
    expect(c).toBeDefined()
  })

  test('healthCheck sends GET /api/health', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'ok', uptime: 123, version: '1.0' }),
    })
    const result = await client.healthCheck()
    expect(result.status).toBe('ok')
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/api/health',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  test('graphQuery sends POST with query body', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [], duration: 5 }),
    })
    const result = await client.graphQuery('testdb', 'MATCH (n) RETURN n')
    expect(result.duration).toBe(5)
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/api/v1/testdb/graph-query',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('MATCH'),
      }),
    )
  })

  test('getNode sends GET with id param', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 1, name: 'Alice' }),
    })
    const result = await client.getNode('testdb', 1)
    expect(result.name).toBe('Alice')
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('id=1'),
      expect.any(Object),
    )
  })

  test('createNode sends POST with name and type', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 42 }),
    })
    const result = await client.createNode('testdb', 'Bob', 1, { age: 30 })
    expect(result.id).toBe(42)
    const callArgs = mockFetch.mock.calls[0]
    expect(callArgs[0]).toBe('http://localhost:8080/api/v1/testdb/node')
    const body = JSON.parse(callArgs[1].body)
    expect(body.name).toBe('Bob')
    expect(body.type).toBe(1)
    expect(body.props.age).toBe(30)
  })

  test('updateNode sends PUT with updates', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 1, age: 31 }),
    })
    const result = await client.updateNode('testdb', 1, { age: 31 })
    expect(result.age).toBe(31)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('id=1'),
      expect.objectContaining({ method: 'PUT' }),
    )
  })

  test('deleteNode sends DELETE', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ deleted: true }),
    })
    const result = await client.deleteNode('testdb', 1)
    expect(result.deleted).toBe(true)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('id=1'),
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  test('getEdge sends GET with src/dst/type', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ src: 1, dst: 2 }),
    })
    const result = await client.getEdge('testdb', 1, 2, 3)
    expect(result.src).toBe(1)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringMatching(/src=1.*dst=2.*type=3/),
      expect.any(Object),
    )
  })

  test('createEdge sends POST', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ edgeId: 99 }),
    })
    const result = await client.createEdge('testdb', 1, 2, 3, { weight: 0.5 })
    expect(result.edgeId).toBe(99)
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.src).toBe(1)
    expect(body.dst).toBe(2)
    expect(body.type).toBe(3)
  })

  test('deleteEdge sends DELETE', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ deleted: true }),
    })
    const result = await client.deleteEdge('testdb', 1, 2, 3)
    expect(result.deleted).toBe(true)
  })

  test('setToken adds authorization header', async () => {
    client.setToken('my-token')
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'ok' }),
    })
    await client.healthCheck()
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer my-token' }),
      }),
    )
  })

  test('non-ok response throws error with status', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not Found'),
    })
    await expect(client.getNode('testdb', 999)).rejects.toThrow('API error 404')
  })
})

// ── generateSdk ──────────────────────────────

describe('generateSdk', () => {
  const tmpDir = path.join(process.cwd(), '.test-sdk-output')

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  test('returns result for go target (no external dep)', () => {
    const result = generateSdk({
      output: tmpDir,
      target: 'go',
      document: { openapi: '3.0.0', info: { title: 'Test', version: '1.0' }, paths: {} },
    })
    expect(result).toBeDefined()
    expect(result.target).toBe('go')
    expect(result.success).toBe(true)
  })

  test('creates output directory for go target', () => {
    generateSdk({
      output: tmpDir,
      target: 'go',
      document: { openapi: '3.0.0', info: { title: 'Test', version: '1.0' }, paths: {} },
    })
    expect(fs.existsSync(tmpDir)).toBe(true)
  })

  test('returns files array for go target', () => {
    const result = generateSdk({
      output: tmpDir,
      target: 'go',
      document: { openapi: '3.0.0', info: { title: 'Test', version: '1.0' }, paths: {} },
    })
    expect(Array.isArray(result.files)).toBe(true)
    expect(result.success).toBe(true)
  })
})
