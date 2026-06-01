/**
 * leiden.ts — Leiden 社区发现算法
 *
 * 基于 Louvain 的改进算法，增加 refinement phase（细化阶段），
 * 解决 Louvain 可能发现的低质量社区问题。
 *
 * 算法流程:
 *   Phase 1: Local Moving (标准 Louvain 模块度优化)
 *   Refinement: 对 Phase 1 的社区进行局部细化，拆分松散连接的社区
 *   Phase 2: Aggregation (社区聚合为超节点)
 *
 * 输入输出接口与 Louvain 一致：
 *   输入: vertices, edges (带权重)
 *   输出: communities (Map<nodeId, communityId>), modularity, levels
 *
 * 引用: Traag, V.A., Waltman, L. & van Eck, N.J. (2019) "From Louvain to Leiden"
 */

export interface LeidenResult {
  /** 每个顶点的社区编号 */
  communities: Map<number, number>
  /** 模块度 */
  modularity: number
  /** 层级数（>1 说明做了 agglomeration） */
  levels: number
}

export interface LeidenEdge {
  src: number
  dst: number
  weight: number
}

/**
 * 标准的 Louvain 模块度增益公式
 * ΔQ = w_to_C/m - (Σ_tot * k_i) / (2 * m²)   [加入社区C]
 *      + remove term when v is moved out
 *
 * 完整: ΔQ = [Σ_in + 2*k_i_in]/2m - [(Σ_tot + k_i)/2m]² - [Σ_in/2m] - [Σ_tot/2m]² - [k_i/2m]²
 */
/**
 * Louvain 模块度增益 (simplified for single-remove context)
 *
 * 当节点 v 独自在社区 self 时，deltaRemove = 0（移动它不降低原社区模块度）。
 * 否则 deltaRemove = -k_v * Σ_tot_self / (2*m²)
 */
function modularityGain(
  kiNode: number,
  sumTotSelf: number,
  sumTotTarget: number,
  weightToTarget: number,
  m: number,
): number {
  // Remove: only penalize if community has > 1 node (sumTotSelf > kiNode means other nodes)
  const deltaRemove = sumTotSelf > kiNode
    ? -(kiNode * sumTotSelf) / (2 * m * m)
    : 0
  // Add
  const deltaAdd = (weightToTarget / m) - (kiNode * sumTotTarget) / (2 * m * m)
  return deltaRemove + deltaAdd
}

/**
 * Leiden 社区发现（基于 Louvain + Refinement）
 */
export function leidenCommunity(
  vertices: number[],
  edges: LeidenEdge[],
  maxLevels: number = 10,
): LeidenResult {
  const n = vertices.length
  if (n === 0) {
    return { communities: new Map(), modularity: 0, levels: 0 }
  }

  let currentVertices = [...vertices]
  let currentEdges = edges
  const allLevels: Array<Map<number, number>> = []
  let bestResult: LeidenResult | null = null

  for (let level = 0; level < maxLevels; level++) {
    // Phase 1 + Refinement
    const phase1Result = localMovingPhase(currentVertices, currentEdges)

    // Refinement on the result
    const refinedResult = refinementPhase(
      currentVertices,
      currentEdges,
      phase1Result.communities
    )

    const refinedComms = refinedResult.communities
    allLevels.push(new Map(refinedComms))

    // Compute modularity on current level graph
    const mod = computeModularity(currentVertices, currentEdges, refinedComms)

    bestResult = {
      communities: new Map(refinedComms),
      modularity: mod,
      levels: level + 1,
    }

    // Phase 2: Aggregation
    const uniqueComms = new Set(refinedComms.values())
    if (uniqueComms.size <= 1) break

    const agg = aggregate(currentVertices, currentEdges, refinedComms)
    if (agg.aggVertices.length >= currentVertices.length) break

    currentVertices = agg.aggVertices
    currentEdges = agg.aggEdges
  }

  // Only return level 1 communities (maps to original vertices)
  const firstLevelComms = allLevels[0]
  const firstLevelMod = bestResult.modularity
  return {
    communities: new Map(firstLevelComms),
    modularity: firstLevelMod,
    levels: allLevels.length,
  }
}

// ──────────────────────────────────────────────
// Phase 1: Local Moving（基于 Louvain）
// ──────────────────────────────────────────────

function localMovingPhase(
  vertices: number[],
  edges: LeidenEdge[],
): { communities: Map<number, number>; modularity: number } {
  const adj = buildAdjacency(vertices, edges)

  // Each node in its own community
  const community = new Map<number, number>()
  for (const v of vertices) community.set(v, v)

  // Total weight (undirected: each edge counted twice)
  const totalWeight = edges.reduce((s, e) => s + e.weight, 0) * 2
  const m = totalWeight / 2
  if (m <= 0) {
    return { communities: community, modularity: 0 }
  }

  // Weighted degree per node
  const ki = new Map<number, number>()
  for (const v of vertices) {
    let sum = 0
    for (const [n, w] of adj.get(v)!) sum += w
    ki.set(v, sum)
  }

  // Community total degree
  const sumTot = new Map<number, number>()
  for (const v of vertices) sumTot.set(v, ki.get(v)!)

  // BFS ordering for stable convergence
  for (let iter = 0; iter < 50; iter++) {
    let moved = false

    // Randomize order for better quality
    const order = [...vertices].sort(() => Math.random() - 0.5)

    for (const v of order) {
      const neighbors = adj.get(v)!
      const currentComm = community.get(v)!

      // Compute weight to each neighboring community
      const commWeights = new Map<number, number>()
      for (const [neighbor, w] of neighbors) {
        const nc = community.get(neighbor)!
        commWeights.set(nc, (commWeights.get(nc) || 0) + w)
      }

      const kiNode = ki.get(v) || 0
      const sumTotSelf = sumTot.get(currentComm) || 0

      let bestComm = currentComm
      let bestDelta = 0

      for (const [comm, weight] of commWeights) {
        if (comm === currentComm) continue
        const sumTotTarget = sumTot.get(comm) || 0
        const delta = modularityGain(kiNode, sumTotSelf, sumTotTarget, weight, m)
        if (delta > bestDelta) {
          bestDelta = delta
          bestComm = comm
        }
      }

      if (bestComm !== currentComm) {
        // Move v from currentComm to bestComm
        community.set(v, bestComm)
        sumTot.set(currentComm, (sumTot.get(currentComm) || 0) - kiNode)
        sumTot.set(bestComm, (sumTot.get(bestComm) || 0) + kiNode)
        moved = true
      }
    }

    if (!moved) break
  }

  const modularity = computeModularity(vertices, edges, community)
  return { communities: community, modularity }
}

// ──────────────────────────────────────────────
// Refinement Phase（Leiden 核心改进）
// ──────────────────────────────────────────────

function refinementPhase(
  vertices: number[],
  edges: LeidenEdge[],
  communities: Map<number, number>,
): { communities: Map<number, number> } {
  const refined = new Map(communities)

  // Group by community
  const commGroups = new Map<number, number[]>()
  for (const v of vertices) {
    const c = communities.get(v)!
    if (!commGroups.has(c)) commGroups.set(c, [])
    commGroups.get(c)!.push(v)
  }

  const adj = buildAdjacency(vertices, edges)

  for (const [commId, members] of commGroups) {
    if (members.length <= 2) continue

    // Build internal edges (both endpoints in same community)
    const internalEdges: LeidenEdge[] = []
    const memberSet = new Set(members)
    for (const e of edges) {
      if (memberSet.has(e.src) && memberSet.has(e.dst)) {
        internalEdges.push(e)
      }
    }

    // If internal connectivity is sparse, skip refinement
    if (internalEdges.length < members.length * 0.3) continue

    // Run local moving on sub-graph
    const subResult = localMovingPhase(members, internalEdges)
    const subComms = new Set(subResult.communities.values())
    if (subComms.size <= 1) continue

    // Check modularity improvement
    const beforeMod = computeModularity(members, internalEdges, communities)
    const afterMod = computeModularity(members, internalEdges, subResult.communities)
    if (afterMod <= beforeMod) continue

    // Apply refinement: merge small subcommunities
    // Use first member ID as new community ID
    const subIdMap = new Map<number, number>()
    for (const v of members) {
      const sc = subResult.communities.get(v)!
      if (!subIdMap.has(sc)) subIdMap.set(sc, v)
      refined.set(v, subIdMap.get(sc)!)
    }
  }

  return { communities: refined }
}

// ──────────────────────────────────────────────
// Phase 2: Aggregation
// ──────────────────────────────────────────────

function aggregate(
  vertices: number[],
  edges: LeidenEdge[],
  communities: Map<number, number>,
): { aggVertices: number[]; aggEdges: LeidenEdge[] } {
  const uniqueComms = new Set<number>()
  for (const v of vertices) uniqueComms.add(communities.get(v)!)
  const aggVertices = [...uniqueComms]

  // Inter-community edges
  const edgeMap = new Map<string, number>()
  for (const e of edges) {
    const c1 = communities.get(e.src)!
    const c2 = communities.get(e.dst)!
    if (c1 === c2) continue
    const key = c1 < c2 ? `${c1}:${c2}` : `${c2}:${c1}`
    edgeMap.set(key, (edgeMap.get(key) || 0) + e.weight)
  }

  const aggEdges: LeidenEdge[] = []
  for (const [key, weight] of edgeMap) {
    const [a, b] = key.split(':').map(Number)
    aggEdges.push({ src: a, dst: b, weight })
  }

  return { aggVertices, aggEdges }
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function buildAdjacency(
  vertices: number[],
  edges: LeidenEdge[],
): Map<number, Map<number, number>> {
  const adj = new Map<number, Map<number, number>>()
  for (const v of vertices) adj.set(v, new Map())
  for (const e of edges) {
    const m1 = adj.get(e.src)
    const m2 = adj.get(e.dst)
    if (m1) m1.set(e.dst, (m1.get(e.dst) || 0) + e.weight)
    if (m2) m2.set(e.src, (m2.get(e.src) || 0) + e.weight)
  }
  return adj
}

function computeModularity(
  vertices: number[],
  edges: LeidenEdge[],
  communities: Map<number, number>,
): number {
  let totalWeight = edges.reduce((s, e) => s + e.weight, 0) * 2
  const m = totalWeight / 2
  if (m === 0) return 0

  const ki = new Map<number, number>()
  for (const v of vertices) {
    let s = 0
    for (const e of edges) {
      if (e.src === v) s += e.weight
      if (e.dst === v) s += e.weight
    }
    ki.set(v, s)
  }

  let Q = 0
  for (const e of edges) {
    if (communities.get(e.src) === communities.get(e.dst)) {
      Q += e.weight - (ki.get(e.src)! * ki.get(e.dst)!) / (2 * m)
    }
  }

  Q /= (2 * m)
  return Q
}
