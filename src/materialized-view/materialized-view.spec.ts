import { MaterializedView } from './materialized-view'
import { MaterializedViewConfig } from '../types'
import { GraphEngine } from '../core/graph-engine'

vi.mock('../core/graph-engine', () => {
  return {
    GraphEngine: vi.fn().mockImplementation(function() { return {
      upsertNode: vi.fn(),
      open: vi.fn(),
      close: vi.fn(),
      isOpen: false,
      stats: vi.fn().mockReturnValue({ nodeCount: 42, edgeCount: 7, diskSizeBytes: 65536 }),
      queryPattern: vi.fn().mockReturnValue([
        { type: 1, name: 'node-1', props: { name: 'Alice' } },
        { type: 1, name: 'node-2', props: { name: 'Bob' } },
      ]),
    }}),
  }
})

describe('MaterializedView', () => {
  let config: MaterializedViewConfig
  let sourceEngine: GraphEngine
  let mv: MaterializedView

  beforeEach(() => {
    config = {
      name: 'test-view',
      pattern: { depth: 1 as const },
      refreshPolicy: 'manual',
    }
    sourceEngine = new (GraphEngine as any)({ path: ':memory:' })
    mv = new MaterializedView(config, sourceEngine, '/tmp/test-view')
  })

  test('should create with valid config', () => {
    expect(mv).toBeDefined()
  })

  test('should open and close', () => {
    expect(() => mv.open()).not.toThrow()
    expect(() => mv.close()).not.toThrow()
  })

  test('should refresh from source engine', async () => {
    const count = await mv.refresh()
    expect(count).toBe(2) // 2 mock nodes returned
  })

  test('should return status with view info', () => {
    mv.open()
    const status = mv.getStatus()
    expect(status.name).toBe('test-view')
    expect(status.nodeCount).toBe(42)
    expect(status.edgeCount).toBe(7)
    expect(status.sizeBytes).toBe(65536)
    mv.close()
  })

  test('should query view engine', () => {
    mv.open()
    const results = mv.query({ depth: 1 })
    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBe(2)
    mv.close()
  })

  test('should drop without throwing', () => {
    expect(() => mv.drop()).not.toThrow()
  })

  test('should start periodic refresh when refreshPolicy is periodic', () => {
    const periodicConfig: MaterializedViewConfig = {
      name: 'periodic-view',
      pattern: { depth: 2 as const },
      refreshPolicy: 'periodic',
      refreshIntervalSeconds: 10,
    }
    const periodicMv = new MaterializedView(periodicConfig, sourceEngine, '/tmp/periodic-view')
    expect(() => periodicMv.open()).not.toThrow()
    expect(() => periodicMv.close()).not.toThrow()
  })
})
