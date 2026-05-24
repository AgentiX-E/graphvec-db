// ============================================================
// RestApiServer — REST API 服务层
// ============================================================

import * as http from 'http'
import { ShardManager } from '../shard/shard-manager'
import {
  UserRegistry, RateLimiter, authenticateBasic, authenticateToken, requireAuth,
} from '../security/auth'
import { RBAC } from '../security/rbac'
import { RowLevelSecurity, RLSContext } from '../security/rls'
import { Role } from '../types'

// ──────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────

export interface RestApiConfig {
  port: number
  host: string
  adminToken?: string
  bodySizeLimit?: number
  enableCors?: boolean
  enableRatelimit?: boolean
  enableAuth?: boolean
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

/**
 * 发送 JSON 响应
 */
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

/**
 * 构建路由处理链
 */
type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsed: URL,
) => Promise<void> | void

interface Route {
  method: string
  path: string
  handler: RouteHandler
  auth?: boolean
}

// ──────────────────────────────────────────
// RestApiServerImpl
// ──────────────────────────────────────────

export function createRestApiServer(
  shardManager: ShardManager,
  config: RestApiConfig,
): RestApiServer {
  const userRegistry = new UserRegistry()
  const rateLimiter = new RateLimiter()
  const server = http.createServer()
  let actualPort: number = config.port

  const routes: Route[] = [
    // GET /api/status
    {
      method: 'GET',
      path: '/api/status',
      handler: async (_req, res) => {
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
      handler: async (req, res) => {
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

    // POST /api/register
    {
      method: 'POST',
      path: '/api/register',
      handler: async (req, res) => {
        const body = await parseBody(req) as Record<string, unknown>
        if (!body.username || !body.password || !body.role) {
          jsonResponse(res, 400, { error: 'username, password, and role are required' })
          return
        }
        await userRegistry.register(
          String(body.username),
          String(body.password),
          String(body.role),
        )
        jsonResponse(res, 200, { message: 'registered' })
      },
    },

    // POST /api/login
    {
      method: 'POST',
      path: '/api/login',
      handler: async (req, res) => {
        const body = await parseBody(req) as Record<string, unknown>
        if (!body.username || !body.password) {
          jsonResponse(res, 400, { error: 'username and password are required' })
          return
        }
        try {
          const token = await authenticateBasic(
            userRegistry,
            String(body.username),
            String(body.password),
          )
          jsonResponse(res, 200, { token })
        } catch {
          jsonResponse(res, 401, { error: 'invalid credentials' })
        }
      },
    },

    // POST /api/admin/disable-user
    {
      method: 'POST',
      path: '/api/admin/disable-user',
      handler: async (req, res) => {
        const body = await parseBody(req) as Record<string, unknown>
        if (!body.username) {
          jsonResponse(res, 400, { error: 'username is required' })
          return
        }
        const ok = userRegistry.disable(String(body.username))
        jsonResponse(res, ok ? 200 : 404, ok ? { message: 'disabled' } : { error: 'user not found' })
      },
    },

    // POST /api/admin/change-role
    {
      method: 'POST',
      path: '/api/admin/change-role',
      handler: async (req, res) => {
        const body = await parseBody(req) as Record<string, unknown>
        if (!body.username || !body.role) {
          jsonResponse(res, 400, { error: 'username and role are required' })
          return
        }
        const ok = userRegistry.changeRole(String(body.username), String(body.role))
        jsonResponse(res, ok ? 200 : 404, ok ? { message: 'role changed' } : { error: 'user not found' })
      },
    },

    // POST /api/admin/unregister
    {
      method: 'POST',
      path: '/api/admin/unregister',
      handler: async (req, res) => {
        const body = await parseBody(req) as Record<string, unknown>
        if (!body.username) {
          jsonResponse(res, 400, { error: 'username is required' })
          return
        }
        const ok = userRegistry.unregister(String(body.username))
        jsonResponse(res, ok ? 200 : 404, ok ? { message: 'unregistered' } : { error: 'user not found' })
      },
    },

    // POST /api/admin/ratelimit-allow
    {
      method: 'POST',
      path: '/api/admin/ratelimit-allow',
      handler: async (req, res) => {
        const body = await parseBody(req) as Record<string, unknown>
        if (!body.key) {
          jsonResponse(res, 400, { error: 'key is required' })
          return
        }
        rateLimiter.allow(String(body.key))
        jsonResponse(res, 200, { message: 'allowed' })
      },
    },

    // POST /api/admin/ratelimit-reset
    {
      method: 'POST',
      path: '/api/admin/ratelimit-reset',
      handler: async (_req, res) => {
        rateLimiter.reset()
        jsonResponse(res, 200, { message: 'reset' })
      },
    },

    // GET /api/headers
    {
      method: 'GET',
      path: '/api/headers',
      handler: async (_req, res, _parsed) => {
        jsonResponse(res, 200, { secure: true })
      },
    },
  ]

  server.on('request', async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      const parsed = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

      // CORS headers
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

      // Find matching route
      const method = req.method?.toUpperCase() ?? 'GET'
      const path = parsed.pathname
      const matched = routes.find(r => r.method === method && r.path === path)

      if (!matched) {
        jsonResponse(res, 404, { error: 'Not Found' })
        return
      }

      // Auth
      const authRequired = matched.auth || config.enableAuth || process.env.NODE_ENV === 'production'
      if (authRequired) {
        const authHeader = req.headers['authorization']
        if (!authHeader) {
          jsonResponse(res, 401, { error: 'Unauthorized' })
          return
        }
        try {
          const result = await authenticateToken(authHeader as string)
          if (!result) {
            jsonResponse(res, 401, { error: 'Unauthorized' })
            return
          }
          // 注入用户信息到请求对象
          const user = result as { user: string; role: string }
          ;(req as any).user = user

          // RBAC 权限检查：根据路由和 HTTP 方法决定所需权限
          const perm = _routeToPermission(matched.path, matched.method)
          if (perm) {
            try {
              RBAC.checkPermission(user.role as Role, perm)
            } catch {
              jsonResponse(res, 403, { error: 'Forbidden: insufficient permissions' })
              return
            }
          }
        } catch {
          jsonResponse(res, 401, { error: 'Invalid token' })
          return
        }
      }

      // Admin token check for admin routes
      if (path.startsWith('/api/admin/') && config.adminToken) {
        const authHeader = req.headers['authorization']
        if (!authHeader || authHeader !== `Bearer ${config.adminToken}`) {
          jsonResponse(res, 401, { error: 'Admin token required' })
          return
        }
      }

      await matched.handler(req, res, parsed)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Internal Server Error'
      jsonResponse(res, 500, { error: message })
    }
  })

  return {
    start(): Promise<void> {
      return new Promise((resolve) => {
        server.listen(config.port, config.host, () => {
          const addr = server.address()
          if (addr && typeof addr === 'object') {
            actualPort = addr.port
          }
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
      return actualPort
    },
  }
}

/**
 * 根据路由 path 和 HTTP method 推导 RBAC 权限
 */
function _routeToPermission(path: string, method: string): string | null {
  // admin 端点需要 admin 权限
  if (path.startsWith('/api/admin/')) return 'admin'

  // 写操作
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    if (method === 'DELETE') return 'delete'
    return 'write'
  }

  // 读操作
  if (method === 'GET') return 'read'

  return null
}
