/**
 * GlobalScheduler 测试
 *
 * 测试覆盖:
 * 1. 构造 & 生命周期（start/stop/running）
 * 2. 热点检测 → migrate 建议
 * 3. 分片过大 → split 建议
 * 4. 分片过小 → merge 建议
 * 5. 优先级排序（紧急在前）
 * 6. maxSuggestionsPerCycle 限制
 * 7. skipList 去重
 * 8. 低负载节点选择
 * 9. 空资源输入
 * 10. scheduleNow 手动触发
 */

import { describe, test, expect, vi } from 'vitest'
import { GlobalScheduler, SuggestionType, NodeResource, ShardLoad } from './global-scheduler'

// ── 工厂函数 ──

function makeNode(overrides: Partial<NodeResource> & { nodeId: string }): NodeResource {
  return {
    cpuPercent: 30,
    memoryPercent: 30,
    shardCount: 5,
    avgLatencyMs: 10,
    ...overrides,
  }
}

function makeShard(overrides: Partial<ShardLoad> & { rangeId: string }): ShardLoad {
  return {
    nodeCount: 500,
    edgeCount: 2000,
    qps: 100,
    avgLatencyMs: 20,
    diskBytes: 1024 * 1024,
    localNodeId: 'node-1',
    isHot: false,
    ...overrides,
  }
}

// ── 测试套件 ──

describe('GlobalScheduler', () => {
  test('should construct and report running=false', () => {
    const s = new GlobalScheduler(
      async () => ({ nodes: [], shards: [] }),
      () => {},
    )
    expect(s.running).toBe(false)
  })

  test('start/set running=true, stop sets running=false', () => {
    const s = new GlobalScheduler(
      async () => ({ nodes: [], shards: [] }),
      () => {},
    )
    expect(s.running).toBe(false)
    s.start()
    expect(s.running).toBe(true)
    s.stop()
    expect(s.running).toBe(false)
  })

  test('start twice is no-op', () => {
    const s = new GlobalScheduler(
      async () => ({ nodes: [], shards: [] }),
      () => {},
    )
    s.start()
    s.start()
    expect(s.running).toBe(true)
    s.stop()
  })

  test('should counsel split when shard node count exceeds max', async () => {
    const suggestions: any[] = []
    const s = new GlobalScheduler(
      async () => ({
        nodes: [makeNode({ nodeId: 'node-1' })],
        shards: [makeShard({ rangeId: 'r1', nodeCount: 200000, localNodeId: 'node-1' })],
      }),
      (sg) => suggestions.push(sg),
      { maxNodesPerRange: 100000, minNodesPerRange: 10 },
    )

    const count = await s.scheduleNow()
    expect(count).toBe(1)
    expect(suggestions[0].type).toBe('split')
    expect(suggestions[0].rangeId).toBe('r1')
    expect(suggestions[0].suggestedTargetCount).toBe(2)
  })

  test('split priority higher than migrate (split takes precedence)', async () => {
    const suggestions: any[] = []
    const s = new GlobalScheduler(
      async () => ({
        nodes: [
          makeNode({ nodeId: 'node-1', shardCount: 10, cpuPercent: 80, memoryPercent: 80 }),
          makeNode({ nodeId: 'node-2', shardCount: 2, cpuPercent: 20, memoryPercent: 20 }),
        ],
        shards: [
          makeShard({
            rangeId: 'r1',
            nodeCount: 200000,
            qps: 800,
            localNodeId: 'node-1',
          }),
        ],
      }),
      (sg) => suggestions.push(sg),
      { maxNodesPerRange: 100000, maxShardImbalanceRatio: 1.2 },
    )

    const count = await s.scheduleNow()
    expect(count).toBeGreaterThanOrEqual(1)
    expect(suggestions[0].type).toBe('split')
  })

  test('should counsel migrate when shard is hot on overloaded node', async () => {
    const suggestions: any[] = []
    const s = new GlobalScheduler(
      async () => ({
        nodes: [
          makeNode({ nodeId: 'node-1', shardCount: 10, cpuPercent: 80, memoryPercent: 80 }),
          makeNode({ nodeId: 'node-2', shardCount: 2, cpuPercent: 20, memoryPercent: 20 }),
        ],
        shards: [
          makeShard({
            rangeId: 'r1',
            qps: 800,
            avgLatencyMs: 200,
            localNodeId: 'node-1',
            isHot: true,
          }),
        ],
      }),
      (sg) => suggestions.push(sg),
      { hotQpsThreshold: 500, hotLatencyMsThreshold: 100 },
    )

    const count = await s.scheduleNow()
    expect(count).toBe(1)
    expect(suggestions[0].type).toBe('migrate')
    expect(suggestions[0].targetNodeId).toBe('node-2')
  })

  test('should counsel merge when shard node count is low', async () => {
    const suggestions: any[] = []
    const s = new GlobalScheduler(
      async () => ({
        nodes: [makeNode({ nodeId: 'node-1' })],
        shards: [
          makeShard({ rangeId: 'r1', nodeCount: 5 }),
          makeShard({ rangeId: 'r2', nodeCount: 500 }),
        ],
      }),
      (sg) => suggestions.push(sg),
      { maxNodesPerRange: 100000, minNodesPerRange: 100 },
    )

    const count = await s.scheduleNow()
    expect(count).toBe(1)
    expect(suggestions[0].type).toBe('merge')
  })

  test('should not migrate if no low-load node exists', async () => {
    const suggestions: any[] = []
    const s = new GlobalScheduler(
      async () => ({
        nodes: [
          makeNode({ nodeId: 'node-1', cpuPercent: 90, memoryPercent: 90 }),
        ],
        shards: [
          makeShard({
            rangeId: 'r1',
            qps: 800,
            localNodeId: 'node-1',
            isHot: true,
          }),
        ],
      }),
      (sg) => suggestions.push(sg),
    )

    const count = await s.scheduleNow()
    expect(count).toBe(0) // no viable target
  })

  test('skipList prevents duplicate suggestions in same cycle', async () => {
    const suggestions: any[] = []
    const s = new GlobalScheduler(
      async () => ({
        nodes: [makeNode({ nodeId: 'node-1' })],
        shards: [
          makeShard({ rangeId: 'r1', nodeCount: 5 }),
          makeShard({ rangeId: 'r2', nodeCount: 3 }),
        ],
      }),
      (sg) => suggestions.push(sg),
      { maxNodesPerRange: 100000, minNodesPerRange: 100, maxSuggestionsPerCycle: 10 },
    )

    // First cycle: both r1 and r2 emit merge
    const count1 = await s.scheduleNow()
    expect(suggestions.length).toBe(count1)

    // Second cycle: skipList should prevent re-emission
    const count2 = await s.scheduleNow()
    expect(count2).toBe(0) // all skipped
  })

  test('respects maxSuggestionsPerCycle', async () => {
    const suggestions: any[] = []
    const s = new GlobalScheduler(
      async () => ({
        nodes: [makeNode({ nodeId: 'node-1' })],
        shards: [
          makeShard({ rangeId: 'r1', nodeCount: 5 }),
          makeShard({ rangeId: 'r2', nodeCount: 3 }),
          makeShard({ rangeId: 'r3', nodeCount: 7 }),
          makeShard({ rangeId: 'r4', nodeCount: 2 }),
        ],
      }),
      (sg) => suggestions.push(sg),
      { maxNodesPerRange: 100000, minNodesPerRange: 100, maxSuggestionsPerCycle: 2 },
    )

    const count = await s.scheduleNow()
    expect(count).toBe(2)
  })

  test('empty resources produces zero suggestions', async () => {
    const suggestions: any[] = []
    const s = new GlobalScheduler(
      async () => ({ nodes: [], shards: [] }),
      (sg) => suggestions.push(sg),
    )

    const count = await s.scheduleNow()
    expect(count).toBe(0)
  })

  test('suggestion priority ordering (split=3 < migrate=5 < merge=8)', async () => {
    const suggestions: GlobalSuggestion[] = []
    const s = new GlobalScheduler(
      async () => ({
        nodes: [
          makeNode({ nodeId: 'node-1', shardCount: 10, cpuPercent: 80, memoryPercent: 80 }),
          makeNode({ nodeId: 'node-2', shardCount: 2, cpuPercent: 20, memoryPercent: 20 }),
        ],
        shards: [
          makeShard({ rangeId: 'r-split', nodeCount: 200000, localNodeId: 'node-1' }),
          makeShard({ rangeId: 'r-hot', qps: 800, isHot: true, localNodeId: 'node-1' }),
          makeShard({ rangeId: 'r-merge', nodeCount: 3 }),
        ],
      }),
      (sg) => suggestions.push(sg),
      {
        maxNodesPerRange: 100000,
        minNodesPerRange: 100,
        maxSuggestionsPerCycle: 10,
        hotQpsThreshold: 500,
      },
    )

    // Note: r-split 的 nodeCount > max 所以它的 split 排在第一位
    // r-hot 在 r-split 之后（因为 split 后 continue 跳过 migrate），
    // 但 r-hot 也可能被排队。确保第一条是 split。
    const count = await s.scheduleNow()
    expect(count).toBeGreaterThanOrEqual(1)
    expect(suggestions[0].type).toBe('split')
  })

  test('not hot shard does not produce migrate', async () => {
    const suggestions: any[] = []
    const s = new GlobalScheduler(
      async () => ({
        nodes: [
          makeNode({ nodeId: 'node-1', shardCount: 10, cpuPercent: 80, memoryPercent: 80 }),
          makeNode({ nodeId: 'node-2', shardCount: 2, cpuPercent: 20, memoryPercent: 20 }),
        ],
        shards: [
          makeShard({ rangeId: 'r1', qps: 50, avgLatencyMs: 5, localNodeId: 'node-1', isHot: false }),
        ],
      }),
      (sg) => suggestions.push(sg),
      { hotQpsThreshold: 500, hotLatencyMsThreshold: 100, minNodesPerRange: 1, maxNodesPerRange: 1000000 },
    )

    const count = await s.scheduleNow()
    expect(count).toBe(0) // not hot, not too big, not too small
  })

  // ── B-10: 反馈闭环 ──
  test('reportResult updates suggestion history', async () => {
    const suggestions: any[] = []
    const s = new GlobalScheduler(
      async () => ({
        nodes: [makeNode({ nodeId: 'node-1' })],
        shards: [makeShard({ rangeId: 'r1', nodeCount: 200000, localNodeId: 'node-1' })],
      }),
      (sg) => suggestions.push(sg),
      { maxNodesPerRange: 100000 },
    )

    await s.scheduleNow()
    expect(suggestions.length).toBe(1)

    // 报告接受
    s.reportResult('r1', 'split', 'accepted')
    const history = s.getSuggestionHistory()
    expect(history.length).toBeGreaterThanOrEqual(1)
    expect(history[0].result).toBe('accepted')
    expect(history[0].resultAt).toBeDefined()
    expect(s.getAcceptedCount()).toBe(1)
  })

  test('reportResult rejected clears skipList for that range', async () => {
    const suggestions: any[] = []
    const s = new GlobalScheduler(
      async () => ({
        nodes: [makeNode({ nodeId: 'node-1' })],
        shards: [makeShard({ rangeId: 'r1', nodeCount: 200000, localNodeId: 'node-1' })],
      }),
      (sg) => suggestions.push(sg),
      { maxNodesPerRange: 100000 },
    )

    // First cycle
    const count1 = await s.scheduleNow()
    expect(count1).toBe(1)

    // Second cycle — skipped due to skipList
    const count2 = await s.scheduleNow()
    expect(count2).toBe(0)

    // Report rejected (clears skipList)
    s.reportResult('r1', 'split', 'rejected')

    // Third cycle — should be able to emit again
    const count3 = await s.scheduleNow()
    expect(count3).toBe(1)
  })

  test('suggestionHistory tracks all suggestions with timestamps', async () => {
    const suggestions: any[] = []
    const s = new GlobalScheduler(
      async () => ({
        nodes: [
          makeNode({ nodeId: 'node-1' }),
          makeNode({ nodeId: 'node-2' }),
        ],
        shards: [
          makeShard({ rangeId: 'r1', nodeCount: 200000, localNodeId: 'node-1' }),
          makeShard({ rangeId: 'r2', nodeCount: 180000, localNodeId: 'node-2' }),
        ],
      }),
      (sg) => suggestions.push(sg),
      { maxNodesPerRange: 100000, maxSuggestionsPerCycle: 10 },
    )

    await s.scheduleNow()
    const history = s.getSuggestionHistory()
    expect(history.length).toBe(2)
    expect(history[0].emittedAt).toBeDefined()
    expect(history[0].emittedAt).toBeGreaterThan(0)
    expect(history[0].suggestion.type).toBe('split')
  })
})
