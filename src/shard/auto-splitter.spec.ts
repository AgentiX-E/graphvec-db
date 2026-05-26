import { AutoSplitter, type SplitSuggestion } from './auto-splitter'
import type { RangeInstance } from './range-instance'

describe('AutoSplitter', () => {
  let splitter: AutoSplitter

  afterEach(() => {
    splitter.stop()
  })

  function mockRange(overrides: Partial<RangeInstance>): RangeInstance {
    return overrides as RangeInstance
  }

  test('should start and stop', () => {
    splitter = new AutoSplitter(() => [], () => {})
    expect(splitter.running).toBe(false)

    splitter.start()
    expect(splitter.running).toBe(true)

    splitter.stop()
    expect(splitter.running).toBe(false)
  })

  test('should check and detect oversized ranges and pass SplitSuggestion', async () => {
    let suggestion: SplitSuggestion | undefined
    const getRanges = () => [mockRange({
      config: { rangeId: 'r1' } as any,
      isDraining: () => false,
      engine: {
        stats: () => ({ nodeCount: 200000, edgeCount: 50000, diskSizeBytes: 0 }),
      },
    } as RangeInstance)]
    const onReshard = (s?: SplitSuggestion) => { suggestion = s }

    splitter = new AutoSplitter(getRanges, onReshard, { maxNodesPerRange: 100000 })
    const count = await splitter.checkNow()
    expect(count).toBe(1)
    expect(suggestion).toBeDefined()
    expect(suggestion!.rangeId).toBe('r1')
    expect(suggestion!.nodeCount).toBe(200000)
    expect(suggestion!.edgeCount).toBe(50000)
    expect(suggestion!.suggestedTargetCount).toBe(2)
    expect(suggestion!.reason).toBe('node_count_exceeded')
  })

  test('should compute suggestedTargetCount correctly (1500/1000 → ceil=2)', async () => {
    let suggestion: SplitSuggestion | undefined
    const getRanges = () => [mockRange({
      config: { rangeId: 'r2' } as any,
      isDraining: () => false,
      engine: {
        stats: () => ({ nodeCount: 1500, edgeCount: 300, diskSizeBytes: 0 }),
      },
    } as RangeInstance)]
    const onReshard = (s?: SplitSuggestion) => { suggestion = s }

    splitter = new AutoSplitter(getRanges, onReshard, { maxNodesPerRange: 1000 })
    const count = await splitter.checkNow()
    expect(count).toBe(1)
    expect(suggestion).toBeDefined()
    expect(suggestion!.suggestedTargetCount).toBe(2)
    expect(suggestion!.nodeCount).toBe(1500)
  })

  test('should skip ranges below threshold', async () => {
    let resharded = false
    const getRanges = () => [mockRange({
      config: { rangeId: 'r1' } as any,
      isDraining: () => false,
      engine: {
        stats: () => ({ nodeCount: 1000, edgeCount: 500, diskSizeBytes: 0 }),
      },
    } as RangeInstance)]
    const onReshard = () => { resharded = true }

    splitter = new AutoSplitter(getRanges, onReshard, { maxNodesPerRange: 100000 })
    const count = await splitter.checkNow()
    expect(count).toBe(0)
    expect(resharded).toBe(false)
  })

  test('should skip draining ranges', async () => {
    let resharded = false
    const getRanges = () => [mockRange({
      config: { rangeId: 'r1' } as any,
      isDraining: () => true,
      engine: {
        stats: () => ({ nodeCount: 200000, edgeCount: 50000, diskSizeBytes: 0 }),
      },
    } as RangeInstance)]
    const onReshard = () => { resharded = true }

    splitter = new AutoSplitter(getRanges, onReshard, { maxNodesPerRange: 100000 })
    const count = await splitter.checkNow()
    expect(count).toBe(0)
    expect(resharded).toBe(false)
  })

  test('should respect minSplitInterval', async () => {
    let reshardCount = 0
    const getRanges = () => [mockRange({
      config: { rangeId: 'r1' } as any,
      isDraining: () => false,
      engine: {
        stats: () => ({ nodeCount: 200000, edgeCount: 50000, diskSizeBytes: 0 }),
      },
    } as RangeInstance)]
    const onReshard = () => { reshardCount++ }

    splitter = new AutoSplitter(getRanges, onReshard, {
      maxNodesPerRange: 100000,
      minSplitIntervalMs: 60000,
    })
    await splitter.checkNow()
    // 第二次立即检查 — 应跳过
    await splitter.checkNow()
    expect(reshardCount).toBe(1)
  })
})
