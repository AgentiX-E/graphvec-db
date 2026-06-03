import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { StatsCollector } from './stats-collector'

describe('StatsCollector', () => {
  let collector: StatsCollector | null = null
  let mockEngine: any

  beforeEach(() => {
    vi.useFakeTimers()
    mockEngine = {
      stats: vi.fn().mockReturnValue({ nodeCount: 100, edgeCount: 250 }),
      getNodeCount: vi.fn().mockResolvedValue(100),
      getEdgeCount: vi.fn().mockResolvedValue(250),
      countByLabel: vi.fn().mockResolvedValue([['Person', 40], ['Company', 30], ['Place', 30]]),
      countEdgesByType: vi.fn().mockResolvedValue([['knows', 100], ['works_at', 150]]),
      getAllNodes: vi.fn().mockResolvedValue([]),
    }
  })

  afterEach(() => {
    if (collector) {
      try { collector.stopPeriodicCollection() } catch {}
    }
    vi.useRealTimers()
  })

  test('constructor creates instance', () => {
    collector = new StatsCollector(mockEngine, { intervalMs: 60000 })
    expect(collector).toBeDefined()
  })

  test('collectNow returns StatsSnapshot', async () => {
    collector = new StatsCollector(mockEngine, { intervalMs: 60000 })
    const s = await collector.collectNow()
    expect(s.totalNodes).toBe(100)
    expect(s.totalEdges).toBe(250)
  })

  test('collectNow includes type distribution', async () => {
    collector = new StatsCollector(mockEngine, { intervalMs: 60000 })
    const s = await collector.collectNow()
    expect(s.typeStats).toBeDefined()
  })

  test('collectNow includes timestamp (collectedAt)', async () => {
    collector = new StatsCollector(mockEngine, { intervalMs: 60000 })
    const s = await collector.collectNow()
    expect(s.collectedAt).toBeGreaterThan(0)
  })

  test('collectNow handles engine errors gracefully', async () => {
    mockEngine.stats = vi.fn().mockReturnValue({ nodeCount: 0, edgeCount: 0 })
    mockEngine.getAllNodes = vi.fn().mockRejectedValue(new Error('scan failed'))
    collector = new StatsCollector(mockEngine, { intervalMs: 60000 })
    const s = await collector.collectNow()
    expect(s.totalNodes).toBe(0)
    expect(s.totalEdges).toBe(0)
  })

  test('start/stop periodic collection', () => {
    collector = new StatsCollector(mockEngine, { intervalMs: 60000 })
    collector.startPeriodicCollection()
    collector.stopPeriodicCollection()
    collector.stopPeriodicCollection() // safe to call twice
  })

  test('estimateSelectivity returns number between 0 and 1', async () => {
    collector = new StatsCollector(mockEngine, { intervalMs: 60000 })
    await collector.collectNow()
    const sel = collector.estimateSelectivity(1, { field: 'age', op: 'eq' })
    expect(sel).toBeGreaterThanOrEqual(0)
    expect(sel).toBeLessThanOrEqual(1)
  })

  test('constructor with null engine', () => {
    collector = new StatsCollector(null as any, { intervalMs: 60000 })
    expect(collector).toBeDefined()
  })
})
