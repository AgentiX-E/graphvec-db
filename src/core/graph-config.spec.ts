import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { GraphConfig } from './graph-config'

const ORIG_ENV = { ...process.env }

function clearConfigEnv(): void {
  delete process.env.DATA_DIR
  delete process.env.VECTOR_DIMENSION
}

describe('GraphConfig', () => {
  test('should create with default config', () => {
    const config = new GraphConfig({ path: '/tmp/test-graph' })
    expect(config).toBeDefined()
    const cfg = config.getConfig()
    expect(cfg.path).toBe('/tmp/test-graph')
    expect(cfg.denseVector?.dimension).toBe(384)
  })

  test('should apply overrides correctly', () => {
    const config = new GraphConfig({
      path: '/custom/graph/path',
      denseVector: { dimension: 768 },
      cacheSize: 500,
    })
    const cfg = config.getConfig()
    expect(cfg.path).toBe('/custom/graph/path')
    expect(cfg.denseVector?.dimension).toBe(768)
    expect(cfg.cacheSize).toBe(500)
  })

  test('should create engine from config', () => {
    const config = new GraphConfig({ path: '/tmp/test-graph-engine' })
    const engine = config.createEngine()
    expect(engine).toBeDefined()
    // Engine should not be open yet (we call open() separately)
  })

  test('should get config values via getConfig', () => {
    const config = new GraphConfig({ path: '/tmp/config-values' })
    const cfg = config.getConfig()
    expect(cfg.path).toBe('/tmp/config-values')
    expect(typeof cfg.denseVector?.dimension).toBe('number')
  })

  test('should apply partial overrides without losing defaults', () => {
    const config = new GraphConfig({ path: '/tmp/partial', nodeCacheSize: 500 })
    const cfg = config.getConfig()
    expect(cfg.path).toBe('/tmp/partial')
    expect(cfg.nodeCacheSize).toBe(500)
    // Should still have defaults for unspecified fields
    expect(cfg.denseVector?.dimension).toBe(384)
  })

  test('should create config for in-memory graph', () => {
    const config = new GraphConfig({ path: ':memory:' })
    const cfg = config.getConfig()
    expect(cfg.path).toBe(':memory:')
  })

  test('should handle nodeCacheSize override', () => {
    const config = new GraphConfig({ path: '/tmp/cache-test', nodeCacheSize: 10000 })
    const cfg = config.getConfig()
    expect(cfg.nodeCacheSize).toBe(10000)
  })
})

// ---- GraphConfig 扩展测试 ----

describe('GraphConfig — expansion', () => {
  for (let iter = 0; iter < 20; iter++) {
    test(`config 各种 path 变体 #${iter}`, () => {
      const path = `/tmp/gc-variant-${iter}-${Date.now()}`
      const config = new GraphConfig({ path })
      const cfg = config.getConfig()
      expect(cfg.path).toBe(path)
      expect(cfg.denseVector?.dimension).toBe(384)
    })
  }

  for (let iter = 0; iter < 10; iter++) {
    test(`config denseVector 维度变体 #${iter}`, () => {
      const config = new GraphConfig({ path: `/tmp/gc-dim-${iter}`, denseVector: { dimension: 128 * (iter + 1) } })
      const cfg = config.getConfig()
      expect(cfg.denseVector?.dimension).toBe(128 * (iter + 1))
    })
  }

  for (let iter = 0; iter < 10; iter++) {
    test(`config cacheSize 变体 #${iter}`, () => {
      const config = new GraphConfig({ path: `/tmp/gc-cache-${iter}`, cacheSize: iter * 100 })
      const cfg = config.getConfig()
      expect(cfg.cacheSize).toBe(iter * 100)
    })
  }
})

// ---- GraphConfig environment variable validation ----

describe('GraphConfig environment validation', () => {
  beforeEach(() => {
    clearConfigEnv()
  })

  afterEach(() => {
    process.env = { ...ORIG_ENV }
  })

  it('applies defaults when no env vars are set', () => {
    const cfg = new GraphConfig()
    const c = cfg.getConfig()
    expect(c.path).toBe('./data/graph')
    expect(c.denseVector).toEqual({ dimension: 384 })
  })

  it('parses a valid DATA_DIR', () => {
    process.env.DATA_DIR = '/tmp/db'
    const cfg = new GraphConfig()
    expect(cfg.getConfig().path).toBe('/tmp/db/graph')
  })

  it('parses a valid VECTOR_DIMENSION', () => {
    process.env.VECTOR_DIMENSION = '512'
    const cfg = new GraphConfig()
    expect(cfg.getConfig().denseVector).toEqual({ dimension: 512 })
  })

  it('treats an empty DATA_DIR as unset (falls back to default)', () => {
    process.env.DATA_DIR = ''
    const cfg = new GraphConfig()
    expect(cfg.getConfig().path).toBe('./data/graph')
  })

  it('rejects a whitespace-only DATA_DIR', () => {
    process.env.DATA_DIR = '   '
    expect(() => new GraphConfig()).toThrow(/DATA_DIR must be a non-empty string/)
  })

  it('rejects a non-numeric VECTOR_DIMENSION', () => {
    process.env.VECTOR_DIMENSION = 'abc'
    expect(() => new GraphConfig()).toThrow(/VECTOR_DIMENSION must be a valid integer/)
  })

  it('rejects a zero VECTOR_DIMENSION', () => {
    process.env.VECTOR_DIMENSION = '0'
    expect(() => new GraphConfig()).toThrow(/VECTOR_DIMENSION must be a positive integer/)
  })

  it('rejects a negative VECTOR_DIMENSION', () => {
    process.env.VECTOR_DIMENSION = '-4'
    expect(() => new GraphConfig()).toThrow(/VECTOR_DIMENSION must be a positive integer/)
  })

  it('rejects a fractional VECTOR_DIMENSION (3.7, not silently truncated)', () => {
    process.env.VECTOR_DIMENSION = '3.7'
    expect(() => new GraphConfig()).toThrow(/VECTOR_DIMENSION/)
  })

  it('rejects a VECTOR_DIMENSION with trailing garbage (12abc)', () => {
    process.env.VECTOR_DIMENSION = '12abc'
    expect(() => new GraphConfig()).toThrow(/VECTOR_DIMENSION/)
  })

  it('merges overrides over defaults and env', () => {
    process.env.VECTOR_DIMENSION = '256'
    const cfg = new GraphConfig({ denseVector: { dimension: 1024 } })
    // Explicit overrides win over env.
    expect(cfg.getConfig().denseVector).toEqual({ dimension: 1024 })
  })

  it('getConfig returns a defensive copy', () => {
    const cfg = new GraphConfig()
    const c1 = cfg.getConfig()
    c1.path = '/hacked'
    expect(cfg.getConfig().path).toBe('./data/graph')
  })
})
