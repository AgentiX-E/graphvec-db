// ============================================================
// RestApiServer 测试 — mTLS 认证
// ============================================================

import { createRestApiServer, RestApiServer, RestApiConfig, jsonResponse, parseBody } from './rest'
import { NodeRecord, EdgeRecord, Role } from '../types'
import { Authenticator, RBAC } from '../security/auth'
import { TLSConfig } from '../security/tls'
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

  getShardStatus(): Array<{ rangeId: string; raftRole: string; nodeCount: number }> {
    return [{ rangeId: 'range-0', raftRole: 'leader', nodeCount: this.allNodes.length }]
  }

  getRange(_rangeId: string): { engine: { stats(): { nodeCount: number; edgeCount: number; diskSizeBytes: number } } } {
    return {
      engine: {
        stats: () => ({
          nodeCount: this.allNodes.length,
          edgeCount: this.edgeStore.size,
          diskSizeBytes: 0,
        }),
      },
    }
  }

  getAllRanges(): Map<string, { engine: { stats(): { nodeCount: number; edgeCount: number; diskSizeBytes: number } } }> {
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
})
