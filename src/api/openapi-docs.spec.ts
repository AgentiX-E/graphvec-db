/**
 * openapi-docs.spec.ts — OpenAPI 文档生成测试
 */
import {
  generateOpenAPIDocument,
  getOpenAPIJSON,
  generateSwaggerUIHTML,
  OpenAPIDocument,
} from './openapi-docs'

describe('generateOpenAPIDocument', () => {
  test('should produce valid OpenAPI 3.0.3 document', () => {
    const doc = generateOpenAPIDocument()
    expect(doc.openapi).toBe('3.0.3')
    expect(doc.info).toBeDefined()
    expect(doc.info.title).toContain('GraphVec')
    expect(doc.info.version).toBe('1.0.0')
  })

  test('should include all expected API paths', () => {
    const doc = generateOpenAPIDocument()
    const paths = Object.keys(doc.paths)

    expect(paths).toContain('/api/health')
    expect(paths).toContain('/api/v1/{db}/graph-query')
    expect(paths).toContain('/api/v1/{db}/node')
    expect(paths).toContain('/api/v1/{db}/edge')
  })

  test('should define proper HTTP methods for /api/v1/{db}/node', () => {
    const doc = generateOpenAPIDocument()
    const nodePath = doc.paths['/api/v1/{db}/node']

    expect(nodePath).toHaveProperty('get')
    expect(nodePath).toHaveProperty('post')
    expect(nodePath).toHaveProperty('put')
    expect(nodePath).toHaveProperty('delete')
  })

  test('should define proper HTTP methods for /api/v1/{db}/edge', () => {
    const doc = generateOpenAPIDocument()
    const edgePath = doc.paths['/api/v1/{db}/edge']

    expect(edgePath).toHaveProperty('get')
    expect(edgePath).toHaveProperty('post')
    expect(edgePath).toHaveProperty('delete')
  })

  test('should include path parameters', () => {
    const doc = generateOpenAPIDocument()
    const queryPath = doc.paths['/api/v1/{db}/graph-query']
    const postOp = queryPath.post

    expect(postOp.parameters).toBeDefined()
    expect(postOp.parameters!.some(p => p.name === 'db')).toBe(true)
    expect(postOp.parameters!.some(p => p.name === 'X-User-ID')).toBe(true)
  })

  test('should include request bodies for POST endpoints', () => {
    const doc = generateOpenAPIDocument()
    const queryPath = doc.paths['/api/v1/{db}/graph-query']

    expect(queryPath.post.requestBody).toBeDefined()
    expect(queryPath.post.requestBody!.required).toBe(true)
    expect(queryPath.post.requestBody!.content['application/json']).toBeDefined()
  })

  test('should include component schemas', () => {
    const doc = generateOpenAPIDocument()
    const schemas = doc.components?.schemas

    expect(schemas).toHaveProperty('Node')
    expect(schemas).toHaveProperty('Edge')
    expect(schemas).toHaveProperty('Error')
    expect(schemas).toHaveProperty('GraphQueryRequest')
  })

  test('should have security schemes defined', () => {
    const doc = generateOpenAPIDocument()

    expect(doc.components?.securitySchemes).toHaveProperty('bearerAuth')
    expect(doc.components?.securitySchemes).toHaveProperty('xUserId')
    expect(doc.security).toBeDefined()
  })

  test('should accept custom options', () => {
    const doc = generateOpenAPIDocument({
      title: 'Custom API',
      version: '2.0.0',
      serverUrl: 'http://localhost:8080',
      serverDescription: 'Custom server',
    })

    expect(doc.info.title).toBe('Custom API')
    expect(doc.info.version).toBe('2.0.0')
    expect(doc.servers![0].url).toBe('http://localhost:8080')
    expect(doc.servers![0].description).toBe('Custom server')
  })
})

describe('getOpenAPIJSON', () => {
  test('should return valid JSON string', () => {
    const json = getOpenAPIJSON()
    const parsed = JSON.parse(json)

    expect(parsed.openapi).toBe('3.0.3')
    expect(parsed.paths).toBeDefined()
    expect(typeof json).toBe('string')
  })
})

describe('generateSwaggerUIHTML', () => {
  test('should generate HTML with Swagger UI CDN reference', () => {
    const html = generateSwaggerUIHTML()

    expect(html).toContain('swagger-ui-dist')
    expect(html).toContain('SwaggerUIBundle')
    expect(html).toContain('swagger-ui.css')
  })

  test('should include the spec URL in the HTML', () => {
    const specUrl = '/api/v2/openapi.json'
    const html = generateSwaggerUIHTML(specUrl)

    expect(html).toContain(specUrl)
  })

  test('should include title', () => {
    const html = generateSwaggerUIHTML()

    expect(html).toContain('GraphVec')
    expect(html).toContain('API Documentation')
  })
})
