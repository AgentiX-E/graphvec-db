/**
 * triangle.ts — 三角计数与聚类系数
 *
 * 功能:
 * - countTriangles(adjacency): 统计图中所有三角形（3-环）
 * - clusteringCoefficient(adjacency, node): 节点的聚类系数
 * - averageClusteringCoefficient(adjacency): 图的平均聚类系数
 *
 * 复杂度: O(d_max^2 * |V|) naive 实现，适用于稀疏图
 */

/**
 * 统计所有三角形
 * adjacency: Map<nodeId, Set<neighborId>>
 */
export function countTriangles(adjacency: Map<number, Set<number>>): number {
  let count = 0
  for (const [u, neighbors] of adjacency) {
    for (const v of neighbors) {
      if (v <= u) continue // 避免重复计数
      const neighborsV = adjacency.get(v)
      if (!neighborsV) continue
      for (const w of neighbors) {
        if (w > v && neighborsV.has(w)) {
          count++
        }
      }
    }
  }
  return count
}

/**
 * 节点的聚类系数 = 实际边数 / 可能边数
 * 对于度 < 2 的节点，聚类系数 = 0
 */
export function clusteringCoefficient(
  adjacency: Map<number, Set<number>>,
  node: number,
): number {
  const neighbors = adjacency.get(node)
  if (!neighbors || neighbors.size < 2) return 0

  let edgeCount = 0
  const neighborArr = [...neighbors]
  for (let i = 0; i < neighborArr.length; i++) {
    const n1 = adjacency.get(neighborArr[i])
    if (!n1) continue
    for (let j = i + 1; j < neighborArr.length; j++) {
      if (n1.has(neighborArr[j])) edgeCount++
    }
  }

  const k = neighbors.size
  const possible = (k * (k - 1)) / 2
  return edgeCount / possible
}

/**
 * 图的平均聚类系数（所有度 >= 2 的节点的聚类系数均值）
 */
export function averageClusteringCoefficient(
  adjacency: Map<number, Set<number>>,
): number {
  let sum = 0
  let count = 0
  for (const [node] of adjacency) {
    const cc = clusteringCoefficient(adjacency, node)
    if (cc > 0 || (adjacency.get(node)?.size ?? 0) >= 2) {
      sum += cc
      count++
    }
  }
  return count === 0 ? 0 : sum / count
}
