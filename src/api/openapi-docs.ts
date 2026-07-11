/**
 * openapi-docs.ts — OpenAPI 3.0 规范文档生成
 *
 * 为 REST API 端点自动生成 OpenAPI 3.0 规范文档。
 * 支持通过 JSON endpoint 获取规范，以及基本的 Swagger UI 支持。
 *
 * Note: 不引入任何新 npm 包，纯手动构建 OpenAPI 规范对象。
 */

// ── 接口定义 ────────────────────────────────────────────

export interface OpenAPIOperation {
  summary?: string
  description?: string
  operationId?: string
  parameters?: OpenAPIParameter[]
  requestBody?: OpenAPIRequestBody
  responses: Record<string, OpenAPIResponse>
}

export interface OpenAPIParameter {
  name: string
  in: 'path' | 'query' | 'header' | 'cookie'
  required?: boolean
  description?: string
  schema: OpenAPISchema
}

export interface OpenAPIRequestBody {
  required?: boolean
  description?: string
  content: Record<string, OpenAPIMediaType>
}

export interface OpenAPIResponse {
  description: string
  content?: Record<string, OpenAPIMediaType>
}

export interface OpenAPIMediaType {
  schema: OpenAPISchema
}

export interface OpenAPISchema {
  type?: string
  properties?: Record<string, OpenAPISchema>
  items?: OpenAPISchema
  required?: string[]
  description?: string
  enum?: string[]
  additionalProperties?: boolean | OpenAPISchema
  oneOf?: OpenAPISchema[]
  allOf?: OpenAPISchema[]
  $ref?: string
  format?: string
}

export interface OpenAPIDocument {
  openapi: string
  info: {
    title: string
    version: string
    description?: string
    contact?: {
      name?: string
      url?: string
      email?: string
    }
  }
  servers?: Array<{
    url: string
    description?: string
  }>
  paths: Record<string, Record<string, OpenAPIOperation>>
  components?: {
    schemas?: Record<string, OpenAPISchema>
    securitySchemes?: Record<string, unknown>
  }
  security?: Array<Record<string, string[]>>
  externalDocs?: {
    description: string
    url: string
  }
}

// ── 共享 Schema 定义 ─────────────────────────────────────

const NodeSchema: OpenAPISchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', description: 'Node ID' },
    type: { type: 'integer', description: '节点类型' },
    name: { type: 'string', description: '节点名称' },
    props: { type: 'object', description: '节点属性（JSON）', additionalProperties: true },
  },
  required: ['id', 'type', 'name'],
}

const EdgeSchema: OpenAPISchema = {
  type: 'object',
  properties: {
    src: { type: 'integer', description: '源Node ID' },
    dst: { type: 'integer', description: '目标Node ID' },
    type: { type: 'integer', description: '边类型' },
    props: { type: 'object', description: '边属性（JSON）', additionalProperties: true },
  },
  required: ['src', 'dst', 'type'],
}

const ErrorSchema: OpenAPISchema = {
  type: 'object',
  properties: {
    error: { type: 'string', description: 'Error描述' },
    code: { type: 'integer', description: 'Error状态码' },
  },
}

const GraphQueryRequestSchema: OpenAPISchema = {
  type: 'object',
  required: ['query'],
  properties: {
    query: { type: 'string', description: '图查询语句（Cypher 语法）' },
    params: {
      type: 'object',
      description: '查询参数',
      additionalProperties: true,
    },
  },
}

// ── 构建 OpenAPI 文档 ──────────────────────────────────

/**
 * 生成 OpenAPI 3.0 规范文档
 *
 * @param options - 配置选项
 * @returns OpenAPI 文档对象
 */
export function generateOpenAPIDocument(options?: {
  title?: string
  version?: string
  serverUrl?: string
  serverDescription?: string
}): OpenAPIDocument {
  const title = options?.title ?? 'AgentiX GraphVec REST API'
  const version = options?.version ?? '1.0.0'
  const serverUrl = options?.serverUrl ?? '/'
  const serverDescription = options?.serverDescription ?? 'Local server'

  const doc: OpenAPIDocument = {
    openapi: '3.0.3',
    info: {
      title,
      version,
      description:
        'AgentiX GraphVec — Globally distributed, multi-active graph database for AI Agent era.\n\n' +
        'This API provides RESTful access to graph database operations including:\n' +
        '- Graph queries using Cypher-like syntax\n' +
        '- Node CRUD operations\n' +
        '- Edge CRUD operations\n' +
        '- Health checks\n\n' +
        'All endpoints support JSON request/response format.',
      contact: {
        name: 'AgentiX Team',
        url: 'https://github.com/agentix/graphvec',
      },
    },
    servers: [
      {
        url: serverUrl,
        description: serverDescription,
      },
    ],
    paths: {
      // ── /api/health ──
      '/api/health': {
        get: {
          summary: '健康检查',
          description: '检查服务是否正常运行',
          operationId: 'healthCheck',
          responses: {
            '200': {
              description: '服务正常',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', enum: ['ok'], description: '服务状态' },
                      uptime: { type: 'number', description: '运行时间（秒）' },
                      version: { type: 'string', description: '服务版本' },
                    },
                  },
                },
              },
            },
          },
        },
      },

      // ── /api/v1/{db}/graph-query ──
      '/api/v1/{db}/graph-query': {
        post: {
          summary: '图查询',
          description: '使用类 Cypher 语法执行图查询',
          operationId: 'graphQuery',
          parameters: [
            {
              name: 'db',
              in: 'path',
              required: true,
              description: '数据库名称',
              schema: { type: 'string' },
            },
            {
              name: 'X-User-ID',
              in: 'header',
              required: false,
              description: '用户 ID（用于 RBAC）',
              schema: { type: 'string' },
            },
          ],
          requestBody: {
            required: true,
            description: '查询请求',
            content: {
              'application/json': {
                schema: GraphQueryRequestSchema,
              },
            },
          },
          responses: {
            '200': {
              description: '查询成功',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      results: {
                        type: 'array',
                        items: { type: 'object' },
                        description: '查询结果数组',
                      },
                      duration: { type: 'number', description: '查询耗时（ms）' },
                    },
                  },
                },
              },
            },
            '400': {
              description: '查询语法Error',
              content: { 'application/json': { schema: ErrorSchema } },
            },
            '401': {
              description: '未授权',
              content: { 'application/json': { schema: ErrorSchema } },
            },
          },
        },
      },

      // ── /api/v1/{db}/node ──
      '/api/v1/{db}/node': {
        get: {
          summary: '获取节点',
          description: '根据 ID 获取节点详情',
          operationId: 'getNode',
          parameters: [
            {
              name: 'db',
              in: 'path',
              required: true,
              description: '数据库名称',
              schema: { type: 'string' },
            },
            {
              name: 'id',
              in: 'query',
              required: true,
              description: 'Node ID',
              schema: { type: 'integer' },
            },
          ],
          responses: {
            '200': {
              description: '获取成功',
              content: { 'application/json': { schema: NodeSchema } },
            },
            '404': {
              description: '节点不存在',
              content: { 'application/json': { schema: ErrorSchema } },
            },
          },
        },
        post: {
          summary: '创建节点',
          description: '创建新节点',
          operationId: 'createNode',
          parameters: [
            {
              name: 'db',
              in: 'path',
              required: true,
              description: '数据库名称',
              schema: { type: 'string' },
            },
          ],
          requestBody: {
            required: true,
            description: '节点数据',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: { type: 'string', description: '节点名称' },
                    type: { type: 'integer', description: '节点类型（默认 0）' },
                    props: {
                      type: 'object',
                      description: '节点属性',
                      additionalProperties: true,
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: '创建成功',
              content: { 'application/json': { schema: NodeSchema } },
            },
            '400': {
              description: '请求参数Error',
              content: { 'application/json': { schema: ErrorSchema } },
            },
          },
        },
        put: {
          summary: '更新节点',
          description: '更新已有节点',
          operationId: 'updateNode',
          parameters: [
            {
              name: 'db',
              in: 'path',
              required: true,
              description: '数据库名称',
              schema: { type: 'string' },
            },
            {
              name: 'id',
              in: 'query',
              required: true,
              description: 'Node ID',
              schema: { type: 'integer' },
            },
          ],
          requestBody: {
            required: true,
            description: '更新的节点数据',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: '节点名称' },
                    props: {
                      type: 'object',
                      description: '节点属性',
                      additionalProperties: true,
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: '更新成功',
              content: { 'application/json': { schema: NodeSchema } },
            },
            '404': {
              description: '节点不存在',
              content: { 'application/json': { schema: ErrorSchema } },
            },
          },
        },
        delete: {
          summary: '删除节点',
          description: '删除指定节点',
          operationId: 'deleteNode',
          parameters: [
            {
              name: 'db',
              in: 'path',
              required: true,
              description: '数据库名称',
              schema: { type: 'string' },
            },
            {
              name: 'id',
              in: 'query',
              required: true,
              description: 'Node ID',
              schema: { type: 'integer' },
            },
          ],
          responses: {
            '200': {
              description: '删除成功',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      deleted: { type: 'boolean' },
                    },
                  },
                },
              },
            },
            '404': {
              description: '节点不存在',
              content: { 'application/json': { schema: ErrorSchema } },
            },
          },
        },
      },

      // ── /api/v1/{db}/edge ──
      '/api/v1/{db}/edge': {
        get: {
          summary: '获取边',
          description: '根据源/目标/类型获取边',
          operationId: 'getEdge',
          parameters: [
            {
              name: 'db',
              in: 'path',
              required: true,
              description: '数据库名称',
              schema: { type: 'string' },
            },
            {
              name: 'src',
              in: 'query',
              required: true,
              description: '源Node ID',
              schema: { type: 'integer' },
            },
            {
              name: 'dst',
              in: 'query',
              required: true,
              description: '目标Node ID',
              schema: { type: 'integer' },
            },
            {
              name: 'type',
              in: 'query',
              required: true,
              description: '边类型',
              schema: { type: 'integer' },
            },
          ],
          responses: {
            '200': {
              description: '获取成功',
              content: { 'application/json': { schema: EdgeSchema } },
            },
            '404': {
              description: '边不存在',
              content: { 'application/json': { schema: ErrorSchema } },
            },
          },
        },
        post: {
          summary: '创建边',
          description: '创建新边',
          operationId: 'createEdge',
          parameters: [
            {
              name: 'db',
              in: 'path',
              required: true,
              description: '数据库名称',
              schema: { type: 'string' },
            },
          ],
          requestBody: {
            required: true,
            description: '边数据',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['src', 'dst', 'type'],
                  properties: {
                    src: { type: 'integer', description: '源Node ID' },
                    dst: { type: 'integer', description: '目标Node ID' },
                    type: { type: 'integer', description: '边类型' },
                    props: {
                      type: 'object',
                      description: '边属性',
                      additionalProperties: true,
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: '创建成功',
              content: { 'application/json': { schema: EdgeSchema } },
            },
            '400': {
              description: '请求参数Error',
              content: { 'application/json': { schema: ErrorSchema } },
            },
          },
        },
        delete: {
          summary: '删除边',
          description: '删除指定边',
          operationId: 'deleteEdge',
          parameters: [
            {
              name: 'db',
              in: 'path',
              required: true,
              description: '数据库名称',
              schema: { type: 'string' },
            },
            {
              name: 'src',
              in: 'query',
              required: true,
              description: '源Node ID',
              schema: { type: 'integer' },
            },
            {
              name: 'dst',
              in: 'query',
              required: true,
              description: '目标Node ID',
              schema: { type: 'integer' },
            },
            {
              name: 'type',
              in: 'query',
              required: true,
              description: '边类型',
              schema: { type: 'integer' },
            },
          ],
          responses: {
            '200': {
              description: '删除成功',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      deleted: { type: 'boolean' },
                    },
                  },
                },
              },
            },
            '404': {
              description: '边不存在',
              content: { 'application/json': { schema: ErrorSchema } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Node: NodeSchema,
        Edge: EdgeSchema,
        Error: ErrorSchema,
        GraphQueryRequest: GraphQueryRequestSchema,
      },
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'JWT Bearer token authentication',
        },
        xUserId: {
          type: 'apiKey',
          in: 'header',
          name: 'X-User-ID',
          description: 'Optional user ID header for RBAC',
        },
      },
    },
    security: [
      { bearerAuth: [] },
    ],
  }

  return doc
}

/**
 * 生成 Swagger UI HTML 页面（使用 CDN）
 *
 * @param specUrl - OpenAPI 规范文档 URL
 * @returns HTML 字符串
 */
export function generateSwaggerUIHTML(specUrl: string = '/api/openapi.json'): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AgentiX GraphVec API Documentation</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
  <style>
    body { margin: 0; background: #fafafa; }
    .swagger-ui .topbar { display: none; }
    .swagger-ui .info .title { font-size: 28px; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: ${JSON.stringify(specUrl)},
      dom_id: '#swagger-ui',
      presets: [
        SwaggerUIBundle.presets.apis,
        SwaggerUIBundle.SwaggerUIStandalonePreset
      ],
      layout: "BaseLayout",
      deepLinking: true,
      showExtensions: true,
      showCommonExtensions: true
    });
  </script>
</body>
</html>`
}

/**
 * 获取 OpenAPI 文档的 JSON 表示
 */
export function getOpenAPIJSON(options?: {
  title?: string
  version?: string
  serverUrl?: string
  serverDescription?: string
}): string {
  return JSON.stringify(generateOpenAPIDocument(options), null, 2)
}
