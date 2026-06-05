import { GraphConfig } from './graph-config'

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
    const config = new GraphConfig({ path: '/tmp/partial', walEnabled: false })
    const cfg = config.getConfig()
    expect(cfg.path).toBe('/tmp/partial')
    expect(cfg.walEnabled).toBe(false)
    // Should still have defaults for unspecified fields
    expect(cfg.denseVector?.dimension).toBe(384)
  })

  test('should create config for in-memory graph', () => {
    const config = new GraphConfig({ path: ':memory:' })
    const cfg = config.getConfig()
    expect(cfg.path).toBe(':memory:')
  })

  test('should handle maxNodeCacheSize override', () => {
    const config = new GraphConfig({ path: '/tmp/cache-test', maxNodeCacheSize: 10000 })
    const cfg = config.getConfig()
    expect(cfg.maxNodeCacheSize).toBe(10000)
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
