/**
 * openapi-bridge.spec.ts — OpenAPIRegistry 测试
 */
import { describe, it, expect, vi } from 'vitest'
import { OpenAPIRegistry } from './openapi-bridge'

describe('OpenAPIRegistry', () => {
  describe('registerRoute', () => {
    it('should register a single route', () => {
      const registry = new OpenAPIRegistry()
      registry.registerRoute('GET', '/api/health', {
        summary: 'Health Check',
        responses: { '200': { description: 'OK' } },
      })
      expect(registry.size).toBe(1)
    })

    it('should normalize method to uppercase', () => {
      const registry = new OpenAPIRegistry()
      registry.registerRoute('get', '/api/foo', {
        responses: { '200': { description: 'OK' } },
      })
      const doc = registry.buildDocument()
      expect(doc.paths['/api/foo'].get).toBeDefined()
      expect(doc.paths['/api/foo'].GET).toBeUndefined()
    })

    it('should create default operationId from summary', () => {
      const registry = new OpenAPIRegistry()
      registry.registerRoute('POST', '/api/v1/{db}/query', {
        summary: 'Graph Query',
        responses: { '200': { description: 'OK' } },
      })
      const doc = registry.buildDocument()
      const op = doc.paths['/api/v1/{db}/query'].post
      expect(op.operationId).toBe('graph_query')
    })

    it('should add default 200 response if none provided', () => {
      const registry = new OpenAPIRegistry()
      registry.registerRoute('DELETE', '/api/item', {})
      const doc = registry.buildDocument()
      const op = doc.paths['/api/item'].delete
      expect(op.responses['200']).toBeDefined()
      expect(op.responses['200'].description).toBe('Success')
    })

    it('should register parameters', () => {
      const registry = new OpenAPIRegistry()
      registry.registerRoute('GET', '/api/v1/{db}/node', {
        summary: 'Get Node',
        parameters: [
          { name: 'db', in: 'path', required: true, description: 'Database name' },
          { name: 'id', in: 'query', required: true, description: 'Node ID' },
        ],
        responses: { '200': { description: 'OK' } },
      })
      const doc = registry.buildDocument()
      const params = doc.paths['/api/v1/{db}/node'].get.parameters!
      expect(params).toHaveLength(2)
      expect(params[0].name).toBe('db')
      expect(params[0].in).toBe('path')
      expect(params[1].name).toBe('id')
      expect(params[1].in).toBe('query')
    })
  })

  describe('registerRoutes (batch)', () => {
    it('should register multiple routes at once', () => {
      const registry = new OpenAPIRegistry()
      registry.registerRoutes([
        { method: 'GET', path: '/api/health', responses: { '200': { description: 'OK' } } },
        { method: 'POST', path: '/api/v1/{db}/query', responses: { '200': { description: 'OK' } } },
      ])
      expect(registry.size).toBe(2)
    })
  })

  describe('buildDocument', () => {
    it('should include base paths from generateOpenAPIDocument', () => {
      const registry = new OpenAPIRegistry()
      const doc = registry.buildDocument()
      // Base paths should be present
      expect(doc.paths['/api/health']).toBeDefined()
      expect(doc.info.title).toBe('AgentiX GraphVec REST API')
    })

    it('should merge registered paths with base paths', () => {
      const registry = new OpenAPIRegistry()
      registry.registerRoute('GET', '/api/custom', {
        summary: 'Custom Endpoint',
        responses: { '200': { description: 'Custom OK' } },
      })
      const doc = registry.buildDocument()
      // Base path still exists
      expect(doc.paths['/api/health']).toBeDefined()
      // Custom path added
      expect(doc.paths['/api/custom']).toBeDefined()
      expect(doc.paths['/api/custom'].get).toBeDefined()
    })

    it('should accept custom title and version', () => {
      const registry = new OpenAPIRegistry()
      const doc = registry.buildDocument({ title: 'Custom API', version: '2.0.0' })
      expect(doc.info.title).toBe('Custom API')
      expect(doc.info.version).toBe('2.0.0')
    })

    it('should set server url from constructor', () => {
      const registry = new OpenAPIRegistry('http://localhost:8080', 'Dev')
      const doc = registry.buildDocument()
      expect(doc.servers![0].url).toBe('http://localhost:8080')
      expect(doc.servers![0].description).toBe('Dev')
    })
  })

  describe('getJSON', () => {
    it('should return valid JSON string', () => {
      const registry = new OpenAPIRegistry()
      const json = registry.getJSON()
      expect(() => JSON.parse(json)).not.toThrow()
      const parsed = JSON.parse(json)
      expect(parsed.openapi).toBe('3.0.3')
    })
  })

  describe('getSwaggerUIHTML', () => {
    it('should return HTML string', () => {
      const registry = new OpenAPIRegistry()
      const html = registry.getSwaggerUIHTML()
      expect(html).toContain('swagger-ui')
      expect(html).toContain('SwaggerUIBundle')
    })

    it('should include custom spec URL', () => {
      const registry = new OpenAPIRegistry()
      const html = registry.getSwaggerUIHTML('/custom/spec.json')
      expect(html).toContain('/custom/spec.json')
    })
  })

  describe('clear', () => {
    it('should reset all registered routes', () => {
      const registry = new OpenAPIRegistry()
      registry.registerRoute('GET', '/api/test', { responses: { '200': { description: 'OK' } } })
      expect(registry.size).toBe(1)
      registry.clear()
      expect(registry.size).toBe(0)
    })
  })

  describe('createJSONHandler', () => {
    it('should return a function that writes JSON response', () => {
      const registry = new OpenAPIRegistry()
      const handler = registry.createJSONHandler()
      expect(typeof handler).toBe('function')

      const res = {
        writeHead: vi.fn(),
        end: vi.fn(),
      } as any
      const req = {} as any

      handler(req, res)
      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' })
      expect(res.end).toHaveBeenCalledOnce()
      const sent = res.end.mock.calls[0][0] as string
      expect(() => JSON.parse(sent)).not.toThrow()
    })
  })

  describe('createSwaggerUIHandler', () => {
    it('should return a function that writes HTML response', () => {
      const registry = new OpenAPIRegistry()
      const handler = registry.createSwaggerUIHandler()
      expect(typeof handler).toBe('function')

      const res = {
        writeHead: vi.fn(),
        end: vi.fn(),
      } as any
      const req = {} as any

      handler(req, res)
      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/html; charset=utf-8' })
      expect(res.end).toHaveBeenCalledOnce()
      const sent = res.end.mock.calls[0][0] as string
      expect(sent).toContain('swagger-ui')
    })
  })

  describe('edge cases', () => {
    it('should handle duplicate route registrations (last wins)', () => {
      const registry = new OpenAPIRegistry()
      registry.registerRoute('GET', '/api/foo', { summary: 'First' })
      registry.registerRoute('GET', '/api/foo', { summary: 'Second' })
      expect(registry.size).toBe(1)
      const doc = registry.buildDocument()
      expect(doc.paths['/api/foo'].get.summary).toBe('Second')
    })

    it('should handle trailing slash in path', () => {
      const registry = new OpenAPIRegistry()
      registry.registerRoute('GET', '/api/bar/', { responses: { '200': { description: 'OK' } } })
      const doc = registry.buildDocument()
      expect(doc.paths['/api/bar']).toBeDefined()
    })

    it('should chaining API', () => {
      const registry = new OpenAPIRegistry()
      registry
        .registerRoute('GET', '/a', { responses: { '200': { description: 'A' } } })
        .registerRoute('POST', '/b', { responses: { '200': { description: 'B' } } })
      expect(registry.size).toBe(2)
    })
  })
})
