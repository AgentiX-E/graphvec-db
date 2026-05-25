// ============================================================
// RestApiServer — mTLS 认证 REST API 服务层
// ============================================================

import * as https from 'https'
import * as http from 'http'
import { ShardManager } from '../shard/shard-manager'
import { Authenticator, RBAC } from '../security/auth'
import { TLSConfig } from '../security/tls'
import { Role, AuthResult, AuthError } from '../types'

// ──────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────

export interface RestApiConfig {
  port: number
  host: string
  authenticator: Authenticator
  tlsConfig: TLSConfig
  bodySizeLimit?: number
  enableCors?: boolean
  enableRatelimit?: boolean
  maxRatelimitPerMin?: number
}

export interface RestApiServer {
  start(): Promise<void>
  stop(): Promise<void>
  getPort(): number
}

// ──────────────────────────────────────────
// 请求解析辅助
// ──────────────────────────────────────────

export function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString()
    })
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch {
        reject(new Error('Invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

export function jsonResponse(
  res: http.ServerResponse,
  statusCode: number,
  data: unknown,
): void {
  const body = JSON.stringify(data)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsed: URL,
  auth: AuthResult,
) => Promise<void> | void

interface Route {
  method: string
  path: string
  handler: RouteHandler
  requireAuth?: boolean
  requiredPermission?: string
}

// ──────────────────────────────────────────
// 简单的内存速率限制器
// ──────────────────────────────────────────

interface RateLimitEntry {
  count: number
  resetAt: number
}

class MemoryRateLimiter {
  private entries = new Map<string, RateLimitEntry>()
  private maxPerMin: number

  constructor(maxPerMin: number = 1000) {
    this.maxPerMin = maxPerMin
  }

  isAllowed(key: string): boolean {
    const now = Date.now()
    const entry = this.entries.get(key)

    if (!entry || now >= entry.resetAt) {
      this.entries.set(key, { count: 1, resetAt: now + 60000 })
      return true
    }

    if (entry.count >= this.maxPerMin) {
      return false
    }

    entry.count++
    return true
  }

  reset(): void {
    this.entries.clear()
  }
}

/**
 * 尝试从请求中提取证书 CN（兼容 https 和 http）
 * https: req.socket.getPeerCertificate()
 * http (测试无证书): null
 */
function extractCN(req: http.IncomingMessage): string | null {
  try {
    const socket = (req as any).socket ?? (req as any).connection
    if (!socket || typeof socket.getPeerCertificate !== 'function') return null
    const cert = socket.getPeerCertificate()
    if (!cert || !cert.subject) return null
    return cert.subject.CN || null
  } catch {
    return null
  }
}

// ──────────────────────────────────────────
// RestApiServer — 完整实现
// ──────────────────────────────────────────

export function createRestApiServer(
  shardManager: ShardManager,
  config: RestApiConfig,
): RestApiServer {
  const rateLimiter = new MemoryRateLimiter(config.maxRatelimitPerMin ?? 1000)
  const authenticator = config.authenticator

  const routes: Route[] = [
    // GET /api/status
    {
      method: 'GET',
      path: '/api/status',
      requireAuth: false,
      handler: async (_req, res, _parsed, _auth) => {
        const status = shardManager.getShardStatus()
        jsonResponse(res, 200, {
          status: 'ok',
          version: '0.1.0',
          shards: status,
        })
      },
    },

    // POST /api/graph/nodes
    {
      method: 'POST',
      path: '/api/graph/nodes',
      requireAuth: true,
      requiredPermission: 'write',
      handler: async (req, res, _parsed, auth) => {
        const body = await parseBody(req) as Record<string, unknown>
        if (!body.typeId || !body.name) {
          jsonResponse(res, 400, { error: 'typeId and name are required' })
          return
        }
        const nodeId = await shardManager.upsertNode(
          Number(body.typeId),
          String(body.name),
        )
        jsonResponse(res, 200, { id: nodeId })
      },
    },

    // GET /api/graph/node/:id
    {
      method: 'GET',
      path: '/api/graph/node',
      requireAuth: true,
      requiredPermission: 'read',
      handler: async (req, res, _parsed, auth) => {
        const body = await parseBody(req) as Record<string, unknown>
        if (!body.id) {
          jsonResponse(res, 400, { error: 'id is required' })
          return
        }
        const node = await shardManager.getNode(Number(body.id))
        if (!node) {
          jsonResponse(res, 404, { error: 'not found' })
          return
        }
        jsonResponse(res, 200, node)
      },
    },

    // DELETE /api/graph/node/:id
    {
      method: 'DELETE',
      path: '/api/graph/node',
      requireAuth: true,
      requiredPermission: 'delete',
      handler: async (req, res, _parsed, auth) => {
        const body = await parseBody(req) as Record<string, unknown>
        if (!body.id) {
          jsonResponse(res, 400, { error: 'id is required' })
          return
        }
        await shardManager.deleteNode(Number(body.id))
        jsonResponse(res, 200, { message: 'deleted' })
      },
    },

    // GET /api/health
    {
      method: 'GET',
      path: '/api/health',
      requireAuth: false,
      handler: async (_req, res, _parsed, _auth) => {
        jsonResponse(res, 200, { status: 'ok' })
      },
    },
  ]

  const server = https.createServer({
    ...config.tlsConfig.getServerOptions(),
  })

  server.on('request', async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      const parsed = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

      // CORS
      if (config.enableCors) {
        const origin = process.env.CORS_ORIGIN || '*'
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

        if (req.method === 'OPTIONS') {
          res.writeHead(204)
          res.end()
          return
        }
      }

      // Security headers
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('X-Frame-Options', 'DENY')
      res.setHeader('X-XSS-Protection', '1; mode=block')

      // Body size limit
      if (config.bodySizeLimit && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')) {
        const contentLength = parseInt(req.headers['content-length'] ?? '0', 10)
        if (contentLength > config.bodySizeLimit) {
          jsonResponse(res, 413, { error: 'Request body too large' })
          return
        }
      }

      // Rate limit
      if (config.enableRatelimit) {
        const clientIp = req.socket.remoteAddress ?? 'unknown'
        if (!rateLimiter.isAllowed(clientIp)) {
          jsonResponse(res, 429, { error: 'Too Many Requests' })
          return
        }
      }

      // 匹配路由
      const method = req.method?.toUpperCase() ?? 'GET'
      const path = parsed.pathname
      const matched = routes.find(r => r.method === method && r.path === path)

      if (!matched) {
        jsonResponse(res, 404, { error: 'Not Found' })
        return
      }

      // mTLS 认证
      let auth: AuthResult | null = null
      if (matched.requireAuth) {
        const cn = extractCN(req)
        if (!cn) {
          jsonResponse(res, 401, { error: 'Client certificate required' })
          return
        }

        try {
          auth = authenticator.authenticate(cn)
        } catch (err) {
          const statusCode = (err instanceof AuthError) ? err.statusCode : 401
          jsonResponse(res, statusCode, { error: err instanceof Error ? err.message : 'Authentication failed' })
          return
        }

        // RBAC
        if (matched.requiredPermission) {
          try {
            RBAC.checkPermission(auth.role, matched.requiredPermission)
          } catch {
            jsonResponse(res, 403, { error: 'Forbidden: insufficient permissions' })
            return
          }
        }
      }

      await matched.handler(req, res, parsed, auth as AuthResult)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Internal Server Error'
      jsonResponse(res, 500, { error: message })
    }
  })

  return {
    start(): Promise<void> {
      return new Promise((resolve) => {
        server.listen(config.port, config.host, () => {
          resolve()
        })
      })
    },

    stop(): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => resolve())
      })
    },

    getPort(): number {
      const addr = server.address()
      if (addr && typeof addr === 'object') return addr.port
      return config.port
    },
  }
}
