/**
 * Louvain 社区发现算法
 *
 * 基于模块度优化的贪心层次聚簇算法。
 * Phase 1: 局部模块度优化（每个节点尝试移动到邻接社区）
 * Phase 2: 将社区聚合成超节点，重复 Phase 1，形成层次社区结构
 *
 * 时间复杂度: O(E log V) (典型)
 */

export interface LouvainResult {
  /** 每个顶点的社区编号 (最终) */
  communities: Map<number, number>
  /** 各层级的模块度 */
  modularity: number
  /** 层级数 (如果 >1 说明做了 agglomeration) */
  levels: number
  /** 每层的社区分配 (从底向上，level 0 = 原始节点分配) */
  levelCommunities?: Array<Map<number, number>>
}

export interface CommunityLevel {
  level: number
  communities: Map<number, number>
  modularity: number
}

/**
 * 运行单阶段 Louvain Phase 1（局部模块度优化）
 * 返回优化后的社区分配和总边权重
 */
function louvainPhase1(
  vertices: number[],
  adj: Map<number, Map<number, number>>,
  totalWeight: number,
): Map<number, number> {
  const community = new Map<number, number>()
  for (const v of vertices) community.set(v, v)

  // 每个节点的度数和
  const sumTot = new Map<number, number>()
  for (const v of vertices) {
    let s = 0
    for (const [, w] of adj.get(v)!) s += w
    sumTot.set(v, s)
  }

  const ki = new Map(sumTot)
  const m = totalWeight / 2

  let improved = true
  let iterations = 0
  const maxIter = 50

  while (improved && iterations < maxIter) {
    improved = false
    iterations++

    for (const v of vertices) {
      const neighbors = adj.get(v)!
      const currentComm = community.get(v)!
      let bestComm = currentComm
      let bestDelta = 0

      // 计算到每个相邻社区的总权重
      const commWeights = new Map<number, number>()
      for (const [neighbor, w] of neighbors) {
        const nc = community.get(neighbor)!
        commWeights.set(nc, (commWeights.get(nc) || 0) + w)
      }

      for (const [comm, weight] of commWeights) {
        if (comm === currentComm) continue

        const sumTotComm = sumTot.get(comm) || 0
        const sumTotSelf = sumTot.get(currentComm) || 0
        const kiNode = ki.get(v) || 0

        // ΔQ = [2*ki_to_comm - (ki * sumTot_comm) / m] / (2*m)
        // 移除出当前社区的增量要减
        const deltaRemove = m > 0 ? (2 * m * kiNode * sumTotSelf) / (4 * m * m) : 0
        const deltaAdd = m > 0
          ? (2 * weight) / (2 * m) - (kiNode * sumTotComm) / (2 * m * m)
          : 0
        const deltaRemove2 = m > 0
          ? (2 * m - 2 * kiNode) * sumTotSelf / (4 * m * m)
          : 0

        // 简化公式: ΔQ = ki_to_comm/m - (ki * sumTot_comm)/(2*m^2)
        // 移除旧社区: -(ki * sumTot_self)/(2*m^2) (已经包含在 ki_to_comm 为0时)
        const deltaQ = m > 0
          ? (weight / m) - (kiNode * (sumTotComm - sumTotSelf + kiNode)) / (2 * m * m)
          : 0

        if (deltaQ > bestDelta) {
          bestDelta = deltaQ
          bestComm = comm
        }
      }

      if (bestComm !== currentComm) {
        community.set(v, bestComm)
        improved = true
      }
    }
  }

  return community
}

/**
 * 计算给定社区划分下的模块度 Q
 */
function computeModularity(
  vertices: number[],
  adj: Map<number, Map<number, number>>,
  community: Map<number, number>,
  totalWeight: number,
): number {
  const m = totalWeight / 2
  if (m <= 0) return 0

  const ki = new Map<number, number>()
  for (const v of vertices) {
    let s = 0
    for (const [, w] of adj.get(v)!) s += w
    ki.set(v, s)
  }

  let Q = 0
  for (const v of vertices) {
    for (const [w, weight] of adj.get(v)!) {
      if (community.get(v) === community.get(w)) {
        Q += weight - (ki.get(v)! * ki.get(w)!) / (2 * m)
      }
    }
  }
  return Q / (2 * m)
}

/**
 * Phase 2: 社区聚簇 (agglomeration)
 * 将 Phase 1 得到的社区聚簇为超级节点，构建新的图的边结构
 */
function aggregateCommunities(
  vertices: number[],
  adj: Map<number, Map<number, number>>,
  community: Map<number, number>,
): {
  newVertices: number[]
  newAdj: Map<number, Map<number, number>>
  totalWeight: number
  communityMap: Map<number, number>
} {
  // 为每个社区分配一个新的超级节点 ID
  const uniqueComms = new Set(community.values())
  const communityMap = new Map<number, number>()
  let superId = 0
  for (const c of uniqueComms) {
    communityMap.set(c, superId++)
  }

  // 建立超级节点间的边权重
  const newAdj = new Map<number, Map<number, number>>()
  const newVertices = Array.from(communityMap.values())
  for (const id of newVertices) newAdj.set(id, new Map())

  let totalWeight = 0
  for (const v of vertices) {
    const cv = communityMap.get(community.get(v)!)!
    for (const [neighbor, w] of adj.get(v)!) {
      const cn = communityMap.get(community.get(neighbor)!)!
      if (cv === cn) {
        // 自环（社区内部边的一半，因为每条边计算两次）
        const current = newAdj.get(cv)!.get(cv) || 0
        newAdj.get(cv)!.set(cv, current + w)
        totalWeight += w
      } else {
        // 社区间边
        const current = newAdj.get(cv)!.get(cn) || 0
        newAdj.get(cv)!.set(cn, current + w)
        totalWeight += w
      }
    }
  }

  // 处理自环边权重：每条边在遍历时被计算两次（v→neighbor 和 neighbor→v）
  // 在超级节点图中，我们只需要一次。
  // 实际上，遍历 vertices 时每条边会遍历两次（因为 adj 是无向的），
  // 所以 totalWeight 应该是 totalWeight/2 才是真正的 m_total
  // 但我们直接按原始图的总权重算：totalWeight 的语义是 "2 * 超级节点图中的总边权重和"
  // 后续在 phase1 中会再做 totalWeight / 2 作为 m
  for (const v of newVertices) {
    const selfLoop = newAdj.get(v)!.get(v) || 0
    if (selfLoop > 0) {
      newAdj.get(v)!.set(v, selfLoop / 2)
    }
  }

  return { newVertices, newAdj, totalWeight, communityMap }
}

/**
 * Louvain 社区发现算法（完整版，含 Phase 2 层次聚簇）
 *
 * @param vertices 顶点列表
 * @param edges 边列表（无向）
 * @param maxLevels 最大递归层次（默认 10）
 * @returns LouvainResult
 */
export function louvainCommunity(
  vertices: number[],
  edges: Array<{ src: number; dst: number; weight: number }>,
  maxLevels = 10,
): LouvainResult {
  const n = vertices.length
  if (n === 0) {
    return { communities: new Map(), modularity: 0, levels: 0 }
  }

  // 建立邻接表
  const adj = new Map<number, Map<number, number>>()
  for (const v of vertices) adj.set(v, new Map())
  let totalWeight = 0
  for (const e of edges) {
    adj.get(e.src)!.set(e.dst, (adj.get(e.src)!.get(e.dst) || 0) + e.weight)
    adj.get(e.dst)!.set(e.src, (adj.get(e.dst)!.get(e.src) || 0) + e.weight)
    totalWeight += e.weight * 2
  }

  const allLevels: Array<Map<number, number>> = []

  let currentVertices = vertices
  let currentAdj = adj
  let currentTotalWeight = totalWeight
  let overallModularity = 0

  // 递归执行 Phase 1 + Phase 2
  for (let level = 0; level < maxLevels; level++) {
    // Phase 1: 在当前图上运行局部优化
    const phase1Community = louvainPhase1(currentVertices, currentAdj, currentTotalWeight)
    const q = computeModularity(currentVertices, currentAdj, phase1Community, currentTotalWeight)
    overallModularity = q

    allLevels.push(new Map(phase1Community))

    // Phase 2: 检查是否可以继续聚簇
    const uniqueComms = new Set(phase1Community.values())
    if (uniqueComms.size <= 1 || uniqueComms.size >= currentVertices.length) {
      // 只有 1 个社区或没有合并，停止
      break
    }

    // 聚簇为超级节点
    const { newVertices, newAdj, communityMap } =
      aggregateCommunities(currentVertices, currentAdj, phase1Community)

    // 如果超级节点数没有减少（所有节点已在不同社区），停止
    if (newVertices.length >= currentVertices.length) {
      break
    }

    // 准备下一轮
    currentVertices = newVertices
    currentAdj = newAdj
  }

  // 将所有层级的社区分配映射回原始节点
  // level 0 = 第一层 Phase 1 结果上的原始节点社区分配
  let result: Map<number, number>
  if (allLevels.length === 1) {
    result = allLevels[0]
  } else {
    // 从 level 0 开始，逐层映射到原始节点
    result = new Map<number, number>()
    for (const v of vertices) result.set(v, allLevels[0].get(v)!)

    for (let l = 1; l < allLevels.length; l++) {
      const currLevel = allLevels[l]
      const superMapping = new Map<number, number>()
      for (const [superNode, superComm] of currLevel) {
        superMapping.set(superNode, superComm)
      }
      for (const v of vertices) {
        const prevComm = result.get(v)!
        if (superMapping.has(prevComm)) {
          result.set(v, superMapping.get(prevComm)!)
        }
      }
    }
  }

  return {
    communities: result,
    modularity: overallModularity,
    levels: allLevels.length,
    levelCommunities: allLevels.length > 1 ? allLevels : undefined,
  }
}
