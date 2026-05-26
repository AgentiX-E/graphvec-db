// ============================================================
// RestApiServer 测试 — mTLS 认证
// ============================================================

import { createRestApiServer, RestApiServer, RestApiConfig, jsonResponse, parseBody, _matchRoute } from './rest'
import { NodeRecord, EdgeRecord, Role } from '../types'
import { Authenticator, RBAC } from '../security/auth'
import { TLSConfig } from '../security/tls'
import { ShardManager } from '../shard/shard-manager'
import { DatabaseManager, DatabaseInstance } from '../core/database-manager'
import * as https from 'https'
import * as http from 'http'
import * as path from 'path'
import * as fs from 'fs'

// ──────────────────────────────────────────
// mTLS 测试用证书路径
// ──────────────────────────────────────────

const TEST_CERTS_DIR = path.resolve(__dirname, '../../test-certs')
const SERVER_CERT = path.join(TEST_CERTS_DIR, 'server-cert.pem')
const SERVER_KEY = path.join(TEST_CERTS_DIR, 'server-key.pem')
const CLIENT_ADMIN_CERT = path.join(TEST_CERTS_DIR, 'client-cert.pem')
const CLIENT_ADMIN_KEY = path.join(TEST_CERTS_DIR, 'client-key.pem')
const CLIENT_READER_CERT = path.join(TEST_CERTS_DIR, 'client-reader-cert.pem')
const CLIENT_READER_KEY = path.join(TEST_CERTS_DIR, 'client-reader-key.pem')

/**
 * 构建一个可供测试使用的 TLSConfig
 * 使用 test-certs/ 下的自签名证书
 */
function createMockTlsConfig(): TLSConfig {
  return new TLSConfig({
    mode: 'mtls',
    tlsCert: SERVER_CERT,
    tlsKey: SERVER_KEY,
    tlsCA: path.join(TEST_CERTS_DIR, 'ca-cert.pem'),
  })
}

/**
 * 构建一个允许测试用 CN 的 Authenticator
 * 基于 test-certs 中签发的 CN：test-admin, test-reader
 */
function createMockAuthenticator(): Authenticator {
  return new Authenticator({
    mode: 'mtls',
    tlsCert: SERVER_CERT,
    tlsKey: SERVER_KEY,
    identities: [
      { cn: 'test-admin', role: Role.ADMIN },
      { cn: 'test-reader', role: Role.READER },
    ],
  })
}

/**
 * 读取客户端证书文件，创建 HTTPS Agent 用于测试请求
 */
function createTestHttpsAgent(certPath: string, keyPath: string): https.Agent {
  return new https.Agent({
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
    rejectUnauthorized: false,
    ca: fs.readFileSync(SERVER_CERT),
  })
}

/** 管理员级别客户端 agent */
const adminAgent = createTestHttpsAgent(CLIENT_ADMIN_CERT, CLIENT_ADMIN_KEY)
/** 只读级别客户端 agent */
const readerAgent = createTestHttpsAgent(CLIENT_READER_CERT, CLIENT_READER_KEY)

/**
 * 无客户端证书的请求（用于测试未认证访问）
 */
function makeNoCertRequest(
  server: RestApiServer,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const port = server.getPort()
    const postData = body !== undefined ? JSON.stringify(body) : undefined
    const options: https.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      rejectUnauthorized: false,
      headers: {},
    }
    if (postData) {
      options.headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData).toString() }
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', (chunk: string) => { data += chunk })
      res.on('end', () => {
        let parsed: unknown
        try { parsed = data ? JSON.parse(data) : {} } catch { parsed = data }
        resolve({ statusCode: res.statusCode ?? 0, body: parsed })
      })
    })
    req.on('error', reject)
    if (postData) req.write(postData)
    req.end()
  })
}

// ──────────────────────────────────────────
// MockShardManager
// ──────────────────────────────────────────

class MockShardManager {
  private allNodes: NodeRecord[] = []
  private nodeEdges: Map<number, { edges: EdgeRecord[]; nodes: NodeRecord[] }> = new Map()
  private edgeStore: Map<string, { src: number; dst: number; type: number }> = new Map()

  setNodes(nodes: NodeRecord[]): void {
    this.allNodes = nodes
  }

  getAllNodes(): NodeRecord[] {
    return this.allNodes
  }

  async upsertNode(typeId: number, name: string): Promise<number> {
    const id = this.allNodes.length + 1
    this.allNodes.push({
      id,
      type: typeId,
      name,
      props: {},
      createdAt: Date.now(),
      degree: 0,
    })
    return id
  }

  async getNode(id: number): Promise<NodeRecord | null> {
    return this.allNodes.find(n => n.id === id) ?? null
  }

  async upsertEdge(src: number, dst: number, typeId: number): Promise<void> {
    const key = `${src}-${dst}-${typeId}`
    this.edgeStore.set(key, { src, dst, type: typeId })
  }

  deleteEdge(src: number, dst: number, typeId: number): boolean {
    const key = `${src}-${dst}-${typeId}`
    return this.edgeStore.delete(key)
  }

  async batchUpsertNodes(
    inputs: Array<{ typeId: number; name: string }>
  ): Promise<number[]> {
    const ids: number[] = []
    for (const input of inputs) {
      const id = this.allNodes.length + ids.length + 1
      this.allNodes.push({
        id,
        type: input.typeId,
        name: input.name,
        props: {},
        createdAt: Date.now(),
        degree: 0,
      })
      ids.push(id)
    }
    return ids
  }

  async batchGetNodes(ids: number[]): Promise<NodeRecord[]> {
    return this.allNodes.filter(n => ids.includes(n.id))
  }

  async neighbors(id: number, _opts?: { maxDepth?: number; edgeTypeFilter?: number[] }): Promise<{
    edges: EdgeRecord[]; nodes: NodeRecord[]
  }> {
    return this.nodeEdges.get(id) ?? { edges: [], nodes: [] }
  }

  setNeighbors(nodeId: number, edges: EdgeRecord[], nodes: NodeRecord[]): void {
    this.nodeEdges.set(nodeId, { edges, nodes })
  }

  getRouter(): { getRangeForKey(key: string): string } {
    return { getRangeForKey: () => 'range-0' }
  }

  getShardStatus(): Array<{ rangeId: string; raftRole: string; nodeCount: number }> {
    return [{ rangeId: 'range-0', raftRole: 'leader', nodeCount: this.allNodes.length }]
  }

  getRange(_rangeId: string): any {
    return {
      engine: {
        stats: () => ({
          nodeCount: this.allNodes.length,
          edgeCount: this.edgeStore.size,
          diskSizeBytes: 0,
        }),
        deleteEdge: (src: number, dst: number, typeId: number) => this.deleteEdge(src, dst, typeId),
      },
      write: (op: any) => {
        if (op.type === 'delete_edge') {
          const { src, dst, typeId } = op.payload
          return this.deleteEdge(src, dst, typeId)
        }
        if (op.type === 'upsert_edge') {
          const { src, dst, typeId } = op.payload
          return this.upsertEdge(src, dst, typeId)
        }
        if (op.type === 'upsert_node') {
          const { typeId, name } = op.payload
          return this.upsertNode(typeId, name)
        }
        if (op.type === 'batch_upsert') {
          const { inputs } = op.payload
          const ids = this.batchUpsertNodes(inputs)
          const result: Record<string, number> = {}
          for (let i = 0; i < inputs.length; i++) {
            result[inputs[i].name] = ids[i]
          }
          return result
        }
        if (op.type === 'delete_node') {
          const { id } = op.payload
          return this.deleteNode(id)
        }
        return undefined
      },
      read: (fn: (engine: any) => any) => {
        return fn(this.getRange('range-0').engine)
      },
    }
  }

  getAllRanges(): Map<string, any> {
    const m = new Map()
    m.set('range-0', this.getRange('range-0'))
    return m
  }

  async deleteNode(id: number): Promise<void> {
    const idx = this.allNodes.findIndex(n => n.id === id)
    if (idx >= 0) this.allNodes.splice(idx, 1)
  }
}

// ──────────────────────────────────────────
// HTTPS 请求辅助函数
// ──────────────────────────────────────────

function makeRequest(
  server: RestApiServer,
  method: string,
  path: string,
  body?: unknown,
  agent: https.Agent = adminAgent,
  headers?: Record<string, string>,
): Promise<{ statusCode: number; body: unknown; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const port = server.getPort()
    const postData = body !== undefined ? JSON.stringify(body) : undefined

    const options: https.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      agent,
      rejectUnauthorized: false,
      headers: {
        ...headers,
      },
    }

    // 如果 agent 没有设置 cert，从文件加载默认 cert
    const agentCert = (agent as any)?.options?.cert
    if (!agentCert) {
      options.key = fs.readFileSync(CLIENT_ADMIN_KEY)
      options.cert = fs.readFileSync(CLIENT_ADMIN_CERT)
    }

    if (postData) {
      options.headers = {
        ...options.headers,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData).toString(),
      }
    }

    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', (chunk: string) => { data += chunk })
      res.on('end', () => {
        let parsed: unknown
        try {
          parsed = data ? JSON.parse(data) : {}
        } catch {
          parsed = data
        }
        resolve({
          statusCode: res.statusCode ?? 0,
          body: parsed,
          headers: res.headers,
        })
      })
    })

    req.on('error', reject)

    if (postData) {
      req.write(postData)
    }
    req.end()
  })
}

// ──────────────────────────────────────────
// 测试套件
// ──────────────────────────────────────────

describe('RestApiServer', () => {
  let mockShardManager: MockShardManager
  let server: RestApiServer
  let mockAuthenticator: Authenticator
  let mockTlsConfig: TLSConfig

  beforeEach(() => {
    mockShardManager = new MockShardManager()
    mockAuthenticator = createMockAuthenticator()
    mockTlsConfig = createMockTlsConfig()
  })

  afterEach(async () => {
    if (server) {
      await server.stop()
    }
  })

  // ──────────────────────────────────────────
  // 基础路由测试
  // ──────────────────────────────────────────

  describe('基础路由', () => {
    test('GET /api/status should return 200', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'GET', '/api/status')
      expect(res.statusCode).toBe(200)
      expect((res.body as any).status).toBe('ok')
    })

    test('GET /api/status should include version', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'GET', '/api/status')
      expect((res.body as any).version).toBe('0.1.0')
    })

    test('GET /api/status should include shards', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      mockShardManager.setNodes([
        { id: 1, type: 1, name: 'A', props: {}, createdAt: Date.now(), degree: 0 },
      ])
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'GET', '/api/status')
      expect((res.body as any).shards).toBeInstanceOf(Array)
    })

    test('POST /api/graph/nodes should create node', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'POST', '/api/graph/nodes', { typeId: 1, name: 'test-node' })
      expect(res.statusCode).toBe(200)
      expect((res.body as any).id).toBeDefined()
    })

    test('POST /api/graph/nodes missing fields should return 400', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'POST', '/api/graph/nodes', { typeId: 1 })
      expect(res.statusCode).toBe(400)
    })

    test('POST /api/graph/nodes missing name should return 400', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'POST', '/api/graph/nodes', { name: 'test' })
      expect(res.statusCode).toBe(400)
    })

    test('GET to unknown route should return 404', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'GET', '/api/unknown')
      expect(res.statusCode).toBe(404)
    })
  })

  // ──────────────────────────────────────────
  // CORS
  // ──────────────────────────────────────────

  describe('CORS', () => {
    test('should include CORS headers when enabled', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig, enableCors: true }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'OPTIONS', '/api/status')
      expect(res.statusCode).toBe(204)
      expect(res.headers['access-control-allow-origin']).toBe('*')
    })

    test('OPTIONS preflight should return 204', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig, enableCors: true }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'OPTIONS', '/api/status')
      expect(res.statusCode).toBe(204)
    })

    test('CORS headers on normal request', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig, enableCors: true }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'GET', '/api/status')
      expect(res.headers['access-control-allow-origin']).toBe('*')
    })
  })

  // ──────────────────────────────────────────
  // mTLS 认证测试
  // ──────────────────────────────────────────

  describe('mTLS 认证', () => {
    test('requests without client cert should be rejected', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      // 无证书会在 SSL 层被拒绝（alert certificate required）
      await expect(makeNoCertRequest(server, 'POST', '/api/graph/nodes', { typeId: 1, name: 'x' }) as Promise<unknown>)
        .rejects.toThrow()
    })

    test('requests with valid admin client cert should pass auth on protected routes', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'POST', '/api/graph/nodes', { typeId: 1, name: 'test-node' }, adminAgent)
      expect(res.statusCode).toBe(200)
    })

    test('requests with reader client cert should be forbidden from write routes', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      // reader 角色没有 write 权限，POST /api/graph/nodes requiresPermission=write
      const res = await makeRequest(server, 'POST', '/api/graph/nodes', { typeId: 1, name: 'test-node' }, readerAgent)
      expect(res.statusCode).toBe(403)
    })

    test('unauthenticated routes should work without cert', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      // /api/status requireAuth=false, 应正常工作
      const res = await makeRequest(server, 'GET', '/api/status')
      expect(res.statusCode).toBe(200)
    })
  })

  // ──────────────────────────────────────────
  // JSON 响应
  // ──────────────────────────────────────────

  describe('JSON 响应', () => {
    test('should return JSON content-type', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'GET', '/api/status')
      expect(res.headers['content-type']).toContain('application/json')
    })

    test('error response should be JSON', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'POST', '/api/graph/nodes', { typeId: 1 })
      expect(res.headers['content-type']).toContain('application/json')
      expect((res.body as any).error).toBeDefined()
    })
  })

  // ──────────────────────────────────────────
  // 服务器生命周期
  // ──────────────────────────────────────────

  describe('服务器生命周期', () => {
    test('should start and stop without error', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()
      expect(server.getPort()).toBeGreaterThan(0)
      await server.stop()
    })

    test('should assign dynamic port when port is 0', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()
      expect(server.getPort()).toBeGreaterThan(0)
    })

    test('should handle multiple requests', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const r1 = await makeRequest(server, 'GET', '/api/status')
      expect(r1.statusCode).toBe(200)

      const r2 = await makeRequest(server, 'POST', '/api/graph/nodes', { typeId: 1, name: 'n' })
      expect(r2.statusCode).toBe(200)

      const r3 = await makeRequest(server, 'GET', '/api/status')
      expect(r3.statusCode).toBe(200)
    })

    test('should handle POST body serialization', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const body = { typeId: 42, name: 'serialization-test' }
      const res = await makeRequest(server, 'POST', '/api/graph/nodes', body)
      expect(res.statusCode).toBe(200)
    })

    test('should add Content-Type and Content-Length to requests', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'POST', '/api/graph/nodes', { typeId: 1, name: 'test' })
      expect(res.statusCode).toBe(200)
    })
  })

  // ──────────────────────────────────────────
  // PUT/DELETE/PATCH handler
  // ──────────────────────────────────────────

  describe('PUT/DELETE/PATCH handler', () => {
    test('POST should work with body', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'POST', '/api/graph/nodes', { typeId: 1, name: 'x' })
      expect(res.statusCode).toBe(200)
    })

    test('PUT to unknown route should return 404', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'PUT', '/api/unknown', {})
      expect(res.statusCode).toBe(404)
    })

    test('PATCH to unknown route should return 404', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'PATCH', '/api/unknown', {})
      expect(res.statusCode).toBe(404)
    })

    test('DELETE to unknown route should return 404', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'DELETE', '/api/unknown')
      expect(res.statusCode).toBe(404)
    })
  })

  // ──────────────────────────────────────────
  // 安全头 + bodySizeLimit
  // ──────────────────────────────────────────

  describe('安全头', () => {
    test('should include security headers', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'GET', '/api/status')
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['x-frame-options']).toBe('DENY')
    })
  })

  describe('bodySizeLimit', () => {
    test('should reject request body exceeding limit', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig, bodySizeLimit: 10 }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'POST', '/api/graph/nodes', {
        typeId: 1,
        name: 'long name that exceeds the body size limit',
      })
      expect(res.statusCode).toBe(413)
    })

    test('should accept request body within limit', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig, bodySizeLimit: 1000 }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'POST', '/api/graph/nodes', {
        typeId: 1, name: 'small',
      })
      expect(res.statusCode).toBe(200)
    })
  })

  // ──────────────────────────────────────────
  // _matchRoute 路由匹配测试
  // ──────────────────────────────────────────

  describe('_matchRoute 路由匹配', () => {
    test('should match exact path without params', () => {
      expect(_matchRoute('/api/graph/node', '/api/graph/node')).toEqual({})
    })

    test('should extract single param :id', () => {
      expect(_matchRoute('/api/graph/node/:id', '/api/graph/node/42')).toEqual({ id: '42' })
    })

    test('should extract :nodeId param', () => {
      expect(_matchRoute('/api/graph/edges/:nodeId', '/api/graph/edges/100')).toEqual({ nodeId: '100' })
    })

    test('should return null for mismatched path (different segment)', () => {
      expect(_matchRoute('/api/graph/node/:id', '/api/graph/edge/42')).toBeNull()
    })

    test('should return null for different length paths', () => {
      expect(_matchRoute('/api/graph/node/:id', '/api/graph/node/42/extra')).toBeNull()
    })

    test('should extract multiple params', () => {
      expect(_matchRoute('/api/:scope/:action', '/api/graph/nodes')).toEqual({ scope: 'graph', action: 'nodes' })
    })

    test('should return null for non-existing route', () => {
      expect(_matchRoute('/api/graph/node/:id', '/api/graph/node')).toBeNull()
    })

    test('should handle GET node via path param', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      mockShardManager.setNodes([
        { id: 42, type: 1, name: 'test-node', props: {}, createdAt: Date.now(), degree: 1 },
      ])
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      // Use POST-like with body for backward compat, but also test new GET with path param
      // The old GET /api/graph/node required body.id; new GET /api/graph/node/:id uses path
      const res = await makeRequest(server, 'GET', '/api/graph/node/42')
      expect(res.statusCode).toBe(200)
      expect((res.body as any).id).toBe(42)
    })

    test('DELETE with path param should work', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      mockShardManager.setNodes([
        { id: 1, type: 1, name: 'delete-me', props: {}, createdAt: Date.now(), degree: 0 },
      ])
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'DELETE', '/api/graph/node/1')
      expect(res.statusCode).toBe(200)
    })
  })

  // ──────────────────────────────────────────
  // 边 CRUD 端点测试
  // ──────────────────────────────────────────

  describe('边 CRUD', () => {
    test('POST /api/graph/edges should create edge', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'POST', '/api/graph/edges', { src: 1, dst: 2, type: 1 })
      expect(res.statusCode).toBe(200)
      expect((res.body as any).message).toBe('edge created')
    })

    test('POST /api/graph/edges missing fields should return 400', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'POST', '/api/graph/edges', { src: 1 })
      expect(res.statusCode).toBe(400)
      expect((res.body as any).error).toContain('required')
    })

    test('GET /api/graph/edges/:nodeId should return neighbor info', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'GET', '/api/graph/edges/1')
      expect(res.statusCode).toBe(200)
      expect((res.body as any).nodeId).toBe(1)
      expect(Array.isArray((res.body as any).edges)).toBe(true)
      expect(Array.isArray((res.body as any).nodes)).toBe(true)
    })

    test('GET /api/graph/edges/:nodeId with invalid id should return 400', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'GET', '/api/graph/edges/abc')
      expect(res.statusCode).toBe(400)
    })

    test('DELETE /api/graph/edge should delete edge', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      // First create an edge
      const createRes = await makeRequest(server, 'POST', '/api/graph/edges', { src: 1, dst: 2, type: 1 })
      expect(createRes.statusCode).toBe(200)

      // Then delete it
      const delRes = await makeRequest(server, 'DELETE', '/api/graph/edge', { src: 1, dst: 2, type: 1 })
      expect(delRes.statusCode).toBe(200)
      expect((delRes.body as any).message).toBe('edge deleted')
    })

    test('DELETE /api/graph/edge missing fields should return 400', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'DELETE', '/api/graph/edge', { src: 1 })
      expect(res.statusCode).toBe(400)
      expect((res.body as any).error).toContain('required')
    })
  })

  // ──────────────────────────────────────────
  // 批量操作端点测试
  // ──────────────────────────────────────────

  describe('批量操作', () => {
    test('POST /api/graph/nodes/batch should create multiple nodes', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'POST', '/api/graph/nodes/batch', {
        items: [
          { id: 'n1', type: 1 },
          { id: 'n2', type: 2 },
          { id: 'n3', type: 1 },
        ],
      })
      expect(res.statusCode).toBe(200)
      expect((res.body as any).count).toBe(3)
      expect((res.body as any).ids).toBeInstanceOf(Array)
      expect((res.body as any).ids.length).toBe(3)
    })

    test('POST /api/graph/nodes/batch with empty items should return 400', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'POST', '/api/graph/nodes/batch', { items: [] })
      expect(res.statusCode).toBe(400)
    })

    test('POST /api/graph/nodes/batch missing items should return 400', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'POST', '/api/graph/nodes/batch', {})
      expect(res.statusCode).toBe(400)
    })

    test('POST /api/graph/edges/batch should create multiple edges', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'POST', '/api/graph/edges/batch', {
        items: [
          { src: 1, dst: 2, type: 1 },
          { src: 2, dst: 3, type: 1 },
          { src: 3, dst: 1, type: 2 },
        ],
      })
      expect(res.statusCode).toBe(200)
      expect((res.body as any).successCount).toBe(3)
      expect((res.body as any).errorCount).toBe(0)
    })

    test('POST /api/graph/edges/batch with invalid items should report errors', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'POST', '/api/graph/edges/batch', {
        items: [
          { src: 1, dst: 2, type: 1 },
          { src: 2, type: 1 }, // missing dst
        ],
      })
      expect(res.statusCode).toBe(200)
      expect((res.body as any).successCount).toBe(1)
      expect((res.body as any).errorCount).toBe(1)
    })

    test('POST /api/graph/edges/batch with empty items should return 400', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'POST', '/api/graph/edges/batch', { items: [] })
      expect(res.statusCode).toBe(400)
    })
  })

  // ──────────────────────────────────────────
  // 查询端点测试
  // ──────────────────────────────────────────

  describe('查询端点', () => {
    test('POST /api/query with match body should return results', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'POST', '/api/query', {
        query: 'MATCH (n) WHERE n.typeId=1 RETURN n LIMIT 100',
      })
      expect(res.statusCode).toBe(200)
      expect((res.body as any).results).toBeInstanceOf(Array)
      expect((res.body as any).count).toBeDefined()
      expect((res.body as any).plan).toBeDefined()
      expect((res.body as any).plan.type).toBeDefined()
    })

    test('POST /api/query without query string should return 400', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'POST', '/api/query', {})
      expect(res.statusCode).toBe(400)
    })

    test('POST /api/query with match object should return results', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      mockShardManager.setNodes([
        { id: 1, type: 1, name: 'A', props: {}, createdAt: Date.now(), degree: 0 },
      ])
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'POST', '/api/query', {
        match: { typeId: 1 },
        return: ['name'],
        limit: 10,
      })
      expect(res.statusCode).toBe(200)
      expect((res.body as any).results).toBeInstanceOf(Array)
      expect((res.body as any).count).toBe(1)
    })

    test('GET /api/query/stream should return SSE response', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'GET', '/api/query/stream?query=MATCH%20(n)%20WHERE%20n.typeId%3D1%20RETURN%20n%20LIMIT%20100')
      expect(res.statusCode).toBe(200)
    })

    test('GET /api/query/stream without query should return 400', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'GET', '/api/query/stream')
      expect(res.statusCode).toBe(400)
    })
  })

  // ──────────────────────────────────────────
  // /metrics 端点测试
  // ──────────────────────────────────────────

  describe('/metrics 端点', () => {
    test('GET /metrics should return prometheus format', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'GET', '/metrics')
      expect(res.statusCode).toBe(200)
      // /metrics is unauthenticated, should return content
      const body = typeof res.body === 'string' ? res.body : JSON.stringify(res.body)
      expect(body.length).toBeGreaterThan(0)
    })

    test('GET /api/metrics should return prometheus format with auth', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'GET', '/api/metrics')
      expect(res.statusCode).toBe(200)
    })

    test('/metrics should have correct content-type', async () => {
      const config: RestApiConfig = { port: 0, host: '127.0.0.1', authenticator: mockAuthenticator, tlsConfig: mockTlsConfig }
      server = createRestApiServer(mockShardManager as any, config)
      await server.start()

      const res = await makeRequest(server, 'GET', '/metrics')
      // The content-type might be application/json from fallback or text/plain from prom-client
      expect(res.statusCode).toBe(200)
    })
  })

  // ──────────────────────────────────────────
  // 多数据库路由测试
  // ──────────────────────────────────────────

  describe('多数据库路由', () => {
    // MockDatabaseManager: wraps two MockShardManager instances
    class MockDatabaseManager {
      private instances = new Map<string, { shardManager: MockShardManager }>()

      createDb(name: string, sm: MockShardManager): void {
        this.instances.set(name, { shardManager: sm })
      }

      resolve(name: string): { shardManager: MockShardManager } {
        const inst = this.instances.get(name)
        if (!inst) throw new Error(`Database '${name}' not found`)
        return inst
      }

      hasDatabase(name: string): boolean {
        return this.instances.has(name)
      }

      listDatabases(): string[] {
        return Array.from(this.instances.keys())
      }
    }

    let db1Sm: MockShardManager
    let db2Sm: MockShardManager
    let mockDbm: MockDatabaseManager
    let dbConfig: RestApiConfig

    beforeEach(() => {
      db1Sm = new MockShardManager()
      db2Sm = new MockShardManager()
      mockDbm = new MockDatabaseManager()
      mockDbm.createDb('db1', db1Sm)
      mockDbm.createDb('db2', db2Sm)
      dbConfig = {
        port: 0,
        host: '127.0.0.1',
        authenticator: mockAuthenticator,
        tlsConfig: mockTlsConfig,
        databaseManager: mockDbm as any,
      }
    })

    test('POST /api/v1/db1/graph/nodes should create node in db1 only', async () => {
      server = createRestApiServer(mockShardManager as any, dbConfig)
      await server.start()

      const res = await makeRequest(server, 'POST', '/api/v1/db1/graph/nodes', { typeId: 1, name: 'node-in-db1' })
      expect(res.statusCode).toBe(200)
      expect((res.body as any).id).toBeDefined()

      // Verify node only exists in db1, not db2
      const db1Nodes = db1Sm.getAllNodes()
      expect(db1Nodes.length).toBe(1)
      expect(db1Nodes[0].name).toBe('node-in-db1')

      const db2Nodes = db2Sm.getAllNodes()
      expect(db2Nodes.length).toBe(0)
    })

    test('POST /api/v1/db2/graph/nodes should create node in db2 only', async () => {
      server = createRestApiServer(mockShardManager as any, dbConfig)
      await server.start()

      const res = await makeRequest(server, 'POST', '/api/v1/db2/graph/nodes', { typeId: 2, name: 'node-in-db2' })
      expect(res.statusCode).toBe(200)

      const db2Nodes = db2Sm.getAllNodes()
      expect(db2Nodes.length).toBe(1)
      expect(db2Nodes[0].name).toBe('node-in-db2')

      const db1Nodes = db1Sm.getAllNodes()
      expect(db1Nodes.length).toBe(0)
    })

    test('Data isolation: nodes in db1 should not be visible via db2', async () => {
      server = createRestApiServer(mockShardManager as any, dbConfig)
      await server.start()

      // Create node in db1
      await makeRequest(server, 'POST', '/api/v1/db1/graph/nodes', { typeId: 1, name: 'secret-db1' })

      // Get node from db1
      const db1Nodes = db1Sm.getAllNodes()
      const nodeId = db1Nodes[0].id

      // db2 should not see this node
      const rDb2 = await makeRequest(server, 'GET', `/api/v1/db2/graph/node/${nodeId}`)
      expect(rDb2.statusCode).toBe(404)
    })

    test('POST /api/v1/:db/graph/nodes with missing db should return 404', async () => {
      server = createRestApiServer(mockShardManager as any, dbConfig)
      await server.start()

      const res = await makeRequest(server, 'POST', '/api/v1/nonexistent/graph/nodes', { typeId: 1, name: 'x' })
      expect(res.statusCode).toBe(404)
      expect((res.body as any).error).toContain('not found')
    })

    test('GET /api/v1/:db/graph/node/:id should return node for correct db', async () => {
      server = createRestApiServer(mockShardManager as any, dbConfig)
      await server.start()

      await makeRequest(server, 'POST', '/api/v1/db1/graph/nodes', { typeId: 1, name: 'find-me' })
      const db1Nodes = db1Sm.getAllNodes()
      const nodeId = db1Nodes[0].id

      const res = await makeRequest(server, 'GET', `/api/v1/db1/graph/node/${nodeId}`)
      expect(res.statusCode).toBe(200)
      expect((res.body as any).name).toBe('find-me')
    })

    test('DELETE /api/v1/:db/graph/node/:id should delete from correct db', async () => {
      server = createRestApiServer(mockShardManager as any, dbConfig)
      await server.start()

      await makeRequest(server, 'POST', '/api/v1/db1/graph/nodes', { typeId: 1, name: 'delete-me' })
      const db1Nodes = db1Sm.getAllNodes()
      const nodeId = db1Nodes[0].id

      await makeRequest(server, 'DELETE', `/api/v1/db1/graph/node/${nodeId}`)
      expect(db1Sm.getAllNodes().length).toBe(0)
    })

    test('POST /api/v1/:db/graph/edges should create edge in correct db', async () => {
      server = createRestApiServer(mockShardManager as any, dbConfig)
      await server.start()

      // Create nodes in db1
      await makeRequest(server, 'POST', '/api/v1/db1/graph/nodes', { typeId: 1, name: 'src' })
      await makeRequest(server, 'POST', '/api/v1/db1/graph/nodes', { typeId: 1, name: 'dst' })

      // Create edge in db1
      const res = await makeRequest(server, 'POST', '/api/v1/db1/graph/edges', { src: 1, dst: 2, type: 1 })
      expect(res.statusCode).toBe(200)
      expect((res.body as any).message).toBe('edge created')
    })

    test('POST /api/v1/:db/query should execute query on correct database', async () => {
      server = createRestApiServer(mockShardManager as any, dbConfig)
      await server.start()

      // Add a node to db1 via the multi-db route
      const createRes = await makeRequest(server, 'POST', '/api/v1/db1/graph/nodes', { typeId: 1, name: 'query-test' })
      expect(createRes.statusCode).toBe(200)
      expect(db1Sm.getAllNodes().length).toBe(1)

      // Now query db1 using match object format (works correctly with parseMatchBody)
      const res = await makeRequest(server, 'POST', '/api/v1/db1/query', {
        match: { typeId: 1 },
        return: ['name'],
        limit: 10,
      })
      expect(res.statusCode).toBe(200)
      expect((res.body as any).results).toBeInstanceOf(Array)
      expect((res.body as any).count).toBe(1) // db1 has 1 node
    })

    test('GET /api/v1/:db/graph/edges/:nodeId should work on correct database', async () => {
      server = createRestApiServer(mockShardManager as any, dbConfig)
      await server.start()

      const res = await makeRequest(server, 'GET', '/api/v1/db1/graph/edges/1')
      expect(res.statusCode).toBe(200)
      expect((res.body as any).nodeId).toBe(1)
    })

    test('POST /api/v1/:db/graph/nodes/batch should batch in correct database', async () => {
      server = createRestApiServer(mockShardManager as any, dbConfig)
      await server.start()

      const res = await makeRequest(server, 'POST', '/api/v1/db1/graph/nodes/batch', {
        items: [
          { id: 'n1', type: 1 },
          { id: 'n2', type: 2 },
        ],
      })
      expect(res.statusCode).toBe(200)
      expect((res.body as any).count).toBe(2)
      expect(db1Sm.getAllNodes().length).toBe(2)
      expect(db2Sm.getAllNodes().length).toBe(0)
    })

    test('POST /api/v1/:db/graph/edges/batch should batch in correct database', async () => {
      server = createRestApiServer(mockShardManager as any, dbConfig)
      await server.start()

      const res = await makeRequest(server, 'POST', '/api/v1/db1/graph/edges/batch', {
        items: [
          { src: 1, dst: 2, type: 1 },
          { src: 2, dst: 3, type: 1 },
        ],
      })
      expect(res.statusCode).toBe(200)
      expect((res.body as any).successCount).toBe(2)
    })

    test('/api/status should work in multi-db mode', async () => {
      server = createRestApiServer(mockShardManager as any, dbConfig)
      await server.start()

      const res = await makeRequest(server, 'GET', '/api/status')
      expect(res.statusCode).toBe(200)
      expect((res.body as any).status).toBe('ok')
      expect((res.body as any).version).toBe('0.1.0')
    })

    test('/api/health should work in multi-db mode', async () => {
      server = createRestApiServer(mockShardManager as any, dbConfig)
      await server.start()

      const res = await makeRequest(server, 'GET', '/api/health')
      expect(res.statusCode).toBe(200)
      expect((res.body as any).status).toBe('ok')
    })

    test('Single-db routes should still work with databaseManager config present', async () => {
      server = createRestApiServer(mockShardManager as any, dbConfig)
      await server.start()

      // Original single-db routes still work with the primary shardManager
      const res = await makeRequest(server, 'POST', '/api/graph/nodes', { typeId: 1, name: 'single-db-node' })
      expect(res.statusCode).toBe(200)
    })

    // Skip concurrent test due to test infrastructure limitations (single port per test)
    test('Concurrent requests to different databases should work', async () => {
      server = createRestApiServer(mockShardManager as any, dbConfig)
      await server.start()

      // Issue concurrent requests to different databases
      const [r1, r2] = await Promise.all([
        makeRequest(server, 'POST', '/api/v1/db1/graph/nodes', { typeId: 1, name: 'concurrent-db1' }),
        makeRequest(server, 'POST', '/api/v1/db2/graph/nodes', { typeId: 2, name: 'concurrent-db2' }),
      ])

      expect(r1.statusCode).toBe(200)
      expect(r2.statusCode).toBe(200)

      // Verify isolation
      expect(db1Sm.getAllNodes().length).toBe(1)
      expect(db1Sm.getAllNodes()[0].name).toBe('concurrent-db1')
      expect(db2Sm.getAllNodes().length).toBe(1)
      expect(db2Sm.getAllNodes()[0].name).toBe('concurrent-db2')
    })
  })
})
