/**
 * 最小生成树 (MST) — Kruskal 算法
 *
 * 输入: 加权无向图的边列表
 * 输出: 最小生成树的边集合
 * 时间复杂度: O(E log E)
 */

export interface MSTEdge {
  src: number
  dst: number
  weight: number
}

export interface MSTResult {
  edges: MSTEdge[]
  totalWeight: number
}

export function minimumSpanningTree(vertices: number[], edges: MSTEdge[]): MSTResult {
  if (vertices.length === 0) return { edges: [], totalWeight: 0 }

  // 按权重排序
  const sorted = [...edges].sort((a, b) => a.weight - b.weight)

  // Union-Find
  const parent = new Map<number, number>()
  const rank = new Map<number, number>()

  for (const v of vertices) {
    parent.set(v, v)
    rank.set(v, 0)
  }

  function find(x: number): number {
    if (parent.get(x) !== x) {
      parent.set(x, find(parent.get(x)!))
    }
    return parent.get(x)!
  }

  function union(a: number, b: number): boolean {
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) return false
    const rankA = rank.get(ra)!
    const rankB = rank.get(rb)!
    if (rankA < rankB) {
      parent.set(ra, rb)
    } else if (rankA > rankB) {
      parent.set(rb, ra)
    } else {
      parent.set(rb, ra)
      rank.set(ra, rankA + 1)
    }
    return true
  }

  const result: MSTEdge[] = []
  let totalWeight = 0

  for (const edge of sorted) {
    if (result.length === vertices.length - 1) break
    // 只处理两个端点都在顶点集合中的边
    if (!parent.has(edge.src) || !parent.has(edge.dst)) continue
    if (union(edge.src, edge.dst)) {
      result.push(edge)
      totalWeight += edge.weight
    }
  }

  return { edges: result, totalWeight }
}
