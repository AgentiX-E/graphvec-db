import { DeltaSync } from './delta-sync'
import { HlcClock } from './hlc-clock'
import { GraphEngine } from '../core/graph-engine'

jest.mock('../core/graph-engine', () => {
  return {
    GraphEngine: jest.fn().mockImplementation(() => ({
      upsertNode: jest.fn(),
      open: jest.fn(),
      close: jest.fn(),
      isOpen: false,
      stats: jest.fn().mockReturnValue({ nodeCount: 0, edgeCount: 0, diskSizeBytes: 0 }),
      queryPattern: jest.fn().mockReturnValue([]),
    })),
  }
})

describe('DeltaSync', () => {
  let clock: HlcClock
  let engine: GraphEngine
  let ds: DeltaSync

  beforeEach(() => {
    clock = new HlcClock()
    engine = new (GraphEngine as any)({ path: ':memory:' })
    ds = new DeltaSync('dc-1', engine, clock)
  })

  test('should create DeltaSync', () => {
    expect(ds).toBeDefined()
  })

  test('should start and stop auto flush', () => {
    const handler = jest.fn()
    ds.startAutoFlush(handler, 50)
    expect(ds).toBeDefined()

    // Wait for at least one flush cycle
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        ds.stopAutoFlush()
        resolve()
      }, 60)
    })
  })

  test('should record changes', () => {
    ds.recordChange('node-1', { name: 'test', value: 42 })
    // flushDeltas should return deltas
    const deltas = ds.flushDeltas()
    expect(Array.isArray(deltas)).toBe(true)
    expect(deltas.length).toBe(1)
    expect(deltas[0].dcId).toBe('dc-1')
    expect(typeof deltas[0].batchId).toBe('string')
    expect(deltas[0].timestamp).toBeDefined()
    expect(typeof deltas[0].timestamp).toBe('number')
  })

  test('should return empty when no pending deltas', () => {
    const deltas = ds.flushDeltas()
    expect(deltas).toEqual([])
  })

  test('should flush and clear pending deltas', () => {
    ds.recordChange('node-1', { name: 'first' })
    const firstFlush = ds.flushDeltas()
    expect(firstFlush.length).toBe(1)

    // Second flush should be empty since pending was cleared
    const secondFlush = ds.flushDeltas()
    expect(secondFlush).toEqual([])
  })

  test('should stop auto flush without error', () => {
    expect(() => ds.stopAutoFlush()).not.toThrow()
  })

  test('should handle multiple calls to stopAutoFlush', () => {
    ds.stopAutoFlush()
    ds.stopAutoFlush() // second call should be safe
    expect(true).toBe(true)
  })

  test('should set timestamp on flushed deltas', () => {
    ds.recordChange('node-1', { x: 1 })
    const deltas = ds.flushDeltas()
    expect(deltas.length).toBe(1)
    expect(deltas[0].timestamp).toBeDefined()
    // timestamp should be recent (within 5s)
    expect(Date.now() - deltas[0].timestamp!).toBeLessThan(5000)
  })
})
