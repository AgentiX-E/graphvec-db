/**
 * k-Core 算法
 *
 * k-Core（k-核）是图论中的一种子图分解算法。
 * 一个 k-核 是图的最大子图，其中每个顶点的度数至少为 k。
 *
 * 核心特性：
 * - 确定性的、不可逆的分解过程
 * - 壳（Shell）编号：一个顶点属于第 k 个壳当且仅当它属于 k-核但不属于 (k+1)-核
 * - 时间复杂度：O(V + E)
 *
 * 实现使用经典的"修剪"算法：
 * 1. 计算每个顶点的度数
 * 2. 重复移除度数小于 k 的顶点，直到所有顶点度数 >= k
 * 3. 返回 k-核子图
 */

import { NodeId } from '../types'

export interface KCoreResult {
  /** 核中的节点 */
  nodes: Set<NodeId>
  /** 每个节点的核数（shell number），即该节点所属的最大 k 值 */
  coreNumbers: Map<NodeId, number>
  /** 所有节点的壳分解（core decomposition），key=节点, value=核数 */
  shellNumbers: Map<NodeId, number>
}

export interface KCoreOptions {
  /** 只计算到指定 k 值（提前停止） */
  maxK?: number
}

/**
 * k-Core 分解
 *
 * @param getNeighbors 邻接函数，返回给定节点的邻居列表
 * @param allNodes 所有节点列表
 * @param k 目标 k 值（最小度数）
 * @returns 包含在 k-核中的节点集合
 */
export function kCore(
  getNeighbors: (nodeId: NodeId) => NodeId[],
  allNodes: NodeId[],
  k: number,
): Set<NodeId> {
  if (k <= 1) return new Set(allNodes)
  if (allNodes.length === 0) return new Set()

  // 构建邻接表和度数
  const adjacency = new Map<NodeId, NodeId[]>()
  const degree = new Map<NodeId, number>()

  for (const node of allNodes) {
    const nb = getNeighbors(node)
    adjacency.set(node, nb)
    degree.set(node, nb.length)
  }

  // 使用队列收集度数不足的节点
  const queue: NodeId[] = []
  const removed = new Set<NodeId>()

  for (const node of allNodes) {
    if (degree.get(node)! < k) {
      queue.push(node)
      removed.add(node)
    }
  }

  // 重复移除度数不足的节点
  while (queue.length > 0) {
    const node = queue.shift()!
    const nb = adjacency.get(node)!

    for (const neighbor of nb) {
      if (!removed.has(neighbor)) {
        const newDegree = degree.get(neighbor)! - 1
        degree.set(neighbor, newDegree)
        if (newDegree < k && !removed.has(neighbor)) {
          removed.add(neighbor)
          queue.push(neighbor)
        }
      }
    }
  }

  // 剩余节点构成 k-核
  const result = new Set<NodeId>()
  for (const node of allNodes) {
    if (!removed.has(node)) {
      result.add(node)
    }
  }

  return result
}

/**
 * 完全 k-Core 分解（壳分解）
 * 计算每个顶点的核数（core number / shell index）
 *
 * 算法采用简化的迭代修剪算法：
 * 重复执行 k=1,2,...,∞ 的 k-core，找到每个节点所属的最大 k
 *
 * @param getNeighbors 邻接函数
 * @param allNodes 所有节点列表
 * @param options 可选参数
 * @returns 壳分解结果
 */
export function coreDecomposition(
  getNeighbors: (nodeId: NodeId) => NodeId[],
  allNodes: NodeId[],
  options?: KCoreOptions,
): KCoreResult {
  const maxK = options?.maxK ?? Infinity
  const n = allNodes.length
  if (n === 0) {
    return {
      nodes: new Set(),
      coreNumbers: new Map(),
      shellNumbers: new Map(),
    }
  }

  // 对每个节点，找到它所属的最大 k-核
  const shellNumbers = new Map<NodeId, number>()
  let maxCore = 0

  // 从 k=1 开始，逐步增加
  // 对每个 k，计算 k-core，记录属于该核但不属于 (k+1)-core 的节点
  let prevCore = new Set(allNodes) // k=1-core 是所有节点
  let currentK = 1

  while (currentK <= maxK) {
    const currentCore = kCore(getNeighbors, allNodes, currentK)

    if (currentCore.size === 0) break

    // 属于 currentK-core 但不属于 (currentK+1)-core 的节点
    const nextCore = kCore(getNeighbors, allNodes, currentK + 1)
    for (const node of currentCore) {
      if (!nextCore.has(node)) {
        shellNumbers.set(node, currentK)
      }
    }

    prevCore = currentCore
    if (nextCore.size === 0) break
    currentK++
  }

  // 剩余节点（属于最大核）
  if (prevCore.size > 0) {
    for (const node of prevCore) {
      if (!shellNumbers.has(node)) {
        shellNumbers.set(node, currentK)
      }
    }
    maxCore = currentK
  }

  // 构建结果
  const nodes = new Set<NodeId>()
  const coreNumbers = new Map<NodeId, number>()

  for (const [node, shell] of shellNumbers) {
    coreNumbers.set(node, shell)
    if (shell >= maxCore) {
      nodes.add(node)
    }
  }

  return { nodes, coreNumbers, shellNumbers }
}

/**
 * 计算所有 k-core 层（从 2 到最大核数）
 *
 * @param getNeighbors 邻接函数
 * @param allNodes 所有节点列表
 * @returns Map<k, Set<NodeId>>
 */
export function allKCores(
  getNeighbors: (nodeId: NodeId) => NodeId[],
  allNodes: NodeId[],
): Map<number, Set<NodeId>> {
  const decomposition = coreDecomposition(getNeighbors, allNodes)
  const maxK = Math.max(...Array.from(decomposition.shellNumbers.values()), 0)

  const result = new Map<number, Set<NodeId>>()
  for (let k = 2; k <= maxK; k++) {
    const core = kCore(getNeighbors, allNodes, k)
    if (core.size > 0) {
      result.set(k, core)
    }
  }

  return result
}
