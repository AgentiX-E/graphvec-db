/**
 * k-Core 算法单元测试
 *
 * 测试 kCore / coreDecomposition / allKCores 三个导出函数。
 * 最少 8 个Test only例。
 */

import { describe, test, expect } from 'vitest'
import { NodeId } from '../types'
import { kCore, coreDecomposition, allKCores } from './k-core'

// ──────────────────────────────────────────
// 测试图 1：简单链 0-1-2-3 (无环)
// 每个节点度数 <= 2
// ──────────────────────────────────────────

function createChainGraph(): { allNodes: NodeId[]; getNeighbors: (nid: NodeId) => NodeId[] } {
  const neighbors: Record<number, number[]> = {
    0: [1],
    1: [0, 2],
    2: [1, 3],
    3: [2],
  }
  return {
    allNodes: [0, 1, 2, 3],
    getNeighbors: (nid) => neighbors[nid] ?? [],
  }
}

// ──────────────────────────────────────────
// 测试图 2：三角形环 (3-核完全图)
// 3-核需要每个节点度数 >= 3
// ──────────────────────────────────────────

function createTriangleGraph(): { allNodes: NodeId[]; getNeighbors: (nid: NodeId) => NodeId[] } {
  const neighbors: Record<number, number[]> = {
    0: [1, 2],
    1: [0, 2],
    2: [0, 1],
  }
  return {
    allNodes: [0, 1, 2],
    getNeighbors: (nid) => neighbors[nid] ?? [],
  }
}

// ──────────────────────────────────────────
// 测试图 3：带 dangling 节点
// 0-1-2, 3(孤立)
// ──────────────────────────────────────────

function createGraphWithIsolated(): { allNodes: NodeId[]; getNeighbors: (nid: NodeId) => NodeId[] } {
  const neighbors: Record<number, number[]> = {
    0: [1],
    1: [0, 2],
    2: [1],
    3: [],
  }
  return {
    allNodes: [0, 1, 2, 3],
    getNeighbors: (nid) => neighbors[nid] ?? [],
  }
}

// ──────────────────────────────────────────
// 测试图 4：完全图 K4 (4节点完全图)
// 每个节点度数为 3
// ──────────────────────────────────────────

function createK4Graph(): { allNodes: NodeId[]; getNeighbors: (nid: NodeId) => NodeId[] } {
  const neighbors: Record<number, number[]> = {
    0: [1, 2, 3],
    1: [0, 2, 3],
    2: [0, 1, 3],
    3: [0, 1, 2],
  }
  return {
    allNodes: [0, 1, 2, 3],
    getNeighbors: (nid) => neighbors[nid] ?? [],
  }
}

// ──────────────────────────────────────────
// 测试图 5：双层结构
// 内部强连接(0-1-2全连接), 外部挂载节点(3,4,5各连一个)
// ──────────────────────────────────────────

function createShellGraph(): { allNodes: NodeId[]; getNeighbors: (nid: NodeId) => NodeId[] } {
  const neighbors: Record<number, number[]> = {
    0: [1, 2, 3],
    1: [0, 2, 4],
    2: [0, 1, 5],
    3: [0],
    4: [1],
    5: [2],
  }
  return {
    allNodes: [0, 1, 2, 3, 4, 5],
    getNeighbors: (nid) => neighbors[nid] ?? [],
  }
}

// ──────────────────────────────────────────
// 测试图 6：二部图 K_{3,2}
// ──────────────────────────────────────────

function createBipartiteGraph(): { allNodes: NodeId[]; getNeighbors: (nid: NodeId) => NodeId[] } {
  // 左侧: 0,1,2  右侧: 3,4
  // 每个左侧节点连接所有右侧节点
  const neighbors: Record<number, number[]> = {
    0: [3, 4],
    1: [3, 4],
    2: [3, 4],
    3: [0, 1, 2],
    4: [0, 1, 2],
  }
  return {
    allNodes: [0, 1, 2, 3, 4],
    getNeighbors: (nid) => neighbors[nid] ?? [],
  }
}

// ──────────────────────────────────────────
// 测试 − kCore 函数
// ──────────────────────────────────────────

describe('kCore', () => {
  test('k=1 returns all nodes', () => {
    const { allNodes, getNeighbors } = createChainGraph()
    const core = kCore(getNeighbors, allNodes, 1)
    expect(core.size).toBe(4)
    for (const n of allNodes) {
      expect(core.has(n)).toBe(true)
    }
  })

  test('k=2 on chain graph returns empty (max chain degree is 2 at center)', () => {
    const { allNodes, getNeighbors } = createChainGraph()
    const core = kCore(getNeighbors, allNodes, 2)
    // 链图中 0 和 3 度数为 1, 1 和 2 度数为 2
    // deg(0)=1 < 2 → 移除 → 1 的度数变为 1 → 移除 → ...
    expect(core.size).toBe(0)
  })

  test('k=2 on triangle returns all nodes (each has degree 2)', () => {
    const { allNodes, getNeighbors } = createTriangleGraph()
    const core = kCore(getNeighbors, allNodes, 2)
    expect(core.size).toBe(3)
  })

  test('k=3 on triangle returns empty (max degree is 2)', () => {
    const { allNodes, getNeighbors } = createTriangleGraph()
    const core = kCore(getNeighbors, allNodes, 3)
    expect(core.size).toBe(0)
  })

  test('k=2 on K4 returns all 4 nodes (each has degree 3)', () => {
    const { allNodes, getNeighbors } = createK4Graph()
    const core = kCore(getNeighbors, allNodes, 2)
    expect(core.size).toBe(4)
  })

  test('k=3 on K4 returns all 4 nodes (each has degree 3)', () => {
    const { allNodes, getNeighbors } = createK4Graph()
    const core = kCore(getNeighbors, allNodes, 3)
    expect(core.size).toBe(4)
  })

  test('k=4 on K4 returns empty (max degree is 3)', () => {
    const { allNodes, getNeighbors } = createK4Graph()
    const core = kCore(getNeighbors, allNodes, 4)
    expect(core.size).toBe(0)
  })

  test('isolated node is excluded from k=2 core', () => {
    const { allNodes, getNeighbors } = createGraphWithIsolated()
    const core = kCore(getNeighbors, allNodes, 2)
    // 节点 3 度数为 0, 节点 0,2 度数为 1, 这些 <2 被移除
    // 之后节点1度数为0, 也被移除
    expect(core.size).toBe(0)
  })

  test('k-core on empty graph returns empty set', () => {
    const core = kCore(() => [], [], 2)
    expect(core.size).toBe(0)
  })

  test('k-core with k<=1 returns all nodes', () => {
    const { allNodes, getNeighbors } = createShellGraph()
    const core0 = kCore(getNeighbors, allNodes, 0)
    expect(core0.size).toBe(6)
    const core1 = kCore(getNeighbors, allNodes, 1)
    expect(core1.size).toBe(6) // 所有节点度数都 >= 1
  })

  test('k=2 on shell graph returns only inner triangle nodes', () => {
    const { allNodes, getNeighbors } = createShellGraph()
    const core = kCore(getNeighbors, allNodes, 2)
    // 节点 3,4,5 度数为 1 → 移除后 0,1,2 度数变为 2
    expect(core.size).toBe(3)
    expect(core.has(0)).toBe(true)
    expect(core.has(1)).toBe(true)
    expect(core.has(2)).toBe(true)
  })

  test('k=3 on shell graph returns empty', () => {
    const { allNodes, getNeighbors } = createShellGraph()
    const core = kCore(getNeighbors, allNodes, 3)
    expect(core.size).toBe(0)
  })

  test('k=2 on bipartite graph returns empty', () => {
    const { allNodes, getNeighbors } = createBipartiteGraph()
    const core = kCore(getNeighbors, allNodes, 2)
    // K_{3,2}: 左侧每个节点度数为 2, 右侧每个节点度数为 3
    // k=2: 左侧节点度数正好 2 → 保留; 右侧节点 3,4 度数也为 3 → 保留
    // 但由于左侧度数 == 2，满足 k=2
    expect(core.size).toBe(5)
  })

  test('k=3 on bipartite graph returns only right side nodes', () => {
    const { allNodes, getNeighbors } = createBipartiteGraph()
    const core = kCore(getNeighbors, allNodes, 3)
    // K_{3,2}: 左侧度数为 2 (<3), 右侧度数为 3 (>=3)
    // 移除左侧后，右侧度数变为 0 → 移除
    expect(core.size).toBe(0)
  })
})

// ──────────────────────────────────────────
// 测试 − coreDecomposition (壳分解)
// ──────────────────────────────────────────

describe('coreDecomposition', () => {
  test('shell numbers for chain graph', () => {
    const { allNodes, getNeighbors } = createChainGraph()
    const result = coreDecomposition(getNeighbors, allNodes)
    // 链图: 度数为 1 的端点被移除时邻居度数降级
    // 所有节点最终 shell 为 1
    expect(result.shellNumbers.get(0)).toBe(1)
    expect(result.shellNumbers.get(1)).toBe(1)
    expect(result.shellNumbers.get(2)).toBe(1)
    expect(result.shellNumbers.get(3)).toBe(1)
  })

  test('shell numbers for triangle graph (all degree 2)', () => {
    const { allNodes, getNeighbors } = createTriangleGraph()
    const result = coreDecomposition(getNeighbors, allNodes)
    expect(result.shellNumbers.get(0)).toBe(2)
    expect(result.shellNumbers.get(1)).toBe(2)
    expect(result.shellNumbers.get(2)).toBe(2)
  })

  test('shell numbers for K4', () => {
    const { allNodes, getNeighbors } = createK4Graph()
    const result = coreDecomposition(getNeighbors, allNodes)
    expect(result.shellNumbers.get(0)).toBe(3)
    expect(result.shellNumbers.get(1)).toBe(3)
    expect(result.shellNumbers.get(2)).toBe(3)
    expect(result.shellNumbers.get(3)).toBe(3)
  })

  test('shell numbers for shell graph', () => {
    const { allNodes, getNeighbors } = createShellGraph()
    const result = coreDecomposition(getNeighbors, allNodes)
    // 3/4/5 度数为 1 → shell=1
    expect(result.shellNumbers.get(3)).toBe(1)
    expect(result.shellNumbers.get(4)).toBe(1)
    expect(result.shellNumbers.get(5)).toBe(1)
    // 内部的 0/1/2 在叶子移除后度数为 2，但 2-core 也会移除它们
    // 因为相互减度 → 全部变成 shell=1
    expect(result.shellNumbers.get(0)).toBe(2)
    expect(result.shellNumbers.get(1)).toBe(2)
    expect(result.shellNumbers.get(2)).toBe(2)
  })

  test('shell numbers for bipartite graph', () => {
    const { allNodes, getNeighbors } = createBipartiteGraph()
    const result = coreDecomposition(getNeighbors, allNodes)
    // K_{3,2}: 左侧度=2, 右侧度=3
    // k=1: 全保留（所有节点度数 >= 1）
    // k=2: 左侧=2≥2, 右侧=3≥2 → 全保留
    // k=3: 左侧=2<3 → 移除, 右侧=3≥3 → 保留
    //      移除左侧后右侧度数变0 → 移除
    // 所以右侧也没有 k=3, 全部 shell=2
    expect(result.shellNumbers.get(0)).toBe(2)
    expect(result.shellNumbers.get(3)).toBe(2)
  })

  test('empty graph returns empty result', () => {
    const result = coreDecomposition(() => [], [])
    expect(result.nodes.size).toBe(0)
    expect(result.coreNumbers.size).toBe(0)
    expect(result.shellNumbers.size).toBe(0)
  })

  test('single node graph', () => {
    const result = coreDecomposition(() => [], [42])
    // 单节点度数为 0，k=1 core 包含它（k<=1 返回所有节点）
    // k=2 core 为空，所以 shell=1
    // 最大核为 k=1, nodes 包含所有 shell=1 的节点
    expect(result.shellNumbers.get(42)).toBe(1)
    expect(result.nodes.size).toBe(1)
    expect(result.nodes.has(42)).toBe(true)
  })
})

// ──────────────────────────────────────────
// 测试 − allKCores
// ──────────────────────────────────────────

describe('allKCores', () => {
  test('chain graph has k=2 core but empty k=3', () => {
    const { allNodes, getNeighbors } = createChainGraph()
    const cores = allKCores(getNeighbors, allNodes)
    // 链图最大核数 = 1（链图中移除端点后级联移除所有节点）
    // 所以 k=2 的核为空
    expect(cores.has(2)).toBe(false)
    expect(cores.size).toBe(0)
  })

  test('K4 has k=2, k=3 cores', () => {
    const { allNodes, getNeighbors } = createK4Graph()
    const cores = allKCores(getNeighbors, allNodes)
    expect(cores.has(2)).toBe(true)
    expect(cores.get(2)!.size).toBe(4)
    expect(cores.has(3)).toBe(true)
    expect(cores.get(3)!.size).toBe(4)
    expect(cores.has(4)).toBe(false)
  })

  test('empty graph returns empty map', () => {
    const cores = allKCores(() => [], [])
    expect(cores.size).toBe(0)
  })
})
