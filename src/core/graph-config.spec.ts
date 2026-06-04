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
