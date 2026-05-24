/**
 * 最大流 — Dinic 算法
 *
 * 输入: 有向加权图的邻接表 (每条边有权重作为容量)
 * 输出: 从 source 到 sink 的最大流值及每条边上的流量
 * 时间复杂度: O(E * V²)
 */

export interface FlowEdge {
  src: number
  dst: number
  capacity: number
  flow: number
}

export interface MaxFlowResult {
  maxFlow: number
  edges: FlowEdge[]
}

interface _Edge {
  to: number
  rev: number
  cap: number
}

export function maxFlow(
  vertices: number[],
  edges: Array<{ src: number; dst: number; capacity: number }>,
  source: number,
  sink: number,
): MaxFlowResult {
  const graph = new Map<number, _Edge[]>()
  for (const v of vertices) {
    graph.set(v, [])
  }

  const edgeMap = new Map<string, FlowEdge>()

  for (const e of edges) {
    const forward: _Edge = { to: e.dst, rev: 0, cap: e.capacity }
    const backward: _Edge = { to: e.src, rev: 0, cap: 0 }
    forward.rev = graph.get(e.dst)!.length
    backward.rev = graph.get(e.src)!.length
    graph.get(e.src)!.push(forward)
    graph.get(e.dst)!.push(backward)

    const key = `${e.src}:${e.dst}`
    edgeMap.set(key, { src: e.src, dst: e.dst, capacity: e.capacity, flow: 0 })
  }

  if (source === sink) {
    return { maxFlow: 0, edges: Array.from(edgeMap.values()) }
  }

  let flow = 0
  const INF = Number.MAX_SAFE_INTEGER

  while (true) {
    // BFS level graph
    const level = new Map<number, number>()
    const queue: number[] = [source]
    level.set(source, 0)

    while (queue.length > 0) {
      const v = queue.shift()!
      for (const e of graph.get(v) || []) {
        if (e.cap > 0 && !level.has(e.to)) {
          level.set(e.to, level.get(v)! + 1)
          queue.push(e.to)
        }
      }
    }

    if (!level.has(sink)) break

    // DFS
    const it = new Map<number, number>()
    for (const v of vertices) it.set(v, 0)

    const dfs = (v: number, f: number): number => {
      if (v === sink) return f
      const edges = graph.get(v)!
      const iter = it.get(v)!

      for (let i = iter; i < edges.length; i++) {
        it.set(v, i)
        const e = edges[i]
        if (e.cap > 0 && (level.get(e.to) ?? -1) === (level.get(v) ?? -2) + 1) {
          const d = dfs(e.to, Math.min(f, e.cap))
          if (d > 0) {
            e.cap -= d
            graph.get(e.to)![e.rev].cap += d
            // Update edge flow
            const key = `${v}:${e.to}`
            const fe = edgeMap.get(key)
            if (fe) {
              fe.flow += d
            }
            return d
          }
        }
      }
      return 0
    }

    let pushed = 0
    while (true) {
      const d = dfs(source, INF)
      if (d === 0) break
      pushed += d
    }

    if (pushed === 0) break
    flow += pushed
  }

  return {
    maxFlow: flow,
    edges: Array.from(edgeMap.values()),
  }
}
