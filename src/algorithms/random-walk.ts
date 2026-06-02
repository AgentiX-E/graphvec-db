/**
 * random-walk.ts — 图上随机游走
 *
 * 功能:
 * - randomWalk(adjacency, startNode, depth): 从 startNode 出发随机游走 depth 步
 * - randomWalks(adjacency, nodes, walkLength, walksPerNode): 多条随机游走
 *
 * 用于 Node2Vec 和 DeepWalk 的采样阶段。
 */

/**
 * 单次随机游走
 */
export function randomWalk(
  adjacency: Map<number, Set<number>>,
  startNode: number,
  depth: number,
): number[] {
  const path: number[] = [startNode]
  let current = startNode
  for (let i = 0; i < depth; i++) {
    const neighbors = adjacency.get(current)
    if (!neighbors || neighbors.size === 0) break
    const arr = [...neighbors]
    current = arr[Math.floor(Math.random() * arr.length)]
    path.push(current)
  }
  return path
}

/**
 * 多条随机游走
 */
export function randomWalks(
  adjacency: Map<number, Set<number>>,
  startNodes: number[],
  walkLength: number,
  walksPerNode: number,
): number[][] {
  const walks: number[][] = []
  for (const node of startNodes) {
    for (let w = 0; w < walksPerNode; w++) {
      walks.push(randomWalk(adjacency, node, walkLength))
    }
  }
  return walks
}
