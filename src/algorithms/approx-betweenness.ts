/**
 * Approximate Betweenness Centrality
 *
 * 使用采样法避免 O(n³) 的精确 Brandes 算法开销。
 * 对大规模图，精确中介中心性达到 O(V * E) 甚至 O(V * (E + V log V))，
 * 对 V 巨大的图不可行。
 *
 * 本实现：从所有节点中随机采样 k 个子集作为源节点，
 * 对每个采样源运行 Brandes BFS/Dijkstra，累计 delta 贡献，
 * 最后按采样比例放缩。
 *
 * 时间复杂度: O(k * (E + V log V)) (k = sampleSize)
 * 空间复杂度: O(V + E)
 *
 * 参考: "A Faster Algorithm for Betweenness Centrality" (Brandes, 2001)
 *       以及approximate变体 (Bader et al., 2007)
 */

import { NodeId } from '../types'

export interface ApproxBetweennessOptions {
  /** 采样数（源节点数量）, 默认: floor(sqrt(V)) */
  sampleSize?: number
  /** 是否归一化，默认 true */
  normalized?: boolean
  /** 随机种子（用于可重复性） */
  seed?: number
}

/**
 * approximate中介中心性 — 基于采样
 *
 * @param vertices - 所有节点 ID
 * @param adjList - 邻接表 (nodeId → 邻居数组)
 * @param options - 配置项
 * @returns Map<nodeId, score>
 */
export function approxBetweenness(
  vertices: NodeId[],
  adjList: Map<NodeId, NodeId[]>,
  options?: ApproxBetweennessOptions,
): Map<NodeId, number> {
  const n = vertices.length
  if (n === 0) return new Map()
  if (n <= 2) {
    // 小图直接用精确算法
    return _exactBetweenness(vertices, adjList, options?.normalized !== false)
  }

  const sampleK = options?.sampleSize ?? Math.max(1, Math.floor(Math.sqrt(n)))
  const normalized = options?.normalized !== false

  // 选择采样节点
  const sampledSources = _sampleNodes(vertices, Math.min(sampleK, n), options?.seed)

  const scores = new Map<NodeId, number>()
  for (const v of vertices) {
    scores.set(v, 0)
  }

  const vertexSet = new Set(vertices)

  for (const s of sampledSources) {
    // BFS from s
    const stack: NodeId[] = []
    const pred = new Map<NodeId, NodeId[]>()
    const sigma = new Map<NodeId, number>()
    const dist = new Map<NodeId, number>()

    for (const v of vertices) {
      pred.set(v, [])
      sigma.set(v, 0)
      dist.set(v, -1)
    }

    sigma.set(s, 1)
    dist.set(s, 0)
    const queue: NodeId[] = [s]
    let queueIdx = 0

    while (queueIdx < queue.length) {
      const v = queue[queueIdx++]
      stack.push(v)
      for (const w of adjList.get(v) || []) {
        if (!vertexSet.has(w)) continue
        if (dist.get(w) === -1) {
          dist.set(w, dist.get(v)! + 1)
          queue.push(w)
        }
        if (dist.get(w) === dist.get(v)! + 1) {
          sigma.set(w, sigma.get(w)! + sigma.get(v)!)
          pred.get(w)!.push(v)
        }
      }
    }

    // accumulation
    const delta = new Map<NodeId, number>()
    for (const v of vertices) {
      delta.set(v, 0)
    }

    while (stack.length > 0) {
      const w = stack.pop()!
      for (const v of pred.get(w) || []) {
        delta.set(v, delta.get(v)! + (sigma.get(v)! / sigma.get(w)!) * (1 + delta.get(w)!))
      }
      if (w !== s) {
        scores.set(w, scores.get(w)! + delta.get(w)!)
      }
    }
  }

  // 放缩因子：由采样比例决定
  const scale = n / sampledSources.length
  for (const v of vertices) {
    scores.set(v, scores.get(v)! * scale)
  }

  // 归一化
  if (normalized && n > 2) {
    const norm = (n - 1) * (n - 2)
    for (const v of vertices) {
      scores.set(v, scores.get(v)! / norm)
    }
  }

  return scores
}

/**
 * 精确中介中心性 (小图后备)
 */
function _exactBetweenness(
  vertices: NodeId[],
  adjList: Map<NodeId, NodeId[]>,
  normalized: boolean,
): Map<NodeId, number> {
  const scores = new Map<NodeId, number>()
  const n = vertices.length
  const vertexSet = new Set(vertices)

  for (const v of vertices) {
    scores.set(v, 0)
  }

  for (const s of vertices) {
    const stack: NodeId[] = []
    const pred = new Map<NodeId, NodeId[]>()
    const sigma = new Map<NodeId, number>()
    const dist = new Map<NodeId, number>()

    for (const v of vertices) {
      pred.set(v, [])
      sigma.set(v, 0)
      dist.set(v, -1)
    }
    sigma.set(s, 1)
    dist.set(s, 0)

    const queue: NodeId[] = [s]
    let queueIdx = 0
    while (queueIdx < queue.length) {
      const v = queue[queueIdx++]
      stack.push(v)
      for (const w of adjList.get(v) || []) {
        if (!vertexSet.has(w)) continue
        if (dist.get(w) === -1) {
          dist.set(w, dist.get(v)! + 1)
          queue.push(w)
        }
        if (dist.get(w) === dist.get(v)! + 1) {
          sigma.set(w, sigma.get(w)! + sigma.get(v)!)
          pred.get(w)!.push(v)
        }
      }
    }

    const delta = new Map<NodeId, number>()
    for (const v of vertices) delta.set(v, 0)

    while (stack.length > 0) {
      const w = stack.pop()!
      for (const v of pred.get(w) || []) {
        delta.set(v, delta.get(v)! + (sigma.get(v)! / sigma.get(w)!) * (1 + delta.get(w)!))
      }
      if (w !== s) scores.set(w, scores.get(w)! + delta.get(w)!)
    }
  }

  if (normalized && n > 2) {
    const norm = (n - 1) * (n - 2)
    for (const v of vertices) {
      scores.set(v, scores.get(v)! / norm)
    }
  }

  return scores
}

/**
 * 伪随机采样 — 从数组中无放回地选取 k 个元素
 * 使用 LCG 实现可重复的随机序列
 */
function _sampleNodes<T>(arr: T[], k: number, seed?: number): T[] {
  const n = arr.length
  if (k >= n) return [...arr]

  // Fisher-Yates shuffle (使用 LCG)
  const indices = arr.map((_, i) => i)
  let state = seed ?? 42
  for (let i = n - 1; i > 0; i--) {
    state = (state * 1664525 + 1013904223) & 0x7fffffff
    const j = state % (i + 1)
    ;[indices[i], indices[j]] = [indices[j], indices[i]]
  }

  return indices.slice(0, k).map((idx) => arr[idx])
}
