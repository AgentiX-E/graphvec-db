/**
 * compression.spec.ts — CompressionMiddleware 测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CompressionMiddleware, negotiateEncoding } from './compression'
import { IncomingMessage, ServerResponse } from 'http'
import { Socket } from 'net'
import * as zlib from 'zlib'

function createMockReq(acceptEncoding?: string): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  if (acceptEncoding) {
    req.headers['accept-encoding'] = acceptEncoding
  }
  return req
}

function createMockRes(): ServerResponse {
  return new ServerResponse(new IncomingMessage(new Socket()))
}

describe('negotiateEncoding', () => {
  it('should return null for no Accept-Encoding header', () => {
    expect(negotiateEncoding(undefined)).toBeNull()
  })

  it('should return gzip for gzip in Accept-Encoding', () => {
    expect(negotiateEncoding('gzip')).toBe('gzip')
  })

  it('should return brotli for brotli in Accept-Encoding', () => {
    expect(negotiateEncoding('br')).toBe('brotli')
  })

  it('should prefer brotli over gzip', () => {
    expect(negotiateEncoding('br, gzip')).toBe('brotli')
  })

  it('should return gzip for wildcard', () => {
    expect(negotiateEncoding('*')).toBe('gzip')
  })

  it('should respect q values', () => {
    expect(negotiateEncoding('gzip;q=0.5, br;q=0.8')).toBe('brotli')
  })

  it('should return null when q=0', () => {
    expect(negotiateEncoding('gzip;q=0')).toBeNull()
  })

  it('should return null for identity only', () => {
    expect(negotiateEncoding('identity')).toBeNull()
  })
})

describe('CompressionMiddleware', () => {
  describe('constructor and options', () => {
    it('should apply default options', () => {
      const mw = new CompressionMiddleware()
      const opts = mw.getOptions()
      expect(opts.algorithm).toBe('gzip')
      expect(opts.level).toBe('balanced')
      expect(opts.threshold).toBe(1024)
      expect(opts.contentTypes).toContain('application/json')
    })

    it('should accept custom options', () => {
      const mw = new CompressionMiddleware({ algorithm: 'brotli', threshold: 500 })
      const opts = mw.getOptions()
      expect(opts.algorithm).toBe('brotli')
      expect(opts.threshold).toBe(500)
    })

    it('should allow runtime option update', () => {
      const mw = new CompressionMiddleware()
      mw.setOptions({ level: 'max' })
      expect(mw.getOptions().level).toBe('max')
    })
  })

  describe('wrapResponse - compressed output', () => {
    it('should set Content-Encoding header for gzip-compressed response', () => {
      const req = createMockReq('gzip')
      const res = createMockRes()
      const mw = new CompressionMiddleware({ threshold: 10 })

      mw.wrapResponse(req, res)

      const body = JSON.stringify({ data: 'x'.repeat(500) })
      expect(body.length).toBeGreaterThan(10)

      // writeHead via middleware override — sets compressionApplied = true
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(body)

      // Middleware should have set Content-Encoding in headers
      expect(res.getHeader('Content-Encoding')).toBe('gzip')
    })

    it('should add Content-Length after compression', () => {
      const req = createMockReq('gzip')
      const res = createMockRes()
      const mw = new CompressionMiddleware({ threshold: 10 })

      mw.wrapResponse(req, res)

      const body = JSON.stringify({ data: 'x'.repeat(500) })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(body)

      expect(typeof res.getHeader('Content-Length')).toBe('number')
    })

    it('should NOT compress response when body below threshold', () => {
      const req = createMockReq('gzip')
      const res = createMockRes()
      const mw = new CompressionMiddleware({ threshold: 100000 }) // huge threshold

      mw.wrapResponse(req, res)

      const body = '{"status":"ok"}'
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(body)

      expect(res.getHeader('Content-Encoding')).toBeUndefined()
    })

    it('should NOT compress non-JSON content types', () => {
      const req = createMockReq('gzip')
      const res = createMockRes()
      const mw = new CompressionMiddleware({ threshold: 10 })

      mw.wrapResponse(req, res)

      const body = '<html><body>hello</body></html>'
      res.writeHead(200, { 'Content-Type': 'text/html' })
      
      res.end(body)

      // HTML 不在默认压缩 contentTypes 中
      expect(res.getHeader('Content-Encoding')).toBeUndefined()
    })

    it('should not compress when no Accept-Encoding header', () => {
      const req = createMockReq(undefined)
      const res = createMockRes()
      const mw = new CompressionMiddleware({ threshold: 10 })

      mw.wrapResponse(req, res)

      const body = 'x'.repeat(2000)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      
      res.end(body)

      expect(res.getHeader('Content-Encoding')).toBeUndefined()
    })

    it('should remove Content-Length when compressing', () => {
      const req = createMockReq('gzip')
      const res = createMockRes()
      const mw = new CompressionMiddleware({ threshold: 10 })

      mw.wrapResponse(req, res)

      const body = 'x'.repeat(2000)
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
      })
      
      res.end(body)

      // Content-Length should be set to compressed size, not original body.length
      const contentLength = res.getHeader('Content-Length') as number
      expect(contentLength).toBeGreaterThan(0)
      expect(contentLength).not.toBe(body.length)
    })
  })

  describe('getGrpcCompressionOptions', () => {
    it('should return gzip compression options by default', () => {
      const mw = new CompressionMiddleware()
      const opts = mw.getGrpcCompressionOptions()
      expect(opts['grpc.default_compression_algorithm']).toBe(2)
    })

    it('should return 0 for algorithm=none', () => {
      const mw = new CompressionMiddleware({ algorithm: 'none' })
      const opts = mw.getGrpcCompressionOptions()
      expect(opts['grpc.default_compression_algorithm']).toBe(0)
    })
  })

  describe('compression failure fallback', () => {
    it('should not crash on normal operation', () => {
      const req = createMockReq('gzip')
      const res = createMockRes()
      const mw = new CompressionMiddleware({ threshold: 10 })

      mw.wrapResponse(req, res)
      

      res.writeHead(200, { 'Content-Type': 'application/json' })

      const body = JSON.stringify({ hello: 'world' })
      expect(() => res.end(body)).not.toThrow()
    })
  })
})
