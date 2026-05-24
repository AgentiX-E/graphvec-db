/**
 * 中介中心性 — Brandes 算法
 *
 * 计算每个顶点的中介中心性 (Betweenness Centrality)。
 * 时间复杂度: O(V * E) (未加权) / O(V * (E + V log V)) (加权)
 */

export interface BetweennessResult {
  /** nodeId → betweenness centrality score */
  [nodeId: number]: number
}

export function betweennessCentrality(
  vertices: number[],
  adjList: Map<number, number[]>,
  normalized = true,
): BetweennessResult {
  const result: BetweennessResult = {}
  const vertexSet = new Set(vertices)
  const n = vertices.length

  for (const v of vertices) {
    result[v] = 0
  }

  for (const s of vertices) {
    // BFS from s
    const stack: number[] = []
    const pred = new Map<number, number[]>()
    const sigma = new Map<number, number>()
    const dist = new Map<number, number>()

    for (const v of vertices) {
      pred.set(v, [])
      sigma.set(v, 0)
      dist.set(v, -1)
    }

    sigma.set(s, 1)
    dist.set(s, 0)
    const queue: number[] = [s]

    while (queue.length > 0) {
      const v = queue.shift()!
      stack.push(v)
      for (const w of adjList.get(v) || []) {
        if (!vertexSet.has(w)) continue
        // w found for the first time?
        if (dist.get(w) === -1) {
          dist.set(w, dist.get(v)! + 1)
          queue.push(w)
        }
        // shortest path to w via v
        if (dist.get(w) === dist.get(v)! + 1) {
          sigma.set(w, sigma.get(w)! + sigma.get(v)!)
          pred.get(w)!.push(v)
        }
      }
    }

    // accumulation
    const delta = new Map<number, number>()
    for (const v of vertices) {
      delta.set(v, 0)
    }

    while (stack.length > 0) {
      const w = stack.pop()!
      for (const v of pred.get(w) || []) {
        delta.set(v, delta.get(v)! + (sigma.get(v)! / sigma.get(w)!) * (1 + delta.get(w)!))
      }
      if (w !== s) {
        result[w] += delta.get(w)!
      }
    }
  }

  // 归一化
  if (normalized && n > 2) {
    const norm = (n - 1) * (n - 2)
    for (const v of vertices) {
      result[v] /= norm
    }
  }

  return result
}
