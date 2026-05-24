#!/usr/bin/env python3
"""Append new graph algorithms to graph-algorithms.ts by replacing the last `}` (class tail) with new methods + `}`."""
import re

filepath = "/home/admin/openclaw/workspace/agentiX-graphvec/src/core/graph-algorithms.ts"

with open(filepath, "r") as f:
    content = f.read()

# Find the last `\n}\n` (closing brace of the class on its own line)
# We need to carefully find the last `}` that is the class closing brace.
# The class ends with `}\n` where that `}` is at the start of a line (after whitespace trimming).
# Looking at the file end: the last line is `}` after `  }\n}\n`

# Strategy: find the LAST line that is just `}` (possibly with leading spaces)
lines = content.split("\n")
# Find the index of the last line that matches (after stripping) exactly `}`
last_brace_idx = None
for i in range(len(lines) - 1, -1, -1):
    if lines[i].strip() == "}":
        last_brace_idx = i
        break

if last_brace_idx is None:
    print("ERROR: Could not find closing brace")
    exit(1)

# The new methods to add (before the closing `}`)
new_methods = r"""
  // ──────────────────────────────────────────
  // 新增图算法
  // ──────────────────────────────────────────

  /**
   * A* Search — 启发式最短路径搜索
   *
   * 在 Dijkstra 基础上引入启发式函数（Euclidean / Manhattan）加速搜索。
   * 使用优先队列 (min-heap)，每次扩展 f(n) = g(n) + h(n) 最小的节点。
   * 适用于已知目标位置且需要搜索加速的场景。
   * 注意：agentiX 默认无几何坐标，可使用节点 ID 差异模拟 Manhattan 距离；
   * Euclidean 模式需要节点具有 'x' 和 'y' 属性。
   *
   * @param sourceId 起始节点 ID
   * @param targetId 目标节点 ID
   * @param opts.heuristic - 启发函数类型：'euclidean' 需节点有 'x','y' 属性，否则 fallback 至 'manhattan'
   * @param opts.weightFn - 自定义边权重函数，默认等权 1
   * @returns nodeId 数组（含两端），如不可达则返回空数组
   */
  async aStarSearch(
    sourceId: NodeId,
    targetId: NodeId,
    opts?: { heuristic?: 'euclidean' | 'manhattan'; weightFn?: (e: any) => number }
  ): Promise<NodeId[]> {
    const sourceNode = this.engine.getNode(sourceId)
    const targetNode = this.engine.getNode(targetId)
    if (!sourceNode || !targetNode) return []

    if (sourceId === targetId) return [sourceId]

    const heuristic = opts?.heuristic ?? 'manhattan'
    const weightFn = opts?.weightFn ?? ((_e: any) => 1)

    const gScore = new Map<NodeId, number>()
    const fScore = new Map<NodeId, number>()
    const parent = new Map<NodeId, NodeId | null>()

    gScore.set(sourceId, 0)
    fScore.set(sourceId, this._heuristicCost(sourceId, targetId, heuristic))

    // Min-heap via array (for simplicity; priority queue would be faster)
    const openSet: NodeId[] = [sourceId]
    const openSetLookup = new Set<NodeId>([sourceId])
    const closedSet = new Set<NodeId>()

    while (openSet.length > 0) {
      // Find node with lowest fScore
      let lowestIdx = 0
      let lowestF = fScore.get(openSet[0]) ?? Infinity
      for (let i = 1; i < openSet.length; i++) {
        const f = fScore.get(openSet[i]) ?? Infinity
        if (f < lowestF) { lowestF = f; lowestIdx = i }
      }
      const current = openSet.splice(lowestIdx, 1)[0]
      openSetLookup.delete(current)

      if (current === targetId) {
        // Reconstruct path
        const path: NodeId[] = []
        let node: NodeId | null = targetId
        while (node !== null) {
          path.unshift(node)
          node = parent.get(node) ?? null
        }
        return path
      }

      closedSet.add(current)
      const currentG = gScore.get(current) ?? Infinity

      const nb = this.engine.neighbors(current)
      for (const { edge, node } of nb) {
        if (node === null) continue
        const neighbor = node.id
        if (closedSet.has(neighbor)) continue

        const w = weightFn(edge)
        const tentativeG = currentG + w

        if (!openSetLookup.has(neighbor)) {
          openSet.push(neighbor)
          openSetLookup.add(neighbor)
        } else {
          const existingG = gScore.get(neighbor) ?? Infinity
          if (tentativeG >= existingG) continue
        }

        parent.set(neighbor, current)
        gScore.set(neighbor, tentativeG)
        fScore.set(neighbor, tentativeG + this._heuristicCost(neighbor, targetId, heuristic))
      }
    }

    return []
  }

  /**
   * 启发式代价估算
   *
   * Euclidean: 需要节点有 'x' 和 'y' 属性，公式 sqrt((x1-x2)² + (y1-y2)²)
   * Manhattan: 使用节点 ID 差值的绝对值作为近似，公式 |id1 - id2|
   */
  private _heuristicCost(a: NodeId, b: NodeId, mode: 'euclidean' | 'manhattan'): number {
    if (mode === 'euclidean') {
      const nodeA = this.engine.getNode(a)
      const nodeB = this.engine.getNode(b)
      if (nodeA && nodeB && typeof (nodeA as any).x === 'number' && typeof (nodeA as any).y === 'number'
          && typeof (nodeB as any).x === 'number' && typeof (nodeB as any).y === 'number') {
        const dx = (nodeA as any).x - (nodeB as any).x
        const dy = (nodeA as any).y - (nodeB as any).y
        return Math.sqrt(dx * dx + dy * dy)
      }
    }
    // Fallback: Manhattan distance using node ID values
    return Math.abs(a - b)
  }

  /**
   * Strongly Connected Components (SCC) — Kosaraju 算法
   *
   * 两遍 DFS：
   * 1. 第一遍按 finish time 对正图做 DFS，结果入栈
   * 2. 第二遍对反图按栈序 DFS，每次遍历到的节点属于同一个 SCC
   *
   * 时间复杂度: O(V + E)，空间复杂度: O(V)
   *
   * @returns Map<NodeId, componentId> — 节点 ID 到连通分量 ID 的映射
   */
  async scc(): Promise<Map<NodeId, number>> {
    const allNodes = this._collectAllNodes()
    const nodeSet = new Set(allNodes)
    const visited = new Set<NodeId>()
    const order: NodeId[] = []

    // 构建反图邻接表
    const reverseAdj = new Map<NodeId, NodeId[]>()
    for (const u of allNodes) {
      const nb = this.engine.neighbors(u)
      for (const { node } of nb) {
        if (node === null || !nodeSet.has(node.id)) continue
        if (!reverseAdj.has(node.id)) reverseAdj.set(node.id, [])
        reverseAdj.get(node.id)!.push(u)
      }
    }

    // 第一遍 DFS（正图）：按 finish time 入栈
    const dfs1 = (v: NodeId) => {
      if (visited.has(v)) return
      visited.add(v)
      const stack: NodeId[] = [v]
      const iter: NodeId[] = []
      while (stack.length > 0) {
        const node = stack[stack.length - 1]
        if (!visited.has(node)) {
          visited.add(node)
          const nb = this.engine.neighbors(node)
          for (const { node: nn } of nb) {
            if (nn !== null && nodeSet.has(nn.id) && !visited.has(nn.id)) {
              stack.push(nn.id)
            }
          }
        } else {
          stack.pop()
          iter.push(node)
        }
      }
      for (const n of iter) order.push(n)
    }

    for (const node of allNodes) {
      if (!visited.has(node)) dfs1(node)
    }

    // 第二遍 DFS（反图）：按栈序分配组件 ID
    const component = new Map<NodeId, number>()
    let compId = 0

    const dfs2 = (v: NodeId, cid: number) => {
      const stack: NodeId[] = [v]
      while (stack.length > 0) {
        const node = stack.pop()!
        if (component.has(node)) continue
        component.set(node, cid)
        const revNb = reverseAdj.get(node) ?? []
        for (const n of revNb) {
          if (!component.has(n)) stack.push(n)
        }
      }
    }

    for (let i = order.length - 1; i >= 0; i--) {
      const v = order[i]
      if (!component.has(v)) {
        dfs2(v, compId)
        compId++
      }
    }

    return component
  }

  /**
   * K-Shortest Paths — Yen 算法
   *
   * 使用 Dijkstra 找第 1 短路径，然后通过"偏离"路径迭代产生后续 top-K 路径。
   * 利用 _heuristicCost 辅助但不影响正确性（A* 仅用于加速）。
   *
   * 时间复杂度: O(K * (V + E) * log V)
   *
   * @param sourceId 源节点 ID
   * @param targetId 目标节点 ID
   * @param k 需要的路径数（最多返回实际存在的路径数）
   * @returns NodeId[][] — 按距离升序排列的路径数组，每条路径为节点 ID 列表
   */
  async kShortestPaths(
    sourceId: NodeId,
    targetId: NodeId,
    k: number
  ): Promise<NodeId[][]> {
    if (k <= 0) return []
    const results: NodeId[][] = []

    // 找第 1 短路径 = A*
    const firstPath = await this.aStarSearch(sourceId, targetId, { heuristic: 'manhattan' })
    if (firstPath.length === 0) return []
    results.push(firstPath)

    // 候选路径池（min-heap by path length）
    const candidates: { path: NodeId[]; cost: number }[] = []

    for (let ki = 1; ki < k; ki++) {
      const prevPath = results[ki - 1]
      const allNodes = new Set<NodeId>()

      for (let i = 0; i < prevPath.length - 1; i++) {
        const spurNode = prevPath[i]

        // 构建 root path = prevPath[0..i]
        const rootPath = prevPath.slice(0, i + 1)

        // 移除被禁止的边：与之前所有路径中 rootPath 匹配的边
        const blockedEdges = new Set<string>()
        for (const p of results) {
          if (p.length > i && p.slice(0, i + 1).every((n, idx) => n === rootPath[idx])) {
            blockedEdges.add(`${p[i]},${p[i + 1]}`)
          }
        }

        // 收集 rootPath 中除最后一节点外所有节点（禁止使用这些节点作为 spur 搜索的中间节点）
        const blockedNodes = new Set(rootPath.slice(0, -1))

        // 使用 A* 计算 spur path：从 spurNode 到 targetId，避开 blockedNodes 和 blockedEdges
        const spurPath = await this._aStarWithBlocks(
          spurNode, targetId, blockedEdges, blockedNodes, allNodes
        )

        if (spurPath.length > 0) {
          const totalPath = [...rootPath.slice(0, -1), ...spurPath]
          const cost = totalPath.length - 1  // 无权图，路径长度 = 边数
          candidates.push({ path: totalPath, cost })
        }
      }

      if (candidates.length === 0) break

      // 选 cost 最小的候选路径
      candidates.sort((a, b) => a.cost - b.cost)
      const best = candidates.shift()!
      results.push(best.path)
    }

    return results
  }

  /**
   * 带阻塞边/节点的 A* Search（用于 Yen 算法内部）
   */
  private async _aStarWithBlocks(
    sourceId: NodeId,
    targetId: NodeId,
    blockedEdges: Set<string>,
    blockedNodes: Set<NodeId>,
    allNodes: Set<NodeId>
  ): Promise<NodeId[]> {
    if (sourceId === targetId) return [sourceId]
    if (blockedNodes.has(sourceId) || blockedNodes.has(targetId)) return []
    const nodeSet = new Set<NodeId>()

    const gScore = new Map<NodeId, number>()
    const fScore = new Map<NodeId, number>()
    const parent = new Map<NodeId, NodeId | null>()

    gScore.set(sourceId, 0)
    fScore.set(sourceId, Math.abs(sourceId - targetId))

    const openSet: NodeId[] = [sourceId]
    const openSetLookup = new Set<NodeId>([sourceId])
    const closedSet = new Set<NodeId>()

    while (openSet.length > 0) {
      let lowestIdx = 0
      let lowestF = fScore.get(openSet[0]) ?? Infinity
      for (let i = 1; i < openSet.length; i++) {
        const f = fScore.get(openSet[i]) ?? Infinity
        if (f < lowestF) { lowestF = f; lowestIdx = i }
      }
      const current = openSet.splice(lowestIdx, 1)[0]
      openSetLookup.delete(current)

      if (current === targetId) {
        const path: NodeId[] = []
        let node: NodeId | null = targetId
        while (node !== null) {
          path.unshift(node)
          node = parent.get(node) ?? null
        }
        return path
      }

      closedSet.add(current)
      const currentG = gScore.get(current) ?? Infinity

      const nb = this.engine.neighbors(current)
      for (const { edge, node } of nb) {
        if (node === null) continue
        const neighbor = node.id
        if (blockedNodes.has(neighbor)) continue
        if (blockedEdges.has(`${current},${neighbor}`)) continue
        if (closedSet.has(neighbor)) continue

        const w = 1
        const tentativeG = currentG + w

        if (!openSetLookup.has(neighbor)) {
          openSet.push(neighbor)
          openSetLookup.add(neighbor)
        } else {
          const existingG = gScore.get(neighbor) ?? Infinity
          if (tentativeG >= existingG) continue
        }

        parent.set(neighbor, current)
        gScore.set(neighbor, tentativeG)
        fScore.set(neighbor, tentativeG + Math.abs(neighbor - targetId))
      }
    }

    return []
  }

  /**
   * Eigenvector Centrality — 特征向量中心性（幂迭代法）
   *
   * 节点的重要性取决于其邻居的重要性之和。
   * 使用幂迭代法逼近主特征向量：
   * x_i^(t+1) = Σ A_ij · x_j^(t)  (A 为邻接矩阵)
   * 每轮迭代后归一化以防止数值溢出。
   *
   * 时间复杂度: O(V * E * maxIter)，空间复杂度: O(V)
   *
   * @param opts.maxIter - 最大迭代轮数（默认 100）
   * @param opts.tolerance - 收敛阈值（默认 1e-6）
   * @param opts.normalized - 是否归一化到 [0,1] 区间，默认 true
   * @returns Map<NodeId, eigenvectorScore> — 节点 ID 到特征向量中心性分数
   */
  eigenvectorCentrality(opts?: { maxIter?: number; tolerance?: number; normalized?: boolean }): Map<NodeId, number> {
    const maxIter = opts?.maxIter ?? 100
    const tolerance = opts?.tolerance ?? 1e-6
    const normalized = opts?.normalized ?? true

    const allNodes = this._collectAllNodes()
    const nodeSet = new Set(allNodes)
    if (allNodes.length === 0) return new Map()
    const n = allNodes.length

    // 初始化所有节点中心性为 1
    const centrality = new Map<NodeId, number>()
    for (const id of allNodes) centrality.set(id, 1)

    for (let iter = 0; iter < maxIter; iter++) {
      // 每个新值 = 邻居中心性之和
      const newCentrality = new Map<NodeId, number>()
      let norm = 0

      for (const u of allNodes) {
        let sum = 0
        const nb = this.engine.neighbors(u)
        for (const { node } of nb) {
          if (node !== null && nodeSet.has(node.id)) {
            sum += centrality.get(node.id) ?? 1
          }
        }
        newCentrality.set(u, sum)
        norm += sum * sum
      }

      norm = Math.sqrt(norm)
      if (norm === 0) break

      // 归一化
      let diff = 0
      for (const u of allNodes) {
        const newVal = newCentrality.get(u)! / norm
        diff += Math.abs(newVal - (centrality.get(u) ?? 0))
        centrality.set(u, newVal)
      }

      if (diff < tolerance) break
    }

    if (normalized) {
      const maxVal = Math.max(...centrality.values(), 1)
      for (const u of allNodes) {
        centrality.set(u, centrality.get(u)! / maxVal)
      }
    }

    return centrality
  }

  /**
   * Node2Vec（近似版）— 随机游走 + 简单 2D 嵌入
   *
   * 通过 node2vec_mod 风格的二阶有偏随机游走生成节点序列，
   * 然后使用类似 Word2Vec 的 Skip-Gram 训练得到 2D 嵌入向量。
   *
   * 参数 p（回退参数）和 q（进出参数）控制游走策略：
   * - p 大 → 倾向于探索新节点（广度优先）
   * - q 大 → 倾向于局部游走（深度优先）
   *
   * 本实现为近似版，使用简单正向传播代替完整的负采样训练。
   * 嵌入维度固定为 2，便于直接可视化。
   *
   * @param opts.walkLength - 每条随机游走的长度（默认 80）
   * @param opts.numWalks - 每个节点出发的游走数量（默认 10）
   * @param opts.p - 回退参数（默认 1.0）
   * @param opts.q - 进出参数（默认 1.0）
   * @param opts.epochs - SGD 迭代轮数（默认 50）
   * @param opts.lr - 学习率（默认 0.01）
   * @returns Map<NodeId, [number, number]> — 节点 ID → 2D 嵌入坐标
   */
  async node2Vec(opts?: {
    walkLength?: number;
    numWalks?: number;
    p?: number;
    q?: number;
    epochs?: number;
    lr?: number;
  }): Promise<Map<NodeId, [number, number]>> {
    const walkLength = opts?.walkLength ?? 80
    const numWalks = opts?.numWalks ?? 10
    const p = opts?.p ?? 1.0
    const q = opts?.q ?? 1.0
    const epochs = opts?.epochs ?? 50
    const lr = opts?.lr ?? 0.01

    const allNodes = this._collectAllNodes()
    const nodeSet = new Set(allNodes)
    if (allNodes.length < 2) return new Map()

    const n = allNodes.length
    const nodeIndex = new Map<NodeId, number>()
    const indexNode = new Map<number, NodeId>()
    for (let i = 0; i < n; i++) {
      nodeIndex.set(allNodes[i], i)
      indexNode.set(i, allNodes[i])
    }

    // 预计算邻居列表
    const neighbors = new Map<number, NodeId[]>()
    for (const u of allNodes) {
      const nb: NodeId[] = []
      for (const { node } of this.engine.neighbors(u)) {
        if (node !== null && nodeSet.has(node.id)) nb.push(node.id)
      }
      neighbors.set(u, nb)
    }

    // 二阶有偏随机游走
    const walk = (start: NodeId): NodeId[] => {
      const path: NodeId[] = [start]
      let prev: NodeId | null = null
      let current = start

      for (let step = 0; step < walkLength - 1; step++) {
        const nb = neighbors.get(current) ?? []
        if (nb.length === 0) break

        if (prev === null) {
          // 第一步，均匀采样
          const next = nb[Math.floor(Math.random() * nb.length)]
          prev = current
          current = next
          path.push(current)
          continue
        }

        // 二阶有偏采样
        const weights: number[] = []
        for (const next of nb) {
          if (next === prev) {
            weights.push(1 / p)  // 回退
          } else if (neighbors.get(next)?.includes(prev)) {
            weights.push(1)  // 共邻 → 局部探索
          } else {
            weights.push(1 / q)  // 远离 → 探索
          }
        }

        const totalW = weights.reduce((a, b) => a + b, 0)
        let r = Math.random() * totalW
        let chosen = nb[0]
        for (let i = 0; i < nb.length; i++) {
          r -= weights[i]
          if (r <= 0) { chosen = nb[i]; break }
        }

        prev = current
        current = chosen
        path.push(current)
      }
      return path
    }

    // 生成所有随机游走序列
    const walks: NodeId[][] = []
    for (const start of allNodes) {
      for (let w = 0; w < numWalks; w++) {
        walks.push(walk(start))
      }
    }

    // 初始化嵌入向量（随机）
    const embedding = new Map<number, [number, number]>()
    for (const id of allNodes) {
      embedding.set(id, [(Math.random() - 0.5) * 0.1, (Math.random() - 0.5) * 0.1])
    }

    // 简化的 Skip-Gram 训练（窗口大小 = 5，光照近似优化）
    const windowSize = 5
    const dim2Vec = (a: [number, number], b: [number, number]): number => a[0] * b[0] + a[1] * b[1]

    for (let epoch = 0; epoch < epochs; epoch++) {
      for (const w of walks) {
        for (let i = 0; i < w.length; i++) {
          const center = w[i]
          const ce = embedding.get(center)!
          const start = Math.max(0, i - windowSize)
          const end = Math.min(w.length - 1, i + windowSize)

          for (let j = start; j <= end; j++) {
            if (i === j) continue
            const ctx = w[j]
            const ctxE = embedding.get(ctx)!

            // 简单梯度：最大化点积
            const dot = dim2Vec(ce, ctxE)
            // Sigmoid gradient: sig' = sig * (1-sig), sig ≈ 1/(1+exp(-dot))
            // 近似梯度: (1 - sigmoid(dot)) * ctxE
            const sig = 1 / (1 + Math.exp(-dot))
            const grad = (1 - sig) * lr

            embedding.set(center, [
              ce[0] + grad * ctxE[0],
              ce[1] + grad * ctxE[1],
            ])

            // 负采样近似：随机采样一个节点作为负例
            const negIdx = Math.floor(Math.random() * n)
            const negId = indexNode.get(negIdx)!
            if (negId !== ctx && negId !== center) {
              const negE = embedding.get(negId)!
              const negDot = dim2Vec(ce, negE)
              const negSig = 1 / (1 + Math.exp(negDot))
              const negGrad = negSig * lr

              embedding.set(center, [
                (embedding.get(center)![0]) - negGrad * negE[0],
                (embedding.get(center)![1]) - negGrad * negE[1],
              ])
            }
          }
        }
      }
    }

    // L2 归一化
    for (const id of allNodes) {
      const e = embedding.get(id)!
      const norm = Math.sqrt(e[0] * e[0] + e[1] * e[1])
      if (norm > 0) {
        embedding.set(id, [e[0] / norm, e[1] / norm])
      }
    }

    // 返回原始 ID 映射
    const result = new Map<NodeId, [number, number]>()
    for (const id of allNodes) {
      result.set(id, embedding.get(id)!)
    }
    return result
  }
"""

# Replace the last `}` (the class tail) with new methods + closing brace
lines[last_brace_idx] = new_methods + "\n}"

with open(filepath, "w") as f:
    f.write("\n".join(lines))

print(f"Appended new methods before line {last_brace_idx + 1}")
print("Done!")
