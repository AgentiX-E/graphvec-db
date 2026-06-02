/**
 * hypermedia.spec.ts — HATEOAS 超媒体链接单元测试
 */

import { describe, test, expect } from 'vitest'
import {
  enrichNodeLinks,
  enrichEdgeLinks,
  enrichListLinks,
  enrichQueryLinks,
  enrichResponse,
  type HypermediaLink,
} from './hypermedia'

describe('hypermedia (GAP-56)', () => {
  describe('enrichNodeLinks', () => {
    test('should inject self link for a node', () => {
      const node = { id: 42, name: 'Alice', type: 1 }
      const result = enrichNodeLinks(node, '/api/graph/node/42')

      expect(result).toBeDefined()
      expect((result as any)._links.self.href).toBe('/api/graph/node/42')
      expect((result as any)._links.self.method).toBe('GET')
    })

    test('should add related edge and neighbor links', () => {
      const node = { id: 7, name: 'Bob', type: 2 }
      const result = enrichNodeLinks(node, '/api/graph/node/7') as any

      expect(result._links.related).toBeInstanceOf(Array)
      expect(result._links.related).toHaveLength(2)
      expect(result._links.related[0].href).toBe('/api/v1/graph/edges/7')
      expect(result._links.related[1].href).toBe('/api/v1/graph/node/neighbors')
    })

    test('should return null for null input', () => {
      expect(enrichNodeLinks(null, '/api/graph/node/0')).toBeNull()
    })

    test('should wrap data in data field', () => {
      const node = { id: 1, name: 'Test', type: 3 }
      const result = enrichNodeLinks(node, '/api/graph/node/1') as any

      expect(result.data).toEqual(node)
      expect(result.data.name).toBe('Test')
    })
  })

  describe('enrichEdgeLinks', () => {
    test('should inject self and optional node link', () => {
      const edgeResult = { edges: [{ src: 1, dst: 2, type: 1 }], edgeCount: 1 }
      const result = enrichEdgeLinks(edgeResult, '/api/graph/edges/1', 1)

      expect(result._links.self.href).toBe('/api/graph/edges/1')
      expect(result._links.related).toBeInstanceOf(Array)
      expect(result._links.related![0].href).toBe('/api/v1/graph/node/1')
    })

    test('should work without nodeId', () => {
      const edgeResult = { edges: [], edgeCount: 0 }
      const result = enrichEdgeLinks(edgeResult, '/api/edges')

      expect(result._links.self.href).toBe('/api/edges')
      expect(result._links.related).toBeUndefined()
    })

    test('should wrap data', () => {
      const edgeResult = { edges: [{ src: 1, dst: 2, type: 1 }], edgeCount: 1 }
      const result = enrichEdgeLinks(edgeResult, '/api/graph/edges/1')

      expect(result.data).toEqual(edgeResult)
    })
  })

  describe('enrichListLinks', () => {
    test('should wrap items in data field with count', () => {
      const items = [{ id: 1 }, { id: 2 }]
      const result = enrichListLinks(items, '/api/nodes', items.length)

      expect(result.data.items).toEqual(items)
      expect(result.data.count).toBe(2)
      expect(result._links.self.href).toBe('/api/nodes')
    })

    test('should include extra metadata', () => {
      const items = [{ id: 1 }]
      const result = enrichListLinks(items, '/api/nodes', 1, { totalPages: 5 })

      expect(result.data.totalPages).toBe(5)
    })
  })

  describe('enrichQueryLinks', () => {
    test('should inject standard query links', () => {
      const data = { results: [{ id: 1 }], count: 1 }
      const result = enrichQueryLinks(data, '/api/query')

      expect(result._links.self.href).toBe('/api/query')
      expect(result._links.related).toBeInstanceOf(Array)
      expect(result._links.related).toHaveLength(2)

      // 验证慢查询链接
      const slowQueryLink = result._links.related.find(
        (l: any) => l.href === '/api/v1/ops/slow-queries',
      )
      expect(slowQueryLink).toBeDefined()
      expect((slowQueryLink as any).title).toBe('查看慢查询')

      // 验证状态链接
      const statusLink = result._links.related.find(
        (l: any) => l.href === '/api/status',
      )
      expect(statusLink).toBeDefined()
    })

    test('should preserve original data in data field', () => {
      const data = { results: [{ id: 1, name: 'Alice' }], count: 1, plan: { type: 'scan' } }
      const result = enrichQueryLinks(data, '/api/query')

      expect(result.data).toEqual(data)
      expect((result.data as any).results[0].name).toBe('Alice')
    })
  })

  describe('enrichResponse', () => {
    test('should create generic enriched response', () => {
      const data = { message: 'ok', id: 1 }
      const result = enrichResponse(data, '/api/v1/status', 'GET', '系统状态')

      expect(result.data).toEqual(data)
      expect(result._links.self.method).toBe('GET')
      expect(result._links.self.title).toBe('系统状态')
    })

    test('should include related links when provided', () => {
      const data = { message: 'created' }
      const related: HypermediaLink[] = [
        { href: '/api/v1/graph/node/1', method: 'GET', title: '查看节点' },
      ]

      const result = enrichResponse(data, '/api/v1/graph/nodes', 'POST', '创建节点', related)

      expect(result._links.related).toBeInstanceOf(Array)
      expect(result._links.related).toHaveLength(1)
      expect(result._links.related![0].href).toBe('/api/v1/graph/node/1')
    })

    test('should default to GET when method is not provided', () => {
      const result = enrichResponse({ ok: true }, '/api/health')

      expect(result._links.self.method).toBe('GET')
    })
  })

  describe('link format validation', () => {
    test('every link should have required href', () => {
      const node = { id: 1, name: 'A', type: 1 }
      const result = enrichNodeLinks(node, '/api/graph/node/1') as any

      expect(result._links.self.href).toBeTruthy()
      for (const link of result._links.related) {
        expect(link.href).toBeTruthy()
        expect(link.method).toBeTruthy()
      }
    })

    test('links should be serializable to JSON without circular refs', () => {
      const data = { results: [], count: 0 }
      const result = enrichQueryLinks(data, '/api/query')

      const json = JSON.stringify(result)
      const parsed = JSON.parse(json)

      expect(parsed._links.self.href).toBe('/api/query')
      expect(parsed.data.count).toBe(0)
    })
  })
})
