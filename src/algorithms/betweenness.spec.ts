import { describe, test, expect } from 'vitest'
import { betweennessCentrality } from './betweenness'

/**
 * 辅助函数：构建无向图的邻接表（每条边在两个方向上添加）
 */
function undirectedEdge(u: number, v: number, adj: Map<number, number[]>): void {
  const lu = adj.get(u) ?? []
  lu.push(v)
  adj.set(u, lu)
  const lv = adj.get(v) ?? []
  lv.push(u)
  adj.set(v, lv)
}

/**
 * 辅助函数：构建线性图的邻接表
 * 0-1-2-3-...-(n-1)
 */
function lineGraph(n: number): Map<number, number[]> {
  const adj = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    if (i > 0) undirectedEdge(i, i - 1, adj)
  }
  return adj
}

/**
 * 辅助函数：构建星形图的邻接表
 * 中心节点 0，叶子节点 1..n-1
 *     1
 *      \
 *  n-1-0-2
 *      |
 *      3
 */
function starGraph(n: number): Map<number, number[]> {
  const adj = new Map<number, number[]>()
  for (let i = 1; i < n; i++) {
    undirectedEdge(0, i, adj)
  }
  return adj
}

/**
 * 辅助函数：构建环图的邻接表
 * 0-1-2-...-(n-1)-0
 */
function cycleGraph(n: number): Map<number, number[]> {
  const adj = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    undirectedEdge(i, (i + 1) % n, adj)
  }
  return adj
}

describe('betweennessCentrality', () => {
  // ─── 第 1 个测试：线性图 ─────────────────────────────────────────
  test('linear graph — endpoints have 0, middle vertices have non-zero betweenness', () => {
    // 4 节点线性图 0-1-2-3
    const vertices = [0, 1, 2, 3]
    const adj = lineGraph(4)
    const r = betweennessCentrality(vertices, adj)

    // 端点 betweenness 应为 0（不归一化时也为 0）
    expect(r[0]).toBe(0)
    expect(r[3]).toBe(0)

    // 中间节点 > 0
    expect(r[1]).toBeGreaterThan(0)
    expect(r[2]).toBeGreaterThan(0)
  })

  // ─── 第 2 个测试：星形图 ─────────────────────────────────────────
  test('star graph — center has highest betweenness', () => {
    const vertices = [0, 1, 2, 3, 4]
    const adj = starGraph(5)
    const r = betweennessCentrality(vertices, adj)

    // 中心节点 0 的 betweenness 最高
    expect(r[0]).toBeGreaterThan(r[1])
    expect(r[0]).toBeGreaterThan(r[2])
    expect(r[0]).toBeGreaterThan(r[3])
    expect(r[0]).toBeGreaterThan(r[4])

    // 所有叶子节点 betweenness 相等
    expect(r[1]).toBe(r[2])
    expect(r[2]).toBe(r[3])
    expect(r[3]).toBe(r[4])
  })

  // ─── 第 3 个测试：环图 ───────────────────────────────────────────
  test('cycle graph — all vertices have equal betweenness', () => {
    const vertices = [0, 1, 2, 3, 4]
    const adj = cycleGraph(5)
    const r = betweennessCentrality(vertices, adj)

    // 环图的所有节点 betweenness 相等（对称性）
    expect(r[0]).toBe(r[1])
    expect(r[1]).toBe(r[2])
    expect(r[2]).toBe(r[3])
    expect(r[3]).toBe(r[4])

    // 每个节点的值应大于 0（5节点环图，归一化后每个节点应为正数）
    expect(r[0]).toBeGreaterThan(0)
  })

  // ─── 第 4 个测试：归一化 ──────────────────────────────────────────
  test('normalized vs unnormalized — normalized values are scaled down', () => {
    const vertices = [0, 1, 2, 3]
    const adj = lineGraph(4)

    const rNorm = betweennessCentrality(vertices, adj, true)
    const rRaw = betweennessCentrality(vertices, adj, false)

    // 归一化值应小于或等于原始值
    // 对于线性图 0-1-2-3，原始值：
    //   CB(1)=4, CB(2)=4
    //   归一化因子 = (n-1)(n-2) = 6
    //   归一化后 CB(1)=4/6=0.666..., CB(2)=4/6=0.666...
    expect(rRaw[1]).toBe(4)
    expect(rRaw[2]).toBe(4)
    expect(rNorm[1]).toBeCloseTo(4 / 6, 10)
    expect(rNorm[2]).toBeCloseTo(4 / 6, 10)
    expect(rNorm[0]).toBe(0)
    expect(rNorm[3]).toBe(0)
  })

  // ─── 第 5 个测试：空图 ────────────────────────────────────────────
  test('empty graph — empty vertex list returns empty result', () => {
    const r = betweennessCentrality([], new Map())
    expect(Object.keys(r)).toHaveLength(0)
  })

  // ─── 第 6 个测试：单节点 ──────────────────────────────────────────
  test('single vertex — betweenness is 0', () => {
    const adj = new Map<number, number[]>([[42, []]])
    const r = betweennessCentrality([42], adj)
    expect(r[42]).toBe(0)
  })

  // ─── 第 7 个测试：团图（clique）—— 所有节点 betweenness = 0  ────
  test('clique — all vertices have zero betweenness (no shortest path goes through another node)', () => {
    // 4 节点完全图，不归一化
    const adj = new Map<number, number[]>([
      [0, [1, 2, 3]],
      [1, [0, 2, 3]],
      [2, [0, 1, 3]],
      [3, [0, 1, 2]],
    ])
    const r = betweennessCentrality([0, 1, 2, 3], adj, false)
    expect(r[0]).toBe(0)
    expect(r[1]).toBe(0)
    expect(r[2]).toBe(0)
    expect(r[3]).toBe(0)
  })

  // ─── 第 8 个测试：3 节点线性图精确值验证 ───────────────────────
  test('3-node line — exact betweenness values', () => {
    // 图: 0-1-2
    // 不归一化时，节点 1 的 betweenness = 2
    // （路径 0→2 和 2→0 都经过节点 1）
    const adj = new Map<number, number[]>([
      [0, [1]],
      [1, [0, 2]],
      [2, [1]],
    ])
    const rRaw = betweennessCentrality([0, 1, 2], adj, false)
    expect(rRaw[0]).toBe(0)
    expect(rRaw[1]).toBe(2)
    expect(rRaw[2]).toBe(0)

    // 归一化：分母 = (n-1)(n-2) = 2
    const rNorm = betweennessCentrality([0, 1, 2], adj, true)
    expect(rNorm[0]).toBe(0)
    expect(rNorm[1]).toBeCloseTo(1, 10)
    expect(rNorm[2]).toBe(0)
  })

  // ─── 第 9 个测试：非连续节点 ID ────────────────────────────────
  test('non-consecutive vertex IDs', () => {
    const vertices = [10, 20, 30]
    const adj = new Map<number, number[]>([
      [10, [20]],
      [20, [10, 30]],
      [30, [20]],
    ])
    const r = betweennessCentrality(vertices, adj, false)
    expect(r[10]).toBe(0)
    expect(r[20]).toBe(2)
    expect(r[30]).toBe(0)
  })

  // ─── 第 10 个测试：子集顶点（部分连通图只计算子集） ──────────
  test('subset of vertices — only computes for specified nodes', () => {
    // 完整图: 0-1-2-3
    // 只计算 [0, 3]：两个节点不连通，因此 betweenness = 0
    const adj = new Map<number, number[]>([
      [0, [1]],
      [1, [0, 2]],
      [2, [1, 3]],
      [3, [2]],
    ])
    const r = betweennessCentrality([0, 3], adj, false)
    expect(r[0]).toBe(0)
    expect(r[3]).toBe(0)
  })
})
