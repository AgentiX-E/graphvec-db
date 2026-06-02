/**
 * openapi-bridge.ts — OpenAPI 装饰器桥接层
 *
 * 在已有 openapi-docs.ts 基础上提供增量改进：
 * 1. OpenAPIRegistry：运行时注册路由的 OpenAPI 元数据
 * 2. 从 Route[] 自动聚合 OpenAPI 路径
 * 3. 提供 registerRoute() / registerRoutes() 便捷方法
 * 4. 生成合并后的 OpenAPI 文档
 *
 * 使用方式：
 * ```ts
 * const registry = new OpenAPIRegistry()
 * registry.registerRoute('GET', '/api/health', {
 *   summary: '健康检查',
 *   tags: ['系统'],
 *   responses: { '200': { description: 'OK' } },
 * })
 * const doc = registry.buildDocument()
 * ```
 */

import { generateOpenAPIDocument, generateSwaggerUIHTML, getOpenAPIJSON } from './openapi-docs'
import type {
  OpenAPIDocument,
  OpenAPIOperation,
  OpenAPISchema,
} from './openapi-docs'

// ── 类型定义 ────────────────────────────────────────────

export interface RouteInfo {
  method: string
  path: string
  summary?: string
  description?: string
  tags?: string[]
  parameters?: Array<{
    name: string
    in: 'path' | 'query' | 'header' | 'cookie'
    required?: boolean
    description?: string
    schema?: OpenAPISchema
  }>
  requestBody?: OpenAPIOperation['requestBody']
  responses?: Record<string, {
    description: string
    schema?: OpenAPISchema
  }>
  security?: Array<Record<string, string[]>>
}

// ── OpenAPIRegistry ─────────────────────────────────

/**
 * OpenAPIRegistry — 运行时 OpenAPI 注册表
 *
 * 允许在路由定义时通过声明式 API 注册 OpenAPI 元数据。
 * 最终调用 buildDocument() 生成包含所有注册路由的完整规范。
 */
export class OpenAPIRegistry {
  private operations = new Map<string, OpenAPIOperation>()
  private serverUrl: string
  private serverDescription: string

  /**
   * @param serverUrl - OpenAPI server URL
   * @param serverDescription - Server description
   */
  constructor(serverUrl: string = '/', serverDescription: string = 'Local server') {
    this.serverUrl = serverUrl
    this.serverDescription = serverDescription
  }

  /**
   * 注册单个路由的 OpenAPI 元数据
   *
   * @param method - HTTP 方法 (GET, POST, PUT, DELETE, PATCH)
   * @param path - 路径模板（如 /api/v1/{db}/node）
   * @param info - 路由信息
   */
  registerRoute(method: string, path: string, info: RouteInfo): this {
    const key = `${method.toUpperCase()}:${path}`

    const operation: OpenAPIOperation = {
      summary: info.summary,
      description: info.description,
      operationId: info.summary
        ? info.summary.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
        : undefined,
      parameters: info.parameters?.map(p => ({
        name: p.name,
        in: p.in,
        required: p.required ?? (p.in === 'path'),
        description: p.description,
        schema: p.schema ?? { type: 'string' },
      })),
      requestBody: info.requestBody,
      responses: {},
    }

    // 构建 responses
    if (info.responses) {
      for (const [status, resp] of Object.entries(info.responses)) {
        operation.responses[status] = {
          description: resp.description,
          content: resp.schema
            ? { 'application/json': { schema: resp.schema } }
            : undefined,
        }
      }
    }

    // 空的 200 默认响应
    if (Object.keys(operation.responses).length === 0) {
      operation.responses['200'] = { description: 'Success' }
    }

    this.operations.set(key, operation)
    return this
  }

  /**
   * 批量注册路由
   *
   * @param routes - 路由信息数组
   */
  registerRoutes(routes: RouteInfo[]): this {
    for (const route of routes) {
      this.registerRoute(route.method, route.path, route)
    }
    return this
  }

  /**
   * 从 RouteInfo 数组构建完整 OpenAPI 文档
   *
   * @param options - 可选覆盖文档元信息
   */
  buildDocument(options?: {
    title?: string
    version?: string
  }): OpenAPIDocument {
    const base = generateOpenAPIDocument({
      title: options?.title,
      version: options?.version,
      serverUrl: this.serverUrl,
      serverDescription: this.serverDescription,
    })

    // 合并注册的自定义路径
    for (const [key, operation] of this.operations) {
      const colonIdx = key.indexOf(':')
      const method = key.substring(0, colonIdx).toLowerCase()
      let path = key.substring(colonIdx + 1)

      if (path.endsWith('/')) {
        path = path.slice(0, -1)
      }

      if (!base.paths[path]) {
        base.paths[path] = {}
      }

      base.paths[path][method] = operation
    }

    return base
  }

  /**
   * 获取 OpenAPI JSON 字符串
   */
  getJSON(options?: { title?: string; version?: string }): string {
    return JSON.stringify(this.buildDocument(options), null, 2)
  }

  /**
   * 获取 Swagger UI HTML 页面
   *
   * @param specUrl - OpenAPI spec 端点 URL
   */
  getSwaggerUIHTML(specUrl: string = '/api/openapi.json'): string {
    return generateSwaggerUIHTML(specUrl)
  }

  /**
   * 创建一个 HTTP handler，用于 /api/openapi.json 端点
   */
  createJSONHandler(options?: { title?: string; version?: string }): (
    _req: import('http').IncomingMessage,
    res: import('http').ServerResponse,
  ) => void {
    return (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(this.getJSON(options))
    }
  }

  /**
   * 创建一个 HTTP handler，用于 /api/docs 端点（Swagger UI）
   */
  createSwaggerUIHandler(specUrl?: string): (
    _req: import('http').IncomingMessage,
    res: import('http').ServerResponse,
  ) => void {
    const url = specUrl ?? '/api/openapi.json'
    return (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(this.getSwaggerUIHTML(url))
    }
  }

  /**
   * 重置注册表
   */
  clear(): void {
    this.operations.clear()
  }

  /**
   * 获取已注册的路由数量
   */
  get size(): number {
    return this.operations.size
  }
}
