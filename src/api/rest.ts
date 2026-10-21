// ============================================================
// RestApiServer — mTLS 认证 REST API 服务层
// ============================================================

import * as https from 'https'
import * as http from 'http'
import * as fs from 'fs'
import * as crypto from 'crypto'
import { ShardManager } from '../shard/shard-manager'
import { Authenticator, RBAC, bodySizeLimitMiddleware, BODY_SIZE_LIMIT } from '../security/auth'
import { TLSConfig } from '../security/tls'
import { Role, AuthResult, AuthError } from '../types'
import { ErrorCode, inferErrorCode } from './error-codes'
import type { OutboxReplicationManager } from '../core/outbox-replication'
import type { DatabaseManager, DatabaseInstance } from '../core/database-manager'
import { register } from 'prom-client'
import { executeIR, QuerySpec, buildIRFromSpec, optimizeIR } from './query-planner'
import { GraphQLSubscription } from './graphql-subscription'
import type { EventBus } from '../core/event-bus'
import { QuerySlowLog } from '../ops/query-slow-log'
import { GnnInferenceEngine } from '../algorithms/gnn-engine'
import { enrichNodeLinks, enrichEdgeLinks, enrichListLinks, enrichQueryLinks, type EnrichedResponse } from './hypermedia'
import { getDefaultTenantManager } from '../security/tenant-manager'

// ──────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────

export interface TlsServerOptions {
  /** Path to the TLS private key file (PEM format) */
  key: string
  /** Path to the TLS certificate file (PEM format) */
  cert: string
  /** Path to the CA certificate file for mTLS client verification (PEM format) */
  ca?: string
  /** Enable mutual TLS (requires ca and requestCert); when true, clients without a valid cert are rejected */
  requestCert?: boolean
}

export interface RestApiConfig {
  port: number
  host: string
  authenticator: Authenticator
  tlsConfig: TLSConfig
  /** Optional inline TLS options — when provided, creates the server directly with these certs.
   *  Provides a simpler alternative to tlsConfig for cases that don't need cert hot-reload. */
  tls?: TlsServerOptions
  /** 请求体大小限制（字节），默认 10MB；设为 0 拒绝所有；设为 undefined 不限制 */
  bodySizeLimit?: number
  enableCors?: boolean
  enableRatelimit?: boolean
  maxRatelimitPerMin?: number
  /** Multi-Leader Outbox 复制管理器（暴露 admin 管理接口） */
  replicationManager?: OutboxReplicationManager
  /** 多数据库管理器（Optional），提供后自动启用 /api/v1/:db/... 路由 */
  databaseManager?: DatabaseManager
  /** EventBus 实例（Optional），提供后启用 GraphQL Subscription SSE 端点 */
  eventBus?: EventBus
  /** HealthChecker 实例（Optional），提供后启用 /health/live 和 /health/ready 端点 */
  healthChecker?: import('./health-checker').HealthChecker
  /** QuerySlowLog 实例（Optional），提供后注入慢查询日志功能到查询路由 */
  slowLog?: QuerySlowLog
  /** GnnInferenceEngine 实例（Optional），提供后启用 /api/v1/gnn/... 推理端点 */
  gnnEngine?: GnnInferenceEngine
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
  // For error responses, normalize to unified format:
  // { error: string, code: number, errorCode: string, details?: any }
  let bodyData = data
  if (statusCode >= 400) {
    const existing = data as Record<string, unknown>
    if (typeof data === 'object' && data !== null) {
      bodyData = {
        error: existing.error ?? inferErrorMessage(statusCode),
        code: statusCode,
        errorCode: existing.errorCode ?? inferErrorCode(statusCode),
        ...(existing.details !== undefined ? { details: existing.details } : {}),
      }
    }
  }
  const body = JSON.stringify(bodyData)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Infer a human-readable error message from status code. */
function inferErrorMessage(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return 'Bad Request'
    case 401:
      return 'Unauthorized'
    case 403:
      return 'Forbidden'
    case 404:
      return 'Not Found'
    case 409:
      return 'Conflict'
    case 413:
      return 'Payload Too Large'
    case 429:
      return 'Too Many Requests'
    case 500:
      return 'Internal Server Error'
    case 503:
      return 'Service Unavailable'
    default:
      return `HTTP ${statusCode}`
  }
}

type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsed: URL,
  params: Record<string, string>,
  auth: AuthResult,
) => Promise<void> | void

interface Route {
  method: string
  path: string
  handler: RouteHandler
  requireAuth?: boolean
  requiredPermission?: string
  /** Optional：子图（租户）隔离标识。如果设置，会在认证后检查子图 ACL */
  subgraph?: string
}

// ── GraphQL Subscription via SSE ────────

/**
 * 处理 GraphQL Subscription SSE 请求
 *
 * 端点: GET /api/v1/graphql/subscribe?events=node:created,node:deleted
 *
 * 配置要求:
 * - config.eventBus 必须提供 EventBus 实例
 */
function handleGraphQLSubscription(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: RestApiConfig,
): void {
  const bus = config.eventBus
  if (!bus) {
    jsonResponse(res, 404, { error: 'EventBus not available' })
    return
  }

  const parsed = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const events = parsed.searchParams.get('events') ?? undefined

  const sub = new GraphQLSubscription(bus)
  const cleanup = sub.subscribe(res, { events })

  // 客户端断开时清理
  req.on('close', () => {
    cleanup()
  })
}

// ──────────────────────────────────────────
// 简单的内存速率限制器
// ──────────────────────────────────────────

interface RateLimitEntry {
  count: number
  resetAt: number
}

export class MemoryRateLimiter {
  private entries = new Map<string, RateLimitEntry>()
  private maxRequests: number
  private windowMs: number
  private cleanupInterval: ReturnType<typeof setInterval> | null = null

  constructor(options?: Partial<{ maxRequests: number; windowMs: number }>) {
    this.maxRequests = options?.maxRequests ?? 100
    this.windowMs = options?.windowMs ?? 60_000
  }

  isAllowed(key: string): boolean {
    const now = Date.now()
    const entry = this.entries.get(key)

    if (!entry || now >= entry.resetAt) {
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs })
      return true
    }

    if (entry.count >= this.maxRequests) {
      return false
    }

    entry.count++
    return true
  }

  check(key: string): { allowed: boolean; resetAt: number; remaining: number } {
    const now = Date.now()
    let entry = this.entries.get(key)

    if (!entry || now >= entry.resetAt) {
      entry = { count: 1, resetAt: now + this.windowMs }
      this.entries.set(key, entry)
      return { allowed: true, resetAt: entry.resetAt, remaining: this.maxRequests - 1 }
    }

    if (entry.count >= this.maxRequests) {
      return { allowed: false, resetAt: entry.resetAt, remaining: 0 }
    }

    entry.count++
    return { allowed: true, resetAt: entry.resetAt, remaining: this.maxRequests - entry.count }
  }

  startCleanup(intervalMs: number = 60_000): void {
    this.stopCleanup()
    this.cleanupInterval = setInterval(() => this.cleanup(), intervalMs)
    if (this.cleanupInterval && typeof (this.cleanupInterval as any).unref === 'function') {
      (this.cleanupInterval as any).unref()
    }
  }

  stopCleanup(): void {
    if (this.cleanupInterval !== null) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
  }

  cleanup(): void {
    const now = Date.now()
    for (const [key, entry] of this.entries) {
      if (now >= entry.resetAt) {
        this.entries.delete(key)
      }
    }
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
// 路由匹配 — 支持路径参数
// ──────────────────────────────────────────

/**
 * 将路径模式匹配到请求路径，返回提取的路径参数。
 * 支持 :param 单段参数和 * 通配符（仅尾部）。
 *
 * Example: 
 *   _matchRoute('/api/graph/node/:id', '/api/graph/node/42')
 *     → { id: '42' }
 *
 *   _matchRoute('/api/graph/edges/:nodeId', '/api/graph/edges/42')
 *     → { nodeId: '42' }
 *
 *   _matchRoute('/api/graph/node', '/api/graph/node')
 *     → {}  （精确匹配，无参数）
 */
export function _matchRoute(
  pattern: string,
  requestPath: string,
): Record<string, string> | null {
  const patternParts = pattern.split('/')
  const requestParts = requestPath.split('/')

  if (patternParts.length !== requestParts.length) {
    return null
  }

  const params: Record<string, string> = {}

  for (let i = 0; i < patternParts.length; i++) {
    const pPart = patternParts[i]
    const rPart = requestParts[i]

    if (pPart.startsWith(':')) {
      // 路径参数 — 提取值
      params[pPart.slice(1)] = rPart
    } else if (pPart !== rPart) {
      // 静态段不匹配
      return null
    }
  }

  return params
}

/**
 * 对没有 Content-Length 的请求应用流式 body size limit
 * 返回 true 表示已处理响应（调用方应 return）
 */
function applyBodySizeLimit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  limit: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (limit <= 0) {
      jsonResponse(res, 413, { error: 'Request body size limit is set to 0, rejecting all body payloads' })
      resolve(true)
      return
    }

    const method = req.method?.toUpperCase() ?? 'GET'
    if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') {
      resolve(false)
      return
    }

    let totalBytes = 0
    let aborted = false

    const onData = (chunk: Buffer) => {
      if (aborted) return
      totalBytes += Buffer.byteLength(chunk)
      if (totalBytes > limit) {
        aborted = true
        req.destroy()
        if (!res.headersSent) {
          jsonResponse(res, 413, { error: 'Request body exceeded limit (streamed)' })
        }
        resolve(true)
      }
    }

    const onEnd = () => {
      if (!aborted) {
        cleanup()
        resolve(false)
      }
    }

    const cleanup = () => {
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
    }

    const onError = (_err: Error) => {
      aborted = true
      cleanup()
      if (!res.headersSent) {
        jsonResponse(res, 413, { error: 'Request body read error' })
      }
      resolve(true)
    }

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

// ──────────────────────────────────────────
// 构建 HTTPS 服务器选项（内置 tls 字段）
// ──────────────────────────────────────────

/**
 * 从 TlsServerOptions 构建 https.ServerOptions。
 * 读取证书文件，如果文件不存在则抛出明确的ErrorInfo。
 */
function buildHttpsOptions(tlsOpts: TlsServerOptions): https.ServerOptions {
  if (!fs.existsSync(tlsOpts.key)) {
    throw new Error(`TLS key file not found: ${tlsOpts.key}`)
  }
  if (!fs.existsSync(tlsOpts.cert)) {
    throw new Error(`TLS cert file not found: ${tlsOpts.cert}`)
  }

  const opts: https.ServerOptions = {
    key: fs.readFileSync(tlsOpts.key, 'utf-8'),
    cert: fs.readFileSync(tlsOpts.cert, 'utf-8'),
  }

  // mTLS support: when ca is provided and requestCert is enabled
  if (tlsOpts.ca && tlsOpts.requestCert) {
    if (!fs.existsSync(tlsOpts.ca)) {
      throw new Error(`TLS CA file not found: ${tlsOpts.ca}`)
    }
    opts.ca = fs.readFileSync(tlsOpts.ca, 'utf-8')
    opts.requestCert = true
    opts.rejectUnauthorized = true
  } else if (tlsOpts.ca) {
    // CA is provided without explicit requestCert — still add CA but don't require client cert
    if (!fs.existsSync(tlsOpts.ca)) {
      throw new Error(`TLS CA file not found: ${tlsOpts.ca}`)
    }
    opts.ca = fs.readFileSync(tlsOpts.ca, 'utf-8')
  }

  return opts
}

// ──────────────────────────────────────────
// RestApiServer — 完整实现
// ──────────────────────────────────────────

export function createRestApiServer(
  shardManager: ShardManager,
  config: RestApiConfig,
): RestApiServer {
  const rateLimiter = new MemoryRateLimiter({
    maxRequests: config.maxRatelimitPerMin ?? 100,
    windowMs: 60_000,
  })
  const authenticator = config.authenticator

  const routes: Route[] = [
    // ── 健康检查 ──────────────────────────────

    // GET /api/status
    {
      method: 'GET',
      path: '/api/status',
      requireAuth: false,
      handler: async (_req, res, _parsed, _params, _auth) => {
        const status = shardManager.getShardStatus()
        jsonResponse(res, 200, {
          status: 'ok',
          version: '0.1.0',
          shards: status,
        })
      },
    },

    // GET /api/health
    {
      method: 'GET',
      path: '/api/health',
      requireAuth: false,
      handler: async (_req, res, _parsed, _params, _auth) => {
        jsonResponse(res, 200, { status: 'ok' })
      },
    },

    // GET /health/live (仅当 healthChecker 可用时注册)
    ...(config.healthChecker
      ? [{
          method: 'GET' as const,
          path: '/health/live',
          requireAuth: false,
          handler: async (_req: http.IncomingMessage, res: http.ServerResponse) => {
            const result = await config.healthChecker!.livez()
            jsonResponse(res, result.ok ? 200 : 503, result)
          },
        }]
      : []),

    // GET /health/ready (仅当 healthChecker 可用时注册)
    ...(config.healthChecker
      ? [{
          method: 'GET' as const,
          path: '/health/ready',
          requireAuth: false,
          handler: async (_req: http.IncomingMessage, res: http.ServerResponse) => {
            const result = await config.healthChecker!.readyz()
            jsonResponse(res, result.ok ? 200 : 503, result)
          },
        }]
      : []),

    // ── 节点 CRUD ────────────────────────────

    // POST /api/graph/nodes
    {
      method: 'POST',
      path: '/api/graph/nodes',
      requireAuth: true,
      requiredPermission: 'write',
      handler: async (req, res, _parsed, _params, auth) => {
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
      path: '/api/graph/node/:id',
      requireAuth: true,
      requiredPermission: 'read',
      handler: async (_req, res, _parsed, params, auth) => {
        const id = Number(params.id)
        if (isNaN(id)) {
          jsonResponse(res, 400, { error: 'Invalid node id' })
          return
        }
        const node = await shardManager.getNode(id)
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
      path: '/api/graph/node/:id',
      requireAuth: true,
      requiredPermission: 'delete',
      handler: async (_req, res, _parsed, params, auth) => {
        const id = Number(params.id)
        if (isNaN(id)) {
          jsonResponse(res, 400, { error: 'Invalid node id' })
          return
        }
        await shardManager.deleteNode(id)
        jsonResponse(res, 200, { message: 'deleted' })
      },
    },

    // ── 边 CRUD ──────────────────────────────

    // POST /api/graph/edges — 创建边
    {
      method: 'POST',
      path: '/api/graph/edges',
      requireAuth: true,
      requiredPermission: 'write',
      handler: async (req, res, _parsed, _params, auth) => {
        const body = await parseBody(req) as Record<string, unknown>
        if (body.src === undefined || body.dst === undefined || body.type === undefined) {
          jsonResponse(res, 400, { error: 'src, dst, and type are required' })
          return
        }
        const src = Number(body.src)
        const dst = Number(body.dst)
        const typeId = Number(body.type)
        if (isNaN(src) || isNaN(dst) || isNaN(typeId)) {
          jsonResponse(res, 400, { error: 'src, dst, and type must be numbers' })
          return
        }
        await shardManager.upsertEdge(src, dst, typeId, {
          props: body.props !== undefined ? (body.props as any) : undefined,
        })
        jsonResponse(res, 200, { message: 'edge created' })
      },
    },

    // GET /api/graph/edges/:nodeId — 获取节点的邻边
    {
      method: 'GET',
      path: '/api/graph/edges/:nodeId',
      requireAuth: true,
      requiredPermission: 'read',
      handler: async (_req, res, _parsed, params, auth) => {
        const nodeId = Number(params.nodeId)
        if (isNaN(nodeId)) {
          jsonResponse(res, 400, { error: 'Invalid node id' })
          return
        }
        const result = await shardManager.neighbors(nodeId)
        jsonResponse(res, 200, {
          nodeId,
          edges: result.edges,
          nodes: result.nodes,
          edgeCount: result.edges.length,
          nodeCount: result.nodes.length,
        })
      },
    },

    // DELETE /api/graph/edge — 删除边（body 传参）
    {
      method: 'DELETE',
      path: '/api/graph/edge',
      requireAuth: true,
      requiredPermission: 'delete',
      handler: async (req, res, _parsed, _params, auth) => {
        const body = await parseBody(req) as Record<string, unknown>
        if (body.src === undefined || body.dst === undefined || body.type === undefined) {
          jsonResponse(res, 400, { error: 'src, dst, and type are required' })
          return
        }
        const src = Number(body.src)
        const dst = Number(body.dst)
        const typeId = Number(body.type)
        if (isNaN(src) || isNaN(dst) || isNaN(typeId)) {
          jsonResponse(res, 400, { error: 'src, dst, and type must be numbers' })
          return
        }

        // ShardManager 没有 deleteEdge 方法，通过所在 range 的 engine 直接调用
        try {
          const rangeId = typeof (shardManager as any)._getRangeForNodeId === 'function'
            ? (shardManager as any)._getRangeForNodeId(src)
            : (shardManager as any).getRouter().getRangeForKey(String(src))
          const range = (shardManager as any).getRange(rangeId)
          await range.write({
            type: 'delete_edge',
            payload: { src, dst, typeId },
          })
          jsonResponse(res, 200, { message: 'edge deleted' })
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Failed to delete edge'
          jsonResponse(res, 500, { error: msg })
        }
      },
    },

    // ── 批量操作 ──────────────────────────────

    // POST /api/graph/nodes/batch
    {
      method: 'POST',
      path: '/api/graph/nodes/batch',
      requireAuth: true,
      requiredPermission: 'write',
      handler: async (req, res, _parsed, _params, auth) => {
        const body = await parseBody(req) as Record<string, unknown>
        const items = body.items as Array<Record<string, unknown>> | undefined
        if (!Array.isArray(items) || items.length === 0) {
          jsonResponse(res, 400, { error: 'items array is required and must be non-empty' })
          return
        }
        const inputs: Array<{ typeId: number; name: string }> = []
        for (const item of items) {
          if (!item.id || !item.type) {
            jsonResponse(res, 400, { error: 'each item must have id and type' })
            return
          }
          inputs.push({
            typeId: Number(item.type),
            name: String(item.id),
          })
        }
        const ids = await shardManager.batchUpsertNodes(inputs)
        jsonResponse(res, 200, { ids, count: ids.length })
      },
    },

    // POST /api/graph/edges/batch
    {
      method: 'POST',
      path: '/api/graph/edges/batch',
      requireAuth: true,
      requiredPermission: 'write',
      handler: async (req, res, _parsed, _params, auth) => {
        const body = await parseBody(req) as Record<string, unknown>
        const items = body.items as Array<Record<string, unknown>> | undefined
        if (!Array.isArray(items) || items.length === 0) {
          jsonResponse(res, 400, { error: 'items array is required and must be non-empty' })
          return
        }
        let successCount = 0
        const errors: Array<{ index: number; error: string }> = []

        for (let i = 0; i < items.length; i++) {
          const item = items[i]
          if (item.src === undefined || item.dst === undefined || item.type === undefined) {
            errors.push({ index: i, error: 'src, dst, and type are required' })
            continue
          }
          try {
            await shardManager.upsertEdge(
              Number(item.src),
              Number(item.dst),
              Number(item.type),
              item.props ? { props: item.props as any } : undefined,
            )
            successCount++
          } catch (err: unknown) {
            errors.push({
              index: i,
              error: err instanceof Error ? err.message : 'Unknown error',
            })
          }
        }

        jsonResponse(res, 200, {
          successCount,
          errorCount: errors.length,
          errors: errors.length > 0 ? errors : undefined,
        })
      },
    },

    // POST /api/v1/graph/node/batch-neighbors — 批量邻居查询
    {
      method: 'POST',
      path: '/api/v1/graph/node/batch-neighbors',
      requireAuth: true,
      requiredPermission: 'read',
      handler: async (req, res, _parsed, _params, auth) => {
        const body = await parseBody(req) as Record<string, unknown>
        const ids = body.ids as number[] | undefined
        if (!Array.isArray(ids) || ids.length === 0) {
          jsonResponse(res, 400, { error: 'ids array is required and must be non-empty' })
          return
        }
        const depth = body.depth !== undefined ? Number(body.depth) : undefined
        const edgeTypeFilter = body.edgeTypeFilter as number[] | undefined

        const result = await shardManager.batchNeighbors(ids, { maxDepth: depth, edgeTypeFilter })
        // 序列化 Map 为 JSON 对象
        const serialized: Record<string, unknown> = {}
        for (const [nodeId, val] of result) {
          serialized[String(nodeId)] = {
            edges: val.edges,
            nodes: val.nodes,
            edgeCount: val.edges.length,
            nodeCount: val.nodes.length,
          }
        }
        jsonResponse(res, 200, {
          nodeIds: ids,
          results: serialized,
          totalNodeCount: result.size,
        })
      },
    },

    // ── 查询端点 ──────────────────────────────

    // POST /api/query — 参数化查询
    {
      method: 'POST',
      path: '/api/query',
      requireAuth: true,
      requiredPermission: 'read',
      handler: async (req, res, _parsed, _params, auth) => {
        const body = await parseBody(req) as Record<string, unknown>

        if (!body.query && !body.match) {
          jsonResponse(res, 400, {
            error: 'query string or match object is required',
          })
          return
        }

        const queryStr = String(body.query || '')

        // 包装查询执行以支持慢查询日志
        const executeQuery = async () => {
          // Build QuerySpec from the request body
          const spec: QuerySpec = body.query
            ? parseQueryString(String(body.query))
            : parseMatchBody(body)

          const plan = buildIRFromSpec(spec)
          const optimized = optimizeIR(plan)
          const results = await executeIR(optimized, shardManager)

          // 注入 HATEOAS _links
          const data = {
            results,
            count: results.length,
            plan: {
              type: optimized.type,
              estimatedRows: optimized.estimatedRows,
              estimatedCost: optimized.estimatedCost,
            },
          }

          // If any慢查询日志，Trace执行
          const enriched = enrichQueryLinks(data, '/api/query')
          jsonResponse(res, 200, enriched)
        }

        if (config.slowLog) {
          await config.slowLog.track(queryStr || '/api/query', executeQuery, auth?.user)
        } else {
          await executeQuery()
        }
      },
    },

    // GET /api/query/stream?query=... — SSE 流式查询
    {
      method: 'GET',
      path: '/api/query/stream',
      requireAuth: true,
      requiredPermission: 'read',
      handler: async (req, res, parsed, _params, auth) => {
        const queryStr = parsed.searchParams.get('query')
        if (!queryStr) {
          jsonResponse(res, 400, { error: 'query parameter is required' })
          return
        }

        const streamHandler = async () => {
          const spec = parseQueryString(queryStr)
          const plan = buildIRFromSpec(spec)
          const optimized = optimizeIR(plan)
          const results = await executeIR(optimized, shardManager)

          // SSE 响应
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          })

          // 发送结果元数据
          res.write(`event: meta\ndata: ${JSON.stringify({ count: results.length })}\n\n`)

          // 逐个发送结果
          for (let i = 0; i < results.length; i++) {
            res.write(`event: result\ndata: ${JSON.stringify({ index: i, node: results[i] })}\n\n`)
          }

          // 发送完成事件
          res.write(`event: complete\ndata: {}\n\n`)
          res.end()
        }

        if (config.slowLog) {
          await config.slowLog.track(queryStr, streamHandler, auth?.user)
        } else {
          await streamHandler().catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : 'Stream query failed'
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            })
            res.write(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`)
            res.end()
          })
        }
      },
    },

    // ── Metrics ───────────────────────────────

    // GET /metrics
    {
      method: 'GET',
      path: '/metrics',
      requireAuth: false,
      handler: async (_req, res, _parsed, _params, auth) => {
        const metrics = await register.metrics()
        res.writeHead(200, {
          'Content-Type': register.contentType,
          'Content-Length': Buffer.byteLength(metrics),
        })
        res.end(metrics)
      },
    },

    // GET /api/metrics
    {
      method: 'GET',
      path: '/api/metrics',
      requireAuth: true,
      requiredPermission: 'read',
      handler: async (_req, res, _parsed, _params, auth) => {
        const metrics = await register.metrics()
        res.writeHead(200, {
          'Content-Type': register.contentType,
          'Content-Length': Buffer.byteLength(metrics),
        })
        res.end(metrics)
      },
    },

    // ── GNN 推理端点（GAP-51）────────────────

    // GET /api/v1/gnn/status — 模型加载状态
    ...(config.gnnEngine
      ? [{
          method: 'GET' as const,
          path: '/api/v1/gnn/status',
          requireAuth: true as const,
          requiredPermission: 'read' as const,
          handler: async (_req: http.IncomingMessage, res: http.ServerResponse, _parsed: URL, _params: Record<string, string>, _auth: AuthResult) => {
            const engine = config.gnnEngine!
            jsonResponse(res, 200, {
              loaded: engine.isLoaded,
              config: engine.getConfig(),
            })
          },
        }]
      : []),

    // POST /api/v1/gnn/predict-link — 链接预测
    ...(config.gnnEngine
      ? [{
          method: 'POST' as const,
          path: '/api/v1/gnn/predict-link',
          requireAuth: true as const,
          requiredPermission: 'read' as const,
          handler: async (req: http.IncomingMessage, res: http.ServerResponse, _parsed: URL, _params: Record<string, string>, _auth: AuthResult) => {
            const engine = config.gnnEngine!
            const body = await parseBody(req) as Record<string, unknown>
            if (body.source === undefined || body.target === undefined) {
              jsonResponse(res, 400, { error: 'source and target are required' })
              return
            }
            try {
              const result = await engine.predictLink(
                body.source as any,
                body.target as any,
              )
              jsonResponse(res, 200, result)
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : 'Link prediction failed'
              jsonResponse(res, 500, { error: msg })
            }
          },
        }]
      : []),

    // POST /api/v1/gnn/embedding — 计算节点嵌入
    ...(config.gnnEngine
      ? [{
          method: 'POST' as const,
          path: '/api/v1/gnn/embedding',
          requireAuth: true as const,
          requiredPermission: 'read' as const,
          handler: async (req: http.IncomingMessage, res: http.ServerResponse, _parsed: URL, _params: Record<string, string>, _auth: AuthResult) => {
            const engine = config.gnnEngine!
            const body = await parseBody(req) as Record<string, unknown>
            if (body.nodeId === undefined) {
              jsonResponse(res, 400, { error: 'nodeId is required' })
              return
            }
            try {
              const embedding = await engine.computeEmbedding(body.nodeId as any)
              jsonResponse(res, 200, {
                nodeId: body.nodeId,
                embedding: Array.from(embedding),
              })
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : 'Embedding computation failed'
              jsonResponse(res, 500, { error: msg })
            }
          },
        }]
      : []),

    // POST /api/v1/gnn/recommend — Top-K 推荐
    ...(config.gnnEngine
      ? [{
          method: 'POST' as const,
          path: '/api/v1/gnn/recommend',
          requireAuth: true as const,
          requiredPermission: 'read' as const,
          handler: async (req: http.IncomingMessage, res: http.ServerResponse, _parsed: URL, _params: Record<string, string>, _auth: AuthResult) => {
            const engine = config.gnnEngine!
            const body = await parseBody(req) as Record<string, unknown>
            if (body.startNode === undefined || body.candidates === undefined) {
              jsonResponse(res, 400, { error: 'startNode and candidates are required' })
              return
            }
            const candidates = Array.isArray(body.candidates) ? body.candidates as any[] : []
            const topK = body.topK !== undefined ? Number(body.topK) : 10
            try {
              const results = await engine.recommend(body.startNode as any, candidates, topK)
              jsonResponse(res, 200, {
                startNode: body.startNode,
                candidates: candidates.length,
                topK,
                results,
              })
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : 'Recommendation failed'
              jsonResponse(res, 500, { error: msg })
            }
          },
        }]
      : []),

    // POST /api/v1/gnn/predict-links-batch — 批量链接预测
    ...(config.gnnEngine
      ? [{
          method: 'POST' as const,
          path: '/api/v1/gnn/predict-links-batch',
          requireAuth: true as const,
          requiredPermission: 'read' as const,
          handler: async (req: http.IncomingMessage, res: http.ServerResponse, _parsed: URL, _params: Record<string, string>, _auth: AuthResult) => {
            const engine = config.gnnEngine!
            const body = await parseBody(req) as Record<string, unknown>
            const pairs = body.pairs
            if (!Array.isArray(pairs)) {
              jsonResponse(res, 400, { error: 'pairs array is required' })
              return
            }
            if (pairs.length === 0) {
              jsonResponse(res, 200, { results: [] })
              return
            }
            for (let i = 0; i < pairs.length; i++) {
              const p = pairs[i]
              if (p.source === undefined || p.target === undefined) {
                jsonResponse(res, 400, { error: `pairs[${i}] must have source and target` })
                return
              }
            }
            try {
              const pairTuples = pairs.map((p: any) => [p.source, p.target] as [any, any])
              const predictions = await engine.predictLinksBatch(pairTuples)
              const results = pairs.map((p: any, i: number) => ({
                source: p.source,
                target: p.target,
                probability: predictions[i].probability,
              }))
              jsonResponse(res, 200, { results })
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : 'Batch link prediction failed'
              jsonResponse(res, 500, { error: msg })
            }
          },
        }]
      : []),

    // POST /api/v1/gnn/recommend-batch — 批量推荐
    ...(config.gnnEngine
      ? [{
          method: 'POST' as const,
          path: '/api/v1/gnn/recommend-batch',
          requireAuth: true as const,
          requiredPermission: 'read' as const,
          handler: async (req: http.IncomingMessage, res: http.ServerResponse, _parsed: URL, _params: Record<string, string>, _auth: AuthResult) => {
            const engine = config.gnnEngine!
            const body = await parseBody(req) as Record<string, unknown>
            const sources = body.sources
            const candidates = body.candidates
            if (!Array.isArray(sources) || sources.length === 0) {
              jsonResponse(res, 400, { error: 'sources array (non-empty) is required' })
              return
            }
            if (!Array.isArray(candidates) || candidates.length === 0) {
              jsonResponse(res, 400, { error: 'candidates array (non-empty) is required' })
              return
            }
            try {
              const topK = body.topK !== undefined ? Number(body.topK) : 10
              const results: Array<{ source: any; recommendations: Array<{ target: any; score: number }> }> = []
              for (const src of sources) {
                const recs = await engine.recommend(src, candidates as any[], topK)
                results.push({
                  source: src,
                  recommendations: recs.map(r => ({ target: r.nodeId, score: r.score })),
                })
              }
              jsonResponse(res, 200, { results })
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : 'Batch recommendation failed'
              jsonResponse(res, 500, { error: msg })
            }
          },
        }]
      : []),

    // POST /api/v1/gnn/load-model — 热加载/切换模型
    ...(config.gnnEngine
      ? [{
          method: 'POST' as const,
          path: '/api/v1/gnn/load-model',
          requireAuth: true as const,
          requiredPermission: 'admin' as const,
          handler: async (req: http.IncomingMessage, res: http.ServerResponse, _parsed: URL, _params: Record<string, string>, _auth: AuthResult) => {
            const engine = config.gnnEngine!
            const body = await parseBody(req) as Record<string, unknown>
            if (!body.modelPath) {
              jsonResponse(res, 400, { error: 'modelPath is required' })
              return
            }
            try {
              await engine.loadModel(String(body.modelPath))
              jsonResponse(res, 200, { message: 'Model loaded successfully', loaded: true })
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : 'Model load failed'
              jsonResponse(res, 500, { error: msg })
            }
          },
        }]
      : []),

    // POST /api/v1/gnn/node-classify — 节点分类
    ...(config.gnnEngine
      ? [{
          method: 'POST' as const,
          path: '/api/v1/gnn/node-classify',
          requireAuth: true as const,
          requiredPermission: 'read' as const,
          handler: async (req: http.IncomingMessage, res: http.ServerResponse, _parsed: URL, _params: Record<string, string>, _auth: AuthResult) => {
            const engine = config.gnnEngine!
            if (!engine.isLoaded) {
              jsonResponse(res, 400, { error: 'No model loaded. Call POST /api/v1/gnn/load-model first' })
              return
            }
            const body = await parseBody(req) as Record<string, unknown>
            const nodeIds = body.nodeIds as number[] | undefined
            const labels = body.labels as string[] | undefined
            if (!Array.isArray(nodeIds) || !Array.isArray(labels) || labels.length === 0) {
              jsonResponse(res, 400, { error: 'nodeIds (array) and labels (non-empty array) are required' })
              return
            }
            try {
              const results = await engine.classifyNodes(nodeIds, labels)
              jsonResponse(res, 200, { results })
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : 'Node classification failed'
              jsonResponse(res, 500, { error: msg })
            }
          },
        }]
      : []),

    // POST /api/v1/gnn/graph-classify — 图分类
    ...(config.gnnEngine
      ? [{
          method: 'POST' as const,
          path: '/api/v1/gnn/graph-classify',
          requireAuth: true as const,
          requiredPermission: 'read' as const,
          handler: async (req: http.IncomingMessage, res: http.ServerResponse, _parsed: URL, _params: Record<string, string>, _auth: AuthResult) => {
            const engine = config.gnnEngine!
            if (!engine.isLoaded) {
              jsonResponse(res, 400, { error: 'No model loaded. Call POST /api/v1/gnn/load-model first' })
              return
            }
            const body = await parseBody(req) as Record<string, unknown>
            const aggregation = (body.aggregation as string) || 'mean'
            if (!['mean', 'max', 'sum'].includes(aggregation)) {
              jsonResponse(res, 400, { error: 'aggregation must be one of: mean, max, sum' })
              return
            }
            const labels = body.labels as string[] | undefined
            if (!Array.isArray(labels) || labels.length === 0) {
              jsonResponse(res, 400, { error: 'labels (non-empty array) is required' })
              return
            }
            try {
              const result = await engine.classifyGraph(aggregation as 'mean' | 'max' | 'sum', labels)
              jsonResponse(res, 200, result)
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : 'Graph classification failed'
              jsonResponse(res, 500, { error: msg })
            }
          },
        }]
      : []),

    // ── 慢查询日志端点（GAP-53）──────────────

    // GET /api/v1/ops/slow-queries — 获取慢查询列表
    ...(config.slowLog
      ? [{
          method: 'GET' as const,
          path: '/api/v1/ops/slow-queries',
          requireAuth: true as const,
          requiredPermission: 'admin' as const,
          handler: async (_req: http.IncomingMessage, res: http.ServerResponse, _parsed: URL, _params: Record<string, string>, _auth: AuthResult) => {
            const slowLog = config.slowLog!
            const queries = slowLog.getSlowQueries()
            jsonResponse(res, 200, {
              count: queries.length,
              thresholdMs: (slowLog as any).thresholdMs ?? 'unknown',
              queries,
            })
          },
        }]
      : []),

    // PUT /api/v1/ops/slow-queries/threshold — 动态调整阈值
    ...(config.slowLog
      ? [{
          method: 'PUT' as const,
          path: '/api/v1/ops/slow-queries/threshold',
          requireAuth: true as const,
          requiredPermission: 'admin' as const,
          handler: async (req: http.IncomingMessage, res: http.ServerResponse, _parsed: URL, _params: Record<string, string>, _auth: AuthResult) => {
            const slowLog = config.slowLog!
            const body = await parseBody(req) as Record<string, unknown>
            if (body.thresholdMs === undefined || isNaN(Number(body.thresholdMs)) || Number(body.thresholdMs) <= 0) {
              jsonResponse(res, 400, { error: 'thresholdMs must be a positive number' })
              return
            }
            slowLog.setThreshold(Number(body.thresholdMs))
            jsonResponse(res, 200, { message: 'Threshold updated', thresholdMs: Number(body.thresholdMs) })
          },
        }]
      : []),

    // DELETE /api/v1/ops/slow-queries — 清空慢查询日志
    ...(config.slowLog
      ? [{
          method: 'DELETE' as const,
          path: '/api/v1/ops/slow-queries',
          requireAuth: true as const,
          requiredPermission: 'admin' as const,
          handler: async (_req: http.IncomingMessage, res: http.ServerResponse, _parsed: URL, _params: Record<string, string>, _auth: AuthResult) => {
            const slowLog = config.slowLog!
            slowLog.clear()
            jsonResponse(res, 200, { message: 'Slow query log cleared' })
          },
        }]
      : []),

    // ════════════════════════════════════════════════════
    // GAP-54: 租户（子图）管理 CRUD 端点
    // ════════════════════════════════════════════════════
    // 需要 admin 权限才能管理租户
    // 子图端点内置 subgraph 隔离校验

    // GET /api/admin/tenants — 列出所有租户
    {
      method: 'GET',
      path: '/api/admin/tenants',
      requireAuth: true,
      requiredPermission: 'admin',
      handler: async (_req: http.IncomingMessage, res: http.ServerResponse, _parsed: URL, _params: Record<string, string>, _auth: AuthResult) => {
        const mgr = getDefaultTenantManager()
        const tenants = mgr.listTenants()
        jsonResponse(res, 200, {
          tenants,
          count: tenants.length,
        })
      },
    },

    // POST /api/admin/tenants — 创建新租户
    {
      method: 'POST',
      path: '/api/admin/tenants',
      requireAuth: true,
      requiredPermission: 'admin',
      handler: async (req: http.IncomingMessage, res: http.ServerResponse, _parsed: URL, _params: Record<string, string>, _auth: AuthResult) => {
        const mgr = getDefaultTenantManager()
        const body = await parseBody(req) as Record<string, unknown>
        if (!body.name || typeof body.name !== 'string') {
          jsonResponse(res, 400, { error: 'name is required and must be a string' })
          return
        }
        try {
          const tenant = mgr.createTenant({
            name: body.name as string,
            displayName: body.displayName as string | undefined,
            description: body.description as string | undefined,
            metadata: body.metadata as Record<string, string> | undefined,
          })
          jsonResponse(res, 201, tenant)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Create failed'
          const status = msg.includes('already exists') ? 409 : 500
          jsonResponse(res, status, { error: msg })
        }
      },
    },

    // GET /api/admin/tenants/:name — 获取租户详情
    {
      method: 'GET',
      path: '/api/admin/tenants/:name',
      requireAuth: true,
      requiredPermission: 'admin',
      handler: async (_req: http.IncomingMessage, res: http.ServerResponse, _parsed: URL, params: Record<string, string>, _auth: AuthResult) => {
        const mgr = getDefaultTenantManager()
        const tenant = mgr.getTenant(params.name)
        if (!tenant) {
          jsonResponse(res, 404, { error: `Tenant '${params.name}' not found` })
          return
        }
        // Also return ACLs for this tenant
        const acls = mgr.listAccess(params.name)
        jsonResponse(res, 200, { ...tenant, acls })
      },
    },

    // PUT /api/admin/tenants/:name — 更新租户
    {
      method: 'PUT',
      path: '/api/admin/tenants/:name',
      requireAuth: true,
      requiredPermission: 'admin',
      handler: async (req: http.IncomingMessage, res: http.ServerResponse, _parsed: URL, params: Record<string, string>, _auth: AuthResult) => {
        const mgr = getDefaultTenantManager()
        const body = await parseBody(req) as Record<string, unknown>
        try {
          const tenant = mgr.updateTenant(params.name, {
            displayName: body.displayName as string | undefined,
            description: body.description as string | undefined,
            active: body.active as boolean | undefined,
            metadata: body.metadata as Record<string, string> | undefined,
          })
          jsonResponse(res, 200, tenant)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Update failed'
          jsonResponse(res, msg.includes('not found') ? 404 : 500, { error: msg })
        }
      },
    },

    // DELETE /api/admin/tenants/:name — 删除租户
    {
      method: 'DELETE',
      path: '/api/admin/tenants/:name',
      requireAuth: true,
      requiredPermission: 'admin',
      handler: async (_req: http.IncomingMessage, res: http.ServerResponse, _parsed: URL, params: Record<string, string>, _auth: AuthResult) => {
        const mgr = getDefaultTenantManager()
        const deleted = mgr.deleteTenant(params.name)
        if (!deleted) {
          jsonResponse(res, 404, { error: `Tenant '${params.name}' not found` })
          return
        }
        jsonResponse(res, 200, { message: `Tenant '${params.name}' deleted` })
      },
    },

    // POST /api/admin/tenants/:name/grant — 授予角色子图访问权限
    {
      method: 'POST',
      path: '/api/admin/tenants/:name/grant',
      requireAuth: true,
      requiredPermission: 'admin',
      handler: async (req: http.IncomingMessage, res: http.ServerResponse, _parsed: URL, params: Record<string, string>, _auth: AuthResult) => {
        const mgr = getDefaultTenantManager()
        const body = await parseBody(req) as Record<string, unknown>
        if (!body.role || typeof body.role !== 'string' || !body.actions || !Array.isArray(body.actions)) {
          jsonResponse(res, 400, { error: 'role (string) and actions (string[]) are required' })
          return
        }
        try {
          mgr.grantAccess(params.name, body.role as string, body.actions as string[])
          jsonResponse(res, 200, { message: `Access granted to role '${body.role}' on '${params.name}'` })
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Grant failed'
          jsonResponse(res, msg.includes('not found') ? 404 : 500, { error: msg })
        }
      },
    },

    // POST /api/admin/tenants/:name/revoke — 撤销角色子图访问权限
    {
      method: 'POST',
      path: '/api/admin/tenants/:name/revoke',
      requireAuth: true,
      requiredPermission: 'admin',
      handler: async (req: http.IncomingMessage, res: http.ServerResponse, _parsed: URL, params: Record<string, string>, _auth: AuthResult) => {
        const mgr = getDefaultTenantManager()
        const body = await parseBody(req) as Record<string, unknown>
        if (!body.role || typeof body.role !== 'string') {
          jsonResponse(res, 400, { error: 'role (string) is required' })
          return
        }
        const removed = mgr.revokeAccess(params.name, body.role as string)
        if (!removed) {
          jsonResponse(res, 404, { error: `No ACL found for role '${body.role}' on '${params.name}'` })
          return
        }
        jsonResponse(res, 200, { message: `Access revoked for role '${body.role}' on '${params.name}'` })
      },
    },

    // ════════════════════════════════════════════════════
    // GAP-55: JMX / 管理终端端点
    // ════════════════════════════════════════════════════
    // 6 个 admin 端点，复用 mTLS + RBAC（requiredPermission: admin）

    // 1) GET /api/admin/cache — 缓存Info
    {
      method: 'GET',
      path: '/api/admin/cache',
      requireAuth: true,
      requiredPermission: 'admin',
      handler: async (_req: http.IncomingMessage, res: http.ServerResponse, _parsed: URL, _params: Record<string, string>, _auth: AuthResult) => {
        const ranges = shardManager.getAllRanges()
        let totalCachedNodes = 0
        let totalCachedEdges = 0
        let totalCacheHits = 0
        let totalCacheMisses = 0
        for (const [, range] of ranges) {
          const status = range.getStatus()
          totalCachedNodes += status.cache?.nodeCacheSize || 0
          totalCachedEdges += status.cache?.edgeCacheSize || 0
          totalCacheHits += status.cache?.hitCount || 0
          totalCacheMisses += status.cache?.missCount || 0
        }
        jsonResponse(res, 200, {
          cachedNodes: totalCachedNodes,
          cachedEdges: totalCachedEdges,
          hitCount: totalCacheHits,
          missCount: totalCacheMisses,
          hitRate: (totalCacheHits + totalCacheMisses) > 0
            ? (totalCacheHits / (totalCacheHits + totalCacheMisses) * 100).toFixed(2) + '%'
            : 'N/A',
          rangeCount: ranges.size,
        })
      },
    },

    // 2) GET /api/admin/shard — 分片状态
    {
      method: 'GET',
      path: '/api/admin/shard',
      requireAuth: true,
      requiredPermission: 'admin',
      handler: async (_req: http.IncomingMessage, res: http.ServerResponse, _parsed: URL, _params: Record<string, string>, _auth: AuthResult) => {
        const status = shardManager.getShardStatus()
        const ranges = shardManager.getAllRanges()
        const shards: Array<{
          id: string
          nodeCount: number
          edgeCount: number
          isStable: boolean
          sizeBytes: number
        }> = []
        for (const [id, range] of ranges) {
          const s = range.getStatus()
          shards.push({
            id,
            nodeCount: s.storage?.nodeCount || 0,
            edgeCount: s.storage?.edgeCount || 0,
            isStable: s.isStable ?? true,
            sizeBytes: s.storage?.sizeBytes || 0,
          })
        }
        jsonResponse(res, 200, {
          overall: status,
          shards,
          shardCount: shards.length,
          totalNodes: status.reduce((sum: number, s: any) => sum + (s.nodeCount || 0), 0),
        })
      },
    },

    // 3) GET /api/admin/config — 运行时配置
    {
      method: 'GET',
      path: '/api/admin/config',
      requireAuth: true,
      requiredPermission: 'admin',
      handler: async (_req: http.IncomingMessage, res: http.ServerResponse, _parsed: URL, _params: Record<string, string>, _auth: AuthResult) => {
        const publicConfig: Record<string, unknown> = {
          port: config.port,
          host: config.host,
          bodySizeLimit: config.bodySizeLimit,
          enableCors: config.enableCors,
          enableRatelimit: config.enableRatelimit,
          maxRatelimitPerMin: config.maxRatelimitPerMin,
          nodeVersion: process.version,
          platform: process.platform,
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage(),
        }
        if (config.replicationManager) {
          publicConfig.replication = config.replicationManager.getConfig()
        }
        jsonResponse(res, 200, publicConfig)
      },
    },

    // 4) POST /api/admin/compact — 手动触发 compaction
    {
      method: 'POST',
      path: '/api/admin/compact',
      requireAuth: true,
      requiredPermission: 'admin',
      handler: async (_req: http.IncomingMessage, res: http.ServerResponse, _parsed: URL, _params: Record<string, string>, _auth: AuthResult) => {
        const ranges = shardManager.getAllRanges()
        let compacted = 0
        const errors: Array<{ rangeId: string; error: string }> = []
        for (const [id, range] of ranges) {
          try {
            if (typeof (range as any).compact === 'function') {
              await (range as any).compact()
              compacted++
            }
          } catch (err: unknown) {
            errors.push({
              rangeId: id,
              error: err instanceof Error ? err.message : 'Compaction failed',
            })
          }
        }
        jsonResponse(res, 200, {
          message: `Compaction triggered on ${compacted}/${ranges.size} ranges`,
          compacted,
          total: ranges.size,
          errors: errors.length > 0 ? errors : undefined,
        })
      },
    },

    // 5) POST /api/admin/ttl — 设置/触发 TTL 清理
    {
      method: 'POST',
      path: '/api/admin/ttl',
      requireAuth: true,
      requiredPermission: 'admin',
      handler: async (req: http.IncomingMessage, res: http.ServerResponse, _parsed: URL, _params: Record<string, string>, _auth: AuthResult) => {
        const body = await parseBody(req) as Record<string, unknown>
        const ttlHours = body.ttlHours !== undefined ? Number(body.ttlHours) : undefined
        const ranges = shardManager.getAllRanges()
        let cleaned = 0
        const errors: Array<{ rangeId: string; error: string }> = []
        for (const [id, range] of ranges) {
          try {
            if (typeof (range as any).applyTTL === 'function') {
              const result = await (range as any).applyTTL(ttlHours)
              cleaned += result?.removed || 0
            }
          } catch (err: unknown) {
            errors.push({
              rangeId: id,
              error: err instanceof Error ? err.message : 'TTL cleanup failed',
            })
          }
        }
        jsonResponse(res, 200, {
          message: `TTL cleanup completed, removed ${cleaned} items across ${ranges.size} ranges`,
          removed: cleaned,
          ttlHours: ttlHours ?? 'default',
          errors: errors.length > 0 ? errors : undefined,
        })
      },
    },

    // 6) GET /api/admin/status — 全面管理状态聚合
    {
      method: 'GET',
      path: '/api/admin/status',
      requireAuth: true,
      requiredPermission: 'admin',
      handler: async (_req: http.IncomingMessage, res: http.ServerResponse, _parsed: URL, _params: Record<string, string>, _auth: AuthResult) => {
        const gc = await import('os')
        const status = shardManager.getShardStatus()
        const ranges = shardManager.getAllRanges()
        let totalNodes = 0
        let totalEdges = 0
        let totalSizeBytes = 0
        let stableRanges = 0
        for (const [, range] of ranges) {
          const s = range.getStatus()
          totalNodes += s.storage?.nodeCount || 0
          totalEdges += s.storage?.edgeCount || 0
          totalSizeBytes += s.storage?.sizeBytes || 0
          if (s.isStable) stableRanges++
        }
        jsonResponse(res, 200, {
          status: status.every((s: any) => s.healthy !== false) ? 'healthy' : 'degraded',
          uptime: process.uptime(),
          shards: {
            total: ranges.size,
            stable: stableRanges,
            unstable: ranges.size - stableRanges,
          },
          storage: {
            totalNodes,
            totalEdges,
            totalSizeBytes,
            totalSizeFormatted: totalSizeBytes > 1048576
              ? (totalSizeBytes / 1048576).toFixed(2) + ' MB'
              : totalSizeBytes + ' bytes',
          },
          system: {
            memory: process.memoryUsage(),
            cpu: gc.cpus().length,
            loadAvg: gc.loadavg(),
            hostname: gc.hostname(),
          },
          tenants: {
            count: getDefaultTenantManager().count,
          },
          timestamp: Date.now(),
        })
      },
    },
  ]

  // ── 多数据库路由 ────────────────
  // 当 config.databaseManager 存在时，为所有 graph/query 端点生成 /api/v1/:db/... 变体
  if (config.databaseManager) {
    const dbm = config.databaseManager

    // 生成多数据库路由的辅助函数
    const addMultiDbRoute = (
      method: string,
      path: string,
      requireAuth: boolean,
      requiredPermission: string | undefined,
      handler: (sm: ShardManager, req: http.IncomingMessage, res: http.ServerResponse, parsed: URL, params: Record<string, string>, auth: AuthResult) => Promise<void>,
    ): void => {
      routes.push({
        method,
        path,
        requireAuth,
        requiredPermission,
        handler: async (req, res, parsed, params, auth) => {
          const dbName = params.db
          let instance: DatabaseInstance
          try {
            instance = dbm.resolve(dbName)
          } catch {
            jsonResponse(res, 404, { error: `Database '${dbName}' not found` })
            return
          }
          await handler(instance.shardManager, req, res, parsed, params, auth)
        },
      })
    }

    // ── 跨数据库查询（必须在 :db 参数化路由之前注册，避免 _cross-db 被 :db/query 捕获）

    routes.push({
      method: 'POST',
      path: '/api/v1/_cross-db/query',
      requireAuth: true,
      requiredPermission: 'read',
      handler: async (req, res, _parsed, _params, _auth) => {
        const body = await parseBody(req) as Record<string, unknown>

        const queries = body.queries as Array<{ db: string; cypher: string; params?: any }> | undefined
        if (!Array.isArray(queries) || queries.length === 0) {
          jsonResponse(res, 400, { error: 'queries array is required and must be non-empty' })
          return
        }

        const maxQueryTimeMs = body.maxQueryTimeMs !== undefined ? Number(body.maxQueryTimeMs) : 30000

        // 并行执行每个查询，独立Error处理
        const results = await Promise.allSettled(
          queries.map(async (q) => {
            let instance: DatabaseInstance
            try {
              instance = dbm.resolve(q.db)
            } catch {
              return { db: q.db, data: null, error: `Database '${q.db}' not found` }
            }

            const sm = instance.shardManager

            // 构建带超时的查询 Promise
            const queryPromise = (async () => {
              try {
                const spec: QuerySpec = { match: { typeId: undefined } }
                // 使用 cypher 构建查询
                const spec2 = parseQueryString(q.cypher)
                const plan = buildIRFromSpec(spec2)
                const optimized = optimizeIR(plan)
                const data = await executeIR(optimized, sm)
                return { db: q.db, data }
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : 'Query execution failed'
                return { db: q.db, data: null, error: msg }
              }
            })()

            // 超时处理
            const timeoutPromise = new Promise<{ db: string; data: null; error: string }>((resolve) => {
              setTimeout(() => {
                resolve({ db: q.db, data: null, error: `Query timed out after ${maxQueryTimeMs}ms` })
              }, maxQueryTimeMs)
            })

            return Promise.race([queryPromise, timeoutPromise])
          }),
        )

        // Promise.allSettled 对内部捕获的 result 不会产生 rejected promise
        // 但作为兜底，safe 映射
        const mappedResults: Array<{ db: string; data: any; error?: string }> = results.map((r) => {
          if (r.status === 'fulfilled') {
            return r.value
          }
          // Promise.allSettled 不应走到这里（内部已 catch），但保留安全兜底
          return { db: 'unknown', data: null, error: 'Internal cross-db query error' }
        })

        jsonResponse(res, 200, { results: mappedResults })
      },
    })

    // 节点 CRUD
    addMultiDbRoute('POST', '/api/v1/:db/graph/nodes', true, 'write',
      async (sm, req, res) => {
        const body = await parseBody(req) as Record<string, unknown>
        if (!body.typeId || !body.name) {
          jsonResponse(res, 400, { error: 'typeId and name are required' })
          return
        }
        const nodeId = await sm.upsertNode(Number(body.typeId), String(body.name))
        jsonResponse(res, 200, { id: nodeId })
      },
    )

    // 游标分页（P1-A3）
    addMultiDbRoute('GET', '/api/v1/:db/nodes/cursor', true, 'read',
      async (sm, req, res, parsed, params) => {
        const query = parsed.searchParams
        const limit = query.get('limit') ? Math.min(Math.max(Number(query.get('limit')), 1), 1000) : 100
        const cursor = query.get('cursor') || null
        try {
          const result = (sm as any).engine?.scanNodesWithCursor({ limit, cursor })
            ?? (sm as any).scanNodesWithCursor({ limit, cursor })
          if (!result) {
            jsonResponse(res, 500, { error: 'scanNodesWithCursor not available' })
            return
          }
          jsonResponse(res, 200, result)
        } catch (err: unknown) {
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : 'Cursor pagination failed' })
        }
      },
    )

    addMultiDbRoute('GET', '/api/v1/:db/graph/node/:id', true, 'read',
      async (sm, _req, res, _parsed, params) => {
        const id = Number(params.id)
        if (isNaN(id)) { jsonResponse(res, 400, { error: 'Invalid node id' }); return }
        const node = await sm.getNode(id)
        if (!node) { jsonResponse(res, 404, { error: 'not found' }); return }
        jsonResponse(res, 200, node)
      },
    )

    addMultiDbRoute('DELETE', '/api/v1/:db/graph/node/:id', true, 'delete',
      async (sm, _req, res, _parsed, params) => {
        const id = Number(params.id)
        if (isNaN(id)) { jsonResponse(res, 400, { error: 'Invalid node id' }); return }
        await sm.deleteNode(id)
        jsonResponse(res, 200, { message: 'deleted' })
      },
    )

    // 边 CRUD
    addMultiDbRoute('POST', '/api/v1/:db/graph/edges', true, 'write',
      async (sm, req, res) => {
        const body = await parseBody(req) as Record<string, unknown>
        if (body.src === undefined || body.dst === undefined || body.type === undefined) {
          jsonResponse(res, 400, { error: 'src, dst, and type are required' })
          return
        }
        const src = Number(body.src)
        const dst = Number(body.dst)
        const typeId = Number(body.type)
        if (isNaN(src) || isNaN(dst) || isNaN(typeId)) {
          jsonResponse(res, 400, { error: 'src, dst, and type must be numbers' })
          return
        }
        await sm.upsertEdge(src, dst, typeId, {
          props: body.props !== undefined ? (body.props as any) : undefined,
        })
        jsonResponse(res, 200, { message: 'edge created' })
      },
    )

    addMultiDbRoute('GET', '/api/v1/:db/graph/edges/:nodeId', true, 'read',
      async (sm, _req, res, _parsed, params) => {
        const nodeId = Number(params.nodeId)
        if (isNaN(nodeId)) { jsonResponse(res, 400, { error: 'Invalid node id' }); return }
        const result = await sm.neighbors(nodeId)
        jsonResponse(res, 200, {
          nodeId,
          edges: result.edges,
          nodes: result.nodes,
          edgeCount: result.edges.length,
          nodeCount: result.nodes.length,
        })
      },
    )

    addMultiDbRoute('DELETE', '/api/v1/:db/graph/edge', true, 'delete',
      async (sm, req, res) => {
        const body = await parseBody(req) as Record<string, unknown>
        if (body.src === undefined || body.dst === undefined || body.type === undefined) {
          jsonResponse(res, 400, { error: 'src, dst, and type are required' })
          return
        }
        const src = Number(body.src)
        const dst = Number(body.dst)
        const typeId = Number(body.type)
        if (isNaN(src) || isNaN(dst) || isNaN(typeId)) {
          jsonResponse(res, 400, { error: 'src, dst, and type must be numbers' })
          return
        }
        try {
          const rangeId = typeof (sm as any)._getRangeForNodeId === 'function'
            ? (sm as any)._getRangeForNodeId(src)
            : (sm as any).getRouter().getRangeForKey(String(src))
          const range = (sm as any).getRange(rangeId)
          await range.write({ type: 'delete_edge', payload: { src, dst, typeId } })
          jsonResponse(res, 200, { message: 'edge deleted' })
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Failed to delete edge'
          jsonResponse(res, 500, { error: msg })
        }
      },
    )

    // 批量操作
    addMultiDbRoute('POST', '/api/v1/:db/graph/nodes/batch', true, 'write',
      async (sm, req, res) => {
        const body = await parseBody(req) as Record<string, unknown>
        const items = body.items as Array<Record<string, unknown>> | undefined
        if (!Array.isArray(items) || items.length === 0) {
          jsonResponse(res, 400, { error: 'items array is required and must be non-empty' })
          return
        }
        const inputs: Array<{ typeId: number; name: string }> = []
        for (const item of items) {
          if (!item.id || !item.type) {
            jsonResponse(res, 400, { error: 'each item must have id and type' })
            return
          }
          inputs.push({ typeId: Number(item.type), name: String(item.id) })
        }
        const ids = await sm.batchUpsertNodes(inputs)
        jsonResponse(res, 200, { ids, count: ids.length })
      },
    )

    addMultiDbRoute('POST', '/api/v1/:db/graph/edges/batch', true, 'write',
      async (sm, req, res) => {
        const body = await parseBody(req) as Record<string, unknown>
        const items = body.items as Array<Record<string, unknown>> | undefined
        if (!Array.isArray(items) || items.length === 0) {
          jsonResponse(res, 400, { error: 'items array is required and must be non-empty' })
          return
        }
        const validItems: Array<{ src: number; dst: number; typeId: number; props?: Record<string, unknown>; weight?: number }> = []
        const errors: Array<{ index: number; error: string }> = []
        for (let i = 0; i < items.length; i++) {
          const item = items[i]
          if (item.src === undefined || item.dst === undefined || item.type === undefined) {
            errors.push({ index: i, error: 'src, dst, and type are required' })
            continue
          }
          validItems.push({
            src: Number(item.src),
            dst: Number(item.dst),
            typeId: Number(item.type),
            props: item.props as Record<string, unknown> | undefined,
            weight: item.weight !== undefined ? Number(item.weight) : undefined,
          })
        }
        let count = 0
        if (validItems.length > 0) {
          const result = await sm.batchUpsertEdges(validItems)
          count = validItems.length
        }
        jsonResponse(res, 200, {
          count,
          errorCount: errors.length,
          errors: errors.length > 0 ? errors : undefined,
        })
      },
    )

    addMultiDbRoute('POST', '/api/v1/:db/graph/node/batch-neighbors', true, 'read',
      async (sm, req, res) => {
        const body = await parseBody(req) as Record<string, unknown>
        const ids = body.ids as number[] | undefined
        if (!Array.isArray(ids) || ids.length === 0) {
          jsonResponse(res, 400, { error: 'ids array is required and must be non-empty' })
          return
        }
        const depth = body.depth !== undefined ? Number(body.depth) : undefined
        const edgeTypeFilter = body.edgeTypeFilter as number[] | undefined
        const result = await sm.batchNeighbors(ids, { maxDepth: depth, edgeTypeFilter })
        const serialized: Record<string, unknown> = {}
        for (const [nodeId, val] of result) {
          serialized[String(nodeId)] = {
            edges: val.edges,
            nodes: val.nodes,
            edgeCount: val.edges.length,
            nodeCount: val.nodes.length,
          }
        }
        jsonResponse(res, 200, { nodeIds: ids, results: serialized, totalNodeCount: result.size })
      },
    )

    // 查询
    addMultiDbRoute('POST', '/api/v1/:db/query', true, 'read',
      async (sm, req, res) => {
        const body = await parseBody(req) as Record<string, unknown>
        if (!body.query && !body.match) {
          jsonResponse(res, 400, { error: 'query string or match object is required' })
          return
        }
        const queryStr = String(body.query || '')
        const queryFn = async () => {
          const spec: QuerySpec = body.query ? parseQueryString(String(body.query)) : parseMatchBody(body)
          const plan = buildIRFromSpec(spec)
          const optimized = optimizeIR(plan)
          const results = await executeIR(optimized, sm)
          jsonResponse(res, 200, { results, count: results.length, plan: { type: optimized.type, estimatedRows: optimized.estimatedRows, estimatedCost: optimized.estimatedCost } })
        }
        if (config.slowLog) {
          await config.slowLog.track(queryStr, queryFn)
        } else {
          await queryFn().catch((err: unknown) => {
            jsonResponse(res, 500, { error: err instanceof Error ? err.message : 'Query execution failed' })
          })
        }
      },
    )

    addMultiDbRoute('GET', '/api/v1/:db/query/stream', true, 'read',
      async (sm, req, res, parsed) => {
        const queryStr = parsed.searchParams.get('query')
        if (!queryStr) { jsonResponse(res, 400, { error: 'query parameter is required' }); return }
        const streamFn = async () => {
          const spec = parseQueryString(queryStr)
          const plan = buildIRFromSpec(spec)
          const optimized = optimizeIR(plan)
          const results = await executeIR(optimized, sm)
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
          res.write(`event: meta\ndata: ${JSON.stringify({ count: results.length })}\n\n`)
          for (let i = 0; i < results.length; i++) {
            res.write(`event: result\ndata: ${JSON.stringify({ index: i, node: results[i] })}\n\n`)
          }
          res.write(`event: complete\ndata: {}\n\n`)
          res.end()
        }
        if (config.slowLog) {
          await config.slowLog.track(queryStr, streamFn)
        } else {
          await streamFn().catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : 'Stream query failed'
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
            res.write(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`)
            res.end()
          })
        }
      },
    )

    // 节点邻居查询（POST 方式）
    addMultiDbRoute('POST', '/api/v1/:db/graph/node/neighbors', true, 'read',
      async (sm, req, res) => {
        const body = await parseBody(req) as Record<string, unknown>
        const nodeId = Number(body.id)
        const maxDepth = body.maxDepth !== undefined ? Number(body.maxDepth) : 1
        if (isNaN(nodeId)) { jsonResponse(res, 400, { error: 'id is required and must be a number' }); return }
        try {
          const result = await sm.neighbors(nodeId, { maxDepth })
          jsonResponse(res, 200, {
            nodeId,
            edges: result.edges,
            nodes: result.nodes,
            edgeCount: result.edges.length,
            nodeCount: result.nodes.length,
          })
        } catch (err: unknown) {
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : 'Failed to get neighbors' })
        }
      },
    )

    // 批量邻居查询（S01）
    addMultiDbRoute('POST', '/api/v1/:db/graph/batch-neighbors', true, 'read',
      async (sm, req, res) => {
        const body = await parseBody(req) as Record<string, unknown>
        const ids = body.ids as number[] | undefined
        if (!Array.isArray(ids) || ids.length === 0) {
          jsonResponse(res, 400, { error: 'ids array is required and must be non-empty' })
          return
        }
        const maxDepth = body.maxDepth !== undefined ? Number(body.maxDepth) : 1
        try {
          const result = new Map<number, { edges: any[]; nodes: any[] }>()
          for (const id of ids) {
            const nb = await sm.neighbors(id, { maxDepth })
            result.set(id, { edges: nb.edges, nodes: nb.nodes })
          }
          const entries: Array<{ id: number; edges: any[]; nodes: any[] }> = []
          for (const [id, val] of result) {
            entries.push({ id, edges: val.edges, nodes: val.nodes })
          }
          jsonResponse(res, 200, { results: entries, count: entries.length })
        } catch (err: unknown) {
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : 'Failed to get batch neighbors' })
        }
      },
    )

    // 数据库级别健康检查
    addMultiDbRoute('GET', '/api/v1/:db/health', false, undefined,
      async (sm, _req, res, _parsed, _params) => {
        jsonResponse(res, 200, { status: 'ok', database: (_params as any).db })
      },
    )

    // 数据库级别统计Info
    addMultiDbRoute('GET', '/api/v1/:db/stats', true, 'read',
      async (sm, _req, res, _parsed, _params) => {
        try {
          const status = sm.getShardStatus()
          const totalNodes = status.reduce((sum, s) => sum + s.nodeCount, 0)
          jsonResponse(res, 200, {
            database: (_params as any).db,
            status: 'ok',
            shardCount: status.length,
            totalNodes,
          })
        } catch (err: unknown) {
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : 'Failed to get stats' })
        }
      },
    )

    // ── 简单事务（写入缓冲）路由 ──────────────

    // POST /api/v1/:db/tx/begin — 开始事务
    addMultiDbRoute('POST', '/api/v1/:db/tx/begin', true, 'write',
      async (sm, _req, res) => {
        const txnMgr = sm.getSimpleTxnManager()
        if (!txnMgr) {
          jsonResponse(res, 503, { error: 'No engine available for transaction' })
          return
        }
        const txId = txnMgr.begin('rest')
        jsonResponse(res, 200, { txId })
      },
    )

    // POST /api/v1/:db/tx/:txId/commit — 提交事务
    addMultiDbRoute('POST', '/api/v1/:db/tx/:txId/commit', true, 'write',
      async (sm, _req, res, _parsed, params) => {
        const txId = params.txId
        const txnMgr = sm.getSimpleTxnManager()
        if (!txnMgr) {
          jsonResponse(res, 503, { error: 'No engine available for transaction' })
          return
        }
        try {
          const count = await txnMgr.commit(txId, sm)
          jsonResponse(res, 200, { committed: count })
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Commit failed'
          jsonResponse(res, 404, { error: msg })
        }
      },
    )

    // POST /api/v1/:db/tx/:txId/rollback — 回滚事务
    addMultiDbRoute('POST', '/api/v1/:db/tx/:txId/rollback', true, 'write',
      async (sm, _req, res, _parsed, params) => {
        const txId = params.txId
        const txnMgr = sm.getSimpleTxnManager()
        if (!txnMgr) {
          jsonResponse(res, 503, { error: 'No engine available for transaction' })
          return
        }
        try {
          const count = txnMgr.rollback(txId)
          jsonResponse(res, 200, { discarded: count })
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Rollback failed'
          jsonResponse(res, 404, { error: msg })
        }
      },
    )

    // GET /api/v1/:db/tx/:txId — 查询事务状态
    addMultiDbRoute('GET', '/api/v1/:db/tx/:txId', true, 'read',
      async (sm, _req, res, _parsed, params) => {
        const txId = params.txId
        const txnMgr = sm.getSimpleTxnManager()
        if (!txnMgr) {
          jsonResponse(res, 503, { error: 'No engine available for transaction' })
          return
        }
        const txn = txnMgr.getTxn(txId)
        if (!txn) {
          jsonResponse(res, 404, { error: `Transaction '${txId}' not found` })
          return
        }
        jsonResponse(res, 200, txn)
      },
    )

    // POST /api/v1/:db/batch — 通用批量操作端点
    // 在一个请求中执行多个异构操作，支持原子性（全部成功或全部失败）
    addMultiDbRoute('POST', '/api/v1/:db/batch', true, 'write',
      async (sm, req, res) => {
        const body = await parseBody(req) as Record<string, unknown>
        const operations = body.operations as Array<Record<string, unknown>> | undefined
        if (!Array.isArray(operations) || operations.length === 0) {
          jsonResponse(res, 400, { error: 'operations array is required and must be non-empty' })
          return
        }

        const txnMgr = sm.getSimpleTxnManager()
        if (!txnMgr) {
          jsonResponse(res, 503, { error: 'No engine available for batch operations' })
          return
        }

        // Start a transaction for atomicity
        const txId = txnMgr.begin('batch')
        const results: Array<{ index: number; op: string; result?: unknown; error?: string }> = []
        let hasError = false

        // Helper to enqueue a write op to the transaction buffer
        const add = (type: string, args: any[]) => {
          txnMgr.addOp(txId, { type: type as any, args })
        }

        try {
          for (let i = 0; i < operations.length; i++) {
            const op = operations[i]
            const opName = String(op.op ?? 'unknown')
            try {
              switch (opName) {
                case 'upsertNode': {
                  const id = op.id
                  const type = op.type
                  if (id === undefined || type === undefined) {
                    throw new Error('upsertNode requires id and type')
                  }
                  add('upsertNode', [Number(type), String(id), { props: op.props as Record<string, unknown> | undefined }])
                  results.push({ index: i, op: opName, result: { queued: true } })
                  break
                }
                case 'upsertEdge': {
                  const src = op.src
                  const dst = op.dst
                  const type = op.type
                  if (src === undefined || dst === undefined || type === undefined) {
                    throw new Error('upsertEdge requires src, dst, and type')
                  }
                  add('upsertEdge', [Number(src), Number(dst), Number(type), op.props ? { props: op.props as any } : undefined])
                  results.push({ index: i, op: opName, result: { queued: true } })
                  break
                }
                case 'deleteNode': {
                  const id = op.id
                  if (id === undefined) throw new Error('deleteNode requires id')
                  add('deleteNode', [Number(id), false, false])
                  results.push({ index: i, op: opName, result: { queued: true } })
                  break
                }
                case 'deleteEdge': {
                  const src = op.src
                  const dst = op.dst
                  const type = op.type
                  if (src === undefined || dst === undefined || type === undefined) {
                    throw new Error('deleteEdge requires src, dst, and type')
                  }
                  add('deleteEdge', [Number(src), Number(dst), Number(type), false])
                  results.push({ index: i, op: opName, result: { queued: true } })
                  break
                }
                default:
                  results.push({ index: i, op: opName, error: `Unknown operation: ${opName}` })
                  hasError = true
                  continue
              }
            } catch (err: unknown) {
              results.push({ index: i, op: opName, error: err instanceof Error ? err.message : String(err) })
              hasError = true
            }
          }

          if (hasError) {
            // Rollback on any operation failure
            txnMgr.rollback(txId)
            jsonResponse(res, 200, { success: false, results, txId, rolledBack: true })
          } else {
            // Commit all operations
            const committed = await txnMgr.commit(txId, sm)
            jsonResponse(res, 200, { success: true, results, txId, committed })
          }
        } catch (err: unknown) {
          // Unexpected error - attempt rollback
          try { txnMgr.rollback(txId) } catch { /* ignore */ }
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : 'Batch operation failed' })
        }
      },
    )

    // ── Ops 管理路由 ──────────────────────────

    // GET /api/v1/databases — 列出所有数据库
    routes.push({
      method: 'GET',
      path: '/api/v1/databases',
      requireAuth: true,
      requiredPermission: 'admin',
      handler: async (_req, res, _parsed, _params, _auth) => {
        try {
          const names = dbm.listDatabases()
          const dbs = names.map((name) => {
            const instance = dbm.resolve(name)
            const sm = instance.shardManager
            const status = sm.getShardStatus()
            const totalNodes = status.reduce((sum, s) => sum + s.nodeCount, 0)
            // Get edge count from range engine stats
            let totalEdges = 0
            for (const [, range] of sm.getAllRanges()) {
              totalEdges += range.getStatus().storage.edgeCount
            }
            return {
              name,
              status: sm.getAllRanges().size > 0 ? 'active' : 'inactive',
              nodeCount: totalNodes,
              edgeCount: totalEdges,
              createdAt: '',
            }
          })
          jsonResponse(res, 200, { databases: dbs })
        } catch (err: unknown) {
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : 'Failed to list databases' })
        }
      },
    })

    // GET /api/v1/shard/:id/info — 分片详情
    routes.push({
      method: 'GET',
      path: '/api/v1/shard/:id/info',
      requireAuth: true,
      requiredPermission: 'admin',
      handler: async (_req, res, _parsed, params, _auth) => {
        const id = params.id
        // Search across all databases for this shard
        let shardInfo: {
          id: string
          rangeCount: number
          nodeCount: number
          edgeCount: number
          status: string
          leader: string | null
          peers: string[]
        } | null = null
        let foundDb: string | null = null
        for (const name of dbm.listDatabases()) {
          const instance = dbm.resolve(name)
          if (instance.shardManager.getRange(id)) {
            shardInfo = instance.shardManager.getShardInfo(id)
            foundDb = name
            break
          }
        }
        if (!shardInfo) {
          jsonResponse(res, 404, { error: `Shard '${id}' not found` })
          return
        }
        jsonResponse(res, 200, { database: foundDb, ...shardInfo })
      },
    })

    // ── 跨数据库查询 ──────────────────────────

    // POST /api/v1/_cross-db/query — 并行跨库查询
  }

  // 注册 admin 路由（If any replicationManager）
  if (config.replicationManager) {
    const mgr = config.replicationManager

    // GET /api/admin/replication — 复制状态和配置
    routes.push({
      method: 'GET',
      path: '/api/admin/replication',
      requireAuth: true,
      requiredPermission: 'admin',
      handler: async (_req, res, _parsed, _params, _auth) => {
        const config = mgr.getConfig()
        jsonResponse(res, 200, {
          nodeId: config.nodeId,
          peers: config.peers.map(p => p.nodeId),
          tickMs: config.tickMs ?? 500,
          maxBackoffSeconds: config.maxBackoffSeconds ?? 60,
          housekeepingIntervalMs: config.housekeepingIntervalMs ?? 86400000,
          entryTTLDays: config.entryTTLDays ?? 14,
        })
      },
    })

    // PUT /api/admin/replication/config — 热加载更新配置
    routes.push({
      method: 'PUT',
      path: '/api/admin/replication/config',
      requireAuth: true,
      requiredPermission: 'admin',
      handler: async (req, res, _parsed, _params, _auth) => {
        const body = (await parseBody(req)) as Record<string, unknown>
        const partial: Record<string, number> = {}
        const intFields = ['tickMs', 'maxBackoffSeconds', 'housekeepingIntervalMs', 'entryTTLDays'] as const
        for (const field of intFields) {
          const val = body[field]
          if (val !== undefined) {
            const n = Number(val)
            if (isNaN(n) || n <= 0) {
              jsonResponse(res, 400, { error: `${field} must be a positive integer` })
              return
            }
            partial[field] = Math.round(n)
          }
        }
        if (Object.keys(partial).length === 0) {
          jsonResponse(res, 400, { error: 'no valid fields to update' })
          return
        }
        mgr.updateConfig(partial)
        jsonResponse(res, 200, { updated: partial })
      },
    })
  }

  const server = config.tls
    ? https.createServer(buildHttpsOptions(config.tls))
    : https.createServer({
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

      // ── 请求Trace ID ──────────────────────────
      // 从 X-Request-Id header 读取（客户端提供），否则自动生成
      const requestId: string = (typeof req.headers['x-request-id'] === 'string')
        ? req.headers['x-request-id']
        : crypto.randomUUID()
      res.setHeader('X-Request-Id', requestId)

      // Body size limit — 使用 auth.ts 中完整的 bodySizeLimitMiddleware
      if (config.bodySizeLimit !== undefined && config.bodySizeLimit >= 0) {
        // 对于无 Content-Length 的请求，用 wrapBodySizeLimit 包装处理
        if (!req.headers['content-length']) {
          // 使用流式 body size limit 中间件
          const middlewareApplied = await applyBodySizeLimit(req, res, config.bodySizeLimit)
          if (middlewareApplied) return
        } else {
          const contentLength = parseInt(req.headers['content-length'], 10)
          if (!isNaN(contentLength) && contentLength > config.bodySizeLimit) {
            jsonResponse(res, 413, { error: 'Request body too large' })
            return
          }
        }
      }

      // setEncoding on incoming message for consistent Body handling
      req.setEncoding('utf8')

      // Rate limit
      if (config.enableRatelimit) {
        const clientIp = req.socket.remoteAddress ?? 'unknown'
        const result = rateLimiter.check(clientIp)
        if (!result.allowed) {
          const retryAfterSec = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))
          const body = JSON.stringify({
            error: 'Too Many Requests',
            retryAfter: retryAfterSec,
          })
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'Retry-After': String(retryAfterSec),
          })
          res.end(body)
          return
        }
      }

      // 匹配路由（支持路径参数）
      const method = req.method?.toUpperCase() ?? 'GET'
      const path = parsed.pathname

      // GraphQL Subscription via SSE
      if (method === 'GET' && path === '/api/v1/graphql/subscribe') {
        return handleGraphQLSubscription(req, res, config)
      }

      let matched: Route | null = null
      let matchedParams: Record<string, string> = {}
      for (const route of routes) {
        if (route.method !== method) continue
        const params = _matchRoute(route.path, path)
        if (params !== null) {
          matched = route
          matchedParams = params
          break
        }
      }

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

        // RBAC — ACL-aware permission check (falls back to role-based defaults)
        if (matched.requiredPermission) {
          try {
            RBAC.checkAclPermission(auth.role, matched.requiredPermission)
          } catch {
            jsonResponse(res, 403, { error: 'Forbidden: insufficient permissions' })
            return
          }
        }

        // 子图(租户)隔离校验中间件 (GAP-54)
        // 如果路由声明了 subgraph，则在校验完成后检查子图 ACL
        if (matched.subgraph) {
          // 支持路径参数替换：subgraph 字段中的 :param 会被替换为路径参数的实际值
          let subgraphName = matched.subgraph
          for (const [k, v] of Object.entries(matchedParams)) {
            subgraphName = subgraphName.replace(`:${k}`, v)
          }
          try {
            getDefaultTenantManager().checkPermission(auth.role, subgraphName, matched.requiredPermission || 'read')
          } catch {
            jsonResponse(res, 403, { error: `Access denied to subgraph '${subgraphName}'` })
            return
          }
        }
      }

      await matched.handler(req, res, parsed, matchedParams, auth as AuthResult)
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

// ──────────────────────────────────────────
// 查询解析辅助函数
// ──────────────────────────────────────────

/**
 * 从简单的查询字符串解析为 QuerySpec。
 * 支持格式：
 *   "MATCH (n) WHERE n.typeId=1 RETURN n LIMIT 10"
 *   "MATCH (n)-[e]->(m) WHERE n.name='test'"
 *
 * 简化实现：解析 key=value 形式的查询条件。
 */
function parseQueryString(query: string): QuerySpec {
  const spec: QuerySpec = {}

  // 尝试提取 typeId
  const typeMatch = query.match(/typeId\s*[=:]\s*(\d+)/)
  if (typeMatch) {
    spec.match = { typeId: parseInt(typeMatch[1], 10) }
  }

  // 尝试提取 name 过滤
  const nameMatch = query.match(/name\s*[=:]\s*['"]([^'"]+)['"]/)
  if (nameMatch) {
    spec.match = { ...spec.match, name: nameMatch[1] }
  }

  // 尝试提取 WHERE 条件
  const whereMatch = query.match(/WHERE\s+(.+?)(?:\s+RETURN|\s+ORDER|\s+LIMIT|\s*$)/i)
  if (whereMatch) {
    const whereClause = whereMatch[1].trim()
    const conditions = whereClause.split(/\s+AND\s+/i)
    const where: Record<string, any> = {}
    for (const cond of conditions) {
      const eqMatch = cond.match(/(\w+)\s*[=:]\s*(.+)/)
      if (eqMatch) {
        let val: any = eqMatch[2].trim()
        // 去掉引号
        if ((val.startsWith("'") && val.endsWith("'")) ||
            (val.startsWith('"') && val.endsWith('"'))) {
          val = val.slice(1, -1)
        } else if (!isNaN(Number(val))) {
          val = Number(val)
        }
        where[eqMatch[1]] = val
      }
    }
    if (Object.keys(where).length > 0) {
      spec.where = where
    }
  }

  // 尝试提取 LIMIT
  const limitMatch = query.match(/LIMIT\s+(\d+)/i)
  if (limitMatch) {
    spec.limit = parseInt(limitMatch[1], 10)
  }

  // 尝试提取 ORDER BY
  const orderMatch = query.match(/ORDER\s+BY\s+(\w+)\s*(ASC|DESC)?/i)
  if (orderMatch) {
    spec.orderBy = {
      field: orderMatch[1],
      direction: (orderMatch[2]?.toLowerCase() as 'asc' | 'desc') ?? 'asc',
    }
  }

  // 尝试提取 RETURN
  const returnMatch = query.match(/RETURN\s+(.+?)(?:\s+ORDER|\s+LIMIT|\s*$)/i)
  if (returnMatch) {
    const fields = returnMatch[1].split(',').map(f => f.trim()).filter(Boolean)
    if (fields.length > 0 && fields[0] !== '*') {
      spec.return = fields
    }
  }

  // 尝试提取 edges: 如果查询包含 -> 或 ->e->
  if (/->/.test(query)) {
    spec.neighbors = spec.neighbors ?? { id: 0, maxDepth: 1 }
  }

  return spec
}

/**
 * 从 match 对象解析出 QuerySpec。
 * body 格式：
 *   { match: { typeId?: number, name?: string },
 *     where?: Record<string, any>,
 *     return?: string[],
 *     orderBy?: { field: string, direction: 'asc'|'desc' },
 *     limit?: number,
 *     neighbors?: { id: number, maxDepth?: number } }
 */
function parseMatchBody(body: Record<string, unknown>): QuerySpec {
  const spec: QuerySpec = {}

  const match = body.match as Record<string, unknown> | undefined
  if (match) {
    spec.match = {
      typeId: match.typeId !== undefined ? Number(match.typeId) : undefined,
      name: match.name !== undefined ? String(match.name) : undefined,
    }
  }

  if (body.where !== undefined) {
    spec.where = body.where as Record<string, any>
  }

  if (body.return !== undefined) {
    spec.return = body.return as string[]
  }

  if (body.orderBy !== undefined) {
    const ob = body.orderBy as Record<string, any>
    spec.orderBy = {
      field: String(ob.field),
      direction: (String(ob.direction) as 'asc' | 'desc'),
    }
  }

  if (body.limit !== undefined) {
    spec.limit = Number(body.limit)
  }

  if (body.neighbors !== undefined) {
    const n = body.neighbors as Record<string, any>
    spec.neighbors = {
      id: Number(n.id),
      maxDepth: n.maxDepth !== undefined ? Number(n.maxDepth) : 1,
    }
  }

  return spec
}
