import { describe, test, expect } from 'vitest'
import { LinkPredictor } from './link-prediction'

function buildEdges(size: number): Array<{ src: number; dst: number }> {
  // 构建一个小型链式图：0-1, 1-2, 2-3, ...
  const edges: Array<{ src: number; dst: number }> = []
  for (let i = 0; i < size - 1; i++) {
    edges.push({ src: i, dst: i + 1 })
  }
  return edges
}

describe('LinkPredictor', () => {
  const allNodes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
  const edges = buildEdges(10)
  const lp = new LinkPredictor(allNodes, undefined, 42)

  test('trainTestSplit splits by ratio', () => {
    const e = buildEdges(10)
    const split = lp.trainTestSplit(e, { testRatio: 0.2 })
    expect(split.train.length + split.test.length).toBe(e.length)
    expect(split.test.length).toBeGreaterThanOrEqual(1)
  })

  test('trainTestSplit with default ratio 0.2', () => {
    const e = buildEdges(10)
    const split = lp.trainTestSplit(e)
    expect(split.train.length + split.test.length).toBe(e.length)
    expect(split.test.length).toBeGreaterThanOrEqual(1)
    expect(split.test.length).toBeLessThanOrEqual(3)
  })

  test('negativeSample returns non-existing edges', () => {
    const e = buildEdges(10)
    const neg = lp.negativeSample(10, e)
    expect(neg.length).toBe(10)
    for (const n of neg) {
      // 不能存在于原始边中
      const exists = e.some(e2 => (e2.src === n.src && e2.dst === n.dst) || (e2.src === n.dst && e2.dst === n.src))
      expect(exists).toBe(false)
      // 不能自连
      expect(n.src).not.toBe(n.dst)
    }
  })

  test('negativeSample no duplicate edges', () => {
    const neg = lp.negativeSample(100, edges)
    const keys = new Set(neg.map(e => `${Math.min(e.src, e.dst)}-${Math.max(e.src, e.dst)}`))
    expect(keys.size).toBe(neg.length)
  })

  test('trainTestSplit partitions all edges', () => {
    const e = buildEdges(10)
    const split = lp.trainTestSplit(e)
    expect(split.train.length + split.test.length).toBe(e.length)
  })

  test('Jaccard similarity evaluation returns valid metrics', () => {
    const split = lp.trainTestSplit(edges)
    const neg = lp.negativeSample(20, split.train)
    const result = lp.evaluate('jaccard', split.train, split.test, neg)
    expect(result.aucRoc).toBeGreaterThanOrEqual(0)
    expect(result.aucRoc).toBeLessThanOrEqual(1)
    expect(result.f1).toBeGreaterThanOrEqual(0)
    expect(result.f1).toBeLessThanOrEqual(1)
    expect(result.precisionAtK).toBeGreaterThanOrEqual(0)
    expect(result.method).toBe('jaccard')
    expect(result.positiveCount).toBe(split.test.length)
    expect(result.negativeCount).toBe(neg.length)
  })

  test('AdamicAdar evaluation returns valid metrics', () => {
    const split = lp.trainTestSplit(edges)
    const neg = lp.negativeSample(20, split.train)
    const result = lp.evaluate('adamicAdar', split.train, split.test, neg)
    expect(result.aucRoc).toBeGreaterThanOrEqual(0)
    expect(result.f1).toBeGreaterThanOrEqual(0)
    expect(result.precision).toBeGreaterThanOrEqual(0)
    expect(result.recall).toBeGreaterThanOrEqual(0)
  })

  test('ResourceAllocation evaluation returns valid metrics', () => {
    const split = lp.trainTestSplit(edges)
    const neg = lp.negativeSample(20, split.train)
    const result = lp.evaluate('resourceAllocation', split.train, split.test, neg)
    expect(result.aucRoc).toBeGreaterThanOrEqual(0)
    expect(result.f1).toBeGreaterThanOrEqual(0)
  })

  test('PreferentialAttachment evaluation returns valid metrics', () => {
    const split = lp.trainTestSplit(edges)
    const neg = lp.negativeSample(20, split.train)
    const result = lp.evaluate('preferentialAttachment', split.train, split.test, neg)
    expect(result.aucRoc).toBeGreaterThanOrEqual(0)
  })

  test('evaluateGNN uses inference function and returns valid metrics', async () => {
    const split = lp.trainTestSplit(edges)
    const neg = lp.negativeSample(20, split.train)
    const mockInference = async (_edges: Array<{ src: number; dst: number }>) => {
      return new Float64Array(_edges.length).fill(0.5)
    }
    const result = await lp.evaluateGNN(split.train, split.test, neg, mockInference)
    expect(result.method).toBe('gnn')
    expect(result.aucRoc).toBeGreaterThanOrEqual(0)
    expect(result.aucRoc).toBeLessThanOrEqual(1)
    expect(result.f1).toBeGreaterThanOrEqual(0)
  })

  test('all four methods return results on small graph', () => {
    const split = lp.trainTestSplit(edges)
    const neg = lp.negativeSample(15, split.train)
    for (const method of ['jaccard', 'adamicAdar', 'resourceAllocation', 'preferentialAttachment'] as const) {
      const r = lp.evaluate(method, split.train, split.test, neg)
      expect(r.aucRoc).toBeGreaterThanOrEqual(0)
      expect(r.precisionAtK).toBeGreaterThanOrEqual(0)
    }
  })

  test('LinkPredictor with pre-built adjacency', () => {
    const adj = new Map<number, Set<number>>()
    adj.set(0, new Set([1, 2]))
    adj.set(1, new Set([0, 2]))
    adj.set(2, new Set([0, 1]))
    adj.set(3, new Set([4]))
    adj.set(4, new Set([3]))
    const lp2 = new LinkPredictor([0, 1, 2, 3, 4], adj, 42)
    const all = [{ src: 0, dst: 1 }, { src: 0, dst: 2 }, { src: 1, dst: 2 }, { src: 3, dst: 4 }]
    const split = lp2.trainTestSplit(all)
    const neg = lp2.negativeSample(10, split.train)
    const r = lp2.evaluate('jaccard', split.train, split.test, neg)
    expect(r.aucRoc).toBeGreaterThanOrEqual(0)
  })
})
